import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openApp(page, options = {}) {
  await page.addInitScript(options => {
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1');
    localStorage.setItem('wterm_ai_models', '["deepseek-chat"]'); localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
    Object.assign(window, options);
  }, options);
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/'); await expect(page.locator('.tab .dot.connected')).toHaveCount(1);
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-input')).toBeEnabled();
}
async function send(page, content) {
  const count = await page.locator('.ai-user').count();
  await page.locator('.ai-input').fill(content); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-user')).toHaveCount(count + 1);
  await expect(page.locator('.ai-stop')).toBeHidden();
}
async function startHeld(page, content) {
  await page.locator('.ai-input').fill(content); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-stop')).toBeVisible();
  return page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').at(-1).args.requestId);
}
async function chunk(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const state = (window as any).testState;
    state.aiRequests.get(id).onmessage(value);
    if (value.done) state.aiRequests.delete(id);
  }, { id, value });
}
async function menuAction(page, row, label) {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

test('complete transcripts and drafts survive reload while model context stays limited', async ({ page }) => {
  await openApp(page);
  for (let i = 0; i < 9; i++) await send(page, 'question-' + i);
  await expect(page.locator('.ai-user')).toHaveCount(9);
  const request = await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_chat').at(-1).args);
  expect(request.messages).toHaveLength(14);
  await page.locator('.ai-input').fill('未发送的后续问题');
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()][0]?.draft)).toBe('未发送的后续问题');
  await page.reload(); await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-user')).toHaveCount(9); await expect(page.locator('.ai-assistant')).toHaveCount(9);
  await expect(page.locator('.ai-input')).toHaveValue('未发送的后续问题');
});

test('single click previews, double click and Enter activate, and the sidebar leaves content visible', async ({ page }) => {
  await openApp(page); await send(page, '会话甲'); await page.locator('.ai-new').click(); await send(page, '会话乙');
  await page.locator('.ai-input').fill('乙的草稿');
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].find(value => value.title === '会话乙')?.draft)).toBe('乙的草稿');
  const revisions = await page.evaluate(() => Object.fromEntries([...(window as any).testState.aiHistory.values()].map(value => [value.id, value.revision])));
  const first = page.locator('.ai-history-row').filter({ hasText: '会话甲' });
  const second = page.locator('.ai-history-row').filter({ hasText: '会话乙' });
  await first.click(); await expect(page.locator('.ai-conversation-phase')).toHaveText('预览');
  await expect(page.locator('.ai-user')).toContainText('会话甲'); await expect(page.locator('.ai-input')).toBeEnabled();
  await expect(page.locator('.ai-history')).toBeVisible(); await expect(page.locator('.ai-history')).not.toContainText('打开会话');
  await second.click(); await expect(page.locator('.ai-input')).toHaveValue('乙的草稿');
  await first.dblclick(); await expect(page.locator('.ai-input')).toBeEnabled();
  await expect(page.locator('.ai-conversation-title')).toHaveText('会话甲'); await expect(page.locator('.ai-history')).toBeVisible();
  await second.click(); await second.press('Enter'); await expect(page.locator('.ai-input')).toHaveValue('乙的草稿');
  // Pass the debounce interval: browsing must not schedule a transcript write.
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => Object.fromEntries([...(window as any).testState.aiHistory.values()].map(value => [value.id, value.revision])))).toEqual(revisions);
  const history = await page.locator('.ai-history').boundingBox(); const content = await page.locator('.ai-chat').boundingBox();
  expect(history!.width).toBe(176); expect(history!.x + history!.width).toBeLessThanOrEqual(content!.x + 1);
  await page.locator('.ai-history-toggle').click(); await expect(page.locator('.ai-history')).toBeHidden();
  await expect(page.locator('.ai-user')).toContainText('会话乙'); await page.locator('.ai-history-toggle').click();
  await page.screenshot({ path: 'test-results/ai-history-sidebar.png' });
});

