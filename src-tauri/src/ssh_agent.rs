use anyhow::{bail, Context};
use russh::keys::{agent::{client::{AgentClient, AgentStream}, AgentIdentity}, PublicKey};
use std::collections::VecDeque;
use std::time::Duration;

pub type Client = AgentClient<Box<dyn AgentStream + Send + Unpin>>;
pub struct AgentAuth {
    pub client: Client,
    pub keys: VecDeque<PublicKey>,
}

impl AgentAuth {
    pub async fn from_client(mut client: Client) -> anyhow::Result<Self> {
        let identities = tokio::time::timeout(Duration::from_secs(15), client.request_identities())
            .await.context("ssh-agent 读取密钥超时")??;
        let keys: VecDeque<_> = identities.into_iter().filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            AgentIdentity::Certificate { .. } => None,
        }).collect();
        if keys.is_empty() { bail!("ssh-agent 没有可用的普通公钥，请先使用 ssh-add 添加密钥（暂不支持 agent 证书身份）"); }
        Ok(Self { client, keys })
    }

    pub async fn system() -> anyhow::Result<Self> {
        #[cfg(windows)]
        let connect = async {
            let path = std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".into());
            AgentClient::connect_named_pipe(path).await.map(|client| client.dynamic())
        };
        #[cfg(unix)]
        let connect = async { AgentClient::connect_env().await.map(|client| client.dynamic()) };
        let client = tokio::time::timeout(Duration::from_secs(15), connect).await
            .context("连接 ssh-agent 超时")?
            .context("无法连接系统 ssh-agent；请启动 agent 并使用 ssh-add 添加密钥")?;
        Self::from_client(client).await
    }
}
