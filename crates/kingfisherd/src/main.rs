mod agent;
mod archive;
mod hub;
mod install;
mod replay;
mod web;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use kingfisher_events::HookNormalizer;

#[derive(Parser)]
#[command(
    version,
    about = "Watch, steer and approve a coding agent from a browser tab.",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
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
    /// Start no agent; only show sessions reporting through the global hooks
    /// (see `install-hooks`). Any of them can be taken over from the page.
    #[arg(long)]
    observe: bool,
    /// Interrupt a turn silent this many seconds with no tool or permission outstanding. 0 disables.
    #[arg(long, default_value_t = 300)]
    watchdog_secs: u64,
    /// Start with autonomous mode on: the daemon approves every permission request itself.
    /// The switch on the page turns it off again.
    #[arg(long)]
    autonomous: bool,
    /// Start with banter on: the agent adds absurd motoring-presenter asides to its chat replies.
    #[arg(long)]
    banter: bool,
    /// Also serve a read-only view on the local network, on port+1, for watching from a phone.
    /// It needs its own token and can never prompt, approve or switch anything.
    #[arg(long)]
    phone: bool,
    /// Extra arguments for claude, after `--`.
    #[arg(last = true)]
    claude_args: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Add hooks to ~/.claude/settings.json so every Claude Code session reports here. Asks first.
    InstallHooks {
        #[arg(long, default_value_t = 7777)]
        port: u16,
        #[arg(long)]
        yes: bool,
    },
    /// Remove kingfisher's hooks from ~/.claude/settings.json.
    UninstallHooks {
        #[arg(long)]
        yes: bool,
    },
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("os randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The address this machine uses on its local network. A UDP connect sends no packets; it only
/// asks the kernel which interface would route there.
fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// Global hooks carry this token in settings.json, so it has to survive restarts.
fn hook_token() -> Result<String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = dirs::config_dir()
        .context("no config directory")?
        .join("kingfisher");
    let path = dir.join("hook-token");
    if let Ok(t) = std::fs::read_to_string(&path)
        && t.trim().len() == 64
    {
        return Ok(t.trim().to_owned());
    }
    std::fs::create_dir_all(&dir)?;
    let token = random_hex(32);
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| f.write_all(token.as_bytes()))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(token)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();
    match cli.command {
        Some(Command::InstallHooks { port, yes }) => {
            return install::run(true, port, &hook_token()?, yes);
        }
        Some(Command::UninstallHooks { yes }) => return install::run(false, 0, "", yes),
        None => {}
    }
    let cwd =
        std::fs::canonicalize(&cli.cwd).with_context(|| format!("cwd {}", cli.cwd.display()))?;

    let token = random_hex(32);
    let hook_token = hook_token()?;
    let watch_token = random_hex(16);
    let phone_port = cli.port + 1;
    let phone_url = if cli.phone {
        lan_ip().map(|ip| format!("http://{ip}:{phone_port}/#t={watch_token}"))
    } else {
        None
    };
    let hub = hub::Hub::new();
    let global_hooks = install::has_global_permission_hook(cli.port);
    let banter = Arc::new(std::sync::atomic::AtomicBool::new(cli.banter));
    let archive_dir = archive::default_dir();
    std::fs::create_dir_all(&archive_dir)
        .with_context(|| format!("creating {}", archive_dir.display()))?;
    tracing::info!("archiving to {}", archive_dir.display());

    let launcher = match &cli.replay {
        Some(path) => {
            let (path, speed, hub) = (path.clone(), cli.speed, hub.clone());
            tokio::spawn(async move {
                if let Err(e) = replay::run(path, speed, hub.clone()).await {
                    hub.notice(format!("replay failed: {e:#}"));
                }
            });
            None
        }
        None => Some(agent::Launcher {
            claude: cli.claude.clone(),
            hook_url: install::permission_url(cli.port),
            hook_token: hook_token.clone(),
            keep_api_key: cli.keep_api_key,
            permission_mode: cli.permission_mode.clone(),
            extra_args: cli.claude_args.clone(),
            archive_dir: archive_dir.clone(),
            watchdog: (cli.watchdog_secs > 0).then(|| Duration::from_secs(cli.watchdog_secs)),
            global_permission_hook: global_hooks,
            banter: banter.clone(),
        }),
    };
    let agent = match &launcher {
        Some(l) if !cli.observe => Some(agent::start(
            l.config(cwd.clone(), cli.resume.clone()),
            hub.clone(),
        )),
        _ => None,
    };
    if cli.observe {
        hub.notice(if global_hooks {
            "observing: sessions started with the global hooks appear here"
        } else {
            "observing, but no global hooks point here yet: run `kingfisherd install-hooks`"
        });
    }

    let state = Arc::new(web::AppState {
        hub,
        agent: Mutex::new(agent),
        launcher,
        hooks: Mutex::new(HookNormalizer::new()),
        port: cli.port,
        token: token.clone(),
        hook_token,
        cwd,
        archive_dir,
        observed_archive: Mutex::new(None),
        autonomous: std::sync::atomic::AtomicBool::new(cli.autonomous),
        banter,
        watch_token,
        phone_url: phone_url.clone(),
    });
    web::publish_mode(&state);
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

    if let Some(url) = &phone_url {
        let addr = SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, phone_port));
        let phone = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("binding {addr} for the phone view"))?;
        println!("watch from a phone on this network (read-only): {url}");
        if let Ok(code) = qrcode::QrCode::new(url.as_bytes()) {
            println!(
                "{}",
                code.render::<qrcode::render::unicode::Dense1x2>()
                    .quiet_zone(true)
                    .build()
            );
        }
        let router = web::watch_router(state.clone());
        tokio::spawn(async move {
            if let Err(e) = axum::serve(phone, router).await {
                tracing::warn!("phone view stopped: {e}");
            }
        });
    } else if cli.phone {
        println!("no LAN address found, so there is no phone view");
    }

    axum::serve(listener, web::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
