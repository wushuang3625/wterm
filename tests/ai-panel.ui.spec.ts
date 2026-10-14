import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openApp(page, init?: () => void) {
  if (init) await page.addInitScript(init);
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
}

async function readyApp(page, options: Record<string, unknown> = {}) {
  await page.addInitScript(options => {
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1');
    localStorage.setItem('wterm_ai_models', '["deepseek-chat"]');
    localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
    Object.assign(window, options);
  }, options);
  await openApp(page);
}

async function commandExit(page, command: string, code: string, output = 'failed') {
  await page.evaluate(async () => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    await (window as any).emitPty(sid, '\x1b]133;A\x07PS> \x1b]133;B\x07');
  });
  await page.locator('.term-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.evaluate(async ({ command, code, output }) => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    await (window as any).emitPty(sid, `${command}\r\n${output}\r\n\x1b]133;D;${code}\x07\x1b]133;A\x07PS> \x1b]133;B\x07`);
  }, { command, code, output });
}

test('manual model input remains available when model discovery fails; keys are scoped', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { (window as any).aiModelsError = 'fixture failure'; });
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await expect(page.locator('#ai-model-manual-input')).toBeVisible();
  await page.locator('#cfg-ai-provider').selectOption('deepseek');
  await page.locator('#cfg-ai-key').fill('fixture-deepseek');
  await page.locator('#cfg-ai-key-save').click();
  await expect(page.locator('#cfg-ai-key-status')).toHaveText('已保存 API Key');
  await page.locator('#cfg-ai-fetch-models').click();
  await expect(page.locator('#cfg-error')).toContainText('获取模型列表失败');
  await expect(page.locator('#ai-model-manual-input')).toBeVisible();
  await page.locator('#ai-model-manual-input').fill('deepseek-chat');
  await page.locator('#ai-model-manual-add').click();
  await expect(page.locator('.ai-model-row input')).toBeChecked();
  await page.locator('#cfg-ai-provider').selectOption('anthropic');
  await expect(page.locator('#cfg-ai-key-status')).toHaveText('尚未保存 API Key');
  await expect(page.locator('.ai-model-row')).toHaveCount(0);
  await page.locator('#cfg-ai-provider').selectOption('deepseek');
  await expect(page.locator('#cfg-ai-key-status')).toHaveText('已保存 API Key');
});

test('stop cancels Rust request, rejects late chunks, and permits another send', async ({ page }) => {
  await readyApp(page, { aiHold: true, aiStartDelay: 100 });
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.ai-input').fill('first');
  await page.locator('.ai-send').click();
  await page.locator('.ai-stop').click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_cancel').length)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { (window as any).aiHold = false; });
  await page.locator('.ai-input').fill('second');
  await page.locator('.ai-send').click();
  await expect(page.locator('.ai-assistant')).toHaveCount(1);
  const requests = await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat'));
  expect(requests[1].args.messages.map(message => message.content)).not.toContain('first');
});

test('multi-turn uses one current system prompt; new chat clears selected context', async ({ page }) => {
  await readyApp(page);
  await page.keyboard.press('Control+Shift+K');
  for (const input of ['one', 'two']) {
    await page.locator('.ai-input').fill(input);
    await page.locator('.ai-send').click();
    await expect(page.locator('.ai-stop')).toBeHidden();
  }
  const messages = await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').at(-1).args.messages);
  expect(messages.filter(message => message.role === 'system')).toHaveLength(1);
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  await page.locator('.ai-new').click();
  await expect(page.locator('.ai-message')).toHaveCount(0);
  await expect(page.locator('.ai-context')).toBeHidden();
});

test('multiline generated commands cannot be directly inserted', async ({ page }) => {
  await readyApp(page, { aiCode: 'echo one\necho two' });
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.ai-input').fill('multiline');
  await page.locator('.ai-send').click();
  await expect(page.getByRole('button', { name: '插入终端', exact: true })).toBeDisabled();
  await expect(page.locator('.ai-code')).toContainText('echo one\necho two');
});

