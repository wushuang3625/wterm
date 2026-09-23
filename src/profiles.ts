import { invoke } from "@tauri-apps/api/core";
import { newSshSession, tryReuseSshProfile, invalidateProfileMenu, type SshProfile } from "./main";
import { actions, bindings, keyChord, shortcutPresets, type Action } from './shortcuts';
import { WTERM_THEMES, currentThemeId, setTheme, applyTheme } from "./themes";
import { showKnownHostsManager } from "./knownhosts";
import { deleteCredential, loadCredential, passwordCredentialKey, saveCredential } from "./credentials";
import { applyAppearance } from "./appearance";

export interface ImportedHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  identity_file: string | null;
  proxy_jump?: string | null;
}

const sessionListEl = () =>
  document.querySelector<HTMLDivElement>("#session-list")!;

// ---------- SSH 配置列表 ----------

export async function renderProfiles(): Promise<void> {
  let savedProfiles: SshProfile[] = [];
  let sshConfigHosts: ImportedHost[] = [];

  try {
    savedProfiles = await invoke<SshProfile[]>("list_ssh_profiles");
  } catch {
    /* 后端未就绪时忽略 */
  }

  try {
    sshConfigHosts = await invoke<ImportedHost[]>("scan_ssh_config");
  } catch {
    /* 读取 ~/.ssh/config 失败或不存在时忽略 */
  }

  const list = sessionListEl();
  if (!list) return;
  list.innerHTML = "";

  const savedNames = new Set(savedProfiles.map((p) => p.name));

  // ~/.ssh/config 中未保存为独立 profile 的项
  const unSavedSshConfig = sshConfigHosts.filter((h) => !savedNames.has(h.alias));

  if (savedProfiles.length === 0 && unSavedSshConfig.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">
      还没有服务器配置<br/>点击右上角 + 或菜单栏「导入配置」</div>`;
    return;
  }

  // 1. 先按分组渲染已保存的 Profiles；未分组保持一个独立区块。
  const grouped = new Map<string, SshProfile[]>();
  for (const profile of savedProfiles) {
    const group = profile.group?.trim() || "未分组";
    const bucket = grouped.get(group) || [];
    bucket.push(profile);
    grouped.set(group, bucket);
  }
  for (const [group, profiles] of grouped) {
    const heading = document.createElement("div");
    heading.className = "profile-group-heading";
    heading.textContent = group;
    list.appendChild(heading);
    for (const p of profiles) {
      const el = document.createElement("div");
      el.className = "session-item";
      if (p.color) el.style.setProperty("--profile-color", p.color);
      el.innerHTML = `
        <div class="icon profile-color-dot">🖥️</div>
        <div class="meta">
          <div class="name"></div>
          <div class="sub"></div>
        </div>`;
      el.querySelector<HTMLDivElement>(".name")!.textContent = p.name;
      const tags = p.tags?.length ? " · " + p.tags.map(tag => "#" + tag).join(" ") : "";
      el.querySelector<HTMLDivElement>(".sub")!.textContent =
        `${p.username}@${p.host}:${p.port}${p.identity_file ? " 🔑" : ""}${tags}`;
      el.onclick = () => { void connectProfile(p); };
      list.appendChild(el);
    }
  }

  // 2. 再渲染 ~/.ssh/config 中默认加载的项（无需手动导入即可使用）
  if (unSavedSshConfig.length > 0) {
    if (savedProfiles.length > 0) {
      const divider = document.createElement("div");
      divider.className = "menu-divider";
      divider.style.margin = "8px 0";
      list.appendChild(divider);
    }

    const titleEl = document.createElement("div");
    titleEl.className = "menu-section-title";
    titleEl.textContent = `~/.ssh/config (${unSavedSshConfig.length})`;
    list.appendChild(titleEl);

    for (const h of unSavedSshConfig) {
      const el = document.createElement("div");
      el.className = "session-item";
      el.innerHTML = `
        <div class="icon">⚙️</div>
        <div class="meta">
          <div class="name"><span class="title"></span><span class="badge">config</span></div>
          <div class="sub"></div>
        </div>`;
      el.querySelector<HTMLSpanElement>(".title")!.textContent = h.alias;
      el.querySelector<HTMLDivElement>(".sub")!.textContent =
        `${h.username}@${h.host}:${h.port}${h.identity_file ? " 🔑" : ""}`;
      
      el.onclick = () => {
        const profile: SshProfile = {
          name: h.alias,
          host: h.host,
          port: h.port,
          username: h.username,
          auth: h.identity_file ? "key" : "agent",
          identity_file: h.identity_file,
          proxy_jump: h.proxy_jump,
        };
        connectProfile(profile);
      };
      list.appendChild(el);
    }
  }
}

type ProfileTreeNode = { groups: Map<string, ProfileTreeNode>; profiles: SshProfile[] };

function buildProfileTree(profiles: SshProfile[]): ProfileTreeNode {
  const root: ProfileTreeNode = { groups: new Map(), profiles: [] };
  for (const profile of profiles) {
    const parts = (profile.group || "").split("/").map(part => part.trim()).filter(Boolean);
    let node = root;
    for (const part of parts) {
      let child = node.groups.get(part);
      if (!child) {
        child = { groups: new Map(), profiles: [] };
        node.groups.set(part, child);
      }
      node = child;
    }
    node.profiles.push(profile);
  }
  return root;
}

export async function showProfilesManager(): Promise<void> {
  const { mask, close } = showDialog("连接管理", `
    <div class="profile-tree-toolbar">
      <span class="setting-hint">分组名称支持 <code>生产/数据库</code> 这样的多级路径。拖动连接到目录即可移动。</span>
      <button class="btn primary" id="profile-tree-new">+ 新建连接</button>
    </div>
    <div class="profile-tree-root" id="profile-tree-root"></div>
    <div class="dialog-actions"><span></span><button class="btn" id="profile-tree-close">完成</button></div>
  `);
  mask.querySelector<HTMLDivElement>(".dialog")!.classList.add("profile-tree-dialog");
  const rootEl = mask.querySelector<HTMLDivElement>("#profile-tree-root")!;

  const moveProfile = async (name: string, group: string | null) => {
    const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
    const profile = profiles.find(item => item.name === name);
    if (!profile) return;
    await invoke("save_ssh_profile", { profile: { ...profile, group } });
    invalidateProfileMenu();
    await render();
  };

  const installDrop = (element: HTMLElement, group: string | null) => {
    element.ondragover = event => {
      if (event.dataTransfer?.types.includes("text/wterm-profile")) {
        event.preventDefault();
        element.classList.add("drag-over");
      }
    };
    element.ondragleave = () => element.classList.remove("drag-over");
    element.ondrop = event => {
      event.preventDefault();
      element.classList.remove("drag-over");
      const name = event.dataTransfer?.getData("text/wterm-profile");
      if (name) void moveProfile(name, group);
    };
  };

  const createProfileRow = (profile: SshProfile) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "profile-tree-profile";
    row.draggable = true;
    const title = document.createElement("span");
    title.className = "profile-tree-name";
    title.textContent = profile.name;
    const detail = document.createElement("span");
    detail.className = "profile-tree-detail";
    detail.textContent = `${profile.username}@${profile.host}:${profile.port}`;
    row.append(title, detail);
    row.onclick = () => { close(); void connectProfile(profile); };
    row.ondragstart = event => {
      event.dataTransfer?.setData("text/wterm-profile", profile.name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    };
    row.ondragend = () => row.classList.remove("dragging");
    if (profile.color) row.style.setProperty("--profile-color", profile.color);
    return row;
  };

  const render = async () => {
    const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
    rootEl.replaceChildren();
    const tree = buildProfileTree(profiles);
    const ungrouped = document.createElement("div");
    ungrouped.className = "profile-tree-drop-root";
    ungrouped.textContent = "未分组 · 拖到这里移出目录";
    installDrop(ungrouped, null);
    rootEl.append(ungrouped);
    for (const profile of tree.profiles.sort((a, b) => a.name.localeCompare(b.name))) rootEl.append(createProfileRow(profile));

    const addNode = (parent: HTMLElement, name: string, node: ProfileTreeNode, path: string) => {
      const details = document.createElement("details");
      details.className = "profile-tree-group";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = name;
      summary.title = path;
      installDrop(summary, path);
      const body = document.createElement("div");
      body.className = "profile-tree-children";
      details.append(summary, body);
      for (const profile of node.profiles.sort((a, b) => a.name.localeCompare(b.name))) body.append(createProfileRow(profile));
      for (const [childName, child] of [...node.groups].sort(([a], [b]) => a.localeCompare(b))) {
        addNode(body, childName, child, `${path}/${childName}`);
      }
      parent.append(details);
    };
    for (const [name, node] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) addNode(rootEl, name, node, name);
    if (!profiles.length) {
      const empty = document.createElement("div");
      empty.className = "favorites-empty";
      empty.textContent = "还没有保存的 SSH 连接";
      rootEl.append(empty);
    }
  };

  mask.querySelector<HTMLButtonElement>("#profile-tree-new")!.onclick = () => { close(); showNewSshDialog(); };
  mask.querySelector<HTMLButtonElement>("#profile-tree-close")!.onclick = close;
  await render();
}

// ---------- 对话框 ----------

export function showDialog(title: string, bodyHtml: string): {
  mask: HTMLDivElement;
  close: () => void;
} {
  const mask = document.createElement("div");
  mask.className = "dialog-mask";
  mask.innerHTML = `<div class="dialog"><h2>${title}</h2>${bodyHtml}</div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.onclick = (e) => {
    if (e.target === mask) close();
  };
  return { mask, close };
}

export function showNewSshDialog(): void {
  const { mask, close } = showDialog(
    "新建 SSH 连接",
    `
    <div class="field"><label>名称（可选）</label><input id="f-name" placeholder="生产服务器" /></div>
    <div class="field-row">
      <div class="field" style="flex:3"><label>主机</label><input id="f-host" placeholder="192.168.1.10" /></div>
      <div class="field" style="flex:1"><label>端口</label><input id="f-port" value="22" /></div>
    </div>
    <div class="field"><label>用户名</label><input id="f-user" placeholder="root" /></div>
    <div class="field-row">
      <div class="field" style="flex:2"><label>分组</label><input id="f-group" placeholder="生产 / 测试 / 个人" /></div>
      <div class="field" style="flex:1"><label>分组颜色</label><input id="f-color" type="color" value="#58a6ff" /></div>
    </div>
    <div class="field"><label>标签（逗号分隔）</label><input id="f-tags" placeholder="数据库, 核心服务" /></div>
    <div class="field"><label>连接后自动执行</label><textarea id="f-login-script" rows="3" placeholder="例如：cd /srv/app && tmux attach -t app"></textarea></div>
    <div class="field"><label>SSH Keepalive（秒，0=关闭）</label><input id="f-keepalive" type="number" min="0" max="3600" value="30" /></div>
    <div class="field"><label><input id="f-auto-reconnect" type="checkbox" /> 断线后自动重连</label></div>
    <div class="field-row">
      <div class="field" style="flex:1"><label>最大重连次数</label><input id="f-reconnect-attempts" type="number" min="1" max="20" value="5" /></div>
      <div class="field" style="flex:1"><label>基础间隔（秒）</label><input id="f-reconnect-delay" type="number" min="1" max="60" value="3" /></div>
    </div>
    <div class="field"><label>认证方式</label>
      <select id="f-auth">
        <option value="agent">系统 ssh-agent</option>
        <option value="key">指定私钥文件</option>
        <option value="password">密码</option>
      </select>
    </div>
    <div class="field"><label for="f-proxy-jump">跳板链（可选）</label><input id="f-proxy-jump" placeholder="已保存连接名，或 user@host:22；多跳用逗号分隔" /><small>按从本机到目标的顺序填写；已保存连接沿用各自认证设置。</small></div>
    <div class="field" id="f-key-wrap" style="display:none"><label>私钥文件绝对路径</label><input id="f-key" placeholder="C:\\Users\\you\\.ssh\\id_ed25519" /></div>
    <div class="field" id="f-pass-wrap" style="display:none">
      <label>密码</label><input id="f-pass" type="password" />
      <label class="setting-check compact"><input id="f-save-keychain" type="checkbox" checked /> 保存到系统 Keychain / Credential Manager</label>
    </div>
    <div class="dialog-actions">
      <span class="dialog-error" id="f-err"></span>
      <div style="display:flex;gap:8px">
        <button class="btn" id="f-cancel">取消</button>
        <button class="btn primary" id="f-ok">保存并连接</button>
      </div>
    </div>`
  );
  const $ = <T extends HTMLElement>(sel: string) => mask.querySelector<T>(sel)!;
  $("#f-auth").onchange = () => {
    $("#f-pass-wrap").style.display =
      $<HTMLSelectElement>("#f-auth").value === "password" ? "block" : "none";
    $('#f-key-wrap').style.display = $<HTMLSelectElement>('#f-auth').value === 'key' ? 'block' : 'none';
  };
  $("#f-cancel").onclick = close;
  $("#f-ok").onclick = async () => {
    const host = $<HTMLInputElement>("#f-host").value.trim();
    const username = $<HTMLInputElement>("#f-user").value.trim();
    if (!host || !username) {
      $("#f-err").textContent = "主机和用户名为必填项";
      return;
    }
    const port = Number($<HTMLInputElement>('#f-port').value);
    const key = $<HTMLInputElement>('#f-key').value.trim();
    const keepalive = Number($<HTMLInputElement>('#f-keepalive').value);
    const reconnectAttempts = Number($<HTMLInputElement>("#f-reconnect-attempts").value);
    const reconnectDelay = Number($<HTMLInputElement>("#f-reconnect-delay").value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { $('#f-err').textContent = '端口必须在 1–65535 之间'; return; }
    if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 3600) { $('#f-err').textContent = 'Keepalive 必须是 0–3600 秒'; return; }
    if (!Number.isInteger(reconnectAttempts) || reconnectAttempts < 1 || reconnectAttempts > 20) { $('#f-err').textContent = '重连次数必须是 1–20'; return; }
    if (!Number.isInteger(reconnectDelay) || reconnectDelay < 1 || reconnectDelay > 60) { $('#f-err').textContent = '重连间隔必须是 1–60 秒'; return; }
    if ($<HTMLSelectElement>('#f-auth').value === 'key' && !key) { $('#f-err').textContent = '请填写私钥路径'; return; }
    const profile: SshProfile = {
      name: $<HTMLInputElement>("#f-name").value.trim() || host,
      host,
      port,
      username,
      auth: $<HTMLSelectElement>("#f-auth").value,
      proxy_jump: $<HTMLInputElement>("#f-proxy-jump").value.trim() || null,
      identity_file: $<HTMLSelectElement>('#f-auth').value === 'key' ? key : null,
      group: $<HTMLInputElement>("#f-group").value.trim() || null,
      tags: $<HTMLInputElement>("#f-tags").value.split(",").map(tag => tag.trim()).filter(Boolean),
      color: $<HTMLInputElement>("#f-color").value || null,
      login_script: $<HTMLTextAreaElement>("#f-login-script").value.trim() || null,
      keepalive_secs: keepalive,
      auto_reconnect: $<HTMLInputElement>("#f-auto-reconnect").checked,
      reconnect_attempts: reconnectAttempts,
      reconnect_delay_secs: reconnectDelay,
    };
    const password = $<HTMLInputElement>("#f-pass").value;
    try {
      await invoke("save_ssh_profile", { profile });
      invalidateProfileMenu();
      close();
      await renderProfiles();
      if (profile.auth === "password" && password && $<HTMLInputElement>("#f-save-keychain").checked) {
        await saveCredential("password", passwordCredentialKey(profile.username, profile.host, profile.port), password);
      }
      if (profile.auth === "password") await newSshSession(profile, password || undefined);
      else await connectProfile(profile);
    } catch (e) {
      $("#f-err").textContent = `保存失败: ${e}`;
    }
  };
  $<HTMLInputElement>("#f-host").focus();
}

// ---------- 密码/密钥缓存 ----------
const passphraseCache = new Map<string, string>();
const passwordCache = new Map<string, string>();

export function clearAuthCache(): void {
  passphraseCache.clear();
  passwordCache.clear();
  alert("已清空已缓存的私钥密码短语与密码！");
}

import { isCopyOnSelectEnabled, setCopyOnSelectEnabled } from "./terminal";

export interface ShellInfo {
  id: string;
  name: string;
  command: string;
  icon: string;
}

export function getDefaultShellCommand(): string | null {
  return localStorage.getItem("wterm_default_shell") || null;
}

export function setDefaultShellCommand(cmd: string): void {
  localStorage.setItem("wterm_default_shell", cmd);
}

export function getDefaultShellName(): string | null {
  return localStorage.getItem("wterm_default_shell_name") || null;
}

export function setDefaultShellName(name: string): void {
  localStorage.setItem("wterm_default_shell_name", name);
}

export async function showSettingsDialog(): Promise<void> {
  let shells: ShellInfo[] = [];
  try {
    shells = await invoke<ShellInfo[]>("list_available_shells");
  } catch (e) {
    console.warn("获取可用 Shell 失败:", e);
  }

  const currentDefaultCmd = getDefaultShellCommand() || (shells[0]?.command ?? "");

  const optionsHtml = shells
    .map(
      (s) =>
        `<option value="${s.command}" data-name="${s.name}" ${s.command === currentDefaultCmd ? "selected" : ""}>
          ${s.icon} ${s.name} (${s.command})
        </option>`
    )
    .join("");

  const themeOptionsHtml = WTERM_THEMES.map(theme => `<option value="${theme.id}">${theme.name}</option>`).join("");

  const contentHtml = `
    <div class="settings-modal">
      <nav class="settings-sidebar">
        <div class="settings-nav-item active" data-tab="general">
          <span class="icon">⚙️</span>
          <span>常规设置</span>
        </div>
        <div class="settings-nav-item" data-tab="security">
          <span class="icon">🔒</span>
          <span>凭据与安全</span>
        </div>
        <div class="settings-nav-item" data-tab="shortcuts">
          <span class="icon">⌨️</span>
          <span>快捷键</span>
        </div>
        <div class="settings-nav-item" data-tab="about">
          <span class="icon">ℹ️</span>
          <span>关于 wterm</span>
        </div>
      </nav>
      <main class="settings-content">
        <!-- 1. 常规设置 -->
        <section class="settings-pane active" id="pane-general">
          <h3 class="settings-title">常规偏好</h3>
          <div class="field"><label>界面与终端主题</label><select id="cfg-theme">${themeOptionsHtml}</select></div>
          <div class="settings-card appearance-card">
            <div class="settings-card-title">背景与窗口效果</div>
            <div class="field-row">
              <div class="field"><label>背景透明度</label><input id="cfg-bg-opacity" type="number" min="0.2" max="1" step="0.05" /></div>
              <div class="field"><label>窗口效果</label><select id="cfg-window-effect"><option value="none">关闭</option><option value="blur">Blur</option><option value="acrylic">Acrylic</option><option value="mica">Mica</option></select></div>
            </div>
            <div class="field"><label>背景图片路径</label><input id="cfg-background-image" placeholder="C:\\Pictures\\terminal.jpg" /></div>
            <div class="field"><label>背景图片透明度</label><input id="cfg-background-image-opacity" type="number" min="0" max="1" step="0.05" /></div>
            <p class="setting-hint">Windows 支持 Blur / Acrylic / Mica；macOS 映射为系统 Vibrancy。</p>
          </div>
          <div class="field">
            <label>默认启动本地终端</label>
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
              点击“+”号时启动的终端类型
            </div>
            <select id="cfg-default-shell">
              ${optionsHtml}
            </select>
          </div>
          <label class="setting-check"><input type="checkbox" id="cfg-no-profile" /> 快速启动 PowerShell（跳过 Profile 脚本）</label>
          <p class="setting-hint">仅影响新终端；关闭后保留你的 PowerShell 启动脚本。</p>
          <label class="setting-check"><input type="checkbox" id="cfg-webgl" /> WebGL 渲染（大量滚动时可启用）</label>
          <p class="setting-hint">渲染方式应用于新终端。</p>
          <div class="field"><label>右键行为</label><select id="cfg-right-click">
            <option value="copy-paste">有选区时复制，否则粘贴</option><option value="copy">仅复制</option>
            <option value="paste">仅粘贴</option><option value="disabled">禁用</option>
          </select></div>
          <div class="settings-card typography-card">
            <div class="settings-card-title">字体与排版</div>
            <div class="field font-combobox-field"><label for="cfg-font-family">终端字体</label><div class="font-combobox"><input id="cfg-font-family" placeholder="Cascadia Code" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="font-combobox-list" /><button type="button" class="combobox-caret" id="font-combobox-caret" tabindex="-1" aria-label="展开字体列表">▾</button><ul class="combobox-list" id="font-combobox-list" role="listbox" hidden></ul></div><p class="setting-hint">选择或输入已安装的字体名称，保存后立即应用。</p></div>
            <div class="field-row typography-values">
              <div class="field"><label for="cfg-font-size">字号</label><input id="cfg-font-size" type="number" min="8" max="40" /><p class="setting-hint">8–40 px</p></div>
              <div class="field"><label for="cfg-line-height">行高</label><input id="cfg-line-height" type="number" min="1" max="2" step="0.05" /><p class="setting-hint">1–2 倍</p></div>
              <div class="field"><label for="cfg-letter-spacing">字距</label><input id="cfg-letter-spacing" type="number" min="0" max="5" step="0.1" /><p class="setting-hint">0–5 px</p></div>
            </div>
          </div>
          <div class="settings-card log-display-card">
            <div class="settings-card-title">日志与滚动</div>
            <label class="setting-check"><input type="checkbox" id="cfg-log-colors" /><span>日志分色</span></label>
            <p class="setting-hint">自动区分时间、日志级别和异常。保留原有颜色与复制内容；全屏程序保持原样。</p>
            <div class="log-color-legend"><span class="log-info">INFO</span><span class="log-warn">WARN</span><span class="log-error">ERROR / 异常</span><span class="log-debug">DEBUG</span></div>
            <div class="field"><label for="cfg-scrollback">滚动缓冲行数</label><input id="cfg-scrollback" type="number" min="100" max="100000" /><span class="setting-hint">100–100000 行，新终端生效</span></div>
          </div>
          <div class="field" style="margin-top:16px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="cfg-copy-on-select" style="width:16px;height:16px;accent-color:var(--accent);" />
              <span style="font-size:13px;color:var(--text);">选中文本时自动复制到剪贴板 (Copy on select)</span>
            </label>
            <div style="font-size:12px;color:var(--text-dim);margin-top:4px;margin-left:24px;">
              划选后自动复制；右键按上方设置执行。Ctrl+V / Cmd+V 粘贴。
            </div>
          </div>
          <div class="settings-card">
            <div class="settings-card-title">系统通知</div>
            <label class="setting-check"><input type="checkbox" id="cfg-notifications" /> 启用系统通知</label>
            <label class="setting-check"><input type="checkbox" id="cfg-notify-disconnect" /> 会话意外断开时通知</label>
            <label class="setting-check"><input type="checkbox" id="cfg-notify-command" /> 长命令完成时通知</label>
            <div class="field"><label>长命令阈值（秒）</label><input id="cfg-notify-min-seconds" type="number" min="0" max="86400" /></div>
            <div class="field"><label>输出关键词（逗号分隔）</label><input id="cfg-notify-keywords" placeholder="ERROR, FAILED, completed" /></div>
          </div>
        </section>

        <!-- 2. 凭据与安全 -->
        <section class="settings-pane" id="pane-security">
          <h3 class="settings-title">凭据与安全</h3>
          <div class="settings-card">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">SSH 已知主机</div>
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.5;">
              连接时校验 ~/.ssh/known_hosts；首次连接显示指纹，密钥变化时阻止自动覆盖。
            </div>
            <button class="btn" id="cfg-known-hosts">🛡 管理 known_hosts</button>
          </div>
          <div class="settings-card">
            <div class="settings-card-title">系统 Keychain / Credential Manager</div>
            <label class="setting-check"><input type="checkbox" id="cfg-keychain-enabled" /> 允许保存 SSH 密码与私钥 Passphrase</label>
            <p class="setting-hint">Profile 文件仍只保存连接信息，不写入密码明文。关闭后只使用当前进程内存缓存。</p>
            <div class="settings-inline-actions">
              <button class="btn" id="cfg-clear-cache">清空内存缓存</button>
              <button class="btn danger" id="cfg-clear-keychain">清除 wterm 系统凭据</button>
            </div>
          </div>
        </section>

        <!-- 3. 快捷键 -->
        <section class="settings-pane" id="pane-shortcuts">
          <h3 class="settings-title">全局与常用快捷键</h3>
          <p class="setting-hint">点击输入框后按组合键。分屏仅影响当前标签，可连续拆分；关闭窗格会自动合并剩余布局。</p>
          <div class="field"><label>快捷键预设</label><select id="cfg-shortcut-preset"><option value="custom">自定义 / 当前</option><option value="default">wterm 默认</option><option value="vscode">VS Code 风格</option><option value="iterm2">iTerm2 风格</option></select></div>
          <div class="shortcut-list" id="shortcut-editor"></div>
          <button class="btn" id="cfg-reset-shortcuts">恢复默认快捷键</button>
          <p class="setting-hint">拖动标签排序；中键关闭整个标签。拖动窗格右上角手柄交换位置；拖动分隔条调节比例，双击等分。</p>
          <p id="cfg-error" class="dialog-error" role="alert"></p>
        </section>

        <!-- 4. 关于 -->
        <section class="settings-pane" id="pane-about">
          <h3 class="settings-title">关于 wterm</h3>
          <div style="font-size:13px;color:var(--text-dim);line-height:1.8;">
            <p><strong style="color:var(--text);">wterm</strong> — 高性能、设计驱动的现代化 SSH 与终端工作台。</p>
            <p>基于 Rust (Tauri 2) + xterm.js + russh 构建，支持高性能 PTY、ZMODEM (rz/sz)、多通道复用及左右多屏分屏。</p>
            <p style="margin-top:12px;font-size:12px;">版本: v0.1.4</p>
          </div>
        </section>
      </main>
    </div>
    <div class="dialog-actions" style="margin-top:16px;">
      <div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="cfg-cancel">取消</button>
        <button class="btn primary" id="cfg-save">保存</button>
      </div>
    </div>`;

  const { mask, close } = showDialog("设置", contentHtml);

  // 扩展弹窗宽度
  const dialogEl = mask.querySelector<HTMLDivElement>(".dialog")!;
  dialogEl.classList.add("settings-dialog");

  const $ = <T extends HTMLElement>(sel: string) => mask.querySelector<T>(sel)!;

  $<HTMLSelectElement>("#cfg-theme").value = currentThemeId();
  const originalThemeId = currentThemeId();

  // 点击遮罩层关闭时也恢复主题
  mask.onclick = (e) => {
    if (e.target === mask) {
      applyTheme(originalThemeId);
      close();
    }
  };

  // 主题实时预览：选择后立即变换，取消恢复，保存确认
  $<HTMLSelectElement>("#cfg-theme").onchange = () => {
    applyTheme($<HTMLSelectElement>("#cfg-theme").value);
  };
  $<HTMLInputElement>("#cfg-copy-on-select").checked = isCopyOnSelectEnabled();
  $<HTMLInputElement>("#cfg-no-profile").checked = localStorage.getItem("wterm_no_profile") === "true";
  $<HTMLInputElement>("#cfg-webgl").checked = localStorage.getItem("wterm_webgl") === "true";
  $<HTMLInputElement>("#cfg-bg-opacity").value = localStorage.getItem("wterm_background_opacity") ?? "1";
  $<HTMLSelectElement>("#cfg-window-effect").value = localStorage.getItem("wterm_window_effect") ?? "none";
  $<HTMLInputElement>("#cfg-background-image").value = localStorage.getItem("wterm_background_image") ?? "";
  $<HTMLInputElement>("#cfg-background-image-opacity").value = localStorage.getItem("wterm_background_image_opacity") ?? "0.22";
  $<HTMLInputElement>("#cfg-notifications").checked = localStorage.getItem("wterm_notifications") !== "false";
  $<HTMLInputElement>("#cfg-notify-disconnect").checked = localStorage.getItem("wterm_notify_disconnect") !== "false";
  $<HTMLInputElement>("#cfg-notify-command").checked = localStorage.getItem("wterm_notify_command") !== "false";
  $<HTMLInputElement>("#cfg-notify-min-seconds").value = localStorage.getItem("wterm_notify_min_seconds") ?? "8";
  $<HTMLInputElement>("#cfg-notify-keywords").value = localStorage.getItem("wterm_notify_keywords") ?? "";
  $<HTMLInputElement>("#cfg-keychain-enabled").checked = localStorage.getItem("wterm_keychain_enabled") !== "false";

  $<HTMLSelectElement>('#cfg-right-click').value = localStorage.getItem('wterm_right_click') || 'copy-paste';
  const numeric = [
    ['font-size', 'font_size', 14, 8, 40], ['line-height', 'line_height', 1.25, 1, 2],
    ['letter-spacing', 'letter_spacing', 0, 0, 5], ['scrollback', 'scrollback', 10000, 100, 100000],
  ] as const;
  for (const [id, key, fallback] of numeric) $<HTMLInputElement>(`#cfg-${id}`).value = localStorage.getItem(`wterm_${key}`) ?? String(fallback);
  $<HTMLInputElement>('#cfg-font-family').value = localStorage.getItem('wterm_font_family') || '';

  // 终端字体下拉：自定义 combobox（原生 datalist 弹窗在 WebView2 深色主题下渲染为亮色）
  const fontInput = $<HTMLInputElement>('#cfg-font-family');
  const fontList = $('#font-combobox-list')!;
  const fontOptions = ['Cascadia Code', 'Consolas', 'JetBrains Mono', 'Courier New'];
  let activeFont = -1;
  const renderFontList = (filter: string) => {
    const q = filter.trim().toLowerCase();
    const items = fontOptions.filter(f => !q || f.toLowerCase().includes(q));
    fontList.innerHTML = items.map((f, i) => `<li role="option" data-value="${f}"${i === activeFont ? ' class="active"' : ''}>${f}</li>`).join('');
    fontList.hidden = items.length === 0;
  };
  const placeFontList = () => {
    const r = fontInput.getBoundingClientRect();
    fontList.style.top = `${r.bottom + 4}px`;
    fontList.style.left = `${r.left}px`;
    fontList.style.width = `${r.width}px`;
  };
  const openFontList = () => {
    renderFontList(fontInput.value);
    if (fontList.hidden) return;
    placeFontList();
    fontInput.setAttribute('aria-expanded', 'true');
  };
  const closeFontList = () => {
    fontList.hidden = true;
    activeFont = -1;
    fontInput.setAttribute('aria-expanded', 'false');
  };
  fontInput.addEventListener('focus', openFontList);
  fontInput.addEventListener('input', () => { activeFont = -1; openFontList(); });
  $('#font-combobox-caret')!.onclick = (e) => {
    e.preventDefault();
    if (fontList.hidden) { fontInput.focus(); openFontList(); } else closeFontList();
  };
  fontList.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (!li) return;
    fontInput.value = li.dataset.value!;
    closeFontList();
    fontInput.focus();
  });
  fontInput.addEventListener('keydown', (e) => {
    const items = [...fontList.querySelectorAll('li')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (fontList.hidden || !items.length) { openFontList(); return; }
      activeFont = e.key === 'ArrowDown' ? (activeFont + 1) % items.length : (activeFont - 1 + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === activeFont));
      items[activeFont].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !fontList.hidden && activeFont >= 0 && items[activeFont]) {
      e.preventDefault();
      fontInput.value = items[activeFont].dataset.value!;
      closeFontList();
    } else if (e.key === 'Escape') closeFontList();
  });
  mask.addEventListener('click', (e) => {
    if (!fontList.hidden && !(e.target as HTMLElement).closest('.font-combobox')) closeFontList();
  });
  $('.settings-content')!.addEventListener('scroll', () => { if (!fontList.hidden) placeFontList(); });
  $<HTMLInputElement>('#cfg-log-colors').checked = localStorage.getItem('wterm_log_colors') !== 'false';
  const shortcuts = bindings();
  for (const key of Object.keys(actions) as Action[]) {
    const row = document.createElement('label'); row.className = 'shortcut-item';
    const text = document.createElement('span'); text.className = 'desc'; text.textContent = actions[key][0];
    const input = document.createElement('input'); input.className = 'shortcut-input'; input.readOnly = true; input.value = shortcuts[key]; input.dataset.action = key;
    input.onkeydown = e => {
      if (e.key === 'Tab') return;
      e.preventDefault(); e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
      input.value = keyChord(e);
    };
    row.append(text, input); $('#shortcut-editor').append(row);
  }
  $<HTMLSelectElement>("#cfg-shortcut-preset").onchange = event => {
    const preset = shortcutPresets[(event.currentTarget as HTMLSelectElement).value];
    if (!preset) return;
    mask.querySelectorAll<HTMLInputElement>("[data-action]").forEach(input => {
      const action = input.dataset.action as Action;
      input.value = preset[action] || actions[action][1];
    });
  };
  $('#cfg-reset-shortcuts').onclick = () => {
    $<HTMLSelectElement>("#cfg-shortcut-preset").value = "default";
    mask.querySelectorAll<HTMLInputElement>('[data-action]').forEach(input => { input.value = actions[input.dataset.action as Action][1]; });
  };

  // 导航栏切换
  mask.querySelectorAll<HTMLDivElement>(".settings-nav-item").forEach((nav) => {
    nav.onclick = () => {
      closeFontList();
      mask.querySelectorAll(".settings-nav-item").forEach((n) => n.classList.remove("active"));
      mask.querySelectorAll(".settings-pane").forEach((p) => p.classList.remove("active"));
      nav.classList.add("active");
      const target = nav.getAttribute("data-tab");
      mask.querySelector(`#pane-${target}`)?.classList.add("active");
      mask.querySelector<HTMLElement>(".settings-content")!.scrollTop = 0;
    };
  });

  $("#cfg-known-hosts").onclick = () => { void showKnownHostsManager(); };

  $("#cfg-clear-cache").onclick = () => {
    clearAuthCache();
  };
  $("#cfg-clear-keychain").onclick = async () => {
    const profiles = await invoke<SshProfile[]>("list_ssh_profiles").catch(() => []);
    await Promise.all(profiles.flatMap(profile => {
      const removals: Promise<void>[] = [
        deleteCredential("password", passwordCredentialKey(profile.username, profile.host, profile.port)),
      ];
      if (profile.identity_file) removals.push(deleteCredential("passphrase", profile.identity_file));
      return removals;
    }));
    alert("已清除 wterm 在系统凭据库中的已知 SSH 密码与 Passphrase。");
  };

  $("#cfg-cancel").onclick = () => {
    // 恢复原始主题
    applyTheme(originalThemeId);
    close();
  };

  $("#cfg-save").onclick = () => {
    const updated: Partial<Record<Action, string>> = {};
    const used = new Set(['ctrl+v', 'meta+v']);
    for (const input of mask.querySelectorAll<HTMLInputElement>('[data-action]')) {
      if (used.has(input.value.toLowerCase())) { $('#cfg-error').textContent = '快捷键冲突（Ctrl+V / Cmd+V 保留用于粘贴）'; return; }
      used.add(input.value.toLowerCase()); updated[input.dataset.action as Action] = input.value;
    }
    for (const [id, , , min, max] of numeric) {
      const input = $<HTMLInputElement>(`#cfg-${id}`), value = Number(input.value);
      if (!input.value || !Number.isFinite(value) || value < min || value > max) { input.reportValidity(); return; }
    }
    localStorage.setItem('wterm_log_colors', String($<HTMLInputElement>('#cfg-log-colors').checked));
    localStorage.setItem('wterm_font_family', $<HTMLInputElement>('#cfg-font-family').value.trim());
    localStorage.setItem('wterm_shortcuts', JSON.stringify(updated));
    setTheme($<HTMLSelectElement>("#cfg-theme").value);
    localStorage.setItem('wterm_right_click', $<HTMLSelectElement>('#cfg-right-click').value);
    for (const [id, key] of numeric) localStorage.setItem(`wterm_${key}`, $<HTMLInputElement>(`#cfg-${id}`).value);
    const sel = $<HTMLSelectElement>("#cfg-default-shell");
    const chosenCmd = sel.value;
    const chosenName = sel.selectedOptions[0]?.getAttribute("data-name") || "本地终端";
    if (chosenCmd) {
      setDefaultShellCommand(chosenCmd);
      setDefaultShellName(chosenName);
    }
    const copyOnSelect = $<HTMLInputElement>("#cfg-copy-on-select").checked;
    setCopyOnSelectEnabled(copyOnSelect);
    localStorage.setItem("wterm_no_profile", String($<HTMLInputElement>("#cfg-no-profile").checked));
    localStorage.setItem("wterm_webgl", String($<HTMLInputElement>("#cfg-webgl").checked));
    localStorage.setItem("wterm_background_opacity", $<HTMLInputElement>("#cfg-bg-opacity").value);
    localStorage.setItem("wterm_window_effect", $<HTMLSelectElement>("#cfg-window-effect").value);
    localStorage.setItem("wterm_background_image", $<HTMLInputElement>("#cfg-background-image").value.trim());
    localStorage.setItem("wterm_background_image_opacity", $<HTMLInputElement>("#cfg-background-image-opacity").value);
    localStorage.setItem("wterm_notifications", String($<HTMLInputElement>("#cfg-notifications").checked));
    localStorage.setItem("wterm_notify_disconnect", String($<HTMLInputElement>("#cfg-notify-disconnect").checked));
    localStorage.setItem("wterm_notify_command", String($<HTMLInputElement>("#cfg-notify-command").checked));
    localStorage.setItem("wterm_notify_min_seconds", $<HTMLInputElement>("#cfg-notify-min-seconds").value);
    localStorage.setItem("wterm_notify_keywords", $<HTMLInputElement>("#cfg-notify-keywords").value.trim());
    localStorage.setItem("wterm_keychain_enabled", String($<HTMLInputElement>("#cfg-keychain-enabled").checked));
    void applyAppearance();
    close();
  };
}

