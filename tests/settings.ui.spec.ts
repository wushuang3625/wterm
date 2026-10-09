import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('migrates legacy preferences and keeps runtime state out of settings.json', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wterm_theme', 'nord');
    localStorage.setItem('wterm_workspace_v1:main', '{"version":1}');
  });
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/settings-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as any).settingsState?.saves.length)).toBe(1);
  const result = await page.evaluate(() => {
    const { configStorage, flushSettings } = (window as any).settingsHarness;
    configStorage.setItem('wterm_font_size', '16');
    configStorage.setItem('wterm_recent_connections', '[]');
    return flushSettings().then(() => (window as any).settingsState.file);
  });
  expect(result).toMatchObject({ wterm_theme: 'nord', wterm_font_size: '16' });
  expect(result).not.toHaveProperty('wterm_workspace_v1:main');
  expect(result).not.toHaveProperty('wterm_recent_connections');
});

test('settings.json overrides stale WebView preferences on startup', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).initialSettingsFile = { wterm_theme: 'dracula' };
    localStorage.setItem('wterm_theme', 'nord');
    localStorage.setItem('wterm_font_size', '20');
  });
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/settings-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!(window as any).settingsHarness)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('wterm_theme'))).toBe('dracula');
  expect(await page.evaluate(() => localStorage.getItem('wterm_font_size'))).toBe('14');
});

test('settings page changes the active JSON path', async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await expect(page.locator('#cfg-settings-path')).toHaveValue('C:\\fixtures\\settings.json');
  await page.locator('#cfg-settings-path').fill('C:\\tracked\\settings.json');
  await page.locator('#cfg-save').click();
  await expect(page.locator('.settings-modal')).toHaveCount(0);
  const call = await page.evaluate(() => (window as any).testState.calls.findLast((entry: any) => entry.command === 'set_app_settings_path'));
  expect(call.args.newPath).toBe('C:\\tracked\\settings.json');
  expect(call.args.settings).toHaveProperty('wterm_theme');
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await expect(page.locator('#cfg-settings-path')).toHaveValue('C:\\tracked\\settings.json');
});
