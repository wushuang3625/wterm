import { LogColorsAddon } from './log-colors';
import { Terminal, type ITerminalAddon, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createZmodemHandler, type ZmodemHandler } from "./zmodem";
import type { SshProfile } from "./main";
import { createAuthChannel } from "./auth";
import { createHostKeyChannel } from "./hostkey";
import { shortcutAction } from "./shortcuts";
import { getTerminalTheme } from "./themes";
import { notifyCommandCompleted, notifyDisconnect, scanKeywordNotification } from "./notifications";

let broadcastTargetProvider: ((sourceId: string) => string[]) | undefined;
export function setBroadcastTargetProvider(provider: ((sourceId: string) => string[]) | undefined): void {
  broadcastTargetProvider = provider;
}

export type SessionStatus = "connecting" | "connected" | "closed";

export interface TermSession {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  pane: HTMLDivElement;
  status: SessionStatus;
  unlisteners: UnlistenFn[];
  zmodem?: ZmodemHandler;
  profile?: SshProfile;
  localShell?: string | null;
  cwd?: string;
  activity?: boolean;
  manualClose?: boolean;
  reconnecting?: boolean;
  reconnectAttempt?: number;
}

export function isCopyOnSelectEnabled(): boolean {
  return localStorage.getItem("wterm_copy_on_select") === "true";
}

export function setCopyOnSelectEnabled(val: boolean): void {
  localStorage.setItem("wterm_copy_on_select", val ? "true" : "false");
}

/**
 * 可拖拽的终端滚动条。
 * 隐藏 xterm 原生 viewport 滚动条，用自定义 overlay 轨道 + 滑块代替。
 */
class ScrollbarAddon implements ITerminalAddon {
  private term!: Terminal;
  private track?: HTMLDivElement;
  private thumb?: HTMLDivElement;
  private readonly disposables: { dispose(): void }[] = [];
  private resizeObserver?: ResizeObserver;
  private renderScheduled = false;
  private isDragging = false;

  activate(term: Terminal): void {
    this.term = term;
    const el = term.element;
    if (!el) return;
    el.classList.add("xterm-custom-scrollbar");
    const viewport = el.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.style.scrollbarWidth = "none";
      const onViewportScroll = () => {
        if (!this.isDragging) {
          this.render();
        }
      };
      viewport.addEventListener("scroll", onViewportScroll, { passive: true });
      this.disposables.push({
        dispose: () => viewport.removeEventListener("scroll", onViewportScroll),
      });
    }

    this.track = document.createElement("div");
    this.track.className = "term-scrollbar";
    this.thumb = document.createElement("div");
    this.thumb.className = "term-scrollbar-thumb";
    this.track.append(this.thumb);
    el.append(this.track);