test('automatic diagnostics stay off by default and ignore successful or unknown exits', async ({ page }) => {
  await readyApp(page);
  await commandExit(page, 'bad', '1');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').length)).toBe(0);
  await page.evaluate(() => localStorage.setItem('wterm_ai_auto_diagnose', 'true'));
  await commandExit(page, 'good', '0');
  await commandExit(page, 'unknown', '');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').length)).toBe(0);
});

test('failed active command diagnoses with history disabled, bounded redacted output, and no execution', async ({ page }) => {
  await readyApp(page);
  await page.evaluate(() => localStorage.setItem('wterm_ai_auto_diagnose', 'true'));
  await commandExit(page, 'curl test', '7', 'token=private-value\r\nconnection refused');
  await expect(page.locator('.ai-panel')).toHaveClass(/open/);
  await expect(page.locator('.ai-assistant')).toHaveCount(1);
  await expect(page.locator('.blocks-toggle')).toBeHidden();
  const calls = await page.evaluate(() => (window as any).testState.calls);
  const request = calls.find(call => call.command === 'ai_chat');
  expect(request.args.messages[0].content).toContain('排错助手');
  expect(request.args.messages[1].content).toContain('退出码：7');
  expect(request.args.messages[1].content).toContain('connection refused');
  expect(request.args.messages[1].content).not.toContain('private-value');
  expect(calls.some(call => call.command === 'write_session' && call.args.data === 'ls -la\r')).toBe(false);
  await expect.poll(() => page.locator('.ai-panel').evaluate(panel => panel.getBoundingClientRect().right)).toBeLessThanOrEqual(901);
  await page.screenshot({ path: 'test-results/ai-diagnostic.png' });
  await commandExit(page, 'bad again', '2');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').length)).toBe(1);
});

test('closing cancels a streaming request and another local terminal restores the same connection history', async ({ page }) => {
  await readyApp(page, { aiHold: true });
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.ai-input').fill('secret from session one');
  await page.locator('.ai-send').click();
  await page.locator('.ai-close').click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.some((call: any) => call.command === 'ai_cancel'))).toBe(true);
  await page.keyboard.press('Control+Shift+T');
  await expect(page.locator('.tab')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('.ai-user')).toContainText('secret from session one');
  await expect(page.locator('.ai-message-status')).toContainText('回复已停止');
});

test('AI panel guides configuration when no provider is set up', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+Shift+K');
  const panel = page.locator('.ai-panel');
  await expect(panel).toHaveClass(/open/);
  await expect(panel.locator('.ai-guide')).toContainText('尚未配置 AI 服务');
  await expect(panel.locator('.ai-model-select')).toBeDisabled();
  await panel.locator('.ai-guide .btn').click();
  await expect(page.locator('.settings-modal')).toBeVisible();
});

test('settings AI card fetches models and saves the selection', async ({ page }) => {
  await openApp(page);
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('.settings-nav-item[data-tab="ai"]').click();

  // 选择预设自动填充 Base URL 与协议
  await page.locator('#cfg-ai-provider').selectOption('deepseek');
  await expect(page.locator('#cfg-ai-base-url')).toHaveValue('https://api.deepseek.com/v1');
  await expect(page.locator('#cfg-ai-protocol')).toHaveValue('openai');

  // 保存 Key 后拉取模型列表
  await page.locator('#cfg-ai-key').fill('sk-fixture');
  await page.locator('#cfg-ai-key-save').click();
  await expect(page.locator('#cfg-ai-key-status')).toHaveText('已保存 API Key');
  await page.locator('#cfg-ai-fetch-models').click();
  await expect(page.locator('#ai-model-picker')).toBeVisible();
  await expect(page.locator('#ai-model-checkboxes .ai-model-check')).toHaveCount(2);

  // 手动勾选添加一个模型并保存
  await page.locator('#ai-model-checkboxes .ai-model-check input').first().check();
  await page.locator('#cfg-save').click();
  await expect(page.locator('.settings-modal')).toHaveCount(0);
  const saved = await page.evaluate(() => ({
    models: localStorage.getItem('wterm_ai_models'),
    baseUrl: localStorage.getItem('wterm_ai_base_url'),
    active: localStorage.getItem('wterm_ai_active_model'),
  }));
  expect(saved.models).toBe('["deepseek-chat"]');
  expect(saved.baseUrl).toBe('https://api.deepseek.com/v1');
  expect(saved.active).toBe('deepseek-chat');
});

