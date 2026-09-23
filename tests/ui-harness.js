import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
window.emitPty = async (sid, text) => emit(`pty-output-${sid}`, Array.from(new TextEncoder().encode(text)));
mockWindows('main');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = window.testState = { calls: [], authResolve: null, transfers: new Map() };
mockIPC(async (command, args) => {
  state.calls.push({ command, args });
  switch (command) {
    case 'spawn_local': await delay(400); return args.shell || 'pwsh.exe';
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
    case 'list_ssh_profiles': return [];
    case 'spawn_ssh':
      return new Promise(resolve => {
        state.authResolve = resolve;
        args.authChannel.onmessage({ request_id: 'fixture-mfa', name: '身份验证', instructions: 'Please Enter MFA Code.', prompts: [{ prompt: 'OTP Code', echo: false }] });
      });
    case 'respond_ssh_auth': state.authResolve?.(); return;
    case 'spawn_ssh_on_existing': await delay(20); return;
    case 'session_is_ssh': return true;
    case 'plugin:dialog|open': return ['C:\\fixtures\\upload.bin'];
    case 'plugin:dialog|save': return 'C:\\fixtures\\download.bin';
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