export function getCachedPassphrase(keyPath: string): string | undefined {
  return passphraseCache.get(keyPath);
}

export function setCachedPassphrase(keyPath: string, pass: string): void {
  passphraseCache.set(keyPath, pass);
}

export function getCachedPassword(key: string): string | undefined {
  return passwordCache.get(key);
}

export function setCachedPassword(key: string, pass: string): void {
  passwordCache.set(key, pass);
}

export async function connectProfile(profile: SshProfile): Promise<void> {
  // Reuse before asking for a password or decrypting a key: OTP is never cached.
  if (await tryReuseSshProfile(profile)) return;
  if (profile.auth === "password") {
    const cacheKey = passwordCredentialKey(profile.username, profile.host, profile.port);
    const cached = getCachedPassword(cacheKey) ?? await loadCredential("password", cacheKey);
    if (cached) {
      setCachedPassword(cacheKey, cached);
      void newSshSession(profile, cached);
      return;
    }
    showPasswordDialog(profile);
    return;
  }
  if (profile.identity_file) {
    const cachedPass = getCachedPassphrase(profile.identity_file) ?? await loadCredential("passphrase", profile.identity_file);
    if (cachedPass) {
      setCachedPassphrase(profile.identity_file, cachedPass);
      void newSshSession(profile, undefined, cachedPass);
      return;
    }
    try {
      const status = await invoke<string>("check_ssh_key_status", { keyPath: profile.identity_file });
      if (status === "encrypted") {
        showKeyPassphraseDialog(profile);
        return;
      }
    } catch (e) {
      console.warn("检查密钥失败:", e);
    }
  }
  newSshSession(profile);
}

