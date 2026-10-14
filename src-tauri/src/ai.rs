//! AI 对话（BYOK）：OpenAI / Anthropic 兼容协议的流式对话与模型列表拉取。
//! 请求由本机直连用户配置的服务商，不经任何中间服务器；API key 存系统 Keychain。

use crate::events::Channel;
use serde::Deserialize;
use std::time::Duration;
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::watch;

/// Keychain 中保存 AI API key 的条目名（service 与其他凭据一致）。
const CHAT_TIMEOUT_SECS: u64 = 90;
const MODELS_TIMEOUT_SECS: u64 = 15;

#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<(String, String), watch::Sender<bool>>>);

struct Registration<'a> {
    requests: &'a AiRequests,
    key: (String, String),
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.requests.0.lock().unwrap().remove(&self.key);
    }
}

impl AiRequests {
    fn begin(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<(Registration<'_>, watch::Receiver<bool>), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("无效请求 ID".into());
        }
        let mut requests = self.0.lock().unwrap();
        let key = (owner.to_string(), id.to_string());
        if requests.contains_key(&key) {
            return Err("请求 ID 已存在".into());
        }
        let (sender, receiver) = watch::channel(false);
        requests.insert(key.clone(), sender);
        Ok((
            Registration {
                requests: self,
                key,
            },
            receiver,
        ))
    }

    fn cancel(&self, owner: &str, id: &str) {
        if let Some(sender) = self.0.lock().unwrap().get(&(owner.into(), id.into())) {
            sender.send_replace(true);
        }
    }

    pub fn cancel_window(&self, owner: &str) {
        for ((window, _), sender) in self.0.lock().unwrap().iter() {
            if window == owner {
                sender.send_replace(true);
            }
        }
    }
}

#[derive(Deserialize, serde::Serialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

/// 通过 IPC Channel 推送给前端的流式片段。
#[derive(serde::Serialize, Clone)]
pub struct AiChunk {
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(rename = "reasoningDelta", skip_serializing_if = "Option::is_none")]
    pub reasoning_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub done: bool,
}

