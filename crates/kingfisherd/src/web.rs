use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt};
use kingfisher_events::EventBody;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::agent::{AgentCmd, AgentHandle};
use crate::hub::Hub;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct Assets;

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
                   img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/// Shy of the 600 s hook timeout, so the daemon answers before claude gives up on it.
const PERMISSION_WAIT: Duration = Duration::from_secs(590);

pub struct AppState {
    pub hub: Arc<Hub>,
    pub agent: Option<AgentHandle>,
    pub port: u16,
    pub token: String,
    pub hook_token: String,
    pub cwd: PathBuf,
}

impl AppState {
    fn cookie_name(&self) -> String {
        format!("kf_{}", self.port)
    }

    fn allowed_hosts(&self) -> [String; 2] {
        [
            format!("127.0.0.1:{}", self.port),
            format!("localhost:{}", self.port),
        ]
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth", post(auth))
        .route("/api/files", get(files))
        .route("/ws", get(ws))
        .route("/hook/permission", post(hook_permission))
        .fallback(get(asset))
        .layer(middleware::from_fn_with_state(state.clone(), guard_host))
        .with_state(state)
}

/// DNS rebinding defence: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
async fn guard_host(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    if !host.is_some_and(|h| s.allowed_hosts().iter().any(|a| a == h)) {
        return (StatusCode::MISDIRECTED_REQUEST, "bad host").into_response();
    }
    next.run(req).await
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authed(s: &AppState, headers: &HeaderMap) -> bool {
    let name = s.cookie_name();
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == name && ct_eq(v.as_bytes(), s.token.as_bytes()))
}

fn same_origin(s: &AppState, headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok());
    origin.is_some_and(|o| s.allowed_hosts().iter().any(|h| o == format!("http://{h}")))
}

#[derive(Deserialize)]
struct AuthBody {
    token: String,
}

async fn auth(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::Json<AuthBody>,
) -> Response {
    if !same_origin(&s, &headers) || !ct_eq(body.token.as_bytes(), s.token.as_bytes()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/",
        s.cookie_name(),
        s.token
    );
    ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
}

async fn files(State(s): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !authed(&s, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&s.cwd)
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output()
        .await;
    let files: Vec<&str> = match &out {
        Ok(o) if o.status.success() => std::str::from_utf8(&o.stdout)
            .unwrap_or("")
            .lines()
            .take(20_000)
            .collect(),
        _ => vec![],
    };
    axum::Json(json!({"root": s.cwd, "files": files})).into_response()
}

