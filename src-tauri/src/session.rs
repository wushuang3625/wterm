//! 会话抽象：统一本地 PTY 与 SSH 通道的读写接口

use std::io::Write;
use std::sync::Mutex;

/// 发给 SSH 通道 actor 的命令
pub enum SshCommand {
    /// 用户输入
    Write(Vec<u8>),
    /// 调整终端尺寸
    Resize(u16, u16),
    /// 关闭通道
    Close,
}

/// 一个可交互的终端会话（本地 PTY 或 SSH 通道）
pub enum SessionKind {
    /// 本地伪终端
    Local {
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<Box<dyn portable_pty::Child + Send>>,
        master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    },
    /// SSH 远程通道：由独立 tokio 任务持有 shell channel，命令经 mpsc 下发。
    /// `handle` 保留下来是为了在同一连接上按需开启新通道（SFTP 子系统）。
    Ssh {
        cmd_tx: tokio::sync::mpsc::UnboundedSender<SshCommand>,
        handle: std::sync::Arc<russh::client::Handle<crate::ssh::SshHandler>>,
        routes: Vec<std::sync::Arc<russh::client::Handle<crate::ssh::SshHandler>>>,
    },
}

impl SessionKind {
    /// 取出 SSH 连接句柄（本地会话返回 None）。
    /// `Handle::channel_open_session` 接受 `&self`，因此可安全共享以并发开通道。
    pub fn ssh_handle(&self) -> Option<std::sync::Arc<russh::client::Handle<crate::ssh::SshHandler>>> {
        match self {
            SessionKind::Ssh { handle, .. } => Some(handle.clone()),
            SessionKind::Local { .. } => None,
        }
    }
}

impl SessionKind {
    /// 向会话写入用户输入
    pub fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        match self {
            SessionKind::Local { writer, .. } => {
                let mut w = writer.lock().unwrap();
                w.write_all(data)?;
                w.flush()?;
            }
            SessionKind::Ssh { cmd_tx, .. } => {
                cmd_tx.send(SshCommand::Write(data.to_vec()))?;
            }
        }
        Ok(())
    }

    /// 调整终端尺寸
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        match self {
            SessionKind::Local { master, .. } => {
                let m = master.lock().unwrap();
                m.resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
            }
            SessionKind::Ssh { cmd_tx, .. } => {
                cmd_tx.send(SshCommand::Resize(cols, rows))?;
            }
        }
        Ok(())
    }

    /// 终止会话
    pub fn kill(&self) {
        match self {
            SessionKind::Local { child, .. } => {
                let _ = child.lock().unwrap().kill();
            }
            SessionKind::Ssh { cmd_tx, .. } => {
                let _ = cmd_tx.send(SshCommand::Close);
            }
        }
    }
}
