import { defineConfig } from '@playwright/test';

// Run after building dist/offline.html. This suite opens the app from disk and
// exercises its real IndexedDB implementation without an HTTP server or mock API.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/offline.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
