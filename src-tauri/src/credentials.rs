const SERVICE: &str = "dev.wterm.app";

fn entry(kind: &str, key: &str) -> Result<keyring::Entry, String> {
    if !matches!(kind, "password" | "passphrase") {
        return Err("不支持的凭据类型".to_string());
    }
    if key.is_empty() || key.len() > 2048 || key.chars().any(|c| c.is_control()) {
        return Err("无效的凭据键".to_string());
    }
    keyring::Entry::new(SERVICE, &format!("{kind}:{key}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn credential_get(kind: String, key: String) -> Result<Option<String>, String> {
    match entry(&kind, &key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn credential_set(kind: String, key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("不保存空凭据".to_string());
    }
    entry(&kind, &key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn credential_delete(kind: String, key: String) -> Result<(), String> {
    match entry(&kind, &key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