impl AiChunk {
    fn activity(phase: &str, tool_name: Option<String>) -> Self {
        Self {
            started: false,
            activity: Some(phase.into()),
            tool_name,
            delta: None,
            reasoning_delta: None,
            error: None,
            done: false,
        }
    }
    fn delta(text: &str) -> Self {
        Self {
            started: false,
            activity: None,
            tool_name: None,
            delta: Some(text.to_string()),
            reasoning_delta: None,
            error: None,
            done: false,
        }
    }
    fn reasoning(text: &str) -> Self {
        let mut chunk = Self::activity("thinking", None);
        if !text.is_empty() {
            chunk.reasoning_delta = Some(text.to_string());
        }
        chunk
    }
    fn error(message: String) -> Self {
        Self {
            started: false,
            activity: None,
            tool_name: None,
            delta: None,
            reasoning_delta: None,
            error: Some(message),
            done: true,
        }
    }
    fn done() -> Self {
        Self {
            started: false,
            activity: None,
            tool_name: None,
            delta: None,
            reasoning_delta: None,
            error: None,
            done: true,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AiProtocol {
    OpenAi,
    Anthropic,
}

fn parse_protocol(protocol: &str) -> Result<AiProtocol, String> {
    match protocol {
        "openai" | "" => Ok(AiProtocol::OpenAi),
        "anthropic" => Ok(AiProtocol::Anthropic),
        other => Err(format!("不支持的 AI 协议: {other}")),
    }
}

/// reqwest 使用 rustls-no-provider，需在进程内安装一次 CryptoProvider。
/// 选用 ring（russh 已在依赖树中），避免 aws-lc-rs 的 cmake/nasm 构建要求。
fn ensure_tls_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// 从 Keychain 读取 AI API key（Ollama 等本地服务无需 key）。
fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base_url.trim()).map_err(|_| "无效的 AI 服务地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL 必须是无用户名、密码、查询参数的 HTTP(S) 地址".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn credential_key(base_url: &str, protocol: AiProtocol) -> String {
    let name = match protocol {
        AiProtocol::OpenAi => "openai",
        AiProtocol::Anthropic => "anthropic",
    };
    format!("ai:{name}:{base_url}")
}

fn read_api_key(base_url: &str, protocol: AiProtocol) -> Result<Option<String>, String> {
    crate::credentials::credential_get("api_key".to_string(), credential_key(base_url, protocol))
        .map(|key| key.filter(|key| !key.is_empty()))
        .map_err(|_| "读取系统 API Key 失败，请检查系统凭据库".to_string())
}

/// 把 HTTP 状态码与响应体映射为面向用户的中文错误。
fn status_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.pointer("/message"))
                .or_else(|| value.pointer("/error"))
                .and_then(|message| message.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status {
        401 | 403 => format!("API key 无效或无权限（{status}）"),
        404 => format!("接口不存在（{status}）：请检查 base_url 是否完整（如以 /v1 结尾）"),
        429 => "请求被限流（429），请稍后重试".to_string(),
        _ => format!("请求失败（{status}）：{detail}"),
    }
}

/// SSE data 行解析结果：一段文本增量，或流结束标记。
#[derive(Debug)]
pub enum SseEvent {
    Delta(String),
    Thinking(String),
    DeltaWithReasoning { text: String, reasoning: String },
    ToolRequest(String),
    Done,
}

/// 解析一条 SSE `data:` 负载。无法识别或与文本增量无关的行返回 None。
fn parse_sse_data(data: &str, protocol: AiProtocol) -> Option<SseEvent> {
    if protocol == AiProtocol::OpenAi && data == "[DONE]" {
        return Some(SseEvent::Done);
    }
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    match protocol {
        AiProtocol::OpenAi => {
            let delta = value.pointer("/choices/0/delta")?;
            if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                if let Some(call) = calls.first() {
                    return Some(SseEvent::ToolRequest(
                        call.pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("未知工具")
                            .chars()
                            .take(80)
                            .collect(),
                    ));
                }
            }
            let content = delta
                .get("content")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let reasoning = delta
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    delta
                        .get("reasoning")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                });
            match (content, reasoning) {
                (Some(text), Some(reasoning)) => Some(SseEvent::DeltaWithReasoning {
                    text: text.into(),
                    reasoning: reasoning.into(),
                }),
                (Some(text), None) => Some(SseEvent::Delta(text.into())),
                (None, Some(reasoning)) => Some(SseEvent::Thinking(reasoning.into())),
                _ => None,
            }
        }
        AiProtocol::Anthropic => match value.get("type")?.as_str()? {
            "content_block_start"
                if value.pointer("/content_block/type")?.as_str()? == "tool_use" =>
            {
                Some(SseEvent::ToolRequest(
                    value
                        .pointer("/content_block/name")?
                        .as_str()?
                        .chars()
                        .take(80)
                        .collect(),
                ))
            }
            "content_block_delta" => {
                if value.pointer("/delta/type").and_then(|v| v.as_str()) == Some("thinking_delta") {
                    return Some(SseEvent::Thinking(
                        value.pointer("/delta/thinking")?.as_str()?.to_string(),
                    ));
                }
                Some(SseEvent::Delta(
                    value.pointer("/delta/text")?.as_str()?.to_string(),
                ))
            }
            "message_stop" => Some(SseEvent::Done),
            _ => None,
        },
    }
}

