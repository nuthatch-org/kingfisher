//! Follows a running Claude Code session through its own transcript file, read-only. Works for
//! sessions started before kingfisher existed, which hooks cannot reach.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use kingfisher_events::{ClaudeNormalizer, EventBody};

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

/// One project's sessions only: the transcripts in that project's own folder.
pub async fn run_project(dir: PathBuf, hub: Arc<Hub>) -> Result<()> {
    let projects = dir.parent().map(Path::to_path_buf).unwrap_or_default();
    hub.notice(format!(
        "watching this project's Claude Code sessions ({})",
        dir.file_name()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    // Six hours back, so a session left open over lunch is still on the floor.
    run_matching(projects, hub, Duration::from_secs(6 * 3600), Some(dir)).await
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

async fn run_from(path: PathBuf, hub: Arc<Hub>, backlog: u64) -> Result<()> {
    let mut f =
        std::fs::File::open(&path).with_context(|| format!("opening {}", path.display()))?;
    let len = f.metadata()?.len();
    let mut normalizer = ClaudeNormalizer::for_transcript();
    let start = len.saturating_sub(backlog);
    f.seek(SeekFrom::Start(start))?;
    // Bytes, not text: a read can end inside a multi-byte character as well as inside a line.
    let mut pending: Vec<u8> = Vec::new();
    let mut skip_fragment = start > 0;
    hub.notice(format!(
        "following {}",
        path.parent()
            .and_then(|d| d.file_name())
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));

    loop {
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        if !buf.is_empty() {
            pending.extend_from_slice(&buf);
            // Only whole lines; the writer may be mid-line when we read.
            while let Some(i) = pending.iter().position(|&c| c == b'\n') {
                let raw: Vec<u8> = pending.drain(..=i).collect();
                if skip_fragment {
                    skip_fragment = false;
                    continue;
                }
                let line = String::from_utf8_lossy(&raw);
                let out = normalizer.line(line.trim_end());
                for body in out.bodies {
                    // Lets the page fetch this session's own file list for its city.
                    if let (EventBody::SessionStarted { cwd, .. }, Some(id)) = (&body, &out.session)
                    {
                        hub.note_session(id, PathBuf::from(cwd), false);
                    }
                    hub.publish(out.session.clone(), out.parent.clone(), body);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
