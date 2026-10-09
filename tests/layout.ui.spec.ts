import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab .connected')).toHaveCount(1);
});

test('splits belong to one tab, recurse, resize and collapse without closing siblings', async ({ page }) => {
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.term-pane:visible')).toHaveCount(2);
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.pane-cell .term-pane.active')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'spawn_local').length)).toBe(2);
  await page.waitForTimeout(450);
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.term-pane:visible')).toHaveCount(3);
  const divider = page.locator('.workspace-root > .split-divider');
  const initial = await page.locator('.pane-cell').first().boundingBox();
  const box = await divider.boundingBox();
  await page.mouse.move(box!.x + 3, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x - 100, box!.y + box!.height / 2); await page.mouse.up();
  const after = await page.locator('.pane-cell').first().boundingBox();
  expect(after!.width).toBeLessThan(initial!.width - 70);
  await page.locator('#btn-add').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.term-pane:visible')).toHaveCount(1);
  await page.locator('.tab').first().click();
  await expect(page.locator('.term-pane:visible')).toHaveCount(3);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.pane-cell.focused')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('.term-pane:visible')).toHaveCount(2);
  await page.locator('.tab').first().click({ button: 'middle' });
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.term-pane:visible')).toHaveCount(1);
});

test('shift-right-click exposes nested one-click split layouts', async ({ page }) => {
  const terminal = page.locator('.term-pane.active .xterm').first();
  await terminal.click({ button: 'right', modifiers: ['Shift'] });
  await expect(page.locator('.terminal-context-menu')).toBeVisible();
  await page.getByRole('button', { name: /分屏/ }).first().click();
  await page.getByRole('button', { name: /一键分屏/ }).click();
  await page.getByRole('button', { name: /四宫格/ }).click();
  await expect(page.locator('.term-pane:visible')).toHaveCount(4);

  await page.waitForTimeout(500);
  await page.locator('.term-pane.active .xterm').first().click({ button: 'right', modifiers: ['Shift'] });
  await page.getByRole('button', { name: /分屏/ }).first().click();
  await page.getByRole('button', { name: /一键分屏/ }).click();
  await page.getByRole('button', { name: /九宫格/ }).click();
  await expect(page.locator('.term-pane:visible')).toHaveCount(9);
  await page.waitForTimeout(500);
  await expect(page.locator('.tab')).toHaveCount(1);
  const boxes = await page.locator('.pane-cell').evaluateAll(cells => cells.map(cell => {
    const r = cell.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  expect(new Set(boxes.map(b => Math.round(b.x))).size).toBe(3);
  expect(new Set(boxes.map(b => Math.round(b.y))).size).toBe(3);
  expect(boxes.every(b => b.w > 150 && b.h > 100)).toBe(true);
  await page.screenshot({ path: 'test-results/nine-panes.png' });
});

test('pointer tab drag reorders in both directions; pane drag swaps sessions without spawning or closing', async ({ page }) => {
  await page.locator('#btn-add').click();
  const before = await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid));
  await page.evaluate(() => {
    (window as any).nativeTabDrags = 0;
    document.addEventListener('dragstart', () => (window as any).nativeTabDrags++);
  });
  const first = await page.locator('.tab .label').first().boundingBox();
  const last = await page.locator('.tab .label').last().boundingBox();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 8 });
  await expect(page.locator('.tab.drop-after')).toHaveCount(1);
  await expect(page.locator('.tab-drop-slot')).toBeVisible();
  expect((await page.locator('.tab.dragging').boundingBox())!.x).toBeGreaterThan(first!.x + 40);
  await expect.poll(async () => (await page.locator('.tab.drop-after').boundingBox())!.x).toBeLessThan(last!.x - 40);
  await page.mouse.move(last!.x + 8, last!.y + last!.height / 2);
  await page.screenshot({ path: 'test-results/tab-drag-preview.png' });
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2);
  await page.mouse.up();
  const after = await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid));
  expect(after).toEqual([...before].reverse());
  await page.waitForFunction(() => [...document.querySelectorAll('.tab')].every(el => el.getAnimations().length === 0));
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2);
  await page.mouse.down();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2, { steps: 8 });
  await expect(page.locator('.tab.drop-before')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.tab-drop-slot')).toHaveCount(0);
  expect(await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid))).toEqual(before);
  expect(await page.evaluate(() => (window as any).nativeTabDrags)).toBe(0);
  await expect(page.locator('.tab.dragging')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.term-pane:visible')).toHaveCount(2);
  const panes = page.locator('.workspace-root:not([hidden]) .pane-cell');
  const ids = await panes.evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid));
  await panes.first().locator('.pane-grip').dragTo(panes.last().locator('.pane-grip'));
  expect(await panes.evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid))).toEqual([...ids].reverse());
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'close_session').length)).toBe(0);
});

