import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 120000,
  expect: {
    timeout: 20000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node backend/server.js',
      cwd: '.',
      port: 4000,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'npm run dev --prefix frontend -- --host 0.0.0.0 --strictPort --port 4173',
      cwd: '.',
      port: 4173,
      reuseExistingServer: true,
      timeout: 30000,
    }
  ],
});