test('preview and activation keep background replies running and previews update live', async ({ page }) => {
  await openApp(page); await send(page, '旧会话'); await page.locator('.ai-new').click();
  await page.evaluate(() => { (window as any).aiHold = true; });
  await page.locator('.ai-input').fill('正在生成的会话'); await page.locator('.ai-send').click();
  await expect(page.locator('.ai-stop')).toBeVisible();
  await page.evaluate(() => { (window as any).heldChannel = [...(window as any).testState.aiRequests.values()][0]; (window as any).heldChannel.onmessage({ delta: '部分回答', done: false }); });
  const old = page.locator('.ai-history-row').filter({ hasText: '旧会话' }); await old.click();
  expect(await page.evaluate(() => (window as any).testState.aiRequests.size)).toBe(1);
  await page.evaluate(() => (window as any).heldChannel.onmessage({ delta: '仍在继续', done: false }));
  await old.dblclick();
  await expect(page.locator('.ai-send')).toBeEnabled(); await expect(page.locator('.ai-stop')).toBeHidden();
  expect(await page.evaluate(() => (window as any).testState.aiRequests.size)).toBe(1);
  expect(await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_cancel').length)).toBe(0);
  const partial = page.locator('.ai-history-row').filter({ hasText: '正在生成的会话' }); await partial.click();
  await expect(page.locator('.ai-assistant')).toContainText('部分回答仍在继续');
  await page.evaluate(() => (window as any).heldChannel.onmessage({ delta: '，实时更新', done: false }));
  await expect(page.locator('.ai-assistant')).toContainText('部分回答仍在继续，实时更新');
  await expect(page.locator('.ai-input')).toBeEnabled();
  await page.evaluate(() => (window as any).heldChannel.onmessage({ done: true }));
  await expect(partial.locator('.ai-history-running')).toBeHidden();
  await partial.dblclick(); await expect(page.locator('.ai-stop')).toBeHidden();
  await expect(page.locator('.ai-message-status')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].find(value => value.title === '正在生成的会话')?.messages.at(-1)?.status)).toBe('complete');
});

test('search, rename, pin and delete operate on saved conversations without creating empty entries', async ({ page }) => {
  await openApp(page); await send(page, '第一条历史'); await page.locator('.ai-new').click();
  await expect(page.locator('.ai-history-row')).toHaveCount(1); await send(page, '第二条历史');
  page.once('dialog', dialog => dialog.accept('重新命名')); await menuAction(page, page.locator('.ai-history-row').filter({ hasText: '第二条历史' }), '重命名');
  await expect(page.locator('.ai-conversation-title')).toHaveText('重新命名');
  await menuAction(page, page.locator('.ai-history-row').filter({ hasText: '重新命名' }), '置顶'); await expect(page.locator('.ai-history-row').first()).toContainText('重新命名');
  await page.locator('.ai-history-search').fill('第一条'); await expect(page.locator('.ai-history-row')).toHaveCount(1);
  await expect(page.locator('.ai-history-row')).toContainText('第一条历史');
  await page.locator('.ai-history-search').fill(''); await expect(page.locator('.ai-history-row')).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept()); await menuAction(page, page.locator('.ai-history-row').filter({ hasText: '重新命名' }), '删除');
  await expect(page.locator('.ai-history-row')).toHaveCount(1); await expect(page.locator('.ai-history-error')).toBeHidden();
  await page.reload(); await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-history-row')).toHaveCount(1); await expect(page.locator('.ai-history-row')).toContainText('第一条历史');
});

