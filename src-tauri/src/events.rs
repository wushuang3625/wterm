//! Event and channel adapters for terminal sessions and Tauri IPC.
use serde::Serialize;
use std::sync::Arc;

type EventCallback = dyn Fn(&str, serde_json::Value) -> Result<(), String> + Send + Sync;
#[derive(Clone)]
pub struct EventSink(Arc<EventCallback>);
impl EventSink {
    pub fn new(
        callback: impl Fn(&str, serde_json::Value) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(callback))
    }
    pub fn emit(&self, name: &str, payload: impl Serialize) -> Result<(), String> {
        (self.0)(
            name,
            serde_json::to_value(payload).map_err(|e| e.to_string())?,
        )
    }
}

type ChannelCallback<T> = dyn Fn(T) -> Result<(), String> + Send + Sync;
pub struct Channel<T>(Arc<ChannelCallback<T>>);
impl<T> Clone for Channel<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<T> Channel<T> {
    pub fn new(callback: impl Fn(T) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(callback))
    }
    pub fn send(&self, payload: T) -> Result<(), String> {
        (self.0)(payload)
    }
}

impl From<tauri::AppHandle> for EventSink {
    fn from(app: tauri::AppHandle) -> Self {
        use tauri::Emitter;
        Self::new(move |name, payload| app.emit(name, payload).map_err(|e| e.to_string()))
    }
}

impl<T: Serialize + Send + Sync + 'static> From<tauri::ipc::Channel<T>> for Channel<T> {
    fn from(channel: tauri::ipc::Channel<T>) -> Self {
        Self::new(move |payload| channel.send(payload).map_err(|e| e.to_string()))
    }
}