export function showKeyPassphraseDialog(profile: SshProfile): void {
  const keyName = profile.identity_file ? profile.identity_file.split(/[/\\]/).pop() : "私钥";
  const { mask, close } = showDialog(
    `解锁私钥 (${profile.name})`,
    `
    <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:12px;">
      私钥 <code>${keyName}</code> 已加密，请输入密码短语 (Passphrase)：
    </div>
    <div class="field">
      <label>私钥密码短语</label>
      <input id="k-pass" type="password" placeholder="Passphrase" />
      <label class="setting-check compact"><input id="k-save-keychain" type="checkbox" checked /> 保存到系统 Keychain / Credential Manager</label>
    </div>
    <div class="dialog-actions">
      <span class="dialog-error" id="k-err"></span>
      <div style="display:flex;gap:8px">
        <button class="btn" id="k-cancel">取消</button>
        <button class="btn primary" id="k-ok">解密并连接</button>
      </div>
    </div>`
  );
  const $ = <T extends HTMLElement>(sel: string) => mask.querySelector<T>(sel)!;
  $("#k-cancel").onclick = close;
  const go = async () => {
    const passphrase = $<HTMLInputElement>("#k-pass").value;
    if (profile.identity_file && passphrase) {
      setCachedPassphrase(profile.identity_file, passphrase);
      if ($<HTMLInputElement>("#k-save-keychain").checked) {
        await saveCredential("passphrase", profile.identity_file, passphrase);
      }
    }
    close();
    void newSshSession(profile, undefined, passphrase || undefined);
  };
  $("#k-ok").onclick = () => { void go(); };
  $<HTMLInputElement>("#k-pass").onkeydown = (e) => {
    if (e.key === "Enter") void go();
  };
  $<HTMLInputElement>("#k-pass").focus();
}

