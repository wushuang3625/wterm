import { test, expect } from '@playwright/test';

test('website preview switches panels with pointer and keyboard and explains illustrative content', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('本地与远端');
  await expect(page.getByRole('tabpanel', { name: 'SSH', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'SFTP', exact: true }).click();
  await expect(page.locator('.file-table')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'AI 助手', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ai-conversation')).toBeVisible();
  await page.locator('.demo-thinking summary').click();
  await expect(page.locator('.demo-thinking p')).toBeVisible();
  await page.getByRole('tab', { name: 'AI 助手', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'SSH', exact: true })).toBeFocused();
  await expect(page.locator('.window-status')).toContainText('不连接真实服务器');
  await expect(page.locator('.release-note')).toContainText('已发布安装包的功能以对应 Release 为准');
});

test('language, accessible labels, source links and theme persist through reload', async ({ page }) => {
  await page.goto('/docs/');
  await page.getByRole('button', { name: '切换到英文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.locator('[data-i18n]').evaluateAll(nodes => nodes.filter(node => /\p{Script=Han}/u.test(node.textContent || '')).length)).toBe(0);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('every connection');
  await expect(page.locator('[data-source-link]')).toHaveAttribute('href', 'https://github.com/wushuang3625/wterm#development');
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Switch to Chinese', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('[data-source-link]')).toHaveAttribute('href', /README.zh-CN/);
});

test('copy confirms the exact clone command and reports clipboard failure', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedCommand = text; } } });
  });
  await page.goto('/docs/');
  await page.getByRole('button', { name: '复制命令', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedCommand)).toBe('git clone https://github.com/wushuang3625/wterm.git');
  await expect(page.getByRole('status')).toHaveText('已复制');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } }); });
  await page.getByRole('button', { name: '复制命令', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('请选中命令手动复制。');
});

test('website remains within small and large viewports in both languages', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const language of ['zh', 'en']) {
      await page.goto(`/docs/?lang=${language}`);
      await expect(page.locator('.copy-button')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByRole('tab', { name: 'SFTP', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.locator('#tab-ai').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  }
  await page.goto('/docs/?lang=zh');
  await page.screenshot({ path: 'test-results/website-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/website-mobile.png', fullPage: true });
});

test('FAQ disclosure works and download links use the actual releases destination', async ({ page }) => {
  await page.goto('/docs/?lang=en');
  await page.getByText('How does the AI assistant use my content?', { exact: true }).click();
  await expect(page.locator('.faq-list details[open] p')).toContainText('Automatic failure diagnosis is off by default');
  for (const link of await page.locator('.hero-actions .button, .download-actions .button').all()) {
    await expect(link).toHaveAttribute('href', 'https://github.com/wushuang3625/wterm/releases/latest');
  }
  expect(await page.locator('a[href="#"]').count()).toBe(2);
  const issues = await page.locator('a').evaluateAll(links => links.filter(link => !link.getAttribute('href') || /^(javascript:|http:)/i.test(link.getAttribute('href') || '')).length);
  expect(issues).toBe(0);
});
