import { configStorage } from './config-storage';
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./features.css";
import {
  createTerminal,
  spawnLocal,
  spawnSsh,
  spawnSshOnExisting,
  bindSessionIO,
  closeSession,
  watchTitle,
  setBroadcastTargetProvider,
  paneDimensions,
  type TermSession,
} from "./terminal";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sameSshAccount } from "./session-identity";
import { leaves, splitLeaf, removeLeaf, swapLeaves, grid, type Layout, type WorkspaceTab } from './layout';
import { shortcutAction, keyChord } from './shortcuts';
import { bindTabDrag } from './tab-drag';
import { captureHistory, restoreHistory, MAX_HISTORY_CHARS, WORKSPACE_HISTORY_CHARS, type SessionHistory } from './session-history';
import { listFavorites, favoriteIcon, favoriteTypeLabel, favoriteScriptEnvironmentLabel, normalizeFavoriteCommand, showFavoritesManager, shellBasename, type Favorite } from "./favorites";
import { applyTheme, getTerminalTheme } from "./themes";
import { applyAppearance } from "./appearance";
import { loadCredential, passwordCredentialKey } from "./credentials";

applyTheme();
void applyAppearance();

// ---------- 全局异常上报 ----------
// 前端白屏类问题在 GUI 下难以排查，统一转发到后端日志（%TEMP%\wterm-debug.log，仅 debug 构建）
function report(msg: string): void {
  invoke("log_frontend", { msg }).catch(() => {});
}
window.addEventListener("error", (e) => {
  report(`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report(`unhandledrejection: ${String(e.reason)}`);
});

export interface SshProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: string;
  proxy_jump?: string | null;
  /** 私钥路径（auth = "key"），来自导入或手动填写 */
  identity_file?: string | null;
  group?: string | null;
  tags?: string[];
  color?: string | null;
  login_script?: string | null;
  keepalive_secs?: number | null;
  auto_reconnect?: boolean;
  reconnect_attempts?: number | null;
  reconnect_delay_secs?: number | null;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="titlebar">
    <button class="brand app-menu-trigger" id="btn-app-menu" title="wterm 主菜单" aria-expanded="false">wterm <span class="brand-caret">⌄</span></button>
    <div class="tabs-container" id="tabs-container">
      <div class="tabs" id="tabs"></div>
      <div class="tab-add-group" id="tab-add-group">
        <button class="tab-add-btn" id="btn-add" title="新建默认终端">+</button>
        <button class="tab-add-arrow" id="btn-add-menu" title="选择终端或快速连接">▼</button>
      </div>
      <div class="tabs-blank-area" id="tabs-blank"></div>
    </div>
    <div class="search-bar" id="term-search-bar" style="display:none;">
      <input id="search-input" placeholder="搜索终端内容..." />
      <label title="正则表达式"><input type="checkbox" id="search-regex" />.*</label>
      <label title="区分大小写"><input type="checkbox" id="search-case" />Aa</label>
      <label title="全词匹配"><input type="checkbox" id="search-word" />词</label>
      <span id="search-result" role="status"></span>
      <button id="search-prev" title="上一个 (Shift+Enter)">↑</button>
      <button id="search-next" title="下一个 (Enter)">↓</button>
      <button id="search-close" title="关闭 (Esc)">✕</button>
    </div>
    <button id="split-broadcast" class="tb-btn" hidden>广播输入</button><div class="window-controls">
      <button id="window-minimize" aria-label="最小化" title="最小化"><svg viewBox="0 0 12 12" aria-hidden="true"><line x1="2.5" y1="6" x2="9.5" y2="6"/></svg></button>
      <button id="window-maximize" aria-label="最大化或还原" title="最大化 / 还原"><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7"/></svg></button>
      <button id="window-close" aria-label="关闭窗口" title="关闭"><svg viewBox="0 0 12 12" aria-hidden="true"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg></button>
    </div>
  </div>
  <div class="main">
    <div class="terminal-area" id="term-area"></div>
  </div>
`;

const tabsEl = document.querySelector<HTMLDivElement>("#tabs")!;
const termArea = document.querySelector<HTMLDivElement>("#term-area")!;
const refreshTabDrag = bindTabDrag(tabsEl, (id, targetId) => {
  const from = workspaceTabs.findIndex(tab => tab.id === id);
  const to = workspaceTabs.findIndex(tab => tab.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  workspaceTabs.splice(to, 0, workspaceTabs.splice(from, 1)[0]);
  renderTabs();
});

const sessions = new Map<string, TermSession>();
const broadcastSessionIds = new Set<string>();
let broadcastEnabled = false;
setBroadcastTargetProvider(sourceId => {
  if (!broadcastEnabled || !broadcastSessionIds.has(sourceId)) return [];
  return [...broadcastSessionIds].filter(id => sessions.get(id)?.status === "connected");
});
function updateBroadcastButton(): void {
 requestAnimationFrame(renderTabs);
  const button = document.querySelector<HTMLButtonElement>("#btn-batch");
  if (!button) return;
  const count = [...broadcastSessionIds].filter(id => sessions.has(id)).length;
  button.classList.toggle("active", broadcastEnabled && count > 1);
  button.textContent = broadcastEnabled && count > 1 ? `⌘ 广播 ${count}` : "⌘ 批量";
  button.title = broadcastEnabled && count > 1 ? `广播输入已开启：${count} 个会话` : "批量连接与广播输入";
}
const refreshTerminalTheme = () => {
  const theme = getTerminalTheme();
  for (const session of sessions.values()) {
    session.term.options.theme = theme;
    session.term.options.fontFamily = configStorage.getItem('wterm_font_family') || "'Cascadia Code', 'JetBrains Mono', Consolas, monospace";
    session.term.options.fontSize = Number(configStorage.getItem('wterm_font_size')) || 14;
    session.term.options.lineHeight = Number(configStorage.getItem('wterm_line_height')) || 1.25;
    session.term.options.letterSpacing = Number(configStorage.getItem('wterm_letter_spacing')) || 0;
  }
  requestAnimationFrame(fitVisible);
};
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;
function adjustFontSize(delta: number): void {
  const current = Number(configStorage.getItem('wterm_font_size')) || 14;
  const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, current + delta));
  if (next === current) return;
  configStorage.setItem('wterm_font_size', String(next));
  for (const session of sessions.values()) session.term.options.fontSize = next;
  requestAnimationFrame(fitVisible);
}
window.addEventListener("wterm-theme-changed", refreshTerminalTheme);
window.addEventListener("wterm-appearance-changed", refreshTerminalTheme);
let activeId: string | null = null;
const workspaceTabs: WorkspaceTab[] = [];
const ownerOf = (sid: string | null) => workspaceTabs.find(tab => sid && leaves(tab.root).includes(sid));
let layoutBusy = false;
function registerSession(session: TermSession, target?: { tab: WorkspaceTab; sid: string; direction: 'h' | 'v' }): void {
  sessions.set(session.id, session);
  const historyChange = session.term.onWriteParsed(() => {
    historyCache.delete(session);
    scheduleHistorySave();
  });
  session.unlisteners.push(() => historyChange.dispose());
  if (target && workspaceTabs.includes(target.tab) && leaves(target.tab.root).includes(target.sid)) {
    target.tab.root = splitLeaf(target.tab.root, target.sid, session.id, target.direction);
    target.tab.focused = session.id;
  } else workspaceTabs.push({ id: session.id, root: { sid: session.id }, focused: session.id });
  rebuildLayout();
}
let counter = 0;
const windowSessionPrefix = crypto.randomUUID();
(window as unknown as Record<string, unknown>).__wtermSessionPrefix = windowSessionPrefix;

type SavedLeaf =
  | { kind: "local"; shell: string | null; cwd?: string; title: string; history?: SessionHistory }
  | { kind: "ssh"; profile: SshProfile; title: string; history?: SessionHistory };
type SavedLayout =
  | { leaf: SavedLeaf }
  | { direction: "h" | "v"; ratio: number; first: SavedLayout; second: SavedLayout };
interface SavedWorkspace {
  version: 1;
  width: number;
  height: number;
  activeTab: number;
  tabs: Array<{ root: SavedLayout; focusedIndex: number }>;
}
interface SessionTransferPayload {
  id: string;
  title: string;
  status: "connecting" | "connected" | "closed";
  profile?: SshProfile;
  localShell?: string | null;
  cwd?: string;
  screen: string;
}
let workspaceStorageKey = `wterm_workspace_v1:${getCurrentWindow().label}`;
let restoringWorkspace = false;
let workspaceSaveTimer: number | undefined;
let historySaveTimer: number | undefined;
const historyCache = new WeakMap<TermSession, { limit: number; cols: number; rows: number; history?: SessionHistory }>();

function snapshotLayout(node: Layout, historyLimit: number): SavedLayout | null {
  if ("sid" in node) {
    const session = sessions.get(node.sid);
    if (!session) return null;
    const cached = historyCache.get(session);
    const history = cached && cached.limit === historyLimit && cached.cols === session.term.cols && cached.rows === session.term.rows
      ? cached.history : captureHistory(session, historyLimit);
    historyCache.set(session, { limit: historyLimit, cols: session.term.cols, rows: session.term.rows, history });
    return {
      leaf: session.profile
        ? { kind: "ssh", profile: session.profile, title: session.title, history }
        : { kind: "local", shell: session.localShell ?? null, cwd: session.cwd, title: session.title, history },
    };
  }
  const first = snapshotLayout(node.first, historyLimit);
  const second = snapshotLayout(node.second, historyLimit);
  if (!first) return second;
  if (!second) return first;
  return { direction: node.direction, ratio: node.ratio, first, second };
}

function saveWorkspace(): void {
  if (restoringWorkspace) return;
  if (historySaveTimer !== undefined) { window.clearTimeout(historySaveTimer); historySaveTimer = undefined; }
  const historyLimit = Math.min(MAX_HISTORY_CHARS, Math.floor(WORKSPACE_HISTORY_CHARS / Math.max(1, sessions.size)));
  const tabs = workspaceTabs.flatMap(tab => {
    const root = snapshotLayout(tab.root, historyLimit);
    return root ? [{ root, focusedIndex: Math.max(0, leaves(tab.root).indexOf(tab.focused)) }] : [];
  });
  const state: SavedWorkspace = {
    version: 1,
    width: Math.round(window.innerWidth),
    height: Math.round(window.innerHeight),
    activeTab: Math.max(0, workspaceTabs.indexOf(ownerOf(activeId)!)),
    tabs,
  };
  try { configStorage.setItem(workspaceStorageKey, JSON.stringify(state)); }
  catch (error) {
    // Retain reconnect/layout information if storage is nearly full.
    const layoutOnly = JSON.stringify(state, (key, value) => key === 'history' ? undefined : value);
    try { configStorage.setItem(workspaceStorageKey, layoutOnly); }
    catch { report(`工作区保存失败: ${String(error)}`); }
  }
}

function scheduleHistorySave(): void {
  if (restoringWorkspace || historySaveTimer !== undefined) return;
  // Throttle: continuous output must still be checkpointed every two seconds.
  historySaveTimer = window.setTimeout(() => { historySaveTimer = undefined; saveWorkspace(); }, 2000);
}

function scheduleWorkspaceSave(): void {
  if (restoringWorkspace) return;
  if (workspaceSaveTimer !== undefined) window.clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = window.setTimeout(() => {
    workspaceSaveTimer = undefined;
    saveWorkspace();
  }, 180);
}

async function restoreSavedLeaf(leaf: SavedLeaf): Promise<string | null> {
  const before = new Set(sessions.keys());
  if (leaf.kind === "local") {
    await newLocalSession(leaf.shell ?? undefined, leaf.title, undefined, leaf.cwd, leaf.history);
  } else {
    let password: string | undefined;
    let passphrase: string | undefined;
    if (leaf.profile.auth === "password") {
      password = await loadCredential("password", passwordCredentialKey(leaf.profile.username, leaf.profile.host, leaf.profile.port));
    }
    if (leaf.profile.identity_file) {
      passphrase = await loadCredential("passphrase", leaf.profile.identity_file);
    }
    await newSshSession(leaf.profile, password, passphrase, leaf.history);
  }
  const id = [...sessions.keys()].find(candidate => !before.has(candidate)) ?? null;
  const session = id ? sessions.get(id) : undefined;
  if (session) session.title = leaf.title;
  return id;
}

async function restoreSavedLayout(node: SavedLayout): Promise<{ root: Layout; ids: string[] } | null> {
  if ("leaf" in node) {
    const id = await restoreSavedLeaf(node.leaf);
    return id ? { root: { sid: id }, ids: [id] } : null;
  }
  const first = await restoreSavedLayout(node.first);
  const second = await restoreSavedLayout(node.second);
  if (!first) return second;
  if (!second) return first;
  return {
    root: { direction: node.direction, ratio: Math.max(.1, Math.min(.9, node.ratio)), first: first.root, second: second.root },
    ids: [...first.ids, ...second.ids],
  };
}

async function restoreWorkspace(): Promise<boolean> {
  const raw = configStorage.getItem(workspaceStorageKey);
  if (!raw) return false;
  let saved: SavedWorkspace;
  try { saved = JSON.parse(raw) as SavedWorkspace; }
  catch { return false; }
  if (saved.version !== 1 || !Array.isArray(saved.tabs) || !saved.tabs.length) return false;
  restoringWorkspace = true;
  try {
    if (saved.width >= 800 && saved.height >= 500) {
      await getCurrentWindow().setSize(new LogicalSize(saved.width, saved.height)).catch(() => {});
    }
    const restored: WorkspaceTab[] = [];
    for (const savedTab of saved.tabs) {
      const built = await restoreSavedLayout(savedTab.root);
      if (!built?.ids.length) continue;
      const focused = built.ids[Math.min(Math.max(0, savedTab.focusedIndex), built.ids.length - 1)] ?? built.ids[0];
      restored.push({ id: built.ids[0], root: built.root, focused });
    }
    if (!restored.length) return false;
    workspaceTabs.splice(0, workspaceTabs.length, ...restored);
    rebuildLayout();
    const selected = restored[Math.min(Math.max(0, saved.activeTab), restored.length - 1)] ?? restored[0];
    activateSession(selected.focused);
    return true;
  } finally {
    restoringWorkspace = false;
    scheduleWorkspaceSave();
  }
}

async function createDetachedWindow(title = "wterm", transferToken?: string): Promise<void> {
  await invoke("create_detached_window", {
    label: `wterm-${crypto.randomUUID()}`,
    title,
    transferToken: transferToken ?? null,
  });
}

function detachSessionFrontend(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.manualClose = true;
  session.reconnecting = false;
  session.zmodem?.dispose();
  session.unlisteners.forEach(unlisten => unlisten());
  session.term.dispose();
  session.pane.remove();
  sessions.delete(id);
  broadcastSessionIds.delete(id);
  sftp.onSessionClosed(id);
  const tab = ownerOf(id);
  if (tab) {
    const root = removeLeaf(tab.root, id);
    if (root) {
      tab.root = root;
      if (tab.focused === id) tab.focused = leaves(root)[0];
    } else {
      workspaceTabs.splice(workspaceTabs.indexOf(tab), 1);
    }
  }
  if (activeId === id) activeId = workspaceTabs[0]?.focused ?? null;
  rebuildLayout();
  if (activeId) activateSession(activeId);
  renderTabs();
}

async function moveSessionToNewWindow(session: TermSession): Promise<void> {
  if (session.status === "closed") return;
  const token = crypto.randomUUID();
  const payload: SessionTransferPayload = {
    id: session.id,
    title: session.title,
    status: session.status,
    profile: session.profile,
    localShell: session.localShell,
    cwd: session.cwd,
    screen: session.serialize.serialize(),
  };
  const key = `wterm_transfer_${token}`;
  configStorage.setItem(key, JSON.stringify(payload));
  let stopAck: (() => void) | undefined;
  stopAck = await listen<{ token: string; id: string }>("wterm-session-adopted", event => {
    if (event.payload.token !== token || event.payload.id !== session.id) return;
    stopAck?.();
    configStorage.removeItem(key);
    detachSessionFrontend(session.id);
  });
  try {
    await createDetachedWindow(session.title, token);
  } catch (error) {
    stopAck?.();
    configStorage.removeItem(key);
    throw error;
  }
}

async function adoptTransferredSession(token: string): Promise<boolean> {
  const key = `wterm_transfer_${token}`;
  const raw = configStorage.getItem(key);
  if (!raw) return false;
  let payload: SessionTransferPayload;
  try { payload = JSON.parse(raw) as SessionTransferPayload; }
  catch { return false; }
  const pane = document.createElement("div");
  pane.className = "term-pane active";
  termArea.appendChild(pane);
  const { term, fit, search, serialize } = createTerminal(pane);
  const session: TermSession = {
    id: payload.id,
    title: payload.title,
    term,
    fit,
    search,
    serialize,
    pane,
    status: payload.status,
    unlisteners: [],
    profile: payload.profile,
    localShell: payload.localShell,
    cwd: payload.cwd,
  };
  registerSession(session);
  activateSession(session.id);
  if (payload.screen) term.write(payload.screen);
  await bindSessionIO(session, event => {
    renderTabs();
    if (event === "closed" && session.profile) void autoReconnectSsh(session, session.profile);
  });
  watchTitle(session, title => { session.title = title; renderTabs(); });
  configStorage.removeItem(key);
  await emit("wterm-session-adopted", { token, id: session.id });
  return true;
}
termArea.addEventListener("focusin", (event) => {
  const session = [...sessions.values()].find(s => s.pane.contains(event.target as Node));
  if (session && session.id !== activeId) activateSession(session.id);
});

document.querySelector('#split-broadcast')!.addEventListener('click', () => {
 if (broadcastEnabled) { broadcastEnabled = false; broadcastSessionIds.clear(); }
 else {
  const tab = ownerOf(activeId); if (!tab) return;
  const ids = leaves(tab.root).filter(id => sessions.get(id)?.status === 'connected');
  if (ids.length < 2) { alert('广播输入至少需要两个已连接窗格'); return; }
  broadcastSessionIds.clear(); ids.forEach(id => broadcastSessionIds.add(id)); broadcastEnabled = true;
 }
 updateBroadcastButton(); if (activeId) sessions.get(activeId)?.term.focus();
});
function recentConnections(): SshProfile[] {
 try { const value = JSON.parse(configStorage.getItem('wterm_recent_connections') || '[]'); return Array.isArray(value) ? value.filter(p => p && typeof p.host === 'string' && typeof p.name === 'string').slice(0, 5) : []; } catch { return []; }
}
function rememberConnection(profile: SshProfile): void {
 configStorage.setItem('wterm_recent_connections', JSON.stringify([profile, ...recentConnections().filter(p => !sameSshAccount(p, profile))].slice(0, 5)));
}
// ---------- 标签栏 ----------

function renderTabs(): void {
 const button = document.querySelector<HTMLButtonElement>('#split-broadcast')!;
 const currentTab = ownerOf(activeId);
 button.hidden = !currentTab || leaves(currentTab.root).length < 2;
 button.textContent = broadcastEnabled ? '停止广播' : '广播输入';
 button.setAttribute('aria-pressed', String(broadcastEnabled));
  tabsEl.innerHTML = "";
  tabsEl.classList.toggle("dense", workspaceTabs.length >= 7);
  tabsEl.classList.toggle("very-dense", workspaceTabs.length >= 12);
  for (const tab of workspaceTabs) {
    const s = sessions.get(tab.focused)!;
    const el = document.createElement("div");
    const isActive = tab === ownerOf(activeId);
    el.className = "tab" + (isActive ? " active" : "") + (s.activity && !isActive ? " has-activity" : "");
    el.dataset.sid = tab.id;
    if (s.profile?.color) { el.classList.add("profile-colored"); el.style.setProperty("--profile-color", s.profile.color); }
    el.innerHTML = `
      <span class="dot ${s.status}"></span>
      <span class="label"></span>
      <span class="close" title="关闭">×</span>
    `;
    el.querySelector<HTMLSpanElement>(".label")!.textContent = s.title;
    if (s.profile?.group) {
      const group = document.createElement("span"); group.className = "tab-group"; group.textContent = s.profile.group;
      el.querySelector(".close")!.before(group);
    }
    el.onclick = () => activateSession(s.id);
    el.oncontextmenu = e => showTabMenu(e, s);

    // 4. 鼠标中键 (Middle Click) 关闭标签页
    el.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void destroyTab(tab);
      }
    };

    el.querySelector<HTMLSpanElement>(".close")!.onclick = (e) => {
      e.stopPropagation();
      void destroyTab(tab);
    };

    tabsEl.appendChild(el);
  }
  refreshTabDrag();
  requestAnimationFrame(() => tabsEl.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  scheduleWorkspaceSave();
}

tabsEl.addEventListener("wheel", event => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
  event.preventDefault();
  tabsEl.scrollLeft += event.deltaY;
}, { passive: false });

