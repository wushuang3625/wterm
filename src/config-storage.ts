import { invoke } from '@tauri-apps/api/core';

type Settings = Record<string, string>;
const DEFAULT_SETTINGS: Settings = {
  wterm_theme: 'github-dark',
  wterm_font_family: '',
  wterm_font_size: '14',
  wterm_line_height: '1.25',
  wterm_letter_spacing: '0',
  wterm_scrollback: '10000',
  wterm_right_click: 'copy-paste',
  wterm_copy_on_select: 'false',
  wterm_no_profile: 'false',
  wterm_webgl: 'false',
  wterm_blocks_mode: 'off',
  wterm_background_opacity: '1',
  wterm_background_image: '',
  wterm_background_image_opacity: '0.22',
  wterm_window_effect: 'none',
  wterm_notifications: 'true',
  wterm_notify_disconnect: 'true',
  wterm_notify_command: 'true',
  wterm_notify_min_seconds: '8',
  wterm_notify_keywords: '',
  wterm_keychain_enabled: 'true',
  wterm_log_colors: 'true',
  wterm_shortcuts: '{}',
  wterm_sftp_follow: 'false',
  wterm_sftp_queue_collapsed: 'false',
  wterm_favorites_v1: '[]',
  wterm_ai_provider: '',
  wterm_ai_protocol: 'openai',
  wterm_ai_base_url: '',
  wterm_ai_models: '[]',
  wterm_ai_active_model: '',
  wterm_ai_auto_diagnose: 'false',
};
const isPreference = (key: string) => key.startsWith('wterm_') &&
  !key.includes('workspace') && !key.includes('transfer') && key !== 'wterm_recent_connections';

let initialized = false;
let writeTimer: number | undefined;
let writeQueue: Promise<void> = Promise.resolve();

function snapshot(): Settings {
  const settings: Settings = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && isPreference(key)) settings[key] = localStorage.getItem(key)!;
  }
  return settings;
}

function enqueueWrite(): Promise<void> {
  if (!initialized) return Promise.resolve();
  const settings = snapshot();
  writeQueue = writeQueue.catch(() => {}).then(() => invoke<void>('save_app_settings', { settings }));
  return writeQueue;
}

function scheduleWrite(): void {
  if (!initialized) return;
  if (writeTimer !== undefined) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => { writeTimer = undefined; void enqueueWrite().catch(console.error); }, 80);
}

/** Load the file before importing the application, so module initializers see the saved values. */
export async function initializeSettings(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const saved = await invoke<Settings | null>('load_app_settings');
  // Existing files win; legacy WebView preferences are used only on first run.
  const settings = { ...DEFAULT_SETTINGS, ...(saved === null ? snapshot() : saved) };
  for (const key of Object.keys(snapshot())) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
  initialized = true;
  if (saved === null || Object.keys(DEFAULT_SETTINGS).some(key => !(key in saved))) await enqueueWrite();
}

export async function flushSettings(): Promise<void> {
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer);
    writeTimer = undefined;
    await enqueueWrite();
  }
  await writeQueue;
}

export interface SettingsPath {
  path: string;
  defaultPath: string;
}

export async function getSettingsPath(): Promise<SettingsPath> {
  return invoke<SettingsPath>('get_app_settings_path');
}

export async function setSettingsPath(path: string): Promise<SettingsPath> {
  await flushSettings();
  return invoke<SettingsPath>('set_app_settings_path', { newPath: path, settings: snapshot() });
}

export const configStorage = {
  getItem(key: string): string | null { return localStorage.getItem(key); },
  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
    if (isPreference(key)) scheduleWrite();
  },
  removeItem(key: string): void {
    localStorage.removeItem(key);
    if (isPreference(key)) scheduleWrite();
  },
};