test('AI panel streams a reply and inserts the command block into the terminal', async ({ page }) => {
  await openApp(page, () => {
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1');
    localStorage.setItem('wterm_ai_models', '["deepseek-chat"]');
    localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
  });
  await page.keyboard.press('Control+Shift+K');
  const panel = page.locator('.ai-panel');
  await expect(panel).toHaveClass(/open/);
  await expect(panel.locator('.ai-guide')).toContainText('AI 助手已就绪');
  await expect(panel.locator('.ai-model-select')).toHaveValue('deepseek-chat');

  await panel.locator('.ai-input').fill('ls -la 是什么意思');
  await panel.locator('.ai-send').click();
  await expect(panel.locator('.ai-message.ai-user')).toContainText('ls -la 是什么意思');
  await expect(panel.locator('.ai-message.ai-assistant')).toContainText('列出目录内容：');

  // 流式结束后代码块带「插入终端 / 复制」操作
  const code = panel.locator('.ai-code');
  await expect(code).toHaveCount(1);
  await expect(code).toContainText('ls -la');
  await code.locator('.ai-code-actions button', { hasText: '插入终端' }).click();
  const pasted = await page.evaluate(() => {
    const entry = (window as any).testState.calls.findLast((call: any) => call.command === 'insert_terminal_input');
    if (!entry) return null;
    return entry.args.text;
  });
  expect(pasted).toContain('ls -la');

  // 新对话清空消息历史
  await panel.locator('.ai-new').click();
  await expect(panel.locator('.ai-message')).toHaveCount(0);
  await expect(panel.locator('.ai-guide')).toBeVisible();
});

test('diagnostics skip cursor edits and preserve a question being composed', async ({ page }) => {
  await readyApp(page);
  await page.evaluate(() => localStorage.setItem('wterm_ai_auto_diagnose', 'true'));
  await page.evaluate(async () => {
    await (window as any).emitPty((window as any).__wtermSessionPrefix + '-s1', '\x1b]133;A\x07PS> \x1b]133;B\x07');
  });
  await page.locator('.term-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type('wrong');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    await (window as any).emitPty((window as any).__wtermSessionPrefix + '-s1', 'edited\r\nfailed\r\n\x1b]133;D;1\x07');
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').length)).toBe(0);
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.ai-input').fill('my unfinished question');
  await commandExit(page, 'bad', '1');
  await expect(page.locator('.ai-input')).toHaveValue('my unfinished question');
  expect(await page.evaluate(() => (window as any).testState.calls.filter((call: any) => call.command === 'ai_chat').length)).toBe(0);
});

test('switching providers discards a late model list from the previous endpoint', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { (window as any).aiModelDelay = 500; });
  await page.locator('#btn-app-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await page.locator('#cfg-ai-provider').selectOption('deepseek');
  await page.locator('#cfg-ai-fetch-models').click();
  await page.locator('#cfg-ai-provider').selectOption('anthropic');
  await expect(page.locator('#cfg-ai-fetch-models')).toBeEnabled();
  await expect(page.locator('#ai-model-picker')).toBeHidden();
  await expect(page.locator('#cfg-ai-base-url')).toHaveValue('https://api.anthropic.com/v1');
});

