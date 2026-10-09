use crate::state::AppState;
use crate::{
    credentials, known_hosts, profiles, pty, settings, sftp, ssh, sshconfig, transfers, windowing,
};
use tauri::{Manager, State};

use crate::profiles::SshProfile;
use crate::session::SessionKind;
use crate::ssh::SshConnectOpts;

// ---------- Tauri 命令 ----------

#[tauri::command]
async fn list_available_shells() -> Result<Vec<pty::ShellInfo>, String> {
    tauri::async_runtime::spawn_blocking(pty::detect_available_shells)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn spawn_local(
    app: tauri::AppHandle,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    no_profile: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pty::spawn(
            app.clone().into(),
            &app.state::<AppState>(),
            id,
            shell,
            cwd,
            cols,
            rows,
            no_profile.unwrap_or(false),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 前端异常上报入口（仅 debug 构建写入日志文件）
#[tauri::command]
fn log_frontend(msg: String) {
    pty::dbg(&format!("[frontend] {}", msg));
}

#[tauri::command]
async fn spawn_ssh(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    auth_channel: tauri::ipc::Channel<ssh::AuthChallenge>,
    host_key_channel: tauri::ipc::Channel<ssh::HostKeyChallenge>,
    keepalive_secs: Option<u64>,
    auth: Option<String>,
    proxy_jump: Option<String>,
    use_keychain: Option<bool>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let opts = SshConnectOpts {
        host,
        port,
        username,
        password,
        private_key,
        passphrase,
        auth_channel: auth_channel.into(),
        host_key_channel: host_key_channel.into(),
        keepalive_secs: keepalive_secs.unwrap_or(30).min(3600),
        auth: auth.unwrap_or_else(|| "auto".into()),
        proxy_jump,
        use_keychain: use_keychain.unwrap_or(true),
    };
    ssh::connect(app.into(), &state, id, opts, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn respond_ssh_auth(
    state: State<'_, AppState>,
    request_id: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    let sender = state
        .auth_pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or("认证请求已过期")?;
    sender.send(responses).map_err(|_| "认证已结束".to_string())
}

#[tauri::command]
fn list_known_hosts() -> Result<known_hosts::KnownHostsFile, String> {
    known_hosts::list().map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_known_host(line: usize) -> Result<(), String> {
    known_hosts::remove_line(line).map_err(|error| error.to_string())
}

#[tauri::command]
fn respond_ssh_host_key(
    state: State<'_, AppState>,
    request_id: String,
    decision: Option<String>,
) -> Result<(), String> {
    let sender = state
        .host_key_pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or("主机密钥确认请求已过期")?;
    sender
        .send(decision)
        .map_err(|_| "主机密钥确认已结束".to_string())
}

#[tauri::command]
async fn spawn_ssh_on_existing(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    new_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ssh::connect_on_existing(app.into(), &state, &source_id, new_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.write(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn write_sessions_bytes(
    state: State<'_, AppState>,
    ids: Vec<String>,
    data: Vec<u8>,
) -> Result<Vec<String>, String> {
    let sessions = state.sessions.lock().unwrap();
    let mut failed = Vec::new();
    for id in ids {
        match sessions.get(&id) {
            Some(session) => {
                if session.write(&data).is_err() {
                    failed.push(id);
                }
            }
            None => failed.push(id),
        }
    }
    Ok(failed)
}

#[tauri::command]
fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.resize(cols, rows).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 终止并移除会话（borrow 仅限于本条语句）
fn kill_session(state: &AppState, id: &str) {
    state.transfers.cancel_session(id);
    state
        .auth_pending
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{}-", id)));
    state
        .host_key_pending
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{}-", id)));
    if let Some(s) = state.sessions.lock().unwrap().remove(id) {
        s.kill();
    }
}

#[tauri::command]
async fn close_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    kill_session(&app.state::<AppState>(), &id);
    // 异步清理该会话可能存在的 SFTP 子系统
    tauri::async_runtime::spawn(async move {
        app.state::<AppState>().sftp.forget(&id).await;
    });
    Ok(())
}

#[tauri::command]
fn list_ssh_profiles() -> Vec<SshProfile> {
    profiles::load()
}

#[tauri::command]
fn save_ssh_profile(profile: SshProfile) -> Result<(), String> {
    profiles::save(profile).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_ssh_profile(name: String) -> Result<(), String> {
    profiles::remove(&name).map_err(|e| e.to_string())
}

/// 判断会话类型（前端用于决定能否打开 SFTP 面板）
#[tauri::command]
fn open_local_directory(
    state: State<'_, AppState>,
    sid: String,
    path: String,
) -> Result<(), String> {
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if !matches!(sessions.get(&sid), Some(SessionKind::Local { .. })) {
            return Err("只能打开本地终端目录".into());
        }
    }
    // Explicit user action only. No shell interpolation, URL handlers or executable paths.
    if path.chars().any(|c| c.is_control()) || path.starts_with("\\\\") || path.starts_with("//") {
        return Err("不支持控制字符或网络目录".into());
    }
    let directory = std::path::PathBuf::from(&path);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("目录不存在或不是绝对路径".into());
    }
    windowing::launch_target(&directory.to_string_lossy())
}

#[tauri::command]
fn session_is_ssh(state: State<'_, AppState>, sid: String) -> bool {
    let sessions = state.sessions.lock().unwrap();
    matches!(sessions.get(&sid), Some(SessionKind::Ssh { .. }))
}

// ---------- SSH config 导入 ----------

#[tauri::command]
fn scan_ssh_config() -> Result<Vec<sshconfig::ImportedHost>, String> {
    sshconfig::scan().map_err(|e| e.to_string())
}

// ---------- SFTP ----------

/// 从会话里取出 SSH 句柄；失败时给出统一报错文案
fn take_ssh_handle(
    state: &State<'_, AppState>,
    sid: &str,
) -> Result<std::sync::Arc<russh::client::Handle<ssh::SshHandler>>, String> {
    let handle = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(sid).and_then(|s| s.ssh_handle())
    };
    handle.ok_or_else(|| "会话不存在或不是 SSH 会话".to_string())
}

#[tauri::command]
async fn sftp_home(state: State<'_, AppState>, sid: String) -> Result<String, String> {
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("无法解析主目录: {e}"))
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    sid: String,
    path: String,
) -> Result<Vec<sftp::SftpEntry>, String> {
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    match sftp::list(&sftp, &path).await {
        Ok(list) => Ok(list),
        Err(e) => {
            // 目录列表失败通常意味着连接或子系统已失效，清掉缓存便于重试
            state.sftp.forget(&sid).await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn sftp_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sid: String,
    remote: String,
    local: String,
) -> Result<u64, String> {
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp::download(&app.clone().into(), &sid, &sftp, &remote, &local)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sid: String,
    local: String,
    remote: String,
) -> Result<u64, String> {
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp::upload(&app.clone().into(), &sid, &sftp, &local, &remote)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, sid: String, path: String) -> Result<(), String> {
    sftp::require_valid_path(&path).map_err(|e| e.to_string())?;
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    sid: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    sftp::require_valid_path(&path).map_err(|e| e.to_string())?;
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    let result = if is_dir {
        sftp.remove_dir(&path).await
    } else {
        sftp.remove_file(&path).await
    };
    result.map_err(|e| format!("删除失败: {e}"))
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    sid: String,
    from: String,
    to: String,
) -> Result<(), String> {
    sftp::require_valid_path(&from).map_err(|e| e.to_string())?;
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp.rename(&from, &to)
        .await
        .map_err(|e| format!("重命名失败: {e}"))
}

#[tauri::command]
async fn sftp_edit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sid: String,
    remote: String,
) -> Result<String, String> {
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp::edit_remote_file(&app.clone().into(), &sid, sftp, &remote)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_local_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_local_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_session_bytes(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.write(&data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn create_detached_window(
    app: tauri::AppHandle,
    label: String,
    title: String,
    transfer_token: Option<String>,
) -> Result<(), String> {
    let page = match transfer_token {
        Some(token) if !token.is_empty() => format!("index.html?transfer={token}"),
        _ => "index.html".to_string(),
    };
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(page.into()))
        .title(title)
        .decorations(false)
        .inner_size(960.0, 640.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn check_ssh_key_status(key_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&key_path);
    if !path.exists() {
        return Err("私钥文件不存在".to_string());
    }
    match russh::keys::load_secret_key(&path, None) {
        Ok(_) => Ok("ok".to_string()),
        Err(russh::keys::Error::KeyIsEncrypted) => Ok("encrypted".to_string()),
        Err(e) => Err(format!("加载私钥失败: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .manage(crate::startup::LaunchDirectory::from_process())
        .invoke_handler(tauri::generate_handler![
            list_available_shells,
            crate::startup::get_launch_directory,
            credentials::credential_get,
            credentials::credential_set,
            credentials::credential_delete,
            windowing::open_external_target,
            windowing::open_downloaded_file,
            windowing::open_local_terminal_path,
            windowing::set_window_effect,
            spawn_local,
            log_frontend,
            spawn_ssh,
            spawn_ssh_on_existing,
            respond_ssh_auth,
            respond_ssh_host_key,
            list_known_hosts,
            remove_known_host,
            write_session,
            write_session_bytes,
            write_sessions_bytes,
            resize_session,
            close_session,
            list_ssh_profiles,
            save_ssh_profile,
            delete_ssh_profile,
            settings::load_app_settings,
            settings::save_app_settings,
            settings::get_app_settings_path,
            settings::set_app_settings_path,
            scan_ssh_config,
            session_is_ssh,
            open_local_directory,
            check_ssh_key_status,
            create_detached_window,
            read_local_binary_file,
            write_local_binary_file,
            sftp_home,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_edit,
            sftp_transfer,
            sftp_transfer_control,
            sftp_chmod,
        ])
        .run(tauri::generate_context!())
        .expect("启动 wterm 失败");
}

#[tauri::command]
async fn sftp_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sid: String,
    transfer_id: String,
    direction: String,
    local: String,
    remote: String,
    overwrite: bool,
) -> Result<u64, String> {
    use std::time::Duration;
    use tauri::Emitter;
    sftp::require_valid_path(&remote).map_err(|e| e.to_string())?;
    if direction != "upload" && direction != "download" {
        return Err("无效传输方向".into());
    }
    let handle = take_ssh_handle(&state, &sid)?;
    let (_registration, control) = state
        .transfers
        .begin(&transfer_id, &sid)
        .map_err(|e| e.to_string())?;
    let report = |done: u64, total: u64, speed: f64| {
        let _ = app.emit(
            "wterm-sftp-transfer",
            serde_json::json!({
                "id": transfer_id, "sid": sid, "done": done, "total": total, "speed": speed
            }),
        );
    };
    report(0, 0, 0.0);
    let work = async {
        let sftp = tokio::time::timeout(Duration::from_secs(30), state.sftp.ensure(&sid, handle))
            .await
            .map_err(|_| anyhow::anyhow!("打开 SFTP 超时"))??;
        sftp::transfer(
            &sftp,
            &direction,
            &local,
            &remote,
            overwrite,
            control.clone(),
            report,
        )
        .await
    };
    transfers::cancellable(control.clone(), work)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn sftp_transfer_control(
    state: State<'_, AppState>,
    sid: String,
    transfer_id: String,
    action: String,
) -> Result<(), String> {
    state
        .transfers
        .control(&transfer_id, &sid, &action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_chmod(
    state: State<'_, AppState>,
    sid: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    sftp::require_valid_path(&path).map_err(|e| e.to_string())?;
    if mode > 0o7777 {
        return Err("权限必须是 0000–7777 的八进制数".into());
    }
    let handle = take_ssh_handle(&state, &sid)?;
    let sftp = state
        .sftp
        .ensure(&sid, handle)
        .await
        .map_err(|e| e.to_string())?;
    sftp.set_metadata(
        path,
        russh_sftp::protocol::FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        },
    )
    .await
    .map_err(|e| e.to_string())
}
