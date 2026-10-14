//! SSH 连接配置的持久化（JSON 文件，存于系统配置目录）

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
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

static PROFILE_LOCK: Mutex<()> = Mutex::new(());

fn lock_profiles(path: &std::path::Path) -> anyhow::Result<std::fs::File> {
    // All application processes must agree on the IDs assigned to legacy files.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("json.lock"))?;
    file.lock()?;
    Ok(file)
}

fn read_with_ids(path: &std::path::Path) -> anyhow::Result<(Vec<SshProfile>, bool)> {
    if !path.exists() {
        return Ok((Vec::new(), false));
    }
    let mut list: Vec<SshProfile> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let mut changed = false;
    let mut ids = std::collections::HashSet::new();
    for profile in &mut list {
        let valid = profile
            .id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && ids.insert(id.clone()));
        if !valid {
            let id = uuid::Uuid::new_v4().to_string();
            ids.insert(id.clone());
            profile.id = Some(id);
            changed = true;
        }
    }
    Ok((list, changed))
}

fn write_profiles(path: &std::path::Path, list: &[SshProfile]) -> anyhow::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_string_pretty(list)?)?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

pub fn load_with_ids() -> anyhow::Result<Vec<SshProfile>> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let path = config_path();
    let _file_lock = lock_profiles(&path)?;
    let (list, changed) = read_with_ids(&path)?;
    if changed {
        write_profiles(&path, &list)?;
    }
    Ok(list)
}

pub fn save(mut profile: SshProfile) -> anyhow::Result<()> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let path = config_path();
    let _file_lock = lock_profiles(&path)?;
    let (mut list, _) = read_with_ids(&path)?;
    if profile
        .id
        .as_ref()
        .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        profile.id = list
            .iter()
            .find(|item| item.name == profile.name)
            .and_then(|item| item.id.clone())
            .or_else(|| Some(uuid::Uuid::new_v4().to_string()));
    }
    list.retain(|p| p.name != profile.name && p.id != profile.id);
    list.push(profile);
    write_profiles(&path, &list)
}

pub fn remove(name: &str) -> anyhow::Result<()> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let path = config_path();
    let _file_lock = lock_profiles(&path)?;
    let (mut list, _) = read_with_ids(&path)?;
    list.retain(|p| p.name != name);
    write_profiles(&path, &list)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_ids_are_persisted_and_survive_renaming() {
        let path =
            std::env::temp_dir().join(format!("wterm-profiles-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r#"[{"name":"旧名称","host":"host","port":22,"username":"root","auth":"agent"}]"#,
        )
        .unwrap();
        let (mut profiles, changed) = read_with_ids(&path).unwrap();
        assert!(changed);
        let id = profiles[0].id.clone();
        write_profiles(&path, &profiles).unwrap();
        let (restored, changed) = read_with_ids(&path).unwrap();
        assert!(!changed);
        assert_eq!(restored[0].id, id);
        profiles[0].name = "新名称".into();
        write_profiles(&path, &profiles).unwrap();
        assert_eq!(read_with_ids(&path).unwrap().0[0].id, id);
        std::fs::write(&path, "invalid JSON").unwrap();
        assert!(read_with_ids(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid JSON");
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn independent_handles_serialize_profile_migration() {
        let path =
            std::env::temp_dir().join(format!("wterm-profile-lock-{}.json", uuid::Uuid::new_v4()));
        let first = lock_profiles(&path).unwrap();
        let second = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.with_extension("json.lock"))
            .unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        let _ = std::fs::remove_file(path.with_extension("json.lock"));
    }
}
