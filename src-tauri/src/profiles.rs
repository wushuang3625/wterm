//! SSH 连接配置的持久化（JSON 文件，存于系统配置目录）

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "agent" | "password" | "key"
    pub auth: String,
    /// 私钥路径（auth = "key" 时使用），旧配置缺省为 None
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub login_script: Option<String>,
    #[serde(default)]
    pub keepalive_secs: Option<u64>,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub reconnect_attempts: Option<u32>,
    #[serde(default)]
    pub reconnect_delay_secs: Option<u64>,
    #[serde(default)]
    pub proxy_jump: Option<String>,
}

fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("wterm");
    std::fs::create_dir_all(&dir).ok();
    dir.join("profiles.json")
}

pub fn load() -> Vec<SshProfile> {
    let path = config_path();
    if !path.exists() {
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(profile: SshProfile) -> anyhow::Result<()> {
    let mut list = load();
    // 同名覆盖
    list.retain(|p| p.name != profile.name);
    list.push(profile);
    let path = config_path();
    std::fs::write(&path, serde_json::to_string_pretty(&list)?)?;
    Ok(())
}

pub fn remove(name: &str) -> anyhow::Result<()> {
    let mut list = load();
    list.retain(|p| p.name != name);
    let path = config_path();
    std::fs::write(&path, serde_json::to_string_pretty(&list)?)?;
    Ok(())
}