async fn ws(State(s): State<Arc<AppState>>, headers: HeaderMap, up: WebSocketUpgrade) -> Response {
    if !same_origin(&s, &headers) {
        return (StatusCode::FORBIDDEN, "bad origin").into_response();
    }
    if !authed(&s, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    up.on_upgrade(move |socket| client(socket, s))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Prompt { text: String },
    Interrupt,
    Permission { req_id: String, allow: bool },
}

async fn client(socket: WebSocket, s: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let (backlog, mut live) = s.hub.snapshot_and_subscribe();
    let batch = format!(
        "[{}]",
        backlog.iter().map(|f| &**f).collect::<Vec<_>>().join(",")
    );
    if sink.send(Message::Text(batch.into())).await.is_err() {
        return;
    }

    let mut send = tokio::spawn(async move {
        loop {
            match live.recv().await {
                Ok(frame) => {
                    if sink
                        .send(Message::Text(format!("[{frame}]").into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // A slow tab missed events; a reload would resync it from the full log.
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("websocket client lagged by {n} events")
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    let s2 = s.clone();
    let mut recv = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(cmd) = serde_json::from_str::<ClientMsg>(&text) else {
                continue;
            };
            match cmd {
                ClientMsg::Prompt { text } => match &s2.agent {
                    Some(a) => a.send(AgentCmd::Prompt(text)).await,
                    None => s2.hub.notice("replay mode: no agent to talk to"),
                },
                ClientMsg::Interrupt => {
                    if let Some(a) = &s2.agent {
                        a.send(AgentCmd::Interrupt).await
                    }
                }
                ClientMsg::Permission { req_id, allow } => {
                    if !s2.hub.resolve_permission(&req_id, allow) {
                        s2.hub
                            .notice(format!("permission {req_id} was no longer waiting"));
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send => recv.abort(),
        _ = &mut recv => send.abort(),
    }
}

async fn hook_permission(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::Json<Value>,
) -> Response {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if !bearer.is_some_and(|b| ct_eq(b.as_bytes(), s.hook_token.as_bytes())) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let req_id = ulid_like();
    let session = body["session_id"].as_str().map(str::to_owned);
    let rx = s.hub.park_permission(req_id.clone());
    s.hub.publish(
        session.clone(),
        None,
        EventBody::PermissionRequested {
            req_id: req_id.clone(),
            tool: body["tool_name"].as_str().unwrap_or("?").to_owned(),
            input: body["tool_input"].clone(),
        },
    );

    let allow = match tokio::time::timeout(PERMISSION_WAIT, rx).await {
        Ok(Ok(allow)) => allow,
        _ => {
            s.hub.forget_permission(&req_id);
            false
        }
    };
    s.hub.publish(
        session,
        None,
        EventBody::PermissionResolved { req_id, allow },
    );

    let decision = if allow {
        json!({"behavior": "allow"})
    } else {
        json!({"behavior": "deny", "message": "Denied from kingfisher."})
    };
    axum::Json(json!({
        "hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}
    }))
    .into_response()
}

fn ulid_like() -> String {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("os randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

async fn asset(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let (path, file) = match Assets::get(path) {
        Some(f) if !path.is_empty() => (path, f),
        _ => match Assets::get("index.html") {
            Some(f) => ("index.html", f),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "web/dist is empty: run `pnpm build` in web/",
                )
                    .into_response();
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut res = Response::new(Body::from(file.data.into_owned()));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap(),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "cross-origin-embedder-policy",
        HeaderValue::from_static("require-corp"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if path == "index.html" {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn app() -> Router {
        router(Arc::new(AppState {
            hub: Hub::new(),
            agent: None,
            port: 7777,
            token: "t0k".into(),
            hook_token: "h00k".into(),
            cwd: ".".into(),
        }))
    }

    fn req(method: &str, uri: &str, headers: &[(&str, &str)], body: &str) -> Request {
        let mut b = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(Body::from(body.to_owned())).unwrap()
    }

    async fn status(r: Request) -> StatusCode {
        app().oneshot(r).await.unwrap().status()
    }

    #[tokio::test]
    async fn foreign_host_is_refused_before_anything_else() {
        let r = req("GET", "/api/files", &[("host", "evil.example:7777")], "");
        assert_eq!(status(r).await, StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn api_needs_the_cookie() {
        let r = req("GET", "/api/files", &[("host", "127.0.0.1:7777")], "");
        assert_eq!(status(r).await, StatusCode::UNAUTHORIZED);
        let r = req(
            "GET",
            "/api/files",
            &[
                ("host", "127.0.0.1:7777"),
                ("cookie", "other=1; kf_7777=t0k"),
            ],
            "",
        );
        assert_eq!(status(r).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_checks_origin_and_token() {
        let ok = [
            ("host", "localhost:7777"),
            ("origin", "http://localhost:7777"),
            ("content-type", "application/json"),
        ];
        assert_eq!(
            status(req("POST", "/api/auth", &ok, r#"{"token":"t0k"}"#)).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            status(req("POST", "/api/auth", &ok, r#"{"token":"nope"}"#)).await,
            StatusCode::FORBIDDEN
        );
        let cross = [
            ("host", "localhost:7777"),
            ("origin", "http://evil.example"),
            ("content-type", "application/json"),
        ];
        assert_eq!(
            status(req("POST", "/api/auth", &cross, r#"{"token":"t0k"}"#)).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn hook_wants_its_own_token_not_the_browser_one() {
        let h = |t: &'static str| {
            [
                ("host", "127.0.0.1:7777"),
                ("authorization", t),
                ("content-type", "application/json"),
            ]
        };
        let r = req("POST", "/hook/permission", &h("Bearer t0k"), "{}");
        assert_eq!(status(r).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hook_round_trip_through_the_hub() {
        let hub = Hub::new();
        let state = Arc::new(AppState {
            hub: hub.clone(),
            agent: None,
            port: 7777,
            token: "t0k".into(),
            hook_token: "h00k".into(),
            cwd: ".".into(),
        });
        let (_, mut live) = hub.snapshot_and_subscribe();
        let r = req(
            "POST",
            "/hook/permission",
            &[
                ("host", "127.0.0.1:7777"),
                ("authorization", "Bearer h00k"),
                ("content-type", "application/json"),
            ],
            r#"{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s1"}"#,
        );
        let call = tokio::spawn(router(state).oneshot(r));
        let frame = live.recv().await.unwrap();
        let ev: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(ev["body"]["type"], "permission_requested");
        assert!(hub.resolve_permission(ev["body"]["req_id"].as_str().unwrap(), true));

        let res = call.await.unwrap().unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out["hookSpecificOutput"]["decision"]["behavior"], "allow");
    }
}
