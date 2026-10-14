import { invoke } from '@tauri-apps/api/core';
import type { SshProfile } from './main';

export interface AiConnection { id: string; name: string; kind: 'local' | 'ssh' | 'general'; targetKey: string; saved: boolean }
export interface AiMessage {
  id: string; role: 'user' | 'assistant'; content: string; reasoning?: string;
  status: 'complete' | 'generating' | 'interrupted' | 'error'; createdAt: number;
  context: string; action: string; model: string; provider: string; error: string;
}
export interface AiConversation {
  id: string; connection: AiConnection; title: string; pinned: boolean;
  createdAt: number; updatedAt: number; lastOpenedAt: number; revision: number;
  messages: AiMessage[]; draft: string; selection: string; model: string;
}
export interface ConversationSummary {
  id: string; connection: AiConnection; title: string; pinned: boolean;
  updatedAt: number; lastOpenedAt: number; preview: string;
}
export interface HistoryPage { items: ConversationSummary[]; total: number }

export function connectionForProfile(profile?: SshProfile | null, local = false): AiConnection {
  if (!profile) return { id: local ? 'local' : 'general', name: local ? '本地终端' : '通用会话', kind: local ? 'local' : 'general', targetKey: local ? 'local' : '', saved: false };
  const host = profile.host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const targetKey = JSON.stringify([host, profile.port, profile.username, profile.proxy_jump?.trim() || '']);
  return { id: profile.id ? 'ssh:' + profile.id : 'ssh:temporary:' + targetKey, name: profile.name,
    kind: 'ssh', targetKey, saved: !!profile.id };
}

export function newConversation(connection: AiConnection): AiConversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), connection: { ...connection }, title: '新会话', pinned: false,
    createdAt: now, updatedAt: now, lastOpenedAt: now, revision: 0, messages: [], draft: '', selection: '', model: '' };
}

/** Keep full transcripts; only successful, complete turns enter model context. */
export function completedTurns(conversation: AiConversation): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let user: AiMessage | undefined;
  for (const message of conversation.messages) {
    if (message.role === 'user') { user = message; continue; }
    if (user && message.status === 'complete' && message.content) {
      turns.push({ role: 'user', content: [user.content, user.context].filter(Boolean).join('\n\n') },
        { role: 'assistant', content: message.content });
    }
    user = undefined;
  }
  return turns;
}

export function conversationSummary(conversation: AiConversation): ConversationSummary {
  return { id: conversation.id, connection: conversation.connection, title: conversation.title,
    pinned: conversation.pinned, updatedAt: conversation.updatedAt, lastOpenedAt: conversation.lastOpenedAt,
    preview: [...conversation.messages].reverse().find(message => !!message.content)?.content.slice(0, 100) ?? '' };
}

/** A serialized writer always snapshots the newest data and retains failed saves
 * in memory. The revision returned by one write is used by the next write. */
export class AiHistoryStore {
  readonly cache = new Map<string, AiConversation>();
  readonly index = new Map<string, ConversationSummary>();
  readonly lastByConnection = new Map<string, AiConversation>();
  private dirty = new Set<string>();
  private failed = new Set<string>();
  private writing: string | undefined;
  private timer: number | undefined;
  private queue: Promise<void> | undefined;
  private loads = new Map<string, Promise<AiConversation | null>>();

  constructor(private onChange: () => void, private onError: (error: unknown) => void) {}

  create(connection: AiConnection): AiConversation {
    const conversation = newConversation(connection);
    this.cache.set(conversation.id, conversation);
    this.lastByConnection.set(connection.id, conversation);
    return conversation;
  }

  touch(conversation: AiConversation): void {
    this.cache.set(conversation.id, conversation);
    // Empty new conversations stay out of the history list.
    if (!conversation.messages.length) return;
    this.index.set(conversation.id, conversationSummary(conversation));
    this.dirty.add(conversation.id);
    if (this.timer === undefined) this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, 400);
    this.onChange();
  }

  async list(search: string, offset = 0): Promise<HistoryPage> {
    await this.flush();
    const page = await invoke<HistoryPage>('ai_history_list', { search, offset });
    for (const item of page.items) this.index.set(item.id, item);
    return page;
  }

  async get(id: string, fresh = false): Promise<AiConversation | null> {
    const cached = this.cache.get(id);
    if (cached && (!fresh || this.dirty.has(id) || this.writing === id || this.failed.has(id))) return cached;
    const loading = this.loads.get(id);
    if (loading) return loading;
    const request = invoke<AiConversation | null>('ai_history_get', { id }).then(conversation => {
      if (this.dirty.has(id) || this.writing === id || this.failed.has(id)) return this.cache.get(id) ?? conversation;
      if (conversation) { this.cache.set(id, conversation); this.index.set(id, conversationSummary(conversation)); }
      return conversation;
    }).finally(() => this.loads.delete(id));
    this.loads.set(id, request);
    return request;
  }

  async recent(connection: AiConnection): Promise<AiConversation> {
    const local = this.lastByConnection.get(connection.id);
    if (local?.connection.targetKey === connection.targetKey) return local;
    const matching = [...this.cache.values()].filter(value => value.connection.id === connection.id && value.connection.targetKey === connection.targetKey)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    if (matching) { this.lastByConnection.set(connection.id, matching); return matching; }
    const saved = await invoke<AiConversation | null>('ai_history_recent', { connectionId: connection.id, targetKey: connection.targetKey });
    const conversation = saved || this.create(connection);
    this.cache.set(conversation.id, conversation);
    this.lastByConnection.set(connection.id, conversation);
    if (saved) this.index.set(saved.id, conversationSummary(saved));
    return conversation;
  }

  markOpened(conversation: AiConversation): void {
    conversation.lastOpenedAt = Date.now();
    this.lastByConnection.set(conversation.connection.id, conversation);
    if (conversation.revision > 0) void invoke('ai_history_open', { id: conversation.id }).catch(error => this.onError(error));
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.queue) { await this.queue; if (this.dirty.size) await this.flush(); return; }
    this.queue = this.drain();
    try { await this.queue; } finally { this.queue = undefined; }
  }

  private async drain(): Promise<void> {
    while (this.dirty.size) {
      const id = this.dirty.values().next().value!;
      this.dirty.delete(id);
      if (this.failed.has(id)) continue;
      const conversation = this.cache.get(id);
      if (!conversation) continue;
      this.writing = id;
      try {
        const revision = await invoke<number>('ai_history_save', { conversation: structuredClone(conversation) });
        conversation.revision = revision;
      } catch (error) { this.failed.add(id); this.onError(error); }
      finally { this.writing = undefined; }
    }
  }

  retry(): void {
    for (const id of this.failed) this.dirty.add(id);
    this.failed.clear();
    void this.flush();
  }

  hasFailedWrites(): boolean { return this.failed.size > 0; }

  async delete(conversation: AiConversation): Promise<void> {
    await this.flush();
    await invoke('ai_history_delete', { id: conversation.id, revision: conversation.revision });
    this.dirty.delete(conversation.id); this.failed.delete(conversation.id);
    this.cache.delete(conversation.id); this.index.delete(conversation.id);
    if (this.lastByConnection.get(conversation.connection.id)?.id === conversation.id) this.lastByConnection.delete(conversation.connection.id);
    this.onChange();
  }
}