    this.track.addEventListener("pointerdown", this.onPointerDown);
    this.disposables.push(term.onScroll(() => {
      if (!this.isDragging) this.render();
    }));
    this.disposables.push(term.onLineFeed(() => this.scheduleRender()));
    this.disposables.push(term.onResize(() => this.render()));
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(el);
    this.render();
  }

  dispose(): void {
    this.isDragging = false;
    document.body.classList.remove("terminal-scrolling");
    this.disposables.forEach(d => d.dispose());
    this.resizeObserver?.disconnect();
    this.term.element?.classList.remove("xterm-custom-scrollbar");
    this.track?.remove();
  }

  private scheduleRender(): void {
    if (this.renderScheduled || this.isDragging) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.track || !this.thumb) return;
    const buffer = this.term.buffer.active;
    const maxScroll = buffer.baseY;
    const trackH = this.track.clientHeight;
    if (maxScroll <= 0 || trackH <= 0) {
      this.track.classList.add("hidden");
      return;
    }
    this.track.classList.remove("hidden");
    const rows = this.term.rows;
    const total = buffer.length;
    const thumbH = Math.max(24, Math.round((trackH * rows) / total));
    const maxTop = trackH - thumbH;
    const ratio = Math.min(1, Math.max(0, buffer.viewportY / maxScroll));
    this.thumb.style.height = `${thumbH}px`;
    if (!this.isDragging) {
      this.thumb.style.transform = `translateY(${Math.round(maxTop * ratio)}px)`;
    }
  }

  private scrollToPointer(clientY: number, grabOffset: number): void {
    if (!this.track || !this.thumb) return;
    const buffer = this.term.buffer.active;
    const maxScroll = buffer.baseY;
    if (maxScroll <= 0) return;
    const rect = this.track.getBoundingClientRect();
    const maxTop = Math.max(1, rect.height - this.thumb.offsetHeight);
    const top = Math.min(maxTop, Math.max(0, clientY - rect.top - grabOffset));
    this.thumb.style.transform = `translateY(${Math.round(top)}px)`;
    const ratio = top / maxTop;
    const targetLine = Math.round(ratio * maxScroll);
    this.term.scrollToLine(targetLine);
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.scrollTop = Math.round(ratio * (viewport.scrollHeight - viewport.clientHeight));
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.track || !this.thumb) return;
    e.preventDefault();
    e.stopPropagation();
    const thumb = this.thumb;
    let grabOffset = thumb.offsetHeight / 2;
    if (e.target === thumb) {
      grabOffset = e.clientY - thumb.getBoundingClientRect().top;
    } else {
      this.scrollToPointer(e.clientY, grabOffset);
    }
    this.isDragging = true;
    thumb.classList.add("dragging");
    document.body.classList.add("terminal-scrolling");

    try {
      this.track.setPointerCapture(e.pointerId);
    } catch {}

    const onMove = (ev: PointerEvent) => {
      if (!this.isDragging) return;
      ev.preventDefault();
      this.scrollToPointer(ev.clientY, grabOffset);
    };

    const onUp = (ev: PointerEvent) => {
      this.isDragging = false;
      thumb.classList.remove("dragging");
      document.body.classList.remove("terminal-scrolling");
      this.track?.removeEventListener("pointermove", onMove);
      this.track?.removeEventListener("pointerup", onUp);
      this.track?.removeEventListener("pointercancel", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (this.track?.hasPointerCapture(ev.pointerId)) {
        try { this.track.releasePointerCapture(ev.pointerId); } catch {}
      }
      this.render();
    };

    this.track.addEventListener("pointermove", onMove);
    this.track.addEventListener("pointerup", onUp);
    this.track.addEventListener("pointercancel", onUp);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
}

export function createTerminal(container: HTMLDivElement): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
} {
  const term = new Terminal({
    fontFamily: localStorage.getItem("wterm_font_family") || "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    fontSize: Number(localStorage.getItem("wterm_font_size")) || 14,
    lineHeight: Number(localStorage.getItem("wterm_line_height")) || 1.25,
    letterSpacing: Number(localStorage.getItem("wterm_letter_spacing")) || 0,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: Number(localStorage.getItem("wterm_scrollback")) || 10000,
    smoothScrollDuration: 0,
    theme: getTerminalTheme(),
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(new ImageAddon());

  term.open(container);
  term.loadAddon(new LogColorsAddon());
  term.loadAddon(new ScrollbarAddon());
  if (localStorage.getItem("wterm_webgl") === "true") {
    setTimeout(() => {
      if (!container.isConnected) return;
      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (container.isConnected) term.loadAddon(new WebglAddon());
      }).catch(() => {});
    }, 250);
  }

  term.onSelectionChange(() => {
    if (isCopyOnSelectEnabled() && term.hasSelection()) {
      const selected = term.getSelection();
      if (selected) navigator.clipboard.writeText(selected).catch(() => {});
    }
  });

  container.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (e.shiftKey) return;
    const mode = localStorage.getItem("wterm_right_click") || "copy-paste";
    if (mode === "disabled") return;
    try {
      if (mode === "copy" || (mode === "copy-paste" && term.hasSelection())) {
        if (term.hasSelection()) await navigator.clipboard.writeText(term.getSelection());
      } else {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
      }
    } catch (error) {
      console.warn("剪贴板操作失败", error);
    }
  });

  term.attachCustomKeyEventHandler(e => {
    if (shortcutAction(e)) return false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      if (e.type === "keydown") {
        e.preventDefault();
        void navigator.clipboard.readText().then(text => term.paste(text)).catch(() => {});
      }
      return false;
    }
    return true;
  });
  fit.fit();
  return { term, fit, search, serialize };
}

