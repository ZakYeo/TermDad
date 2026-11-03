import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './ui-tests',
  outputDir: '/tmp/term-dad-demo-ui',
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
});
