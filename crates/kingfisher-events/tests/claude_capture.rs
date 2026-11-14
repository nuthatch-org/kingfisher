use kingfisher_events::{ClaudeNormalizer, EventBody, ToolKind};

fn normalize(fixture: &str) -> Vec<(Option<String>, EventBody)> {
    let mut n = ClaudeNormalizer::new();
    fixture
        .lines()
        .flat_map(|l| {
            let out = n.line(l);
            out.bodies.into_iter().map(move |b| (out.parent.clone(), b))
        })
        .collect()
}

#[test]
fn basic_turn_from_a_real_capture() {
    let events = normalize(include_str!("fixtures/basic_turn.ndjson"));
    let bodies: Vec<_> = events.iter().map(|(_, b)| b).collect();

    // SessionStart hooks run before `system/init` is emitted, so init is not the first line.
    let Some(EventBody::SessionStarted {
        model,
        api_key_source,
        capabilities,
        ..
    }) = bodies
        .iter()
        .copied()
        .find(|b| matches!(b, EventBody::SessionStarted { .. }))
    else {
        panic!("no SessionStarted");
    };
    assert_eq!(model, "claude-fable-5-2");
    assert_eq!(api_key_source.as_deref(), Some("none"));
    assert!(capabilities.iter().any(|c| c == "interrupt_receipt_v1"));

    assert!(bodies.iter().any(
        |b| matches!(b, EventBody::TurnStarted { text } if text.starts_with("Read README.md"))
    ));

    let calls: Vec<_> = bodies
        .iter()
        .filter_map(|b| match b {
            EventBody::ToolCall {
                tool, kind, paths, ..
            } => Some((tool.as_str(), *kind, paths.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            (
                "Read",
                ToolKind::Read,
                vec!["/Users/dev/Projects/kingfisher/README.md".to_string()]
            ),
            ("Bash", ToolKind::Shell, vec![]),
        ]
    );

    let results: Vec<_> = bodies
        .iter()
        .filter_map(|b| match b {
            EventBody::ToolResult {
                tool, ok, summary, ..
            } => Some((tool.clone(), *ok, summary.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[1],
        (Some("Bash".into()), true, "design-report.md".into())
    );

    let streamed: String = bodies
        .iter()
        .filter_map(|b| match b {
            EventBody::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let complete = bodies
        .iter()
        .find_map(|b| match b {
            EventBody::MessageComplete { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        streamed, complete,
        "deltas must reassemble into the final text"
    );

    let Some(EventBody::TurnEnded {
        ok,
        cost_usd,
        context_window,
        ..
    }) = bodies.last().copied()
    else {
        panic!("last event should be TurnEnded");
    };
    assert!(*ok);
    assert!(cost_usd.unwrap() > 0.0);
    assert_eq!(*context_window, Some(1_000_000));

    assert!(bodies.iter().any(|b| matches!(
        b,
        EventBody::RateLimit {
            utilization: Some(_),
            ..
        }
    )));
    assert!(events.iter().all(|(parent, _)| parent.is_none()));
}

#[test]
fn garbage_lines_become_notices_not_panics() {
    let mut n = ClaudeNormalizer::new();
    let out = n.line("not json at all");
    assert!(matches!(&out.bodies[..], [EventBody::Notice { .. }]));
}

#[test]
fn subagent_lines_carry_their_parent() {
    let mut n = ClaudeNormalizer::new();
    let out = n.line(r#"{"type":"stream_event","parent_tool_use_id":"toolu_X","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}"#);
    assert_eq!(out.parent.as_deref(), Some("toolu_X"));
    assert_eq!(
        out.bodies,
        vec![EventBody::ThinkingDelta {
            text: "hmm".into(),
            estimated_tokens: None
        }]
    );
}

#[test]
fn redacted_thinking_keeps_its_token_estimate() {
    let mut n = ClaudeNormalizer::new();
    let out = n.line(r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":174,"estimated_tokens_delta":124,"session_id":"s"}"#);
    assert_eq!(
        out.bodies,
        vec![EventBody::ThinkingDelta {
            text: String::new(),
            estimated_tokens: Some(174)
        }]
    );
}

#[test]
fn interrupt_marker_is_not_a_prompt() {
    let mut n = ClaudeNormalizer::new();
    let out = n.line(r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#);
    assert_eq!(
        out.bodies,
        vec![EventBody::Notice {
            text: "[Request interrupted by user]".into()
        }]
    );
}

#[test]
fn aborted_turn_has_no_cost_rather_than_zero() {
    let mut n = ClaudeNormalizer::new();
    let out = n.line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0,"terminal_reason":"aborted_streaming","modelUsage":{}}"#);
    let [
        EventBody::TurnEnded {
            ok,
            cost_usd,
            reason,
            ..
        },
    ] = &out.bodies[..]
    else {
        panic!()
    };
    assert!(!ok);
    assert_eq!(*cost_usd, None);
    assert_eq!(reason.as_deref(), Some("aborted_streaming"));
}

#[test]
fn a_session_transcript_reads_like_the_stream() {
    let mut n = ClaudeNormalizer::for_transcript();
    let lines = [
        r#"{"type":"api-request","sessionId":"s"}"#,
        r#"{"type":"user","sessionId":"s","cwd":"/repo","message":{"role":"user","content":"letsgoo"}}"#,
        r#"{"type":"assistant","sessionId":"s","cwd":"/repo","message":{"model":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
        r#"{"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a\nb"}]}}"#,
        r#"{"type":"user","sessionId":"s","message":{"content":"<task-notification>\n<task-id>x</task-id>"}}"#,
        r#"{"type":"system","subtype":"turn_duration","sessionId":"s","durationMs":1200}"#,
    ];
    let bodies: Vec<EventBody> = lines.iter().flat_map(|l| n.line(l).bodies).collect();
    let kinds: Vec<&str> = bodies
        .iter()
        .map(|b| match b {
            EventBody::SessionStarted { .. } => "start",
            EventBody::TurnStarted { .. } => "prompt",
            EventBody::ToolCall { .. } => "call",
            EventBody::ToolResult { .. } => "result",
            EventBody::Notice { .. } => "notice",
            EventBody::TurnEnded { .. } => "end",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        ["start", "prompt", "call", "result", "notice", "end"]
    );
    assert!(
        matches!(&bodies[3], EventBody::ToolResult { tool: Some(t), ok: true, .. } if t == "Bash")
    );
}
