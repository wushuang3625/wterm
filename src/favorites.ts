export type FavoriteType = "directory" | "script" | "connection";
export type FavoriteScriptEnvironment = "current" | "powershell" | "wsl" | "ssh";

export interface Favorite {
  id: string;
  type: FavoriteType;
  name: string;
  value: string;
  scriptEnvironment?: FavoriteScriptEnvironment;
  scriptTarget?: string;
  cwd?: string;
}

const STORAGE_KEY = "wterm_favorites_v1";
const SCRIPT_ENVIRONMENTS: FavoriteScriptEnvironment[] = ["current", "powershell", "wsl", "ssh"];

export function listFavorites(): Favorite[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Favorite => {
      if (
        !item || typeof item !== "object" ||
        typeof (item as Favorite).id !== "string" ||
        !["directory", "script", "connection"].includes((item as Favorite).type) ||
        typeof (item as Favorite).name !== "string" ||
        typeof (item as Favorite).value !== "string"
      ) return false;
      const env = (item as Favorite).scriptEnvironment;
      const validEnv = env === undefined || SCRIPT_ENVIRONMENTS.includes(env);
      const cwd = (item as Favorite).cwd;
      const validCwd = cwd === undefined || typeof cwd === "string";
      return validEnv && validCwd;
    });
  } catch {
    return [];
  }
}

function saveFavorites(items: Favorite[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function favoriteIcon(type: FavoriteType): string {
  return type === "directory" ? "▱" : type === "script" ? "⌘" : "↗";
}

export function favoriteTypeLabel(type: FavoriteType): string {
  return type === "directory" ? "目录" : type === "script" ? "脚本" : "连接";
}

export function favoriteScriptEnvironmentLabel(environment?: FavoriteScriptEnvironment, target?: string): string {
  if (environment === "powershell") return "PowerShell";
  if (environment === "wsl") return "WSL / Bash";
  if (environment === "ssh") return target ? `远程 · ${target}` : "远程连接";
  return "当前终端";
}

const WINDOWS_EXECUTABLE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\).+\.(?:exe|com|bat|cmd|ps1)$/i;

function withoutOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0], last = value[value.length - 1];
  return (first === last && (first === "'" || first === '"')) ? value.slice(1, -1) : value;
}

export function extractDirectoryFromExecutablePath(path: string): string | undefined {
  const clean = withoutOuterQuotes(path.trim());
  if (!WINDOWS_EXECUTABLE_PATH.test(clean)) return undefined;
  const last = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return last > 0 ? clean.slice(0, last) : undefined;
}

export function shellBasename(shell?: string): string {
  return shell?.split(/[\\/]/).pop()?.toLowerCase() || "";
}

function toWslPath(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : null;
}

function toGitBashPath(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return match ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : null;
}

/**
 * 收藏输入框允许用户只填真实可执行文件路径。
 * 根据实际执行环境补上调用符、引号，或转换 Windows 路径，普通命令保持原样。
 */
export function normalizeFavoriteCommand(
  value: string,
  environment: FavoriteScriptEnvironment = "current",
  shell?: string,
): string {
  const trimmed = value.trim();
  if (environment === "ssh") return trimmed;
  const path = withoutOuterQuotes(trimmed);
  if (!WINDOWS_EXECUTABLE_PATH.test(path)) return trimmed;

  const basename = shellBasename(shell);
  const isWsl = environment === "wsl" || basename === "wsl.exe" || basename === "wsl";
  if (isWsl) {
    const wslPath = toWslPath(path);
    if (wslPath) return `'${wslPath.replace(/'/g, "'\\''")}'`;
  }

  const isBash = /^(?:bash|zsh|fish|sh|git-bash)(?:\.exe)?$/i.test(basename);
  if (isBash) {
    const bashPath = toGitBashPath(path);
    if (bashPath) return `'${bashPath.replace(/'/g, "'\\''")}'`;
  }

  const isCmd = /^(?:cmd|command)(?:\.exe)?$/i.test(basename);
  if (environment === "powershell" || !isCmd) return `& '${path.replace(/'/g, "''")}'`;
  return `"${path.replace(/"/g, '""')}"`;
}

