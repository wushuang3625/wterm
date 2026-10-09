//! SFTP 文件传输：复用已有 SSH 连接，另开一个通道承载 sftp 子系统。
//!
//! 设计要点：
//! - `Handle::channel_open_session(&self)` 只借用 `&self`，因此可在同一连接上并发开多个通道；
//! - SFTP 会话惰性创建并缓存，避免每次列目录都重新协商；
//! - 大文件传输分块读写并上报进度事件（运维场景常传大日志文件）。

use crate::events::EventSink as AppHandle;
use anyhow::{anyhow, Context};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::SshHandler;

/// 传输进度事件负载
#[derive(Clone, Serialize)]
pub struct TransferProgress {
    pub name: String,
    pub done: u64,
    pub total: u64,
}

/// 远程文件编辑同步事件（通知前端状态）
#[derive(Clone, Serialize)]
pub struct RemoteEditStatus {
    pub file_name: String,
    pub remote_path: String,
    pub status: String, // "opened" | "saving" | "saved" | "error"
    pub message: Option<String>,
}

/// 目录项（传给前端的最小信息集）
#[derive(Clone, Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix 时间戳（秒）
    pub modified: Option<u32>,
    /// 权限位（如 0o644）
    pub permissions: Option<u32>,
}

pub struct SftpManager {
    // 用 tokio Mutex：`ensure` 需要在等待建立连接期间持有锁，避免并发重复建通道
    sessions: tokio::sync::Mutex<HashMap<String, Arc<SftpSession>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 取得该 SSH 会话对应的 SFTP 子系统（不存在则建立并缓存）
    pub async fn ensure(
        &self,
        sid: &str,
        handle: Arc<russh::client::Handle<SshHandler>>,
    ) -> anyhow::Result<Arc<SftpSession>> {
        let mut map = self.sessions.lock().await;
        if let Some(s) = map.get(sid) {
            return Ok(s.clone());
        }

        let channel = handle
            .channel_open_session()
            .await
            .context("打开 SFTP 通道失败")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("服务端不支持 sftp 子系统")?;

        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("初始化 SFTP 会话失败")?;
        let sftp = Arc::new(sftp);
        map.insert(sid.to_string(), sftp.clone());
        Ok(sftp)
    }

