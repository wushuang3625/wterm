//! SSH 会话：基于 russh 的远程终端

use anyhow::{anyhow, Context};
use russh::client::{self, Handle};
use russh::keys::*;
use russh::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::session::SessionKind;
use crate::state::AppState;

#[derive(Clone, serde::Serialize)]
pub struct HostKeyChallenge {
    request_id: String,
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
    changed: bool,
}

/// SSH 主机密钥校验器：优先校验 ~/.ssh/known_hosts；未知主机必须显式确认。
pub struct SshHandler {
    host: String,
    port: u16,
    request_prefix: String,
    host_key_channel: tauri::ipc::Channel<HostKeyChallenge>,
    host_key_pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>>>,
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_key.public_key();
        let known_hosts_path = crate::known_hosts::path().context("无法定位 ~/.ssh/known_hosts")?;
        let changed = match russh::keys::known_hosts::check_known_hosts_path(&self.host, self.port, &key, &known_hosts_path) {
            Ok(true) => return Ok(true),
            Ok(false) => false,
            Err(russh::keys::Error::KeyChanged { .. }) => true,
            Err(error) => return Err(anyhow!("known_hosts 校验失败: {error}")),
        };

        let request_id = format!("{}-hostkey", self.request_prefix);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.host_key_pending.lock().unwrap().insert(request_id.clone(), tx);
        if let Err(error) = self.host_key_channel.send(HostKeyChallenge {
            request_id: request_id.clone(),
            host: self.host.clone(),
            port: self.port,
            algorithm: key.algorithm().as_str().to_string(),
            fingerprint: key.fingerprint(Default::default()).to_string(),
            changed,
        }) {
            self.host_key_pending.lock().unwrap().remove(&request_id);
            return Err(anyhow!("无法显示主机密钥确认窗口: {error}"));
        }

        let decision = tokio::time::timeout(std::time::Duration::from_secs(180), rx).await;
        self.host_key_pending.lock().unwrap().remove(&request_id);
        let decision = decision.context("主机密钥确认超时")?.context("主机密钥确认已关闭")?;

