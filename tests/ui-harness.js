import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
window.emitPty = async (sid, text) => emit(`pty-output-${sid}`, Array.from(new TextEncoder().encode(text)));
window.emitCloseRequest = async () => emit('tauri://close-requested');
mockWindows('main');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = window.testState = { calls: [], authResolve: null, transfers: new Map() };
state.settingsPath = 'C:\\fixtures\\settings.json';
state.aiModels = ['deepseek-chat', 'deepseek-reasoner'];
state.aiRequests = new Map();
state.aiCredentials = new Map();
state.profiles = window.savedProfiles ?? [];
state.sshAutoConnect = window.sshAutoConnect ?? false;
state.aiHistory = new Map(Object.entries(JSON.parse(localStorage.getItem('__test_ai_history') || '{}')));
for (const value of state.aiHistory.values()) {
  let changed = false;
  for (const message of value.messages) if (message.status === 'generating') { message.status = 'interrupted'; changed = true; }
  if (changed) value.revision++;
}
const persistAiHistory = () => localStorage.setItem('__test_ai_history', JSON.stringify(Object.fromEntries(state.aiHistory)));
persistAiHistory();
mockIPC(async (command, args) => {
  state.calls.push({ command, args });
  switch (command) {
    case 'ai_history_list': {
      if (window.aiHistoryError) throw new Error(window.aiHistoryError);
      const values = [...state.aiHistory.values()].filter(value => !args.search || JSON.stringify(value).toLowerCase().includes(args.search.toLowerCase()))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
      return { total: values.length, items: values.slice(args.offset, args.offset + 100).map(value => ({ id: value.id, connection: value.connection, title: value.title,
        pinned: value.pinned, updatedAt: value.updatedAt, lastOpenedAt: value.lastOpenedAt, preview: [...value.messages].reverse().find(message => message.content)?.content.slice(0, 100) || '' })) };
    }
    case 'ai_history_get': {
      if (window.aiHistoryGetError) throw new Error(window.aiHistoryGetError);
      return structuredClone(state.aiHistory.get(args.id) ?? null);
    }
    case 'ai_history_open': {
      const value = state.aiHistory.get(args.id); if (value) { value.lastOpenedAt = Date.now(); persistAiHistory(); } return;
    }
    case 'ai_history_recent': {
      if (window.aiRecentDelay) await delay(window.aiRecentDelay);
      return structuredClone([...state.aiHistory.values()].filter(value => value.connection.id === args.connectionId && value.connection.targetKey === args.targetKey)
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt)[0] ?? null);
    }
    case 'ai_history_save': {
      if (window.aiHistoryError) throw new Error(window.aiHistoryError);
      const value = structuredClone(args.conversation);
      const previous = state.aiHistory.get(value.id);
      if ((previous?.revision ?? 0) !== value.revision || (!previous && value.revision !== 0)) throw new Error('该会话已在其他窗口更新或删除');
      value.revision++; state.aiHistory.set(value.id, value); persistAiHistory(); return value.revision;
    }
    case 'ai_history_delete': {
      if (state.aiHistory.get(args.id)?.revision !== args.revision) throw new Error('该会话已在其他窗口更新');
      state.aiHistory.delete(args.id); persistAiHistory(); return;
    }
    case 'get_launch_directory': return window.initialLaunchDirectory ?? null;
    case 'get_app_settings_path': return { path: state.settingsPath, defaultPath: 'C:\\fixtures\\settings.json' };
    case 'set_app_settings_path': state.settingsPath = args.newPath; return { path: state.settingsPath, defaultPath: 'C:\\fixtures\\settings.json' };
    case 'load_app_settings': return window.initialSettingsFile ?? null;
    case 'ai_models':
      await delay(window.aiModelDelay ?? 10);
      if (window.aiModelsError) throw new Error(window.aiModelsError);
      return state.aiModels;
    case 'credential_get': return state.aiCredentials.get(args.kind + ':' + args.key) ?? null;
    case 'credential_set': state.aiCredentials.set(args.kind + ':' + args.key, args.value); return;
    case 'credential_delete': state.aiCredentials.delete(args.kind + ':' + args.key); return;
    case 'ai_cancel': state.aiRequests.delete(args.requestId); return;
    case 'write_session_bytes': {
      if (window.writeInputDelay) await delay(window.writeInputDelay);
      if (window.writeInputError) throw new Error(window.writeInputError);
      if (window.echoTerminalInput) await window.emitPty(args.id, new TextDecoder().decode(new Uint8Array(args.data)));
      return;
    }
    case 'insert_terminal_input': {
      if (window.writeInputDelay) await delay(window.writeInputDelay);
      if (window.writeInputError) throw new Error(window.writeInputError);
      if (window.echoTerminalInput) await window.emitPty(args.id, args.text);
      return;
    }
    case 'ai_chat':
      state.aiRequests.set(args.requestId, args.channel);
      void (async () => {
        await delay(window.aiStartDelay ?? 0);
        args.channel.onmessage({ started: true, done: false });
        if (window.aiHold) return;
        await delay(10);
        if (!state.aiRequests.has(args.requestId)) return;
        if (window.aiError) {
          args.channel.onmessage({ error: window.aiError, done: true });
          state.aiRequests.delete(args.requestId);
          return;
        }
        args.channel.onmessage({ delta: window.aiReply ?? '列出目录内容：\n```bash\n' + (window.aiCode ?? 'ls -la') + '\n```', done: false });
        args.channel.onmessage({ done: true });
        state.aiRequests.delete(args.requestId);
      })();
      return;
    case 'spawn_local': await delay(window.localSpawnDelay ?? 400); return args.shell || 'pwsh.exe';
    case 'list_available_shells':
      await delay(200);
      return [
        { id: 'pwsh', name: 'PowerShell 7', command: 'pwsh.exe', icon: '⚡' },
        { id: 'wsl', name: 'WSL Bash', command: 'wsl.exe', icon: '◧' },
      ];
    case 'scan_ssh_config':
      await delay(200);
      return [{ alias: 'jumpserver', host: 'test.invalid', port: 22, username: 'fixture', identity_file: 'test-key' }];
    case 'check_ssh_key_status': return 'ok';
    case 'list_ssh_profiles': return state.profiles;
    case 'spawn_ssh':
      if (state.sshAutoConnect) return;
      return new Promise(resolve => {
        state.authResolve = resolve;
        args.authChannel.onmessage({ request_id: 'fixture-mfa', name: '身份验证', instructions: 'Please Enter MFA Code.', prompts: [{ prompt: 'OTP Code', echo: false }] });
      });
    case 'respond_ssh_auth': state.authResolve?.(); return;
    case 'spawn_ssh_on_existing': await delay(20); return;
    case 'session_is_ssh': return true;
    case 'plugin:dialog|open': return ['C:\\fixtures\\upload.bin'];
    case 'plugin:dialog|save': return state.downloadPath ?? 'C:\\fixtures\\download.bin';
    case 'open_downloaded_file':
      if (state.openFileError) throw new Error(state.openFileError);
      return;
    case 'open_local_terminal_path':
      if (state.openPathError) throw new Error(state.openPathError);
      return;
    case 'sftp_home': return '/home/' + args.sid;
    case 'sftp_list': return [{ name: 'readme.txt', path: args.path + '/readme.txt', is_dir: false, size: 100, modified: 0, permissions: 0o644 }];
    case 'sftp_transfer': return new Promise((resolve, reject) => {
      state.transfers.set(args.transferId, { resolve, reject });
      setTimeout(() => void emit('wterm-sftp-transfer', { id: args.transferId, sid: args.sid, done: 1024, total: 4096, speed: 2048 }), 50);
    });
    case 'sftp_transfer_control':
      if (args.action === 'cancel') state.transfers.get(args.transferId)?.reject(new Error('传输已取消'));
      return;
    default: return;
  }
}, { shouldMockEvents: true });
await import('/src/main.ts');