function showPasswordDialog(profile: SshProfile): void {
  const { mask, close } = showDialog(
    `连接 ${profile.name}`,
    `
    <div class="field"><label>${profile.username}@${profile.host} 的密码</label>
      <input id="p-pass" type="password" />
      <label class="setting-check compact"><input id="p-save-keychain" type="checkbox" checked /> 保存到系统 Keychain / Credential Manager</label>
    </div>
    <div class="dialog-actions">
      <span class="dialog-error"></span>
      <div style="display:flex;gap:8px">
        <button class="btn" id="p-cancel">取消</button>
        <button class="btn primary" id="p-ok">连接</button>
      </div>
    </div>`
  );
  const $ = <T extends HTMLElement>(sel: string) => mask.querySelector<T>(sel)!;
  $("#p-cancel").onclick = close;
  const go = async () => {
    const pwd = $<HTMLInputElement>("#p-pass").value;
    if (pwd) {
      const cacheKey = passwordCredentialKey(profile.username, profile.host, profile.port);
      setCachedPassword(cacheKey, pwd);
      if ($<HTMLInputElement>("#p-save-keychain").checked) {
        await saveCredential("password", cacheKey, pwd);
      }
    }
    close();
    void newSshSession(profile, pwd);
  };
  $("#p-ok").onclick = () => { void go(); };
  $<HTMLInputElement>("#p-pass").onkeydown = (e) => {
    if (e.key === "Enter") void go();
  };
  $<HTMLInputElement>("#p-pass").focus();
}
