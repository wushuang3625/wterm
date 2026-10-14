//! Local AI transcripts. Each snapshot is committed atomically; revisions prevent
//! an older window from overwriting a transcript edited by another window.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target_key: String,
    #[serde(default)]
    pub saved: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning: String,
    pub status: String,
    pub created_at: i64,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversation {
    pub id: String,
    pub connection: AiConnection,
    pub title: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: i64,
    pub revision: i64,
    pub messages: Vec<AiMessage>,
    #[serde(default)]
    pub draft: String,
    #[serde(default)]
    pub selection: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub connection: AiConnection,
    pub title: String,
    pub pinned: bool,
    pub updated_at: i64,
    pub last_opened_at: i64,
    pub preview: String,
}

#[derive(Serialize)]
pub struct HistoryPage {
    pub items: Vec<ConversationSummary>,
    pub total: i64,
}

pub struct HistoryDb {
    db: Connection,
}

impl HistoryDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        Self::initialize(db)
    }

    fn initialize(mut db: Connection) -> Result<Self, String> {
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > 2 {
            return Err("AI 历史数据库来自较新版本，请使用更新后的 wterm".into());
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, title TEXT NOT NULL,
              pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              last_opened_at INTEGER NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
              connection_data TEXT NOT NULL, preview TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS history_recent ON conversations(pinned DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS history_connection ON conversations(connection_id, last_opened_at DESC);
            ").map_err(|e| e.to_string())?;
        if version == 1 {
            let transaction = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            transaction.execute_batch("ALTER TABLE conversations ADD COLUMN connection_data TEXT NOT NULL DEFAULT '{}'; ALTER TABLE conversations ADD COLUMN preview TEXT NOT NULL DEFAULT '';").map_err(|e| e.to_string())?;
            let mut statement = transaction
                .prepare("SELECT data FROM conversations")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for raw in rows {
                let conversation: AiConversation =
                    serde_json::from_str(&raw.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                transaction
                    .execute(
                        "UPDATE conversations SET connection_data=?1,preview=?2 WHERE id=?3",
                        params![
                            serde_json::to_string(&conversation.connection)
                                .map_err(|e| e.to_string())?,
                            preview_text(&conversation),
                            conversation.id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
            }
            drop(statement);
            transaction
                .pragma_update(None, "user_version", 2)
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        db.pragma_update(None, "user_version", 2)
            .map_err(|e| e.to_string())?;
        Ok(Self { db })
    }

    pub fn get(&self, id: &str) -> Result<Option<AiConversation>, String> {
        let raw: Option<(String, i64)> = self
            .db
            .query_row(
                "SELECT data,last_opened_at FROM conversations WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|(data, last_opened)| {
            let mut conversation: AiConversation =
                serde_json::from_str(&data).map_err(|e| e.to_string())?;
            conversation.last_opened_at = last_opened;
            Ok(conversation)
        })
        .transpose()
    }

    fn mark_opened(&self, id: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE conversations SET last_opened_at=MAX(last_opened_at,?1) WHERE id=?2",
                params![now_ms(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn recent(
        &self,
        connection_id: &str,
        target_key: &str,
    ) -> Result<Option<AiConversation>, String> {
        let id: Option<String> = self.db.query_row("SELECT id FROM conversations WHERE connection_id=?1 AND json_extract(connection_data,'$.targetKey')=?2 ORDER BY last_opened_at DESC, updated_at DESC LIMIT 1", params![connection_id, target_key], |row| row.get(0))
            .optional().map_err(|e| e.to_string())?;
        match id {
            Some(id) => self.get(&id),
            None => Ok(None),
        }
    }

    pub fn list(&self, search: &str, offset: u32) -> Result<HistoryPage, String> {
        let search: String = search.chars().take(200).collect();
        let total = self.db.query_row("SELECT count(*) FROM conversations WHERE ?1='' OR instr(lower(title),lower(?1))>0 OR instr(lower(data),lower(?1))>0", [&search], |row| row.get(0)).map_err(|e| e.to_string())?;
        let mut statement = self.db.prepare("SELECT id,connection_data,title,pinned,updated_at,last_opened_at,preview FROM conversations WHERE ?1='' OR instr(lower(title),lower(?1))>0 OR instr(lower(data),lower(?1))>0 ORDER BY pinned DESC, updated_at DESC, id LIMIT 100 OFFSET ?2").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![search, offset], |row| {
                let connection: String = row.get(1)?;
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    connection: serde_json::from_str(&connection).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    title: row.get(2)?,
                    pinned: row.get(3)?,
                    updated_at: row.get(4)?,
                    last_opened_at: row.get(5)?,
                    preview: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(HistoryPage { items, total })
    }

    pub fn save(&mut self, mut conversation: AiConversation) -> Result<i64, String> {
        if uuid::Uuid::parse_str(&conversation.id).is_err()
            || conversation.connection.id.is_empty()
            || conversation.title.chars().count() > 120
            || conversation.messages.len() > 10_000
            || conversation.draft.chars().count() > 16_000
            || conversation.selection.chars().count() > 6_000
        {
            return Err("AI 会话记录无效或过长".into());
        }
        let mut message_ids = std::collections::HashSet::new();
        for message in &conversation.messages {
            if !message_ids.insert(&message.id)
                || !["user", "assistant"].contains(&message.role.as_str())
                || !["complete", "generating", "interrupted", "error"]
                    .contains(&message.status.as_str())
                || message.content.chars().count() + message.reasoning.chars().count() > 100_000
                || message.context.chars().count() > 6_000
            {
                return Err("AI 消息记录无效或过长".into());
            }
        }
        let expected = conversation.revision;
        conversation.revision += 1;
        let data = serde_json::to_string(&conversation).map_err(|e| e.to_string())?;
        if data.len() > 16 * 1024 * 1024 {
            return Err("该会话内容过多，请新建会话继续".into());
        }
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let previous: Option<(i64, String)> = transaction
            .query_row(
                "SELECT revision,connection_id FROM conversations WHERE id=?1",
                [&conversation.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let revision = previous.as_ref().map(|value| value.0);
        if revision.unwrap_or(0) != expected || (revision.is_none() && expected != 0) {
            return Err("该会话已在其他窗口更新或删除，本次更改未保存；当前内容仍保留在此窗口，可复制后新建会话继续".into());
        }
        if previous.is_some_and(|value| value.1 != conversation.connection.id) {
            return Err("已保存会话的连接归属不能改变".into());
        }
        transaction.execute("INSERT INTO conversations(id,connection_id,title,pinned,updated_at,last_opened_at,revision,data,connection_data,preview)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,pinned=excluded.pinned,updated_at=excluded.updated_at,last_opened_at=MAX(conversations.last_opened_at,excluded.last_opened_at),revision=excluded.revision,data=excluded.data,connection_data=excluded.connection_data,preview=excluded.preview",
            params![conversation.id, conversation.connection.id, conversation.title, conversation.pinned,
                conversation.updated_at, conversation.last_opened_at, conversation.revision, data,
                serde_json::to_string(&conversation.connection).map_err(|e| e.to_string())?, preview_text(&conversation)]).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(conversation.revision)
    }

    pub fn delete(&mut self, id: &str, revision: i64) -> Result<(), String> {
        let changed = self
            .db
            .execute(
                "DELETE FROM conversations WHERE id=?1 AND revision=?2",
                params![id, revision],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 && self.get(id)?.is_some() {
            return Err("该会话已在其他窗口更新，请重新打开后再删除".into());
        }
        Ok(())
    }

    fn recover_interrupted(&mut self) -> Result<(), String> {
        let mut statement = self
            .db
            .prepare("SELECT data FROM conversations WHERE instr(data,'\"generating\"')>0")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut conversations = Vec::new();
        for raw in rows {
            conversations.push(
                serde_json::from_str::<AiConversation>(&raw.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        drop(statement);
        for mut conversation in conversations {
            // A different application process may still be writing this thread.
            // Fresh partial responses remain readable without changing its revision.
            if now_ms().saturating_sub(conversation.updated_at) < 600_000 {
                continue;
            }
            let mut changed = false;
            for message in &mut conversation.messages {
                if message.status == "generating" {
                    message.status = "interrupted".into();
                    changed = true;
                }
            }
            if changed {
                self.save(conversation)?;
            }
        }
        Ok(())
    }
}

fn preview_text(conversation: &AiConversation) -> String {
    conversation
        .messages
        .iter()
        .rev()
        .find(|message| !message.content.is_empty())
        .map(|message| message.content.chars().take(100).collect())
        .unwrap_or_default()
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

static HISTORY: OnceLock<Mutex<Option<HistoryDb>>> = OnceLock::new();
fn with_history<T>(work: impl FnOnce(&mut HistoryDb) -> Result<T, String>) -> Result<T, String> {
    let mut history = HISTORY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if history.is_none() {
        let path = dirs::config_dir()
            .ok_or("无法找到应用数据目录")?
            .join("wterm")
            .join("ai-history.sqlite3");
        let mut database = HistoryDb::open(&path)?;
        database.recover_interrupted()?;
        *history = Some(database);
    }
    work(history.as_mut().expect("initialized above"))
}

#[tauri::command]
pub async fn ai_history_list(search: String, offset: u32) -> Result<HistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || with_history(|db| db.list(&search, offset)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn ai_history_get(id: String) -> Result<Option<AiConversation>, String> {
    tauri::async_runtime::spawn_blocking(move || with_history(|db| db.get(&id)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn ai_history_recent(
    connection_id: String,
    target_key: String,
) -> Result<Option<AiConversation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_history(|db| db.recent(&connection_id, &target_key))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn ai_history_save(conversation: AiConversation) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || with_history(|db| db.save(conversation)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn ai_history_delete(id: String, revision: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_history(|db| db.delete(&id, revision)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn ai_history_open(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_history(|db| db.mark_opened(&id)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn conversation() -> AiConversation {
        AiConversation {
            id: uuid::Uuid::new_v4().to_string(),
            connection: AiConnection {
                id: "ssh:stable".into(),
                name: "服务器".into(),
                kind: "ssh".into(),
                target_key: "root@host".into(),
                saved: true,
            },
            title: "排查磁盘".into(),
            pinned: false,
            created_at: 1,
            updated_at: 2,
            last_opened_at: 3,
            revision: 0,
            draft: "未发送问题".into(),
            selection: "选中上下文".into(),
            model: "model".into(),
            messages: vec![AiMessage {
                id: "message".into(),
                role: "assistant".into(),
                content: "半段中文回复".into(),
                reasoning: "先检查磁盘空间与挂载点".into(),
                status: "generating".into(),
                created_at: 1,
                context: "".into(),
                action: "chat".into(),
                model: "model".into(),
                provider: "provider".into(),
                error: "".into(),
            }],
        }
    }
    #[test]
    fn survives_reopening_and_recovers_partial_responses() {
        let path =
            std::env::temp_dir().join(format!("wterm-history-{}.sqlite3", uuid::Uuid::new_v4()));
        let mut history = HistoryDb::open(&path).unwrap();
        let mut value = conversation();
        value.revision = history.save(value.clone()).unwrap();
        drop(history);
        let mut history = HistoryDb::open(&path).unwrap();
        history.recover_interrupted().unwrap();
        let restored = history.get(&value.id).unwrap().unwrap();
        assert_eq!(restored.draft, "未发送问题");
        assert_eq!(restored.selection, "选中上下文");
        assert_eq!(restored.messages[0].content, "半段中文回复");
        assert_eq!(restored.messages[0].reasoning, "先检查磁盘空间与挂载点");
        assert_eq!(restored.messages[0].status, "interrupted");
        assert!(history.save(value).is_err());
        drop(history);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn old_messages_without_reasoning_remain_readable_and_oversized_reasoning_is_rejected() {
        let mut raw = serde_json::to_value(conversation()).unwrap();
        raw["messages"][0]
            .as_object_mut()
            .unwrap()
            .remove("reasoning");
        let mut legacy: AiConversation = serde_json::from_value(raw).unwrap();
        assert!(legacy.messages[0].reasoning.is_empty());
        let mut history = HistoryDb {
            db: Connection::open_in_memory().unwrap(),
        };
        // Validation runs before storage, so an oversized snapshot cannot be committed.
        legacy.messages[0].reasoning = "x".repeat(100_000);
        assert!(history
            .save(legacy)
            .unwrap_err()
            .contains("消息记录无效或过长"));
    }
    #[test]
    fn pagination_search_pinning_and_stale_delete() {
        let mut history = HistoryDb::initialize(Connection::open_in_memory().unwrap()).unwrap();
        let mut value = conversation();
        value.revision = history.save(value.clone()).unwrap();
        let mut pinned = conversation();
        pinned.title = "置顶".into();
        pinned.pinned = true;
        history.save(pinned.clone()).unwrap();
        assert_eq!(history.list("", 0).unwrap().items[0].id, pinned.id);
        assert_eq!(history.list("半段中文", 0).unwrap().total, 2);
        assert_eq!(history.list("排查", 0).unwrap().total, 1);
        assert!(history.list("", 100).unwrap().items.is_empty());
        assert!(history.delete(&value.id, 0).is_err());
        history.delete(&value.id, value.revision).unwrap();
        assert!(history.get(&value.id).unwrap().is_none());
        assert!(
            history.save(value).is_err(),
            "a late save must not resurrect a deleted transcript"
        );
    }
    #[test]
    fn opening_recent_live_history_does_not_conflict_with_its_writer() {
        let mut history = HistoryDb::initialize(Connection::open_in_memory().unwrap()).unwrap();
        let mut value = conversation();
        value.updated_at = now_ms();
        value.revision = history.save(value.clone()).unwrap();
        history.recover_interrupted().unwrap();
        history.mark_opened(&value.id).unwrap();
        assert_eq!(
            history.get(&value.id).unwrap().unwrap().revision,
            value.revision
        );
        value.messages[0].content.push_str("继续生成");
        assert!(history.save(value).is_ok());
    }
    #[test]
    fn old_schema_migrates_without_replacing_transcripts() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE conversations(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,title TEXT NOT NULL,pinned INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_opened_at INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL); PRAGMA user_version=1;").unwrap();
        let value = conversation();
        db.execute(
            "INSERT INTO conversations VALUES(?1,?2,?3,0,2,3,0,?4)",
            params![
                value.id,
                value.connection.id,
                value.title,
                serde_json::to_string(&value).unwrap()
            ],
        )
        .unwrap();
        let history = HistoryDb::initialize(db).unwrap();
        assert_eq!(
            history.list("", 0).unwrap().items[0].preview,
            "半段中文回复"
        );
        assert_eq!(history.get(&value.id).unwrap().unwrap().messages.len(), 1);
    }
    #[test]
    fn listing_paginates_without_duplicating_or_omitting_records() {
        let mut history = HistoryDb::initialize(Connection::open_in_memory().unwrap()).unwrap();
        for _ in 0..105 {
            history.save(conversation()).unwrap();
        }
        let first = history.list("", 0).unwrap();
        let second = history.list("", 100).unwrap();
        assert_eq!(first.total, 105);
        assert_eq!(first.items.len(), 100);
        assert_eq!(second.items.len(), 5);
        let unique: std::collections::HashSet<_> = first
            .items
            .iter()
            .chain(second.items.iter())
            .map(|item| &item.id)
            .collect();
        assert_eq!(unique.len(), 105);
    }
    #[test]
    fn changed_host_has_its_own_recent_thread_inside_the_same_group() {
        let mut history = HistoryDb::initialize(Connection::open_in_memory().unwrap()).unwrap();
        let old = conversation();
        history.save(old.clone()).unwrap();
        let mut new = conversation();
        new.connection.target_key = "root@new-host".into();
        new.last_opened_at = 99;
        history.save(new.clone()).unwrap();
        assert_eq!(
            history
                .recent(&old.connection.id, &old.connection.target_key)
                .unwrap()
                .unwrap()
                .id,
            old.id
        );
        assert_eq!(
            history
                .recent(&new.connection.id, &new.connection.target_key)
                .unwrap()
                .unwrap()
                .id,
            new.id
        );
    }
}