/**
 * 精确 fit：不用 FitAddon 的 proposeDimensions（它读 getComputedStyle 的 border-box 高度，
 * 会把 .term-pane 的 padding 算进可用高度/宽度，导致 rows/cols 比实际可视区域多出最多 1 行 2 列，
 * 全屏等特定尺寸下最后一行被裁、右侧内容超出）。
 * term.resize 会触发 onResize → resize_session，同步到本地 PTY / SSH 远端。
 */
function fitSession(s: TermSession): void {
  const { cols, rows } = paneDimensions(s.pane, s.term);
  if (cols !== s.term.cols || rows !== s.term.rows) s.term.resize(cols, rows);
}

function fitVisible(): void {
  const tab = ownerOf(activeId);
  if (tab) leaves(tab.root).forEach(id => { const s = sessions.get(id); if (s) fitSession(s); });
}
new ResizeObserver(() => requestAnimationFrame(fitVisible)).observe(termArea);

function rebuildLayout(): void {
  // Move existing terminal nodes; never recreate xterm or its PTY when rearranging.
  for (const s of sessions.values()) s.pane.remove();
  termArea.replaceChildren();
  const build = (node: Layout, tab: WorkspaceTab): HTMLElement => {
    if ('sid' in node) {
      const s = sessions.get(node.sid)!;
      const cell = document.createElement('div');
      cell.className = 'pane-cell'; cell.dataset.sid = s.id;
      const grip = document.createElement('button'); grip.className = 'pane-grip'; grip.draggable = true;
      grip.textContent = '⠿'; grip.title = '拖动交换窗格'; grip.setAttribute('aria-label', '拖动交换窗格');
      grip.ondragstart = e => { e.dataTransfer?.setData('text/wterm-pane-id', s.id); };
      cell.ondragover = e => { if (e.dataTransfer?.types.includes('text/wterm-pane-id')) e.preventDefault(); };
      cell.ondrop = e => {
        e.preventDefault(); const source = e.dataTransfer?.getData('text/wterm-pane-id');
        if (source && source !== s.id && leaves(tab.root).includes(source)) { swapLeaves(tab.root, source, s.id); rebuildLayout(); activateSession(source); }
      };
      if (leaves(tab.root).length > 1) cell.append(grip);
      cell.append(s.pane); return cell;
    }
    const branch = document.createElement('div'); branch.className = `split-node split-${node.direction}`;
    const first = build(node.first, tab), second = build(node.second, tab);
    const divider = document.createElement('div'); divider.className = 'split-divider'; divider.tabIndex = 0;
    divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', '调整分屏比例');
    divider.setAttribute('aria-orientation', node.direction === 'h' ? 'vertical' : 'horizontal');
    const apply = () => {
      first.style.flex = `${node.ratio} 1 0`; second.style.flex = `${1 - node.ratio} 1 0`;
      divider.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
      requestAnimationFrame(fitVisible);
    };
    divider.onpointerdown = e => { if (e.button === 0) { e.preventDefault(); divider.setPointerCapture(e.pointerId); } };
    divider.onpointermove = e => {
      if (!divider.hasPointerCapture(e.pointerId)) return;
      const rect = branch.getBoundingClientRect();
      node.ratio = Math.max(.1, Math.min(.9, node.direction === 'h' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height)); apply();
    };
    divider.onpointerup = e => {
      if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId);
      scheduleWorkspaceSave();
    };
    divider.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); node.ratio = Math.max(.1, Math.min(.9, node.ratio + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -.05 : .05))); apply();
    };
    divider.ondblclick = () => { node.ratio = .5; apply(); scheduleWorkspaceSave(); };
    branch.append(first, divider, second); apply(); return branch;
  };
  for (const tab of workspaceTabs) {
    const root = build(tab.root, tab); root.classList.add('workspace-root'); root.dataset.tab = tab.id; termArea.append(root);
  }
  updatePanesVisibility();
}
function updatePanesVisibility(): void {
  const tab = ownerOf(activeId);
  termArea.querySelectorAll<HTMLElement>('.workspace-root').forEach(root => { root.hidden = root.dataset.tab !== tab?.id; });
  for (const s of sessions.values()) {
    s.pane.classList.toggle('active', !!tab && leaves(tab.root).includes(s.id));
    s.pane.parentElement?.classList.toggle('focused', s.id === activeId);
  }

  requestAnimationFrame(fitVisible);
}
async function toggleSplitScreen(direction: 'h' | 'v' = 'h'): Promise<void> {
  const tab = ownerOf(activeId), source = activeId && sessions.get(activeId);
  if (!tab || !source || layoutBusy) return;
  layoutBusy = true;
  try {
    const target = { tab, sid: source.id, direction };
    if (source.profile) {
      if (source.status !== 'connected') return;
      await newSshSessionOnExisting(source, target);
    } else await newLocalSession(source.localShell ?? undefined, undefined, target);
  } finally { layoutBusy = false; }
}
async function setGrid(count: number): Promise<void> {
  const tab = ownerOf(activeId);
  if (!tab || layoutBusy) return;
  if (leaves(tab.root).length > count) { alert('现有窗格多于目标布局；请先关闭多余窗格，避免丢失会话。'); return; }
  while (workspaceTabs.includes(tab) && leaves(tab.root).length < count) {
    const previous = leaves(tab.root).length;
    activateSession(tab.focused); await toggleSplitScreen('h');
    if (leaves(tab.root).length === previous) return;
  }
  if (!workspaceTabs.includes(tab)) return;
  tab.root = grid(leaves(tab.root), count === 3 ? 3 : Math.sqrt(count)); rebuildLayout();
}
async function destroyTab(tab: WorkspaceTab): Promise<void> {
  for (const sid of leaves(tab.root)) await destroySession(sid);
}
function activateSession(id: string): void {
  if (!sessions.has(id)) return;
  activeId = id;
  const tab = ownerOf(id); if (tab) tab.focused = id;

  updatePanesVisibility();

  const s = sessions.get(id);
  if (s) {
    s.activity = false;
    requestAnimationFrame(() => {
      if (activeId !== id || !sessions.has(id)) return;
      fitSession(s);
      s.term.focus();
    });
  }
  // SFTP 面板跟随激活会话：SSH 会话则切换绑定，本地会话则收起
  if (sftp.boundSession() !== null) {
    if (s?.profile && sftp.boundSession() !== id) {
      void sftp.openFor(id);
    } else if (!s?.profile) {
      sftp.close();
    }
  }
  renderTabs();
}