export function showFavoritesManager(connectionNames: string[]): void {
  const mask = document.createElement("div");
  mask.className = "dialog-mask";
  const dialog = document.createElement("div");
  dialog.className = "dialog favorites-dialog";
  const title = document.createElement("h2");
  title.textContent = "收藏管理";
  const hint = document.createElement("p");
  hint.className = "setting-hint";
  hint.textContent = "目录会在对应路径打开本地终端；脚本必须绑定执行环境，可选择 PowerShell、WSL / Bash、当前终端或指定 SSH 连接。本地 exe/cmd/bat/ps1 路径可直接填写，程序会自动适配调用格式；连接会直接打开已保存的 SSH Profile。";
  const list = document.createElement("div");
  list.className = "favorites-list";
  const form = document.createElement("div");
  form.className = "favorites-form";
  form.innerHTML =
    '<div class="field-row">' +
      '<div class="field" style="flex:1"><label>类型</label><select id="fav-type"><option value="directory">目录</option><option value="script">脚本</option><option value="connection">连接</option></select></div>' +
      '<div class="field" style="flex:2"><label>名称</label><input id="fav-name" placeholder="例如：项目目录" /></div>' +
    '</div>' +
    '<div class="field" id="fav-value-wrap"><label id="fav-value-label">目录路径</label><input id="fav-value" placeholder="C:\\Projects\\demo" /></div>' +
    '<div class="field" id="fav-connection-wrap" hidden><label>SSH 连接</label><select id="fav-connection"></select></div>' +
    '<div class="field-row" id="fav-script-env-wrap" hidden>' +
      '<div class="field" style="flex:1"><label>执行环境</label><select id="fav-script-env"><option value="powershell">PowerShell（本地）</option><option value="wsl">WSL / Bash（本地）</option><option value="current">当前活动终端</option><option value="ssh">远程 SSH 连接</option></select></div>' +
      '<div class="field" style="flex:1" id="fav-script-target-wrap" hidden><label>远程机器</label><select id="fav-script-target"></select></div>' +
    '</div>' +
    '<div class="field" id="fav-cwd-wrap" hidden><label id="fav-cwd-label">执行目录（工作目录，可选）</label><input id="fav-cwd" placeholder="例如：D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64（留空自动使用程序所在目录）" /></div>' +
    '<div class="dialog-actions"><span class="dialog-error" id="fav-error"></span><button class="btn primary" id="fav-add">添加收藏</button></div>';
  const footer = document.createElement("div");
  footer.className = "dialog-actions";
  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = "完成";
  footer.append(document.createElement("span"), close);
  dialog.append(title, hint, list, form, footer);
  mask.append(dialog);
  document.body.append(mask);

  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const type = $<HTMLSelectElement>("#fav-type");
  const value = $<HTMLInputElement>("#fav-value");
  const connection = $<HTMLSelectElement>("#fav-connection");
  const scriptEnvironment = $<HTMLSelectElement>("#fav-script-env");
  const scriptTarget = $<HTMLSelectElement>("#fav-script-target");
  const cwd = $<HTMLInputElement>("#fav-cwd");
  for (const name of connectionNames) {
    for (const select of [connection, scriptTarget]) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
  }

  const refreshScriptTarget = () => {
    const remoteScript = type.value === "script" && scriptEnvironment.value === "ssh";
    $("#fav-script-target-wrap").hidden = !remoteScript;
  };
  const refreshFields = () => {
    const isConnection = type.value === "connection";
    const isScript = type.value === "script";
    $("#fav-value-wrap").hidden = isConnection;
    $("#fav-connection-wrap").hidden = !isConnection;
    $("#fav-script-env-wrap").hidden = !isScript;
    $("#fav-cwd-wrap").hidden = !isScript;
    if (!isConnection) {
      $("#fav-value-label").textContent = isScript ? "脚本 / 命令" : "目录路径";
      value.placeholder = isScript ? "例如：npm run dev / ./deploy.sh / .\\deploy.ps1" : "C:\\Projects\\demo";
    }
    refreshScriptTarget();
  };
  type.onchange = refreshFields;
  scriptEnvironment.onchange = refreshScriptTarget;
  value.oninput = () => {
    if (type.value === "script" && !cwd.dataset.userEdited) {
      const autoDir = extractDirectoryFromExecutablePath(value.value);
      cwd.placeholder = autoDir
        ? `自动推导：${autoDir}`
        : "例如：D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64（留空自动使用程序所在目录）";
    }
  };
  cwd.oninput = () => {
    cwd.dataset.userEdited = cwd.value.trim() ? "true" : "";
  };
  refreshFields();

  let editingId: string | null = null;

  const resetForm = () => {
    editingId = null;
    $<HTMLInputElement>("#fav-name").value = "";
    value.value = "";
    cwd.value = "";
    delete cwd.dataset.userEdited;
    cwd.placeholder = "例如：D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64（留空自动使用程序所在目录）";
    type.value = "directory";
    $("#fav-error").textContent = "";
    $("#fav-add").textContent = "添加收藏";
    refreshFields();
  };

  const loadIntoForm = (item: Favorite) => {
    editingId = item.id;
    type.value = item.type;
    $<HTMLInputElement>("#fav-name").value = item.name;
    if (item.type === "connection") {
      connection.value = item.value;
    } else {
      value.value = item.value;
    }
    if (item.type === "script") {
      scriptEnvironment.value = item.scriptEnvironment || "current";
      if (item.scriptTarget) scriptTarget.value = item.scriptTarget;
      cwd.value = item.cwd || "";
      cwd.dataset.userEdited = item.cwd ? "true" : "";
    }
    $("#fav-error").textContent = "";
    $("#fav-add").textContent = "更新收藏";
    refreshFields();
    $<HTMLInputElement>("#fav-name").focus();
  };

  const render = () => {
    list.replaceChildren();
    const items = listFavorites();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "favorites-empty";
      empty.textContent = "还没有收藏";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "favorite-row";
      const icon = document.createElement("span");
      icon.className = "favorite-icon";
      icon.textContent = favoriteIcon(item.type);
      const meta = document.createElement("div");
      meta.className = "favorite-meta";
      const name = document.createElement("div");
      name.className = "favorite-name";
      name.textContent = item.name;
      const detail = document.createElement("div");
      detail.className = "favorite-detail";
      const environment = item.type === "script"
        ? ` · ${favoriteScriptEnvironmentLabel(item.scriptEnvironment, item.scriptTarget)}`
        : "";
      const cwdText = (item.type === "script" && item.cwd) ? ` · 目录: ${item.cwd}` : "";
      detail.textContent = favoriteTypeLabel(item.type) + environment + cwdText + " · " + item.value;
      detail.title = detail.textContent;
      meta.append(name, detail);
      const remove = document.createElement("button");
      remove.className = "favorite-remove";
      remove.title = "移除收藏";
      remove.textContent = "×";
      remove.onclick = (e) => {
        e.stopPropagation();
        saveFavorites(listFavorites().filter(candidate => candidate.id !== item.id));
        if (editingId === item.id) resetForm();
        render();
      };
      row.append(icon, meta, remove);
      row.style.cursor = "pointer";
      row.title = "点击编辑此收藏";
      row.onclick = () => loadIntoForm(item);
      if (editingId === item.id) row.classList.add("favorite-row-editing");
      list.append(row);
    }
  };
  render();

  $("#fav-add").onclick = () => {
    const favoriteType = type.value as FavoriteType;
    const rawName = $<HTMLInputElement>("#fav-name").value.trim();
    const favoriteValue = favoriteType === "connection" ? connection.value : value.value.trim();
    if (!favoriteValue) {
      $("#fav-error").textContent = favoriteType === "connection" ? "请先保存一个 SSH 连接" : "请填写收藏内容";
      return;
    }
    const scriptEnv = favoriteType === "script" ? scriptEnvironment.value as FavoriteScriptEnvironment : undefined;
    const scriptTargetName = favoriteType === "script" && scriptEnv === "ssh" ? scriptTarget.value : undefined;
    if (favoriteType === "script" && scriptEnv === "ssh" && !scriptTargetName) {
      $("#fav-error").textContent = "远程脚本需要选择 SSH 连接";
      return;
    }
    const rawCwd = cwd.value.trim();
    const autoCwd = favoriteType === "script" ? extractDirectoryFromExecutablePath(favoriteValue) : undefined;
    const finalCwd = rawCwd || autoCwd || undefined;
    const fallbackName = favoriteType === "directory"
      ? favoriteValue.split(/[\\/]/).filter(Boolean).pop() || favoriteValue
      : favoriteType === "connection" ? favoriteValue : favoriteValue.slice(0, 32);
    const items = listFavorites();
    const newFavorite: Favorite = {
      id: editingId || crypto.randomUUID(),
      type: favoriteType,
      name: rawName || fallbackName,
      value: favoriteValue,
      scriptEnvironment: scriptEnv,
      scriptTarget: scriptTargetName,
      cwd: favoriteType === "script" ? finalCwd : undefined,
    };
    if (editingId) {
      const idx = items.findIndex(candidate => candidate.id === editingId);
      if (idx >= 0) items[idx] = newFavorite;
      else items.push(newFavorite);
    } else {
      items.push(newFavorite);
    }
    saveFavorites(items);
    resetForm();
    render();
  };
  close.onclick = () => mask.remove();
  mask.onclick = event => { if (event.target === mask) mask.remove(); };
  $<HTMLInputElement>("#fav-name").focus();
}
