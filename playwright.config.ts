import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  // The layout sweep visits every route in both themes and screenshots each one, which runs
  // close to 25s on a developer machine and overran Playwright's 30s default on CI runners.
  timeout: 120_000,
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
