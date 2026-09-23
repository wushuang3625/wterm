use anyhow::{bail, Context};
use std::{collections::HashMap, future::Future, sync::Mutex, time::{Duration, Instant}};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt}, sync::watch};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Control { Running, Paused, Cancelled }

#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, (String, watch::Sender<Control>)>>);
pub struct Registration<'a> { registry: &'a Transfers, id: String }
impl Drop for Registration<'_> {
    fn drop(&mut self) { self.registry.0.lock().unwrap().remove(&self.id); }
}
impl Transfers {
    pub fn begin(&self, id: &str, sid: &str) -> anyhow::Result<(Registration<'_>, watch::Receiver<Control>)> {
        if id.is_empty() || id.len() > 120 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { bail!("无效传输 ID"); }
        let mut map = self.0.lock().unwrap();
        if map.contains_key(id) { bail!("传输 ID 已存在"); }
        let (tx, rx) = watch::channel(Control::Running);
        map.insert(id.into(), (sid.into(), tx));
        Ok((Registration { registry: self, id: id.into() }, rx))
    }
    pub fn control(&self, id: &str, sid: &str, action: &str) -> anyhow::Result<()> {
        let state = match action { "pause" => Control::Paused, "resume" => Control::Running, "cancel" => Control::Cancelled, _ => bail!("无效传输操作") };
        let map = self.0.lock().unwrap();
        let (owner, tx) = map.get(id).context("传输已结束或尚未开始")?;
        if owner != sid { bail!("传输不属于此会话"); }
        if *tx.borrow() == Control::Cancelled { bail!("传输正在取消"); }
        tx.send(state).context("传输已结束")?;
        Ok(())
    }
    pub fn cancel_session(&self, sid: &str) {
        for (owner, tx) in self.0.lock().unwrap().values() {
            if owner == sid { let _ = tx.send(Control::Cancelled); }
        }
    }
}

pub async fn cancellable<T>(mut control: watch::Receiver<Control>, work: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    tokio::select! {
        biased;
        _ = async {
            loop {
                if *control.borrow_and_update() == Control::Cancelled { break; }
                if control.changed().await.is_err() { break; }
            }
        } => bail!("传输已取消；目标可能保留部分文件"),
        result = work => result,
    }
}

pub async fn copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    src: &mut R, dst: &mut W, mut control: watch::Receiver<Control>, mut report: impl FnMut(u64, f64),
) -> anyhow::Result<u64> {
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0;
    let mut active_time = Duration::ZERO;
    let mut last_report = Instant::now();
    loop {
        while *control.borrow_and_update() == Control::Paused {
            control.changed().await.context("传输控制已关闭")?;
        }
        if *control.borrow() == Control::Cancelled { bail!("传输已取消"); }
        let start = Instant::now();
        let n = tokio::time::timeout(Duration::from_secs(60), src.read(&mut buf)).await.context("读取超时")??;
        if n == 0 { break; }
        tokio::time::timeout(Duration::from_secs(60), dst.write_all(&buf[..n])).await.context("写入超时")??;
        done += n as u64;
        active_time += start.elapsed();
        if last_report.elapsed() >= Duration::from_millis(100) {
            report(done, done as f64 / active_time.as_secs_f64().max(0.001));
            last_report = Instant::now();
        }
    }
    tokio::time::timeout(Duration::from_secs(60), dst.flush()).await.context("刷新文件超时")??;
    report(done, done as f64 / active_time.as_secs_f64().max(0.001));
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn paused_copy_resumes_with_exact_binary_content() {
        let (tx, rx) = watch::channel(Control::Paused);
        let bytes: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
        let expected = bytes.clone();
        let task = tokio::spawn(async move {
            let mut output = Vec::new();
            copy(&mut bytes.as_slice(), &mut output, rx, |_, _| {}).await.unwrap();
            output
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!task.is_finished());
        tx.send(Control::Running).unwrap();
        assert_eq!(task.await.unwrap(), expected);
    }
    #[tokio::test]
    async fn cancellation_interrupts_stalled_io_and_registry_is_scoped_and_cleaned() {
        let registry = Transfers::default();
        let (guard, rx) = registry.begin("transfer-1", "session-a").unwrap();
        assert!(registry.control("transfer-1", "session-b", "cancel").is_err());
        assert!(registry.begin("transfer-1", "session-a").is_err());
        let task = tokio::spawn(cancellable(rx, std::future::pending::<anyhow::Result<()>>()));
        registry.cancel_session("session-a");
        assert!(tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap().is_err());
        drop(guard);
        assert!(registry.begin("transfer-1", "session-a").is_ok());
    }
}
