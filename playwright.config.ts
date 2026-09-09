import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    baseURL: 'http://127.0.0.1:1421',
  },
  projects: [
    { name: 'workspace-ui', testMatch: 'workspace.spec.ts', use: { browserName: 'chromium' } },
    ...(process.env.COMPASS_CDP_URL ? [{ name: 'tauri-cdp', testMatch: 'app.spec.ts' }] : []),
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 1421 --strictPort',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: !process.env.CI,
  },
});
