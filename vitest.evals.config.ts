import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/evals/**/*.test.ts'],
    environment: 'node',
    pool: 'threads'
  }
});
