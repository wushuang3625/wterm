//! Cross-implementation tests: russh client against an independent ssh2 (Node) server.
use super::*;
use russh::{client, keys::{decode_secret_key, PublicKeyOrCertificate}};
use std::{io::{BufRead, BufReader}, process::{Child, Command, Stdio}, time::Duration};
struct Client;
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &PublicKeyOrCertificate) -> Result<bool, Self::Error> { Ok(true) }
}
struct Server(Child, u16, String);
impl Drop for Server {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
async fn connection(password_only: bool) -> (Handle<Client>, Server, Arc<PrivateKey>) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/ssh-server.cjs");
    let mut command = Command::new("node");
    command.arg(script).arg(if password_only { "password" } else { "mfa" }).stdout(Stdio::piped());
    let mut server = Server(command.spawn().expect("Install test dependencies: npm install"), 0, String::new());
    let mut line = String::new();
    BufReader::new(server.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let info: serde_json::Value = serde_json::from_str(&line).expect("SSH fixture failed to start");
    let key = Arc::new(decode_secret_key(info["privateKey"].as_str().unwrap(), None).unwrap());
    let port = info["port"].as_u64().unwrap() as u16;
    server.1 = port;
    server.2 = info["agentPipe"].as_str().unwrap().into();
    let handle = client::connect(Arc::new(client::Config::default()), ("127.0.0.1", port), Client).await.unwrap();
    (handle, server, key)
}
#[tokio::test]
async fn private_key_then_two_mfa_rounds() {
    let (mut client, _server, key) = connection(false).await;
    let mut rounds = 0;
    let mut reports = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(10), authenticate(
        &mut client, "fixture", VecDeque::from([key]), None,
        |_, instructions, prompts| {
            rounds += 1;
            assert_eq!(instructions, "Please Enter MFA Code.");
            assert_eq!(prompts[0].echo, rounds == 2);
            let answer = if rounds == 1 { "123456" } else { "confirm" };
            async move { Ok(vec![answer.into()]) }
        }, |message| reports.push(message.to_owned()),
    )).await.unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(rounds, 2);
    assert!(reports.iter().any(|s| s.contains("第一步认证通过")));
    // Prove authenticated channel access, not merely reception of an OTP prompt.
    let mut channel = client.channel_open_session().await.unwrap();
    channel.exec(true, "fixture").await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => break data.to_vec(),
                None => panic!("No authenticated output"),
                _ => {}
            }
        }
    }).await.unwrap();
    assert_eq!(output, b"authenticated\n");
}
#[tokio::test]
async fn wrong_otp_is_rejected() {
    let (mut client, _server, key) = connection(false).await;
    let mut prompted = false;
    let result = tokio::time::timeout(Duration::from_secs(10), authenticate(
        &mut client, "fixture", VecDeque::from([key]), None,
        |_, _, _| { prompted = true; async { Ok(vec!["wrong".into()]) } }, |_| {},
    )).await.unwrap();
    assert!(prompted);
    assert!(result.is_err());
}
#[tokio::test]
async fn cancel_mfa_returns_without_hanging() {
    let (mut client, _server, key) = connection(false).await;
    let result = tokio::time::timeout(Duration::from_secs(10), authenticate(
        &mut client, "fixture", VecDeque::from([key]), None,
        |_, _, _| async { bail!("认证已取消") }, |_| {},
    )).await.unwrap();
    assert!(result.unwrap_err().to_string().contains("认证已取消"));
}
#[tokio::test]
async fn ordinary_password_login_still_works() {
    let (mut client, _server, _) = connection(true).await;
    let result = tokio::time::timeout(Duration::from_secs(10), authenticate(
        &mut client, "fixture", VecDeque::new(), Some("test-password".into()),
        |_, _, _| async { panic!("must not prompt for an already supplied password") }, |_| {},
    )).await.unwrap();
    assert!(result.is_ok(), "{result:?}");
}