test('assistant defaults to the right; robot and shortcut fold it without covering the terminal', async ({ page }) => {
  await readyApp(page);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(page.locator('.ai-input')).toBeFocused();
  expect((await page.locator('#btn-ai svg').boundingBox())!.width).toBe(20);
  await page.keyboard.press('Escape');
  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-panel')).toBeVisible();
  for (const size of [{ width: 855, height: 781 }, { width: 1280, height: 800 }, { width: 800, height: 500 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const box = await page.locator('.ai-panel').boundingBox();
      const terminal = await page.locator('#term-area').boundingBox();
      return box!.x + box!.width === size.width && box!.y === 40 && terminal!.x + terminal!.width <= box!.x + 1 && terminal!.width >= 320 && box!.height === size.height - 40;
    }).toBe(true);
    const send = await page.locator('.ai-send').boundingBox();
    expect(send!.y + send!.height).toBeLessThan(size.height);
    expect(await page.locator('.main').evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual({ x: 0, y: 0 });
    const terminal = await page.locator('#term-area').boundingBox();
    expect(terminal!.x).toBe(0);
  }
  await page.locator('#term-area').click({ position: { x: 10, y: 100 } });
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('.ai-panel')).toBeHidden();
  expect((await page.locator('#term-area').boundingBox())!.width).toBe(800);
  await page.keyboard.press('Control+Shift+K'); await expect(page.locator('.ai-panel')).toBeVisible();
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-panel')).toBeHidden();
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-panel')).toBeVisible();
  await page.locator('.ai-close').click();
  await expect(page.locator('.ai-panel')).toBeHidden();
  await expect(page.locator('#btn-ai')).toHaveAttribute('aria-expanded', 'false');
});

async function drag(page, selector: string, dx: number, dy: number) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test('right assistant ignores old floating settings and remembers side and resized width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    if (!localStorage.getItem('wterm_ai_window')) localStorage.setItem('wterm_ai_window', JSON.stringify({ mode: 'floating', bounds: { x: 200, y: 100, width: 640, height: 400 } }));
  });
  await readyApp(page);
  await page.locator('#btn-ai').click();
  const before = await page.locator('.ai-panel').boundingBox();
  await drag(page, '.ai-title', -200, 80);
  let box = await page.locator('.ai-panel').boundingBox();
  expect(box).toEqual(before);
  await drag(page, '.ai-dock-divider', -100, 0);
  box = await page.locator('.ai-panel').boundingBox();
  expect(box!.width).toBeCloseTo(before!.width + 100, 0);
  expect(box!.height).toBe(before!.height);
  await page.locator('.ai-dock-divider').focus(); await page.keyboard.press('ArrowRight');
  box = await page.locator('.ai-panel').boundingBox(); expect(box!.width).toBeCloseTo(before!.width + 80, 0);
  await page.locator('.ai-side').click(); await expect(page.locator('.ai-panel')).toHaveClass(/ai-left/);
  box = await page.locator('.ai-panel').boundingBox(); expect(box!.x).toBe(0);
  await page.locator('.ai-input').fill('keep this question');
  await page.locator('.ai-close').click();
  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-input')).toHaveValue('keep this question');
  expect(await page.locator('.ai-panel').boundingBox()).toEqual(box);
  await page.reload();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
  await page.locator('#btn-ai').click();
  expect(await page.locator('.ai-panel').boundingBox()).toEqual(box);
  await page.screenshot({ path: 'test-results/ai-left-docked.png' });
});