async function destroySession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  s.manualClose = true;
  s.reconnecting = false;
  await closeSession(id);
  s.zmodem?.dispose();
  s.unlisteners.forEach((u) => u());
  s.term.dispose();
  s.pane.remove();
  sessions.delete(id);
  broadcastSessionIds.delete(id);
  if (broadcastSessionIds.size < 2) broadcastEnabled = false;
  updateBroadcastButton();
  sftp.onSessionClosed(id);

  const tab = ownerOf(id);
  if (tab) {
    const root = removeLeaf(tab.root, id);
    if (root) { tab.root = root; if (tab.focused === id) tab.focused = leaves(root)[0]; }
    else workspaceTabs.splice(workspaceTabs.indexOf(tab), 1);
  }
  if (activeId === id) activeId = (tab && workspaceTabs.includes(tab) ? tab : workspaceTabs[0])?.focused ?? null;
  rebuildLayout();
  if (activeId) activateSession(activeId);
  renderTabs();
}

/** 标题栏「文件」按钮：为当前 SSH 会话开/关 SFTP 面板 */
async function toggleSftpPanel(): Promise<void> {
  if (!activeId) {
    alert("请先选择或连接一个 SSH 会话");
    return;
  }
  if (sftp.boundSession() === activeId) {
    sftp.close();
    return;
  }
  const s = sessions.get(activeId);
  if (!s) return;
  const isSsh = await invoke<boolean>("session_is_ssh", { sid: activeId }).catch(() => false);
  if (isSsh) {
    await sftp.openFor(activeId);
  } else {
    sftp.close();
    alert("当前不是 SSH 会话，SFTP 文件功能仅在 SSH 会话下可用");
  }
}

// ---------- 会话创建 ----------