test('three conversations stream independently; stop and late chunks affect only their own request', async ({ page }) => {
  await openApp(page, { aiHold: true });
  const a = await startHeld(page, '并发甲'); await page.locator('.ai-new').click();
  const b = await startHeld(page, '并发乙'); await page.locator('.ai-new').click();
  const c = await startHeld(page, '并发丙');
  expect(await page.evaluate(() => (window as any).testState.aiRequests.size)).toBe(3);
  await expect(page.locator('.ai-history-row[data-running="true"]')).toHaveCount(3);
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(3);
  expect(await page.locator('.ai-history-running:visible').first().evaluate(el => getComputedStyle(el).animationName)).toBe('ai-spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.ai-history-running:visible').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.ai-input').fill('丙的下一条草稿');
  await chunk(page, a, { activity: 'thinking', done: false });
  await chunk(page, c, { delta: '丙的部分回复', done: false });
  await expect(page.locator('.ai-activity')).toContainText('正在生成回复');
  const rowA = page.locator('.ai-history-row').filter({ hasText: '并发甲' });
  await rowA.dblclick(); await expect(page.locator('.ai-activity')).toContainText('正在思考');
  await chunk(page, b, { delta: '乙的部分回复', done: false });
  await expect(page.locator('.ai-activity')).toContainText('正在思考');
  await expect(page.locator('.ai-messages')).not.toContainText('乙的部分回复');
  await page.evaluate(id => { (window as any).cancelledChannel = (window as any).testState.aiRequests.get(id); }, a);
  await page.locator('.ai-stop').click();
  await expect(rowA.locator('.ai-history-running')).toBeHidden();
  await expect(page.locator('.ai-history-row[data-running="true"]')).toHaveCount(2);
  const nextA = await startHeld(page, '甲的第二次请求');
  await page.evaluate(() => {
    const channel = (window as any).cancelledChannel;
    channel.onmessage({ delta: '旧请求的晚到内容', done: false }); channel.onmessage({ error: '旧请求错误', done: true });
  });
  await expect(page.locator('.ai-stop')).toBeVisible();
  await expect(page.locator('.ai-messages')).not.toContainText('旧请求的');
  await chunk(page, b, { delta: '，乙已完成', done: false }); await chunk(page, b, { done: true });
  await chunk(page, c, { error: '丙的独立失败', done: true });
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(1);
  await expect(page.locator('.ai-stop')).toBeVisible();
  await chunk(page, nextA, { delta: '甲的新回复', done: false }); await chunk(page, nextA, { done: true });
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(0);
  await expect(page.locator('#btn-ai')).not.toHaveClass(/busy/);
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].filter(value => value.messages.at(-1).status !== 'generating').length)).toBe(3);
  await page.locator('.ai-history-row').filter({ hasText: '并发乙' }).dblclick();
  await expect(page.locator('.ai-assistant')).toHaveText('乙的部分回复，乙已完成');
  await page.locator('.ai-history-row').filter({ hasText: '并发丙' }).dblclick();
  await expect(page.locator('.ai-error')).toHaveText('丙的独立失败');
  await expect(page.locator('.ai-input')).toHaveValue('丙的下一条草稿');
  await expect(page.locator('.ai-history-error')).toBeHidden();
});

test('terminal tab changes keep local and SSH chats running with the correct conversation content', async ({ page }) => {
  await openApp(page, { aiHold: true, sshAutoConnect: true, savedProfiles: [{ id: 'parallel-host', name: '并行远程', host: 'parallel.invalid', port: 22, username: 'fixture', auth: 'agent' }] });
  const local = await startHeld(page, '本地后台问题');
  await page.locator('#btn-add').click(); await expect(page.locator('.tab .dot.connected')).toHaveCount(2);
  await expect(page.locator('.ai-user')).toContainText('本地后台问题'); await expect(page.locator('.ai-stop')).toBeVisible();
  await page.locator('#btn-add-menu').click(); await page.locator('.menu-item .title').filter({ hasText: /^并行远程$/ }).click();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(3); await expect(page.locator('.ai-send')).toBeEnabled();
  const remote = await startHeld(page, '远程后台问题');
  await chunk(page, local, { delta: '本地专属回答', done: false });
  await expect(page.locator('.ai-messages')).not.toContainText('本地专属回答');
  await page.locator('.tab').first().click();
  await expect(page.locator('.ai-user')).toContainText('本地后台问题'); await expect(page.locator('.ai-assistant')).toContainText('本地专属回答');
  await chunk(page, remote, { delta: '远程专属回答', done: false });
  await expect(page.locator('.ai-messages')).not.toContainText('远程专属回答');
  await page.locator('.tab').last().click(); await expect(page.locator('.ai-assistant')).toContainText('远程专属回答');
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).testState.calls.filter(call => call.command === 'ai_cancel').length)).toBe(0);
  await page.screenshot({ path: 'test-results/ai-concurrent-history.png' });
  await chunk(page, local, { done: true }); await chunk(page, remote, { done: true });
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].filter(value => value.messages.at(-1).status === 'complete').length)).toBe(2);
  await page.reload(); await expect(page.locator('.tab')).toHaveCount(3); await page.locator('#btn-ai').click();
  await page.locator('.ai-history-row').filter({ hasText: '本地后台问题' }).dblclick(); await expect(page.locator('.ai-assistant')).toContainText('本地专属回答');
  await page.locator('.ai-history-row').filter({ hasText: '远程后台问题' }).dblclick(); await expect(page.locator('.ai-assistant')).toContainText('远程专属回答');
});

