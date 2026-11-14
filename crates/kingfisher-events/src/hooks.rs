//! Claude Code's HTTP hook payloads, from sessions kingfisher did not start itself. Coarser than
//! stream-json: no token deltas and no intermediate text, but `Stop` carries the final reply.

use std::collections::HashSet;

use serde_json::Value;

use crate::{EventBody, Normalized, SUMMARY_CHARS, ToolKind, paths, str_at, truncate};

#[derive(Debug, Default)]
pub struct HookNormalizer {
    seen: HashSet<String>,
}

impl HookNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn payload(&mut self, v: &Value) -> Normalized {
        let session = str_at(v, "session_id");
        let mut bodies = vec![];
        if let Some(id) = &session
            && self.seen.insert(id.clone())
        {
            bodies.push(EventBody::SessionStarted {
                model: str_at(v, "model").unwrap_or_else(|| "observed session".into()),
                cwd: str_at(v, "cwd").unwrap_or_default(),
                tools: vec![],
                mcp: vec![],
                capabilities: vec![],
                permission_mode: str_at(v, "permission_mode"),
                api_key_source: None,
                version: None,
            });
        }

        match v["hook_event_name"].as_str().unwrap_or("") {
            "UserPromptSubmit" => bodies.push(EventBody::TurnStarted {
                text: str_at(v, "prompt").unwrap_or_default(),
            }),
            "PreToolUse" => {
                let tool = str_at(v, "tool_name").unwrap_or_default();
                let input = v["tool_input"].clone();
                bodies.push(EventBody::ToolCall {
                    call_id: str_at(v, "tool_use_id").unwrap_or_default(),
                    kind: ToolKind::classify(&tool),
                    paths: paths(&input),
                    tool,
                    input,
                });
            }
            "PostToolUse" => bodies.push(EventBody::ToolResult {
                call_id: str_at(v, "tool_use_id").unwrap_or_default(),
                tool: str_at(v, "tool_name"),
                ok: true,
                summary: truncate(&summarize(&v["tool_response"]), SUMMARY_CHARS),
            }),
            "PostToolUseFailure" => bodies.push(EventBody::ToolResult {
                call_id: str_at(v, "tool_use_id").unwrap_or_default(),
                tool: str_at(v, "tool_name"),
                ok: false,
                summary: truncate(&str_at(v, "error").unwrap_or_default(), SUMMARY_CHARS),
            }),
            "Stop" => {
                if let Some(text) = str_at(v, "last_assistant_message") {
                    bodies.push(EventBody::MessageComplete { text });
                }
                bodies.push(EventBody::TurnEnded {
                    ok: true,
                    reason: Some("stop".into()),
                    cost_usd: None,
                    duration_ms: None,
                    context_window: None,
                });
            }
            "PreCompact" => bodies.push(EventBody::Compaction {
                trigger: str_at(v, "trigger"),
            }),
            "Notification" => {
                if let Some(text) = str_at(v, "message") {
                    bodies.push(EventBody::Notice { text });
                }
            }
            "SessionEnd" => bodies.push(EventBody::SessionEnded {
                reason: str_at(v, "reason"),
            }),
            "SessionStart" | "SubagentStart" | "SubagentStop" | "PermissionRequest" => {}
            other => bodies.push(EventBody::Unknown {
                raw_type: format!("hook/{other}"),
            }),
        }
        Normalized {
            session,
            parent: None,
            bodies,
        }
    }
}

fn summarize(r: &Value) -> String {
    match r {
        Value::String(s) => s.clone(),
        Value::Object(o) => {
            if let Some(out) = o.get("stdout").and_then(Value::as_str) {
                let err = o.get("stderr").and_then(Value::as_str).unwrap_or("");
                return if err.is_empty() {
                    out.into()
                } else {
                    format!("{out}\n{err}")
                };
            }
            if let Some(c) = r["file"]["content"].as_str() {
                return c.into();
            }
            // Edit and Write echo the whole file and patch back; the diff is already on the call.
            if let Some(path) = o.get("filePath").and_then(Value::as_str) {
                return format!("updated {path}");
            }
            r.to_string()
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