async function newLocalSession(shellCmd?: string, shellTitle?: string, target?: { tab: WorkspaceTab; sid: string; direction: 'h' | 'v' }, cwd?: string, history?: SessionHistory): Promise<void> {
  const id = `${windowSessionPrefix}-s${++counter}`;
  const pane = document.createElement("div");
  // 先置为可见，否则 fit 量不到真实尺寸（proposeDimensions 会返回 NaN）
  pane.className = "term-pane active";
  for (const s of sessions.values()) s.pane.classList.remove("active");
  termArea.appendChild(pane);
  const { term, fit, search, serialize } = createTerminal(pane);

  const finalCmd = shellCmd || getDefaultShellCommand() || null;
  const finalTitle = shellTitle || (finalCmd ? finalCmd.split(/[/\\]/).pop()?.replace(/\.exe$/i, "") : "本地终端") || "本地终端";

  const session: TermSession = {
    id, title: finalTitle, term, fit, search, serialize, pane,
    status: "connecting", unlisteners: [], localShell: finalCmd, cwd,
  };
  registerSession(session, target);
  activateSession(id);
  await restoreHistory(session, history);
  await bindSessionIO(session, () => renderTabs());
  watchTitle(session, (t) => { session.title = t; renderTabs(); });
  if (!sessions.has(id)) { session.unlisteners.forEach(unlisten => unlisten()); return; }

  try {
    session.localShell = await spawnLocal(id, paneDimensions(pane, term), finalCmd, cwd ?? null);
    if (!sessions.has(id)) { await closeSession(id); return; }
    session.status = "connected";
  } catch (e) {
    if (!sessions.has(id)) return;
    term.write(`\x1b[31m启动失败: ${e}\x1b[0m\r\n`);
    session.status = "closed";
    report(`spawnLocal 失败: ${String(e)}`);
  }
  renderTabs();
}

export async function tryReuseSshProfile(profile: SshProfile, history?: SessionHistory): Promise<boolean> {
  const live = [...sessions.values()].find(s => s.profile && sameSshAccount(s.profile, profile) && s.status === "connected");
  if (live) { await newSshSessionOnExisting(live, undefined, history); return true; }
  const pending = [...sessions.values()].find(s => s.profile && sameSshAccount(s.profile, profile) && s.status === "connecting");
  if (pending) { activateSession(pending.id); return true; }
  return false;
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, ms)); }
async function autoReconnectSsh(session: TermSession, profile: SshProfile, password?: string, passphrase?: string): Promise<void> {
  if (!profile.auto_reconnect || session.manualClose || session.reconnecting || !sessions.has(session.id)) return;
  session.reconnecting = true;
  const maxAttempts = Math.max(1, Math.min(profile.reconnect_attempts ?? 5, 20));
  const baseDelay = Math.max(1, Math.min(profile.reconnect_delay_secs ?? 3, 60));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (session.manualClose || !sessions.has(session.id)) break;
    session.reconnectAttempt = attempt;
    session.status = "connecting";
    renderTabs();
    const delay = Math.min(baseDelay * attempt, 30);
    session.term.write(`\r\n\x1b[33m[SSH] 连接断开，将在 ${delay}s 后自动重连（${attempt}/${maxAttempts}）…\x1b[0m\r\n`);
    await closeSession(session.id);
    await sleep(delay * 1000);
    if (session.manualClose || !sessions.has(session.id)) break;
    try {
      await spawnSsh(session.id, paneDimensions(session.pane, session.term), {
        host: profile.host, port: profile.port, username: profile.username,
        password: profile.auth === "password" ? password ?? null : null,
        privateKey: profile.identity_file ?? null, passphrase: passphrase ?? null,
        keepaliveSecs: profile.keepalive_secs ?? 30,
        auth: profile.auth, proxyJump: profile.proxy_jump ?? null,
      });
      if (session.manualClose || !sessions.has(session.id)) { await closeSession(session.id); break; }
      session.status = "connected";
      session.reconnectAttempt = 0;
      session.reconnecting = false;
      session.term.write("\r\n\x1b[32m[SSH] 已自动重连\x1b[0m\r\n");
      rememberConnection(profile);
    if (profile.login_script?.trim()) await invoke("write_session", { id: session.id, data: profile.login_script.trimEnd() + "\r" });
      renderTabs();
      return;
    } catch (error) {
      session.term.write(`\x1b[31m[SSH] 自动重连失败: ${error}\x1b[0m\r\n`);
    }
  }
  session.reconnecting = false;
  session.status = "closed";
  session.term.write("\r\n\x1b[31m[SSH] 自动重连已停止，可从标签右键手动重连。\x1b[0m\r\n");
  renderTabs();
}

export async function newSshSession(profile: SshProfile, password?: string, passphrase?: string, history?: SessionHistory): Promise<void> {
  if (await tryReuseSshProfile(profile, history)) return;
  const id = `${windowSessionPrefix}-s${++counter}`;
  const pane = document.createElement("div");
  // 同 newLocalSession：先可见，保证尺寸测量有效
  pane.className = "term-pane active";
  for (const s of sessions.values()) s.pane.classList.remove("active");
  termArea.appendChild(pane);
  const { term, fit, search, serialize } = createTerminal(pane);

  const session: TermSession = {
    id, title: profile.name, term, fit, search, serialize, pane,
    status: "connecting", unlisteners: [], profile,
  };
  registerSession(session);
  activateSession(id);
  await restoreHistory(session, history);
  term.write(`\x1b[90m正在连接 ${profile.username}@${profile.host}...\x1b[0m\r\n`);
  await bindSessionIO(session, event => {
    renderTabs();
    if (event === "closed") void autoReconnectSsh(session, profile, password, passphrase);
  });
  if (!sessions.has(id)) { session.unlisteners.forEach(unlisten => unlisten()); return; }

  try {
    await spawnSsh(id, paneDimensions(pane, term), {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.auth === "password" ? password ?? null : null,
      privateKey: profile.identity_file ?? null,
      passphrase: passphrase ?? null,
      keepaliveSecs: profile.keepalive_secs ?? 30,
        auth: profile.auth, proxyJump: profile.proxy_jump ?? null,
    });
    if (!sessions.has(id)) { await closeSession(id); return; }
    session.status = "connected";
    rememberConnection(profile);
    if (profile.login_script?.trim()) await invoke("write_session", { id, data: profile.login_script.trimEnd() + "\r" });
  } catch (e) {
    term.write(`\x1b[31m连接失败: ${e}\x1b[0m\r\n`);
    session.status = "closed";
  }
  renderTabs();
}

/** 复用现有 SSH 会话的通道建立新会话 */
export async function newSshSessionOnExisting(sourceSession: TermSession, target?: { tab: WorkspaceTab; sid: string; direction: 'h' | 'v' }, history?: SessionHistory): Promise<void> {
  if (!sourceSession.profile) return;
  const profile = sourceSession.profile;
  const id = `${windowSessionPrefix}-s${++counter}`;
  const pane = document.createElement("div");
  pane.className = "term-pane active";
  for (const s of sessions.values()) s.pane.classList.remove("active");
  termArea.appendChild(pane);
  const { term, fit, search, serialize } = createTerminal(pane);

  const session: TermSession = {
    id, title: `${profile.name} (复用)`, term, fit, search, serialize, pane,
    status: "connecting", unlisteners: [], profile,
  };
  registerSession(session, target);
  activateSession(id);
  await restoreHistory(session, history);
  term.write(`\x1b[90m正在复用连接 ${profile.username}@${profile.host} 打开新终端...\x1b[0m\r\n`);
  await bindSessionIO(session, () => renderTabs());
  if (!sessions.has(id)) { session.unlisteners.forEach(unlisten => unlisten()); return; }

  try {
    await spawnSshOnExisting(sourceSession.id, id, paneDimensions(pane, term));
    if (!sessions.has(id)) { await closeSession(id); return; }
    session.status = "connected";
    rememberConnection(profile);
    if (profile.login_script?.trim()) await invoke("write_session", { id, data: profile.login_script.trimEnd() + "\r" });
  } catch (e) {
    term.write(`\x1b[31m复用连接失败: ${e}\x1b[0m\r\n服务器可能限制同一连接的通道数。没有自动重新认证；可关闭旧连接后重试。\r\n`);
    session.status = "closed";
  }
  renderTabs();
}

import {
  showNewSshDialog,
  showProfilesManager,
  connectProfile,
  showSettingsDialog,
  getDefaultShellCommand,
  type ImportedHost,
  type ShellInfo,
} from "./profiles";
import { showImportDialog } from "./sshimport";
import * as sftp from "./sftp";

// ---------- 下拉菜单：+ 号按钮 ----------

let currentMenu: HTMLDivElement | null = null;
let shellListPromise: Promise<ShellInfo[]> | undefined;
let hostListPromise: Promise<ImportedHost[]> | undefined;
export function invalidateProfileMenu(): void { hostListPromise = undefined; }
let hostsReadAt = 0;
function loadMenuData() {
  shellListPromise ??= invoke<ShellInfo[]>("list_available_shells").catch(() => { shellListPromise = undefined; return []; });
  if (!hostListPromise || Date.now() - hostsReadAt > 10_000) {
    hostsReadAt = Date.now();
    hostListPromise = invoke<ImportedHost[]>("scan_ssh_config").catch(() => { hostListPromise = undefined; return []; });
  }
  return Promise.all([shellListPromise, hostListPromise]);
}

