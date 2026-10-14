import { Channel, invoke } from '@tauri-apps/api/core';
import { AiWindow } from './ai-window';
import { aiAutoDiagnose, aiConfig, aiReady, setAiActiveModel } from './ai-config';
import { buildMessages, canInsertCommand, diagnosticContext, renderMarkdownLite, type AiAction, type ChatRole, type FailedCommand } from './ai-helpers';
import { AiHistoryStore, completedTurns, type AiConnection, type AiConversation, type AiMessage } from './ai-history';
import { AiHistoryView } from './ai-history-view';
import { configStorage } from './config-storage';
import { aiIcon } from './ai-icons';
import { selectionDraft, type AiSelectionAction } from './ai-selection';

export interface AiPanelDeps {
  getSessionId: () => string | null;
  getConnection: () => AiConnection;
  getKnownConnections: () => Promise<AiConnection[]>;
  getSelection: () => string;
  insertIntoTerminal: (text: string) => Promise<void>;
  canInsert?: () => boolean;
  focusTerminal?: () => void;
  activateSession?: (sid: string) => boolean;
  openSettings: () => void;
}
interface AiChunk { started?: boolean; activity?: 'thinking' | 'tool_request'; toolName?: string; delta?: string; reasoningDelta?: string; error?: string; done: boolean }
interface RunningRequest { id: string; conversation: AiConversation; message: AiMessage; startedAt: number; phase: string }

export class AiPanel {
  private panel: HTMLElement;
  private windowLayout: AiWindow;
  private historyView: AiHistoryView;
  private store: AiHistoryStore;
  private conversation: AiConversation;
  private preview: AiConversation | null = null;
  private knownConnections = new Map<string, AiConnection>();
  private listedIds: string[] = [];
  private total = 0;
  private search = '';
  private searchTimer: number | undefined;
  private listEpoch = 0;
  private selectionEpoch = 0;
  private loaded = false;
  private changing = false;
  private disposed = false;
  private ready: Promise<void>;
  private sessionId: string | null;
  private running = new Map<string, RunningRequest>();
  private insertFeedback = new Map<string, { text: string; error: boolean; pending: boolean }>();
  private reasoningViews = new Map<string, { open: boolean; scrollTop: number }>();
  private reasoningText = new WeakMap<HTMLElement, string>();
  private lastDiagnosticAt = 0;
  private activityTimer: number | undefined;
  private activity: HTMLElement;
  private activityLabel: HTMLElement;
  private activityTime: HTMLElement;
  private modelSelect: HTMLSelectElement;
  private messagesEl: HTMLElement;
  private contextEl: HTMLElement;
  private contextLabel: HTMLElement;
  private quickRow: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private historyButton: HTMLButtonElement;
  private titleEl: HTMLElement;
  private connectionEl: HTMLElement;
  private phaseEl: HTMLElement;
  private returnButton: HTMLButtonElement;
  private errorEl: HTMLElement;
  private readonly onConfigChange = () => { this.refreshModelSelect(); this.renderConversation(); };
  private readonly onConnectionsChange = () => void this.refreshConnections().catch(error => this.historyError(error));

