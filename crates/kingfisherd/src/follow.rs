//! Follows a running Claude Code session through its own transcript file, read-only. Works for
//! sessions started before kingfisher existed, which hooks cannot reach.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use kingfisher_events::{ClaudeNormalizer, EventBody};
use tokio::task::JoinHandle;

use crate::hub::Hub;

/// How far back from the end to start, so a long session does not send its whole history.
const BACKLOG_BYTES: u64 = 1_500_000;

/// The session's working directory, from the most recent line that names one.
pub fn cwd_of(path: &Path) -> Option<PathBuf> {
    let text = tail(path, BACKLOG_BYTES).ok()?;
    text.lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        v["cwd"].as_str().map(PathBuf::from)
    })
}

fn tail(path: &Path, bytes: u64) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(bytes)))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    // Starting mid-file lands mid-line; drop the fragment.
    Ok(if len > bytes {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or_default()
    } else {
        text
    })
}

pub async fn run(path: PathBuf, hub: Arc<Hub>) -> Result<()> {
    run_from(path, hub, BACKLOG_BYTES).await
}

/// Every session whose transcript was written to within `window`, each followed as it appears.
/// Runs until the daemon stops; new sessions are picked up on the next scan.
pub async fn run_all(projects: PathBuf, hub: Arc<Hub>, window: Duration) -> Result<()> {
    hub.notice(format!(
        "following every session active in the last {} minutes",
        window.as_secs() / 60
    ));
    run_matching(projects, hub, window, None).await
}

/// A Claude Code process's entry in `~/.claude/sessions/<pid>.json`. Internal to Claude Code,
/// so read leniently: only the three fields used here.
#[derive(serde::Deserialize)]
struct OpenSession {
    pid: i32,
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: PathBuf,
    /// `busy`, `idle` (finished, waiting for the next message) or `waiting` (a permission
    /// prompt or a question is up), with `waitingFor` saying which.
    #[serde(default)]
    status: Option<String>,
    #[serde(rename = "waitingFor", default)]
    waiting_for: Option<serde_json::Value>,
}

