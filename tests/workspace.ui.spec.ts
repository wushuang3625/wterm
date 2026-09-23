import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/main.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
});

test('slow spawn does not hide new tab; repeated arrow clicks keep one bounded menu', async ({ page }) => {
  await page.setViewportSize({ width: 708, height: 650 });
  const arrow = page.locator('#btn-add-menu');
  await arrow.click();
  await arrow.click();
  await expect(page.locator('.menu-dropdown')).toHaveCount(0);
  await arrow.click();
  await expect(page.locator('.session-filter')).toBeVisible();
  await expect(page.locator('.menu-dropdown')).toHaveCount(1);
  const box = await page.locator('.menu-dropdown').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(708 - 8);
  expect(box!.y + box!.height).toBeLessThanOrEqual(650 - 8);
  await page.keyboard.press('Escape');
  await arrow.click();
  await expect(page.locator('.session-filter')).toBeVisible();
  const counts = await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'list_available_shells').length);
  expect(counts).toBe(1);
  await page.keyboard.press('Escape');
  await page.locator('#btn-add').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/workspace.png' });
});

test('double click blank titlebar toggles maximize without creating a terminal', async ({ page }) => {
  await page.locator('#tabs-blank').dblclick();
  await expect(page.locator('.tab')).toHaveCount(1);
  const commands = await page.evaluate(() => (window as any).testState.calls.map(c => c.command));
  expect(commands.some(command => command.includes('maximize'))).toBe(true);
});

test('tab context menu duplicates the same local shell', async ({ page }) => {
  await page.locator('.tab').click({ button: 'right' });
  await page.getByRole('button', { name: '复制终端（相同 Shell）' }).click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_local').length)).toBe(2);
});

test('MFA is themed; normal connect and duplicate both reuse authenticated transport', async ({ page }) => {
  await page.locator('#btn-add-menu').click();
  await page.locator('.menu-item .title').filter({ hasText: /^jumpserver$/ }).click();
  await expect(page.locator('.auth-dialog')).toBeVisible();
  await expect(page.locator('.auth-dialog .field input')).toHaveAttribute('type', 'password');
  const colors = await page.locator('.auth-dialog').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  expect(colors.background).toBe('rgb(22, 27, 34)');
  const modal = await page.locator('.auth-dialog').boundingBox();
  expect(Math.abs(modal!.x + modal!.width / 2 - 450)).toBeLessThan(2);
  expect(Math.abs(modal!.y + modal!.height / 2 - 325)).toBeLessThan(2);
  await page.screenshot({ path: 'test-results/mfa-themed.png' });
  await page.getByLabel('OTP Code').fill('123456');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.locator('.auth-dialog')).toHaveCount(0);
  await expect(page.locator('.tab .dot.connected')).toHaveCount(2);
  await page.locator('.term-pane.active .xterm').click({ button: 'right', modifiers: ['Shift'] });
  const remoteDirectory = page.getByRole('button', { name: /打开当前目录/ });
  await expect(remoteDirectory).toBeDisabled();
  await expect(remoteDirectory).toContainText('远程连接（不可用）');
  await page.keyboard.press('Escape');
  await page.locator('#btn-add-menu').click();
  await page.locator('.session-filter').fill('fixture@test.invalid');
  await page.locator('.menu-item:not([hidden])').filter({ hasText: 'jumpserver' }).first().click();
  await expect(page.locator('.tab')).toHaveCount(3);
  await expect(page.locator('.tab .dot.connected')).toHaveCount(3);
  await expect(page.locator('.auth-dialog')).toHaveCount(0);
  await page.locator('.tab').last().click({ button: 'right' });
  await page.getByRole('button', { name: '复制终端（复用 SSH 连接）' }).click();
  await expect(page.locator('.tab')).toHaveCount(4);
  const counts = await page.evaluate(() => {
    const calls = (window as any).testState.calls;
    return { fresh: calls.filter(c => c.command === 'spawn_ssh').length, reused: calls.filter(c => c.command === 'spawn_ssh_on_existing').length };
  });
  expect(counts).toEqual({ fresh: 1, reused: 2 });
});