/**
 * 由 pane 的实际可视尺寸计算行列数：clientWidth/clientHeight 已不含 border-box padding，
 * 再手动减去 .term-pane 的 padding，避免 FitAddon 对容器几何的推算误差。
 */
export function paneDimensions(pane: HTMLElement, term: Terminal): { cols: number; rows: number } {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  const style = getComputedStyle(pane);
  const width = pane.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const height = pane.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  if (cell?.width && cell?.height && width > 0 && height > 0) {
    return {
      cols: Math.max(2, Math.floor(width / cell.width)),
      rows: Math.max(1, Math.floor(height / cell.height)),
    };
  }
  return { cols: 120, rows: 30 };
}

export function fitDimensions(fit: FitAddon): { cols: number; rows: number } {
  const size = fit.proposeDimensions();
  const valid = (v: number | undefined, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  return {
    cols: valid(size?.cols, 120),
    rows: valid(size?.rows, 30),
  };
}

export interface TermDimensions { cols: number; rows: number }

export async function spawnLocal(
  id: string,
  dims: TermDimensions,
  shell: string | null,
  cwd: string | null
): Promise<string> {
  const { cols, rows } = dims;
  return invoke<string>("spawn_local", {
    id,
    shell,
    cwd,
    cols,
    rows,
    noProfile: localStorage.getItem("wterm_no_profile") === "true",
  });
}

export async function spawnSshOnExisting(
  sourceId: string,
  newId: string,
  dims: TermDimensions
): Promise<void> {
  const { cols, rows } = dims;
  await invoke("spawn_ssh_on_existing", { sourceId, newId, cols, rows });
}

export async function spawnSsh(
  id: string,
  dims: TermDimensions,
  opts: {
    host: string;
    port: number;
    username: string;
    password?: string | null;
    privateKey?: string | null;
    passphrase?: string | null;
    keepaliveSecs?: number | null;
    auth?: string;
    proxyJump?: string | null;
  }
): Promise<void> {
  const { cols, rows } = dims;
  const endpoint = `${opts.username}@${opts.host}:${opts.port}`;
  const auth = createAuthChannel(endpoint);
  const hostKey = createHostKeyChannel(endpoint);
  try {
    await invoke("spawn_ssh", {
      id,
      cols,
      rows,
      ...opts,
      useKeychain: localStorage.getItem("wterm_keychain_enabled") !== "false",
      authChannel: auth.channel,
      hostKeyChannel: hostKey.channel,
    });
  } finally {
    auth.dispose();
    hostKey.dispose();
  }
}

function ctrlClick(event: MouseEvent): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function normalizeRemotePath(path: string, cwd?: string): string {
  const clean = path.replace(/[),.;:\\]]+$/, "");
  if (clean.startsWith("/")) return clean;
  if (!cwd || !cwd.startsWith("/")) return clean;
  const parts = `${cwd.replace(/\/$/, "")}/${clean}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

interface DetectedLink {
  type: "url" | "path";
  raw: string;
  start: number;
  end: number;
}

function trimPunctuation(str: string): { clean: string; trimmed: number } {
  const match = str.match(/[),.;:'"`>\]}]+$/);
  if (!match) return { clean: str, trimmed: 0 };
  return { clean: str.slice(0, str.length - match[0].length), trimmed: match[0].length };
}

