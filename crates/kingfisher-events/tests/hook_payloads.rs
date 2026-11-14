use kingfisher_events::{EventBody, HookNormalizer, ToolKind};
use serde_json::json;

#[test]
fn observed_session_from_real_payload_shapes() {
    let mut n = HookNormalizer::new();
    let base = json!({"session_id": "s1", "cwd": "/repo", "permission_mode": "default"});
    let with = |extra: serde_json::Value| {
        let mut v = base.clone();
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };

    let first = n.payload(&with(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "hi"}),
    ));
    assert_eq!(first.session.as_deref(), Some("s1"));
    assert!(
        matches!(&first.bodies[..], [EventBody::SessionStarted { cwd, .. }, EventBody::TurnStarted { text }] if cwd == "/repo" && text == "hi")
    );

    let call = n.payload(&with(json!({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_use_id": "t1", "tool_input": {"file_path": "/repo/a.rs"}})));
    assert_eq!(
        call.bodies,
        vec![EventBody::ToolCall {
            call_id: "t1".into(),
            tool: "Read".into(),
            kind: ToolKind::Read,
            input: json!({"file_path": "/repo/a.rs"}),
            paths: vec!["/repo/a.rs".into()]
        }]
    );

    let fail = n.payload(&with(json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_use_id": "t2", "error": "Exit code 1"})));
    assert!(
        matches!(&fail.bodies[..], [EventBody::ToolResult { ok: false, summary, .. }] if summary == "Exit code 1")
    );

    let ok = n.payload(&with(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "t3", "tool_response": {"stdout": "out", "stderr": ""}})));
    assert!(
        matches!(&ok.bodies[..], [EventBody::ToolResult { ok: true, summary, .. }] if summary == "out")
    );

    let stop = n.payload(&with(
        json!({"hook_event_name": "Stop", "last_assistant_message": "done"}),
    ));
    assert!(
        matches!(&stop.bodies[..], [EventBody::MessageComplete { text }, EventBody::TurnEnded { .. }] if text == "done")
    );
}

#[test]
fn edit_results_say_what_changed_not_the_whole_file() {
    let mut n = HookNormalizer::new();
    let out = n.payload(&json!({"session_id": "s", "hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_use_id": "t",
        "tool_response": {"filePath": "/r/a.rs", "oldString": "x", "originalFile": "huge", "structuredPatch": []}}));
    assert!(
        matches!(&out.bodies[1], EventBody::ToolResult { summary, .. } if summary == "updated /r/a.rs")
    );
}