#[tokio::test]
async fn agent_signature_then_mfa_uses_no_client_private_key() {
    let (mut client, server, _) = connection(false).await;
    #[cfg(windows)]
    let agent = russh::keys::agent::client::AgentClient::connect_named_pipe(&server.2).await.unwrap().dynamic();
    #[cfg(unix)]
    let agent = russh::keys::agent::client::AgentClient::connect_uds(&server.2).await.unwrap().dynamic();
    let agent = crate::ssh_agent::AgentAuth::from_client(agent).await.unwrap();
    let mut rounds = 0;
    tokio::time::timeout(Duration::from_secs(10), authenticate_with_agent(
        &mut client, "fixture", VecDeque::new(), None, Some(agent),
        |_, _, _| {
            rounds += 1;
            let answer = if rounds == 1 { "123456" } else { "confirm" };
            async move { Ok(vec![answer.into()]) }
        }, |_| {},
    )).await.unwrap().unwrap();
    assert_eq!(rounds, 2);
    assert!(client.channel_open_session().await.is_ok());
}

#[tokio::test]
async fn two_proxy_hops_open_multiple_target_channels_and_reject_bad_destination() {
    let (mut first, server, _) = connection(true).await;
    assert!(first.authenticate_password("fixture", "test-password").await.unwrap().success());
    let mut second = crate::ssh::connect_via(&first, Arc::new(client::Config::default()), "127.0.0.1", server.1, Client).await.unwrap();
    assert!(second.authenticate_password("fixture", "test-password").await.unwrap().success());
    let mut target = crate::ssh::connect_via(&second, Arc::new(client::Config::default()), "127.0.0.1", server.1, Client).await.unwrap();
    assert!(target.authenticate_password("fixture", "test-password").await.unwrap().success());
    for _ in 0..2 {
        let mut channel = target.channel_open_session().await.unwrap();
        channel.exec(true, "fixture").await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(msg) = channel.wait().await {
                if let russh::ChannelMsg::Data { data } = msg { return data.to_vec(); }
            }
            vec![]
        }).await.unwrap();
        assert_eq!(result, b"authenticated\n");
    }
    assert!(crate::ssh::connect_via(&first, Arc::new(client::Config::default()), "forbidden.invalid", 22, Client).await.is_err());
}

#[tokio::test]
async fn sftp_roundtrip_through_proxy_preserves_binary_and_refuses_unconfirmed_overwrite() {
    let (mut first, server, _) = connection(true).await;
    assert!(first.authenticate_password("fixture", "test-password").await.unwrap().success());
    let mut target = crate::ssh::connect_via(&first, Arc::new(client::Config::default()), "127.0.0.1", server.1, Client).await.unwrap();
    assert!(target.authenticate_password("fixture", "test-password").await.unwrap().success());
    let channel = target.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.unwrap();
    let name = format!("wterm-sftp-fixture-{}-{}", std::process::id(), server.1);
    let upload = std::env::temp_dir().join(format!("{name}-upload"));
    let download = std::env::temp_dir().join(format!("{name}-download"));
    let bytes: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
    tokio::fs::write(&upload, &bytes).await.unwrap();
    let (tx, rx) = tokio::sync::watch::channel(crate::transfers::Control::Running);
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        crate::sftp::transfer(&sftp, "upload", upload.to_str().unwrap(), "/binary.bin", false, rx.clone(), |_, _, _| {}).await?;
        assert!(crate::sftp::transfer(&sftp, "upload", upload.to_str().unwrap(), "/binary.bin", false, rx.clone(), |_, _, _| {}).await.is_err());
        crate::sftp::transfer(&sftp, "download", download.to_str().unwrap(), "/binary.bin", false, rx.clone(), |_, _, _| {}).await?;
        assert_eq!(tokio::fs::read(&download).await?, bytes);
        sftp.set_metadata("/binary.bin", russh_sftp::protocol::FileAttributes { permissions: Some(0o100640), ..Default::default() }).await?;
        assert_eq!(sftp.metadata("/binary.bin").await?.permissions.unwrap() & 0o777, 0o640);
        anyhow::Ok(())
    }).await;
    drop(tx);
    let _ = tokio::fs::remove_file(upload).await;
    let _ = tokio::fs::remove_file(download).await;
    result.unwrap().unwrap();
}