export function detectLinksInLine(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];

  // 1. Quoted paths or URLs (preserves spaces inside quotes, e.g. 'D:\Program Files\...')
  const quotedRegex = /["']((?:https?:\/\/|[A-Za-z]:[\\/]|\\\\|\/|~\/|\.\.?\/)[^"'\r\n]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRegex.exec(text)) !== null) {
    const raw = m[1];
    const { clean } = trimPunctuation(raw);
    if (clean.length > 1) {
      const isUrl = /^https?:\/\//i.test(clean);
      const start = m.index + 1;
      const end = start + clean.length;
      links.push({ type: isUrl ? "url" : "path", raw: clean, start, end });
    }
  }

  // 2. URLs (http://, https://, file://)
  const urlRegex = /(?:https?|file):\/\/[^\s<>"'|`()\[\]{}]+/gi;
  while ((m = urlRegex.exec(text)) !== null) {
    const raw = m[0];
    const { clean } = trimPunctuation(raw);
    const start = m.index;
    const end = start + clean.length;
    if (!links.some(l => start >= l.start && start < l.end)) {
      links.push({ type: "url", raw: clean, start, end });
    }
  }

  // 3. IP with port / localhost (e.g. localhost:5173, 127.0.0.1:1420)
  const hostRegex = /(?:localhost|\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))(?::\d{1,5})(?:[^\s<>"'|`()\[\]{}]*)?/gi;
  while ((m = hostRegex.exec(text)) !== null) {
    const raw = m[0];
    const { clean } = trimPunctuation(raw);
    const start = m.index;
    const end = start + clean.length;
    if (!links.some(l => start >= l.start && start < l.end)) {
      links.push({ type: "url", raw: `http://${clean}`, start, end });
    }
  }

  // 4. Unquoted Windows absolute paths (e.g. C:\Users\Administrator, D:\Tools\app.exe)
  const winPathRegex = /(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'|?*\x00-\x1f]+/g;
  while ((m = winPathRegex.exec(text)) !== null) {
    const raw = m[0];
    const { clean } = trimPunctuation(raw);
    const start = m.index;
    const end = start + clean.length;
    if (!links.some(l => (start >= l.start && start < l.end) || (end > l.start && end <= l.end))) {
      links.push({ type: "path", raw: clean, start, end });
    }
  }

  // 5. Unquoted Unix / relative / home paths (e.g. /var/log, ./src/main.ts, ../package.json, ~/.bashrc)
  const unixPathRegex = /(?:~\/|\.\.?\/|(?:\/(?:mnt\/[a-zA-Z]\/|etc\/|var\/|usr\/|opt\/|home\/|tmp\/|bin\/|dev\/|sys\/|proc\/|root\/|[a-zA-Z0-9._-]+\/)))[^\s<>"'|?*\x00-\x1f]*/g;
  while ((m = unixPathRegex.exec(text)) !== null) {
    const raw = m[0];
    const { clean } = trimPunctuation(raw);
    const start = m.index;
    const end = start + clean.length;
    if (!links.some(l => (start >= l.start && start < l.end) || (end > l.start && end <= l.end))) {
      links.push({ type: "path", raw: clean, start, end });
    }
  }

  return links.sort((a, b) => a.start - b.start);
}

function findColRange(line: any, startCharIndex: number, length: number): { startX: number; endX: number } {
  let charCount = 0;
  let startX = 1;
  let endX = 1;
  let foundStart = false;

  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const w = cell.getWidth();
    if (w === 0) continue;
    const chars = cell.getChars();
    if (!foundStart && charCount >= startCharIndex) {
      startX = x + 1;
      foundStart = true;
    }
    charCount += chars.length || 1;
    if (charCount >= startCharIndex + length) {
      endX = x + 1;
      break;
    }
  }
  if (!foundStart) startX = startCharIndex + 1;
  if (endX < startX) endX = startX + length - 1;
  return { startX, endX };
}

let activeTooltip: HTMLElement | null = null;
let tooltipTimer: any = null;

function showLinkTooltip(x: number, y: number, text: string, isUrl: boolean, hintOnly = false): void {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  if (!activeTooltip) {
    activeTooltip = document.createElement("div");
    activeTooltip.className = "terminal-link-tooltip";
    document.body.appendChild(activeTooltip);
  }
  if (hintOnly) {
    activeTooltip.innerHTML = `<span class="link-key">请按住 Ctrl 点击</span> 打开${isUrl ? "链接" : "目录 / 文件"}`;
  } else {
    const label = isUrl ? "访问链接" : "打开目录 / 文件";
    activeTooltip.innerHTML = `<span class="link-key">Ctrl + 点击</span> ${label}: <span class="link-target">${escapeHtml(text)}</span>`;
  }
  activeTooltip.style.display = "flex";
  const rect = activeTooltip.getBoundingClientRect();
  const top = Math.max(10, y - rect.height - 8);
  const left = Math.min(window.innerWidth - rect.width - 10, Math.max(10, x));
  activeTooltip.style.top = `${top}px`;
  activeTooltip.style.left = `${left}px`;
}

function hideLinkTooltip(): void {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  if (activeTooltip) {
    activeTooltip.style.display = "none";
  }
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] || c));
}