test('favorites open directories and execute scripts in bound PowerShell or WSL environments', async ({ page }) => {
  const openFavorites = async () => {
    await page.locator('#btn-app-menu').click();
    await page.locator('.app-menu .menu-parent').filter({ hasText: '收藏' }).click();
  };

  await openFavorites();
  await page.locator('#btn-favorites').click();
  await expect(page.locator('.favorites-dialog')).toBeVisible();

  await page.locator('#fav-name').fill('项目目录');
  await page.locator('#fav-value').fill('C:\\Projects\\wterm-demo');
  await page.locator('#fav-add').click();

  await page.locator('#fav-type').selectOption('script');
  await expect(page.locator('#fav-script-env')).toHaveValue('powershell');
  await page.locator('#fav-name').fill('启动开发服务');
  await page.locator('#fav-value').fill('npm run dev');
  await page.locator('#fav-add').click();

  await page.locator('#fav-type').selectOption('script');
  await page.locator('#fav-script-env').selectOption('wsl');
  await page.locator('#fav-name').fill('部署 Bash');
  await page.locator('#fav-value').fill('./deploy.sh');
  await page.locator('#fav-add').click();
  await page.getByRole('button', { name: '完成' }).click();

  await openFavorites();
  await page.locator('.app-menu .menu-nested:not([hidden]) .menu-item').filter({ hasText: '项目目录' }).click();
  await expect(page.locator('.tab')).toHaveCount(2);
  const cwd = await page.evaluate(() => {
    const calls = (window as any).testState.calls.filter((call: any) => call.command === 'spawn_local');
    return calls.at(-1)?.args?.cwd;
  });
  expect(cwd).toBe('C:\\Projects\\wterm-demo');

  await openFavorites();
  await page.locator('.app-menu .menu-nested:not([hidden]) .menu-item').filter({ hasText: '启动开发服务' }).click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as any).testState.calls;
    return calls.filter((call: any) => call.command === 'spawn_local').at(-1)?.args?.shell;
  })).toBe('pwsh.exe');
  await expect.poll(() => page.evaluate(() =>
    (window as any).testState.calls.some((call: any) => call.command === 'write_session' && call.args.data === 'npm run dev\r')
  )).toBe(true);

  await openFavorites();
  await page.locator('.app-menu .menu-nested:not([hidden]) .menu-item').filter({ hasText: '部署 Bash' }).click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as any).testState.calls;
    return calls.filter((call: any) => call.command === 'spawn_local').at(-1)?.args?.shell;
  })).toBe('wsl.exe');
  await expect.poll(() => page.evaluate(() =>
    (window as any).testState.calls.some((call: any) => call.command === 'write_session' && call.args.data === './deploy.sh\r')
  )).toBe(true);

  await openFavorites();
  await page.locator('#btn-favorites').click();
  await page.locator('#fav-type').selectOption('script');
  await page.locator('#fav-script-env').selectOption('powershell');
  await expect(page.locator('#fav-cwd-wrap')).toBeVisible();
  await page.locator('#fav-name').fill('CLIProxyAPI');
  await page.locator('#fav-value').fill('D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64\\cli-proxy-api.exe');
  await page.locator('#fav-add').click();
  await page.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('wterm_favorites_v1') || '[]');
    const item = items.find((candidate: any) => candidate.name === 'CLIProxyAPI');
    return { scriptEnvironment: item?.scriptEnvironment, cwd: item?.cwd };
  })).toEqual({
    scriptEnvironment: 'powershell',
    cwd: 'D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64',
  });

  await openFavorites();
  await page.locator('.app-menu .menu-nested:not([hidden]) .menu-item').filter({ hasText: 'CLIProxyAPI' }).click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as any).testState.calls;
    const spawn = calls.filter((call: any) => call.command === 'spawn_local').at(-1)?.args;
    const write = calls.filter((call: any) => call.command === 'write_session').at(-1)?.args?.data;
    return { cwd: spawn?.cwd, write };
  })).toEqual({
    cwd: 'D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64',
    write: "& 'D:\\Program Files\\CLIProxyAPI_7.2.36_windows_amd64\\cli-proxy-api.exe'\r",
  });

  await page.keyboard.press('Control+K');
  await expect(page.locator('.command-palette')).toBeVisible();
  await page.getByLabel('命令面板搜索').fill('启动开发');
  await expect(page.locator('.command-palette-item').filter({ hasText: '收藏 · 启动开发服务' })).toBeVisible();
});

test('command palette supports mouse click actions and opens tree connection manager', async ({ page }) => {
  await page.keyboard.press('Control+K');
  await expect(page.locator('.command-palette')).toBeVisible();
  await page.getByLabel('命令面板搜索').fill('连接管理');
  const item = page.locator('.command-palette-item').filter({ hasText: '连接管理' });
  await expect(item).toBeVisible();
  await item.hover();
  await item.click();
  await expect(page.locator('.command-palette')).toHaveCount(0);
  await expect(page.locator('.profile-tree-dialog')).toBeVisible();
  await expect(page.locator('#profile-tree-root')).toBeVisible();
});

