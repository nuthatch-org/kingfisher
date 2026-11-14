//! The session library: archives written by the agent reader (`{"ts", "raw"}` lines) and by the
//! hook receiver (`{"ts", "hook"}` lines), listed and replayed for the page.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use kingfisher_events::{AgentEvent, ClaudeNormalizer, EventBody, HookNormalizer, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    pub name: String,
    pub bytes: u64,
    pub started: Option<i64>,
    pub ended: Option<i64>,
    pub cwd: Option<String>,
    pub session: Option<String>,
    pub first_prompt: Option<String>,
    pub tool_calls: usize,
    pub observed: bool,
}

/// Archive names come from the page, so they must be bare file names and nothing else.
pub fn valid_name(name: &str) -> bool {
    name.ends_with(".ndjson")
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn load(dir: &Path, name: &str) -> Result<Vec<AgentEvent>> {
    if !valid_name(name) {
        bail!("bad archive name");
    }
    let text =
        std::fs::read_to_string(dir.join(name)).with_context(|| format!("reading {name}"))?;
    Ok(events(&text))
}

pub fn events(text: &str) -> Vec<AgentEvent> {
    let mut claude = ClaudeNormalizer::new();
    let mut hooks = HookNormalizer::new();
    let mut out = vec![];
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v["ts"].as_i64().unwrap_or(0);
        let n = if let Some(raw) = v.get("raw") {
            claude.value(raw)
        } else if let Some(hook) = v.get("hook") {
            hooks.payload(hook)
        } else if let Some(Ok(body)) = v.get("kf").map(EventBody::deserialize) {
            kingfisher_events::Normalized {
                session: None,
                parent: None,
                bodies: vec![body],
            }
        } else {
            continue;
        };
        for body in n.bodies {
            out.push(AgentEvent {
                v: SCHEMA_VERSION,
                seq: out.len() as u64 + 1,
                ts,
                session: n.session.clone(),
                parent: n.parent.clone(),
                body,
            });
        }
    }
    out
}

pub fn summarize(name: String, bytes: u64, text: &str) -> Summary {
    let mut s = Summary {
        name,
        bytes,
        started: None,
        ended: None,
        cwd: None,
        session: None,
        first_prompt: None,
        tool_calls: 0,
        observed: text.lines().next().is_some_and(|l| l.contains("\"hook\":")),
    };
    for e in events(text) {
        s.started.get_or_insert(e.ts);
        s.ended = Some(e.ts);
        match e.body {
            EventBody::SessionStarted { cwd, .. } if s.cwd.is_none() => {
                s.cwd = Some(cwd);
                s.session = e.session;
            }
            EventBody::TurnStarted { text } if s.first_prompt.is_none() => {
                s.first_prompt = Some(text.chars().take(160).collect());
            }
            EventBody::ToolCall { .. } => s.tool_calls += 1,
            _ => {}
        }
    }
    s
}

pub fn list(dir: &Path) -> Vec<Summary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<Summary> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !valid_name(&name) {
                return None;
            }
            let bytes = e.metadata().ok()?.len();
            let text = std::fs::read_to_string(e.path()).ok()?;
            Some(summarize(name, bytes, &text))
        })
        .filter(|s| s.started.is_some())
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.started));
    out
}

pub fn default_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("kingfisher/sessions")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_escape_the_directory() {
        assert!(valid_name("1794666393672.ndjson"));
        assert!(valid_name("observed-1794666393672.ndjson"));
        for bad in [
            "../x.ndjson",
            "a/b.ndjson",
            ".hidden.ndjson",
            "x.json",
            "x.ndjson\0",
            "%2e%2e.ndjson",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn both_archive_kinds_replay_with_their_own_timestamps() {
        let text = concat!(
            r#"{"ts":1000,"raw":{"type":"system","subtype":"init","session_id":"a","cwd":"/r","model":"m","apiKeySource":"none"}}"#,
            "\n",
            r#"{"ts":1500,"raw":{"type":"user","isReplay":true,"session_id":"a","message":{"content":[{"type":"text","text":"go"}]}}}"#,
            "\n",
            r#"{"ts":1700,"kf":{"type":"permission_requested","req_id":"r","tool":"Bash","input":{}}}"#,
            "\n",
            r#"{"ts":2000,"hook":{"hook_event_name":"PreToolUse","session_id":"b","cwd":"/o","tool_name":"Read","tool_use_id":"t","tool_input":{"file_path":"/o/x"}}}"#,
            "\n",
            "not json\n",
        );
        let ev = events(text);
        let ts: Vec<i64> = ev.iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![1000, 1500, 1700, 2000, 2000]);
        assert!(matches!(ev[2].body, EventBody::PermissionRequested { .. }));
        let s = summarize("x.ndjson".into(), 1, text);
        assert_eq!(s.cwd.as_deref(), Some("/r"));
        assert_eq!(s.first_prompt.as_deref(), Some("go"));
        assert_eq!(s.tool_calls, 1);
        assert_eq!((s.started, s.ended), (Some(1000), Some(2000)));
        assert!(!s.observed);
    }
}
