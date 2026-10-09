import { configStorage } from './config-storage';
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TransferQueue, type Transfer, type TransferProgress } from "./transfer-queue";
import { open as pickFiles, save as saveFile } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// ---------- 类型 ----------

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

interface Progress {
  name: string;
  done: number;
  total: number;
}

interface EditStatus {
  file_name: string;
  remote_path: string;
  status: "opened" | "saving" | "saved" | "error";
  message?: string;
}

export interface ActiveSshSession {
  sid: string;
  cwd?: string;
}

// ---------- 面板状态 ----------

let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
let progressEl: HTMLElement | null = null;

let sessionId: string | null = null; // 当前面板绑定的 SSH 会话
let cwd = "/";
let navigation = 0;
let panelEpoch = 0;
let queueEl: HTMLElement | null = null;
let queueListening: Promise<UnlistenFn> | undefined;
let queueCollapsed = configStorage.getItem("wterm_sftp_queue_collapsed") === "true";
let dropOverlayEl: HTMLElement | null = null;
let activeSshSessionProvider: () => ActiveSshSession | null = () => null;
const directories = new Map<string, string>();
const shellDirectorySnippets = {
  test: `printf '\\033]9;9;%s\\a' "$PWD"`,
  bash: `__wterm_report_cwd() { printf '\\033]9;9;%s\\a' "$PWD"; }
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__wterm_report_cwd)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }__wterm_report_cwd"
fi`,
  zsh: `autoload -Uz add-zsh-hook
__wterm_report_cwd() { printf '\\033]9;9;%s\\a' "$PWD"; }
add-zsh-hook -d precmd __wterm_report_cwd 2>/dev/null
add-zsh-hook precmd __wterm_report_cwd`,
  fish: `function __wterm_report_cwd --on-event fish_prompt
    printf '\\033]9;9;%s\\a' "$PWD"
end`,
} as const;
const queue = new TransferQueue({
  async run(task) {
    await ensureQueueListener();
    return invoke<number>("sftp_transfer", {
      sid: task.sid, transferId: task.id, direction: task.direction,
      local: task.local, remote: task.remote, overwrite: task.overwrite,
    });
  },
  control: (task, action) => invoke("sftp_transfer_control", { sid: task.sid, transferId: task.id, action }),
}, renderQueue, task => {
  if (sessionId === task.sid && task.direction === "upload") void navigate(cwd);
});
function ensureQueueListener(): Promise<UnlistenFn> {
  return queueListening ??= listen<TransferProgress>("wterm-sftp-transfer", event => queue.progress(event.payload))
    .catch(error => { queueListening = undefined; throw error; });
}
async function openDownload(task: Transfer, reveal = false): Promise<void> {
  if (task.direction !== "download" || task.status !== "completed" || task.busy) return;
  task.busy = true; task.error = undefined; renderQueue();
  try { await invoke("open_downloaded_file", { path: task.local, reveal }); }
  catch (error) { task.error = (reveal ? "打开文件夹失败：" : "打开文件失败：") + String(error); }
  finally { task.busy = false; renderQueue(); }
}
function renderQueue(): void {
  if (!queueEl) return;
  queueEl.replaceChildren();
  const tasks = queue.tasks.filter(task => task.sid === sessionId);
  if (!tasks.length) return;
  const header = document.createElement("div"); header.className = "transfer-heading";
  const title = document.createElement("button"); title.className = "st transfer-queue-toggle";
  title.textContent = `${queueCollapsed ? "▸" : "▾"} 传输队列 (${tasks.length})`;
  title.setAttribute("aria-expanded", String(!queueCollapsed));
  title.onclick = () => {
    queueCollapsed = !queueCollapsed;
    configStorage.setItem("wterm_sftp_queue_collapsed", String(queueCollapsed));
    renderQueue();
  };
  const clear = document.createElement("button"); clear.className = "st"; clear.textContent = "清除已结束"; clear.onclick = () => queue.clearFinished(sessionId ?? undefined);
  header.append(title, clear); queueEl.append(header);
  const list = document.createElement("div"); list.className = "transfer-list"; list.hidden = queueCollapsed;
  const labels: Record<Transfer["status"], string> = { queued: "排队中", starting: "准备中", running: "传输中", paused: "已暂停", cancelling: "正在取消", completed: "已完成", cancelled: "已取消", failed: "失败" };
  for (const task of tasks) {
    const row = document.createElement("article"); row.className = "transfer-row"; row.dataset.status = task.status; row.dataset.id = task.id;
    const canOpen = task.direction === "download" && task.status === "completed";
    const name = document.createElement(canOpen ? "button" : "div"); name.className = "transfer-name"; name.textContent = (task.direction === "upload" ? "↑ " : "↓ ") + task.name; name.title = task.local + " ↔ " + task.remote;
    if (name instanceof HTMLButtonElement) {
      name.type = "button"; name.classList.add("transfer-open-file"); name.disabled = !!task.busy;
      name.title = "打开文件：" + task.local; name.setAttribute("aria-label", "打开文件：" + task.name);
      name.onclick = () => void openDownload(task);
    }
    const status = document.createElement("div"); status.className = "sftp-transfer-status";
    status.textContent = labels[task.status] + " · " + fmtSize(task.done) + (task.total ? " / " + fmtSize(task.total) : "") + (task.status === "running" ? " · " + fmtSize(task.speed) + "/s" : "");
    const bar = document.createElement("progress"); bar.max = Math.max(task.total, task.done, 1); bar.value = task.done; bar.setAttribute("aria-label", task.name + " 传输进度");
    const actions = document.createElement("div"); actions.className = "transfer-actions";
    const button = (label: string, run: () => void) => {
      const el = document.createElement("button"); el.className = "st"; el.textContent = label; el.disabled = !!task.busy; el.onclick = run; actions.append(el);
    };
    if (task.status === "running") button("暂停", () => void queue.control(task.id, "pause"));
    if (task.status === "paused") button("继续", () => void queue.control(task.id, "resume"));
    if (["queued", "running", "paused"].includes(task.status)) button("取消", () => void queue.control(task.id, "cancel"));
    if (["failed", "cancelled"].includes(task.status)) button("重新传输", () => {
      if (confirm("将从头重新传输并覆盖目标文件（包括已有的部分内容）。是否继续？")) queue.retry(task.id);
    });
    if (canOpen) button("打开文件夹", () => void openDownload(task, true));
    row.append(name, status, bar, actions);
    if (task.error) { const error = document.createElement("div"); error.className = "transfer-error"; error.textContent = task.error; row.append(error); }
    if (["failed", "cancelled"].includes(task.status)) {
      const hint = document.createElement("div"); hint.className = "sftp-transfer-status"; hint.textContent = "目标可能保留部分文件；重新传输会从头开始。"; row.append(hint);
    }
    list.append(row);
  }
  queueEl.append(list);
}
window.addEventListener("wterm-cwd", event => {
  const { sid, path } = (event as CustomEvent<{ sid: string; path: string }>).detail;
  directories.set(sid, path);
  if (sessionId === sid && panelEl?.querySelector<HTMLInputElement>("#sp-follow")?.checked && path.startsWith("/") && path !== cwd) void navigate(path);
});
let unlistenProgress: UnlistenFn | null = null;
let unlistenEdit: UnlistenFn | null = null;
let unlistenDrop: UnlistenFn | null = null;

