//! 解析 ~/.ssh/config，用于把 OpenSSH 现有配置迁移进 wterm。
//!
//! 只处理单层配置（不展开 Include / Match），并对通配符主机做跳过处理，
//! 避免把 `Host *` 这类全局默认项误当成可连接的主机。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 从 ssh config 中解析出的一条可导入主机
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedHost {
    /// Host 段声明的别名（用作 wterm 中的显示名）
    pub alias: String,
    /// HostName，缺省时等于 alias
    pub host: String,
    pub port: u16,
    pub username: String,
    /// IdentityFile，已把 `~` 展开为绝对路径
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

pub fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("config")
}

/// 本地默认用户名（OpenSSH 未指定 User 时使用登录名）
fn default_user() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERNAME").unwrap_or_else(|_| "root".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("USER").unwrap_or_else(|_| "root".to_string())
    }
}

/// 把 `~` 开头的路径展开为绝对路径
/// 把 `~` 开头的路径展开为绝对路径
fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            #[cfg(target_os = "windows")]
            {
                return home.join(rest.replace('/', "\\")).to_string_lossy().to_string();
            }
            #[cfg(not(target_os = "windows"))]
            {
                return home.join(rest).to_string_lossy().to_string();
            }
        }
    }
    p.to_string()
}

/// 通配符/取反模式不可直接连接
fn is_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.starts_with('!')
}

/// 解析配置文件内容。
///
/// 支持的关键字：Host / HostName / User / Port / IdentityFile。
/// 未知关键字与注释一律忽略。
pub fn parse(content: &str) -> Vec<ImportedHost> {
    let mut hosts: Vec<ImportedHost> = Vec::new();
    let mut current: Option<ImportedHost> = None;

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // 关键字与值之间可用空格或 '=' 分隔
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().to_string()),
            None => continue,
        };
        let value = value.trim_start_matches('=').trim().to_string();
        if value.is_empty() {
            continue;
        }

        match key.as_str() {
            "host" => {
                // 收尾上一段
                if let Some(h) = current.take() {
                    hosts.push(h);
                }
                // 取第一个非通配符的模式作为别名；该段全是通配符则整段跳过
                let alias = value
                    .split_whitespace()
                    .find(|p| !is_wildcard(p))
                    .map(|s| s.to_string());
                if let Some(alias) = alias {
                    current = Some(ImportedHost {
                        host: alias.clone(),
                        alias,
                        port: 22,
                        username: default_user(),
                        identity_file: None,
                        proxy_jump: None,
                    });
                }
            }
            "hostname" => {
                if let Some(h) = current.as_mut() {
                    h.host = value;
                }
            }
            "user" => {
                if let Some(h) = current.as_mut() {
                    h.username = value;
                }
            }
            "port" => {
                if let Some(h) = current.as_mut() {
                    if let Ok(p) = value.parse::<u16>() {
                        h.port = p;
                    }
                }
            }
            "proxyjump" => { if let Some(h) = current.as_mut() { h.proxy_jump = Some(value); } }
            "identityfile" => {
                if let Some(h) = current.as_mut() {
                    // 只保留第一个密钥文件，多个 IdentityFile 时取首个
                    if h.identity_file.is_none() {
                        h.identity_file = Some(expand_tilde(&value));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(h) = current.take() {
        hosts.push(h);
    }

    // 按别名去重（同名后者覆盖），保持出现顺序
    let mut seen: Vec<String> = Vec::new();
    hosts.retain(|h| {
        if seen.contains(&h.alias) {
            false
        } else {
            seen.push(h.alias.clone());
            true
        }
    });
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ssh_config() {
        let sample = r#"
        # 全局配置，应被跳过
        Host *
            ServerAliveInterval 60
            User root

        # 正常机器
        Host prod-web
            HostName 192.168.1.100
            User deploy
            Port 2222
            IdentityFile ~/.ssh/id_rsa_prod

        # 另一个配置（等号风格）
        Host dev-db
            HostName=10.0.0.5
            User=admin
            Port=3306
        "#;

        let hosts = parse(sample);
        assert_eq!(hosts.len(), 2);

        assert_eq!(hosts[0].alias, "prod-web");
        assert_eq!(hosts[0].host, "192.168.1.100");
        assert_eq!(hosts[0].username, "deploy");
        assert_eq!(hosts[0].port, 2222);
        assert!(hosts[0].identity_file.is_some());

        assert_eq!(hosts[1].alias, "dev-db");
        assert_eq!(hosts[1].host, "10.0.0.5");
        assert_eq!(hosts[1].username, "admin");
        assert_eq!(hosts[1].port, 3306);
    }

    #[test]
    fn test_user_scan() {
        if let Ok(hosts) = scan() {
            println!("Scanned {} hosts from real ~/.ssh/config:", hosts.len());
            for h in &hosts {
                println!("  {} -> {}@{}:{} (key: {:?})", h.alias, h.username, h.host, h.port, h.identity_file);
            }
        }
    }
}

/// 读取并解析 ~/.ssh/config
pub fn scan() -> anyhow::Result<Vec<ImportedHost>> {
    let path = config_path();
    if !path.exists() {
        anyhow::bail!("未找到 {}", path.display());
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(parse(&content))
}
impl ImportedHost {
    pub fn into_profile(self) -> crate::profiles::SshProfile {
        crate::profiles::SshProfile {
            id: None,
            name: self.alias, host: self.host, port: self.port, username: self.username,
            auth: if self.identity_file.is_some() { "key" } else { "agent" }.into(), identity_file: self.identity_file,
            proxy_jump: self.proxy_jump, group: None, tags: vec![], color: None, login_script: None,
            keepalive_secs: None, auto_reconnect: false, reconnect_attempts: None, reconnect_delay_secs: None,
        }
    }
}
