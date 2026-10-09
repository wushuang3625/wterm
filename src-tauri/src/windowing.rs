use std::path::PathBuf;
use tauri::Manager;

use crate::session::SessionKind;
use crate::state::AppState;

pub(crate) fn launch_target(target: &str) -> Result<(), String> {
    if target.is_empty() || target.len() > 8192 || target.chars().any(|c| c.is_control()) {
        return Err("无效的打开目标".to_string());
    }

    #[cfg(target_os = "windows")]
    let shell_path = windows_shell_path(target);
    #[cfg(target_os = "windows")]
    let clean = shell_path.as_ref();
    #[cfg(not(target_os = "windows"))]
    let clean = target;

    #[cfg(target_os = "windows")]
    let mut command = {
        let path = std::path::Path::new(clean);
        if path.is_dir() {
            return open_windows_directory(clean);
        }
        let mut cmd = std::process::Command::new("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler").arg(clean);
        cmd
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

#[cfg(target_os = "windows")]
fn windows_shell_path(target: &str) -> std::borrow::Cow<'_, str> {
    if let Some(unc) = target.strip_prefix(r"\\?\UNC\") {
        std::borrow::Cow::Owned(format!(r"\\{}", unc))
    } else {
        std::borrow::Cow::Borrowed(target.strip_prefix(r"\\?\").unwrap_or(target))
    }
}

#[cfg(target_os = "windows")]
fn open_windows_directory(path: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SW_SHOWNORMAL};

    let path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let owner = unsafe { GetForegroundWindow() } as usize;
    // A fresh STA supports Shell extensions regardless of the Tauri caller's COM mode.
    std::thread::Builder::new()
        .name("wterm-open-directory".into())
        .spawn(move || {
            let initialized = unsafe {
                CoInitializeEx(
                    std::ptr::null(),
                    (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                )
            };
            if initialized < 0 {
                return Err(format!(
                    "初始化目录打开组件失败: 0x{:08X}",
                    initialized as u32
                ));
            }
            struct ComApartment;
            impl Drop for ComApartment {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() };
                }
            }
            let _apartment = ComApartment;
            let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                // This worker has no message loop, so finish the Shell handoff before returning.
                fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                hwnd: owner as _,
                lpVerb: verb.as_ptr(),
                lpFile: path.as_ptr(),
                // Let the Shell activate/restore Explorer, including a reused folder window.
                nShow: SW_SHOWNORMAL,
                ..Default::default()
            };
            if unsafe { ShellExecuteExW(&mut info) } == 0 {
                Err(format!("无法打开目录: {}", std::io::Error::last_os_error()))
            } else {
                Ok(())
            }
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "目录打开线程异常".to_string())?
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
pub fn open_downloaded_file(path: String, reveal: bool) -> Result<(), String> {
    if path.is_empty() || path.len() > 8192 || path.chars().any(|c| c.is_control()) {
        return Err("无效的下载文件路径".to_string());
    }
    let file = PathBuf::from(&path);
    if !file.is_absolute() {
        return Err("下载文件路径必须是绝对路径".to_string());
    }
    let file = file
        .canonicalize()
        .map_err(|_| "文件不存在，可能已被移动或删除".to_string())?;
    if !file.is_file() {
        return Err("下载路径不是文件".to_string());
    }
    let target = file.to_string_lossy();
    #[cfg(target_os = "windows")]
    let target = windows_shell_path(&target);
    if !reveal {
        return launch_target(&target);
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.arg("/select,").arg(&*target);
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(&file);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(file.parent().ok_or("无法获取文件所在目录")?);
        cmd
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    return Err("当前系统不支持打开文件夹".to_string());

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
    let raw = path.trim_matches(|c| {
        matches!(
            c,
            '"' | '\'' | ',' | ';' | ':' | ')' | ']' | '}' | '>' | '<' | '`'
        )
    });

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
    let wsl_converted = if stripped_line.starts_with("/mnt/")
        && stripped_line.len() >= 7
        && stripped_line.as_bytes()[6] == b'/'
    {
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
    } else if let Some(rest) = raw_ref
        .strip_prefix("~/")
        .or_else(|| raw_ref.strip_prefix("~\\"))
    {
        dirs::home_dir()
            .map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(raw_ref))
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
    let resolved = resolved
        .canonicalize()
        .map_err(|_| format!("路径不存在: {}", resolved.display()))?;
    launch_target(&resolved.to_string_lossy())
}

#[tauri::command]
pub fn set_window_effect(
    app: tauri::AppHandle,
    label: String,
    effect: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "窗口不存在".to_string())?;

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
            )
            .map_err(|e| e.to_string()),
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

#[cfg(test)]
mod tests {
    use super::open_downloaded_file;

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_paths_preserve_unicode_spaces_and_unc_roots() {
        use super::windows_shell_path;
        assert_eq!(
            windows_shell_path(r"\\?\C:\Projects\中文 目录"),
            r"C:\Projects\中文 目录"
        );
        assert_eq!(
            windows_shell_path(r"\\?\UNC\server\share\中文 目录"),
            r"\\server\share\中文 目录"
        );
        assert_eq!(
            windows_shell_path(r"\\server\share\folder"),
            r"\\server\share\folder"
        );
    }

    #[test]
    fn downloaded_file_actions_reject_invalid_or_missing_files() {
        let directory = std::env::temp_dir();
        let missing = directory.join(format!("wterm-missing-download-{}.txt", std::process::id()));
        for reveal in [false, true] {
            assert!(open_downloaded_file("https://example.com/file.txt".into(), reveal).is_err());
            assert!(open_downloaded_file("relative.txt".into(), reveal).is_err());
            assert!(open_downloaded_file("invalid\nfile.txt".into(), reveal).is_err());
            assert!(
                open_downloaded_file(directory.to_string_lossy().into(), reveal)
                    .unwrap_err()
                    .contains("不是文件")
            );
            assert!(
                open_downloaded_file(missing.to_string_lossy().into(), reveal)
                    .unwrap_err()
                    .contains("文件不存在")
            );
        }
    }
}