test('icon toolbar and conversation context menu preserve the active draft and keyboard focus', async ({ page }) => {
  await openApp(page); await send(page, '菜单目标甲'); await page.locator('.ai-new').click(); await send(page, '当前乙');
  await page.locator('.ai-input').fill('乙的未发送草稿');
  const icons = page.locator('.ai-header button');
  for (const button of await icons.all()) { await expect(button.locator('svg')).toHaveCount(1); await expect(button).toHaveText(''); expect(await button.getAttribute('aria-label')).toBeTruthy(); expect(await button.getAttribute('title')).toBeTruthy(); }
  await expect(page.locator('.ai-conversation-header button')).toHaveCount(1); await expect(page.locator('.ai-return')).toBeHidden();
  let row = page.locator('.ai-history-row').filter({ hasText: '菜单目标甲' });
  await row.click({ button: 'right' });
  await expect(page.locator('.ai-conversation-title')).toHaveText('当前乙');
  await expect(page.locator('.ai-input')).toHaveValue('乙的未发送草稿');
  const menu = page.getByRole('menu', { name: '会话操作' });
  await expect(menu).toBeVisible(); const bounds = await menu.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(8); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(892);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(row).toBeFocused(); await expect(page.locator('.ai-panel')).toBeVisible();
  page.once('dialog', dialog => dialog.accept('甲的新名字')); await menuAction(page, row, '重命名');
  row = page.locator('.ai-history-row').filter({ hasText: '甲的新名字' });
  await expect(page.locator('.ai-conversation-title')).toHaveText('当前乙');
  await row.press('Shift+F10'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.ai-history-row').first()).toContainText('甲的新名字');
  await row.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
  await page.locator('.ai-input').click(); await expect(menu).toHaveCount(0);
  await menuAction(page, row, '取消置顶');
  page.once('dialog', dialog => dialog.dismiss()); await menuAction(page, row, '删除'); await expect(row).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await menuAction(page, row, '删除');
  await expect(row).toHaveCount(0); await expect(page.locator('.ai-conversation-title')).toHaveText('当前乙'); await expect(page.locator('.ai-input')).toHaveValue('乙的未发送草稿');
});

test('deleting a background conversation cancels only that request and late chunks cannot restore it', async ({ page }) => {
  await openApp(page, { aiHold: true });
  const a = await startHeld(page, '将被删除的后台会话'); await chunk(page, a, { delta: '已收到部分', done: false });
  await page.evaluate(id => { (window as any).deletedChannel = (window as any).testState.aiRequests.get(id); }, a);
  await page.locator('.ai-new').click(); const b = await startHeld(page, '保留的并行会话');
  await page.locator('.ai-input').fill('当前草稿');
  const row = page.locator('.ai-history-row').filter({ hasText: '将被删除的后台会话' });
  page.once('dialog', dialog => dialog.accept()); await menuAction(page, row, '删除');
  await expect(row).toHaveCount(0); await expect(page.locator('.ai-stop')).toBeVisible();
  expect(await page.evaluate(() => (window as any).testState.aiRequests.size)).toBe(1);
  await page.evaluate(() => { (window as any).deletedChannel.onmessage({ delta: '删除后的回复', done: false }); (window as any).deletedChannel.onmessage({ done: true }); });
  await chunk(page, b, { delta: '保留的答案', done: false }); await chunk(page, b, { done: true });
  await expect.poll(() => page.evaluate(() => (window as any).testState.aiHistory.size)).toBe(1);
  await expect(page.locator('.ai-input')).toHaveValue('当前草稿'); await expect(page.locator('.ai-assistant')).toHaveText('保留的答案');
  await expect(page.locator('.ai-history-error')).toBeHidden();
});

test('closing the assistant cancels and saves every running conversation', async ({ page }) => {
  await openApp(page, { aiHold: true });
  const a = await startHeld(page, '关闭前甲'); await chunk(page, a, { delta: '甲的未完成回答', done: false });
  await page.locator('.ai-new').click(); const b = await startHeld(page, '关闭前乙'); await chunk(page, b, { delta: '乙的未完成回答', done: false });
  await page.locator('.ai-input').fill('乙的待发送草稿'); await page.locator('.ai-close').click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.aiRequests.size)).toBe(0);
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].filter(value => value.messages.at(-1).status === 'interrupted').length)).toBe(2);
  await page.locator('#btn-ai').click(); await expect(page.locator('.ai-input')).toHaveValue('乙的待发送草稿');
  await expect(page.locator('.ai-history-running:visible')).toHaveCount(0);
  await page.locator('.ai-history-row').filter({ hasText: '关闭前甲' }).dblclick(); await expect(page.locator('.ai-assistant')).toContainText('甲的未完成回答');
  await expect(page.locator('.ai-message-status')).toHaveText('回复已停止');
});

