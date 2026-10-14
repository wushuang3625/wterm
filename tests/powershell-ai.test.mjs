import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = await readFile('src-tauri/src/pty.rs', 'utf8');
const hook = JSON.parse(source.match(/const POWERSHELL_PROMPT_HOOK: &str = ("[^\n]+");/)[1]);
for (const shell of ['pwsh.exe', 'powershell.exe']) {
  test(`${shell} prompt reports cmdlet/native failures, later success, and preserves custom prompt`, { skip: process.platform !== 'win32' }, t => {
    const script = `function global:prompt { 'custom> ' }; ${hook}; prompt; Write-Error 'fixture-failure' -ErrorAction Continue; prompt; Write-Output 'success'; prompt; & $env:ComSpec /d /c exit 7; prompt; Write-Error 'cmdlet-after-native' -ErrorAction Continue; prompt; & $env:ComSpec /d /c exit 7; prompt; Write-Output 'success'; prompt`;
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.error?.code === 'ENOENT') { t.skip('Shell is not installed'); return; }
    assert.ifError(result.error);
    const codes = [...result.stdout.matchAll(/\x1b\]133;D;(-?\d+)\x07/g)].map(match => Number(match[1]));
    assert.deepEqual(codes, [1, 0, 7, 1, 7, 0]);
    assert.equal((result.stdout.match(/custom> /g) ?? []).length, 7);
    assert.ok(!result.stdout.includes('PS>'));
  });
}