/// Keep UTF-8 bytes intact until a complete SSE line is available. An event may
/// contain several data lines; errors and incomplete streams must not look successful.
#[derive(Default)]
struct SseDecoder {
    bytes: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8], protocol: AiProtocol) -> Result<Vec<SseEvent>, String> {
        self.bytes.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(position) = self.bytes.iter().position(|byte| *byte == b'\n') {
            let line = std::str::from_utf8(&self.bytes[..position])
                .map_err(|_| "AI 服务返回了无效 UTF-8".to_string())?
                .trim_end_matches('\r')
                .to_string();
            self.bytes.drain(..=position);
            if line.is_empty() {
                if self.data.is_empty() {
                    continue;
                }
                let data = self.data.join("\n");
                self.data.clear();
                if data != "[DONE]" {
                    let value: serde_json::Value = serde_json::from_str(&data)
                        .map_err(|_| "AI 服务返回了无效流式数据".to_string())?;
                    if value.get("error").is_some()
                        || value.get("type").and_then(|v| v.as_str()) == Some("error")
                    {
                        return Err(status_error(500, &data));
                    }
                }
                if let Some(event) = parse_sse_data(&data, protocol) {
                    let done = matches!(event, SseEvent::Done);
                    events.push(event);
                    if done {
                        return Ok(events);
                    }
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
            if self.data.iter().map(String::len).sum::<usize>() > 131_072 {
                return Err("AI 流式数据过长".into());
            }
        }
        if self.bytes.len() > 131_072 {
            return Err("AI 流式数据过长".into());
        }
        Ok(events)
    }
}

/// 解析模型列表响应（OpenAI / Anthropic 均为 `data[].id`）。
pub fn parse_models(body: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .pointer("/data")
        .and_then(|data| data.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    model
                        .get("id")
                        .or_else(|| model.get("name"))
                        .and_then(|id| id.as_str())
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 解析 Ollama 原生 `/api/tags` 响应（`models[].name`）。
pub fn parse_ollama_tags(body: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .pointer("/models")
        .and_then(|models| models.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("name").and_then(|name| name.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 组装对话请求体；Anthropic 协议把 system 消息提取为顶层字段。
fn build_chat_body(protocol: AiProtocol, model: &str, messages: &[AiMessage]) -> serde_json::Value {
    match protocol {
        AiProtocol::OpenAi => serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
        }),
        AiProtocol::Anthropic => {
            let system = messages
                .iter()
                .rev()
                .find(|m| m.role == "system")
                .map(|m| m.content.clone());
            let turns: Vec<&AiMessage> = messages.iter().filter(|m| m.role != "system").collect();
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "stream": true,
                "messages": turns,
            });
            if let Some(system) = system {
                body["system"] = serde_json::json!(system);
            }
            body
        }
    }
}

fn chat_url(base_url: &str, protocol: AiProtocol) -> String {
    let base = base_url.trim().trim_end_matches('/');
    match protocol {
        AiProtocol::OpenAi => format!("{base}/chat/completions"),
        AiProtocol::Anthropic => format!("{base}/messages"),
    }
}

fn apply_auth(
    request: reqwest::RequestBuilder,
    protocol: AiProtocol,
    key: Option<&str>,
) -> reqwest::RequestBuilder {
    match (protocol, key) {
        (AiProtocol::OpenAi, Some(key)) => request.bearer_auth(key),
        (AiProtocol::Anthropic, Some(key)) => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        _ => request,
    }
}

/// 流式对话：逐段解析 SSE 并通过 Channel 推送，结束或出错时推送 done。
async fn chat(
    base_url: &str,
    model: &str,
    protocol: AiProtocol,
    messages: &[AiMessage],
    sink: &Channel<AiChunk>,
    key: Option<&str>,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        return Err("尚未配置 AI 服务地址（base_url）".to_string());
    }
    if model.trim().is_empty() {
        return Err("尚未选择模型".to_string());
    }
    ensure_tls_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHAT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败: {error}"))?;
    let request = apply_auth(
        client
            .post(chat_url(base_url, protocol))
            .json(&build_chat_body(protocol, model, messages)),
        protocol,
        key,
    );
    let response = request
        .send()
        .await
        .map_err(|error| format!("无法连接 AI 服务: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(status_error(status.as_u16(), &body));
    }

    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        return Err("AI 服务未返回 SSE 流，请检查地址与协议".into());
    }
    let mut decoder = SseDecoder::default();
    let mut response_size = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| format!("读取响应失败: {error}"))?;
        response_size += bytes.len();
        if response_size > 2_000_000 {
            return Err("AI 回复过长，请缩小问题范围".into());
        }
        for event in decoder.push(&bytes, protocol)? {
            match event {
                SseEvent::Delta(text) => sink
                    .send(AiChunk::delta(&text))
                    .map_err(|error| error.to_string())?,
                SseEvent::Thinking(text) => sink
                    .send(AiChunk::reasoning(&text))
                    .map_err(|error| error.to_string())?,
                SseEvent::DeltaWithReasoning { text, reasoning } => {
                    let mut chunk = AiChunk::delta(&text);
                    chunk.reasoning_delta = Some(reasoning);
                    sink.send(chunk).map_err(|error| error.to_string())?;
                }
                SseEvent::ToolRequest(name) => {
                    sink.send(AiChunk::activity("tool_request", Some(name)))
                        .map_err(|error| error.to_string())?;
                    return Err("模型请求了工具调用；当前助手尚未接入工具执行，请让模型直接给出排查说明或命令建议。工具未执行。".into());
                }
                SseEvent::Done => return Ok(()),
            }
        }
    }
    Err("AI 响应提前结束，请重试".into())
}