test('docked AI keeps output above input and terminal below, preserves replies and supports divider resize', async ({ page }) => {
  await readyApp(page);
  await page.locator('#btn-ai').click();
  await page.locator('.ai-input').fill('hello');
  await page.locator('.ai-send').click();
  await expect(page.locator('.ai-assistant')).toHaveCount(1);
  await page.locator('.ai-mode').click();
  await expect(page.locator('.main')).toHaveClass(/ai-dock-open/);
  const panel = await page.locator('.ai-panel').boundingBox();
  let terminal = await page.locator('#term-area').boundingBox();
  expect(terminal!.y).toBeCloseTo(panel!.y + panel!.height, 0);
  expect(terminal!.height).toBeGreaterThanOrEqual(160);
  await drag(page, '.ai-dock-divider', 0, 60);
  const larger = await page.locator('.ai-panel').boundingBox();
  expect(larger!.height).toBeGreaterThan(panel!.height);
  const input = await page.locator('.ai-input').boundingBox();
  const output = await page.locator('.ai-messages').boundingBox();
  expect(output!.y + output!.height).toBeLessThanOrEqual(input!.y);
  await page.locator('.ai-dock-divider').focus();
  await page.keyboard.press('ArrowUp');
  expect((await page.locator('.ai-panel').boundingBox())!.height).toBeCloseTo(larger!.height - 20, 0);
  await page.screenshot({ path: 'test-results/ai-docked.png' });
  await page.locator('.ai-mode').click();
  await expect(page.locator('.ai-assistant')).toHaveCount(1);
  terminal = await page.locator('#term-area').boundingBox();
  expect(terminal!.height).toBe(610); expect(terminal!.x).toBe(0);
  await page.locator('.ai-mode').click();
  await page.locator('.ai-close').click();
  expect((await page.locator('#term-area').boundingBox())!.height).toBe(610);
  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-panel')).toHaveClass(/ai-docked/);
});

test('insertion reveals the terminal input, confirms the write, and never submits the command', async ({ page }) => {
  await readyApp(page, { echoTerminalInput: true, aiCode: 'echo inserted' });
  await page.evaluate(async () => {
    const state = (window as any).testState;
    const id = state.calls.find(call => call.command === 'spawn_local').args.id;
    await (window as any).emitPty(id, Array.from({ length: 120 }, (_, i) => `line-${i}\r\n`).join('') + 'PS> ');
  });
  await page.locator('#btn-ai').click(); await page.locator('.ai-input').fill('给我命令'); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-insert')).toBeEnabled(); await page.locator('.ai-insert').click();
  await expect(page.locator('.ai-insert-feedback')).toContainText('已插入终端，按 Enter 执行');
  await expect(page.locator('.term-pane.active .xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('.term-pane.active .xterm-rows')).toContainText('echo inserted');
  const write = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'insert_terminal_input').at(-1));
  expect(write.args.text).toBe('echo inserted'); expect(write.args.bracketed).toBe(false);
  const assistant = await page.locator('.ai-panel').boundingBox(), terminal = await page.locator('#term-area').boundingBox();
  expect(terminal!.x + terminal!.width).toBeLessThanOrEqual(assistant!.x + 1);
  await page.screenshot({ path: 'test-results/ai-insert-right.png' });
});

test('a rejected terminal write shows an error and can be retried', async ({ page }) => {
  await readyApp(page, { writeInputError: '终端会话已结束或不存在，请重新连接' });
  await page.locator('#btn-ai').click(); await page.locator('.ai-input').fill('生成命令'); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-insert')).toBeEnabled(); await page.locator('.ai-insert').click();
  await expect(page.locator('.ai-insert-feedback')).toContainText('插入失败：');
  await expect(page.locator('.ai-insert-feedback')).toContainText('请重新连接'); await expect(page.locator('.ai-insert')).toBeEnabled();
  await page.evaluate(() => { (window as any).writeInputError = ''; }); await page.locator('.ai-insert').click();
  await expect(page.locator('.ai-insert-feedback')).toContainText('已插入终端');
});

test('insertion returns from command history and waits for the input acknowledgement', async ({ page }) => {
  await readyApp(page, { echoTerminalInput: true, writeInputDelay: 250, aiCode: 'echo visible' });
  await page.evaluate(() => { localStorage.setItem('wterm_blocks_mode', 'compatible'); window.dispatchEvent(new Event('wterm-blocks-mode-change')); });
  await page.locator('.blocks-toggle').click(); await expect(page.locator('.blocks-panel')).toBeVisible();
  await page.locator('#btn-ai').click(); await page.locator('.ai-input').fill('恢复输入'); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-insert')).toBeEnabled(); await page.locator('.ai-insert').click();
  await expect(page.locator('.blocks-panel')).toBeHidden(); await expect(page.locator('.ai-insert')).toBeDisabled();
  await expect(page.locator('.ai-insert-feedback')).toContainText('正在插入');
  await expect(page.locator('.ai-insert-feedback')).toContainText('已插入终端');
  await expect(page.locator('.term-pane.active .xterm-rows')).toContainText('echo visible');
  await expect(page.locator('.term-pane.active .xterm-helper-textarea')).toBeFocused();
});

