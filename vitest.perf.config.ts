import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// FR-R3-042 — separate config for the performance suite.
//
// `tests/perf/**` used to sit in the default config's `include` AND be invoked
// separately as `test:perf` in the `ci` chain, so every wall-clock budget was
// asserted twice per gate for one signal — double the flake exposure, no extra
// information.
//
// It could have been fixed by dropping `test:perf` from the chain instead. This
// direction was taken because it keeps timing assertions out of `test:host`:
// that is the suite FR-R3-033 made hermetic, and a wall-clock assertion inside
// it is an environment-dependent failure in a suite whose whole value is that it
// is not. It also makes perf a named target rather than an invisible passenger
// of the default include — visible in both `ci` and `ci:fast`, which now name it.
//
// Follows `vitest.e2e.config.ts`, which separates its suite for the same kind of
// reason.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./tests/__stubs__/vscode.ts', import.meta.url))
    }
  },
  test: {
    include: ['tests/perf/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globalSetup: ['./tests/global-temp-root.ts'],
    // Single-threaded on purpose. These assertions measure elapsed wall clock,
    // and a worker pool competing for cores is the most reliable way to make a
    // timing budget fail for a reason that has nothing to do with the code under
    // test — which is the flake this item exists to reduce, not to relocate.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } }
  }
});
