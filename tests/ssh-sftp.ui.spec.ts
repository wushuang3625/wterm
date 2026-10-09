import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
});
test('new SSH configuration carries ProxyJump and explicit agent authentication', async ({ page }) => {
  await page.evaluate(async () => { const module = await import('/src/profiles.ts'); module.showNewSshDialog(); });
  await page.locator('#f-host').fill('target.invalid'); await page.locator('#f-user').fill('deploy');
  await page.locator('#f-proxy-jump').fill('bastion,admin@second:2222');
  await page.locator('#f-auth').selectOption('agent');
  await page.locator('#f-ok').click();
  await expect.poll(() => page.evaluate(() => window.testState.calls.find(call => call.command === 'spawn_ssh')?.args.proxyJump)).toBe('bastion,admin@second:2222');
  expect(await page.evaluate(() => window.testState.calls.find(call => call.command === 'spawn_ssh')?.args.auth)).toBe('agent');
});
test('SFTP queue pauses, resumes, cancels and retries with fixed paths', async ({ page }) => {
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
  await expect(page.locator('.sftp-item')).toHaveCount(1);
  await page.locator('#sp-upload').click();
  const row = page.locator('.transfer-row').first();
  await expect(row).toHaveAttribute('data-status', 'running');
  await row.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(row).toHaveAttribute('data-status', 'paused');
  await row.getByRole('button', { name: '继续', exact: true }).click();
  await expect(row).toHaveAttribute('data-status', 'running');
  await page.screenshot({ path: 'test-results/sftp-queue.png' });
  await row.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toHaveAttribute('data-status', 'cancelled');
  page.once('dialog', dialog => dialog.accept());
  await row.getByRole('button', { name: '重新传输', exact: true }).click();
  await expect(page.locator('.transfer-row')).toHaveCount(2);
  await expect(page.locator('.transfer-row').last()).toHaveAttribute('data-status', 'running');
  const calls = await page.evaluate(() => window.testState.calls.filter(call => call.command === 'sftp_transfer').map(call => call.args));
  expect(calls[0].remote).toBe('/home/remote-a/upload.bin'); expect(calls[1].remote).toBe(calls[0].remote);
  expect(calls[1].transferId).not.toBe(calls[0].transferId); expect(calls[1].overwrite).toBe(true);
});
test('SFTP switching sessions isolates queue, follows reported directories and changes permissions', async ({ page }) => {
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
  await page.locator('#sp-upload').click();
  await expect(page.locator('.transfer-row')).toHaveAttribute('data-status', 'running');
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-b'); });
  await expect(page.locator('.transfer-row')).toHaveCount(0);
  await page.locator('#sp-follow').check();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wterm-cwd', { detail: { sid: 'remote-b', path: '/srv/project' } })));
  await expect(page.locator('#sp-path')).toHaveText('/srv/project');
  page.once('dialog', dialog => dialog.accept('640'));
  await page.getByTitle('修改权限', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testState.calls.find(call => call.command === 'sftp_chmod')?.args.mode)).toBe(0o640);
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
  await expect(page.locator('.transfer-row')).toHaveAttribute('data-status', 'running');
});

for (const viewport of [{ width: 1142, height: 889 }, { width: 800, height: 650 }]) {
  test(`completed download opens the saved file and reveals it at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const local = 'C:\\下载 文件\\重命名, 报告.txt';
    await page.evaluate(path => { window.testState.downloadPath = path; }, local);
    await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
    await page.getByTitle('另存为并加入下载队列', { exact: true }).click();
    const row = page.locator('.transfer-row');
    await expect(row).toHaveAttribute('data-status', 'running');
    await expect(row.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0);
    await expect(row.locator('button.transfer-name')).toHaveCount(0);
    await page.evaluate(() => { for (const transfer of window.testState.transfers.values()) transfer.resolve(4096); });
    await expect(row).toHaveAttribute('data-status', 'completed');
    const file = row.getByRole('button', { name: '打开文件：readme.txt', exact: true });
    const folder = row.getByRole('button', { name: '打开文件夹', exact: true });
    await expect(file).toBeVisible(); await expect(folder).toBeVisible();
    await file.click();
    await expect.poll(() => page.evaluate(() => window.testState.calls.filter(call => call.command === 'open_downloaded_file').map(call => call.args))).toEqual([{ path: local, reveal: false }]);
    await folder.click();
    await expect.poll(() => page.evaluate(() => window.testState.calls.filter(call => call.command === 'open_downloaded_file').map(call => call.args))).toEqual([{ path: local, reveal: false }, { path: local, reveal: true }]);
    await file.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.testState.calls.filter(call => call.command === 'open_downloaded_file').length)).toBe(3);
    const geometry = await row.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
      });
    });
    expect(geometry).toBe(true);
    await page.screenshot({ path: `test-results/sftp-completed-download-${viewport.width}.png` });
  });
}

test('file opening errors preserve the completed download and can be retried', async ({ page }) => {
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
  await page.getByTitle('另存为并加入下载队列', { exact: true }).click();
  const row = page.locator('.transfer-row');
  await expect(row).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => {
    window.testState.openFileError = '文件不存在，可能已被移动或删除';
    for (const transfer of window.testState.transfers.values()) transfer.resolve(4096);
  });
  await expect(row).toHaveAttribute('data-status', 'completed');
  await row.getByRole('button', { name: '打开文件：readme.txt', exact: true }).click();
  await expect(row.locator('.transfer-error')).toContainText('打开文件失败：');
  await expect(row.locator('.transfer-error')).toContainText('文件不存在');
  await expect(row).toHaveAttribute('data-status', 'completed');
  await row.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(row.locator('.transfer-error')).toContainText('打开文件夹失败：');
  await page.evaluate(() => { window.testState.openFileError = null; });
  await row.getByRole('button', { name: '打开文件：readme.txt', exact: true }).click();
  await expect(row.locator('.transfer-error')).toHaveCount(0);
  await expect(row).toHaveAttribute('data-status', 'completed');
});

test('unfinished downloads and completed uploads have no local open actions', async ({ page }) => {
  await page.evaluate(async () => { await (await import('/src/sftp.ts')).openFor('remote-a'); });
  await page.getByTitle('另存为并加入下载队列', { exact: true }).click();
  const download = page.locator('.transfer-row').first();
  await expect(download).toHaveAttribute('data-status', 'running');
  await download.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(download).toHaveAttribute('data-status', 'paused');
  await expect(download.locator('.transfer-open-file')).toHaveCount(0);
  await expect(download.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0);
  await download.getByRole('button', { name: '取消', exact: true }).click();
  await expect(download).toHaveAttribute('data-status', 'cancelled');
  await expect(download.locator('.transfer-open-file')).toHaveCount(0);
  await expect(download.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0);
  await page.locator('#sp-upload').click();
  const upload = page.locator('.transfer-row').last();
  await expect(upload).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => { for (const transfer of window.testState.transfers.values()) transfer.resolve(4096); });
  await expect(upload).toHaveAttribute('data-status', 'completed');
  await expect(upload.locator('.transfer-open-file')).toHaveCount(0);
  await expect(upload.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0);
  await page.getByTitle('另存为并加入下载队列', { exact: true }).click();
  const failed = page.locator('.transfer-row').last();
  await expect(failed).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => { [...window.testState.transfers.values()].at(-1).reject(new Error('下载失败')); });
  await expect(failed).toHaveAttribute('data-status', 'failed');
  await expect(failed.locator('.transfer-open-file')).toHaveCount(0);
  await expect(failed.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCount(0);
});
