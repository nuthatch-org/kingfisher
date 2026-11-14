use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt};
use kingfisher_events::{EventBody, HookNormalizer};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::agent::{self, AgentCmd, AgentHandle, Launcher};
use crate::archive;
use crate::hub::{ArchiveFile, Decision, Hub, now_ms};

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct Assets;

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
                   img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/// Shy of the 600 s hook timeout, so the daemon answers before claude gives up on it.
const PERMISSION_WAIT: Duration = Duration::from_secs(590);

pub struct AppState {
    pub hub: Arc<Hub>,
    pub agent: Mutex<Option<AgentHandle>>,
    /// `None` in replay mode, where nothing may be started.
    pub launcher: Option<Launcher>,
    pub hooks: Mutex<HookNormalizer>,
    pub port: u16,
    pub token: String,
    pub hook_token: String,
    pub cwd: PathBuf,
    pub archive_dir: PathBuf,
    /// Opened on the first hook event, so a daemon that observes nothing leaves no empty file.
    pub observed_archive: Mutex<Option<ArchiveFile>>,
    /// The daemon answers permission requests itself while this is on.
    pub autonomous: AtomicBool,
    pub banter: Arc<AtomicBool>,
    /// For the read-only phone listener; never accepted by the control router.
    pub watch_token: String,
    pub phone_url: Option<String>,
}

/// Which listener a request came in on. The phone one may look, never steer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Control,
    Watch,
}

pub fn publish_mode(s: &AppState) {
    s.hub.publish(
        None,
        None,
        EventBody::Mode {
            autonomous: s.autonomous.load(Ordering::Relaxed),
            banter: s.banter.load(Ordering::Relaxed),
        },
    );
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
        .route("/api/role", get(role))
        .route("/api/phone.svg", get(phone_qr))
        .route("/api/files", get(files))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{name}", get(session_events))
        .route("/ws", get(ws))
        .route("/hook/permission", post(hook_permission))
        .route("/hook/event", post(hook_event))
        .fallback(get(asset))
        .layer(Extension(Role::Control))
        .layer(middleware::from_fn_with_state(state.clone(), guard_host))
        .with_state(state)
}

/// The LAN listener for a phone: the page, the history and the live feed, and nothing that acts.
/// No Host check here, since the host is whatever address the phone used; the watch token
/// cookie, scoped to that origin, is what keeps strangers out.
pub fn watch_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth", post(auth))
        .route("/api/role", get(role))
        .route("/api/files", get(files))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{name}", get(session_events))
        .route("/ws", get(ws))
        .fallback(get(asset))
        .layer(Extension(Role::Watch))
        .with_state(state)
}

async fn role(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
) -> Response {
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let phone = if role == Role::Control {
        s.phone_url.clone()
    } else {
        None
    };
    axum::Json(
        json!({"role": if role == Role::Control { "control" } else { "watch" }, "phone": phone}),
    )
    .into_response()
}

