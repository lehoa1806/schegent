import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
    // FR-R3-027 — this workspace held 39,353 lines of source against
    // 37,496 lines of test and was measured by nothing.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Tests live beside source here, so the measured set is named
      // explicitly and test code is excluded from it rather than moved.
      // `test.include` above is unchanged.
      //
      // `__tests__/**` is excluded for the same reason `*.test.ts` is, and
      // for no other: the nine files it holds are fixtures and harnesses —
      // including six `.svelte` surfaces built to be mounted by a test.
      // They are exercised by construction, so counting them inflates the
      // measurement of the product code (85.17% with them, 84.97% without,
      // 289 statements). This is not the Svelte-component exclusion the
      // requirement forbids: no component that ships is excluded.
      include: ['src/**/*.ts', 'src/**/*.svelte'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      // What the provider counts, recorded where a reader of the numbers
      // will find it:
      //   * 189 source files are instrumented — 107 `.svelte` and 82
      //     non-test `.ts` — so un-imported components are counted at 0%
      //     rather than omitted. No shipping `.svelte` path is excluded;
      //     excluding the component majority would make the percentage a
      //     statement about the `lib/` helpers only, over roughly half the
      //     statements.
      //   * Under v8, `lines` and `statements` are the same measure, which
      //     is why those two percentages are identical (as they are in the
      //     host config).
      //   * Nine files measure 0% today, 461 statements between them — the
      //     largest are HoverText.svelte, ControlPanel.svelte, and the two
      //     entry points. They are inside the measured set.
      //
      // Floors are `floor(measured) − 5` per metric, against a measurement
      // taken 2026-08-22 on darwin, branch
      // 110-coverage-and-budget-gate-completeness: 84.97% statements
      // (12466/14671) / 79.60% branches (4747/5963) / 81.06% functions
      // (865/1067) / 84.97% lines. Five points of headroom is room for a
      // legitimate
      // refactor; pinning a floor to what the tree happens to measure today
      // makes the next one red for nothing. Full run recorded in
      // ../docs/development/coverage-measurements.md.
      thresholds: {
        statements: 79,
        branches: 74,
        functions: 76,
        lines: 79
      }
    }
  }
});
