import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.ui.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:1420', browserName: 'chromium', channel: 'msedge', viewport: { width: 900, height: 650 } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
});
