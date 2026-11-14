mod agent;
mod hub;
mod replay;
mod web;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;

#[derive(Parser)]
#[command(
    version,
    about = "Watch, steer and approve a coding agent from a browser tab."
)]
struct Cli {
    /// Port on 127.0.0.1. Never bound on any other interface.
    #[arg(long, default_value_t = 7777)]
    port: u16,
    /// Directory the agent works in.
    #[arg(long, default_value = ".")]
    cwd: PathBuf,
    /// Replay an archive or a `claude -p --output-format stream-json` capture instead of running an agent.
    #[arg(long)]
    replay: Option<PathBuf>,
    /// Replay speed multiplier.
    #[arg(long, default_value_t = 1.0)]
    speed: f64,
    /// Resume an earlier Claude Code session by id.
    #[arg(long)]
    resume: Option<String>,
    /// Passed through as `--permission-mode`.
    #[arg(long)]
    permission_mode: Option<String>,
    /// Path to the claude binary.
    #[arg(long, default_value = "claude")]
    claude: String,
    /// Keep ANTHROPIC_API_KEY in the agent's environment. By default it is removed, so the
    /// agent uses your own subscription login.
    #[arg(long)]
    keep_api_key: bool,
    /// Do not open a browser.
    #[arg(long)]
    no_open: bool,
    /// Extra arguments for claude, after `--`.
    #[arg(last = true)]
    claude_args: Vec<String>,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("os randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();
    let cwd =
        std::fs::canonicalize(&cli.cwd).with_context(|| format!("cwd {}", cli.cwd.display()))?;

    let token = random_hex(32);
    let hook_token = random_hex(32);
    let hub = hub::Hub::new();

    let agent = match &cli.replay {
        Some(path) => {
            let (path, speed, hub) = (path.clone(), cli.speed, hub.clone());
            tokio::spawn(async move {
                if let Err(e) = replay::run(path, speed, hub.clone()).await {
                    hub.notice(format!("replay failed: {e:#}"));
                }
            });
            None
        }
        None => {
            let dir = dirs::data_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("kingfisher/sessions");
            std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            let archive = dir.join(format!("{}.ndjson", hub::now_ms()));
            tracing::info!("archiving to {}", archive.display());
            Some(agent::start(
                agent::AgentConfig {
                    claude: cli.claude.clone(),
                    cwd: cwd.clone(),
                    hook_url: format!("http://127.0.0.1:{}/hook/permission", cli.port),
                    hook_token: hook_token.clone(),
                    keep_api_key: cli.keep_api_key,
                    permission_mode: cli.permission_mode.clone(),
                    resume: cli.resume.clone(),
                    extra_args: cli.claude_args.clone(),
                    archive,
                },
                hub.clone(),
            ))
        }
    };

    let state = Arc::new(web::AppState {
        hub,
        agent,
        port: cli.port,
        token: token.clone(),
        hook_token,
        cwd,
    });
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, cli.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;

    // The token rides in the fragment, which browsers never send to the server or put in logs.
    let url = format!("http://127.0.0.1:{}/#t={token}", cli.port);
    println!("kingfisher is watching at {url}");
    if !cli.no_open {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let _ = std::process::Command::new(opener).arg(&url).spawn();
    }

    axum::serve(listener, web::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