test('settings switch built-in theme and shortcut preset', async ({ page }) => {
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await expect(page.locator('.settings-modal')).toBeVisible();
  await expect(page.locator('#cfg-window-effect')).toBeVisible();
  await expect(page.locator('#cfg-notifications')).toBeVisible();
  await page.locator('[data-tab="security"]').click();
  await expect(page.locator('#cfg-keychain-enabled')).toBeVisible();
  await page.locator('[data-tab="general"]').click();
  await page.locator('#cfg-theme').selectOption('github-light');
  await page.locator('[data-tab="shortcuts"]').click();
  await page.locator('#cfg-shortcut-preset').selectOption('vscode');
  await page.getByRole('button', { name: '保存' }).click();

  const saved = await page.evaluate(() => ({
    theme: localStorage.getItem('wterm_theme'),
    dataset: document.documentElement.dataset.theme,
    shortcuts: JSON.parse(localStorage.getItem('wterm_shortcuts') || '{}'),
  }));
  expect(saved.theme).toBe('github-light');
  expect(saved.dataset).toBe('github-light');
  expect(saved.shortcuts.commandPalette).toBe('Ctrl+Shift+P');
});

test('unknown SSH host key requires explicit fingerprint confirmation', async ({ page }) => {
  await page.evaluate(async () => {
    const { createHostKeyChannel } = await import('/src/hostkey.ts');
    const hostKey = createHostKeyChannel('root@example.test:22');
    (window as any).testHostKey = hostKey;
    (hostKey.channel as any).onmessage({
      request_id: 'host-key-fixture',
      host: 'example.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture-fingerprint',
      changed: false,
    });
  });
  await expect(page.locator('.host-key-dialog')).toBeVisible();
  await expect(page.locator('.host-key-dialog')).toContainText('SHA256:fixture-fingerprint');
  await page.getByRole('button', { name: '信任并保存' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).testState.calls.some((call: any) =>
      call.command === 'respond_ssh_host_key' && call.args.requestId === 'host-key-fixture' && call.args.decision === 'save'
    )
  )).toBe(true);
});

test('smart link provider detects URLs and directory paths, and ctrl+click triggers open', async ({ page }) => {
  const detected = await page.evaluate(async () => {
    const { detectLinksInLine } = await import('/src/terminal.ts');
    const line = 'Open web https://github.com/hero/wterm or localhost:1420, check dir D:\\Projects\\my_app and "C:\\Program Files\\app" or ./relative/path';
    return detectLinksInLine(line);
  });

  expect(detected.length).toBe(5);
  expect(detected[0].raw).toBe('https://github.com/hero/wterm');
  expect(detected[0].type).toBe('url');
  expect(detected[1].raw).toBe('http://localhost:1420');
  expect(detected[1].type).toBe('url');
  expect(detected[2].raw).toBe('D:\\Projects\\my_app');
  expect(detected[2].type).toBe('path');
  expect(detected[3].raw).toBe('C:\\Program Files\\app');
  expect(detected[3].type).toBe('path');
  expect(detected[4].raw).toBe('./relative/path');
  expect(detected[4].type).toBe('path');

  // Test link activation (URL -> open_external_target, Path -> open_local_terminal_path)
  await page.evaluate(async () => {
    const { installSmartLinks } = await import('/src/terminal.ts');
    let capturedProvider: any = null;
    const fakeSession: any = {
      id: 'test-session-links',
      cwd: 'C:\\Users\\Administrator',
      term: {
        buffer: {
          active: {
            getLine: () => ({
              translateToString: () => 'See https://example.com and C:\\Windows\\System32',
              getCell: (x: number) => (x < 60 ? { getChars: () => 'x', getWidth: () => 1 } : undefined),
            }),
          },
        },
        registerLinkProvider: (p: any) => {
          capturedProvider = p;
          return { dispose: () => {} };
        },
      },
      unlisteners: [],
    };
    installSmartLinks(fakeSession);

    let links: any[] = [];
    capturedProvider.provideLinks(1, (res: any[]) => {
      links = res;
    });

    (window as any).testLinks = links;
  });

  const linksCount = await page.evaluate(() => (window as any).testLinks?.length);
  expect(linksCount).toBe(2);

  // Activate without Ctrl -> shows warning tooltip
  await page.evaluate(() => {
    const link = (window as any).testLinks[0];
    link.activate({ ctrlKey: false, metaKey: false, clientX: 100, clientY: 100 } as any);
  });
  await expect(page.locator('.terminal-link-tooltip')).toBeVisible();
  await expect(page.locator('.terminal-link-tooltip')).toContainText('请按住 Ctrl 点击');

  // Activate URL with Ctrl -> invokes open_external_target
  await page.evaluate(() => {
    const link = (window as any).testLinks[0];
    link.activate({ ctrlKey: true, metaKey: false, clientX: 100, clientY: 100 } as any);
  });
  await expect.poll(() =>
    page.evaluate(() =>
      (window as any).testState.calls.some((c: any) =>
        c.command === 'open_external_target' && c.args.target === 'https://example.com'
      )
    )
  ).toBe(true);

  // Activate Path with Ctrl -> invokes open_local_terminal_path
  await page.evaluate(() => {
    const link = (window as any).testLinks[1];
    link.activate({ ctrlKey: true, metaKey: false, clientX: 100, clientY: 100 } as any);
  });
  await expect.poll(() =>
    page.evaluate(() =>
      (window as any).testState.calls.some((c: any) =>
        c.command === 'open_local_terminal_path' && c.args.path === 'C:\\Windows\\System32'
      )
    )
  ).toBe(true);
});


 test('split broadcast sends to sibling and stops immediately', async ({ page }) => {
  await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.term-pane:visible')).toHaveCount(2);
  await page.waitForTimeout(500);
  await expect(page.locator('.pane-toolbar')).toHaveCount(0);
  await page.locator('#split-broadcast').click();
  await expect(page.locator('#split-broadcast')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('echo broadcast');
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'write_sessions_bytes').length)).toBeGreaterThan(0);
  await page.locator('#split-broadcast').click();
  const before = await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'write_sessions_bytes').length);
  await page.keyboard.type('local');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'write_sessions_bytes').length)).toBe(before);
 });
 test('font choice persists and recent connections lead the menu', async ({ page }) => {
  await page.locator('#btn-app-menu').click(); await page.locator('#btn-settings').click();
  await page.locator('#cfg-font-family').fill('Consolas'); await page.locator('#cfg-save').click();
  expect(await page.evaluate(() => localStorage.getItem('wterm_font_family'))).toBe('Consolas');
  await page.locator('#btn-add-menu').click();
  await expect(page.locator('.add-menu .menu-section-title').first()).toHaveText('最近连接');
  const items = await page.locator('.add-menu').innerText();
  expect(items.indexOf('新建自定义 SSH')).toBeLessThan(items.indexOf('本地终端'));
 });