#[tauri::command]
pub async fn ai_chat(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, AiRequests>,
    request_id: String,
    base_url: String,
    model: String,
    protocol: String,
    messages: Vec<AiMessage>,
    channel: tauri::ipc::Channel<AiChunk>,
) -> Result<(), String> {
    let sink = Channel::from(channel);
    let protocol = match parse_protocol(&protocol) {
        Ok(protocol) => protocol,
        Err(error) => {
            let _ = sink.send(AiChunk::error(error));
            return Ok(());
        }
    };
    let base_url = normalize_base_url(&base_url)?;
    if messages.is_empty()
        || messages.len() > 32
        || messages
            .iter()
            .any(|message| !matches!(message.role.as_str(), "system" | "user" | "assistant"))
        || messages
            .iter()
            .map(|message| message.content.len())
            .sum::<usize>()
            > 300_000
    {
        return Err("AI 对话内容无效或过长，请开始新对话".into());
    }
    let (_registration, cancel) = requests.begin(window.label(), &request_id)?;
    sink.send(AiChunk {
        started: true,
        activity: None,
        tool_name: None,
        delta: None,
        reasoning_delta: None,
        error: None,
        done: false,
    })?;
    let key = read_api_key(&base_url, protocol)?;
    let result = cancellable(
        cancel,
        chat(
            &base_url,
            &model,
            protocol,
            &messages,
            &sink,
            key.as_deref(),
        ),
    )
    .await;
    match result {
        Ok(()) => {
            let _ = sink.send(AiChunk::done());
        }
        Err(error) => {
            let _ = sink.send(AiChunk::error(error));
        }
    }
    Ok(())
}

async fn cancellable(
    mut cancel: watch::Receiver<bool>,
    work: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    if *cancel.borrow() {
        return Err("请求已停止".into());
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("请求已停止".into()),
        result = work => result,
    }
}

#[tauri::command]
pub fn ai_cancel(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, AiRequests>,
    request_id: String,
) {
    requests.cancel(window.label(), &request_id);
}

#[tauri::command]
pub async fn ai_models(base_url: String, protocol: String) -> Result<Vec<String>, String> {
    if base_url.trim().is_empty() {
        return Err("尚未配置 AI 服务地址（base_url）".to_string());
    }
    let protocol = parse_protocol(&protocol)?;
    let normalized = normalize_base_url(&base_url)?;
    let base = normalized.as_str();
    let key = read_api_key(base, protocol)?;
    models(base, protocol, key.as_deref()).await
}

