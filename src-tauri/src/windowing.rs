use std::path::PathBuf;
use tauri::Manager;

use crate::session::SessionKind;
use crate::state::AppState;

fn launch_target(target: &str) -> Result<(), String> {
    if target.is_empty() || target.len() > 8192 || target.chars().any(|c| c.is_control()) {
        return Err("无效的打开目标".to_string());
    }

    let clean = target.strip_prefix(r"\\?\").unwrap_or(target);

    #[cfg(target_os = "windows")]
    let mut command = {
        let path = std::path::Path::new(clean);
        if path.is_dir() {
            let mut cmd = std::process::Command::new("explorer.exe");
            cmd.arg(clean);
            cmd
        } else {
            let mut cmd = std::process::Command::new("rundll32.exe");
            cmd.arg("url.dll,FileProtocolHandler").arg(clean);
            cmd
        }
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(clean);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(clean);
        cmd
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    return Err("当前系统不支持打开外部目标".to_string());

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
pub fn open_external_target(target: String) -> Result<(), String> {
    let lower = target.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("只允许打开 http/https 地址".to_string());
    }
    launch_target(&target)
}

#[tauri::command]
pub fn open_local_terminal_path(
    state: tauri::State<'_, AppState>,
    sid: String,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if !matches!(sessions.get(&sid), Some(SessionKind::Local { .. })) {
            return Err("只能从本地终端打开本地文件路径".to_string());
        }
    }
    if path.is_empty() || path.len() > 4096 || path.chars().any(|c| c.is_control()) {
        return Err("无效的本地路径".to_string());
    }
    let raw = path.trim_matches(|c| matches!(c, '"' | '\'' | ',' | ';' | ':' | ')' | ']' | '}' | '>' | '<' | '`'));

    // Strip :line:col or :line if present (e.g. index.html:10:5)
    let stripped_line = if let Some(idx) = raw.rfind(':') {
        let suffix = &raw[idx + 1..];
        if suffix.chars().all(|c| c.is_ascii_digit()) {
            let prefix = &raw[..idx];
            if let Some(idx2) = prefix.rfind(':') {
                let suffix2 = &prefix[idx2 + 1..];
                if suffix2.chars().all(|c| c.is_ascii_digit()) && !prefix[..idx2].ends_with(':') {
                    &prefix[..idx2]
                } else {
                    prefix
                }
            } else {
                prefix
            }
        } else {
            raw
        }
    } else {
        raw
    };

    // Support WSL /mnt/<drive>/... on Windows
    #[cfg(target_os = "windows")]
    let wsl_converted = if stripped_line.starts_with("/mnt/") && stripped_line.len() >= 7 && stripped_line.as_bytes()[6] == b'/' {
        let drive = (stripped_line.as_bytes()[5] as char).to_ascii_uppercase();
        format!("{}:\\{}", drive, stripped_line[7..].replace('/', "\\"))
    } else {
        stripped_line.to_string()
    };
    #[cfg(target_os = "windows")]
    let raw_ref = &wsl_converted;
    #[cfg(not(target_os = "windows"))]
    let raw_ref = stripped_line;

    let candidate = if raw_ref == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(raw_ref))
    } else if let Some(rest) = raw_ref.strip_prefix("~/").or_else(|| raw_ref.strip_prefix("~\\")) {
        dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(raw_ref))
    } else {
        PathBuf::from(raw_ref)
    };

    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        let base = cwd
            .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
            .ok_or_else(|| "当前终端尚未上报工作目录，无法解析相对路径".to_string())?;
        PathBuf::from(base).join(candidate)
    };
    let resolved = resolved.canonicalize().map_err(|_| format!("路径不存在: {}", resolved.display()))?;
    launch_target(&resolved.to_string_lossy())
}

#[tauri::command]
pub fn set_window_effect(app: tauri::AppHandle, label: String, effect: String) -> Result<(), String> {
    let window = app.get_webview_window(&label).ok_or_else(|| "窗口不存在".to_string())?;

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{
            apply_acrylic, apply_blur, apply_mica, clear_acrylic, clear_blur, clear_mica,
        };
        let _ = clear_acrylic(&window);
        let _ = clear_blur(&window);
        let _ = clear_mica(&window);
        match effect.as_str() {
            "none" => Ok(()),
            "blur" => apply_blur(&window, Some((18, 18, 18, 120))).map_err(|e| e.to_string()),
            "acrylic" => apply_acrylic(&window, Some((18, 18, 18, 150))).map_err(|e| e.to_string()),
            "mica" => apply_mica(&window, None).map_err(|e| e.to_string()),
            _ => Err("未知窗口效果".to_string()),
        }
    }

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };
        let _ = clear_vibrancy(&window);
        match effect.as_str() {
            "none" => Ok(()),
            "blur" | "acrylic" | "mica" => apply_vibrancy(
                &window,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::Active),
                None,
            ).map_err(|e| e.to_string()),
            _ => Err("未知窗口效果".to_string()),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if matches!(effect.as_str(), "none" | "blur" | "acrylic" | "mica") {
            Ok(())
        } else {
            Err("未知窗口效果".to_string())
        }
    }
}