    /// 会话结束或出错时清理缓存，下次调用会重新建立
    pub async fn forget(&self, sid: &str) {
        if let Some(s) = self.sessions.lock().await.remove(sid) {
            let _ = s.close().await;
        }
    }
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 列目录，目录在前、同类按名称排序
pub async fn list(sftp: &SftpSession, path: &str) -> anyhow::Result<Vec<SftpEntry>> {
    let read_dir = sftp
        .read_dir(path)
        .await
        .with_context(|| format!("无法读取目录 {}", path))?;

    let mut entries: Vec<SftpEntry> = read_dir
        .map(|e| {
            let ft = e.file_type();
            let meta = e.metadata();
            SftpEntry {
                name: e.file_name(),
                path: e.path(),
                is_dir: ft.is_dir(),
                is_symlink: ft.is_symlink(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime,
                permissions: meta.permissions,
            }
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// 远程 → 本地，分块传输并上报进度
pub async fn download(
    app: &AppHandle,
    sid: &str,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
) -> anyhow::Result<u64> {
    let mut src = sftp
        .open(remote)
        .await
        .with_context(|| format!("无法打开远程文件 {}", remote))?;

    let total = sftp
        .metadata(remote)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);
    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();

    if let Some(parent) = std::path::Path::new(local).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let mut dst = tokio::fs::File::create(local)
        .await
        .with_context(|| format!("无法写入本地文件 {}", local))?;

    let event = format!("sftp-progress-{}", sid);
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = src.read(&mut buf).await.context("读取远程数据失败")?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.context("写入本地文件失败")?;
        done += n as u64;
        let _ = app.emit(
            &event,
            TransferProgress {
                name: name.clone(),
                done,
                total,
            },
        );
    }
    dst.flush().await?;
    Ok(done)
}

/// 本地 → 远程，分块传输并上报进度
pub async fn upload(
    app: &AppHandle,
    sid: &str,
    sftp: &SftpSession,
    local: &str,
    remote: &str,
) -> anyhow::Result<u64> {
    let mut src = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("无法打开本地文件 {}", local))?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = local
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(local)
        .to_string();

    let mut dst = sftp
        .open_with_flags(
            remote,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .with_context(|| format!("无法创建远程文件 {}", remote))?;

    let event = format!("sftp-progress-{}", sid);
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = src.read(&mut buf).await.context("读取本地文件失败")?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.context("写入远程文件失败")?;
        done += n as u64;
        let _ = app.emit(
            &event,
            TransferProgress {
                name: name.clone(),
                done,
                total,
            },
        );
    }
    dst.flush().await?;
    Ok(done)
}
/// 拒绝危险路径，避免误删根目录
pub fn require_valid_path(p: &str) -> anyhow::Result<()> {
    if p.trim().is_empty() || p == "/" {
        return Err(anyhow!("拒绝操作空路径或根目录"));
    }
    Ok(())
}

/// 开启远程文件临时编辑，并在修改时自动回传
pub async fn edit_remote_file(
    app: &AppHandle,
    sid: &str,
    sftp: Arc<SftpSession>,
    remote: &str,
) -> anyhow::Result<String> {
    require_valid_path(remote)?;

    let file_name = Path::new(remote)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("无效的远程文件名"))?
        .to_string();

    // 在临时目录下建立该 session / 文件的隔离子目录，避免名称冲突
    let mut temp_dir = std::env::temp_dir();
    temp_dir.push("wterm-edit");
    temp_dir.push(format!("{}_{}", sid, uuid_compact()));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .context("无法创建编辑临时目录")?;

    let local_file_path = temp_dir.join(&file_name);
    let local_str = local_file_path.to_string_lossy().to_string();

    // 1. 下载远程文件至本地临时文件
    download(app, sid, &sftp, remote, &local_str).await?;

    // 2. 尝试使用操作系统默认关联程序打开文件
    #[cfg(target_os = "windows")]
    {
        let local_arg = local_str.clone();
        std::thread::spawn(move || {
            let _ = std::process::Command::new("notepad.exe")
                .arg(&local_arg)
                .spawn();
        });
    }
    #[cfg(target_os = "macos")]
    {
        let local_arg = local_str.clone();
        std::thread::spawn(move || {
            let _ = std::process::Command::new("open").arg(&local_arg).spawn();
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let local_arg = local_str.clone();
        std::thread::spawn(move || {
            let _ = std::process::Command::new("xdg-open")
                .arg(&local_arg)
                .spawn();
        });
    }

    // 3. 后台监听临时文件修改并回传
    let app_handle = app.clone();
    let sid_string = sid.to_string();
    let remote_string = remote.to_string();
    let local_path_buf = local_file_path.clone();

    tokio::spawn(async move {
        watch_and_sync_back(app_handle, sid_string, sftp, remote_string, local_path_buf).await;
    });

    Ok(local_str)
}

fn uuid_compact() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}_{}", d.as_secs(), d.subsec_nanos())
}

async fn watch_and_sync_back(
    app: AppHandle,
    sid: String,
    sftp: Arc<SftpSession>,
    remote: String,
    local: PathBuf,
) {
    let file_name = local
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let event_name = format!("sftp-edit-{}", sid);

    let _ = app.emit(
        &event_name,
        RemoteEditStatus {
            file_name: file_name.clone(),
            remote_path: remote.clone(),
            status: "opened".to_string(),
            message: Some(format!("已在本地打开: {}", file_name)),
        },
    );

    let mut last_mtime = tokio::fs::metadata(&local)
        .await
        .and_then(|m| m.modified())
        .ok();

    // 监听 2 小时后自动退出监控，避免无休止后台等待
    let max_cycles = 2 * 60 * 60 * 2; // 每 500ms 一次，约 2 小时
    for _ in 0..max_cycles {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        if !local.exists() {
            break;
        }

        if let Ok(meta) = tokio::fs::metadata(&local).await {
            if let Ok(mtime) = meta.modified() {
                if Some(mtime) != last_mtime {
                    last_mtime = Some(mtime);

                    // 防抖：编辑器可能分步写入或截断写入，等待 300ms
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

                    let _ = app.emit(
                        &event_name,
                        RemoteEditStatus {
                            file_name: file_name.clone(),
                            remote_path: remote.clone(),
                            status: "saving".to_string(),
                            message: Some(format!("检测到保存，正在回传: {}", file_name)),
                        },
                    );

                    let local_str = local.to_string_lossy().to_string();
                    match upload(&app, &sid, &sftp, &local_str, &remote).await {
                        Ok(_) => {
                            let _ = app.emit(
                                &event_name,
                                RemoteEditStatus {
                                    file_name: file_name.clone(),
                                    remote_path: remote.clone(),
                                    status: "saved".to_string(),
                                    message: Some(format!("已同步回传: {}", file_name)),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = app.emit(
                                &event_name,
                                RemoteEditStatus {
                                    file_name: file_name.clone(),
                                    remote_path: remote.clone(),
                                    status: "error".to_string(),
                                    message: Some(format!("回传失败: {}", e)),
                                },
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Queue transfers share the exact implementation exercised by cross-implementation tests.
pub async fn transfer(
    sftp: &SftpSession,
    direction: &str,
    local: &str,
    remote: &str,
    overwrite: bool,
    control: tokio::sync::watch::Receiver<crate::transfers::Control>,
    report: impl Fn(u64, u64, f64),
) -> anyhow::Result<u64> {
    use crate::transfers;
    require_valid_path(remote)?;
    if direction == "upload" {
        let mut source = tokio::fs::File::open(&local).await?;
        let metadata = source.metadata().await?;
        if !metadata.is_file() {
            anyhow::bail!("只支持上传普通文件");
        }
        let total = metadata.len();
        let flags = OpenFlags::WRITE
            | OpenFlags::CREATE
            | if overwrite {
                OpenFlags::TRUNCATE
            } else {
                OpenFlags::EXCLUDE
            };
        let mut target = sftp.open_with_flags(remote, flags).await?;
        report(0, total, 0.0);
        let done = transfers::copy(&mut source, &mut target, control.clone(), |done, speed| {
            report(done, total, speed)
        })
        .await?;
        target.shutdown().await?;
        Ok(done)
    } else {
        let metadata = sftp.metadata(remote).await?;
        if metadata.is_dir() {
            anyhow::bail!("请选择文件，暂不支持递归下载目录");
        }
        let total = metadata.size.unwrap_or(0);
        let mut source = sftp.open(remote).await?;
        let mut target = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .create_new(!overwrite)
            .truncate(overwrite)
            .open(&local)
            .await?;
        report(0, total, 0.0);
        let done = transfers::copy(&mut source, &mut target, control.clone(), |done, speed| {
            report(done, total, speed)
        })
        .await?;
        source.shutdown().await?;
        Ok(done)
    }
}
