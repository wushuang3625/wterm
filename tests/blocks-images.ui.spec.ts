import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
});

test('command history replaces the terminal view on demand without shrinking it', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('wterm_blocks_mode', 'shell'));
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.evaluate(async () => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    await (window as any).emitPty(sid, '\x1b]133;A\x07PS> \x1b]133;B\x07');
  });
  await page.locator('.term-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo hello');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    await (window as any).emitPty(sid, 'echo hello\r\nhello\r\n\x1b]133;D;0\x07\x1b]133;A\x07PS> \x1b]133;B\x07');
  });
  const panel = page.locator('.term-pane.active .blocks-panel');
  await expect(panel).toBeHidden();
  await expect(page.locator('.blocks-toggle:visible')).toContainText('1');
  const terminalBefore = await page.locator('.term-pane.active .xterm').boundingBox();
  await page.screenshot({ path: 'test-results/blocks-terminal.png' });
  await page.locator('.blocks-toggle:visible').click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.locator('.blocks-toggle:visible').click();
  await expect(panel).toBeVisible();
  const layout = await page.locator('.term-pane.active').evaluate(pane => {
    const panel = pane.querySelector('.blocks-panel')!.getBoundingClientRect();
    const terminal = pane.querySelector('.xterm')!.getBoundingClientRect();
    return { panelHeight: panel.height, terminalHeight: terminal.height,
      panelWidth: panel.width, terminalWidth: terminal.width,
      terminalInert: (pane.querySelector('.xterm') as HTMLElement).inert };
  });
  expect(layout.panelHeight).toBeGreaterThan(layout.terminalHeight * .9);
  expect(layout.panelWidth).toBeGreaterThan(layout.terminalWidth * .9);
  expect(layout.terminalHeight).toBe(terminalBefore!.height);
  expect(layout.terminalInert).toBe(true);
  const block = page.locator('.command-block');
  await expect(block).toHaveCount(1);
  await expect(block.locator('summary code')).toHaveText('echo hello');
  await expect(block.locator('.block-output')).toContainText('hello');
  await expect(block.locator('.block-state')).toHaveText('退出 0');
  await block.getByRole('button', { name: '复制' }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'))).toBe('echo hello\nhello');
  await page.screenshot({ path: 'test-results/blocks.png' });
  await block.locator('summary').click();
  await expect(block).not.toHaveAttribute('open', '');
  await block.locator('summary').click();
  await block.getByRole('button', { name: '重新运行' }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.some((call: any) =>
    call.command === 'write_session' && call.args.data === 'echo hello\r'))).toBe(true);
});

test('blocks setting applies to an existing terminal', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.blocks-toggle:visible')).toHaveCount(0);
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('#cfg-blocks-mode').selectOption('compatible');
  await page.locator('#cfg-save').click();
  await expect(page.locator('.blocks-toggle:visible')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('wterm_blocks_mode'))).toBe('compatible');
  await page.locator('.term-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(page.locator('.command-block summary code')).toHaveText('pwd');
});

test('iTerm2 image stays fully visible after font zoom; sixel still renders in terminal', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createTerminal } = await import('/src/terminal.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;width:400px;height:200px;left:0;top:0';
    document.body.append(host);
    const { term, image } = createTerminal(host);
    const source = document.createElement('canvas');
    source.width = 1000; source.height = 700;
    source.getContext('2d')!.fillStyle = '#ff0000';
    source.getContext('2d')!.fillRect(0, 0, 2, 2);
    const base64 = source.toDataURL('image/png').split(',')[1];
    const png = `\x1b]1337;File=inline=1;size=${atob(base64).length}:${base64}\x07`;
    await new Promise<void>(resolve => term.write(png, resolve));
    const preview = host.querySelector<HTMLImageElement>('.inline-image-body img')!;
    await preview.decode();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const body = host.querySelector<HTMLElement>('.inline-image-body')!;
    const fits = () => {
      const outer = body.getBoundingClientRect();
      const inner = preview.getBoundingClientRect();
      return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
    };
    const beforeZoom = fits();
    term.options.fontSize = 22;
    term.resize(30, 10);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const afterZoom = fits();
    const iip = preview.naturalWidth === 1000 && preview.naturalHeight === 700 && beforeZoom && afterZoom;
    host.querySelector<HTMLButtonElement>('.inline-image-viewer [aria-label="关闭图片预览"]')!.click();
    term.write('\r\n');
    await new Promise<void>(resolve => term.write('\x1bPq#1;2;100;0;0#1~\x1b\\', resolve));
    await new Promise(resolve => setTimeout(resolve, 100));
    const sixel = image.getImageAtBufferCell(0, 1);
    const red = (canvas?: HTMLCanvasElement) => {
      if (!canvas) return false;
      const pixel = canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data;
      return pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80 && pixel[3] > 0;
    };
    const answer = { iip, sixel: red(sixel), preview: {
      natural: [preview.naturalWidth, preview.naturalHeight],
      beforeZoom, afterZoom,
      outer: body.getBoundingClientRect().toJSON(),
      inner: preview.getBoundingClientRect().toJSON(),
    } };
    term.dispose(); host.remove();
    return answer;
  });
  expect(result.iip, JSON.stringify(result.preview)).toBe(true);
  expect(result.sixel).toBe(true);
});

test('PTY image output opens a fitted preview through the real session path', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600; canvas.height = 1000;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#387c47'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#d58b36'; ctx.fillRect(100, 100, 800, 600);
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    await (window as any).emitPty(sid, `\x1b]1337;File=inline=1;size=${atob(base64).length}:${base64}\x07`);
  });
  const viewer = page.locator('.term-pane.active .inline-image-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1600);
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Minus');
  const fits = await viewer.evaluate(element => {
    const outer = element.querySelector('.inline-image-body')!.getBoundingClientRect();
    const inner = element.querySelector('img')!.getBoundingClientRect();
    return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
  });
  expect(fits).toBe(true);
  await page.screenshot({ path: 'test-results/image-preview.png' });
  await viewer.getByRole('button', { name: '关闭图片预览' }).click();
  await expect(viewer).toBeHidden();
  await page.locator('.inline-image-trigger:visible').click();
  await expect(viewer).toBeVisible();
});
