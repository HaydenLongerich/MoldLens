import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run gets an isolated data directory, so test submissions never enter the demo workspace.
const testDataDir = process.env.MOLDLENS_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'moldlens-e2e-'));
process.env.MOLDLENS_E2E_DATA_DIR = testDataDir;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/offline.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    browserName: 'chromium',
    // Fake camera so the live phone flow can run headless; it has no effect on other specs.
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/build-screening.mjs && node server/index.mjs',
    // Browser regressions must never use a developer's configured live AI key.
    env: { PORT: '5175', HOST: '127.0.0.1', MOLDLENS_DATA_DIR: testDataDir, AI_PROVIDER: 'mock' },
    url: 'http://127.0.0.1:5175/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