async fn phone_qr(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
) -> Response {
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(url) = &s.phone_url else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match qrcode::QrCode::new(url.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(240, 240)
                .dark_color(qrcode::render::svg::Color("#0b0d14"))
                .light_color(qrcode::render::svg::Color("#f0f4ff"))
                .build();
            (
                [
                    (header::CONTENT_TYPE, "image/svg+xml"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                svg,
            )
                .into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
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

fn authed(s: &AppState, role: Role, headers: &HeaderMap) -> bool {
    let (name, token) = match role {
        Role::Control => (s.cookie_name(), &s.token),
        Role::Watch => (format!("kfw_{}", s.port), &s.watch_token),
    };
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == name && ct_eq(v.as_bytes(), token.as_bytes()))
}

fn same_origin(s: &AppState, role: Role, headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok());
    match role {
        Role::Control => {
            origin.is_some_and(|o| s.allowed_hosts().iter().any(|h| o == format!("http://{h}")))
        }
        Role::Watch => {
            let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
            matches!((origin, host), (Some(o), Some(h)) if o == format!("http://{h}"))
        }
    }
}

#[derive(Deserialize)]
struct AuthBody {
    token: String,
}

async fn auth(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
    body: axum::Json<AuthBody>,
) -> Response {
    let (name, token) = match role {
        Role::Control => (s.cookie_name(), &s.token),
        Role::Watch => (format!("kfw_{}", s.port), &s.watch_token),
    };
    if !same_origin(&s, role, &headers) || !ct_eq(body.token.as_bytes(), token.as_bytes()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cookie = format!("{name}={token}; HttpOnly; SameSite=Strict; Path=/");
    ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
}

async fn sessions(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
) -> Response {
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let dir = s.archive_dir.clone();
    let list = tokio::task::spawn_blocking(move || archive::list(&dir))
        .await
        .unwrap_or_default();
    for cwd in list.iter().filter_map(|x| x.cwd.as_ref()) {
        s.hub.allow_archived_cwd(PathBuf::from(cwd));
    }
    axum::Json(list).into_response()
}

async fn session_events(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !archive::valid_name(&name) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dir = s.archive_dir.clone();
    match tokio::task::spawn_blocking(move || archive::load(&dir, &name)).await {
        Ok(Ok(events)) => axum::Json(events).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn archive_hook(s: &AppState, payload: &Value) -> Option<ArchiveFile> {
    use std::io::Write;
    let mut file = s.observed_archive.lock().unwrap();
    if file.is_none() {
        let path = s.archive_dir.join(format!("observed-{}.ndjson", now_ms()));
        *file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map(|f| Arc::new(Mutex::new(f)))
            .map_err(|e| {
                tracing::warn!(
                    "cannot archive observed sessions to {}: {e}",
                    path.display()
                )
            })
            .ok();
    }
    let f = file.clone()?;
    let line = json!({"ts": now_ms(), "hook": payload}).to_string();
    if let Err(e) = writeln!(f.lock().unwrap(), "{line}") {
        tracing::warn!("observed archive write failed: {e}");
    }
    Some(f)
}

#[derive(Deserialize)]
struct FilesQuery {
    cwd: Option<PathBuf>,
}

async fn files(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
    Query(q): Query<FilesQuery>,
) -> Response {
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Only directories a session has reported, never an arbitrary path from the page.
    let root = match q.cwd {
        Some(cwd) if s.hub.is_known_cwd(&cwd) => cwd,
        Some(_) => return StatusCode::FORBIDDEN.into_response(),
        None => s.cwd.clone(),
    };
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&root)
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
    axum::Json(json!({"root": root, "files": files})).into_response()
}

async fn ws(
    State(s): State<Arc<AppState>>,
    Extension(role): Extension<Role>,
    headers: HeaderMap,
    up: WebSocketUpgrade,
) -> Response {
    if !same_origin(&s, role, &headers) {
        return (StatusCode::FORBIDDEN, "bad origin").into_response();
    }
    if !authed(&s, role, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    up.on_upgrade(move |socket| client(socket, s, role))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Prompt {
        text: String,
    },
    Interrupt,
    Permission {
        req_id: String,
        allow: bool,
    },
    TakeOver {
        session: String,
    },
    SetMode {
        autonomous: Option<bool>,
        banter: Option<bool>,
    },
}

fn current_agent(s: &AppState) -> Option<AgentHandle> {
    s.agent.lock().unwrap().clone()
}

fn take_over(s: &AppState, session: &str) {
    let Some(launcher) = &s.launcher else {
        return s.hub.notice("replay mode: nothing to take over with");
    };
    let mut agent = s.agent.lock().unwrap();
    if agent.is_some() {
        return s
            .hub
            .notice("already driving a session; start another kingfisherd to take over this one");
    }
    let Some(info) = s.hub.session(session) else {
        return s.hub.notice(format!("unknown session {session}"));
    };
    s.hub.notice(format!(
        "taking over {}; close it in the terminal first, two writers on one session is untested",
        &session[..session.len().min(8)]
    ));
    *agent = Some(agent::start(
        launcher.config(info.cwd, Some(session.to_owned())),
        s.hub.clone(),
    ));
}

async fn client(socket: WebSocket, s: Arc<AppState>, role: Role) {
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
            if role == Role::Watch {
                continue;
            }
            let Ok(cmd) = serde_json::from_str::<ClientMsg>(&text) else {
                continue;
            };
            match cmd {
                ClientMsg::Prompt { text } => match current_agent(&s2) {
                    Some(a) => a.send(AgentCmd::Prompt(text)).await,
                    None if s2.launcher.is_some() => s2
                        .hub
                        .notice("observing only: take over a session to talk to it"),
                    None => s2.hub.notice("replay mode: no agent to talk to"),
                },
                ClientMsg::Interrupt => {
                    if let Some(a) = current_agent(&s2) {
                        a.send(AgentCmd::Interrupt).await
                    }
                }
                ClientMsg::TakeOver { session } => take_over(&s2, &session),
                ClientMsg::SetMode { autonomous, banter } => {
                    if let Some(on) = autonomous {
                        s2.autonomous.store(on, Ordering::Relaxed);
                        if on {
                            s2.hub.allow_all_pending();
                        }
                    }
                    if let Some(on) = banter {
                        s2.banter.store(on, Ordering::Relaxed);
                    }
                    publish_mode(&s2);
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

fn hook_authed(s: &AppState, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    bearer.is_some_and(|b| ct_eq(b.as_bytes(), s.hook_token.as_bytes()))
}

/// Lifecycle events from any Claude Code session with the global hooks installed.
async fn hook_event(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::Json<Value>,
) -> Response {
    if !hook_authed(&s, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = body["session_id"].as_str().unwrap_or_default();
    if s.hub.session(session).is_some_and(|i| i.owned) {
        return StatusCode::NO_CONTENT.into_response();
    }
    let file = archive_hook(&s, &body);
    let out = s.hooks.lock().unwrap().payload(&body);
    for b in out.bodies {
        if let (EventBody::SessionStarted { cwd, .. }, Some(id)) = (&b, &out.session) {
            s.hub.note_session(id, PathBuf::from(cwd), false);
            if let Some(f) = &file {
                s.hub.set_archive(id, f.clone());
            }
        }
        s.hub.publish(out.session.clone(), None, b);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Claude drops the hook request when someone else decides first; axum then drops this
/// handler's future mid-await, and the card has to go.
struct Pending<'a> {
    s: &'a AppState,
    req_id: String,
    session: Option<String>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.s.hub.forget_permission(&self.req_id) {
            self.s.hub.publish(
                self.session.clone(),
                None,
                EventBody::PermissionWithdrawn {
                    req_id: self.req_id.clone(),
                },
            );
        }
    }
}

async fn hook_permission(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::Json<Value>,
) -> Response {
    if !hook_authed(&s, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let req_id = ulid_like();
    let session = body["session_id"].as_str().map(str::to_owned);
    if s.autonomous.load(Ordering::Relaxed) {
        s.hub.publish(
            session.clone(),
            None,
            EventBody::PermissionRequested {
                req_id: req_id.clone(),
                tool: body["tool_name"].as_str().unwrap_or("?").to_owned(),
                input: body["tool_input"].clone(),
            },
        );
        s.hub.publish(
            session,
            None,
            EventBody::PermissionResolved {
                req_id,
                allow: true,
                auto: true,
            },
        );
        return decision_response(true);
    }
    let rx = s.hub.park_permission(req_id.clone());
    let _pending = Pending {
        s: &s,
        req_id: req_id.clone(),
        session: session.clone(),
    };
    s.hub.publish(
        session.clone(),
        None,
        EventBody::PermissionRequested {
            req_id: req_id.clone(),
            tool: body["tool_name"].as_str().unwrap_or("?").to_owned(),
            input: body["tool_input"].clone(),
        },
    );

    let decision = match tokio::time::timeout(PERMISSION_WAIT, rx).await {
        Ok(Ok(d)) => d,
        _ => {
            s.hub.forget_permission(&req_id);
            Decision {
                allow: false,
                auto: false,
            }
        }
    };
    s.hub.publish(
        session,
        None,
        EventBody::PermissionResolved {
            req_id,
            allow: decision.allow,
            auto: decision.auto,
        },
    );
    decision_response(decision.allow)
}

fn decision_response(allow: bool) -> Response {
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
            agent: Mutex::new(None),
            launcher: None,
            hooks: Mutex::new(HookNormalizer::new()),
            port: 7777,
            token: "t0k".into(),
            hook_token: "h00k".into(),
            cwd: ".".into(),
            archive_dir: std::env::temp_dir().join("kingfisher-test-archive"),
            observed_archive: Mutex::new(None),
            autonomous: AtomicBool::new(false),
            banter: Arc::new(AtomicBool::new(false)),
            watch_token: "w4tch".into(),
            phone_url: None,
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
            agent: Mutex::new(None),
            launcher: None,
            hooks: Mutex::new(HookNormalizer::new()),
            port: 7777,
            token: "t0k".into(),
            hook_token: "h00k".into(),
            cwd: ".".into(),
            archive_dir: std::env::temp_dir().join("kingfisher-test-archive"),
            observed_archive: Mutex::new(None),
            autonomous: AtomicBool::new(false),
            banter: Arc::new(AtomicBool::new(false)),
            watch_token: "w4tch".into(),
            phone_url: None,
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

    fn state(hub: Arc<Hub>) -> Arc<AppState> {
        Arc::new(AppState {
            hub,
            agent: Mutex::new(None),
            launcher: None,
            hooks: Mutex::new(HookNormalizer::new()),
            port: 7777,
            token: "t0k".into(),
            hook_token: "h00k".into(),
            cwd: ".".into(),
            archive_dir: std::env::temp_dir().join("kingfisher-test-archive"),
            observed_archive: Mutex::new(None),
            autonomous: AtomicBool::new(false),
            banter: Arc::new(AtomicBool::new(false)),
            watch_token: "w4tch".into(),
            phone_url: None,
        })
    }

    fn hook_req(path: &str, body: &str) -> Request {
        req(
            "POST",
            path,
            &[
                ("host", "127.0.0.1:7777"),
                ("authorization", "Bearer h00k"),
                ("content-type", "application/json"),
            ],
            body,
        )
    }

    #[tokio::test]
    async fn hooks_from_our_own_child_are_not_shown_twice() {
        let hub = Hub::new();
        hub.note_session("mine", ".".into(), true);
        let app = router(state(hub.clone()));
        let body = r#"{"hook_event_name":"UserPromptSubmit","session_id":"mine","prompt":"x"}"#;
        app.clone()
            .oneshot(hook_req("/hook/event", body))
            .await
            .unwrap();
        assert!(hub.snapshot_and_subscribe().0.is_empty());

        let body = r#"{"hook_event_name":"UserPromptSubmit","session_id":"theirs","cwd":"/r","prompt":"x"}"#;
        app.oneshot(hook_req("/hook/event", body)).await.unwrap();
        assert_eq!(hub.snapshot_and_subscribe().0.len(), 2);
        assert!(!hub.session("theirs").unwrap().owned);
    }

    #[tokio::test]
    async fn abandoned_permission_request_withdraws_its_card() {
        let hub = Hub::new();
        let (_, mut live) = hub.snapshot_and_subscribe();
        let call = tokio::spawn(router(state(hub.clone())).oneshot(hook_req(
            "/hook/permission",
            r#"{"tool_name":"Bash","tool_input":{},"session_id":"s"}"#,
        )));
        let first: Value = serde_json::from_str(&live.recv().await.unwrap()).unwrap();
        assert_eq!(first["body"]["type"], "permission_requested");
        call.abort();
        let next: Value = serde_json::from_str(&live.recv().await.unwrap()).unwrap();
        assert_eq!(next["body"]["type"], "permission_withdrawn");
        assert_eq!(hub.pending_permissions(), 0);
    }

    #[tokio::test]
    async fn autonomous_mode_answers_at_once_and_says_so() {
        let hub = Hub::new();
        let st = state(hub.clone());
        st.autonomous.store(true, Ordering::Relaxed);
        let res = router(st)
            .oneshot(hook_req(
                "/hook/permission",
                r#"{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s"}"#,
            ))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out["hookSpecificOutput"]["decision"]["behavior"], "allow");
        let log = hub.snapshot_and_subscribe().0;
        let last: Value = serde_json::from_str(log.last().unwrap()).unwrap();
        assert_eq!(last["body"]["type"], "permission_resolved");
        assert_eq!(last["body"]["auto"], true);
        assert_eq!(hub.pending_permissions(), 0);
    }

    #[tokio::test]
    async fn switching_autonomous_on_releases_what_is_waiting() {
        let hub = Hub::new();
        let rx = hub.park_permission("r1".into());
        assert_eq!(hub.allow_all_pending(), 1);
        let d = rx.await.unwrap();
        assert!(d.allow && d.auto);
    }

    #[tokio::test]
    async fn the_phone_listener_cannot_steer_or_use_the_control_token() {
        let hub = Hub::new();
        let app = watch_router(state(hub.clone()));
        let lan = [
            ("host", "192.168.1.20:7778"),
            ("origin", "http://192.168.1.20:7778"),
            ("content-type", "application/json"),
        ];
        let r = req("POST", "/api/auth", &lan, r#"{"token":"t0k"}"#);
        assert_eq!(
            app.clone().oneshot(r).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let r = req("POST", "/api/auth", &lan, r#"{"token":"w4tch"}"#);
        assert_eq!(
            app.clone().oneshot(r).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let r = req(
            "POST",
            "/hook/permission",
            &[
                ("host", "192.168.1.20:7778"),
                ("authorization", "Bearer h00k"),
            ],
            "{}",
        );
        assert_eq!(
            app.clone().oneshot(r).await.unwrap().status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let r = req(
            "GET",
            "/api/files",
            &[("host", "192.168.1.20:7778"), ("cookie", "kf_7777=t0k")],
            "",
        );
        assert_eq!(
            app.oneshot(r).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn the_watch_cookie_does_not_open_the_control_side() {
        let app = router(state(Hub::new()));
        let r = req(
            "GET",
            "/api/files",
            &[("host", "127.0.0.1:7777"), ("cookie", "kfw_7777=w4tch")],
            "",
        );
        assert_eq!(
            app.oneshot(r).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
