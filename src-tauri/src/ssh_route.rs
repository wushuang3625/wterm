//! Resolve ProxyJump without invoking a shell or ProxyCommand.
use anyhow::{bail, Context};
use crate::profiles::SshProfile;

pub fn resolve(spec: &str, profiles: &[SshProfile], default_user: &str) -> anyhow::Result<Vec<SshProfile>> {
    fn expand(spec: &str, profiles: &[SshProfile], user: &str, stack: &mut Vec<String>, out: &mut Vec<SshProfile>) -> anyhow::Result<()> {
        if spec.trim().is_empty() || spec.trim().eq_ignore_ascii_case("none") { return Ok(()); }
        for part in spec.split(',') {
            let part = part.trim();
            if part.is_empty() { bail!("跳板链包含空主机"); }
            if stack.iter().any(|item| item == part) || stack.len() >= 8 || out.len() >= 8 { bail!("跳板链存在循环或超过 8 跳"); }
            stack.push(part.to_owned());
            if let Some(mut profile) = profiles.iter().find(|p| p.name == part).cloned() {
                if profile.host.trim().is_empty() || profile.port == 0 || profile.username.trim().is_empty() { bail!("已保存的跳板配置缺少有效主机、端口或用户名"); }
                if let Some(nested) = profile.proxy_jump.take() { expand(&nested, profiles, user, stack, out)?; }
                if out.len() >= 8 { bail!("跳板链超过 8 跳"); }
                out.push(profile); stack.pop(); continue;
            }
            let (user_override, address) = part.rsplit_once('@').map_or((None, part), |(u, h)| (Some(u), h));
            let (alias, port_override) = if address.starts_with('[') {
                let end = address.find(']').context("IPv6 跳板地址缺少 ]")?;
                let rest = &address[end + 1..];
                (&address[1..end], if rest.is_empty() { None } else { Some(rest.strip_prefix(':').context("跳板端口格式错误")?) })
            } else {
                if address.matches(':').count() > 1 { bail!("IPv6 跳板请使用 [地址]:端口"); }
                address.split_once(':').map_or((address, None), |(h, p)| (h, Some(p)))
            };
            if alias.is_empty() || alias.chars().any(|c| c.is_whitespace() || c.is_control()) || user_override == Some("") {
                bail!("跳板主机或用户名无效");
            }
            let mut profile = profiles.iter().find(|p| p.name == alias).cloned().unwrap_or_else(|| SshProfile {
                name: alias.into(), host: alias.into(), port: 22, username: user.into(), auth: "agent".into(),
                identity_file: None, group: None, tags: vec![], color: None, login_script: None,
                keepalive_secs: None, auto_reconnect: false, reconnect_attempts: None, reconnect_delay_secs: None, proxy_jump: None,
            });
            if let Some(user) = user_override { profile.username = user.into(); }
            if let Some(port) = port_override { profile.port = port.parse().context("跳板端口无效")?; }
            if profile.port == 0 { bail!("跳板端口必须在 1–65535 之间"); }
            if let Some(nested) = profile.proxy_jump.take() { expand(&nested, profiles, user, stack, out)?; }
            if out.len() >= 8 { bail!("跳板链超过 8 跳"); }
            out.push(profile);
            stack.pop();
        }
        Ok(())
    }
    let mut out = Vec::new();
    expand(spec, profiles, default_user, &mut Vec::new(), &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_supports_chain_ipv6_overrides_and_rejects_invalid_input() {
        let route = resolve("alice@jump:2222,bob@[::1]:2200", &[], "root").unwrap();
        assert_eq!((&*route[0].username, route[0].port), ("alice", 2222));
        assert_eq!(&route[1].host, "::1");
        assert!(resolve("jump:0", &[], "root").is_err());
        assert!(resolve("jump,,target", &[], "root").is_err());
        let mut jump = route[0].clone(); jump.name = "jump".into(); jump.proxy_jump = Some("jump".into());
        assert!(resolve("jump", &[jump], "root").is_err());
        let mut named = route[0].clone(); named.name = "生产 跳板".into();
        let resolved = resolve("生产 跳板", &[named], "root").unwrap();
        assert_eq!(resolved[0].username, "alice");
    }
}