test('tab clicks still activate; sorting survives title updates and cancels outside the bar or on Escape', async ({ page }) => {
  await page.locator('#btn-add').click();
  await expect(page.locator('.tab .connected')).toHaveCount(2);
  const ids = await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid));
  await page.locator('.tab .label').first().click();
  await expect(page.locator('.tab.active')).toHaveAttribute('data-sid', ids[0]!);
  const source = await page.locator('.tab .label').first().boundingBox();
  const target = await page.locator('.tab .label').last().boundingBox();
  const start = async () => {
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 6 });
    await expect(page.locator('.tab.dragging')).toHaveCount(1);
  };
  await start();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.tab.dragging, .tab.drop-after')).toHaveCount(0);
  expect(await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid))).toEqual(ids);
  await start();
  await page.mouse.move(400, 300);
  await page.mouse.up();
  expect(await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid))).toEqual(ids);
  await start();
  await page.evaluate(async id => (window as any).emitPty(id, '\x1b]0;updated while dragging\x07'), ids[0]);
  await expect(page.locator('.tab .label').first()).toHaveText('updated while dragging');
  await expect(page.locator('.tab.dragging')).toHaveCount(1);
  await page.mouse.up();
  expect(await page.locator('.tab').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.sid))).toEqual([...ids].reverse());
  await expect(page.locator('.tab.active')).toHaveAttribute('data-sid', ids[0]!);
  await page.locator('.tab .label').first().click();
  await expect(page.locator('.tab.active')).toHaveAttribute('data-sid', ids[1]!);
  await page.locator('.tab .close').first().click();
  await expect(page.locator('.tab')).toHaveCount(1);
});

test('reduced motion keeps a visible drop slot without sliding transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#btn-add').click();
  await expect(page.locator('.tab .connected')).toHaveCount(2);
  const source = await page.locator('.tab .label').first().boundingBox();
  const target = await page.locator('.tab .label').last().boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 6 });
  await expect(page.locator('.tab-drop-slot')).toBeVisible();
  expect(await page.locator('.tab:not(.dragging)').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.mouse.up();
  await expect(page.locator('.tab-drop-slot')).toHaveCount(0);
  expect(await page.locator('.tab').evaluateAll(els => els.flatMap(el => el.getAnimations()).length)).toBe(0);
});

test('settings remap actual split shortcuts, reject collisions and persist right click', async ({ page }) => {
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('#cfg-right-click').selectOption('copy');
  await page.locator('[data-tab="shortcuts"]').click();
  await page.locator('[data-action="splitH"]').focus(); await page.keyboard.press('Control+Alt+H');
  await page.locator('#cfg-save').click();
  expect(await page.evaluate(() => localStorage.getItem('wterm_right_click'))).toBe('copy');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+D'); await expect(page.locator('.term-pane:visible')).toHaveCount(1);
  await page.keyboard.press('Control+Alt+H'); await expect(page.locator('.term-pane:visible')).toHaveCount(2);

  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('[data-tab="shortcuts"]').click();
  await page.locator('[data-action="splitV"]').focus(); await page.keyboard.press('Control+Alt+H');
  await page.locator('#cfg-save').click(); await expect(page.locator('#cfg-error')).toContainText('冲突');
});

