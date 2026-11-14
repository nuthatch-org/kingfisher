use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use kingfisher_events::{ClaudeNormalizer, EventBody};
use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::hub::{Hub, now_ms};

/// Variables that would make the child think it is nested inside another Claude Code session,
/// or make it bill an API key instead of the user's own subscription login.
const STRIP_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
];

pub struct AgentConfig {
    pub claude: String,
    pub cwd: PathBuf,
    pub hook_url: String,
    pub hook_token: String,
    pub keep_api_key: bool,
    pub permission_mode: Option<String>,
    pub resume: Option<String>,
    pub extra_args: Vec<String>,
    pub archive: PathBuf,
}

pub enum AgentCmd {
    Prompt(String),
    Interrupt,
    Exited(u64),
    SessionId(String),
}

#[derive(Clone)]
pub struct AgentHandle(mpsc::Sender<AgentCmd>);

impl AgentHandle {
    pub async fn send(&self, cmd: AgentCmd) {
        let _ = self.0.send(cmd).await;
    }
}

struct Running {
    generation: u64,
    child: Child,
    stdin: ChildStdin,
}

pub fn start(cfg: AgentConfig, hub: Arc<Hub>) -> AgentHandle {
    let (tx, rx) = mpsc::channel(64);
    let handle = AgentHandle(tx.clone());
    tokio::spawn(supervise(cfg, hub, rx, tx));
    handle
}

/// Owns the child. A prompt arriving after the child has exited respawns it with `--resume`,
/// so a crash or a hang-kill costs a restart, not the conversation.
async fn supervise(
    cfg: AgentConfig,
    hub: Arc<Hub>,
    mut rx: mpsc::Receiver<AgentCmd>,
    tx: mpsc::Sender<AgentCmd>,
) {
    let mut session = cfg.resume.clone();
    let mut generation = 0u64;
    let mut running: Option<Running> = None;

    match spawn(&cfg, session.as_deref(), generation, &hub, &tx).await {
        Ok(r) => running = Some(r),
        Err(e) => hub.notice(format!("could not start claude: {e:#}")),
    }

    while let Some(cmd) = rx.recv().await {
        match cmd {
            AgentCmd::SessionId(id) => session = Some(id),
            AgentCmd::Exited(g) => {
                if running.as_ref().is_some_and(|r| r.generation == g) {
                    let mut r = running.take().unwrap();
                    let code = r.child.wait().await.ok().and_then(|s| s.code());
                    hub.publish(session.clone(), None, EventBody::AgentExited { code });
                }
            }
            AgentCmd::Interrupt => match running.as_ref().and_then(|r| r.child.id()) {
                Some(pid) => {
                    use nix::sys::signal::{Signal, kill};
                    use nix::unistd::Pid;
                    if let Err(e) = kill(Pid::from_raw(pid as i32), Signal::SIGINT) {
                        hub.notice(format!("interrupt failed: {e}"));
                    }
                }
                None => hub.notice("nothing to interrupt: the agent is not running"),
            },
            AgentCmd::Prompt(text) => {
                if running.is_none() {
                    generation += 1;
                    match spawn(&cfg, session.as_deref(), generation, &hub, &tx).await {
                        Ok(r) => running = Some(r),
                        Err(e) => {
                            hub.notice(format!("could not start claude: {e:#}"));
                            continue;
                        }
                    }
                }
                let line = json!({
                    "type": "user",
                    "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                })
                .to_string();
                let r = running.as_mut().unwrap();
                let wrote = async {
                    r.stdin.write_all(line.as_bytes()).await?;
                    r.stdin.write_all(b"\n").await?;
                    r.stdin.flush().await
                }
                .await;
                if let Err(e) = wrote {
                    hub.notice(format!("could not write to claude: {e}"));
                }
            }
        }
    }
}

fn settings(cfg: &AgentConfig) -> String {
    json!({
        "hooks": {
            "PermissionRequest": [{
                "matcher": "*",
                "hooks": [{
                    "type": "http",
                    "url": cfg.hook_url,
                    "timeout": 600,
                    "headers": {"Authorization": "Bearer $KF_HOOK_TOKEN"},
                    "allowedEnvVars": ["KF_HOOK_TOKEN"],
                }],
            }],
        },
    })
    .to_string()
}

async fn spawn(
    cfg: &AgentConfig,
    resume: Option<&str>,
    generation: u64,
    hub: &Arc<Hub>,
    tx: &mpsc::Sender<AgentCmd>,
) -> Result<Running> {
    let mut cmd = Command::new(&cfg.claude);
    cmd.current_dir(&cfg.cwd)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--include-hook-events",
            "--replay-user-messages",
            "--forward-subagent-text",
            "--settings",
        ])
        .arg(settings(cfg));
    if let Some(id) = resume {
        cmd.args(["--resume", id]);
    }
    if let Some(mode) = &cfg.permission_mode {
        cmd.args(["--permission-mode", mode]);
    }
    cmd.args(&cfg.extra_args);
    for var in STRIP_ENV {
        cmd.env_remove(var);
    }
    if !cfg.keep_api_key {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env("KF_HOOK_TOKEN", &cfg.hook_token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning {}", cfg.claude))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let archive = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cfg.archive)
        .await
        .with_context(|| format!("opening archive {}", cfg.archive.display()))?;

    tokio::spawn(read_stdout(
        stdout,
        archive,
        hub.clone(),
        tx.clone(),
        generation,
    ));
    let hub2 = hub.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!(target: "claude", "{line}");
            hub2.notice(format!("claude stderr: {line}"));
        }
    });

    hub.notice(match resume {
        Some(id) => format!("claude started, resuming {id}"),
        None => "claude started".to_string(),
    });
    Ok(Running {
        generation,
        child,
        stdin,
    })
}

async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    mut archive: File,
    hub: Arc<Hub>,
    tx: mpsc::Sender<AgentCmd>,
    generation: u64,
) {
    let mut normalizer = ClaudeNormalizer::new();
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let record = match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(raw) => json!({"ts": now_ms(), "raw": raw}).to_string(),
                    Err(_) => json!({"ts": now_ms(), "text": line}).to_string(),
                };
                if let Err(e) = archive.write_all(format!("{record}\n").as_bytes()).await {
                    tracing::warn!("archive write failed: {e}");
                }
                let out = normalizer.line(&line);
                for body in out.bodies {
                    if let EventBody::SessionStarted { .. } = &body
                        && let Some(id) = &out.session
                    {
                        let _ = tx.send(AgentCmd::SessionId(id.clone())).await;
                    }
                    hub.publish(out.session.clone(), out.parent.clone(), body);
                }
            }
            Ok(None) => break,
            Err(e) => {
                hub.notice(format!("reading claude output failed: {e}"));
                break;
            }
        }
    }
    let _ = archive.flush().await;
    let _ = tx.send(AgentCmd::Exited(generation)).await;
}
