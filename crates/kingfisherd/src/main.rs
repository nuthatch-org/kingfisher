mod agent;
mod archive;
mod follow;
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
    /// Follow a running Claude Code session through its transcript file
    /// (`~/.claude/projects/<dir>/<session>.jsonl`), read-only. Works for sessions kingfisher
    /// did not start and that have no hooks.
    #[arg(long, conflicts_with = "replay")]
    follow: Option<PathBuf>,
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
    /// Serve the read-only view on your tailnet over HTTPS with `tailscale serve`, for as long as
    /// the daemon runs. The watch listener then binds to localhost only, unless --phone is given too.
    #[arg(long)]
    tailscale: bool,
    /// HTTPS port on the tailnet name.
    #[arg(long, default_value_t = 443)]
    tailscale_port: u16,
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

fn tailscale_cli() -> String {
    const APP: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    let on_path = std::process::Command::new("tailscale")
        .arg("version")
        .output()
        .is_ok_and(|o| o.status.success());
    if on_path || !std::path::Path::new(APP).exists() {
        "tailscale".into()
    } else {
        APP.into()
    }
}

fn tailnet_name() -> Option<String> {
    let out = std::process::Command::new(tailscale_cli())
        .args(["status", "--json"])
        .output()
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_owned())
}

/// Foreground `tailscale serve`: its route belongs to this process and goes when it does,
/// so nothing is left in the user's Tailscale config.
fn tailscale_serve(https_port: u16, local_port: u16) -> Result<tokio::process::Child> {
    tokio::process::Command::new(tailscale_cli())
        .args([
            "serve",
            &format!("--https={https_port}"),
            &format!("http://127.0.0.1:{local_port}"),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("starting tailscale serve")
        .map(|mut child| {
            if let Some(err) = child.stderr.take() {
                tokio::spawn(async move {
                    use tokio::io::AsyncBufReadExt;
                    let mut lines = tokio::io::BufReader::new(err).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::warn!(target: "tailscale", "{line}");
                    }
                });
            }
            child
        })
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
    let cwd = match cli.follow.as_deref().and_then(follow::cwd_of) {
        Some(followed) => followed,
        None => {
            std::fs::canonicalize(&cli.cwd).with_context(|| format!("cwd {}", cli.cwd.display()))?
        }
    };

    let token = random_hex(32);
    let hook_token = hook_token()?;
    let watch_token = random_hex(16);
    let phone_port = cli.port + 1;
    let lan_url = if cli.phone {
        lan_ip().map(|ip| format!("http://{ip}:{phone_port}/#t={watch_token}"))
    } else {
        None
    };
    let tailnet = if cli.tailscale {
        let name = tailnet_name()
            .context("--tailscale: no tailnet name; is Tailscale running and logged in?")?;
        let port = match cli.tailscale_port {
            443 => String::new(),
            p => format!(":{p}"),
        };
        Some(format!("https://{name}{port}/#t={watch_token}"))
    } else {
        None
    };
    // The tailnet address works from anywhere on the tailnet, so it is the one to hand out.
    let phone_url = tailnet.clone().or(lan_url.clone());
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
    if let Some(path) = cli.follow.clone() {
        let hub = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = follow::run(path, hub.clone()).await {
                hub.notice(format!("follow stopped: {e:#}"));
            }
        });
    }
    let agent = match &launcher {
        Some(l) if !cli.observe && cli.follow.is_none() => Some(agent::start(
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

    let mut _serve = None;
    if phone_url.is_some() {
        let ip = if cli.phone {
            Ipv4Addr::UNSPECIFIED
        } else {
            Ipv4Addr::LOCALHOST
        };
        let addr = SocketAddr::from((ip, phone_port));
        let phone = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("binding {addr} for the phone view"))?;
        let router = web::watch_router(state.clone());
        tokio::spawn(async move {
            if let Err(e) = axum::serve(phone, router).await {
                tracing::warn!("phone view stopped: {e}");
            }
        });
        if let Some(url) = &lan_url {
            println!("watch on this network (read-only): {url}");
        }
        if let Some(url) = &tailnet {
            _serve = Some(tailscale_serve(cli.tailscale_port, phone_port)?);
            println!("watch from anywhere on your tailnet (read-only): {url}");
        }
        if let Some(url) = &phone_url
            && let Ok(code) = qrcode::QrCode::new(url.as_bytes())
        {
            println!(
                "{}",
                code.render::<qrcode::render::unicode::Dense1x2>()
                    .quiet_zone(true)
                    .build()
            );
        }
    } else if cli.phone {
        println!("no LAN address found, so there is no phone view");
    }

    axum::serve(listener, web::router(state))
        // SIGTERM too, or `kill` skips the drops that take tailscale serve and claude down with us.
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        })
        .await?;
    Ok(())
}