test('saved remote history remains readable and cannot insert into a different local connection', async ({ page }) => {
  await page.addInitScript(() => {
    const connection = { id: 'ssh:server', name: '生产服务器', kind: 'ssh', targetKey: '["host",22,"root",""]', saved: true };
    const message = { id: 'answer', role: 'assistant', content: '```bash\necho remote\n```', status: 'complete', createdAt: 1, context: '', action: 'chat', model: 'deepseek-chat', provider: 'https://api.deepseek.com/v1', error: '' };
    const conversation = { id: 'remote', connection, title: '远程历史', pinned: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, revision: 1, messages: [message], draft: '', selection: '', model: 'deepseek-chat' };
    localStorage.setItem('__test_ai_history', JSON.stringify({ remote: conversation }));
    (window as any).savedProfiles = [{ id: 'server', name: '生产服务器', host: 'host', port: 22, username: 'root', auth: 'agent' }];
  });
  await openApp(page);
  const row = page.locator('.ai-history-row').filter({ hasText: '远程历史' });
  await row.click(); await expect(page.locator('.ai-insert')).toBeDisabled();
  await row.dblclick(); await expect(page.locator('.ai-input')).toBeEnabled(); await expect(page.locator('.ai-insert')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).testState.calls.some(call => call.command === 'spawn_ssh'))).toBe(false);
  await page.evaluate(() => { (window as any).testState.profiles = []; window.dispatchEvent(new Event('wterm-connections-change')); });
  await expect(page.locator('.ai-conversation-connection')).toContainText('已删除');
  await expect(page.locator('.ai-assistant')).toContainText('echo remote');
});

test('failed persistence stays visible and can be retried without losing the transcript', async ({ page }) => {
  await openApp(page); await page.evaluate(() => { (window as any).aiHistoryError = 'fixture disk error'; });
  await send(page, '需要保存的问题'); await expect(page.locator('.ai-history-error')).toContainText('fixture disk error');
  await expect(page.locator('.ai-user')).toContainText('需要保存的问题');
  await page.evaluate(() => { (window as any).aiHistoryError = ''; }); await page.locator('.ai-history-error button').click();
  await expect.poll(() => page.evaluate(() => (window as any).testState.aiHistory.size)).toBe(1);
  await page.reload(); await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-user')).toContainText('需要保存的问题');
});

test('saved SSH connections share stable groups across tabs, renaming and changed hosts', async ({ page }) => {
  await openApp(page, { savedProfiles: [{ id: 'server-one', name: '服务器一', host: 'server-one.invalid', port: 22, username: 'fixture', auth: 'agent' }] });
  await page.evaluate(() => { (window as any).testState.sshAutoConnect = true; });
  await page.locator('.ai-close').click(); await page.locator('#btn-add-menu').click();
  await page.locator('.menu-item .title').filter({ hasText: /^服务器一$/ }).click();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(2); await page.locator('#btn-ai').click();
  await send(page, '远程排错问题'); await page.locator('.ai-input').fill('远程草稿');
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()].find(value => value.title === '远程排错问题')?.draft)).toBe('远程草稿');
  await page.locator('.ai-close').click(); await page.locator('.tab').first().click(); await page.locator('#btn-ai').click();
  await send(page, '本地问题'); await expect(page.locator('.ai-history-list summary')).toHaveCount(2);
  await page.locator('.ai-close').click(); await page.locator('.tab').last().click(); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-user')).toContainText('远程排错问题'); await expect(page.locator('.ai-input')).toHaveValue('远程草稿');
  await expect(page.locator('.ai-insert')).toBeEnabled();
  await page.evaluate(() => { (window as any).testState.profiles[0].name = '改名后的服务器'; window.dispatchEvent(new Event('wterm-connections-change')); });
  await expect(page.locator('.ai-conversation-connection')).toContainText('改名后的服务器');
  await page.evaluate(() => { (window as any).testState.profiles[0].host = 'another-host.invalid'; window.dispatchEvent(new Event('wterm-connections-change')); });
  // The existing live terminal and transcript still belong to the original host.
  await expect(page.locator('.ai-conversation-connection')).toContainText('server-one.invalid');
  await expect(page.locator('.ai-user')).toContainText('远程排错问题');
  await page.locator('.ai-close').click(); await page.locator('#btn-add-menu').click();
  await page.locator('.menu-item .title').filter({ hasText: /^改名后的服务器$/ }).click();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(3); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-user')).toHaveCount(0);
  const old = page.locator('.ai-history-row').filter({ hasText: '远程排错问题' }); await old.dblclick();
  await expect(page.locator('.ai-insert')).toBeDisabled();
  await expect(page.locator('.ai-conversation-connection')).toContainText('server-one.invalid');
});