function positionMenu(menu: HTMLElement, left: number, top: number): void {
  const width = Math.min(320, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 100))}px`;
  menu.style.maxHeight = `${Math.max(80, window.innerHeight - parseFloat(menu.style.top) - 8)}px`;
}

type MenuActionOptions = { icon?: string; detail?: string; disabled?: boolean; id?: string };
function appendMenuAction(parent: HTMLElement, label: string, action: () => void | Promise<void>, options: MenuActionOptions = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item";
  if (options.id) button.id = options.id;
  button.disabled = !!options.disabled;
  const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = options.icon ?? "";
  const meta = document.createElement("span"); meta.className = "meta";
  const title = document.createElement("span"); title.className = "title"; title.textContent = label;
  meta.append(title);
  if (options.detail) {
    const detail = document.createElement("span"); detail.className = "subtitle"; detail.textContent = options.detail; meta.append(detail);
  }
  button.append(icon, meta);
  button.onclick = event => {
    event.stopPropagation();
    if (button.disabled) return;
    closeCurrentMenu();
    void action();
  };
  parent.append(button);
  return button;
}

function appendNestedMenu(parent: HTMLElement, label: string, iconText: string, build: (child: HTMLElement) => void): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "menu-nested-wrap";
  const button = document.createElement("button"); button.type = "button"; button.className = "menu-item menu-parent";
  const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = iconText;
  const title = document.createElement("span"); title.className = "meta title"; title.textContent = label;
  const caret = document.createElement("span"); caret.className = "menu-caret"; caret.textContent = "›";
  button.append(icon, title, caret);
  const child = document.createElement("div"); child.className = "menu-nested"; child.hidden = true;
  build(child);
  button.onclick = event => {
    event.stopPropagation();
    child.hidden = !child.hidden;
    button.classList.toggle("expanded", !child.hidden);
  };
  wrap.append(button, child); parent.append(wrap);
  return wrap;
}

function appendDivider(parent: HTMLElement): void {
  const divider = document.createElement("div"); divider.className = "menu-divider"; parent.append(divider);
}

function appendSplitMenu(parent: HTMLElement, session: TermSession): void {
  appendNestedMenu(parent, "分屏", "▦", splitMenu => {
    appendMenuAction(splitMenu, "左右拆分", () => { activateSession(session.id); return toggleSplitScreen("h"); }, { icon: "↔" });
    appendMenuAction(splitMenu, "上下拆分", () => { activateSession(session.id); return toggleSplitScreen("v"); }, { icon: "↕" });
    appendNestedMenu(splitMenu, "一键分屏", "⊞", quickMenu => {
      appendMenuAction(quickMenu, "三列", () => { activateSession(session.id); return setGrid(3); }, { icon: "Ⅲ" });
      appendMenuAction(quickMenu, "四宫格", () => { activateSession(session.id); return setGrid(4); }, { icon: "▦" });
      appendMenuAction(quickMenu, "九宫格", () => { activateSession(session.id); return setGrid(9); }, { icon: "▦" });
    });
  });
}

function showTabMenu(event: MouseEvent, session: TermSession): void {
  event.preventDefault();
  event.stopPropagation();
  closeCurrentMenu();
  const menu = document.createElement("div");
  menu.className = "menu-dropdown tab-context-menu";
  const duplicate = document.createElement("button");
  duplicate.className = "menu-item";
  duplicate.textContent = session.profile ? "复制终端（复用 SSH 连接）" : "复制终端（相同 Shell）";
  duplicate.disabled = !!session.profile && session.status !== "connected";
  duplicate.onclick = () => {
    closeCurrentMenu();
    if (session.profile) void newSshSessionOnExisting(session);
    else void newLocalSession(session.localShell ?? undefined);
  };
  menu.append(duplicate);
  appendDivider(menu);
  appendSplitMenu(menu, session);
  appendMenuAction(menu, "移到新窗口", () => moveSessionToNewWindow(session), {
    icon: "↗",
    detail: "保持当前 PTY / SSH 后端会话",
    disabled: session.status === "closed",
  });
  appendMenuAction(menu, "打开当前目录", () => { activateSession(session.id); return openCurrentDirectory(session); }, {
    icon: "▱",
    detail: session.profile ? "远程连接（不可用）" : (session.cwd || "等待 Shell 上报当前目录"),
    disabled: !!session.profile || !session.cwd,
  });
  if (session.profile && session.status === "closed") {
    appendMenuAction(menu, "重新连接（新标签）", () => connectProfile(session.profile!), { icon: "↻" });
  }
  appendDivider(menu);
  appendMenuAction(menu, "关闭标签及其窗格", () => {
    const tab = ownerOf(session.id);
    if (tab) return destroyTab(tab);
  }, { icon: "×" });
  positionMenu(menu, event.clientX, event.clientY);
  document.body.append(menu);
  currentMenu = menu;
  duplicate.focus();
}

function closeCurrentMenu(): void {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
  document.querySelector("#btn-add-menu")?.setAttribute("aria-expanded", "false");
  document.querySelector("#btn-app-menu")?.setAttribute("aria-expanded", "false");
}

async function runFavorite(favorite: Favorite): Promise<void> {
  closeCurrentMenu();
  if (favorite.type === "directory") {
    await newLocalSession(undefined, favorite.name, undefined, favorite.value);
    return;
  }
  if (favorite.type === "connection") {
    const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
    const profile = profiles.find(item => item.name === favorite.value);
    if (!profile) { alert(`收藏的连接“${favorite.value}”已不存在，请在收藏管理中更新。`); return; }
    await connectProfile(profile);
    return;
  }

  let session: TermSession | undefined;
  const environment = favorite.scriptEnvironment ?? "current";
  let newlySpawned = false;
  if (environment === "powershell" || environment === "wsl") {
    const [shells] = await loadMenuData();
    const shell = environment === "powershell"
      ? shells.find(item => /^(pwsh|powershell)$/i.test(item.id) || /powershell/i.test(item.name))
      : shells.find(item => /^wsl$/i.test(item.id) || /wsl|bash/i.test(item.name) || /(^|\\)wsl(?:\.exe)?$/i.test(item.command));
    if (!shell) {
      alert(environment === "powershell" ? "未检测到 PowerShell，无法执行该收藏脚本。" : "未检测到 WSL / Bash，无法执行该收藏脚本。");
      return;
    }
    await newLocalSession(shell.command, `${favorite.name} · ${shell.name}`, undefined, favorite.cwd);
    session = activeId ? sessions.get(activeId) : undefined;
    newlySpawned = true;
  } else if (environment === "ssh") {
    const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
    const profile = profiles.find(item => item.name === favorite.scriptTarget);
    if (!profile) { alert(`脚本绑定的远程连接“${favorite.scriptTarget || ""}”已不存在，请在收藏管理中更新。`); return; }
    await connectProfile(profile);
    session = activeId ? sessions.get(activeId) : undefined;
  } else {
    session = activeId ? sessions.get(activeId) : undefined;
    if (!session || session.status !== "connected") {
      await newLocalSession(undefined, undefined, undefined, favorite.cwd);
      session = activeId ? sessions.get(activeId) : undefined;
      newlySpawned = true;
    }
  }

  if (!session || session.status !== "connected") { alert("目标执行环境尚未连接，脚本未执行。"); return; }
  let command = normalizeFavoriteCommand(favorite.value, environment, session.localShell ?? undefined);
  if (favorite.cwd && !newlySpawned) {
    const shellBase = shellBasename(session.localShell ?? undefined);
    const isPwsh = environment === "powershell" || /^(?:pwsh|powershell)(?:\.exe)?$/i.test(shellBase);
    const isCmd = /^(?:cmd|command)(?:\.exe)?$/i.test(shellBase);
    if (isPwsh) {
      command = `Set-Location -LiteralPath '${favorite.cwd.replace(/'/g, "''")}'; ${command}`;
    } else if (isCmd) {
      command = `cd /d "${favorite.cwd.replace(/"/g, '""')}" && ${command}`;
    } else {
      command = `cd '${favorite.cwd.replace(/'/g, "'\\''")}' && ${command}`;
    }
  }
  await invoke("write_session", { id: session.id, data: command + "\r" }).catch(error => alert(`执行收藏脚本失败: ${error}`));
  session.term.focus();
}

async function openFavoritesManager(): Promise<void> {
  const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
  showFavoritesManager(profiles.map(profile => profile.name));
}

async function showBatchDialog(): Promise<void> {
  closeCurrentMenu();
  const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
  const mask = document.createElement("div"); mask.className = "dialog-mask";
  const dialog = document.createElement("div"); dialog.className = "dialog batch-dialog";
  const title = document.createElement("h2"); title.textContent = "批量连接与广播输入";
  const hint = document.createElement("p"); hint.className = "setting-hint";
  hint.textContent = "可一次打开多个已保存连接；广播开启后，在广播组任一终端输入都会同步发送到组内其他已连接会话。执行破坏性命令前请确认目标。";
  const profileTitle = document.createElement("h3"); profileTitle.className = "batch-section-title"; profileTitle.textContent = "批量打开连接";
  const profileList = document.createElement("div"); profileList.className = "batch-list";
  if (!profiles.length) { profileList.textContent = "暂无已保存 SSH Profile"; profileList.classList.add("favorites-empty"); }
  for (const profile of profiles) {
    const label = document.createElement("label"); label.className = "batch-row";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.profile = profile.name;
    const text = document.createElement("span"); text.textContent = `${profile.name} · ${profile.username}@${profile.host}:${profile.port}${profile.group ? " · " + profile.group : ""}`;
    label.append(checkbox, text); profileList.append(label);
  }
  const connectButton = document.createElement("button"); connectButton.className = "btn primary"; connectButton.textContent = "打开所选连接";
  const activeTitle = document.createElement("h3"); activeTitle.className = "batch-section-title"; activeTitle.textContent = "广播组";
  const activeList = document.createElement("div"); activeList.className = "batch-list";
  const renderActive = () => {
    activeList.replaceChildren();
    const active = [...sessions.values()].filter(session => session.status === "connected");
    if (!active.length) { const empty=document.createElement("div"); empty.className="favorites-empty"; empty.textContent="暂无已连接会话"; activeList.append(empty); return; }
    for (const session of active) {
      const label = document.createElement("label"); label.className = "batch-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.session = session.id; checkbox.checked = broadcastSessionIds.has(session.id);
      const text = document.createElement("span"); text.textContent = session.profile ? `${session.title} · ${session.profile.username}@${session.profile.host}` : session.title;
      label.append(checkbox, text); activeList.append(label);
    }
  };
  renderActive();
  const broadcastToggle = document.createElement("label"); broadcastToggle.className = "batch-toggle";
  const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = broadcastEnabled;
  broadcastToggle.append(enabled, document.createTextNode(" 启用广播输入"));
  const actions = document.createElement("div"); actions.className = "dialog-actions";
  const apply = document.createElement("button"); apply.className = "btn primary"; apply.textContent = "应用广播组";
  const close = document.createElement("button"); close.className = "btn"; close.textContent = "关闭";
  actions.append(connectButton, document.createElement("span"), apply, close);
  dialog.append(title, hint, profileTitle, profileList, activeTitle, activeList, broadcastToggle, actions); mask.append(dialog); document.body.append(mask);
  connectButton.onclick = async () => {
    const names = [...profileList.querySelectorAll<HTMLInputElement>("input[data-profile]:checked")].map(input => input.dataset.profile!);
    connectButton.disabled = true;
    for (const name of names) { const profile = profiles.find(item => item.name === name); if (profile) await connectProfile(profile); }
    connectButton.disabled = false;
    renderActive();
  };
  apply.onclick = () => {
    broadcastSessionIds.clear();
    activeList.querySelectorAll<HTMLInputElement>("input[data-session]:checked").forEach(input => broadcastSessionIds.add(input.dataset.session!));
    broadcastEnabled = enabled.checked && broadcastSessionIds.size > 1;
    updateBroadcastButton();
    if (enabled.checked && broadcastSessionIds.size < 2) alert("广播输入至少需要选择 2 个已连接会话");
  };
  close.onclick = () => mask.remove();
  mask.onclick = event => { if (event.target === mask) mask.remove(); };
}

