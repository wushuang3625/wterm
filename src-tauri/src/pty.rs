//! 本地伪终端：启动 shell，读取输出，转发到前端

use crate::events::EventSink as AppHandle;
use anyhow::{anyhow, Context};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;

use crate::session::SessionKind;
use crate::state::AppState;

// Read $? before any prompt work changes it. Cmdlet failures get status 1;
// native programs retain their nonzero LASTEXITCODE. A later success resets to 0.
const POWERSHELL_PROMPT_HOOK: &str = "$global:WtermOriginalPrompt = $function:prompt; $global:WtermPromptSeen = $false; $global:WtermLastError = $null; function global:prompt { $ok = $?; $lastError = if ($Error.Count) { $Error[0] } else { $null }; $newError = -not [object]::ReferenceEquals($lastError, $global:WtermLastError); $code = if ($ok) { 0 } elseif ($newError -and $lastError.FullyQualifiedErrorId -notlike '*NativeCommandExit*') { 1 } elseif ($global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }; $global:WtermLastError = $lastError; $e = ([char]27).ToString(); if ($global:WtermPromptSeen) { [Console]::Write($e + ']133;D;' + $code + [char]7) }; $global:WtermPromptSeen = $true; $p = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path; [Console]::Write($e + ']9;9;' + $p + [char]7 + $e + ']133;A' + [char]7); $label = if ($global:WtermOriginalPrompt) { & $global:WtermOriginalPrompt } else { 'PS ' + $p + '> ' }; [string]$label + $e + ']133;B' + [char]7 }";

/// 诊断日志：写入 %TEMP%\wterm-debug.log（仅 debug 构建启用）。
/// 前端 JS 异常也会通过 `log_frontend` 汇总到这里，便于排查白屏类问题。
pub fn dbg(msg: &str) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("wterm-debug.log"))
        {
            let _ = writeln!(f, "{}", msg);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub icon: String,
}

pub fn detect_available_shells() -> Vec<ShellInfo> {
    static SHELLS: std::sync::OnceLock<Vec<ShellInfo>> = std::sync::OnceLock::new();
    SHELLS.get_or_init(scan_available_shells).clone()
}

fn scan_available_shells() -> Vec<ShellInfo> {
    let mut list = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if which_exists("pwsh.exe") {
            list.push(ShellInfo {
                id: "pwsh".to_string(),
                name: "PowerShell 7".to_string(),
                command: "pwsh.exe".to_string(),
                icon: "⚡".to_string(),
            });
        }
        if which_exists("powershell.exe") {
            list.push(ShellInfo {
                id: "powershell".to_string(),
                name: "Windows PowerShell".to_string(),
                command: "powershell.exe".to_string(),
                icon: "🔷".to_string(),
            });
        }
        if which_exists("cmd.exe") {
            list.push(ShellInfo {
                id: "cmd".to_string(),
                name: "Command Prompt (cmd)".to_string(),
                command: "cmd.exe".to_string(),
                icon: "⬛".to_string(),
            });
        }
        if which_exists("wsl.exe") {
            list.push(ShellInfo {
                id: "wsl".to_string(),
                name: "WSL (Linux)".to_string(),
                command: "wsl.exe".to_string(),
                icon: "🐧".to_string(),
            });
        }
        if which_exists("bash.exe") {
            list.push(ShellInfo {
                id: "git-bash".to_string(),
                name: "Git Bash".to_string(),
                command: "bash.exe".to_string(),
                icon: "🦬".to_string(),
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for (id, name, cmd) in [
            ("zsh", "Zsh", "/bin/zsh"),
            ("bash", "Bash", "/bin/bash"),
            ("fish", "Fish", "/usr/bin/fish"),
            ("sh", "Sh", "/bin/sh"),
        ] {
            if std::path::Path::new(cmd).exists() {
                list.push(ShellInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    command: cmd.to_string(),
                    icon: "🐚".to_string(),
                });
            }
        }
    }

    if list.is_empty() {
        list.push(ShellInfo {
            id: "default".to_string(),
            name: "默认终端".to_string(),
            command: detect_shell(),
            icon: "💻".to_string(),
        });
    }

    list
}

/// Windows 下按优先级探测可用 shell
fn detect_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        static DEFAULT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        DEFAULT
            .get_or_init(|| {
                ["pwsh.exe", "powershell.exe"]
                    .into_iter()
                    .find(|name| which_exists(name))
                    .unwrap_or("cmd.exe")
                    .to_string()
            })
            .clone()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[cfg(target_os = "windows")]
fn which_exists(name: &str) -> bool {
    // No child processes or console windows just to inspect PATH.
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

pub fn spawn(
    app: AppHandle,
    state: &AppState,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    no_profile: bool,
) -> anyhow::Result<String> {
    let started = std::time::Instant::now();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("打开 PTY 失败")?;

    let shell = shell.unwrap_or_else(detect_shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Preserve inherited agent configuration instead of injecting a Windows pipe.
    let shell_name = std::path::Path::new(&shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if no_profile && matches!(shell_name.as_str(), "pwsh" | "powershell") {
        cmd.arg("-NoLogo");
        cmd.arg("-NoProfile");
    }
    // Report the actual prompt directory, rather than guessing from typed `cd` commands.
    // Keep the user's PowerShell prompt (including profile customisations).
    // Return the prompt text: an empty return makes PowerShell append its fallback `PS>`.
    if matches!(shell_name.as_str(), "pwsh" | "powershell") {
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg(POWERSHELL_PROMPT_HOOK);
    } else if shell_name == "cmd" {
        cmd.arg("/K");
        cmd.arg("prompt $E]133;D$E\\$E]9;9;$P$E\\$E]133;A$E\\$P$G$E]133;B$E\\$S");
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        dbg(&format!("[pty] spawn_command 失败: {}", e));
        anyhow!("启动 shell `{}` 失败: {}", shell, e)
    })?;

    // slave 已被 spawn 接管，丢弃我们的副本
    drop(pair.slave);

    let writer = pair.master.take_writer().context("获取 PTY 写入端失败")?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .context("获取 PTY 读取端失败")?;

    let child: Box<dyn portable_pty::Child + Send> = child;
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let kind = SessionKind::Local {
        writer: std::sync::Mutex::new(writer),
        child: child.clone(),
        master: std::sync::Mutex::new(pair.master),
    };
    state.sessions.lock().unwrap().insert(id.clone(), kind);
    dbg(&format!(
        "[timing] local PTY created in {} ms",
        started.elapsed().as_millis()
    ));

    // 读取线程：PTY 输出 → 前端事件
    let event_name = format!("pty-output-{}", id);
    let closed_event = format!("pty-closed-{}", id);
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let exit_closed = closed.clone();
    let exit_sink = app.clone();
    let exit_event = closed_event.clone();
    // ConPTY can retain its output pipe after the child exits. Monitor the child
    // independently so the frontend receives a close event.
    std::thread::spawn(move || loop {
        let finished = child.lock().unwrap().try_wait();
        match finished {
            Ok(Some(_)) | Err(_) => {
                if !exit_closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    let _ = exit_sink.emit(&exit_event, ());
                }
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    });
    std::thread::spawn(move || {
        let mut first_output = true;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if first_output {
                        dbg(&format!(
                            "[timing] local first output in {} ms",
                            started.elapsed().as_millis()
                        ));
                        first_output = false;
                    }
                    let _ = app.emit(&event_name, buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
        if !closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            let _ = app.emit(&closed_event, ());
        }
    });

    Ok(shell)
}
