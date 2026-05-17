import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/perf/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/parity/**/*.test.ts',
      'tests/lint/**/*.test.ts',
      'tests/contract/**/*.test.ts'
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/integration/**/*.host.test.ts',
      'tests/integration/runTest.ts',
      'tests/integration/index.ts'
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // `src/extension.ts` is the activation entry whose seams are
      // exercised end-to-end via integration tests, not unit tests.
      // The `*.d.ts` and contracts shim files contain no executable
      // statements worth measuring.
      exclude: [
        'src/extension.ts',
        'src/**/*.d.ts',
        'src/ui/sidebar/messages.ts'
      ],
      // Floor pinned slightly below current measured coverage (Linux
      // run as of branch 056: ~88.7% statements / ~84.1% branches /
      // ~88.2% functions / ~88.7% lines). The 80% line matches the
      // service-level target in CLAUDE.md. CI fails on regression.
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80
      }
    },
    pool: 'threads'
  }
});
