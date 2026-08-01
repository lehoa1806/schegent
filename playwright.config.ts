import { defineConfig } from '@playwright/test';

const isCi = process.env['CI'] === 'true';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.visual.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: isCi,
  outputDir: 'tests/visual/.artifacts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  reporter: isCi
    ? [
        ['line'],
        ['html', { outputFolder: 'tests/visual/.artifacts/report', open: 'never' }]
      ]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      threshold: 0.25,
      maxDiffPixelRatio: 0.04
    }
  },
  webServer: {
    command: 'node tests/visual/serve-built-webviews.mjs',
    port: 4173,
    reuseExistingServer: !isCi,
    timeout: 15_000
  }
});