async function showFavoritesMenu(event: MouseEvent): Promise<void> {
  event.stopPropagation();
  closeCurrentMenu();
  const menu = document.createElement("div");
  menu.className = "menu-dropdown favorites-menu";
  const items = listFavorites();
  if (!items.length) {
    const empty = document.createElement("div"); empty.className = "menu-loading"; empty.textContent = "还没有收藏"; menu.append(empty);
  } else {
    for (const favorite of items) {
      const item = document.createElement("button"); item.className = "menu-item favorite-menu-item";
      const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = favoriteIcon(favorite.type);
      const meta = document.createElement("span"); meta.className = "meta";
      const title = document.createElement("span"); title.className = "title"; title.textContent = favorite.name;
      const subtitle = document.createElement("span"); subtitle.className = "subtitle"; subtitle.textContent = favoriteTypeLabel(favorite.type) + " · " + favorite.value;
      meta.append(title, subtitle); item.append(icon, meta);
      item.onclick = () => void runFavorite(favorite); menu.append(item);
    }
    const divider = document.createElement("div"); divider.className = "menu-divider"; menu.append(divider);
  }
  const manage = document.createElement("button"); manage.className = "menu-item"; manage.textContent = "☆ 管理收藏…";
  manage.onclick = () => { closeCurrentMenu(); void openFavoritesManager(); }; menu.append(manage);
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  positionMenu(menu, rect.left, rect.bottom + 4);
  document.body.append(menu); currentMenu = menu;
}

interface PaletteItem { label: string; detail: string; keywords: string; run: () => void | Promise<void>; }
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const haystack = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1000 - direct;
  let at = 0, score = 0, streak = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return -1;
    streak = found === at ? streak + 1 : 0;
    score += 10 + streak * 4 - Math.min(found - at, 5);
    at = found + 1;
  }
  return score;
}

async function showCommandPalette(): Promise<void> {
  const previous = document.querySelector<HTMLElement>(".command-palette-mask");
  if (previous) { previous.querySelector<HTMLInputElement>("input")?.focus(); return; }
  closeCurrentMenu();
  const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
  const commands: PaletteItem[] = [
    { label: "新建本地终端", detail: "Ctrl+Shift+T", keywords: "new local terminal shell", run: () => newLocalSession() },
    { label: "左右拆分当前窗格", detail: "Ctrl+Shift+D", keywords: "split horizontal", run: () => toggleSplitScreen("h") },
    { label: "上下拆分当前窗格", detail: "Ctrl+Shift+E", keywords: "split vertical", run: () => toggleSplitScreen("v") },
    { label: "三窗格布局", detail: "3 panes", keywords: "layout grid", run: () => setGrid(3) },
    { label: "四宫格布局", detail: "4 panes", keywords: "layout grid", run: () => setGrid(4) },
    { label: "九宫格布局", detail: "9 panes", keywords: "layout grid", run: () => setGrid(9) },
    { label: "搜索当前终端", detail: "Ctrl+F", keywords: "search terminal", run: () => toggleSearchBar() },
    { label: "连接管理", detail: "树形分组 / 拖拽", keywords: "ssh profile connection tree", run: () => showProfilesManager() },
    { label: "管理收藏", detail: "目录 / 脚本 / 连接", keywords: "favorite bookmark", run: () => openFavoritesManager() },
    { label: "远程文件", detail: "SFTP", keywords: "sftp remote file", run: () => toggleSftpPanel() },
    { label: "批量连接 / 广播", detail: "Broadcast", keywords: "batch broadcast", run: () => showBatchDialog() },
    { label: "新建窗口", detail: "Ctrl+Shift+N", keywords: "new window detach", run: () => createDetachedWindow() },
    { label: "偏好设置", detail: "Ctrl+,", keywords: "settings preferences", run: () => showSettingsDialog() },
  ];
  for (const profile of profiles) commands.push({
    label: "连接 · " + profile.name,
    detail: profile.username + "@" + profile.host + ":" + profile.port + (profile.group ? " · " + profile.group : ""),
    keywords: "ssh " + (profile.tags || []).join(" ") + " " + (profile.group || ""),
    run: () => connectProfile(profile),
  });
  for (const favorite of listFavorites()) commands.push({
    label: "收藏 · " + favorite.name,
    detail: favoriteTypeLabel(favorite.type) + (favorite.cwd ? ` · ${favorite.cwd}` : "") + " · " + favorite.value,
    keywords: "favorite " + favorite.type + " " + (favorite.cwd || ""),
    run: () => runFavorite(favorite),
  });

  const mask = document.createElement("div"); mask.className = "command-palette-mask";
  const palette = document.createElement("div"); palette.className = "command-palette";
  const input = document.createElement("input"); input.className = "command-palette-input"; input.placeholder = "输入命令、连接、分组、标签或收藏…"; input.setAttribute("aria-label", "命令面板搜索");
  const results = document.createElement("div"); results.className = "command-palette-results";
  palette.append(input, results); mask.append(palette); document.body.append(mask);
  let visible: PaletteItem[] = [], selected = 0;
  const render = () => {
    const query = input.value.trim();
    visible = commands.map(item => ({ item, score: fuzzyScore(item.label + " " + item.detail + " " + item.keywords, query) }))
      .filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 14).map(entry => entry.item);
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    results.replaceChildren();
    if (!visible.length) { const empty = document.createElement("div"); empty.className = "command-palette-empty"; empty.textContent = "没有匹配项"; results.append(empty); return; }
    visible.forEach((item, index) => {
      const row = document.createElement("button"); row.className = "command-palette-item" + (index === selected ? " selected" : "");
      const label = document.createElement("span"); label.className = "command-label"; label.textContent = item.label;
      const detail = document.createElement("span"); detail.className = "command-detail"; detail.textContent = item.detail;
      row.append(label, detail);
      row.onmouseenter = () => {
        selected = index;
        [...results.querySelectorAll<HTMLElement>(".command-palette-item")]
          .forEach((node, itemIndex) => node.classList.toggle("selected", itemIndex === selected));
      };
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => { mask.remove(); void item.run(); };
      results.append(row);
    });
  };
  input.oninput = () => { selected = 0; render(); };
  input.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); mask.remove(); sessions.get(activeId || "")?.term.focus(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length) selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
      render(); return;
    }
    if (event.key === "Enter" && visible[selected]) { event.preventDefault(); const item = visible[selected]; mask.remove(); void item.run(); }
  };
  mask.onmousedown = event => { if (event.target === mask) mask.remove(); };
  render(); input.focus();
}

document.addEventListener("click", (e) => {
  if (currentMenu && !currentMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest("#tab-add-group")) {
    closeCurrentMenu();
  }
});