test('log colors preserve original text and ANSI and skip alternate screen', async ({ page }) => {
 await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
 await page.evaluate(async () => {
  const sid = (document.querySelector('.tab') as HTMLElement).dataset.sid;
  await (window as any).emitPty(sid, '2026-09-21 14:22:25.358 INFO hello 中文\r\nWARN warning\r\n\x1b[35mERROR original\x1b[0m\r\n');
 });
 await expect.poll(() => page.locator('.xterm-decoration').count()).toBeGreaterThan(0);
 await page.screenshot({ path: 'test-results/log-colors.png' });
 await page.locator('#btn-app-menu').click(); await page.locator('#btn-settings').click();
 await page.locator('#cfg-log-colors').uncheck(); await page.locator('#cfg-save').click();
 await expect(page.locator('.xterm-decoration')).toHaveCount(0);
 await page.locator('#btn-app-menu').click(); await page.locator('#btn-settings').click();
 await page.locator('#cfg-log-colors').check(); await page.locator('#cfg-save').click();
 await expect.poll(() => page.locator('.xterm-decoration').count()).toBeGreaterThan(0);
 await page.evaluate(async () => { await (window as any).emitPty((document.querySelector('.tab') as HTMLElement).dataset.sid, '\x1b[?1049hERROR alternate'); });
 await expect(page.locator('.xterm-decoration')).toHaveCount(0);
});

test('settings keep typography fields and actions usable at desktop and small widths', async ({ page }) => {
 for (const width of [1100, 650]) {
  await page.setViewportSize({ width, height: 760 });
  await page.locator('#btn-app-menu').click(); await page.locator('#btn-settings').click();
  await page.locator('#cfg-theme').selectOption('gruvbox-dark');
  await page.locator('#cfg-font-family').scrollIntoViewIfNeeded();
  const card = page.locator('.typography-card');
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const id of ['cfg-font-family', 'cfg-font-size', 'cfg-line-height', 'cfg-letter-spacing']) {
   const box = await page.locator('#' + id).boundingBox(); expect(box!.width).toBeGreaterThan(85);
  }
  await expect(page.locator('#cfg-save')).toBeInViewport();
  await page.screenshot({ path: 'test-results/settings-' + width + '.png' });
  await page.locator('[data-tab="shortcuts"]').click();
  await expect(page.locator('.shortcut-input').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/shortcuts-' + width + '.png' });
  await page.locator('#cfg-cancel').click();
 }
});
