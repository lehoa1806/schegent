import { defineConfig } from 'vitest/config';

// Feature 034 Item 055 — separate config for deterministic-CLI Speckit
// pipeline E2E tests. The default `vitest.config.ts` excludes these
// because they spawn real child processes (the fake-claude stub) and
// are slower than unit / integration tests. Run via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 120_000,
    hookTimeout: 30_000
  }
});
