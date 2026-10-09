import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Explorer directory is passed unchanged to a fresh terminal and preserves normal workspace history', async ({ page }) => {
  const directory = 'C:\\目录 空格\\';
  const normalKey = 'wterm_workspace_v1:main';
  const saved = JSON.stringify({ version: 1, activeTab: 0, tabs: [{ root: { type: 'leaf', leaf: { kind: 'local', title: 'original', shell: 'pwsh.exe', cwd: 'C:\\old' } } }] });
  await page.addInitScript(({ directory, normalKey, saved }) => {
    (window as any).initialLaunchDirectory = directory;
    localStorage.setItem(normalKey, saved);
  }, { directory, normalKey, saved });
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab .connected')).toHaveCount(1);
  const calls = await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_local'));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.cwd).toBe(directory);
  await page.evaluate(() => (window as any).emitCloseRequest());
  expect(await page.evaluate(key => localStorage.getItem(key), normalKey)).toBe(saved);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key + ':explorer'), normalKey)).not.toBeNull();
});
