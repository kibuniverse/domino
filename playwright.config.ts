import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30000,
  use: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } },
  reporter: 'list',
})