        match decision.as_deref() {
            Some("once") => Ok(true),
            Some("save") if !changed => {
                russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, crate::known_hosts::path()?)
                    .context("写入 ~/.ssh/known_hosts 失败")?;
                Ok(true)
            }
            Some("save") => Err(anyhow!("主机密钥已变更，拒绝自动覆盖 known_hosts；请核实后手动处理旧记录")),
            _ => Ok(false),
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct AuthChallenge {
    request_id: String,
    endpoint: String,
    name: String,
    instructions: String,
    prompts: Vec<AuthPrompt>,
}
#[derive(Clone, serde::Serialize)]
struct AuthPrompt { prompt: String, echo: bool }

pub struct SshConnectOpts {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub auth_channel: tauri::ipc::Channel<AuthChallenge>,
    pub host_key_channel: tauri::ipc::Channel<HostKeyChallenge>,
    pub keepalive_secs: u64,
    pub auth: String,
    pub proxy_jump: Option<String>,
    pub use_keychain: bool,
}

/// 建立 SSH 连接并打开交互式 shell 通道
pub async fn connect(
    app: AppHandle,
    state: &AppState,
    id: String,
    opts: SshConnectOpts,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(300)),
        keepalive_interval: (opts.keepalive_secs > 0).then(|| std::time::Duration::from_secs(opts.keepalive_secs)),
        ..Default::default()
    });

    let mut profiles = crate::profiles::load();
    if opts.proxy_jump.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        if let Ok(imported) = crate::sshconfig::scan() {
            for host in imported {
                if !profiles.iter().any(|p| p.name == host.alias) { profiles.push(host.into_profile()); }
            }
        }
    }
    let hops = crate::ssh_route::resolve(opts.proxy_jump.as_deref().unwrap_or(""), &profiles, &opts.username)?;
    let mut routes: Vec<Arc<Handle<SshHandler>>> = Vec::new();
    let mut endpoints: Vec<_> = hops.into_iter().map(|p| (p.host, p.port, p.username, p.auth, p.identity_file, None, None)).collect();
    endpoints.push((opts.host.clone(), opts.port, opts.username.clone(), opts.auth.clone(), opts.private_key.clone(), opts.password.clone(), opts.passphrase.clone()));
    let mut final_handle = None;
    let count = endpoints.len();
    for (index, (host, port, username, auth, private_key, mut password, mut passphrase)) in endpoints.into_iter().enumerate() {
        let prefix = format!("{id}-hop{index}");
        let endpoint = format!("{username}@{host}:{port}");
        let handler = SshHandler {
            host: host.clone(), port, request_prefix: prefix.clone(),
            host_key_channel: opts.host_key_channel.clone(), host_key_pending: state.host_key_pending.clone(),
        };
        let mut handle = if let Some(previous) = routes.last() {
            connect_via(previous, config.clone(), &host, port, handler).await
        } else {
            client::connect(config.clone(), (host.as_str(), port), handler).await
        }.with_context(|| format!("无法连接 {endpoint}（第 {} 跳）", index + 1))?;
        if opts.use_keychain && index + 1 < count {
            if auth == "password" {
                password = crate::credentials::credential_get("password".into(), endpoint.clone()).ok().flatten();
            }
            if let Some(path) = &private_key {
                passphrase = crate::credentials::credential_get("passphrase".into(), path.clone()).ok().flatten();
            }
        }
        let mut keys = std::collections::VecDeque::new();
        let mut round = 0;
        if auth != "agent" && auth != "password" {
            if let Some(path) = &private_key {
                let key = match load_secret_key(path, passphrase.as_deref()) {
                    Err(russh::keys::Error::KeyIsEncrypted) => {
                        let answers = request_auth(state, &opts.auth_channel, format!("{prefix}-key"), endpoint.clone(),
                            format!("解锁私钥 · {endpoint}"), path.clone(), vec![client::Prompt { prompt: "Passphrase:".into(), echo: false }]).await?;
                        load_secret_key(path, answers.first().map(String::as_str))?
                    }
                    result => result.with_context(|| format!("加载私钥失败 ({path})"))?,
                };
                keys.push_back(Arc::new(key));
            } else if auth == "key" {
                anyhow::bail!("{endpoint} 未配置私钥路径");
            } else if let Some(home) = dirs::home_dir() {
                for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
                    if let Ok(key) = load_secret_key(home.join(".ssh").join(name), None) { keys.push_back(Arc::new(key)); }
                }
            }
        }
        let agent = if auth == "agent" { Some(crate::ssh_agent::AgentAuth::system().await?) } else { None };
        let auth_result = crate::ssh_auth::authenticate_with_agent(
            &mut handle, &username, keys, password, agent,
            |name, instructions, prompts| {
                round += 1;
                request_auth(state, &opts.auth_channel, format!("{prefix}-{round}"), endpoint.clone(), format!("{endpoint} · {name}"), instructions, prompts)
            },
            |message| { let _ = app.emit(&format!("pty-output-{id}"), format!("\r\n[SSH {endpoint}] {message}\r\n").into_bytes()); },
        ).await;
        if let Err(error) = auth_result {
            let _ = handle.disconnect(Disconnect::ByApplication, "Authentication stopped", "en").await;
            return Err(error.context(format!("{endpoint} 认证失败")));
        }
        if index + 1 == count { final_handle = Some(handle); } else { routes.push(Arc::new(handle)); }
    }
    let handle = final_handle.context("连接目标为空")?;

    // ---- 打开通道并请求 PTY + shell ----
    let channel = handle
        .channel_open_session()
        .await
        .context("打开 SSH 通道失败")?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .context("申请 PTY 失败")?;
    channel
        .request_shell(false)
        .await
        .context("启动远程 shell 失败")?;

    // 认证与 shell 通道就绪后，把连接句柄共享出来：
    // 后续 SFTP 需要在同一连接上再开一个通道。
    let handle = Arc::new(handle);

    // ---- Actor：一个 tokio 任务独占 channel，select! 同时处理「前端命令」与「服务器输出」----
    let (cmd_tx, mut cmd_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::session::SshCommand>();
    let event_name = format!("pty-output-{}", id);
    let closed_event = format!("pty-closed-{}", id);

    tokio::spawn(async move {
        let mut channel = channel;
        loop {
            tokio::select! {
                // 来自前端的命令
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(crate::session::SshCommand::Write(data)) => {
                            let mut slice: &[u8] = &data;
                            if channel.data(&mut slice).await.is_err() { break; }
                        }
                        Some(crate::session::SshCommand::Resize(c, r)) => {
                            let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                        }
                        Some(crate::session::SshCommand::Close) | None => {
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
                // 来自服务器的输出
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let _ = app.emit(&event_name, data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { ref data, ext }) if ext == 1 => {
                            let _ = app.emit(&event_name, data.to_vec());
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = app.emit(&closed_event, ());
    });

    let kind = SessionKind::Ssh { cmd_tx, handle, routes };
    state.sessions.lock().unwrap().insert(id, kind);
    Ok(())
}

async fn request_auth(
    state: &AppState, channel: &tauri::ipc::Channel<AuthChallenge>, request_id: String,
    endpoint: String, name: String, instructions: String, prompts: Vec<client::Prompt>,
) -> anyhow::Result<Vec<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.auth_pending.lock().unwrap().insert(request_id.clone(), tx);
    let sent = channel.send(AuthChallenge {
        request_id: request_id.clone(), endpoint, name, instructions,
        prompts: prompts.into_iter().map(|p| AuthPrompt { prompt: p.prompt, echo: p.echo }).collect(),
    });
    if let Err(error) = sent {
        state.auth_pending.lock().unwrap().remove(&request_id);
        return Err(anyhow!("无法显示认证请求: {error}"));
    }
    let reply = tokio::time::timeout(std::time::Duration::from_secs(180), rx).await;
    state.auth_pending.lock().unwrap().remove(&request_id);
    reply.context("认证输入超时")?.context("认证已关闭")?.ok_or_else(|| anyhow!("认证已取消"))
}

pub async fn connect_on_existing(
    app: AppHandle,
    state: &AppState,
    source_id: &str,
    new_id: String,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    let (handle, routes) = {
        let sessions = state.sessions.lock().unwrap();
        match sessions.get(source_id) {
            Some(SessionKind::Ssh { handle, routes, .. }) => (handle.clone(), routes.clone()),
            _ => return Err(anyhow!("源会话不存在或不是 SSH 会话")),
        }
    };

    let channel = handle
        .channel_open_session()
        .await
        .context("在现有连接上打开 SSH 通道失败")?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .context("申请 PTY 失败")?;
    channel
        .request_shell(false)
        .await
        .context("启动远程 shell 失败")?;

    let (cmd_tx, mut cmd_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::session::SshCommand>();
    let event_name = format!("pty-output-{}", new_id);
    let closed_event = format!("pty-closed-{}", new_id);

    tokio::spawn(async move {
        let mut channel = channel;
        loop {
            tokio::select! {
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(crate::session::SshCommand::Write(data)) => {
                            let mut slice: &[u8] = &data;
                            if channel.data(&mut slice).await.is_err() { break; }
                        }
                        Some(crate::session::SshCommand::Resize(c, r)) => {
                            let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                        }
                        Some(crate::session::SshCommand::Close) | None => {
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let _ = app.emit(&event_name, data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { ref data, ext }) if ext == 1 => {
                            let _ = app.emit(&event_name, data.to_vec());
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = app.emit(&closed_event, ());
    });

    let kind = SessionKind::Ssh { cmd_tx, handle, routes };
    state.sessions.lock().unwrap().insert(new_id, kind);
    Ok(())
}


/// Shared by production and wire tests.
pub async fn connect_via<H: client::Handler + 'static>(previous: &Handle<H>, config: Arc<client::Config>, host: &str, port: u16, handler: H) -> Result<Handle<H>, H::Error> {
    let channel = previous.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await?;
    client::connect_stream(config, channel.into_stream(), handler).await
}
