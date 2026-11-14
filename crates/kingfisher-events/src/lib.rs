//! The agent-agnostic event schema, and the normaliser that turns Claude Code's
//! `--output-format stream-json` lines into it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: u16 = 1;

const SUMMARY_CHARS: usize = 600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentEvent {
    pub v: u16,
    pub seq: u64,
    /// Milliseconds since the Unix epoch, stamped by whoever observed the line.
    pub ts: i64,
    pub session: Option<String>,
    /// The `tool_use` id of the Task/Agent call this came from; `None` for the main agent.
    pub parent: Option<String>,
    pub body: EventBody,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Write,
    Edit,
    Search,
    Shell,
    Web,
    Agent,
    Mcp,
    Other,
}

impl ToolKind {
    pub fn classify(tool: &str) -> Self {
        match tool {
            "Read" | "NotebookRead" => Self::Read,
            "Write" => Self::Write,
            "Edit" | "MultiEdit" | "NotebookEdit" => Self::Edit,
            "Grep" | "Glob" | "LS" | "LSP" => Self::Search,
            "Bash" | "BashOutput" | "PowerShell" | "KillShell" | "Monitor" => Self::Shell,
            "WebFetch" | "WebSearch" => Self::Web,
            "Task" | "Agent" => Self::Agent,
            t if t.starts_with("mcp__") => Self::Mcp,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventBody {
    SessionStarted {
        model: String,
        cwd: String,
        tools: Vec<String>,
        mcp: Vec<McpServer>,
        capabilities: Vec<String>,
        permission_mode: Option<String>,
        /// `"none"` means the subscription login is in use rather than an API key.
        api_key_source: Option<String>,
        version: Option<String>,
    },
    TurnStarted {
        text: String,
    },
    TextDelta {
        text: String,
    },
    /// Thinking text may arrive redacted, leaving only the running token estimate.
    ThinkingDelta {
        text: String,
        estimated_tokens: Option<u64>,
    },
    MessageComplete {
        text: String,
    },
    ToolCall {
        call_id: String,
        tool: String,
        kind: ToolKind,
        input: Value,
        paths: Vec<String>,
    },
    ToolResult {
        call_id: String,
        tool: Option<String>,
        ok: bool,
        summary: String,
    },
    Usage {
        context_tokens: u64,
        output_tokens: u64,
    },
    RateLimit {
        status: String,
        window: Option<String>,
        utilization: Option<f64>,
        resets_at: Option<i64>,
    },
    Status {
        status: String,
    },
    Hook {
        event: String,
        phase: String,
    },
    Retry {
        attempt: Option<u64>,
        delay_ms: Option<u64>,
        error: Option<String>,
    },
    Compaction {
        trigger: Option<String>,
    },
    TurnEnded {
        ok: bool,
        reason: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        context_window: Option<u64>,
    },
    PermissionRequested {
        req_id: String,
        tool: String,
        input: Value,
    },
    PermissionResolved {
        req_id: String,
        allow: bool,
    },
    AgentExited {
        code: Option<i32>,
    },
    Notice {
        text: String,
    },
    Unknown {
        raw_type: String,
    },
}

/// What a single parsed line contributed: the session and parent it belongs to, plus bodies.
#[derive(Debug, Default)]
pub struct Normalized {
    pub session: Option<String>,
    pub parent: Option<String>,
    pub bodies: Vec<EventBody>,
}

/// Stateful, because a `tool_result` names only the call id and the tool name lives on the call.
#[derive(Debug, Default)]
pub struct ClaudeNormalizer {
    tools_by_call: HashMap<String, String>,
}

impl ClaudeNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn line(&mut self, line: &str) -> Normalized {
        match serde_json::from_str::<Value>(line) {
            Ok(v) => self.value(&v),
            Err(_) => Normalized {
                bodies: vec![EventBody::Notice {
                    text: truncate(line.trim(), SUMMARY_CHARS),
                }],
                ..Default::default()
            },
        }
    }

    pub fn value(&mut self, v: &Value) -> Normalized {
        let session = str_at(v, "session_id");
        let parent = str_at(v, "parent_tool_use_id");
        let bodies = match v["type"].as_str().unwrap_or("") {
            "system" => self.system(v),
            "stream_event" => stream_event(&v["event"]),
            "assistant" => self.assistant(v),
            "user" => self.user(v),
            "result" => vec![result(v)],
            "rate_limit_event" => vec![rate_limit(&v["rate_limit_info"])],
            other => vec![EventBody::Unknown {
                raw_type: other.to_string(),
            }],
        };
        Normalized {
            session,
            parent,
            bodies,
        }
    }

    fn system(&mut self, v: &Value) -> Vec<EventBody> {
        let subtype = v["subtype"].as_str().unwrap_or("");
        let body = match subtype {
            "init" => EventBody::SessionStarted {
                model: str_at(v, "model").unwrap_or_default(),
                cwd: str_at(v, "cwd").unwrap_or_default(),
                tools: strings(&v["tools"]),
                mcp: v["mcp_servers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|s| McpServer {
                        name: str_at(s, "name").unwrap_or_default(),
                        status: str_at(s, "status").unwrap_or_default(),
                    })
                    .collect(),
                capabilities: strings(&v["capabilities"]),
                permission_mode: str_at(v, "permissionMode"),
                api_key_source: str_at(v, "apiKeySource"),
                version: str_at(v, "claude_code_version"),
            },
            "status" => match str_at(v, "status") {
                Some(status) => EventBody::Status { status },
                None => return vec![],
            },
            "hook_started" | "hook_response" => EventBody::Hook {
                event: str_at(v, "hook_event").unwrap_or_default(),
                phase: if subtype == "hook_started" {
                    "started".into()
                } else {
                    str_at(v, "outcome").unwrap_or_else(|| "done".into())
                },
            },
            "api_retry" => EventBody::Retry {
                attempt: v["attempt"].as_u64(),
                delay_ms: v["retry_delay_ms"].as_u64().or(v["delay_ms"].as_u64()),
                error: str_at(v, "error").or_else(|| v.get("error").map(|e| e.to_string())),
            },
            "thinking_tokens" => EventBody::ThinkingDelta {
                text: String::new(),
                estimated_tokens: v["estimated_tokens"].as_u64(),
            },
            "compact_boundary" => EventBody::Compaction {
                trigger: str_at(&v["compact_metadata"], "trigger"),
            },
            other => EventBody::Unknown {
                raw_type: format!("system/{other}"),
            },
        };
        vec![body]
    }

    fn assistant(&mut self, v: &Value) -> Vec<EventBody> {
        let mut out = vec![];
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => out.push(EventBody::MessageComplete {
                    text: str_at(block, "text").unwrap_or_default(),
                }),
                Some("tool_use") => {
                    let call_id = str_at(block, "id").unwrap_or_default();
                    let tool = str_at(block, "name").unwrap_or_default();
                    self.tools_by_call.insert(call_id.clone(), tool.clone());
                    let input = block["input"].clone();
                    out.push(EventBody::ToolCall {
                        kind: ToolKind::classify(&tool),
                        paths: paths(&input),
                        call_id,
                        tool,
                        input,
                    });
                }
                _ => {}
            }
        }
        out
    }

    fn user(&mut self, v: &Value) -> Vec<EventBody> {
        let content = &v["message"]["content"];
        if let Some(text) = content.as_str() {
            return vec![EventBody::TurnStarted { text: text.into() }];
        }
        let mut out = vec![];
        let mut text = String::new();
        for block in content.as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
                Some("tool_result") => {
                    let call_id = str_at(block, "tool_use_id").unwrap_or_default();
                    out.push(EventBody::ToolResult {
                        tool: self.tools_by_call.remove(&call_id),
                        ok: !block["is_error"].as_bool().unwrap_or(false),
                        summary: truncate(&result_text(&block["content"]), SUMMARY_CHARS),
                        call_id,
                    });
                }
                _ => {}
            }
        }
        // Prompts echo back with isReplay; text without it is the CLI's own marker,
        // such as "[Request interrupted by user]".
        if !text.is_empty() {
            let body = if v["isReplay"].as_bool() == Some(true) {
                EventBody::TurnStarted { text }
            } else {
                EventBody::Notice { text }
            };
            out.insert(0, body);
        }
        out
    }
}

