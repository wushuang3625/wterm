//! Authentication policy, independent of Tauri so the real wire exchange is testable.
#[cfg(test)]
#[path = "ssh_auth_tests.rs"]
mod tests;
use anyhow::{anyhow, bail, Context};
use russh::client::{Handle, Handler, KeyboardInteractiveAuthResponse as Interactive, Prompt};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg};
use russh::client::AuthResult;
use russh::MethodKind;
use std::{collections::VecDeque, future::Future, sync::Arc};

#[cfg(test)]
pub async fn authenticate<H, Ask, Reply, Report>(
    handle: &mut Handle<H>, username: &str, keys: VecDeque<Arc<PrivateKey>>,
    password: Option<String>, ask: Ask, report: Report,
) -> anyhow::Result<()>
where H: Handler, Ask: FnMut(String, String, Vec<Prompt>) -> Reply,
    Reply: Future<Output = anyhow::Result<Vec<String>>>, Report: FnMut(&str),
{
    authenticate_with_agent(handle, username, keys, password, None, ask, report).await
}

pub async fn authenticate_with_agent<H, Ask, Reply, Report>(
    handle: &mut Handle<H>, username: &str, mut keys: VecDeque<Arc<PrivateKey>>,
    mut password: Option<String>, mut agent: Option<crate::ssh_agent::AgentAuth>, mut ask: Ask, mut report: Report,
) -> anyhow::Result<()>
where
    H: Handler,
    Ask: FnMut(String, String, Vec<Prompt>) -> Reply,
    Reply: Future<Output = anyhow::Result<Vec<String>>>,
    Report: FnMut(&str),
{
    // Obtain allowed methods. In particular, retain partial_success after each factor.
    let mut result = handle.authenticate_none(username).await?;
    let mut password_attempted = false;
    let mut interactive_attempted = false;
    for _ in 0..32 {
        let AuthResult::Failure { remaining_methods, partial_success } = result.clone() else {
            report("认证成功");
            return Ok(());
        };
        if partial_success { report("第一步认证通过，服务器要求继续验证"); }
        if !partial_success && remaining_methods.contains(&MethodKind::PublicKey) {
            if let Some(agent) = agent.as_mut() {
                if let Some(key) = agent.keys.pop_front() {
                    report("正在通过系统 ssh-agent 签名认证");
                    let hash = handle.best_supported_rsa_hash().await?.flatten();
                    result = tokio::time::timeout(std::time::Duration::from_secs(120),
                        handle.authenticate_publickey_with(username, key, hash, &mut agent.client))
                        .await.context("ssh-agent 签名超时")?.context("ssh-agent 签名认证失败")?;
                    continue;
                }
            }
        }
        if !partial_success && remaining_methods.contains(&MethodKind::PublicKey) && !keys.is_empty() {
            report("正在进行私钥认证");
            let key = keys.pop_front().unwrap();
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            result = handle.authenticate_publickey(username, PrivateKeyWithHashAlg::new(key, hash)).await
                .context("私钥认证通信失败")?;
            continue;
        }
        if remaining_methods.contains(&MethodKind::Password) && !password_attempted && password.is_some() {
            password_attempted = true;
            report("正在进行密码认证");
            result = handle.authenticate_password(username, password.take().unwrap()).await?;
            continue;
        }
        if remaining_methods.contains(&MethodKind::KeyboardInteractive) && !interactive_attempted {
            interactive_attempted = true;
            report("服务器请求键盘交互认证（密码 / MFA）");
            let mut response = handle.authenticate_keyboard_interactive_start(username, None).await?;
            let mut finished = false;
            for _ in 0..32 {
                match response {
                    Interactive::Success => { result = AuthResult::Success; finished = true; break; }
                    Interactive::Failure { remaining_methods, partial_success } => {
                        result = AuthResult::Failure { remaining_methods, partial_success };
                        finished = true;
                        break;
                    }
                    Interactive::InfoRequest { name, instructions, prompts } => {
                        let count = prompts.len();
                        let answers = if count == 0 { Vec::new() } else {
                            report("等待输入服务器认证挑战");
                            ask(name, instructions, prompts).await?
                        };
                        if answers.len() != count { bail!("认证响应数量不匹配"); }
                        response = handle.authenticate_keyboard_interactive_respond(answers).await?;
                    }
                }
            }
            if !finished { bail!("认证挑战轮数过多"); }
            continue;
        }
        if remaining_methods.contains(&MethodKind::Password) && !password_attempted {
            password_attempted = true;
            let answers = ask("SSH 密码".into(), String::new(), vec![Prompt { prompt: "Password:".into(), echo: false }]).await?;
            let answer = answers.into_iter().next().ok_or_else(|| anyhow!("未提供密码"))?;
            result = handle.authenticate_password(username, answer).await?;
            continue;
        }
        bail!("认证被拒绝（服务器允许: {:?}，已通过部分认证: {}）", remaining_methods, partial_success);
    }
    bail!("认证步骤过多")
}
