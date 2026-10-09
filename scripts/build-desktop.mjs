import { spawn } from 'node:child_process';
import { buildExplorer } from './build-explorer.mjs';
buildExplorer();
const dev = process.argv.includes('--dev');
const child = spawn(process.execPath, [process.env.npm_execpath, 'run', dev ? 'dev:web' : 'build:web'], {
  stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