// ---------- 工具 ----------

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} G`;
}

function fmtTime(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parentPath(p: string): string {
  if (p === "/") return "/";
  const idx = p.replace(/\/+$/, "").lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

function report(msg: string): void {
  invoke("log_frontend", { msg }).catch(() => {});
}

// ---------- 渲染 ----------

function render(entries: SftpEntry[]): void {
  if (!listEl || !pathEl) return;
  pathEl.textContent = cwd;
  listEl.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sftp-empty";
    empty.textContent = "空目录（可将本地文件拖拽至此上传）";
    listEl.appendChild(empty);
    return;
  }

  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "sftp-item";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = e.is_dir ? "📁" : e.is_symlink ? "🔗" : "📄";

    const meta = document.createElement("div");
    meta.className = "meta";

    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.title = e.is_dir ? `${e.name} (点击打开)` : `${e.name} (双击在本地编辑)`;
    nameEl.textContent = e.name;

    const subEl = document.createElement("div");
    subEl.className = "sub";
    subEl.textContent = e.is_dir ? "目录" : `${fmtSize(e.size)} · ${fmtTime(e.modified)}`;

    meta.appendChild(nameEl);
    meta.appendChild(subEl);

    const ops = document.createElement("div");
    ops.className = "ops";

    if (!e.is_dir) {
      const editBtn = document.createElement("button");
      editBtn.className = "op";
      editBtn.title = "双击或点击编辑";
      editBtn.textContent = "✎";
      editBtn.onclick = (ev) => {
        ev.stopPropagation();
        void editRemote(e.name, joinPath(cwd, e.name));
      };
      ops.appendChild(editBtn);

      const dlBtn = document.createElement("button");
      dlBtn.className = "op";
      dlBtn.title = "另存为并加入下载队列";
      dlBtn.textContent = "⬇";
      dlBtn.onclick = (ev) => {
        ev.stopPropagation();
        void download(e.name, joinPath(cwd, e.name));
      };
      ops.appendChild(dlBtn);
    }

    const rnBtn = document.createElement("button");
    rnBtn.className = "op";
    rnBtn.title = "重命名";
    rnBtn.textContent = "🏷";
    rnBtn.onclick = (ev) => {
      ev.stopPropagation();
      void rename(e.name, joinPath(cwd, e.name), e.is_dir);
    };
    ops.appendChild(rnBtn);

    const chmod = document.createElement("button");
    chmod.className = "op"; chmod.title = "修改权限"; chmod.textContent = "权限";
    chmod.onclick = async () => {
      const sid = sessionId, path = joinPath(cwd, e.name);
      const mode = prompt("Unix 权限（八进制，如 644 或 755）", ((e.permissions ?? 0) & 0o7777).toString(8));
      if (mode === null) return;
      if (!/^[0-7]{3,4}$/.test(mode)) { alert("请输入 3–4 位八进制权限"); return; }
      try { await invoke("sftp_chmod", { sid, path, mode: parseInt(mode, 8) }); if (sessionId === sid) await navigate(cwd); }
      catch (error) { showError("权限修改失败：" + String(error)); }
    };
    ops.append(chmod);
    const rmBtn = document.createElement("button");
    rmBtn.className = "op";
    rmBtn.title = "删除";
    rmBtn.textContent = "✕";
    rmBtn.onclick = (ev) => {
      ev.stopPropagation();
      void remove(e.name, joinPath(cwd, e.name), e.is_dir);
    };
    ops.appendChild(rmBtn);

    item.appendChild(icon);
    item.appendChild(meta);
    item.appendChild(ops);

    // 交互绑定：目录点击打开，文件双击编辑
    if (e.is_dir) {
      meta.onclick = () => void navigate(joinPath(cwd, e.name));
    } else {
      meta.ondblclick = () => void editRemote(e.name, joinPath(cwd, e.name));
    }

    listEl.appendChild(item);
  }
}

function showError(msg: string): void {
  if (!listEl) return;
  listEl.innerHTML = "";
  const err = document.createElement("div");
  err.className = "sftp-empty";
  err.textContent = msg;
  listEl.appendChild(err);
}

// ---------- 传输与文件操作 ----------

async function download(name: string, remote: string): Promise<void> {
  const sid = sessionId;
  if (!sid) return;
  try {
    const local = await saveFile({ defaultPath: name, title: "保存远程文件" });
    if (local) queue.add({ sid, name, remote, local, direction: "download", overwrite: true });
  } catch (error) { if (progressEl) progressEl.textContent = String(error); }
}
async function uploadFiles(paths: string[], sid = sessionId, directory = cwd): Promise<void> {
  if (!sid || !paths.length) return;
  try {
    const entries = await invoke<SftpEntry[]>("sftp_list", { sid, path: directory });
    const existing = new Set(entries.map(entry => entry.name));
    for (const local of paths) {
      const name = local.replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() ?? local;
      const remote = joinPath(directory, name);
      const overwrite = existing.has(name);
      if (overwrite && !confirm("远程文件已存在，覆盖 " + remote + "？")) continue;
      queue.add({ sid, name, local, remote, direction: "upload", overwrite });
      existing.add(name);
    }
  } catch (error) { if (progressEl) progressEl.textContent = "无法加入上传队列：" + String(error); }
}
async function upload(): Promise<void> {
  const sid = sessionId, directory = cwd;
  if (!sid) return;
  try {
    const picked = await pickFiles({ multiple: true, title: "选择要上传的文件" });
    if (picked) await uploadFiles(Array.isArray(picked) ? picked : [picked], sid, directory);
  } catch (error) { if (progressEl) progressEl.textContent = String(error); }
}

async function editRemote(name: string, remote: string): Promise<void> {
  if (!sessionId || !progressEl) return;
  progressEl.textContent = `✎ 打开并监听 ${name}...`;
  try {
    await invoke("sftp_edit", { sid: sessionId, remote });
  } catch (e) {
    progressEl.textContent = `✕ 编辑失败: ${String(e)}`;
    setTimeout(() => {
      if (progressEl) progressEl.textContent = "";
    }, 5000);
  }
}

async function rename(name: string, full: string, isDir: boolean): Promise<void> {
  const next = prompt(isDir ? "新目录名" : "新文件名", name);
  if (!next || next === name) return;
  try {
    await invoke("sftp_rename", { sid: sessionId, from: full, to: joinPath(cwd, next) });
    await navigate(cwd);
  } catch (e) {
    showError(`重命名失败: ${String(e)}`);
  }
}

function confirmRemoteDelete(name: string, full: string, isDir: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "sftp-delete-dialog";
    const title = document.createElement("h2"); title.textContent = `删除远程${isDir ? "目录" : "文件"}？`;
    const warning = document.createElement("p"); warning.textContent = "此操作不可撤销，请确认要删除：";
    const path = document.createElement("code"); path.textContent = full || name;
    const actions = document.createElement("div"); actions.className = "dialog-actions sftp-delete-actions";
    const cancel = document.createElement("button"); cancel.className = "btn"; cancel.textContent = "取消";
    cancel.onclick = () => dialog.close("cancel");
    const confirm = document.createElement("button"); confirm.className = "btn danger"; confirm.textContent = "删除";
    confirm.onclick = () => dialog.close("delete");
    actions.append(cancel, confirm);
    dialog.append(title, warning, path, actions);
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "delete";
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close("cancel");
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

async function remove(name: string, full: string, isDir: boolean): Promise<void> {
  const sid = sessionId;
  if (!sid || !await confirmRemoteDelete(name, full, isDir)) return;
  try {
    await invoke("sftp_remove", { sid, path: full, isDir });
    if (sessionId === sid) await navigate(cwd);
  } catch (e) {
    showError(`删除失败: ${String(e)}`);
  }
}

// ---------- 拖拽文件上传支持 ----------

async function setupDragAndDrop(): Promise<void> {
  if (unlistenDrop || !dropOverlayEl) return;
  try {
    const webview = getCurrentWebview();
    unlistenDrop = await webview.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        const panelOpen = !!sessionId && !!panelEl?.classList.contains("open");
        if (!panelOpen && !activeSshSessionProvider()) return;
        if (panelOpen) panelEl?.classList.add("dragover");
        const follow = panelEl?.querySelector<HTMLInputElement>("#sp-follow")?.checked;
        const active = panelOpen ? null : activeSshSessionProvider();
        const target = panelOpen ? cwd : (follow && active?.cwd?.startsWith("/") ? active.cwd : "SSH 主目录");
        dropOverlayEl!.textContent = `松开以上传到 ${target}`;
        dropOverlayEl!.hidden = false;
        dropOverlayEl!.setAttribute("aria-hidden", "false");
      } else if (payload.type === "leave") {
        panelEl?.classList.remove("dragover");
        dropOverlayEl!.hidden = true;
        dropOverlayEl!.setAttribute("aria-hidden", "true");
      } else if (payload.type === "drop") {
        panelEl?.classList.remove("dragover");
        dropOverlayEl!.hidden = true;
        dropOverlayEl!.setAttribute("aria-hidden", "true");
        if (payload.paths && payload.paths.length > 0) {
          void uploadDroppedFiles(payload.paths);
        }
      }
    });
  } catch (e) {
    report(`初始化拖拽支持失败: ${e}`);
  }
}

async function uploadDroppedFiles(paths: string[]): Promise<void> {
  let sid = sessionId;
  if (!sid) {
    const active = activeSshSessionProvider();
    if (!active) return;
    if (active.cwd?.startsWith("/")) directories.set(active.sid, active.cwd);
    await openFor(active.sid);
    sid = sessionId;
  }
  if (sid) await uploadFiles(paths, sid, cwd);
}

// ---------- 公共 API ----------

export function boundSession(): string | null {
  return sessionId;
}

/** 绑定到某个 SSH 会话并打开面板（定位到远程主目录） */
export async function openFor(sid: string): Promise<void> {
  if (!panelEl) return;
  cleanupListeners();
  const epoch = ++panelEpoch;
  ++navigation;
  sessionId = sid;
  renderQueue();
  panelEl.classList.add("open");

  // 1. 进度事件
  const progressListener = await listen<Progress>(`sftp-progress-${sid}`, (e) => {
    const { name, done, total } = e.payload;
    if (progressEl && total > 0) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      progressEl.textContent = `${name} ${pct}%`;
    }
  });

  if (epoch !== panelEpoch) { progressListener(); return; }
  unlistenProgress = progressListener;

  // 2. 远程编辑事件
  const editListener = await listen<EditStatus>(`sftp-edit-${sid}`, (e) => {
    const p = e.payload;
    if (progressEl && p.message) {
      progressEl.textContent = p.message;
      if (p.status === "saved") {
        // 保存后刷新当前目录列表
        void navigate(cwd);
      }
    }
  });

  if (epoch !== panelEpoch) { editListener(); return; }
  unlistenEdit = editListener;
  try {
    const home = await invoke<string>("sftp_home", { sid });
    if (epoch === panelEpoch) await navigate(panelEl.querySelector<HTMLInputElement>("#sp-follow")?.checked ? directories.get(sid) ?? home : home);
  } catch (e) {
    report(`sftp_home 失败: ${e}`);
    if (epoch === panelEpoch) showError(`打开失败: ${String(e)}`);
  }
}

function cleanupListeners(): void {
  unlistenProgress?.();
  unlistenProgress = null;
  unlistenEdit?.();
  unlistenEdit = null;
}

export function close(): void {
  ++panelEpoch; ++navigation;
  panelEl?.classList.remove("open");
  panelEl?.classList.remove("dragover");
  if (dropOverlayEl) {
    dropOverlayEl.hidden = true;
    dropOverlayEl.setAttribute("aria-hidden", "true");
  }
  cleanupListeners();
  sessionId = null;
}

/** 会话被销毁时若面板绑定的是它则关闭 */
export function onSessionClosed(sid: string): void {
  queue.cancelSession(sid); directories.delete(sid);
  if (sessionId === sid) close();
}

/** 创建面板 DOM 并绑定工具栏事件（应用启动时调用一次） */
export function initPanel(container: HTMLElement, getActiveSshSession: () => ActiveSshSession | null = () => null): void {
  activeSshSessionProvider = getActiveSshSession;
  panelEl = document.createElement("aside");
  panelEl.className = "sftp-panel";
  panelEl.innerHTML = `
    <div class="sftp-header">
      <span class="sftp-title">远程文件 (SFTP)</span>
      <div class="sftp-tools">
        <button class="st" id="sp-up" title="上级目录">↑</button>
        <button class="st" id="sp-refresh" title="刷新">⟳</button>
        <button class="st" id="sp-mkdir" title="新建目录">⊞</button>
        <button class="st" id="sp-upload" title="上传文件 (也可拖拽到窗口任意位置)">⬆</button>
        <button class="st" id="sp-close" title="关闭">✕</button>
      </div>
    </div>
    <label class="sftp-follow" title="开启后，SFTP 会随当前 SSH 终端的工作目录切换。"><input id="sp-follow" aria-describedby="sp-follow-description" type="checkbox" /> 跟随终端目录</label>
    <div class="sftp-follow-hint" id="sp-follow-hint">
      <span id="sp-follow-description">开启后，执行 cd 会同步切换 SFTP 路径。远端 Shell 需要上报当前目录。</span>
      <details class="sftp-shell-help">
        <summary>配置远端 Shell</summary>
        <div class="sftp-shell-help-body">
          <p>先在 SSH 终端运行此命令测试；若 SFTP 路径改变，再把对应配置加入远端用户的 Shell 配置文件。</p>
          <div class="sftp-shell-config">
            <code id="sp-shell-test"></code>
            <button class="sftp-shell-copy" type="button" data-copy-target="sp-shell-test">复制测试命令</button>
          </div>
          <details class="sftp-shell-config">
            <summary>Bash · ~/.bashrc</summary>
            <pre><code id="sp-shell-bash"></code></pre>
            <button class="sftp-shell-copy" type="button" data-copy-target="sp-shell-bash">复制 Bash 配置</button>
          </details>
          <details class="sftp-shell-config">
            <summary>Zsh · ~/.zshrc</summary>
            <pre><code id="sp-shell-zsh"></code></pre>
            <button class="sftp-shell-copy" type="button" data-copy-target="sp-shell-zsh">复制 Zsh 配置</button>
          </details>
          <details class="sftp-shell-config">
            <summary>Fish · ~/.config/fish/config.fish</summary>
            <pre><code id="sp-shell-fish"></code></pre>
            <button class="sftp-shell-copy" type="button" data-copy-target="sp-shell-fish">复制 Fish 配置</button>
          </details>
          <p>配置写在远端服务器的用户目录中；重新连接后生效。OSC 7 和 OSC 9;9 均可识别。</p>
        </div>
      </details>
    </div>
    <div class="sftp-path" id="sp-path">/</div>
    <div class="sftp-list" id="sp-list"></div>
    <div class="sftp-queue" aria-label="传输队列"></div>
    <div class="sftp-progress" id="sp-progress"></div>
  `;
  container.appendChild(panelEl);
  for (const [name, snippet] of Object.entries(shellDirectorySnippets)) {
    const code = panelEl.querySelector<HTMLElement>(`#sp-shell-${name}`);
    if (code) code.textContent = snippet;
  }
  panelEl.querySelectorAll<HTMLButtonElement>(".sftp-shell-copy").forEach(button => {
    button.addEventListener("click", async () => {
      const target = button.dataset.copyTarget;
      const code = target ? panelEl?.querySelector<HTMLElement>(`#${target}`) : null;
      if (!code) return;
      const originalLabel = button.textContent ?? "复制";
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败，请手动选择代码";
      }
      window.setTimeout(() => { if (button.isConnected) button.textContent = originalLabel; }, 1800);
    });
  });
  listEl = panelEl.querySelector("#sp-list");
  pathEl = panelEl.querySelector<HTMLElement>("#sp-path")!;
  progressEl = panelEl.querySelector("#sp-progress");
  queueEl = panelEl.querySelector(".sftp-queue");
  dropOverlayEl = document.createElement("div");
  dropOverlayEl.className = "sftp-drop-overlay";
  dropOverlayEl.textContent = "松开以上传";
  dropOverlayEl.hidden = true;
  dropOverlayEl.setAttribute("aria-hidden", "true");
  container.append(dropOverlayEl);
  const follow = panelEl.querySelector<HTMLInputElement>("#sp-follow")!;
  follow.checked = configStorage.getItem("wterm_sftp_follow") === "true";
  follow.onchange = () => {
    configStorage.setItem("wterm_sftp_follow", String(follow.checked));
    const path = sessionId ? directories.get(sessionId) : undefined;
    if (follow.checked && path?.startsWith("/")) void navigate(path);
  };

  panelEl.querySelector("#sp-up")!.addEventListener("click", () => void navigate(parentPath(cwd)));
  panelEl.querySelector("#sp-refresh")!.addEventListener("click", () => void navigate(cwd));
  panelEl.querySelector("#sp-upload")!.addEventListener("click", () => void upload());
  panelEl.querySelector("#sp-close")!.addEventListener("click", close);
  panelEl.querySelector("#sp-mkdir")!.addEventListener("click", async () => {
    const name = prompt("新目录名");
    if (!name) return;
    try {
      await invoke("sftp_mkdir", { sid: sessionId, path: joinPath(cwd, name) });
      await navigate(cwd);
    } catch (e) {
      showError(`创建失败: ${String(e)}`);
    }
  });

  // 支持点击路径栏跳转/手动定位
  pathEl.style.cursor = "pointer";
  pathEl.title = "点击手动输入路径";
  pathEl.addEventListener("click", async () => {
    const next = prompt("前往远程路径", cwd);
    if (next && next.trim()) {
      await navigate(next.trim());
    }
  });
  void setupDragAndDrop();
}

async function navigate(path: string): Promise<void> {
  const sid = sessionId, ticket = ++navigation;
  if (!sid) return;
  if (listEl) {
    listEl.innerHTML = "";
    const loadingEl = document.createElement("div");
    loadingEl.className = "sftp-empty";
    loadingEl.textContent = "加载中...";
    listEl.appendChild(loadingEl);
  }
  try {
    const target = path.trim() || "/";
    const entries = await invoke<SftpEntry[]>("sftp_list", { sid, path: target });
    if (ticket !== navigation || sessionId !== sid) return;
    cwd = target;
    render(entries);
  } catch (e) {
    if (ticket === navigation && sessionId === sid) showError(`加载失败: ${String(e)}`);
    report(`sftp_list 失败: ${e}`);
  }
}
