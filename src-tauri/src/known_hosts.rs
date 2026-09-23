use std::path::PathBuf;

use anyhow::{anyhow, Context};
use serde::Serialize;

#[derive(Serialize)]
pub struct KnownHostEntry {
    pub line: usize,
    pub hosts: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: String,
}

#[derive(Serialize)]
pub struct KnownHostsFile {
    pub path: String,
    pub entries: Vec<KnownHostEntry>,
}

pub fn path() -> anyhow::Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| anyhow!("无法确定用户主目录"))
}

pub fn list() -> anyhow::Result<KnownHostsFile> {
    let path = path()?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("读取 known_hosts 失败"),
    };
    let mut entries = Vec::new();
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let offset = usize::from(parts.first().is_some_and(|value| value.starts_with('@')));
        if parts.len() < offset + 3 { continue; }
        let hosts = parts[offset].to_string();
        let algorithm = parts[offset + 1].to_string();
        let encoded = parts[offset + 2];
        let comment = parts.get(offset + 3..).map(|values| values.join(" ")).unwrap_or_default();
        let fingerprint = russh::keys::parse_public_key_base64(encoded)
            .map(|key| key.fingerprint(Default::default()).to_string())
            .unwrap_or_else(|_| "无法解析指纹".to_string());
        entries.push(KnownHostEntry { line: index + 1, hosts, algorithm, fingerprint, comment });
    }
    Ok(KnownHostsFile { path: path.display().to_string(), entries })
}

pub fn remove_line(line_number: usize) -> anyhow::Result<()> {
    if line_number == 0 { return Err(anyhow!("known_hosts 行号无效")); }
    let path = path()?;
    let content = std::fs::read_to_string(&path).context("读取 known_hosts 失败")?;
    let mut lines: Vec<&str> = content.lines().collect();
    if line_number > lines.len() { return Err(anyhow!("known_hosts 条目已变化，请刷新后重试")); }
    lines.remove(line_number - 1);
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let backup = path.with_extension("known_hosts.wterm.bak");
    std::fs::copy(&path, &backup).context("创建 known_hosts 备份失败")?;
    let output = if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
    std::fs::write(&path, output).context("写入 known_hosts 失败")?;
    Ok(())
}