  constructor(private container: HTMLElement, private deps: AiPanelDeps) {
    this.sessionId = deps.getSessionId();
    this.store = new AiHistoryStore(() => this.renderHistory(), error => this.historyError(error));
    this.conversation = this.store.create(deps.getConnection());
    this.panel = document.createElement('aside');
    this.panel.className = 'ai-panel'; this.panel.setAttribute('aria-label', 'AI 助手');
    this.panel.innerHTML = `<header class="ai-header"><strong class="ai-title">AI 助手</strong>
      <button class="st ai-icon ai-history-toggle" type="button" aria-label="收起历史会话" aria-pressed="true">${aiIcon('sidebar')}</button>
      <button class="st ai-icon ai-mode" type="button" aria-label="停靠上方">${aiIcon('dock')}</button><select class="ai-model-select" aria-label="选择模型"></select>
      <button class="st ai-icon ai-side" type="button" aria-label="移到左侧" title="移到左侧">${aiIcon('left')}</button>
      <button class="st ai-icon ai-new" type="button" aria-label="新对话" title="新对话">${aiIcon('new')}</button>
      <button class="st ai-icon ai-close" type="button" aria-label="关闭 AI 助手" title="关闭 AI 助手">${aiIcon('close')}</button></header>
      <div class="ai-workspace"><section class="ai-chat" aria-label="会话内容">
        <header class="ai-conversation-header"><div class="ai-conversation-heading"><strong class="ai-conversation-title"></strong>
          <div class="ai-conversation-meta"><span class="ai-conversation-connection"></span><span class="ai-conversation-phase"></span></div></div>
          <button class="st ai-icon ai-return" type="button" aria-label="返回当前会话" title="返回当前会话" hidden>${aiIcon('back')}</button></header>
        <div class="ai-messages" role="log" aria-live="polite"></div>
        <div class="ai-context" hidden><span class="ai-context-label"></span><button class="ai-context-remove st" type="button">移除</button></div>
        <div class="ai-quick" hidden><button class="st ai-quick-explain" type="button">解释选中</button><button class="st ai-quick-summarize" type="button">总结选中</button></div>
        <div class="ai-activity" role="status" hidden><span class="ai-spinner" aria-hidden="true"></span><span class="ai-activity-label"></span><span class="ai-activity-time"></span></div>
        <div class="ai-composer"><textarea class="ai-input" rows="2" spellcheck="false" aria-label="输入 AI 问题" placeholder="输入问题，或描述想让命令完成的操作"></textarea>
          <div class="ai-composer-actions"><span class="ai-privacy" title="发送输入、显式附带的上下文及有限对话历史">直连所选服务商</span><button class="btn primary ai-send" type="button">发送</button><button class="btn ai-stop" type="button" hidden>停止</button></div></div>
      </section></div><div class="ai-history-error" role="alert" hidden><span></span><button class="st" type="button">重试保存</button></div>`;
    const query = <T extends HTMLElement>(selector: string) => this.panel.querySelector<T>(selector)!;
    this.activity = query('.ai-activity'); this.activityLabel = query('.ai-activity-label'); this.activityTime = query('.ai-activity-time');
    this.modelSelect = query('.ai-model-select'); this.messagesEl = query('.ai-messages');
    this.contextEl = query('.ai-context'); this.contextLabel = query('.ai-context-label'); this.quickRow = query('.ai-quick');
    this.input = query('.ai-input'); this.sendButton = query('.ai-send'); this.stopButton = query('.ai-stop');
    this.historyButton = query('.ai-history-toggle'); this.titleEl = query('.ai-conversation-title');
    this.connectionEl = query('.ai-conversation-connection'); this.phaseEl = query('.ai-conversation-phase');
    this.returnButton = query('.ai-return'); this.errorEl = query('.ai-history-error');
    this.historyView = new AiHistoryView({ preview: id => void this.selectConversation(id, false), activate: id => void this.selectConversation(id, true),
      search: text => this.searchHistory(text), more: () => void this.loadHistory(true),
      rename: id => void this.renameConversation(id), pin: id => void this.pinConversation(id), delete: id => void this.deleteConversation(id) });
    query('.ai-workspace').prepend(this.historyView.element);
    container.append(this.panel);
    this.windowLayout = new AiWindow(this.panel, container);
    const historyOpen = configStorage.getItem('wterm_ai_history_open') !== 'false';
    this.toggleHistory(historyOpen);
    this.historyButton.onclick = () => { this.toggleHistory(!this.panel.classList.contains('ai-history-open')); this.windowLayout.layout(); };
    query<HTMLButtonElement>('.ai-close').onclick = () => this.close();
    query<HTMLButtonElement>('.ai-new').onclick = () => this.newChat();
    this.sendButton.onclick = () => void this.send('chat', this.input.value.trim()); this.stopButton.onclick = () => this.stop();
    this.modelSelect.onchange = () => { setAiActiveModel(this.modelSelect.value); this.conversation.model = this.modelSelect.value; this.store.touch(this.conversation); };
    this.input.oninput = () => this.saveDraft();
    this.input.onfocus = () => this.activatePreview();
    this.input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send('chat', this.input.value.trim()); } };
    query<HTMLButtonElement>('.ai-quick-explain').onclick = () => void this.send('explain', this.input.value.trim());
    query<HTMLButtonElement>('.ai-quick-summarize').onclick = () => void this.send('summarize', this.input.value.trim());
    query<HTMLButtonElement>('.ai-context-remove').onclick = () => this.setSelection('');
    this.returnButton.onclick = () => { this.preview = null; ++this.selectionEpoch; this.changing = false; this.renderConversation(); };
    this.errorEl.querySelector<HTMLButtonElement>('button')!.onclick = () => { this.errorEl.hidden = true; this.store.retry(); void this.loadHistory(); };
    this.panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); this.close(); } });
    window.addEventListener('wterm-ai-config-change', this.onConfigChange);
    window.addEventListener('wterm-connections-change', this.onConnectionsChange);
    this.refreshModelSelect(); this.renderConversation();
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const results = await Promise.allSettled([this.refreshConnections(), this.loadHistory()]);
    for (const result of results) if (result.status === 'rejected') this.historyError(result.reason);
    this.loaded = true;
    await this.restoreConnection();
  }

  private currentConnection(): AiConnection {
    const current = this.deps.getConnection();
    // Old workspace snapshots predate stable profile IDs.
    if (current.kind === 'ssh' && !current.saved) {
      const known = [...this.knownConnections.values()].find(item => item.name === current.name && item.targetKey === current.targetKey);
      if (known) return known;
    }
    return this.knownConnections.get(current.id)?.targetKey === current.targetKey ? this.knownConnections.get(current.id)! : current;
  }

  private async refreshConnections(): Promise<void> {
    const known = await this.deps.getKnownConnections();
    this.knownConnections = new Map(known.map(connection => [connection.id, connection]));
    this.renderHistory(); this.updateHeading(); this.updateInsertButtons();
  }

  private displayed(): AiConversation { return this.preview || this.conversation; }
  private isDisplayed(conversation: AiConversation): boolean { return this.displayed().id === conversation.id; }

  private async restoreConnection(): Promise<void> {
    const token = ++this.selectionEpoch;
    this.changing = true; this.updateControls();
    const connection = this.currentConnection();
    try {
      const conversation = await this.store.recent(connection);
      if (token !== this.selectionEpoch || this.disposed) return;
      this.conversation = conversation; this.preview = null;
      this.store.markOpened(conversation);
      this.refreshModelSelect(); this.renderConversation();
    } catch (error) { if (token === this.selectionEpoch) { this.conversation = this.store.create(connection); this.preview = null; this.historyError(error); this.renderConversation(); } }
    finally { if (token === this.selectionEpoch) { this.changing = false; this.updateControls(); } }
  }

  private async selectConversation(id: string, activate: boolean): Promise<void> {
    const token = ++this.selectionEpoch;
    this.saveDraft();
    this.changing = true; this.updateControls();
    try {
      const conversation = this.running.get(id)?.conversation || (id === this.conversation.id ? this.conversation : await this.store.get(id, true));
      if (token !== this.selectionEpoch || !conversation || this.disposed) return;
      this.changing = false;
      if (activate) {
        this.conversation = conversation; this.preview = null; this.changing = false;
        this.store.markOpened(conversation);
        this.refreshModelSelect();
      } else this.preview = id === this.conversation.id ? null : conversation;
      this.renderConversation();
    } catch (error) { this.historyError(error); }
    finally { if (token === this.selectionEpoch) { this.changing = false; this.updateControls(); } }
  }

  private activatePreview(): void {
    if (!this.preview) return;
    ++this.selectionEpoch; this.changing = false; this.conversation = this.preview; this.preview = null;
    this.store.markOpened(this.conversation); this.refreshModelSelect(); this.renderConversation();
  }

  private toggleHistory(open: boolean): void {
    this.historyView.element.hidden = !open;
    this.panel.classList.toggle('ai-history-open', open);
    this.historyButton.setAttribute('aria-pressed', String(open));
    this.historyButton.setAttribute('aria-label', open ? '收起历史会话' : '展开历史会话');
    this.historyButton.title = open ? '收起历史会话' : '展开历史会话';
    if (!open) this.historyView.closeMenu();
    configStorage.setItem('wterm_ai_history_open', String(open));
  }

  private searchHistory(text: string): void {
    this.search = text;
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.loadHistory(), 180);
  }

  private async loadHistory(more = false): Promise<void> {
    const token = ++this.listEpoch;
    const offset = more ? this.listedIds.length : 0;
    try {
      const page = await this.store.list(this.search, offset);
      if (token !== this.listEpoch || this.disposed) return;
      this.listedIds = [...new Set([...(more ? this.listedIds : []), ...page.items.map(item => item.id)])];
      this.total = page.total; this.renderHistory();
    } catch (error) { this.historyError(error); }
  }

  private renderHistory(): void {
    if (!this.historyView) return;
    const ids = new Set(this.listedIds);
    for (const conversation of this.store.cache.values()) {
      if (conversation.messages.length && (!this.search || [conversation.title, conversation.connection.name, ...conversation.messages.map(message => message.content)].join('\n').toLowerCase().includes(this.search.toLowerCase()))) ids.add(conversation.id);
    }
    const items = [...ids].map(id => this.store.index.get(id)).filter(item => !!item)
      .sort((a, b) => Number(b!.pinned) - Number(a!.pinned) || b!.updatedAt - a!.updatedAt);
    const labels = new Map([...this.knownConnections].map(([id, connection]) => [id, connection.name]));
    for (const item of items) if (item!.connection.saved && !labels.has(item!.connection.id)) labels.set(item!.connection.id, item!.connection.name + ' · 已删除');
    this.historyView.update(items, this.displayed().id, new Set(this.running.keys()), labels, Math.max(this.total, items.length));
  }

  private updateHeading(): void {
    if (!this.titleEl) return;
    const value = this.displayed();
    this.titleEl.textContent = value.title;
    const known = this.knownConnections.get(value.connection.id);
    let label = known?.name || value.connection.name + (value.connection.saved ? ' · 已删除' : '');
    if (value.connection.kind === 'ssh') {
      try { const [host, port, user] = JSON.parse(value.connection.targetKey); label += ` · ${user}@${host}:${port}`; } catch { /* Older snapshots still have a readable name. */ }
    }
    this.connectionEl.textContent = label;
    this.phaseEl.textContent = this.preview ? '预览' : '当前会话';
    this.returnButton.hidden = !this.preview;
  }

  private saveDraft(): void {
    if (this.preview || this.changing) return;
    if (this.conversation.draft === this.input.value) return;
    this.conversation.draft = this.input.value;
    this.store.touch(this.conversation);
  }

  setSelection(text: string): void {
    this.conversation.selection = text.trim().slice(0, 6000);
    this.store.touch(this.conversation); this.renderContext();
  }

  private renderContext(): void {
    const text = this.preview ? '' : this.conversation.selection;
    this.contextLabel.textContent = `上下文：选中内容 ${text.length} 字符`;
    this.contextEl.hidden = !text; this.quickRow.hidden = !text;
  }

  explainSelection(): void { this.explainText(this.deps.getSelection()); }
  explainText(text: string): void {
    this.prepareSelection(text, 'explain');
  }
  prepareSelection(text: string, action: AiSelectionAction, sid: string | null = this.deps.getSessionId()): void {
    if (!text.trim()) return;
    void this.ready.then(async () => {
      this.saveDraft();
      if (sid && sid !== this.deps.getSessionId() && this.deps.activateSession) {
        if (!this.deps.activateSession(sid)) throw new Error('原终端会话已结束');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      const current = this.currentConnection();
      if (this.preview?.connection.id === current.id && this.preview.connection.targetKey === current.targetKey) this.activatePreview();
      else if (this.changing || this.conversation.connection.id !== current.id || this.conversation.connection.targetKey !== current.targetKey) await this.restoreConnection();
      else this.preview = null;
      if (sid !== this.deps.getSessionId() || this.disposed) return;
      const draft = selectionDraft(text, action);
      this.conversation.draft = [this.conversation.draft.trim(), draft].filter(Boolean).join('\n\n');
      this.store.touch(this.conversation); this.renderConversation(); this.open(); this.input.focus({ preventScroll: true });
    }).catch(error => this.historyError(error));
  }

  newChat(): void {
    this.saveDraft(); ++this.selectionEpoch; this.changing = false;
    this.preview = null; this.conversation = this.store.create(this.currentConnection());
    this.refreshModelSelect(); this.renderConversation();
  }

  sessionChanged(id: string | null): void {
    if (id === this.sessionId) { this.updateInsertButtons(); return; }
    this.saveDraft(); this.sessionId = id;
    if (this.loaded) void this.restoreConnection();
  }

  diagnoseFailure(sid: string, failure: FailedCommand): void {
    if (!this.loaded || !aiAutoDiagnose() || !aiReady() || sid !== this.deps.getSessionId()
      || !Number.isSafeInteger(failure.exitCode) || failure.exitCode === 0 || this.running.has(this.conversation.id) || this.preview || this.changing
      || this.input.value.trim() || this.conversation.selection || Date.now() - this.lastDiagnosticAt < 10_000) return;
    this.lastDiagnosticAt = Date.now(); this.newChat(); this.open();
    void this.send('diagnose', diagnosticContext(failure));
  }

  private refreshModelSelect(): void {
    const config = aiConfig();
    this.modelSelect.replaceChildren(...config.models.map(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; }));
    this.modelSelect.value = config.models.includes(this.conversation.model) ? this.conversation.model : (config.models.includes(config.activeModel) ? config.activeModel : config.models[0] ?? '');
    this.updateControls();
  }

  private showGuide(): void {
    const guide = document.createElement('div'); guide.className = 'ai-guide';
    guide.innerHTML = aiReady() ? '<p><strong>AI 助手已就绪</strong></p><p>输入问题，或选中终端文字后按 Ctrl+Shift+I 解释。</p><p>对话保存在本机，可从历史会话中继续聊天。</p>'
      : '<p><strong>尚未配置 AI 服务</strong></p><p>请到「设置 → AI 助手」填写服务地址、API Key，并添加模型。</p>';
    if (!aiReady()) { const button = document.createElement('button'); button.className = 'btn primary'; button.textContent = '去配置'; button.onclick = () => this.deps.openSettings(); guide.append(button); }
    this.messagesEl.append(guide);
  }

  private renderConversation(): void {
    for (const details of this.messagesEl.querySelectorAll<HTMLDetailsElement>('.ai-reasoning')) {
      const id = details.closest<HTMLElement>('.ai-message')!.dataset.messageId!;
      const view = this.reasoningViews.get(id);
      if (view) {
        view.open = details.open;
        if (details.open) view.scrollTop = details.querySelector<HTMLElement>('.ai-reasoning-content')!.scrollTop;
      }
    }
    this.messagesEl.replaceChildren();
    const value = this.displayed();
    for (const message of value.messages) {
      if (message.role === 'assistant' && message.status === 'generating' && !message.content && !message.reasoning) continue;
      const bubble = this.appendMessage(message.role, message.content || (message.role === 'user' ? '分析选中内容' : ''));
      bubble.dataset.messageId = message.id;
      if (message.role === 'assistant' && message.status === 'generating') bubble.querySelector('.ai-body')!.innerHTML = renderMarkdownLite(message.content);
      if (message.role === 'assistant') this.renderReasoning(bubble, message);
      if (message.role === 'user' && message.context) {
        const details = document.createElement('details'); details.className = 'ai-message-context';
        const summary = document.createElement('summary'); summary.textContent = `终端片段 · ${message.context.length} 字符`;
        const content = document.createElement('pre'); content.textContent = message.context; details.append(summary, content); bubble.append(details);
      }
      if (message.role === 'assistant' && message.status !== 'generating') this.finalizeAssistantMessage(bubble, message.content);
      if (message.status === 'interrupted') this.appendMessageStatus(bubble, '回复已停止');
      if (message.status === 'generating' && this.running.get(value.id)?.message.id !== message.id) this.appendMessageStatus(bubble, '回复未完成');
      if (message.status === 'error') { const error = document.createElement('div'); error.className = 'ai-error'; error.textContent = message.error || '请求失败'; bubble.append(error); }
      if ((message.status === 'error' || message.status === 'interrupted') && message === value.messages.at(-1) && value.messages.at(-2)?.role === 'user') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'st ai-retry'; retry.textContent = '重试'; retry.disabled = this.running.has(value.id);
        retry.onclick = () => { this.activatePreview(); const user = value.messages.at(-2)!; void this.send(['chat', 'explain', 'summarize', 'diagnose'].includes(user.action) ? user.action as AiAction : 'chat', user.content, { user, answer: message }); };
        bubble.append(retry);
      }
    }
    if (!value.messages.length) this.showGuide();
    this.input.value = value.draft;
    this.updateHeading(); this.renderContext(); this.updateControls(); this.renderHistory();
  }

  private appendMessage(role: ChatRole, content: string, scroll = true): HTMLElement {
    const bubble = document.createElement('article'); bubble.className = `ai-message ai-${role}`;
    const body = document.createElement('div'); body.className = 'ai-body'; body.textContent = content;
    bubble.append(body); this.messagesEl.append(bubble); if (scroll) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return bubble;
  }
  private appendMessageStatus(bubble: HTMLElement, text: string): void {
    const status = document.createElement('div'); status.className = 'ai-message-status'; status.textContent = text; bubble.append(status);
  }

  private renderReasoning(bubble: HTMLElement, message: AiMessage): void {
    if (!message.reasoning) return;
    let view = this.reasoningViews.get(message.id);
    if (!view) { view = { open: false, scrollTop: 0 }; this.reasoningViews.set(message.id, view); }
    const state = view;
    let details = bubble.querySelector<HTMLDetailsElement>('.ai-reasoning');
    if (!details) {
      details = document.createElement('details'); details.className = 'ai-reasoning';
      const current = details;
      current.innerHTML = '<summary><span class="ai-reasoning-title">思考过程</span><span class="ai-reasoning-state"></span><span class="ai-spinner" aria-hidden="true" hidden></span></summary><div class="ai-reasoning-content"></div>';
      current.open = state.open;
      const content = current.querySelector<HTMLElement>('.ai-reasoning-content')!;
      current.ontoggle = () => {
        if (!current.isConnected) return;
        state.open = current.open;
        if (current.open) content.scrollTop = state.scrollTop;
      };
      content.onscroll = () => { if (current.isConnected && current.open) state.scrollTop = content.scrollTop; };
      bubble.prepend(current);
    }
    const request = this.running.get(this.displayed().id);
    const live = message.status === 'generating' && request?.message.id === message.id;
    const thinking = live && request?.phase === '正在思考';
    details.querySelector<HTMLElement>('.ai-reasoning-state')!.textContent = thinking ? '正在思考' : live || message.status === 'complete' ? '已结束' : message.status === 'interrupted' ? '已停止' : '未完成';
    details.querySelector<HTMLElement>('.ai-spinner')!.hidden = !thinking;
    const content = details.querySelector<HTMLElement>('.ai-reasoning-content')!;
    if (this.reasoningText.get(content) !== message.reasoning) {
      const top = state.scrollTop;
      const following = this.reasoningText.has(content) && content.scrollHeight - content.clientHeight - top < 24;
      content.innerHTML = renderMarkdownLite(message.reasoning); this.reasoningText.set(content, message.reasoning);
      if (details.open) { content.scrollTop = following ? content.scrollHeight : top; state.scrollTop = content.scrollTop; }
    }
    bubble.classList.toggle('ai-reasoning-only', !message.content);
  }

  private insertionAllowed(): boolean {
    const current = this.currentConnection(); const source = this.displayed().connection;
    return !!this.deps.getSessionId() && (this.deps.canInsert?.() ?? true) && current.id === source.id && !!source.targetKey && current.targetKey === source.targetKey;
  }
  private updateInsertButtons(): void {
    if (!this.messagesEl) return;
    this.messagesEl.querySelectorAll<HTMLButtonElement>('.ai-insert').forEach(button => {
      const code = button.closest('.ai-code')?.querySelector('code')?.textContent || '';
      const feedback = this.insertFeedback.get(button.dataset.feedbackKey!);
      const reason = !canInsertCommand(code) ? '多行或含控制字符的命令请复制后自行检查' : !this.insertionAllowed() ? '请选择与此会话相同连接的可输入终端' : '';
      button.disabled = !!feedback?.pending || !!reason;
      button.title = reason || '写入当前连接的终端输入行（不执行）';
      const label = button.closest('.ai-code')!.querySelector<HTMLElement>('.ai-insert-feedback')!;
      label.textContent = feedback?.text || reason; label.classList.toggle('ai-error', !!feedback?.error);
    });
  }
  private finalizeAssistantMessage(bubble: HTMLElement, content: string): void {
    const body = bubble.querySelector('.ai-body')!; body.innerHTML = renderMarkdownLite(content);
    for (const [index, pre] of [...body.querySelectorAll<HTMLElement>('.ai-code')].entries()) {
      const code = pre.querySelector('code')!.textContent || '';
      const actions = document.createElement('div'); actions.className = 'ai-code-actions';
      const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'st ai-insert'; insert.textContent = '插入终端';
      const conversationId = this.displayed().id;
      const key = bubble.dataset.messageId + ':' + index; insert.dataset.feedbackKey = key;
      const feedback = document.createElement('span'); feedback.className = 'ai-insert-feedback'; feedback.setAttribute('role', 'status');
      insert.onclick = async () => {
        if (this.insertFeedback.get(key)?.pending) return;
        this.activatePreview();
        if (conversationId !== this.conversation.id || !this.insertionAllowed() || !canInsertCommand(code)) {
          this.insertFeedback.set(key, { text: '插入失败：请选择与会话相同连接的终端，或复制命令后检查', error: true, pending: false }); this.updateInsertButtons(); return;
        }
        this.insertFeedback.set(key, { text: '正在插入…', error: false, pending: true }); this.updateInsertButtons();
        try { await this.deps.insertIntoTerminal(code); this.insertFeedback.set(key, { text: '已插入终端，按 Enter 执行', error: false, pending: false }); }
        catch (error) { this.insertFeedback.set(key, { text: '插入失败：' + String(error), error: true, pending: false }); }
        finally { this.updateInsertButtons(); }
      };
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'st'; copy.textContent = '复制'; copy.onclick = () => void navigator.clipboard.writeText(code).catch(() => {});
      actions.append(insert, copy); pre.append(actions, feedback);
    }
    this.updateInsertButtons();
  }

  private setActivity(request: RunningRequest, text: string): void {
    request.phase = text;
    if (this.isDisplayed(request.conversation)) {
      this.updateActivity();
      const bubble = this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${request.message.id}"]`);
      if (bubble) this.renderReasoning(bubble, request.message);
    }
  }
  private updateActivity = (): void => {
    const request = this.running.get(this.displayed().id);
    if (!request) return;
    const seconds = Math.floor((Date.now() - request.startedAt) / 1000);
    this.activityTime.textContent = seconds + ' 秒';
    this.activityLabel.textContent = request.phase + (seconds >= 20 ? ' · 仍在等待' : '');
  };
  private updateControls(): void {
    if (!this.sendButton) return;
    const running = this.running.has(this.displayed().id);
    const visibleRunning = running && !this.preview;
    const displayedRunning = this.running.has(this.displayed().id);
    this.panel.setAttribute('aria-busy', String(displayedRunning)); this.activity.hidden = !displayedRunning;
    document.querySelector('#btn-ai')?.classList.toggle('busy', this.running.size > 0);
    if (displayedRunning) {
      this.updateActivity();
      if (this.activityTimer === undefined) this.activityTimer = window.setInterval(this.updateActivity, 1000);
    } else if (this.activityTimer !== undefined) { window.clearInterval(this.activityTimer); this.activityTimer = undefined; }
    this.input.disabled = this.changing || !this.loaded;
    this.sendButton.hidden = visibleRunning; this.stopButton.hidden = !visibleRunning;
    this.sendButton.disabled = running || this.changing || !this.loaded;
    this.modelSelect.disabled = running || !!this.preview || !aiConfig().models.length;
  }

  stop(): void { this.stopConversation(this.conversation.id); }

  private stopConversation(id: string): void {
    const request = this.running.get(id);
    if (request) {
      this.running.delete(id);
      request.message.status = 'interrupted'; request.conversation.updatedAt = Date.now(); this.store.touch(request.conversation);
      void invoke('ai_cancel', { requestId: request.id }).catch(error => this.historyError(`停止请求失败：${String(error)}`));
      if (this.isDisplayed(request.conversation)) this.renderConversation();
    }
    this.updateControls(); this.renderHistory();
  }

  private stopAll(): void {
    for (const id of this.running.keys()) this.stopConversation(id);
  }

  private async send(action: AiAction, input: string, retry?: { user: AiMessage; answer: AiMessage }): Promise<void> {
    await this.ready;
    this.activatePreview();
    if (this.running.has(this.conversation.id) || this.changing || this.disposed) return;
    if (!aiReady()) { this.renderConversation(); return; }
    const conversation = this.conversation;
    if (retry && conversation.messages.at(-1) !== retry.answer) return;
    const context = retry ? retry.user.context : conversation.selection; const userContent = [input.trim(), context].filter(Boolean).join('\n\n');
    if (!userContent) { this.input.focus({ preventScroll: true }); return; }
    if (userContent.length > 16_000) { const error = this.appendMessage('assistant', '输入过长，请缩小内容范围（最多 16000 字符）'); error.classList.add('ai-error'); return; }
    const config = aiConfig(); const model = this.modelSelect.value;
    const messages = buildMessages(action, userContent, completedTurns(conversation));
    const makeMessage = (role: 'user' | 'assistant', content: string, status: AiMessage['status']): AiMessage => ({ id: crypto.randomUUID(), role, content, status, createdAt: Date.now(), context: '', action, model, provider: config.baseUrl, error: '' });
    const user = retry?.user || makeMessage('user', input.trim(), 'complete'); user.context = context;
    const answer = retry?.answer || makeMessage('assistant', '', 'generating');
    if (retry) for (const key of this.insertFeedback.keys()) if (key.startsWith(answer.id + ':')) this.insertFeedback.delete(key);
    this.reasoningViews.delete(answer.id);
    Object.assign(answer, { content: '', reasoning: '', error: '', status: 'generating', model, provider: config.baseUrl, action });
    if (!conversation.messages.length) conversation.title = [...(input.trim() || context).replace(/\s+/g, ' ')].slice(0, 60).join('');
    if (!retry) conversation.messages.push(user, answer);
    conversation.model = model; conversation.updatedAt = Date.now();
    if (!retry) { conversation.draft = ''; conversation.selection = ''; }
    const request: RunningRequest = { id: crypto.randomUUID(), conversation, message: answer, startedAt: Date.now(), phase: '正在连接服务' };
    this.running.set(conversation.id, request); this.store.touch(conversation); this.renderConversation();
    const channel = new Channel<AiChunk>();
    channel.onmessage = chunk => {
      // The request owns its conversation even when another tab or preview is visible.
      const current = this.running.get(conversation.id) === request;
      if (chunk.started) { if (!current) void invoke('ai_cancel', { requestId: request.id }).catch(() => {}); else this.setActivity(request, '正在等待回复'); return; }
      if (!current) return;
      if (chunk.activity) this.setActivity(request, chunk.activity === 'thinking' ? '正在思考' : '模型请求工具：' + (chunk.toolName || '未知工具') + '（未执行）');
      if (chunk.error) { this.finishRequest(request, 'error', chunk.error); return; }
      if (chunk.done) { this.finishRequest(request, 'complete'); return; }
      if (chunk.delta || chunk.reasoningDelta) {
        if (answer.content.length + (answer.reasoning?.length || 0) + (chunk.delta?.length || 0) + (chunk.reasoningDelta?.length || 0) > 100_000) { this.stopConversation(conversation.id); this.finishRequest(request, 'error', '回复过长，已停止请求，请缩小问题范围'); return; }
        const following = this.messagesEl.scrollHeight - this.messagesEl.clientHeight - this.messagesEl.scrollTop < 24;
        answer.content += chunk.delta || ''; answer.reasoning = (answer.reasoning || '') + (chunk.reasoningDelta || '');
        conversation.updatedAt = Date.now(); this.setActivity(request, chunk.delta ? '正在生成回复' : '正在思考'); this.store.touch(conversation);
        if (this.isDisplayed(conversation)) {
          let bubble = this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${answer.id}"]`);
          if (!bubble) { bubble = this.appendMessage('assistant', answer.content, false); bubble.dataset.messageId = answer.id; }
          this.renderReasoning(bubble, answer);
          bubble.querySelector('.ai-body')!.innerHTML = renderMarkdownLite(answer.content);
          if (following) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      }
    };
    try { await invoke('ai_chat', { requestId: request.id, baseUrl: config.baseUrl, model, protocol: config.protocol, messages, channel }); }
    catch (error) { if (this.running.get(conversation.id) === request) this.finishRequest(request, 'error', `请求失败：${String(error)}`); }
  }

  private finishRequest(request: RunningRequest, status: 'complete' | 'error', error = ''): void {
    request.message.status = status; request.message.error = error; request.conversation.updatedAt = Date.now();
    this.running.delete(request.conversation.id); this.store.touch(request.conversation); void this.store.flush();
    if (this.isDisplayed(request.conversation)) this.renderConversation(); else { this.updateControls(); this.renderHistory(); }
  }

  private async renameConversation(id: string): Promise<void> {
    try {
      const conversation = this.running.get(id)?.conversation || await this.store.get(id);
      if (!conversation || this.disposed) return;
      const title = window.prompt('会话名称', conversation.title)?.trim();
      if (!title) return;
      conversation.title = [...title].slice(0, 120).join(''); this.store.touch(conversation); this.updateHeading();
    } catch (error) { this.historyError(error); }
  }
  private async pinConversation(id: string): Promise<void> {
    try {
      const conversation = this.running.get(id)?.conversation || await this.store.get(id);
      if (!conversation || this.disposed) return;
      conversation.pinned = !conversation.pinned; this.store.touch(conversation);
    } catch (error) { this.historyError(error); }
  }
  private async deleteConversation(id: string): Promise<void> {
    try {
      const conversation = this.running.get(id)?.conversation || await this.store.get(id);
      if (!conversation || this.disposed || !window.confirm(`删除会话“${conversation.title}”？`)) return;
      this.stopConversation(id);
      await this.store.delete(conversation); this.listedIds = this.listedIds.filter(id => id !== conversation.id); this.total = Math.max(0, this.total - 1);
      for (const message of conversation.messages) this.reasoningViews.delete(message.id);
      if (this.conversation.id === conversation.id) {
        ++this.selectionEpoch; this.changing = false; this.preview = null;
        this.conversation = this.store.create(this.currentConnection()); this.refreshModelSelect(); this.renderConversation();
      } else if (this.preview?.id === id) { this.preview = null; this.renderConversation(); }
      await this.loadHistory();
    } catch (error) { this.historyError(error); }
  }
  private historyError(error: unknown): void {
    if (!this.errorEl) return;
    this.errorEl.querySelector('span')!.textContent = '历史记录保存或读取失败：' + String(error);
    this.errorEl.hidden = false;
  }

  isOpen(): boolean { return this.panel.classList.contains('open'); }
  open(): void {
    this.refreshModelSelect(); this.panel.classList.add('open'); this.windowLayout.layout();
    document.querySelector('#btn-ai')?.setAttribute('aria-expanded', 'true');
    if (this.loaded) { void this.loadHistory(); void this.refreshConnections().catch(error => this.historyError(error)); }
  }
  close(): void {
    this.stopAll(); this.collapse();
  }
  private collapse(): void {
    this.saveDraft(); this.historyView.closeMenu(); void this.store.flush(); this.panel.classList.remove('open'); this.windowLayout.layout();
    document.querySelector('#btn-ai')?.setAttribute('aria-expanded', 'false');
    this.deps.focusTerminal?.();
  }
  toggle(): void {
    if (this.isOpen()) this.collapse();
    else { this.open(); if (!this.preview) this.input.focus({ preventScroll: true }); }
  }
  async flush(): Promise<void> {
    this.saveDraft(); this.stopAll(); await this.store.flush();
    if (this.store.hasFailedWrites()) throw new Error('AI 会话仍有未保存的内容，请重试保存');
  }
  dispose(): void {
    this.saveDraft(); this.stopAll(); void this.store.flush(); this.disposed = true; ++this.selectionEpoch; ++this.listEpoch;
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    window.removeEventListener('wterm-ai-config-change', this.onConfigChange); window.removeEventListener('wterm-connections-change', this.onConnectionsChange);
    this.historyView.dispose(); this.windowLayout.dispose(); this.panel.remove();
  }
}
