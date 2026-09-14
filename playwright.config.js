import { defineConfig } from '@playwright/test';

// Tests share ONE seeded in-process server (booted in globalSetup), so they must
// not run in parallel and must not be destructive (e.g. never delete demo.test).
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    // Optional override for out-of-process runs; specs navigate via the `baseUrl`
    // fixture populated by globalSetup (config is loaded before globalSetup runs).
    baseURL: process.env.JLP_E2E_URL,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
});