export function installSmartLinks(session: TermSession): void {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = session.term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text.trim()) {
        callback(undefined);
        return;
      }
      const detected = detectLinksInLine(text);
      if (!detected.length) {
        callback(undefined);
        return;
      }

      const links: ILink[] = detected.map(item => {
        const { startX, endX } = findColRange(line, item.start, item.end - item.start);
        const isUrl = item.type === "url";
        return {
          range: {
            start: { x: startX, y: bufferLineNumber },
            end: { x: endX, y: bufferLineNumber },
          },
          text: item.raw,
          decorations: { pointerCursor: true, underline: true },
          hover(event: MouseEvent) {
            showLinkTooltip(event.clientX, event.clientY, item.raw, isUrl);
          },
          leave() {
            hideLinkTooltip();
          },
          activate(event: MouseEvent) {
            if (!(event.ctrlKey || event.metaKey)) {
              showLinkTooltip(event.clientX, event.clientY, item.raw, isUrl, true);
              tooltipTimer = setTimeout(hideLinkTooltip, 2000);
              return;
            }
            hideLinkTooltip();
            if (isUrl) {
              void invoke("open_external_target", { target: item.raw })
                .catch(error => console.warn("打开链接失败", error));
            } else {
              if (session.profile) {
                const remote = normalizeRemotePath(item.raw, session.cwd);
                void invoke("sftp_edit", { sid: session.id, remote })
                  .catch(error => console.warn("打开远程路径失败", error));
              } else {
                void invoke("open_local_terminal_path", {
                  sid: session.id,
                  path: item.raw,
                  cwd: session.cwd ?? null,
                }).catch(error => console.warn("打开本地路径失败", error));
              }
            }
          },
        };
      });

      callback(links);
    },
  };

  const disposable = session.term.registerLinkProvider(provider);
  session.unlisteners.push(() => {
    disposable.dispose();
    hideLinkTooltip();
  });
}