test('window close flushes the latest draft before destroying the window', async ({ page }) => {
  await openApp(page); await send(page, '关闭前的会话'); await page.locator('.ai-input').fill('刚刚输入的草稿');
  await page.evaluate(() => (window as any).emitCloseRequest());
  await expect.poll(() => page.evaluate(() => (window as any).testState.calls.some(call => call.command.endsWith('destroy')))).toBe(true);
  expect(await page.evaluate(() => [...(window as any).testState.aiHistory.values()][0].draft)).toBe('刚刚输入的草稿');
});

test('saving AI configuration keeps the current transcript and draft', async ({ page }) => {
  await openApp(page); await send(page, '保留已有正文'); await page.locator('.ai-input').fill('保留输入草稿');
  await page.evaluate(() => window.dispatchEvent(new Event('wterm-ai-config-change')));
  await expect(page.locator('.ai-user')).toContainText('保留已有正文');
  await expect(page.locator('.ai-input')).toHaveValue('保留输入草稿');
  await expect(page.locator('.ai-history-row')).toHaveCount(1);
});

test('a failed close save keeps the window and draft when the user cancels closing', async ({ page }) => {
  await openApp(page); await send(page, '必须保留的会话'); await page.locator('.ai-input').fill('不能丢失的草稿');
  await page.evaluate(() => { (window as any).aiHistoryError = 'fixture write failure'; });
  let prompted = false;
  page.once('dialog', async dialog => { prompted = true; expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); });
  await page.evaluate(() => (window as any).emitCloseRequest());
  await expect.poll(() => prompted).toBe(true);
  expect(await page.evaluate(() => (window as any).testState.calls.some(call => call.command.endsWith('destroy')))).toBe(false);
  await expect(page.locator('.ai-input')).toHaveValue('不能丢失的草稿');
  await page.evaluate(() => { (window as any).aiHistoryError = ''; }); await page.locator('.ai-history-error button').click();
  await expect.poll(() => page.evaluate(() => [...(window as any).testState.aiHistory.values()][0].draft)).toBe('不能丢失的草稿');
});

test('restored command actions become available when the terminal finishes connecting', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).localSpawnDelay = 1800;
    localStorage.setItem('wterm_ai_base_url', 'https://api.deepseek.com/v1');
    localStorage.setItem('wterm_ai_models', '["deepseek-chat"]'); localStorage.setItem('wterm_ai_active_model', 'deepseek-chat');
    const common = { createdAt: 1, context: '', action: 'chat', model: 'deepseek-chat', provider: 'https://api.deepseek.com/v1', error: '' };
    const id = '00000000-0000-4000-8000-000000000111';
    localStorage.setItem('__test_ai_history', JSON.stringify({ [id]: { id, connection: { id: 'local', name: '本地终端', kind: 'local', targetKey: 'local', saved: false },
      title: '恢复已有命令', pinned: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, revision: 1, draft: '', selection: '', model: 'deepseek-chat',
      messages: [{ ...common, id: 'u', role: 'user', content: '列出文件', status: 'complete' }, { ...common, id: 'a', role: 'assistant', content: '```bash\nls -la\n```', status: 'complete' }] } }));
  });
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/'); await expect(page.locator('.tab')).toHaveCount(1); await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-insert')).toBeDisabled();
  await expect(page.locator('.tab .dot.connected')).toHaveCount(1); await expect(page.locator('.ai-insert')).toBeEnabled();
});
