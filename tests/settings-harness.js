import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

mockWindows('main');
const state = window.settingsState = {
  file: window.initialSettingsFile ?? null,
  saves: [],
};
mockIPC((command, args) => {
  if (command === 'load_app_settings') return state.file;
  if (command === 'save_app_settings') {
    state.file = structuredClone(args.settings);
    state.saves.push(state.file);
  }
});

const { initializeSettings, configStorage, flushSettings } = await import('/src/config-storage.ts');
await initializeSettings();
window.settingsHarness = { configStorage, flushSettings };
