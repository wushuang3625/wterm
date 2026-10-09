import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const workspaceKey = 'wterm_workspace_v1:main';
test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab .connected')).toHaveCount(1);
});

test('window close checkpoints output; reopening restores distinct pane histories and creates fresh sessions', async ({ page }) => {
  const firstId = await page.locator('.pane-cell').first().getAttribute('data-sid');
  await page.evaluate(id => (window as any).emitPty(id, '\r\n旧会话 中文输出\r\n\x1b[31mERROR-history\x1b[0m\r\n'), firstId);
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.pane-cell')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_local').length)).toBe(2);
  const secondId = await page.locator('.pane-cell').last().getAttribute('data-sid');
  await page.evaluate(id => (window as any).emitPty(id, '\r\nsecond-pane-history\r\n'), secondId);
  await page.locator('#btn-add').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  const thirdId = await page.locator('.tab').last().getAttribute('data-sid');
  await page.evaluate(id => (window as any).emitPty(id, '\r\nthird-tab-history\r\n'), thirdId);
  await page.evaluate(() => (window as any).emitCloseRequest());
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.some(c => c.command === 'plugin:window|destroy'))).toBe(true);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), workspaceKey);
  expect(saved.tabs[0].root.first.leaf.history.screen).toContain('旧会话');
  expect(saved.tabs[0].root.second.leaf.history.screen).toContain('second-pane-history');
  expect(saved.tabs[1].root.leaf.history.screen).toContain('third-tab-history');
  await page.reload();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_local').length)).toBe(3);
  await expect(page.locator('.workspace-root')).toHaveCount(2);
  await expect(page.locator('.tab .connected')).toHaveCount(2);
  await expect(page.locator('.term-pane:visible .xterm-rows')).toContainText('third-tab-history');
  await page.locator('.tab .label').first().click();
  await expect(page.locator('.tab.active')).toHaveAttribute('data-sid', (await page.locator('.tab').first().getAttribute('data-sid'))!);
  await expect(page.locator('.term-pane:visible')).toHaveCount(2);
  await expect(page.locator('.term-pane:visible .xterm-rows').first()).toContainText('旧会话');
  await expect(page.locator('.term-pane:visible .xterm-rows').last()).toContainText('second-pane-history');
  await expect(page.locator('.term-pane:visible .xterm-rows').first()).toContainText('上次会话历史');
  const newId = await page.locator('.pane-cell').first().getAttribute('data-sid');
  expect(newId).not.toBe(firstId);
  await page.evaluate(id => (window as any).emitPty(id, 'NEW-CONNECTION-OUTPUT\r\n'), newId);
  await expect(page.locator('.term-pane:visible .xterm-rows').first()).toContainText('NEW-CONNECTION-OUTPUT');
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'write_session_bytes' || c.command === 'write_session').length)).toBe(0);
});

test('periodic checkpoint stores normal history while excluding alternate screen and input modes', async ({ page }) => {
  const id = await page.locator('.pane-cell').getAttribute('data-sid');
  await page.evaluate(id => (window as any).emitPty(id, '\r\nnormal-screen-history\r\n\x1b[?1049h\x1b[?1000h\x1b[Hvim-alternate-screen'), id);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), workspaceKey)).toContain('normal-screen-history');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).tabs[0].root.leaf.history, workspaceKey);
  expect(saved.screen).not.toContain('vim-alternate-screen');
  expect(saved.screen).not.toContain('\x1b[?1049h');
  expect(saved.screen).not.toContain('\x1b[?1000h');
  await page.reload();
  await expect(page.locator('.tab .connected')).toHaveCount(1);
  await expect(page.locator('.xterm-rows')).toContainText('normal-screen-history');
  await expect(page.locator('.xterm-rows')).not.toContainText('vim-alternate-screen');
});

test('large output keeps recent complete rows within the storage budget', async ({ page }) => {
  const id = await page.locator('.pane-cell').getAttribute('data-sid');
  await page.evaluate(async id => {
    // Actual PTY output arrives in small chunks, rather than a single 700KB event.
    for (let start = 0; start < 4000; start += 20) {
      const lines = Array.from({ length: 20 }, (_, offset) => `row-${start + offset} ${'中'.repeat(60)}`).join('\r\n');
      await (window as any).emitPty(id, lines + '\r\n');
    }
    await (window as any).emitPty(id, 'LATEST-OUTPUT\r\n');
  }, id);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), workspaceKey)).toContain('LATEST-OUTPUT');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).tabs[0].root.leaf.history, workspaceKey);
  expect(saved.screen.length).toBeLessThanOrEqual(128000);
  expect(saved.screen).not.toContain('row-0 ');
  expect(saved.screen).toContain('row-3999 ');
  await page.reload();
  await expect(page.locator('.xterm-rows')).toContainText('LATEST-OUTPUT');
});

test('SSH history is visible before authentication and is isolated when restored connections are reused', async ({ page }) => {
  await page.evaluate(async () => {
    (window as any).testState.sshAutoConnect = true;
    const { newSshSession } = await import('/src/main.ts');
    const profile = { name: 'history-ssh', host: 'history.invalid', port: 22, username: 'fixture', auth: 'agent' };
    await newSshSession(profile);
    const id = document.querySelector('.tab.active')!.getAttribute('data-sid');
    await (window as any).emitPty(id, '\r\nssh-one-history\r\n');
    await newSshSession(profile);
    const secondId = document.querySelector('.tab.active')!.getAttribute('data-sid');
    await (window as any).emitPty(secondId, '\r\nssh-two-history\r\n');
    await (window as any).emitCloseRequest();
  });
  await expect(page.locator('.tab')).toHaveCount(3);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), workspaceKey)).toContain('ssh-two-history');
  await page.reload();
  await expect(page.locator('.tab .connecting')).toHaveCount(1);
  await expect(page.locator('.term-pane:visible .xterm-rows')).toContainText('ssh-one-history');
  await expect(page.locator('.term-pane:visible .xterm-rows')).toContainText('正在连接');
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_ssh').length)).toBe(1);
  await page.evaluate(() => (window as any).testState.authResolve());
  await expect(page.locator('.tab .connected')).toHaveCount(3);
  await expect(page.locator('.term-pane:visible .xterm-rows')).toContainText('ssh-two-history');
  await expect(page.locator('.term-pane:visible .xterm-rows')).not.toContainText('ssh-one-history');
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_ssh_on_existing').length)).toBe(1);
});

test('legacy workspaces without history still reopen', async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({
    version: 1, width: 900, height: 650, activeTab: 0,
    tabs: [{ focusedIndex: 0, root: { leaf: { kind: 'local', shell: null, title: 'Legacy' } } }],
  })), workspaceKey);
  // Prevent the currently open fixture from replacing the legacy snapshot.
  await page.evaluate(() => (window as any).legacySnapshot = localStorage.getItem('wterm_workspace_v1:main'));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('legacyRestore')) localStorage.setItem('wterm_workspace_v1:main', sessionStorage.getItem('legacyRestore')!);
  });
  await page.evaluate(() => sessionStorage.setItem('legacyRestore', (window as any).legacySnapshot));
  await page.reload();
  await expect(page.locator('.tab .connected')).toHaveCount(1);
  await expect(page.locator('.tab .label')).toHaveText('Legacy');
  await expect(page.locator('.xterm-rows')).not.toContainText('上次会话历史');
});
