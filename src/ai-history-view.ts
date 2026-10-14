import { configStorage } from './config-storage';
import type { ConversationSummary } from './ai-history';
import { aiIcon } from './ai-icons';

interface HistoryViewDeps {
  preview: (id: string) => void; activate: (id: string) => void;
  search: (text: string) => void; more: () => void;
  rename: (id: string) => void; pin: (id: string) => void; delete: (id: string) => void;
}

export class AiHistoryView {
  readonly element: HTMLElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private moreButton: HTMLButtonElement;
  private rows = new Map<string, HTMLButtonElement>();
  private groupLabels = new Map<string, HTMLElement>();
  private groupStates = new Map<string, boolean>();
  private signature = '';
  private items: ConversationSummary[] = [];
  private selected = '';
  private running = new Set<string>();
  private labels = new Map<string, string>();
  private view = configStorage.getItem('wterm_ai_history_view') === 'all' ? 'all' : 'connections';
  private menu: HTMLElement | undefined;
  private menuOwner: HTMLButtonElement | undefined;
  private readonly dismissMenu = () => this.closeMenu();

  constructor(private deps: HistoryViewDeps) {
    this.element = document.createElement('aside');
    this.element.className = 'ai-history';
    this.element.setAttribute('aria-label', 'AI 历史会话');
    this.element.innerHTML = `<div class="ai-history-heading"><strong>会话</strong><span class="ai-history-count"></span></div>
      <div class="ai-history-views" aria-label="历史查看方式"><button type="button" data-view="all">全部会话</button><button type="button" data-view="connections">按连接</button></div>
      <input class="ai-history-search" type="search" placeholder="搜索会话" aria-label="搜索会话" maxlength="200" />
      <div class="ai-history-list"></div><button class="st ai-history-more" type="button" hidden>加载更多</button>`;
    this.list = this.element.querySelector('.ai-history-list')!;
    this.count = this.element.querySelector('.ai-history-count')!;
    this.moreButton = this.element.querySelector('.ai-history-more')!;
    this.moreButton.onclick = () => deps.more();
    this.element.querySelector<HTMLInputElement>('.ai-history-search')!.oninput = event => deps.search((event.target as HTMLInputElement).value.trim());
    this.element.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
      button.onclick = () => { this.closeMenu(); this.view = button.dataset.view!; configStorage.setItem('wterm_ai_history_view', this.view); this.signature = ''; this.render(); };
    });
    this.list.addEventListener('scroll', this.dismissMenu);
    window.addEventListener('resize', this.dismissMenu);
  }

  update(items: ConversationSummary[], selected: string, running: Set<string>, labels: Map<string, string>, total: number): void {
    this.items = items; this.selected = selected; this.running = running; this.labels = labels;
    this.count.textContent = String(total);
    this.moreButton.hidden = items.length >= total;
    if (this.menuOwner && !items.some(item => item.id === this.menuOwner!.dataset.id)) this.closeMenu();
    this.render();
  }

  private row(item: ConversationSummary): HTMLButtonElement {
    let row = this.rows.get(item.id);
    if (!row) {
      row = document.createElement('button'); row.type = 'button'; row.className = 'ai-history-row'; row.dataset.id = item.id;
      row.innerHTML = '<span class="ai-history-title"></span><span class="ai-history-meta"></span><span class="ai-spinner ai-history-running" aria-hidden="true" hidden></span>';
      row.setAttribute('aria-haspopup', 'menu');
      row.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); this.openMenu(item.id, row!, event.clientX, event.clientY); };
      row.onclick = () => this.deps.preview(item.id);
      row.ondblclick = () => this.deps.activate(item.id);
      row.onkeydown = event => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault(); event.stopPropagation();
          const rect = row!.getBoundingClientRect(); this.openMenu(item.id, row!, rect.left + 12, rect.bottom); return;
        }
        if (event.key === 'Enter') { event.preventDefault(); this.deps.activate(item.id); return; }
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const rows = [...this.list.querySelectorAll<HTMLButtonElement>('.ai-history-row')].filter(button => button.getClientRects().length);
        const index = rows.indexOf(row!);
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) { next.focus({ preventScroll: true }); this.deps.preview(next.dataset.id!); }
      };
      this.rows.set(item.id, row);
    }
    const label = this.labels.get(item.connection.id) || item.connection.name;
    const running = this.running.has(item.id);
    row.querySelector('.ai-history-title')!.textContent = (item.pinned ? '· ' : '') + item.title;
    row.querySelector('.ai-history-meta')!.textContent = (this.view === 'all' ? label + ' · ' : '') + new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    row.querySelector<HTMLElement>('.ai-history-running')!.hidden = !running;
    row.dataset.running = String(running);
    row.setAttribute('aria-label', item.title + '，' + label + (running ? '，正在生成' : ''));
    row.setAttribute('aria-pressed', String(item.id === this.selected));
    row.title = item.title + (running ? '\n正在生成' : '') + (item.preview ? '\n' + item.preview : '');
    return row;
  }

  private render(): void {
    this.element.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === this.view)));
    const signature = this.view + '|' + this.items.map(item => item.id + ':' + item.connection.id).join('|');
    const rows = this.items.map(item => this.row(item));
    if (signature !== this.signature) {
      this.list.querySelectorAll<HTMLDetailsElement>('details[data-connection-id]').forEach(group => this.groupStates.set(group.dataset.connectionId!, group.open));
      this.signature = signature; this.groupLabels.clear();
      if (!rows.length) {
        const empty = document.createElement('p'); empty.className = 'ai-history-empty'; empty.textContent = '暂无会话'; this.list.replaceChildren(empty);
      } else if (this.view === 'all') this.list.replaceChildren(...rows);
      else {
        const groups = new Map<string, HTMLDetailsElement>();
        this.items.forEach((item, index) => {
          let group = groups.get(item.connection.id);
          if (!group) {
            group = document.createElement('details'); group.dataset.connectionId = item.connection.id; group.open = this.groupStates.get(item.connection.id) ?? true;
            const summary = document.createElement('summary');
            group.append(summary); groups.set(item.connection.id, group); this.groupLabels.set(item.connection.id, summary);
          }
          group.append(rows[index]);
        });
        this.list.replaceChildren(...groups.values());
      }
    }
    for (const [id, label] of this.groupLabels) label.textContent = this.labels.get(id) || this.items.find(item => item.connection.id === id)?.connection.name || '连接';
  }

  private openMenu(id: string, owner: HTMLButtonElement, x: number, y: number): void {
    this.closeMenu();
    const item = this.items.find(item => item.id === id);
    if (!item) return;
    const menu = document.createElement('div');
    menu.className = 'menu-dropdown ai-history-menu'; menu.popover = 'auto';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '会话操作'); menu.dataset.conversationId = id;
    const add = (label: string, icon: Parameters<typeof aiIcon>[0], action: () => void, danger = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-item' + (danger ? ' danger' : '');
      button.setAttribute('role', 'menuitem'); button.innerHTML = aiIcon(icon);
      const text = document.createElement('span'); text.textContent = label; button.append(text);
      button.onclick = () => { this.closeMenu(true); action(); }; menu.append(button);
    };
    add('重命名', 'rename', () => this.deps.rename(id));
    add(item.pinned ? '取消置顶' : '置顶', item.pinned ? 'unpin' : 'pin', () => this.deps.pin(id));
    const divider = document.createElement('div'); divider.className = 'menu-divider'; divider.setAttribute('role', 'separator'); menu.append(divider);
    add('删除', 'delete', () => this.deps.delete(id), true);
    menu.onkeydown = event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); this.closeMenu(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    menu.addEventListener('toggle', () => { if (!menu.matches(':popover-open') && this.menu === menu) this.closeMenu(); });
    document.body.append(menu); this.menu = menu; this.menuOwner = owner; owner.setAttribute('aria-expanded', 'true');
    menu.showPopover();
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    menu.querySelector<HTMLButtonElement>('button')!.focus({ preventScroll: true });
  }

  closeMenu(restoreFocus = false): void {
    const menu = this.menu, owner = this.menuOwner;
    this.menu = undefined; this.menuOwner = undefined;
    menu?.remove(); owner?.removeAttribute('aria-expanded');
    if (restoreFocus && owner?.isConnected) owner.focus({ preventScroll: true });
  }

  dispose(): void {
    this.closeMenu();
    this.list.removeEventListener('scroll', this.dismissMenu);
    window.removeEventListener('resize', this.dismissMenu);
  }
}