export async function bindSessionIO(
  session: TermSession,
  onStateChange: (event: "activity" | "closed") => void
): Promise<void> {
  const { id, term } = session;
  let commandStartedAt = 0;
  const completeCommand = (exitCode?: string) => {
    if (!commandStartedAt) return;
    const elapsed = Date.now() - commandStartedAt;
    commandStartedAt = 0;
    notifyCommandCompleted(session.title, elapsed, exitCode);
  };
  const directory = (value: string) => {
    if (value && !/[\x00-\x1f]/.test(value)) {
      session.cwd = value;
      if (session.profile) window.dispatchEvent(new CustomEvent("wterm-cwd", { detail: { sid: session.id, path: value } }));
    }
    completeCommand();
  };

  // Remote shell integrations commonly report cwd through OSC 7 (file URI)
  // or OSC 9;9 (raw path); both update the SSH session and SFTP follow state.
  const osc7 = term.parser.registerOscHandler(7, value => {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") {
        directory(decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1"));
      }
    } catch {}
    return true;
  });
  const osc9 = term.parser.registerOscHandler(9, value => {
    if (value.startsWith("9;")) directory(value.slice(2).replace(/^"|"$/g, ""));
    return true;
  });
  const osc133 = term.parser.registerOscHandler(133, value => {
    const [marker, exitCode] = value.split(";");
    if (marker === "C") commandStartedAt = Date.now();
    else if (marker === "D") completeCommand(exitCode);
    return true;
  });
  session.unlisteners.push(() => {
    osc7.dispose();
    osc9.dispose();
    osc133.dispose();
  });
  installSmartLinks(session);

  const transferStatus = document.createElement("button");
  transferStatus.className = "transfer-status";
  transferStatus.textContent = "文件传输中 · 点击取消 / Ctrl+C";
  transferStatus.hidden = true;
  session.pane.append(transferStatus);

  let writes = Promise.resolve();
  const send = (data: number[]) => {
    writes = writes.then(() => invoke<void>("write_session_bytes", { id, data })).catch(() => {
      zmodem.cancel();
    });
  };
  const zmodem = createZmodemHandler(term, send, {
    onState: active => {
      transferStatus.hidden = !active;
    },
    restorePointer: () => {
      return getCurrentWindow().setCursorVisible(true).catch(() => {});
    },
  });
  transferStatus.onclick = () => zmodem.cancel();
  session.zmodem = zmodem;

  const decoder = new TextDecoder();
  let notificationTail = "";
  session.unlisteners.push(
    await listen<number[]>(`pty-output-${id}`, (e) => {
      const u8 = new Uint8Array(e.payload);
      if (!zmodem.isActive()) {
        const text = decoder.decode(u8, { stream: true });
        notificationTail = (notificationTail + text).slice(-4096);
        scanKeywordNotification(session.title, notificationTail);
      }
      zmodem.consume(u8);
      if (!session.pane.classList.contains("active") && !session.activity) {
        session.activity = true;
        onStateChange("activity");
      }
    })
  );
  session.unlisteners.push(
    await listen(`pty-closed-${id}`, () => {
      session.status = "closed";
      zmodem.dispose();
      term.write("\r\n\x1b[90m[会话已结束]\x1b[0m\r\n");
      if (!session.manualClose) notifyDisconnect(session.title);
      onStateChange("closed");
    })
  );

  let broadcastWrites = Promise.resolve();
  term.onData(data => {
    if (zmodem.isActive()) {
      if (data.includes("\x03")) zmodem.cancel();
      return;
    }
    if (data.includes("\r") || data.includes("\n")) commandStartedAt = Date.now();
    const bytes = Array.from(new TextEncoder().encode(data));
    send(bytes);
    const targets = broadcastTargetProvider?.(id).filter(target => target !== id) ?? [];
    if (targets.length) {
      broadcastWrites = broadcastWrites
        .then(() => invoke<string[]>("write_sessions_bytes", { ids: targets, data: bytes }))
        .then(failed => {
          if (failed.length) console.warn("广播写入失败", failed);
        })
        .catch(error => console.warn("广播写入失败", error));
    }
  });
  term.onResize(({ cols, rows }) => {
    invoke("resize_session", { id, cols, rows }).catch(() => {});
  });
}

export async function closeSession(id: string): Promise<void> {
  await invoke("close_session", { id }).catch(() => {});
}

export function watchTitle(session: TermSession, onTitle: (t: string) => void): void {
  session.term.onTitleChange(t => {
    if (t) onTitle(t);
  });
}
