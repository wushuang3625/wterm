//! User preferences shared by all windows. Secrets remain in the OS keychain.

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    version: u32,
    settings: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsLocationFile {
    version: u32,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLocation {
    pub path: String,
    pub default_path: String,
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("wterm")
}

fn default_path() -> PathBuf {
    config_dir().join("settings.json")
}
fn location_path() -> PathBuf {
    config_dir().join("settings-location.json")
}

fn validate_path(input: &str) -> Result<PathBuf, String> {
    if input.trim().is_empty() {
        return Ok(default_path());
    }
    let path = PathBuf::from(input.trim());
    if !path.is_absolute() {
        return Err("配置文件路径必须是绝对路径".into());
    }
    if !path
        .extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("json"))
    {
        return Err("配置文件必须是 .json 文件".into());
    }
    if path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("settings-location.json")
            || name.to_string_lossy().eq_ignore_ascii_case("profiles.json")
    }) {
        return Err("不能覆盖配置入口或 SSH Profile 文件".into());
    }
    Ok(path)
}

fn path() -> Result<PathBuf, String> {
    let location = match std::fs::read_to_string(location_path()) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(default_path()),
        Err(error) => return Err(format!("读取配置文件路径失败: {error}")),
    };
    let location: SettingsLocationFile = serde_json::from_str(&location)
        .map_err(|error| format!("配置文件路径格式错误: {error}"))?;
    if location.version != 1 {
        return Err(format!("不支持的配置路径版本: {}", location.version));
    }
    validate_path(&location.path)
}

fn validate(settings: &BTreeMap<String, String>) -> Result<(), String> {
    if settings.len() > 128 {
        return Err("设置项过多".into());
    }
    for (key, value) in settings {
        if !key.starts_with("wterm_")
            || key.len() > 80
            || key.contains("workspace")
            || key.contains("transfer")
            || key.contains("recent_connections")
            || value.len() > 131_072
        {
            return Err(format!("无效的设置项: {key}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_app_settings() -> Result<Option<BTreeMap<String, String>>, String> {
    let path = path()?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取设置失败: {error}")),
    };
    let file: SettingsFile =
        serde_json::from_str(&content).map_err(|error| format!("设置文件格式错误: {error}"))?;
    if file.version != 1 {
        return Err(format!("不支持的设置文件版本: {}", file.version));
    }
    validate(&file.settings)?;
    Ok(Some(file.settings))
}

#[tauri::command]
pub fn save_app_settings(settings: BTreeMap<String, String>) -> Result<(), String> {
    validate(&settings)?;
    write_settings(&path()?, settings)
}

fn write_settings(path: &PathBuf, settings: BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("无效设置目录")?)
        .map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(&SettingsFile {
        version: 1,
        settings,
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{content}\n")).map_err(|error| format!("保存设置失败: {error}"))
}

#[tauri::command]
pub fn get_app_settings_path() -> Result<SettingsLocation, String> {
    Ok(SettingsLocation {
        path: path()?.to_string_lossy().into_owned(),
        default_path: default_path().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn set_app_settings_path(
    new_path: String,
    settings: BTreeMap<String, String>,
) -> Result<SettingsLocation, String> {
    validate(&settings)?;
    let current = path()?;
    let target = validate_path(&new_path)?;
    let default = default_path();
    if target != current && target != default && target.exists() {
        return Err("目标配置文件已存在，请选择新文件名以免覆盖".into());
    }
    write_settings(&target, settings)?;
    let pointer = location_path();
    if target == default {
        if pointer.exists() {
            std::fs::remove_file(pointer).map_err(|error| format!("恢复默认路径失败: {error}"))?;
        }
    } else {
        std::fs::create_dir_all(config_dir()).map_err(|error| error.to_string())?;
        let content = serde_json::to_string_pretty(&SettingsLocationFile {
            version: 1,
            path: target.to_string_lossy().into_owned(),
        })
        .map_err(|error| error.to_string())?;
        std::fs::write(pointer, format!("{content}\n"))
            .map_err(|error| format!("保存配置文件路径失败: {error}"))?;
    }
    get_app_settings_path()
}

#[cfg(test)]
mod tests {
    use super::validate_path;

    #[test]
    fn custom_path_must_be_absolute_json_and_cannot_replace_other_config() {
        assert!(validate_path("relative/settings.json").is_err());
        assert!(validate_path("/tmp/settings.yaml").is_err());
        assert!(validate_path("/tmp/profiles.json").is_err());
        assert!(validate_path("/tmp/settings-location.json").is_err());
        let candidate = std::env::temp_dir().join("wterm-custom-settings.json");
        assert_eq!(
            validate_path(&candidate.to_string_lossy()).unwrap(),
            candidate
        );
    }
}
