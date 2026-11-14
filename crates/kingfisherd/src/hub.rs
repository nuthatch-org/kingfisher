use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use kingfisher_events::{AgentEvent, EventBody, SCHEMA_VERSION};
use tokio::sync::{broadcast, oneshot};

pub type Frame = Arc<str>;

/// Holds every event of this daemon's life, so a browser that connects late, or reloads,
/// is sent the whole session before going live.
pub struct Hub {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Frame>,
    permissions: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    sessions: Mutex<HashMap<String, SessionInfo>>,
    /// Directories of archived sessions, so a replay can draw its own repository.
    archived_cwds: Mutex<HashSet<PathBuf>>,
}

#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub cwd: PathBuf,
    /// Started by this daemon, so its stream-json already covers what its hooks would report.
    pub owned: bool,
}

struct Inner {
    seq: u64,
    log: Vec<Frame>,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(4096);
        Arc::new(Self {
            inner: Mutex::new(Inner {
                seq: 0,
                log: vec![],
            }),
            tx,
            permissions: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            archived_cwds: Mutex::new(HashSet::new()),
        })
    }

    pub fn publish(&self, session: Option<String>, parent: Option<String>, body: EventBody) {
        let mut inner = self.inner.lock().unwrap();
        inner.seq += 1;
        let event = AgentEvent {
            v: SCHEMA_VERSION,
            seq: inner.seq,
            ts: now_ms(),
            session,
            parent,
            body,
        };
        let frame: Frame = serde_json::to_string(&event)
            .expect("events serialise")
            .into();
        inner.log.push(frame.clone());
        // No receivers is the normal state before a browser connects.
        let _ = self.tx.send(frame);
    }

    pub fn notice(&self, text: impl Into<String>) {
        self.publish(None, None, EventBody::Notice { text: text.into() });
    }

    /// Taken under the log lock, so no event can fall between the snapshot and the subscription.
    pub fn snapshot_and_subscribe(&self) -> (Vec<Frame>, broadcast::Receiver<Frame>) {
        let inner = self.inner.lock().unwrap();
        (inner.log.clone(), self.tx.subscribe())
    }

    pub fn park_permission(&self, req_id: String) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.permissions.lock().unwrap().insert(req_id, tx);
        rx
    }

    /// Returns false if the request was already answered or has timed out.
    pub fn resolve_permission(&self, req_id: &str, allow: bool) -> bool {
        match self.permissions.lock().unwrap().remove(req_id) {
            Some(tx) => tx.send(allow).is_ok(),
            None => false,
        }
    }

    /// Returns true if it was still waiting.
    pub fn forget_permission(&self, req_id: &str) -> bool {
        self.permissions.lock().unwrap().remove(req_id).is_some()
    }

    pub fn pending_permissions(&self) -> usize {
        self.permissions.lock().unwrap().len()
    }

    pub fn note_session(&self, id: &str, cwd: PathBuf, owned: bool) {
        let mut sessions = self.sessions.lock().unwrap();
        let entry = sessions
            .entry(id.to_owned())
            .or_insert(SessionInfo { cwd, owned });
        entry.owned |= owned;
    }

    pub fn session(&self, id: &str) -> Option<SessionInfo> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn is_known_cwd(&self, cwd: &std::path::Path) -> bool {
        self.sessions.lock().unwrap().values().any(|s| s.cwd == cwd)
            || self.archived_cwds.lock().unwrap().contains(cwd)
    }

    pub fn allow_archived_cwd(&self, cwd: PathBuf) {
        self.archived_cwds.lock().unwrap().insert(cwd);
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