fn stream_event(e: &Value) -> Vec<EventBody> {
    match e["type"].as_str() {
        Some("content_block_delta") => {
            let d = &e["delta"];
            match d["type"].as_str() {
                Some("text_delta") => vec![EventBody::TextDelta {
                    text: str_at(d, "text").unwrap_or_default(),
                }],
                Some("thinking_delta") => vec![EventBody::ThinkingDelta {
                    text: str_at(d, "thinking").unwrap_or_default(),
                    estimated_tokens: d["estimated_tokens"].as_u64(),
                }],
                _ => vec![],
            }
        }
        Some("message_start") => {
            let u = &e["message"]["usage"];
            let n = |k: &str| u[k].as_u64().unwrap_or(0);
            vec![EventBody::Usage {
                context_tokens: n("input_tokens")
                    + n("cache_read_input_tokens")
                    + n("cache_creation_input_tokens"),
                output_tokens: n("output_tokens"),
            }]
        }
        _ => vec![],
    }
}

fn result(v: &Value) -> EventBody {
    let model_usage = v["modelUsage"].as_object();
    let context_window =
        model_usage.and_then(|m| m.values().filter_map(|u| u["contextWindow"].as_u64()).max());
    // An aborted turn reports 0 with no usage at all, which is "not counted", not "free".
    let counted = model_usage.is_some_and(|m| !m.is_empty());
    EventBody::TurnEnded {
        ok: !v["is_error"].as_bool().unwrap_or(false)
            && v["subtype"].as_str().is_none_or(|s| s == "success"),
        reason: str_at(v, "terminal_reason")
            .or_else(|| str_at(v, "stop_reason"))
            .or_else(|| str_at(v, "subtype")),
        cost_usd: v["total_cost_usd"].as_f64().filter(|_| counted),
        duration_ms: v["duration_ms"].as_u64(),
        context_window,
    }
}

fn rate_limit(info: &Value) -> EventBody {
    let window = str_at(info, "rateLimitType");
    let utilization = window
        .as_deref()
        .and_then(|w| info["unifiedWindows"][w]["utilization"].as_f64());
    EventBody::RateLimit {
        status: str_at(info, "status").unwrap_or_default(),
        resets_at: info["resetsAt"].as_i64(),
        window,
        utilization,
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn paths(input: &Value) -> Vec<String> {
    ["file_path", "notebook_path", "path"]
        .iter()
        .filter_map(|k| str_at(input, k))
        .collect()
}

fn str_at(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect()
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("ééé", 2), "éé…");
        assert_eq!(truncate("ab", 5), "ab");
    }

    #[test]
    fn classify_mcp_tools() {
        assert_eq!(
            ToolKind::classify("mcp__github__create_issue"),
            ToolKind::Mcp
        );
        assert_eq!(ToolKind::classify("Somethingelse"), ToolKind::Other);
    }
}
