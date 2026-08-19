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
      // Baselines are authored on macOS and verified on Linux (the visual step is
      // gated `runner.os == 'Linux'`, and `snapshotPathTemplate` below strips
      // `{platform}`, so one file serves both), so this ratio has to absorb that
      // platform gap. Measured 2026-08-19 in an `ubuntu:24.04` container, in
      // Playwright's own metric: the gap tops out at 0.807%, while the smallest
      // drift that previously slipped through scored 1.326%. 0.01 sits between
      // them -- 24% headroom over the gap, and it fails all eight of the stale
      // baselines this replaced. 0.04 was wide enough to pass a whole missing
      // content band. `threshold` is deliberately left alone: tightening it makes
      // benign sub-pixel shifts louder without making content changes fail. See
      // docs/features/bugs/ visual-baseline-drift-passes-the-gate.
      maxDiffPixelRatio: 0.01
    }
  },
  webServer: {
    command: 'node tests/visual/serve-built-webviews.mjs',
    port: 4173,
    reuseExistingServer: !isCi,
    timeout: 15_000
  }
});
