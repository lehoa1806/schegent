import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Feature 059 — alias the bare `vscode` specifier to a default stub so
  // modules that statically import `vscode` (e.g.
  // `src/state/capability-trust-resolver.ts`) can be loaded by tests that
  // do not supply their own `vi.mock('vscode', …)`. Tests that need real
  // VS Code semantics continue to override the alias via `vi.mock` at
  // module scope.
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./tests/__stubs__/vscode.ts', import.meta.url))
    }
  },
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      // FR-R3-042 — `tests/perf/**` is deliberately absent.
      //
      // It used to be here AND invoked separately as `test:perf` in the `ci`
      // chain, so every wall-clock budget was asserted twice per gate for one
      // signal: double the flake exposure, no extra information. It is now run
      // once, by `test:perf`, which both `ci` and `ci:fast` name explicitly.
      //
      // Excluding it here rather than dropping `test:perf` from the chain is the
      // choice that keeps timing assertions out of `test:host`. That suite is
      // the one FR-R3-033 made hermetic, and a wall-clock assertion inside it is
      // an environment-dependent failure in a suite whose whole value is that it
      // is not. Naming perf explicitly also makes it visible in the chain rather
      // than an invisible passenger of the default include.
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
    // Vitest's default is 5s for both, and 5s was never a number anyone chose
    // for this suite — it is what you get by not setting it.
    //
    // What this suite actually contains: `tests/integration/**` spawns real
    // processes, writes real files and drains real queues. On an IDLE machine
    // `concurrent-run-execution.test.ts` runs 21 tests in 22.1s and
    // `concurrency-cap.test.ts` runs 5 in 7.4s. Those averages sit against a 5s
    // per-test ceiling, so the margin is near zero before anything goes wrong.
    //
    // Measured 2026-08-23: with an unrelated 10-worker build running on this
    // 10-core machine, `npm run test:host` failed 14-17 tests, every one of them
    // `Test timed out in 5000ms`, and always from the same six integration
    // files. The identical commit had passed `npm run ci` end to end 40 minutes
    // earlier on an idle machine. Nothing about the code changed between the
    // two runs; only what else the CPU was doing.
    //
    // That is not a flaky suite, it is a suite measuring the machine — the same
    // defect FR-R3-033 fixed in `drainUntil`, which bounded a wait in
    // event-loop rounds rather than elapsed time and so failed under load for
    // exactly this reason. A timeout that a passing test approaches on an idle
    // box reports load, not correctness.
    //
    // 30s is chosen as roughly 4x the slowest observed single-file average, not
    // to paper over a hang: a genuine deadlock still fails, 25s later. The
    // wall-clock cost of the raise is zero on a green run, because a passing
    // test never reaches its timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Gives the run its own temp root rather than the shared system one, so a
    // saturated `$TMPDIR` cannot turn filesystem-heavy suites into timeouts.
    // Reasoning in the file.
    globalSetup: ['./tests/global-temp-root.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // One exclusion, and it is a measured one.
      //
      // `src/ui/sidebar/messages.ts` is a nine-line shim (`wc -l`, so ten
      // by the newline-split convention the LOC budget uses) holding
      // message literals and no executable statement worth measuring.
      // Check the claim rather than trusting the adjective.
      //
      // FR-R3-027 removed the other two. `src/extension.ts` was excluded
      // as an activation entry "exercised end-to-end via integration
      // tests, not unit tests" — and measurement showed that premise named
      // the wrong suite: the file is 74.64% statement-covered by the suite
      // that runs on every `npm run test`, while the `*.host.test.ts` files
      // the comment referred to are excluded at line 28 below and are
      // reached in CI only after the visual-regression step. Including it
      // costs 0.30 points of line coverage. `src/**/*.d.ts` was deleted
      // because it matched zero files under `src/`; an exclusion that
      // excludes nothing is a comment pretending to be a decision.
      exclude: ['src/ui/sidebar/messages.ts'],
      // Floors pinned below measured coverage, and deliberately not raised
      // to meet it: a floor set to what today's tree happens to hit makes
      // the next legitimate refactor red for nothing.
      //
      // Measured 2026-08-22 on darwin, branch
      // 110-coverage-and-budget-gate-completeness, with `src/extension.ts`
      // in the measured set (411 files): 89.64% statements (38720/43192) /
      // 88.11% branches (13088/14854) / 91.65% functions (2437/2659) /
      // 89.64% lines. Statements and functions reproduced exactly across
      // runs; branches moved 0.02 points (13081/14848 in one run), because
      // v8 attributes branch ranges from what actually executed. A floor
      // pinned to a measured number would be pinned to that noise too.
      //
      // The previous comment recorded a Linux branch-056 run (~88.7 /
      // ~84.1 / ~88.2 / ~88.7); its branches figure had drifted four points
      // from actual, which is why the platform and branch are named here
      // and the full run is recorded in
      // docs/development/coverage-measurements.md.
      //
      // The 80% line matches the service-level target in CLAUDE.md. CI
      // fails on regression.
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