async fn models(
    base: &str,
    protocol: AiProtocol,
    key: Option<&str>,
) -> Result<Vec<String>, String> {
    ensure_tls_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(MODELS_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败: {error}"))?;

    let request = apply_auth(client.get(format!("{base}/models")), protocol, key);
    let response = request
        .send()
        .await
        .map_err(|error| format!("无法连接 AI 服务: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?;
    let ollama =
        protocol == AiProtocol::OpenAi && (status.as_u16() == 404 || status.as_u16() == 405);
    if !status.is_success() && !ollama {
        return Err(status_error(status.as_u16(), &body));
    }
    let models = parse_models(&body);
    if !models.is_empty() || protocol == AiProtocol::Anthropic {
        if models.is_empty() {
            return Err("未返回模型列表，请手动输入模型 ID".to_string());
        }
        return Ok(models);
    }

    // Ollama 等 OpenAI 兼容端点未实现 /models 时，回退到原生 /api/tags。
    let root = base.strip_suffix("/v1").unwrap_or(base);
    let fallback = apply_auth(client.get(format!("{root}/api/tags")), protocol, key);
    let response = fallback
        .send()
        .await
        .map_err(|error| format!("无法连接 AI 服务: {error}"))?;
    if !response.status().is_success() {
        return Err("该服务商不支持模型列表，请手动输入模型 ID".to_string());
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?;
    let models = parse_ollama_tags(&body);
    if models.is_empty() {
        return Err("未返回模型列表，请手动输入模型 ID".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn sse_preserves_split_utf8_crlf_multiple_data_lines_and_reports_errors() {
        let wire = "event: message\r\ndata: {\r\ndata: \"choices\":[{\"delta\":{\"content\":\"你好🌍\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
        for split in 0..wire.len() {
            let mut decoder = SseDecoder::default();
            let mut events = decoder
                .push(&wire.as_bytes()[..split], AiProtocol::OpenAi)
                .unwrap();
            events.extend(
                decoder
                    .push(&wire.as_bytes()[split..], AiProtocol::OpenAi)
                    .unwrap(),
            );
            assert!(matches!(&events[0], SseEvent::Delta(text) if text == "你好🌍"));
            assert!(matches!(events[1], SseEvent::Done));
        }
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(
                b"data: {\"type\":\"error\",\"error\":{\"message\":\"overloaded\"}}\n\n",
                AiProtocol::Anthropic
            )
            .unwrap_err()
            .contains("overloaded"));
        assert!(SseDecoder::default()
            .push(b"data: garbage\n\n", AiProtocol::OpenAi)
            .is_err());
        assert!(SseDecoder::default()
            .push(&vec![b'x'; 131_073], AiProtocol::OpenAi)
            .is_err());
    }

    #[test]
    fn detects_reasoning_and_tool_requests_without_treating_them_as_answers() {
        assert!(matches!(
            parse_sse_data(
                r#"{"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}"#,
                AiProtocol::OpenAi
            ),
            Some(SseEvent::Thinking(text)) if text == "private reasoning"
        ));
        assert!(matches!(
            parse_sse_data(
                r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}"#,
                AiProtocol::Anthropic
            ),
            Some(SseEvent::Thinking(text)) if text == "private reasoning"
        ));
        assert!(
            matches!(parse_sse_data(r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"read_file"}}]}}]}"#, AiProtocol::OpenAi), Some(SseEvent::ToolRequest(name)) if name == "read_file")
        );
        assert!(
            matches!(parse_sse_data(r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"read_file"}}"#, AiProtocol::Anthropic), Some(SseEvent::ToolRequest(name)) if name == "read_file")
        );
        let chunk = serde_json::to_value(AiChunk::activity("thinking", None)).unwrap();
        assert_eq!(chunk["activity"], "thinking");
        assert!(chunk.get("delta").is_none());
        let chunk = serde_json::to_value(AiChunk::reasoning("provider text")).unwrap();
        assert_eq!(chunk["reasoningDelta"], "provider text");
        assert!(chunk.get("delta").is_none());
    }

    #[test]
    fn reasoning_preserves_mixed_deltas_and_ignores_encrypted_thinking() {
        assert!(
            matches!(parse_sse_data(r#"{"choices":[{"delta":{"content":"answer","reasoning_content":"trace"}}]}"#, AiProtocol::OpenAi), Some(SseEvent::DeltaWithReasoning { text, reasoning }) if text == "answer" && reasoning == "trace")
        );
        assert!(
            matches!(parse_sse_data(r#"{"choices":[{"delta":{"reasoning_content":null,"reasoning":"trace"}}]}"#, AiProtocol::OpenAi), Some(SseEvent::Thinking(text)) if text == "trace")
        );
        for payload in [
            r#"{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"opaque"}}"#,
            r#"{"type":"content_block_start","content_block":{"type":"redacted_thinking","data":"opaque"}}"#,
        ] {
            assert!(parse_sse_data(payload, AiProtocol::Anthropic).is_none());
        }
    }

    #[test]
    fn scoped_keys_normalize_urls_and_do_not_reuse_other_providers() {
        let base = normalize_base_url(" HTTPS://EXAMPLE.COM:443/v1/ ").unwrap();
        assert_eq!(base, "https://example.com/v1");
        assert_eq!(
            credential_key(&base, AiProtocol::OpenAi),
            "ai:openai:https://example.com/v1"
        );
        assert_ne!(
            credential_key(&base, AiProtocol::OpenAi),
            credential_key(&base, AiProtocol::Anthropic)
        );
        for url in [
            "file:///tmp",
            "https://user:key@example.com",
            "https://example.com?key=secret",
            "https://example.com#key",
        ] {
            assert!(normalize_base_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn cancellation_is_window_scoped_handles_early_stop_and_cleans_up() {
        let requests = AiRequests::default();
        let (guard, receiver) = requests.begin("main", "first").unwrap();
        assert!(requests.begin("main", "first").is_err());
        requests.cancel("other", "first");
        assert!(!*receiver.borrow());
        requests.cancel("main", "first");
        let mut polled = false;
        let result = cancellable(receiver, async {
            polled = true;
            Ok(())
        })
        .await;
        assert!(result.unwrap_err().contains("停止"));
        assert!(!polled);
        drop(guard);
        assert!(requests.0.lock().unwrap().is_empty());
        let (_guard, receiver) = requests.begin("main", "next").unwrap();
        requests.cancel_window("main");
        assert!(*receiver.borrow());
    }

    #[tokio::test]
    async fn concurrent_conversations_cancel_independently() {
        let requests = AiRequests::default();
        let registrations: Vec<_> = (0..6)
            .map(|index| {
                requests
                    .begin("main", &format!("conversation-{index}"))
                    .unwrap()
            })
            .collect();
        let (_other_guard, other) = requests.begin("other", "conversation-0").unwrap();
        requests.cancel("main", "conversation-2");
        for (index, (_, receiver)) in registrations.iter().enumerate() {
            assert_eq!(*receiver.borrow(), index == 2);
        }
        assert!(!*other.borrow());
        drop(registrations);
        assert_eq!(requests.0.lock().unwrap().len(), 1);
        requests.cancel_window("other");
        assert!(*other.borrow());
    }

    async fn stream_server(
        wire: &'static str,
        protocol: AiProtocol,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let (path, auth) = match protocol {
                AiProtocol::OpenAi => ("POST /chat/completions", "authorization: bearer fixture"),
                AiProtocol::Anthropic => ("POST /messages", "x-api-key: fixture"),
            };
            assert!(request.starts_with(path));
            assert!(request.to_lowercase().contains(auth));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            for byte in wire.as_bytes() {
                if stream.write_all(&[*byte]).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        });
        (base, server)
    }

    #[tokio::test]
    async fn http_stream_delivers_unicode_and_rejects_truncated_response() {
        for (wire, successful) in [
            (
                "data: {\"choices\":[{\"delta\":{\"content\":\"中文🌍\"}}]}\n\ndata: [DONE]\n\n",
                true,
            ),
            (
                "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
                false,
            ),
        ] {
            let (base, server) = stream_server(wire, AiProtocol::OpenAi).await;
            let deltas = std::sync::Arc::new(Mutex::new(String::new()));
            let output = deltas.clone();
            let sink = Channel::new(move |chunk: AiChunk| {
                if let Some(text) = chunk.delta {
                    output.lock().unwrap().push_str(&text);
                }
                Ok(())
            });
            let result = chat(
                &base,
                "fixture",
                AiProtocol::OpenAi,
                &[],
                &sink,
                Some("fixture"),
            )
            .await;
            assert_eq!(result.is_ok(), successful);
            if successful {
                assert_eq!(*deltas.lock().unwrap(), "中文🌍");
            } else {
                assert!(result.unwrap_err().contains("提前结束"));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_stream_keeps_reasoning_separate_from_answers_for_both_protocols() {
        let openai = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考🌍\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"结\",\"reasoning\":\"继续\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"论\"}}]}\n\ndata: [DONE]\n\n",
        );
        let anthropic = concat!(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"思考🌍继续\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"signature_delta\",\"signature\":\"opaque\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"结论\"}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        for (protocol, wire) in [
            (AiProtocol::OpenAi, openai),
            (AiProtocol::Anthropic, anthropic),
        ] {
            let (base, server) = stream_server(wire, protocol).await;
            let captured = std::sync::Arc::new(Mutex::new((String::new(), String::new())));
            let output = captured.clone();
            let sink = Channel::new(move |chunk: AiChunk| {
                let mut text = output.lock().unwrap();
                if let Some(delta) = chunk.delta {
                    text.0.push_str(&delta);
                }
                if let Some(reasoning) = chunk.reasoning_delta {
                    text.1.push_str(&reasoning);
                }
                Ok(())
            });
            chat(&base, "fixture", protocol, &[], &sink, Some("fixture"))
                .await
                .unwrap();
            assert_eq!(
                *captured.lock().unwrap(),
                ("结论".into(), "思考🌍继续".into())
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_drops_stalled_http_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 8192];
            stream.read(&mut buffer).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            ready_tx.send(()).unwrap();
            // Read remaining request bytes, then observe the client closing TCP.
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
            }
        });
        let requests = AiRequests::default();
        let (_guard, receiver) = requests.begin("main", "stream").unwrap();
        let sink = Channel::new(|_: AiChunk| Ok(()));
        let cancel = async {
            ready_rx.await.unwrap();
            requests.cancel("main", "stream");
        };
        let work = cancellable(
            receiver,
            chat(&base, "fixture", AiProtocol::OpenAi, &[], &sink, None),
        );
        let (result, _) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(work, cancel) })
                .await
                .unwrap();
        assert!(result.unwrap_err().contains("停止"));
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn models_fall_back_after_404() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (path, status, body) in [
                ("/v1/models", "404 Not Found", "{}"),
                (
                    "/api/tags",
                    "200 OK",
                    "{\"models\":[{\"name\":\"local-model\"}]}",
                ),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&buffer[..count]).starts_with(&format!("GET {path} "))
                );
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        assert_eq!(
            models(&base, AiProtocol::OpenAi, None).await.unwrap(),
            vec!["local-model"]
        );
        server.await.unwrap();
    }

    fn openai_chunks() -> Vec<&'static str> {
        vec![
            r#"data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}"#,
            r#"data: {"choices":[{"delta":{"content":"你好"},"index":0}]}"#,
            r#"data: {"choices":[{"delta":{"content":"，世界"},"index":0}]}"#,
            "data: [DONE]",
        ]
    }

    #[test]
    fn parses_openai_stream_deltas_and_done() {
        let mut deltas = Vec::new();
        let mut done = false;
        for line in openai_chunks() {
            match parse_sse_data(line.strip_prefix("data: ").unwrap(), AiProtocol::OpenAi) {
                Some(SseEvent::Delta(text)) => deltas.push(text),
                Some(SseEvent::Done) => done = true,
                _ => {}
            }
        }
        assert_eq!(deltas, vec!["你好", "，世界"]);
        assert!(done);
    }

    #[test]
    fn parses_anthropic_stream_deltas_and_done() {
        let deltas: Vec<String> = [
            r#"{"type":"message_start","message":{}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ls"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" -la"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_stop"}"#,
        ]
        .iter()
        .filter_map(|data| match parse_sse_data(data, AiProtocol::Anthropic) {
            Some(SseEvent::Delta(text)) => Some(text),
            _ => None,
        })
        .collect();
        assert_eq!(deltas, vec!["ls", " -la"]);
        assert!(matches!(
            parse_sse_data(r#"{"type":"message_stop"}"#, AiProtocol::Anthropic),
            Some(SseEvent::Done)
        ));
    }

    #[test]
    fn ignores_unrelated_sse_events() {
        assert!(parse_sse_data(r#"{"type":"ping"}"#, AiProtocol::Anthropic).is_none());
        assert!(parse_sse_data(
            r#"{"choices":[{"delta":{},"index":0}]}"#,
            AiProtocol::OpenAi
        )
        .is_none());
        assert!(parse_sse_data("not json", AiProtocol::OpenAi).is_none());
    }

    #[test]
    fn parses_model_lists() {
        let openai =
            r#"{"object":"list","data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}"#;
        assert_eq!(
            parse_models(openai),
            vec!["deepseek-chat", "deepseek-reasoner"]
        );
        let anthropic = r#"{"data":[{"id":"claude-sonnet-4-5","display_name":"Claude"}]}"#;
        assert_eq!(parse_models(anthropic), vec!["claude-sonnet-4-5"]);
        assert!(parse_models("{}").is_empty());
        assert!(parse_models("not json").is_empty());
    }

    #[test]
    fn parses_ollama_tags() {
        let tags = r#"{"models":[{"name":"llama3:8b"},{"name":"qwen2.5:7b"}]}"#;
        assert_eq!(parse_ollama_tags(tags), vec!["llama3:8b", "qwen2.5:7b"]);
        assert!(parse_ollama_tags("{}").is_empty());
    }

    #[test]
    fn anthropic_body_extracts_system_message() {
        let messages = vec![
            AiMessage {
                role: "system".into(),
                content: "你是助手".into(),
            },
            AiMessage {
                role: "user".into(),
                content: "解释 ls".into(),
            },
        ];
        let body = build_chat_body(AiProtocol::Anthropic, "claude-x", &messages);
        assert_eq!(body["system"], "你是助手");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn openai_body_keeps_all_messages() {
        let messages = vec![
            AiMessage {
                role: "system".into(),
                content: "你是助手".into(),
            },
            AiMessage {
                role: "user".into(),
                content: "解释 ls".into(),
            },
        ];
        let body = build_chat_body(AiProtocol::OpenAi, "gpt-x", &messages);
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert!(body.get("system").is_none());
        assert_eq!(body["model"], "gpt-x");
    }

    #[test]
    fn maps_status_errors_to_chinese_hints() {
        assert!(status_error(401, "unauthorized").contains("API key 无效"));
        assert!(status_error(429, "slow down").contains("限流"));
        assert!(status_error(404, "no route").contains("base_url"));
        let detailed = status_error(500, r#"{"error":{"message":"boom"}}"#);
        assert!(detailed.contains("boom"));
        let plain = status_error(500, "server exploded");
        assert!(plain.contains("server exploded"));
    }

    #[test]
    fn protocol_parsing_rejects_unknown_values() {
        assert_eq!(parse_protocol("openai").unwrap(), AiProtocol::OpenAi);
        assert_eq!(parse_protocol("anthropic").unwrap(), AiProtocol::Anthropic);
        assert!(parse_protocol("gemini").is_err());
    }
}
