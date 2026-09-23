//! 全局应用状态

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::session::SessionKind;
use crate::sftp::SftpManager;

pub struct AppState {
    pub sessions: Mutex<HashMap<String, SessionKind>>,
    pub sftp: SftpManager,
    pub transfers: crate::transfers::Transfers,
    pub auth_pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>,
    pub host_key_pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sftp: SftpManager::new(),
            transfers: crate::transfers::Transfers::default(),
            auth_pending: Mutex::new(HashMap::new()),
            host_key_pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