async function showAddMenu(e: MouseEvent): Promise<void> {
  e.stopPropagation();
  if (currentMenu) {
    const sameMenu = currentMenu.classList.contains("add-menu");
    closeCurrentMenu();
    if (sameMenu) return;
  }

  const btn = e.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement("div");
  menu.className = "menu-dropdown add-menu";
  positionMenu(menu, rect.left, rect.bottom + 4);
  menu.innerHTML = '<div class="menu-loading">正在读取终端与连接…</div>';
  document.body.append(menu);
  currentMenu = menu;
  btn.setAttribute("aria-expanded", "true");
  const [[availableShells, hosts], savedProfiles] = await Promise.all([
    loadMenuData(), invoke<SshProfile[]>('list_ssh_profiles').catch(() => []),
  ]);
  if (currentMenu !== menu) return;
  menu.replaceChildren();

  const recentHeading = document.createElement('div'); recentHeading.className = 'menu-section-title'; recentHeading.textContent = '最近连接'; menu.append(recentHeading);
  const recent = recentConnections();
  if (!recent.length) { const empty = document.createElement('div'); empty.className = 'menu-loading compact'; empty.textContent = '暂无连接记录'; menu.append(empty); }
  for (const profile of recent) appendMenuAction(menu, profile.name, () => connectProfile(profile), { icon: '◷', detail: profile.username + '@' + profile.host + ':' + profile.port });
  // 4. 收藏快捷入口
  const favs = listFavorites();
  if (favs.length) {
    const divFav = document.createElement('div'); divFav.className = 'menu-divider'; menu.append(divFav);
    const favHeading = document.createElement('div'); favHeading.className = 'menu-section-title'; favHeading.textContent = `收藏 (${favs.length})`; menu.append(favHeading);
    for (const fav of favs) {
      const item = document.createElement('div'); item.className = 'menu-item';
      item.innerHTML = `
        <div class="icon">${favoriteIcon(fav.type)}</div>
        <div class="meta">
          <div class="title"></div>
          <div class="subtitle"></div>
        </div>
      `;
      item.querySelector<HTMLDivElement>('.title')!.textContent = fav.name;
      item.querySelector<HTMLDivElement>('.subtitle')!.textContent = favoriteTypeLabel(fav.type) + ' · ' + fav.value;
      item.onclick = () => { closeCurrentMenu(); void runFavorite(fav); };
      menu.append(item);
    }
  }

  // 2. 新建 SSH 连接选项
  const divSsh = document.createElement("div");
  divSsh.className = "menu-divider";
  menu.appendChild(divSsh);

  const newSshItem = document.createElement("div");
  newSshItem.className = "menu-item";
  newSshItem.innerHTML = `
    <div class="icon">➕</div>
    <div class="meta">
      <div class="title">新建自定义 SSH 连接...</div>
    </div>
  `;
  newSshItem.onclick = () => {
    closeCurrentMenu();
    showNewSshDialog();
  };
  menu.appendChild(newSshItem);

  const defaultCmd = getDefaultShellCommand();

  const localSectionTitle = document.createElement("div");
  localSectionTitle.className = "menu-section-title";
  localSectionTitle.textContent = "本地终端 (Local)";
  menu.appendChild(localSectionTitle);

  for (const sh of availableShells) {
    const isDefault = defaultCmd ? sh.command === defaultCmd : (sh.id === "pwsh" || sh.id === "powershell");
    const item = document.createElement("div");
    item.className = "menu-item";
    item.innerHTML = `
      <div class="icon">${sh.icon}</div>
      <div class="meta">
        <div class="title">${sh.name}${isDefault ? " <span style='font-size:10px;opacity:0.7;'>(默认)</span>" : ""}</div>
        <div class="subtitle">${sh.command}</div>
      </div>
    `;
    item.onclick = () => {
      closeCurrentMenu();
      void newLocalSession(sh.command, sh.name);
    };
    menu.appendChild(item);
  }

  // 3.5 已保存连接 + ~/.ssh/config 合并展示（去重）
  const savedNames = new Set(savedProfiles.map(p => p.name));
  const allConnections: Array<{ label: string; detail: string; source: 'saved' | 'config'; connect: () => void }> = [];
  for (const profile of savedProfiles) {
    const group = profile.group ? ` · ${profile.group}` : '';
    const tags = profile.tags?.length ? ` · ${profile.tags.map(tag => '#' + tag).join(' ')}` : '';
    allConnections.push({
      label: profile.name,
      detail: `${profile.username}@${profile.host}:${profile.port}${group}${tags}`,
      source: 'saved',
      connect: () => { closeCurrentMenu(); void connectProfile(profile); },
    });
  }
  for (const h of hosts) {
    if (savedNames.has(h.alias)) continue;
    allConnections.push({
      label: h.alias,
      detail: `${h.username}@${h.host}:${h.port}${h.identity_file ? " 🔑" : ""} [config]`,
      source: 'config',
      connect: () => {
        closeCurrentMenu();
        const profile: SshProfile = {
          name: h.alias, host: h.host, port: h.port, username: h.username,
          auth: h.identity_file ? "key" : "agent",
          identity_file: h.identity_file, proxy_jump: h.proxy_jump,
        };
        connectProfile(profile);
      },
    });
  }
  if (allConnections.length) {
    const heading = document.createElement('div'); heading.className = 'menu-section-title'; heading.textContent = `已保存连接 (${allConnections.length})`; menu.append(heading);
    for (const conn of allConnections) {
      const item = document.createElement('div'); item.className = 'menu-item';
      item.innerHTML = `
        <div class="icon">${conn.source === 'config' ? '⚙️' : '🖥️'}</div>
        <div class="meta">
          <div class="title"></div>
          <div class="subtitle"></div>
        </div>
      `;
      item.querySelector<HTMLDivElement>('.title')!.textContent = conn.label;
      item.querySelector<HTMLDivElement>('.subtitle')!.textContent = conn.detail;
      item.onclick = conn.connect;
      menu.append(item);
    }
  }

  // 3. 检查是否有已连接的活动 SSH 会话可供复用
  const connectedSshSessions = [...sessions.values()].filter(
    (s) => s.status === "connected" && s.profile
  );

  if (connectedSshSessions.length > 0) {
    const divider = document.createElement("div");
    divider.className = "menu-divider";
    menu.appendChild(divider);

    const sectionTitle = document.createElement("div");
    sectionTitle.className = "menu-section-title";
    sectionTitle.textContent = "复用已连接会话 (免密/免MFA)";
    menu.appendChild(sectionTitle);

    for (const actSession of connectedSshSessions) {
      const item = document.createElement("div");
      item.className = "menu-item";
      item.innerHTML = `
        <div class="icon">⚡</div>
        <div class="meta">
          <div class="title"></div>
          <div class="subtitle">复用通道打开新窗口</div>
        </div>
      `;
      item.querySelector<HTMLElement>(".title")!.textContent = actSession.title;
      item.onclick = () => {
        closeCurrentMenu();
        void newSshSessionOnExisting(actSession);
      };
      menu.appendChild(item);
    }
  }

  const importItem = document.createElement("div");
  importItem.className = "menu-item";
  importItem.textContent = "⤓ 导入 SSH 配置…";
  importItem.onclick = () => { closeCurrentMenu(); showImportDialog(); };
  menu.appendChild(importItem);
  const filter = document.createElement("input");
  filter.className = "session-filter";
  filter.placeholder = "搜索会话、主机、用户名…";
  filter.setAttribute("aria-label", "搜索会话");
  menu.prepend(filter);
  filter.oninput = () => {
    const query = filter.value.trim();
    menu.querySelectorAll<HTMLElement>(".menu-item").forEach(item => {
      item.hidden = fuzzyScore(item.textContent || "", query) < 0;
    });
    menu.querySelectorAll<HTMLElement>(".menu-section-title, .menu-divider").forEach(item => { item.hidden = !!query; });
  };
  filter.onkeydown = (event) => {
    if (event.key === "Escape") { closeCurrentMenu(); if (activeId) sessions.get(activeId)?.term.focus(); }
    if (event.key === "Enter") menu.querySelector<HTMLElement>(".menu-item:not([hidden])")?.click();
  };
  document.body.appendChild(menu);
  currentMenu = menu;
  filter.focus();
}

// ---------- 终端内搜索功能 (1.6 搜索) ----------

function toggleSearchBar(): void {
  const searchBar = document.querySelector<HTMLDivElement>("#term-search-bar")!;
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  if (searchBar.style.display === "none") {
    searchBar.style.display = "flex";
    input.focus();
    input.select();
  } else {
    searchBar.style.display = "none";
    if (activeId) { sessions.get(activeId)?.search.clearDecorations(); sessions.get(activeId)?.term.focus(); }
  }
}

function doSearch(forward = true): void {
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  const term = activeId ? sessions.get(activeId) : null;
  if (!term) return;
  const result = document.querySelector<HTMLElement>('#search-result')!;
  if (!input.value) { term.search.clearDecorations(); result.textContent = ''; return; }
  const regex = document.querySelector<HTMLInputElement>('#search-regex')!.checked;
  if (regex) { try { new RegExp(input.value); } catch { result.textContent = '正则无效'; term.search.clearDecorations(); return; } }
  const options = {
    regex, caseSensitive: document.querySelector<HTMLInputElement>('#search-case')!.checked,
    wholeWord: document.querySelector<HTMLInputElement>('#search-word')!.checked,
    decorations: { matchBackground: '#664d00', matchBorder: '#997a00', matchOverviewRuler: '#997a00', activeMatchBackground: '#996600', activeMatchBorder: '#ffcc66', activeMatchColorOverviewRuler: '#ffcc66' },
  };
  const found = forward ? term.search.findNext(input.value, options) : term.search.findPrevious(input.value, options);
  result.textContent = found ? '已匹配' : '无匹配';
}

for (const id of ['search-regex', 'search-case', 'search-word']) document.getElementById(id)!.addEventListener('change', () => doSearch());
document.querySelector("#search-close")!.addEventListener("click", toggleSearchBar);
document.querySelector("#search-next")!.addEventListener("click", () => doSearch(true));
document.querySelector("#search-prev")!.addEventListener("click", () => doSearch(false));
document.querySelector("#search-input")!.addEventListener("input", () => doSearch(true));
document.querySelector("#search-input")!.addEventListener("keydown", (e: any) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doSearch(!e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    toggleSearchBar();
  }
});

document.querySelector("#btn-add")!.addEventListener("click", () => void newLocalSession());
document.querySelector("#btn-add-menu")!.addEventListener("click", (e) => void showAddMenu(e as MouseEvent));
const titlebar = document.querySelector<HTMLElement>(".titlebar")!;
const isTitlebarBlank = (target: EventTarget | null) => target instanceof HTMLElement &&
  !target.closest("button, .tab, input, .search-bar");
titlebar.addEventListener("dblclick", event => {
  if (!isTitlebarBlank(event.target)) return;
  event.preventDefault();
  closeCurrentMenu();
  void getCurrentWindow().toggleMaximize();
});
let dragOrigin: { x: number; y: number } | undefined;
titlebar.addEventListener("pointerdown", event => {
  if (event.button === 0 && isTitlebarBlank(event.target)) dragOrigin = { x: event.clientX, y: event.clientY };
});
window.addEventListener("pointerup", () => { dragOrigin = undefined; });
window.addEventListener("pointermove", event => {
  if (!event.buttons) { dragOrigin = undefined; return; }
  if (dragOrigin && Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) > 5) {
    dragOrigin = undefined;
    void getCurrentWindow().startDragging();
  }
});
document.querySelector("#window-minimize")!.addEventListener("click", () => void getCurrentWindow().minimize());
document.querySelector("#window-maximize")!.addEventListener("click", () => void getCurrentWindow().toggleMaximize());
document.querySelector("#window-close")!.addEventListener("click", () => void getCurrentWindow().close());

