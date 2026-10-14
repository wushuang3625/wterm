import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page) {
  await page.addInitScript(() => {
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1');
    localStorage.setItem('wterm_ai_models', '["deepseek-chat"]'); localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
    (window as any).aiHold = true;
  });
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/'); await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-input')).toBeEnabled();
}
async function start(page, text) {
  await page.locator('.ai-input').fill(text); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-stop')).toBeVisible();
  return page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').at(-1).args.requestId);
}
async function chunk(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const state = (window as any).testState; state.aiRequests.get(id).onmessage(value);
    if (value.done) state.aiRequests.delete(id);
  }, { id, value });
}

test('reasoning starts folded, streams while open, and stays open after the answer finishes', async ({ page }) => {
  await open(page); const id = await start(page, '解释这个命令');
  await chunk(page, id, { reasoningDelta: '先核对命令的选项说明。', done: false });
  const details = page.locator('.ai-reasoning');
  await expect(details).toBeVisible(); await expect(details).toHaveJSProperty('open', false);
  await expect(details.locator('.ai-reasoning-content')).toBeHidden();
  await expect(details.locator('.ai-reasoning-state')).toHaveText('正在思考'); await expect(details.locator('.ai-spinner')).toBeVisible();
  await page.locator('.ai-panel').screenshot({ path: 'test-results/ai-reasoning-folded.png' });
  await details.locator('summary').click();
  await chunk(page, id, { reasoningDelta: '\n\n- 区分参数与命令。\n- 检查适用环境。\n\n```sh\necho tentative\n```\n\n<img src=x onerror=alert(1)>', done: false });
  await expect(details).toHaveJSProperty('open', true); await expect(details.locator('.ai-reasoning-content')).toContainText('检查适用环境');
  await expect(details.locator('img')).toHaveCount(0); await expect(details.locator('.ai-reasoning-content')).toContainText('<img src=x');
  await chunk(page, id, { delta: '命令说明如下：\n\n```sh\necho final\n```', done: false });
  await expect(details.locator('.ai-reasoning-state')).toHaveText('已结束'); await expect(details.locator('.ai-spinner')).toBeHidden();
  await chunk(page, id, { done: true }); await expect(details).toHaveJSProperty('open', true);
  await expect(details.locator('.ai-insert')).toHaveCount(0); await expect(page.locator('.ai-body .ai-insert')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/ai-reasoning-expanded.png' });
  await details.locator('summary').click(); await expect(details).toHaveJSProperty('open', false);
  await expect(page.locator('.ai-assistant > .ai-body')).toContainText('命令说明如下');
});

test('reasoning survives reload, defaults folded again, and stays out of subsequent model context', async ({ page }) => {
  await open(page); const id = await start(page, '首个问题');
  await chunk(page, id, { reasoningDelta: 'ONLY_PROVIDER_REASONING', delta: '第一条结论', done: false });
  await chunk(page, id, { done: true }); await page.locator('.ai-reasoning summary').click();
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()][0]?.messages[1].reasoning)).toBe('ONLY_PROVIDER_REASONING');
  await page.reload(); await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', false);
  await page.locator('.ai-reasoning summary').click(); await expect(page.locator('.ai-reasoning-content')).toHaveText('ONLY_PROVIDER_REASONING');
  await start(page, '后续问题');
  const messages = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').at(-1).args.messages);
  expect(messages.some(message => message.content === '第一条结论')).toBe(true);
  expect(JSON.stringify(messages)).not.toContain('ONLY_PROVIDER_REASONING');
});

test('concurrent conversations keep their reasoning and fold choices separate', async ({ page }) => {
  await open(page); const a = await start(page, '会话甲'); await chunk(page, a, { reasoningDelta: '甲的过程', done: false });
  await page.locator('.ai-reasoning summary').click(); await page.locator('.ai-new').click();
  const b = await start(page, '会话乙'); await chunk(page, b, { reasoningDelta: '乙的过程', done: false });
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', false);
  await chunk(page, a, { reasoningDelta: '继续分析', delta: '甲的结论', done: false }); await chunk(page, a, { done: true });
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', false);
  await expect(page.locator('.ai-reasoning-content')).toHaveText('乙的过程');
  await page.locator('.ai-history-row').filter({ hasText: '会话甲' }).click();
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', true);
  await expect(page.locator('.ai-reasoning-content')).toHaveText('甲的过程继续分析'); await expect(page.locator('.ai-assistant > .ai-body')).toContainText('甲的结论');
  await page.locator('.ai-history-row').filter({ hasText: '会话乙' }).dblclick();
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', false);
  await page.evaluate(id => { (window as any).oldReasoningChannel = (window as any).testState.aiRequests.get(id); }, b);
  await page.locator('.ai-stop').click();
  await expect(page.locator('.ai-reasoning-state')).toHaveText('已停止');
  await page.evaluate(() => (window as any).oldReasoningChannel.onmessage({ reasoningDelta: 'LATE_REASONING', done: false }));
  await expect(page.locator('.ai-reasoning-content')).toHaveText('乙的过程');
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].find(value => value.title === '会话乙')?.messages[1].reasoning)).toBe('乙的过程');
});

test('status-only models have no empty reasoning section, and failed reasoning can be retried', async ({ page }) => {
  await open(page); const id = await start(page, '测试失败重试');
  await chunk(page, id, { activity: 'thinking', done: false });
  await expect(page.locator('.ai-activity')).toContainText('正在思考'); await expect(page.locator('.ai-reasoning')).toHaveCount(0);
  await chunk(page, id, { reasoningDelta: '失败前的片段', done: false }); await page.locator('.ai-reasoning summary').click();
  await chunk(page, id, { error: '服务连接中断', done: true });
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', true); await expect(page.locator('.ai-reasoning-state')).toHaveText('未完成');
  await expect(page.locator('.ai-reasoning-content')).toHaveText('失败前的片段'); await expect(page.locator('.ai-activity')).toBeHidden();
  await page.locator('.ai-retry').click(); await expect(page.locator('.ai-reasoning')).toHaveCount(0);
  const retry = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').at(-1).args.requestId);
  expect(retry).not.toBe(id); await chunk(page, retry, { reasoningDelta: '重试后的过程', done: false });
  await expect(page.locator('.ai-reasoning')).toHaveJSProperty('open', false);
  await expect(page.locator('.ai-reasoning-content')).toHaveText('重试后的过程'); await expect(page.locator('.ai-user')).toHaveCount(1);
  await chunk(page, retry, { delta: '重试成功', done: false }); await chunk(page, retry, { done: true });
  await expect(page.locator('.ai-assistant > .ai-body')).toContainText('重试成功');
});

test('an oversized reasoning stream is cancelled while the already received portion remains saved', async ({ page }) => {
  await open(page); const id = await start(page, '限制过长过程');
  await chunk(page, id, { reasoningDelta: '已收到的片段', done: false });
  await chunk(page, id, { reasoningDelta: 'x'.repeat(100_000), done: false });
  await expect(page.locator('.ai-error')).toContainText('回复过长'); await expect(page.locator('.ai-stop')).toBeHidden();
  await expect(page.locator('.ai-reasoning-content')).toHaveText('已收到的片段');
  expect(await page.evaluate(id => (window as any).testState.calls.some(call => call.command === 'ai_cancel' && call.args.requestId === id), id)).toBe(true);
});
