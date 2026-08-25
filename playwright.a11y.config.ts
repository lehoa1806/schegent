// FR-R3-091 — the accessibility scan's Playwright project.
//
// A SEPARATE CONFIG, ONE SERVER. `playwright.config.ts` matches
// `**/*.visual.spec.ts` under `tests/visual`, so the a11y spec needs its own
// `testDir`. What it must NOT have is its own way of serving the app: the
// `webServer` below starts `tests/visual/serve-built-webviews.mjs` — the same
// script, on the same port — which is exactly what FR-R3-091 §3 asks for.
// `reuseExistingServer` means running both suites back to back starts one.
import { defineConfig } from '@playwright/test';

const isCi = process.env['CI'] === 'true';

export default defineConfig({
  testDir: './tests/a11y',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: isCi,
  outputDir: 'tests/a11y/.artifacts',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node tests/visual/serve-built-webviews.mjs',
    port: 4173,
    reuseExistingServer: !isCi,
    timeout: 15_000
  }
});