async function openCurrentDirectory(session?: TermSession): Promise<void> {
  const s = session ?? (activeId ? sessions.get(activeId) : undefined);
  if (!s || s.profile) return;
  if (!s.cwd) { alert('当前 Shell 尚未报告目录。PowerShell/cmd 自动集成；其他 Shell 可配置 OSC 7 或 OSC 9;9 目录上报。'); return; }
  try { await invoke('open_local_directory', { sid: s.id, path: s.cwd }); }
  catch (error) { alert(`打开目录失败: ${error}`); }
}

async function showAppMenu(event: MouseEvent): Promise<void> {
  event.stopPropagation();
  const trigger = event.currentTarget as HTMLButtonElement;
  if (currentMenu) {
    const sameMenu = currentMenu.classList.contains("app-menu");
    closeCurrentMenu();
    if (sameMenu) return;
  }
  const menu = document.createElement("div"); menu.className = "menu-dropdown app-menu";
  const rect = trigger.getBoundingClientRect();
  positionMenu(menu, rect.left, rect.bottom + 4);
  document.body.append(menu); currentMenu = menu; trigger.setAttribute("aria-expanded", "true");

  const [[availableShells], profiles] = await Promise.all([
    loadMenuData(),
    invoke<SshProfile[]>("list_ssh_profiles").catch(() => []),
  ]);
  if (currentMenu !== menu) return;

  appendNestedMenu(menu, "新建终端", "+", child => {
    for (const shell of availableShells) {
      appendMenuAction(child, shell.name, () => newLocalSession(shell.command, shell.name), { icon: shell.icon, detail: shell.command });
    }
    appendDivider(child);
    appendMenuAction(child, "新建 SSH 连接…", () => showNewSshDialog(), { icon: "↗" });
    appendMenuAction(child, "连接管理…", () => showProfilesManager(), { icon: "▦", detail: "树形分组 / 拖拽" });
    for (const profile of profiles) {
      appendMenuAction(child, profile.name, () => connectProfile(profile), { icon: "●", detail: `${profile.username}@${profile.host}:${profile.port}` });
    }
  });

  appendNestedMenu(menu, "收藏", "★", child => {
    const favorites = listFavorites();
    if (!favorites.length) {
      const empty = document.createElement("div"); empty.className = "menu-loading compact"; empty.textContent = "还没有收藏"; child.append(empty);
    }
    for (const favorite of favorites) {
      const detail = favorite.type === "script"
        ? `${favoriteTypeLabel(favorite.type)} · ${favoriteScriptEnvironmentLabel(favorite.scriptEnvironment, favorite.scriptTarget)}${favorite.cwd ? ` · ${favorite.cwd}` : ""}`
        : favoriteTypeLabel(favorite.type);
      appendMenuAction(child, favorite.name, () => runFavorite(favorite), { icon: favoriteIcon(favorite.type), detail });
    }
    appendDivider(child);
    appendMenuAction(child, "管理收藏…", () => openFavoritesManager(), { icon: "☆", id: "btn-favorites" });
  });

  appendDivider(menu);
  const active = activeId ? sessions.get(activeId) : undefined;
  appendMenuAction(menu, "远程文件 ", () => toggleSftpPanel(), {
    icon: "▤",
    detail: active?.profile ? active.title : "仅 SSH 会话可用",
    disabled: !active?.profile || active.status !== "connected",
    id: "btn-sftp",
  });
  appendMenuAction(menu, "批量连接 / 广播", () => showBatchDialog(), { icon: "⌘", id: "btn-batch" });
  appendMenuAction(menu, "命令面板 ", () => showCommandPalette(), { icon: "⌕", detail: "Ctrl+K" });
  appendMenuAction(menu, "设置", () => showSettingsDialog(), { icon: "⚙", id: "btn-settings" });
}

document.querySelector("#btn-app-menu")!.addEventListener("click", event => void showAppMenu(event as MouseEvent));

termArea.addEventListener("contextmenu", event => {
  if (!event.shiftKey) return;
  const session = [...sessions.values()].find(candidate => candidate.pane.contains(event.target as Node));
  if (!session) return;
  event.preventDefault();
  event.stopPropagation();
  activateSession(session.id);
  closeCurrentMenu();
  const menu = document.createElement("div"); menu.className = "menu-dropdown terminal-context-menu";
  appendMenuAction(menu, "粘贴", async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) session.term.paste(text);
  }, { icon: "⎘" });
  appendMenuAction(menu, "复制", async () => {
    if (session.term.hasSelection()) await navigator.clipboard.writeText(session.term.getSelection()).catch(() => {});
  }, { icon: "⧉", disabled: !session.term.hasSelection() });
  appendDivider(menu);
  appendSplitMenu(menu, session);
  appendMenuAction(menu, "打开当前目录", () => openCurrentDirectory(session), {
    icon: "▱",
    detail: session.profile ? "远程连接（不可用）" : (session.cwd || "等待 Shell 上报当前目录"),
    disabled: !!session.profile || !session.cwd,
  });
  positionMenu(menu, event.clientX, event.clientY);
  document.body.append(menu); currentMenu = menu;
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && currentMenu) { e.preventDefault(); closeCurrentMenu(); return; }
  if (document.querySelector('.dialog-mask') || (e.target instanceof HTMLElement && e.target.matches('input, select, textarea:not(.xterm-helper-textarea)'))) {
    if (e.ctrlKey && e.shiftKey) report(`快捷键被跳过: 存在打开的对话框或焦点在输入框（target=${e.target instanceof HTMLElement ? e.target.className || e.target.tagName : String(e.target)}）`);
    return;
  }
  const action = shortcutAction(e);
  if (!action) {
    if (e.ctrlKey && e.shiftKey) report(`快捷键未匹配: ${keyChord(e)}（key=${e.key}），未绑定任何动作`);
    return;
  }
  report(`快捷键命中: ${keyChord(e)} -> ${action}`);
  e.preventDefault();
  const tab = ownerOf(activeId);
  switch (action) {
    case "newTab": void newLocalSession(); break;
    case "closePane": if (activeId) void destroySession(activeId); break;
    case "splitH": void toggleSplitScreen("h"); break;
    case "splitV": void toggleSplitScreen("v"); break;
    case "grid3": void setGrid(3); break;
    case "grid4": void setGrid(4); break;
    case "grid9": void setGrid(9); break;
    case "nextTab":
    case "previousTab":
      if (tab && workspaceTabs.length) {
        const step = action === "nextTab" ? 1 : -1;
        const index = (workspaceTabs.indexOf(tab) + step + workspaceTabs.length) % workspaceTabs.length;
        activateSession(workspaceTabs[index].focused);
      }
      break;
    case "nextPane":
    case "previousPane":
      if (tab && activeId) {
        const ids = leaves(tab.root), step = action === "nextPane" ? 1 : -1;
        activateSession(ids[(ids.indexOf(activeId) + step + ids.length) % ids.length]);
      }
      break;
    case "search": toggleSearchBar(); break;
    case "quickConnect": (document.querySelector("#btn-add-menu") as HTMLButtonElement).click(); break;
    case "commandPalette": void showCommandPalette(); break;
    case "connections": void showProfilesManager(); break;
    case "favorites": void openFavoritesManager(); break;
    case "sftp": void toggleSftpPanel(); break;
    case "batch": void showBatchDialog(); break;
    case "settings": void showSettingsDialog(); break;
    case "openDirectory": void openCurrentDirectory(); break;
    case "fontLarger": adjustFontSize(1); break;
    case "fontSmaller": adjustFontSize(-1); break;
    case "newWindow": void createDetachedWindow(); break;
    case "reconnect": {
      const session = activeId ? sessions.get(activeId) : undefined;
      if (session?.profile) void connectProfile(session.profile);
      break;
    }
  }
});
window.addEventListener("resize", () => {
  closeCurrentMenu();
  fitVisible();
  scheduleWorkspaceSave();
});
window.addEventListener("beforeunload", saveWorkspace);
window.addEventListener('pagehide', saveWorkspace);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveWorkspace(); });
void getCurrentWindow().onCloseRequested(async () => {
  // Drain queued xterm output before Tauri destroys the WebView.
  await Promise.all([...sessions.values()].map(session => new Promise<void>(resolve => {
    const timeout = window.setTimeout(resolve, 500);
    session.term.write('', () => { window.clearTimeout(timeout); resolve(); });
  })));
  saveWorkspace();
}).catch(error => report(`注册历史保存失败: ${String(error)}`));

// ---------- 启动 ----------

(async () => {
  try {
    sftp.initPanel(document.querySelector<HTMLElement>(".main")!, () => {
      const session = activeId ? sessions.get(activeId) : undefined;
      return session?.profile && session.status === "connected"
        ? { sid: session.id, cwd: session.cwd }
        : null;
    });
    await applyAppearance();
    const transferToken = new URLSearchParams(window.location.search).get("transfer");
    const adopted = transferToken ? await adoptTransferredSession(transferToken) : false;
    if (!adopted) {
      const directory = await invoke<string | null>('get_launch_directory');
      if (directory) {
        // Explorer opens the requested folder immediately and does not overwrite
        // the normal window's saved workspace or wait for its SSH authentication.
        workspaceStorageKey += ':explorer';
        await newLocalSession(undefined, undefined, undefined, directory);
      } else if (!(await restoreWorkspace())) await newLocalSession();
    }
  } catch (e) {
    report(`启动失败: ${String(e)}`);
    if (!sessions.size) await newLocalSession().catch(() => {});
  }
})();