test('avatar and shortcut fold the assistant while simultaneous replies keep running', async ({ page }) => {
  await readyApp(page, { aiHold: true }); await page.locator('#btn-ai').click();
  await page.locator('.ai-input').fill('后台甲'); await page.locator('.ai-send').click(); await expect(page.locator('.ai-stop')).toBeVisible();
  await page.locator('.ai-new').click(); await page.locator('.ai-input').fill('后台乙'); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-stop')).toBeVisible(); await page.locator('.ai-input').fill('折叠前草稿');
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-panel')).toBeHidden();
  await expect(page.locator('#btn-ai')).toHaveClass(/busy/); await expect(page.locator('#btn-ai')).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    const state = (window as any).testState;
    for (const channel of state.aiRequests.values()) { channel.onmessage({ delta: '后台已经完成', done: false }); channel.onmessage({ done: true }); }
    state.aiRequests.clear();
  });
  await expect(page.locator('#btn-ai')).not.toHaveClass(/busy/);
  await page.keyboard.press('Control+Shift+K'); await expect(page.locator('.ai-panel')).toBeVisible();
  await expect(page.locator('.ai-assistant')).toContainText('后台已经完成'); await expect(page.locator('.ai-input')).toHaveValue('折叠前草稿');
  await page.keyboard.press('Control+Shift+K'); await expect(page.locator('.ai-panel')).toBeHidden();
  expect(await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_cancel').length)).toBe(0);
});

test('waiting, thinking and streaming show activity, stop and failure clear it', async ({ page }) => {
  await readyApp(page, { aiHold: true });
  await page.locator('#btn-ai').click();
  await page.locator('.ai-input').fill('diagnose');
  await page.locator('.ai-send').click();
  await expect(page.locator('.ai-activity')).toContainText('正在等待回复');
  await expect(page.locator('#btn-ai')).toHaveClass(/busy/);
  await page.evaluate(() => [...(window as any).testState.aiRequests.values()][0].onmessage({ activity: 'thinking', done: false }));
  await expect(page.locator('.ai-activity')).toContainText('正在思考');
  await expect(page.locator('.ai-activity-time')).not.toHaveText('0 秒');
  await page.screenshot({ path: 'test-results/ai-thinking.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.ai-activity .ai-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.locator('.ai-panel')).toHaveAttribute('aria-busy', 'true');
  await page.locator('.ai-mode').click();
  await expect(page.locator('.ai-activity')).toBeVisible();
  await page.evaluate(() => [...(window as any).testState.aiRequests.values()][0].onmessage({ delta: 'answer', done: false }));
  await expect(page.locator('.ai-activity')).toContainText('正在生成回复');
  await page.locator('.ai-stop').click();
  await expect(page.locator('.ai-activity')).toBeHidden();
  await expect(page.locator('#btn-ai')).not.toHaveClass(/busy/);
  await page.locator('.ai-input').fill('another');
  await page.locator('.ai-send').click();
  await expect(page.locator('.ai-activity')).toContainText('正在等待回复');
  await page.evaluate(() => {
    const channel = [...(window as any).testState.aiRequests.values()][0];
    channel.onmessage({ activity: 'tool_request', toolName: '<read_file>', done: false });
  });
  await expect(page.locator('.ai-activity')).toContainText('<read_file>（未执行）');
  await page.evaluate(() => [...(window as any).testState.aiRequests.values()][0].onmessage({ error: '工具未执行', done: true }));
  await expect(page.locator('.ai-activity')).toBeHidden();
  await expect(page.locator('.ai-error')).toContainText('工具未执行');
  expect(await page.evaluate(() => (window as any).testState.calls.some((call: any) => call.command === 'write_session'))).toBe(false);
});