impl OpenSession {
    /// One word for the page: `busy`, `idle`, or `waiting: <what>`.
    fn state(&self) -> String {
        match self.status.as_deref() {
            Some("waiting") => {
                let what = match &self.waiting_for {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(v) => v
                        .get("type")
                        .or_else(|| v.get("kind"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("you")
                        .to_owned(),
                    None => "you".into(),
                };
                format!("waiting: {what}")
            }
            Some(s) => s.to_owned(),
            None => "busy".into(),
        }
    }
}

fn alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

/// Session ids of the Claude Code terminals open in `cwd` right now, or `None` when this
/// Claude Code keeps no registry to ask.
pub fn open_sessions(registry: &Path, cwd: &Path) -> Option<Vec<String>> {
    session_states(registry, cwd).map(|v| v.into_iter().map(|(id, _)| id).collect())
}

/// The open sessions in `cwd` with their current state, as `open_sessions` but with the status.
pub fn session_states(registry: &Path, cwd: &Path) -> Option<Vec<(String, String)>> {
    let entries = std::fs::read_dir(registry).ok()?;
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<OpenSession>(&std::fs::read(e.path()).ok()?).ok())
        .filter(|s| s.cwd == cwd && alive(s.pid))
        .map(|s| (s.session_id.clone(), s.state()))
        .collect();
    out.sort();
    out.dedup_by(|a, b| a.0 == b.0);
    Some(out)
}

/// One project, one terminal or more: follow exactly the sessions open in `cwd`, add ones that
/// open later, and see off ones that close.
pub async fn run_project(
    dir: PathBuf,
    cwd: PathBuf,
    registry: PathBuf,
    hub: Arc<Hub>,
) -> Result<()> {
    hub.notice(format!(
        "watching the Claude Code sessions open in {}",
        cwd.display()
    ));
    if open_sessions(&registry, &cwd).is_none() {
        // An older Claude Code without the registry: fall back to recently written transcripts.
        let projects = dir.parent().map(Path::to_path_buf).unwrap_or_default();
        return run_matching(projects, hub, Duration::from_secs(10 * 60), Some(dir)).await;
    }
    let mut following: std::collections::HashMap<String, JoinHandle<()>> = Default::default();
    let mut states: std::collections::HashMap<String, String> = Default::default();
    loop {
        let current = session_states(&registry, &cwd).unwrap_or_default();
        // Status changes are how the page knows a terminal is waiting on its person.
        for (id, state) in &current {
            if states.get(id) != Some(state) {
                states.insert(id.clone(), state.clone());
                hub.publish(
                    Some(id.clone()),
                    None,
                    EventBody::Status {
                        status: state.clone(),
                    },
                );
            }
        }
        let open: Vec<String> = current.into_iter().map(|(id, _)| id).collect();
        for id in &open {
            let path = dir.join(format!("{id}.jsonl"));
            if following.contains_key(id) || !path.exists() {
                continue;
            }
            let hub = hub.clone();
            let task = tokio::spawn(async move {
                if let Err(e) = run_from(path.clone(), hub.clone(), BACKLOG_BYTES).await {
                    hub.notice(format!("stopped following {}: {e:#}", path.display()));
                }
            });
            following.insert(id.clone(), task);
        }
        let closed: Vec<String> = following
            .keys()
            .filter(|id| !open.contains(id))
            .cloned()
            .collect();
        for id in closed {
            if let Some(task) = following.remove(&id) {
                task.abort();
            }
            states.remove(&id);
            hub.publish(
                Some(id),
                None,
                EventBody::SessionEnded {
                    reason: Some("terminal closed".into()),
                },
            );
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn run_matching(
    projects: PathBuf,
    hub: Arc<Hub>,
    window: Duration,
    only: Option<PathBuf>,
) -> Result<()> {
    let mut following = std::collections::HashSet::new();
    loop {
        let found = active_transcripts(&projects, window)
            .into_iter()
            .filter(|p| only.as_deref().is_none_or(|d| p.parent() == Some(d)));
        for path in found {
            if following.insert(path.clone()) {
                let hub = hub.clone();
                tokio::spawn(async move {
                    // A smaller backlog each, since several sessions share one page.
                    if let Err(e) = run_from(path.clone(), hub.clone(), 400_000).await {
                        hub.notice(format!("stopped following {}: {e:#}", path.display()));
                    }
                });
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

/// `<projects>/<dir>/<session>.jsonl`, modified within `window`. Subagent transcripts live a
/// level deeper and are left out; their work shows through the parent's Task calls.
/// Claude Code keeps a project's transcripts in a folder named after its path, every character
/// that is not a letter, digit or hyphen turned into a hyphen. If that guess misses, look for the
/// folder whose newest transcript says it ran in `cwd`.
pub fn project_dir(projects: &Path, cwd: &Path) -> Option<PathBuf> {
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let guess = projects.join(&encoded);
    if guess.is_dir() {
        return Some(guess);
    }
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|d| d.path())
        .find(|dir| {
            let newest = std::fs::read_dir(dir)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
                .max_by_key(|f| f.metadata().and_then(|m| m.modified()).ok());
            newest.is_some_and(|f| cwd_of(&f.path()).as_deref() == Some(cwd))
        })
}

pub fn active_transcripts(projects: &Path, window: Duration) -> Vec<PathBuf> {
    let now = std::time::SystemTime::now();
    let Ok(dirs) = std::fs::read_dir(projects) else {
        return vec![];
    };
    let mut out = vec![];
    for dir in dirs.flatten().filter(|d| d.path().is_dir()) {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            let fresh = f
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age < window);
            if fresh && p.extension().is_some_and(|e| e == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

/// One transcript being read from where it was opened onwards.
struct Tail {
    file: std::fs::File,
    // Bytes, not text: a read can end inside a multi-byte character as well as inside a line.
    pending: Vec<u8>,
    skip_fragment: bool,
    normalizer: ClaudeNormalizer,
    /// For a subagent's transcript, the parent's Agent call, so its work goes to the helper robot.
    parent: Option<String>,
}

impl Tail {
    fn open(
        path: &Path,
        backlog: u64,
        normalizer: ClaudeNormalizer,
        parent: Option<String>,
    ) -> Result<Self> {
        let mut file =
            std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let len = file.metadata()?.len();
        let start = len.saturating_sub(backlog);
        file.seek(SeekFrom::Start(start))?;
        Ok(Self {
            file,
            pending: Vec::new(),
            skip_fragment: start > 0,
            normalizer,
            parent,
        })
    }

    fn poll(&mut self, hub: &Hub) -> Result<()> {
        let mut buf = Vec::new();
        self.file.read_to_end(&mut buf)?;
        self.pending.extend_from_slice(&buf);
        // Only whole lines; the writer may be mid-line when we read.
        while let Some(i) = self.pending.iter().position(|&c| c == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=i).collect();
            if std::mem::take(&mut self.skip_fragment) {
                continue;
            }
            let line = String::from_utf8_lossy(&raw);
            let out = self.normalizer.line(line.trim_end());
            let parent = self.parent.clone().or(out.parent);
            for body in out.bodies {
                // Lets the page fetch this session's own file list for its city.
                if let (EventBody::SessionStarted { cwd, .. }, Some(id)) = (&body, &out.session) {
                    hub.note_session(id, PathBuf::from(cwd), false);
                }
                hub.publish(out.session.clone(), parent.clone(), body);
            }
        }
        Ok(())
    }
}

/// `<session>/subagents/agent-<id>.jsonl` beside a `.meta.json` whose `toolUseId` names the
/// parent's Agent call. Files whose meta has not been written yet are left for the next scan.
fn subagents(dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let meta: serde_json::Value =
                serde_json::from_slice(&std::fs::read(p.with_extension("meta.json")).ok()?).ok()?;
            Some((p, meta["toolUseId"].as_str()?.to_owned()))
        })
        .collect()
}

async fn run_from(path: PathBuf, hub: Arc<Hub>, backlog: u64) -> Result<()> {
    let mut main = Tail::open(&path, backlog, ClaudeNormalizer::for_transcript(), None)?;
    let sub_dir = path.with_extension("").join("subagents");
    let mut subs: std::collections::HashMap<PathBuf, Tail> = Default::default();
    hub.notice(format!(
        "following {}",
        path.parent()
            .and_then(|d| d.file_name())
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    for tick in 0u64.. {
        main.poll(&hub)?;
        if tick % 6 == 0 {
            for (file, tool_use) in subagents(&sub_dir) {
                if subs.contains_key(&file) {
                    continue;
                }
                // A helper that finished before we started is history; only recent ones walk in.
                let fresh = file
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age < Duration::from_secs(600));
                if !fresh {
                    subs.insert(
                        file.clone(),
                        Tail::open(&file, 0, ClaudeNormalizer::for_subagent(), Some(tool_use))?,
                    );
                    continue;
                }
                match Tail::open(
                    &file,
                    300_000,
                    ClaudeNormalizer::for_subagent(),
                    Some(tool_use),
                ) {
                    Ok(t) => {
                        subs.insert(file, t);
                    }
                    Err(e) => tracing::warn!("subagent transcript: {e:#}"),
                }
            }
        }
        for t in subs.values_mut() {
            if let Err(e) = t.poll(&hub) {
                tracing::warn!("subagent transcript: {e:#}");
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_files_are_paired_with_the_call_that_started_them() {
        let dir = std::env::temp_dir().join(format!("kf-subagents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-a1.jsonl"), "").unwrap();
        std::fs::write(
            dir.join("agent-a1.meta.json"),
            r#"{"toolUseId":"toolu_X","description":"review"}"#,
        )
        .unwrap();
        // Meta not written yet: wait for the next scan rather than guess.
        std::fs::write(dir.join("agent-a2.jsonl"), "").unwrap();
        assert_eq!(
            subagents(&dir),
            vec![(dir.join("agent-a1.jsonl"), "toolu_X".to_string())]
        );
    }

    #[test]
    fn only_live_sessions_in_this_folder_count_as_open() {
        let reg = std::env::temp_dir().join(format!("kf-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&reg).unwrap();
        let me = std::process::id();
        std::fs::write(
            reg.join("a.json"),
            format!(r#"{{"pid":{me},"sessionId":"open-here","cwd":"/p/app","status":"busy"}}"#),
        )
        .unwrap();
        std::fs::write(
            reg.join("b.json"),
            format!(r#"{{"pid":{me},"sessionId":"open-elsewhere","cwd":"/p/other"}}"#),
        )
        .unwrap();
        // A pid that cannot be running: the entry outlived its process.
        std::fs::write(
            reg.join("c.json"),
            r#"{"pid":999999,"sessionId":"stale","cwd":"/p/app"}"#,
        )
        .unwrap();
        std::fs::write(reg.join("d.json"), "not json").unwrap();
        assert_eq!(
            open_sessions(&reg, Path::new("/p/app")),
            Some(vec!["open-here".to_string()])
        );
        std::fs::write(reg.join("a.json"), format!(r#"{{"pid":{me},"sessionId":"open-here","cwd":"/p/app","status":"waiting","waitingFor":"permission"}}"#)).unwrap();
        assert_eq!(
            session_states(&reg, Path::new("/p/app")),
            Some(vec![("open-here".into(), "waiting: permission".into())])
        );
        assert_eq!(
            open_sessions(&reg.join("missing"), Path::new("/p/app")),
            None
        );
    }

    #[test]
    fn project_folders_are_found_by_their_encoded_path() {
        let root = std::env::temp_dir().join(format!("kf-projects-{}", std::process::id()));
        let dir = root.join("-Users-me-code-my-app");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            project_dir(&root, Path::new("/Users/me/code/my-app")),
            Some(dir)
        );
        assert_eq!(project_dir(&root, Path::new("/Users/me/elsewhere")), None);
    }

    #[test]
    fn tail_never_starts_mid_line() {
        let dir = std::env::temp_dir().join(format!("kf-follow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"cwd\":\"/one\"}\n{\"cwd\":\"/two\"}\n").unwrap();
        assert_eq!(tail(&p, 16).unwrap(), "{\"cwd\":\"/two\"}\n");
        assert_eq!(cwd_of(&p), Some(PathBuf::from("/two")));
    }
}
