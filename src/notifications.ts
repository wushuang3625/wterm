import { configStorage } from './config-storage';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let lastKeywordNotice = 0;

export function notificationsEnabled(): boolean {
  return configStorage.getItem("wterm_notifications") !== "false";
}

export async function notifySystem(title: string, body: string): Promise<void> {
  if (!notificationsEnabled()) return;
  try {
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
    if (allowed) sendNotification({ title, body });
  } catch (error) {
    console.warn("系统通知失败", error);
  }
}

export function notifyDisconnect(title: string): void {
  if (configStorage.getItem("wterm_notify_disconnect") === "false") return;
  void notifySystem("wterm · 会话已断开", title);
}

export function notifyCommandCompleted(title: string, elapsedMs: number, exitCode?: string): void {
  if (configStorage.getItem("wterm_notify_command") === "false") return;
  const minSeconds = Math.max(0, Number(configStorage.getItem("wterm_notify_min_seconds") ?? "8") || 8);
  if (elapsedMs < minSeconds * 1000) return;
  const status = exitCode == null || exitCode === "" ? "" : ` · exit ${exitCode}`;
  void notifySystem("wterm · 命令执行完成", `${title} · ${(elapsedMs / 1000).toFixed(1)}s${status}`);
}

export function scanKeywordNotification(title: string, text: string): void {
  const raw = configStorage.getItem("wterm_notify_keywords")?.trim();
  if (!raw) return;
  const keywords = raw.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
  const matched = keywords.find(keyword => text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
  if (!matched || Date.now() - lastKeywordNotice < 3000) return;
  lastKeywordNotice = Date.now();
  void notifySystem("wterm · 关键词触发", `${title} · ${matched}`);
}
