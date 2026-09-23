export const actions = {
  newTab: ["新建本地标签", "Ctrl+Shift+T"],
  closePane: ["关闭当前窗格", "Ctrl+Shift+W"],
  nextTab: ["下一个标签", "Ctrl+Tab"],
  previousTab: ["上一个标签", "Ctrl+Shift+Tab"],
  splitH: ["左右拆分当前窗格", "Ctrl+Shift+D"],
  splitV: ["上下拆分当前窗格", "Ctrl+Shift+E"],
  grid3: ["三窗格布局", "Ctrl+Alt+3"],
  grid4: ["四窗格布局", "Ctrl+Alt+4"],
  grid9: ["九窗格布局", "Ctrl+Alt+9"],
  nextPane: ["下一个窗格", "Alt+ArrowRight"],
  previousPane: ["上一个窗格", "Alt+ArrowLeft"],
  search: ["搜索终端", "Ctrl+F"],
  quickConnect: ["快速连接", "Ctrl+P"],
  commandPalette: ["命令面板", "Ctrl+K"],
  connections: ["连接管理", "Ctrl+Alt+P"],
  favorites: ["收藏管理", "Ctrl+Alt+F"],
  sftp: ["远程文件", "Ctrl+Shift+R"],
  batch: ["批量连接 / 广播", "Ctrl+Shift+B"],
  settings: ["偏好设置", "Ctrl+,"],
  openDirectory: ["打开本地当前目录", "Ctrl+Shift+O"],
  newWindow: ["新建窗口", "Ctrl+Shift+N"],
  reconnect: ["重新连接", "Ctrl+Shift+U"],
  fontLarger: ["放大终端字体", "Ctrl+="],
  fontSmaller: ["缩小终端字体", "Ctrl+-"],
} as const;

export type Action = keyof typeof actions;

export function bindings(): Record<Action, string> {
  let saved: Partial<Record<Action, string>> = {};
  try { saved = JSON.parse(localStorage.getItem("wterm_shortcuts") || "{}"); } catch {}
  return Object.fromEntries(
    Object.entries(actions).map(([key, value]) => [key, saved?.[key as Action] || value[1]])
  ) as Record<Action, string>;
}

export function keyChord(e: KeyboardEvent): string {
  const raw = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const key = raw === "+" ? "=" : raw;
  return [
    e.ctrlKey ? "Ctrl" : "",
    e.metaKey ? "Meta" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey && key !== "=" ? "Shift" : "",
    key,
  ].filter(Boolean).join("+");
}

export function shortcutAction(e: KeyboardEvent): Action | undefined {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  const chord = keyChord(e).toLowerCase();
  const current = bindings();
  return (Object.keys(actions) as Action[]).find(key => current[key].toLowerCase() === chord);
}

export const shortcutPresets: Record<string, Partial<Record<Action, string>>> = {
  default: Object.fromEntries((Object.keys(actions) as Action[]).map(key => [key, actions[key][1]])),
  vscode: {
    newTab: "Ctrl+Shift+T", closePane: "Ctrl+Shift+W", nextTab: "Ctrl+PageDown", previousTab: "Ctrl+PageUp",
    splitH: "Ctrl+\\", splitV: "Ctrl+Shift+\\", nextPane: "Alt+ArrowRight", previousPane: "Alt+ArrowLeft",
    search: "Ctrl+F", quickConnect: "Ctrl+P", commandPalette: "Ctrl+Shift+P", settings: "Ctrl+,",
    openDirectory: "Ctrl+Shift+O", connections: "Ctrl+Alt+P", favorites: "Ctrl+Alt+F", newWindow: "Ctrl+Shift+N",
  },
  iterm2: {
    newTab: "Meta+T", closePane: "Meta+W", nextTab: "Meta+ArrowRight", previousTab: "Meta+ArrowLeft",
    splitH: "Meta+D", splitV: "Meta+Shift+D", nextPane: "Meta+]", previousPane: "Meta+[",
    search: "Meta+F", quickConnect: "Meta+O", commandPalette: "Meta+Shift+P", settings: "Meta+,",
    openDirectory: "Meta+Shift+O", connections: "Meta+Alt+P", favorites: "Meta+Alt+F", newWindow: "Meta+N",
  },
};
