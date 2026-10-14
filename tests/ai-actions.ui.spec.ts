import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page, options = {}) {
  await page.addInitScript(options => {
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1'); localStorage.setItem('wterm_ai_models', '["deepseek-chat"]');
    localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
    Object.assign(window, options);
  }, options);
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/'); await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-input')).toBeEnabled();
}
async function send(page, text) { await page.locator('.ai-input').fill(text); await page.locator('.ai-send').click(); await expect(page.locator('.ai-user').last()).toHaveText(text); await expect(page.locator('.ai-stop')).toBeHidden(); }
async function selectTerminalText(page, text = 'echo selected') {
  await page.evaluate(async text => {
    const id = (window as any).testState.calls.find(call => call.command === 'spawn_local').args.id;
    await (window as any).emitPty(id, '\x1b[2J\x1b[H' + text);
  }, text);
  const span = page.locator('.term-pane.active .xterm-rows span').filter({ hasText: text }).first(); await expect(span).toBeVisible();
  const box = await span.boundingBox();
  await page.mouse.move(box!.x + 1, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width + 2, box!.y + box!.height / 2, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.ai-select-btn')).toBeVisible();
  return { x: box!.x + box!.width + 2, y: box!.y + box!.height / 2 };
}

test('a preview remains editable; typing enters the selected conversation and preserves the previous draft', async ({ page }) => {
  await open(page); await send(page, '甲'); await page.locator('.ai-new').click(); await send(page, '乙'); await page.locator('.ai-input').fill('乙的草稿');
  await page.locator('.ai-history-row').filter({ hasText: '甲' }).click(); await expect(page.locator('.ai-conversation-phase')).toHaveText('预览');
  await page.locator('.ai-input').fill('甲的后续问题'); await expect(page.locator('.ai-conversation-phase')).toHaveText('当前会话');
  await page.locator('.ai-send').click(); await expect(page.locator('.ai-user')).toHaveCount(2); await expect(page.locator('.ai-user').last()).toHaveText('甲的后续问题');
  await page.locator('.ai-history-row').filter({ hasText: '乙' }).dblclick(); await expect(page.locator('.ai-input')).toHaveValue('乙的草稿');
});

test('failed model requests leave input usable and retry reuses the question while preserving the draft', async ({ page }) => {
  await open(page, { aiError: '无法连接 AI 服务' }); await send(page, '首次问题'); await expect(page.locator('.ai-retry')).toBeVisible();
  await expect(page.locator('.ai-input')).toBeEnabled(); await page.locator('.ai-input').fill('下一条草稿');
  await page.evaluate(() => { (window as any).aiError = ''; }); await page.locator('.ai-retry').click();
  await expect(page.locator('.ai-code')).toBeVisible(); await expect(page.locator('.ai-user')).toHaveCount(1); await expect(page.locator('.ai-assistant')).toHaveCount(1);
  await expect(page.locator('.ai-input')).toHaveValue('下一条草稿');
  const calls = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat'));
  expect(calls).toHaveLength(2); expect(calls[1].args.messages).toEqual(calls[0].args.messages);
  expect(calls[1].args.requestId).not.toBe(calls[0].args.requestId);
});

test('preview insertion activates the conversation and feedback survives refresh during the write', async ({ page }) => {
  await open(page, { echoTerminalInput: true, writeInputDelay: 400 }); await send(page, '含命令的历史'); await page.locator('.ai-new').click();
  await page.locator('.ai-history-row').click(); await expect(page.locator('.ai-conversation-phase')).toHaveText('预览');
  await expect(page.locator('.ai-insert')).toBeEnabled(); await page.locator('.ai-insert').click();
  await expect(page.locator('.ai-conversation-phase')).toHaveText('当前会话'); await expect(page.locator('.ai-insert-feedback')).toContainText('正在插入');
  await page.evaluate(() => window.dispatchEvent(new Event('wterm-ai-config-change')));
  await expect(page.locator('.ai-insert')).toBeDisabled(); await expect(page.locator('.ai-insert-feedback')).toContainText('已插入终端');
  await expect(page.locator('.term-pane.active .xterm-rows')).toContainText('ls -la');
});

for (const [label, expected] of [['解释命令', '请解释下面命令'], ['排查问题', '请根据下面的终端内容排查问题'], ['插入会话', 'echo selected']]) {
  test(`selected terminal popup prepares ${label} in the composer without sending`, async ({ page }) => {
    await open(page); await selectTerminalText(page); await page.locator('.ai-select-btn').click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.locator('.ai-input')).toHaveValue(new RegExp(expected)); await expect(page.locator('.ai-input')).toHaveValue(/echo selected/);
    await expect(page.locator('.ai-input')).toBeFocused();
    expect(await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').length)).toBe(0);
  });
}

test('ordinary right click on selected text provides AI actions and appends to the existing draft', async ({ page }) => {
  await open(page); await page.locator('.ai-input').fill('已有问题'); await selectTerminalText(page);
  const span = page.locator('.term-pane.active .xterm-rows span').filter({ hasText: 'echo selected' }).first();
  await span.click({ button: 'right' }); await page.getByRole('button', { name: 'AI 插入会话', exact: true }).click();
  await expect(page.locator('.ai-input')).toHaveValue('已有问题\n\necho selected'); await expect(page.locator('.ai-input')).toBeFocused();
  expect(await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').length)).toBe(0);
  await page.screenshot({ path: 'test-results/ai-selection-actions.png' });
});

test('both docking sides remain fixed and the chosen side survives reload', async ({ page }) => {
  await open(page); await expect(page.locator('.ai-panel')).toHaveClass(/ai-right/);
  await page.locator('.ai-side').click(); await expect(page.locator('.ai-panel')).toHaveClass(/ai-left/); await page.reload();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click(); await expect(page.locator('.ai-panel')).toHaveClass(/ai-left/);
  await page.locator('.ai-side').click(); await expect(page.locator('.ai-panel')).toHaveClass(/ai-right/);
});

test('failed history selection during a connection change releases the composer lock', async ({ page }) => {
  await open(page, { sshAutoConnect: true, savedProfiles: [{ id: 'loading', name: '等待恢复的连接', host: 'loading.invalid', port: 22, username: 'fixture', auth: 'agent' }] });
  await send(page, '较早会话'); await page.locator('.ai-new').click(); await send(page, '当前会话');
  await expect.poll(() => page.evaluate(() => (window as any).testState.aiHistory.size)).toBe(2);
  await page.evaluate(() => { (window as any).aiRecentDelay = 1500; (window as any).aiHistoryGetError = '历史暂时无法读取'; });
  await page.locator('#btn-add-menu').click(); await page.locator('.menu-item .title').filter({ hasText: /^等待恢复的连接$/ }).click();
  await expect(page.locator('.ai-input')).toBeDisabled(); await page.locator('.ai-history-row').filter({ hasText: '较早会话' }).click();
  await expect(page.locator('.ai-history-error')).toContainText('历史暂时无法读取'); await expect(page.locator('.ai-input')).toBeEnabled();
  await page.locator('.ai-input').fill('读取失败后仍可填写'); await expect(page.locator('.ai-input')).toHaveValue('读取失败后仍可填写');
});

test('selection action appears beside the release pointer and stays within the terminal near an edge', async ({ page }) => {
  await open(page); await page.locator('#btn-ai').click();
  const pointer = await selectTerminalText(page);
  const marker = await page.locator('.ai-select-btn').boundingBox();
  expect(marker!.x - pointer.x).toBeGreaterThanOrEqual(8); expect(marker!.x - pointer.x).toBeLessThan(20);
  expect(marker!.y - pointer.y).toBeGreaterThanOrEqual(8); expect(marker!.y - pointer.y).toBeLessThan(20);
  await page.evaluate(async () => {
    const id = (window as any).testState.calls.find(call => call.command === 'spawn_local').args.id;
    await (window as any).emitPty(id, '\x1b[2J\x1b[999;1Hecho bottom');
  });
  const text = page.locator('.term-pane.active .xterm-rows span').filter({ hasText: 'echo bottom' }).first();
  await expect(text).toBeVisible(); const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.ai-select-btn')).toBeVisible();
  const edge = (await page.locator('.ai-select-btn').boundingBox())!;
  const pane = (await page.locator('.term-pane.active').boundingBox())!;
  expect(edge.y + edge.height).toBeLessThanOrEqual(pane.y + pane.height - 7);
  expect(Math.abs(edge.y - box.y)).toBeLessThan(60);
  await page.locator('.ai-select-btn').click();
  const popup = (await page.locator('.ai-selection-menu').boundingBox())!;
  expect(popup.y).toBeGreaterThanOrEqual(8); expect(popup.y + popup.height).toBeLessThanOrEqual(642);
  await page.screenshot({ path: 'test-results/ai-selection-at-pointer.png' });
});

test('terminal context menu opens upward at the bottom with all actions visible and expands to fit', async ({ page }) => {
  await open(page); await selectTerminalText(page);
  const terminal = (await page.locator('.term-pane.active .xterm').boundingBox())!;
  await page.mouse.click(terminal.x + terminal.width / 2, terminal.y + terminal.height - 6, { button: 'right' });
  const menu = page.locator('.terminal-context-menu'); await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.height).toBeGreaterThan(240); expect(bounds.y + bounds.height).toBeLessThanOrEqual(642);
  expect(await menu.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await menu.getByRole('button', { name: /分屏/ }).click();
  await menu.getByRole('button', { name: /一键分屏/ }).click();
  await expect(menu.getByRole('button', { name: /九宫格/ })).toBeVisible();
  const expanded = (await menu.boundingBox())!;
  expect(expanded.y).toBeGreaterThanOrEqual(8); expect(expanded.y + expanded.height).toBeLessThanOrEqual(642);
  await page.screenshot({ path: 'test-results/terminal-context-menu-at-bottom.png' });
});

test('formatted replies keep code actions outside horizontal scrolling and insert only the chosen command', async ({ page }) => {
  const command = 'echo ' + 'x'.repeat(180);
  await open(page, { echoTerminalInput: true, aiReply: '**命令与参数解释**\n\n- **`dnf`**：软件包管理器。\n- `--security`：仅安装安全补丁。\n\n```bash\n' + command + '\n```\n\n在原生 Linux 环境下，可以先检查更新。\n\n```powershell\nwsl echo check\n```' });
  await send(page, '解释这个命令');
  const reply = page.locator('.ai-assistant').last();
  await expect(reply.locator('strong').first()).toHaveText('命令与参数解释'); await expect(reply.locator('.ai-list > li')).toHaveCount(2);
  await expect(reply.locator('.ai-inline-code')).toHaveCount(2); await expect(reply).not.toContainText('**');
  const code = reply.locator('.ai-code').first();
  expect(await code.locator('.ai-code-content').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await code.locator('.ai-insert').click(); await expect(code.locator('.ai-insert-feedback')).toContainText('已插入终端');
  const inputs = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'insert_terminal_input'));
  expect(inputs).toHaveLength(1); expect(inputs[0].args.text).toBe(command);
  await expect(page.locator('.term-pane.active .xterm-rows')).toContainText(command);
  await page.screenshot({ path: 'test-results/ai-formatted-response.png' });
});

test('native insertion respects bracketed paste and sends no broadcast input', async ({ page }) => {
  await open(page, { echoTerminalInput: true }); await page.locator('.term-pane.active .xterm').click(); await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.term-pane:visible')).toHaveCount(2); await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'spawn_local').length)).toBe(2);
  await page.locator('#split-broadcast').click();
  await page.evaluate(async () => {
    const id = (window as any).testState.calls.filter(call => call.command === 'spawn_local').at(-1).args.id;
    await (window as any).emitPty(id, '\x1b[?2004hbracketed ready');
  });
  await expect(page.locator('.pane-cell.focused .xterm-rows')).toContainText('bracketed ready');
  await send(page, '生成单行命令'); await page.locator('.ai-insert').click();
  await expect(page.locator('.ai-insert-feedback')).toContainText('已插入终端');
  const calls = await page.evaluate(() => (window as any).testState.calls);
  const inputs = calls.filter(call => call.command === 'insert_terminal_input');
  expect(inputs).toHaveLength(1); expect(inputs[0].args.bracketed).toBe(true); expect(inputs[0].args.text).toBe('ls -la');
  expect(calls.filter(call => call.command === 'write_sessions_bytes')).toHaveLength(0);
});
