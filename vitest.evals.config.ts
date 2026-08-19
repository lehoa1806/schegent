import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/evals/**/*.test.ts'],
    environment: 'node',
    // Same per-run temp root as `vitest.config.ts`.
    globalSetup: ['./tests/global-temp-root.ts'],
    pool: 'threads'
  }
});
