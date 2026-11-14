use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use kingfisher_events::ClaudeNormalizer;
use serde_json::Value;

use crate::hub::Hub;

/// Accepts both kingfisher archives (`{"ts", "raw"}` per line, replayed at recorded pace)
/// and bare `claude -p ... | tee` captures, which carry no timing and get a fixed one.
pub async fn run(path: PathBuf, speed: f64, hub: Arc<Hub>) -> Result<()> {
    let text = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("reading {}", path.display()))?;
    let speed = speed.max(0.01);
    let mut normalizer = ClaudeNormalizer::new();
    let mut last_ts: Option<i64> = None;

    hub.notice(format!("replaying {}", path.display()));
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let parsed: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (raw, ts) = match (parsed.get("raw"), parsed["ts"].as_i64()) {
            (Some(raw), Some(ts)) => (raw.clone(), Some(ts)),
            _ => (parsed, None),
        };
        let gap_ms = match (ts, last_ts) {
            (Some(t), Some(prev)) => (t - prev).clamp(0, 4000) as f64,
            (Some(_), None) => 0.0,
            _ if raw["type"] == "stream_event" => 30.0,
            _ => 350.0,
        };
        last_ts = ts.or(last_ts);
        if gap_ms > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(gap_ms / speed / 1000.0)).await;
        }
        let out = normalizer.value(&raw);
        for body in out.bodies {
            hub.publish(out.session.clone(), out.parent.clone(), body);
        }
    }
    hub.notice("replay finished");
    Ok(())
}
