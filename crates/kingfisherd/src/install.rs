//! Adds or removes kingfisher's entries in the user's global Claude Code settings, so sessions
//! started anywhere report to the daemon. Touches only entries pointing at 127.0.0.1/hook/*.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

const OBSERVED: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "PreCompact",
    "Notification",
    "SessionEnd",
];
const TOOL_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
];

pub fn settings_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".claude/settings.json"))
}

pub fn permission_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/hook/permission")
}

/// True if the global settings already send PermissionRequest to this daemon.
pub fn has_global_permission_hook(port: u16) -> bool {
    settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|s| s.contains(&permission_url(port)))
}

fn is_ours(hook: &Value) -> bool {
    hook["url"].as_str().is_some_and(|u| {
        u.starts_with("http://127.0.0.1:")
            && (u.contains("/hook/event") || u.contains("/hook/permission"))
    })
}

/// Removes our hook entries, then any matcher group or event they leave empty.
pub fn strip(settings: &mut Value) -> usize {
    let mut removed = 0;
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    for groups in hooks.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        for group in groups.iter_mut() {
            if let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = list.len();
                list.retain(|h| !is_ours(h));
                removed += before - list.len();
            }
        }
        groups.retain(|g| g["hooks"].as_array().is_none_or(|l| !l.is_empty()));
    }
    hooks.retain(|_, g| g.as_array().is_none_or(|a| !a.is_empty()));
    if hooks.is_empty() {
        settings.as_object_mut().unwrap().remove("hooks");
    }
    removed
}

pub fn add(settings: &mut Value, port: u16, token: &str) {
    if !settings.is_object() {
        *settings = json!({});
    }
    let root = settings.as_object_mut().unwrap();
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("hooks is an object");
    let entry = |url: String, timeout: u64| {
        json!({
            "type": "http",
            "url": url,
            "timeout": timeout,
            "headers": {"Authorization": format!("Bearer {token}")},
        })
    };
    let mut push = |event: &str, hook: Value| {
        let mut group = json!({"hooks": [hook]});
        if TOOL_EVENTS.contains(&event) {
            group["matcher"] = json!("*");
        }
        hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("event hooks are a list")
            .push(group);
    };
    for event in OBSERVED {
        push(
            event,
            entry(format!("http://127.0.0.1:{port}/hook/event"), 5),
        );
    }
    push("PermissionRequest", entry(permission_url(port), 600));

    // If the user restricts hook URLs, ours must be on the list or nothing above fires.
    if let Some(list) = root
        .get_mut("allowedHttpHookUrls")
        .and_then(Value::as_array_mut)
    {
        let pattern = json!(format!("http://127.0.0.1:{port}/*"));
        if !list.contains(&pattern) {
            list.push(pattern);
        }
    }
}

pub fn run(install: bool, port: u16, token: &str, yes: bool) -> Result<()> {
    let path = settings_path()?;
    let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    let text = std::fs::read_to_string(&real).unwrap_or_else(|_| "{}".into());
    let mut settings: Value = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON", real.display()))?;

    let removed = strip(&mut settings);
    if install {
        add(&mut settings, port, token);
    }
    let action = if install {
        format!(
            "add HTTP hooks for {} events pointing at 127.0.0.1:{port}, with a bearer token,{}",
            OBSERVED.len() + 1,
            if removed > 0 {
                format!(" replacing {removed} existing kingfisher entries")
            } else {
                String::new()
            }
        )
    } else if removed == 0 {
        println!("No kingfisher hooks in {}.", real.display());
        return Ok(());
    } else {
        format!("remove {removed} kingfisher hook entries")
    };

    println!("This will {action} in {}.", real.display());
    if install {
        println!(
            "Sessions you start anywhere will then report to kingfisherd while it runs, and permission \
             prompts will also appear in the browser. With the daemon stopped, Claude Code carries on as normal."
        );
    }
    if !yes {
        print!("Proceed? [y/N] ");
        std::io::stdout().flush()?;
        let mut answer = String::new();
        std::io::stdin().lock().read_line(&mut answer)?;
        if !matches!(answer.trim(), "y" | "Y" | "yes") {
            bail!("left unchanged");
        }
    }

    if real.exists() {
        let backup = real.with_extension(format!("json.kingfisher-{}", crate::hub::now_ms()));
        std::fs::copy(&real, &backup)
            .with_context(|| format!("backing up to {}", backup.display()))?;
        println!("Backed up the old file to {}.", backup.display());
    }
    std::fs::write(&real, serde_json::to_string_pretty(&settings)? + "\n")
        .with_context(|| format!("writing {}", real.display()))?;
    println!("Done.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_then_strip_leaves_the_user_settings_alone() {
        let original = json!({
            "model": "opus",
            "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "lint.sh"}]}]},
        });
        let mut s = original.clone();
        add(&mut s, 7777, "tok");
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(
            s["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"],
            600
        );
        assert_eq!(s["hooks"]["Stop"][0].get("matcher"), None);

        // Installing twice must not stack duplicates.
        strip(&mut s);
        add(&mut s, 7777, "tok");
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);

        assert_eq!(strip(&mut s), OBSERVED.len() + 1);
        assert_eq!(s, original);
    }

    #[test]
    fn allow_list_gets_our_url_only_if_the_user_has_one() {
        let mut s = json!({"allowedHttpHookUrls": ["https://example.com/*"]});
        add(&mut s, 7777, "t");
        assert_eq!(s["allowedHttpHookUrls"][1], "http://127.0.0.1:7777/*");
        let mut s = json!({});
        add(&mut s, 7777, "t");
        assert!(s.get("allowedHttpHookUrls").is_none());
    }
}