test('local current directory is a shift-right-click action and remote-style unavailable state is explicit', async ({ page }) => {
  const sid = await page.locator('.tab').getAttribute('data-sid');
  await page.evaluate(async sid => { await (window as any).emitPty(sid, '\x1b]9;9;C:\\Projects\\中文\x07'); }, sid);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter(c => c.command === 'open_local_directory').length)).toBe(0);

  await page.locator('.term-pane.active .xterm').click({ button: 'right', modifiers: ['Shift'] });
  const directory = page.getByRole('button', { name: /打开当前目录/ });
  await expect(directory).toBeEnabled();
  await expect(directory).toContainText('C:\\Projects\\中文');
  await directory.click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.findLast(c => c.command === 'open_local_directory')?.args.path)).toBe('C:\\Projects\\中文');

  await page.evaluate(async sid => { await (window as any).emitPty(sid, '\x1b]7;file:///C:/Other%20Folder\x07'); }, sid);
  await page.waitForTimeout(100);
  await page.locator('.term-pane.active .xterm').click({ button: 'right', modifiers: ['Shift'] });
  await page.getByRole('button', { name: /打开当前目录/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.findLast(c => c.command === 'open_local_directory')?.args.path)).toBe('C:/Other Folder');
});

test('ordinary right click does not open the menu; shift-right-click does and top toolbar stays clear', async ({ page }) => {
  await expect(page.locator('#btn-layout, #btn-directory, #btn-sftp, #btn-favorites, #btn-batch, #btn-settings')).toHaveCount(0);
  const terminal = page.locator('.term-pane.active .xterm').first();
  await terminal.click({ button: 'right' });
  await expect(page.locator('.terminal-context-menu')).toHaveCount(0);
  await terminal.click({ button: 'right', modifiers: ['Shift'] });
  await expect(page.locator('.terminal-context-menu')).toBeVisible();
  await expect(page.getByRole('button', { name: /分屏/ }).first()).toBeVisible();
});

test('many tabs shrink and mouse wheel scrolls the horizontal tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 650 });
  for (let i = 0; i < 12; i++) await page.locator('#btn-add').click();
  await expect(page.locator('.tab')).toHaveCount(13);
  await expect(page.locator('#tabs')).toHaveClass(/very-dense/);

  await page.locator('.tab').first().click();
  await page.waitForTimeout(100);
  const tabs = page.locator('#tabs');
  const metrics = await tabs.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, left: el.scrollLeft }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  const box = await tabs.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 360);
  await expect.poll(() => tabs.evaluate(el => el.scrollLeft)).toBeGreaterThan(metrics.left);
});

test('terminal surface stays inside the app bounds at fullscreen edge heights', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 96 });
  const metrics = await page.locator('#app').evaluate(app => {
    const appRect = app.getBoundingClientRect();
    const selectors = [
      '.main',
      '.terminal-area',
      '.workspace-root:not([hidden])',
      '.workspace-root:not([hidden]) .pane-cell',
      '.workspace-root:not([hidden]) .term-pane.active',
      '.workspace-root:not([hidden]) .term-pane.active .xterm',
    ];
    return {
      app: { bottom: appRect.bottom, scrollHeight: app.scrollHeight, clientHeight: app.clientHeight },
      nodes: selectors.flatMap(selector => [...app.querySelectorAll<HTMLElement>(selector)].map(node => {
        const rect = node.getBoundingClientRect();
        return { selector, bottom: rect.bottom, right: rect.right };
      })),
    };
  });

  expect(metrics.app.scrollHeight).toBeLessThanOrEqual(metrics.app.clientHeight);
  expect(metrics.nodes.every(node => node.bottom <= metrics.app.bottom + 0.5), JSON.stringify(metrics)).toBe(true);
});
