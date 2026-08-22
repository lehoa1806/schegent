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
      //   * Nine files measure 0% today, 461 statements between them. FR-R3-044
      //     classified all nine, and the number reads as a testing gap when it
      //     is almost entirely a dead-code inventory:
      //
      //       - SIX Svelte components, 407 of the 461 statements, are already
      //         recorded as knowingly unreachable by
      //         `tests/lint/svelte-surface-reachability.test.ts`, each with its
      //         reason — HoverText.svelte (179, superseded by the
      //         hover-text-anchor directive and HoverTextPortal),
      //         ControlPanel.svelte (104), QueueList.svelte (41, superseded by
      //         QueuesTier), PhaseTracker.svelte (36, superseded by
      //         RunDetailTier's phase list), LiveActivityHeader.svelte (33) and
      //         StatusHeader.svelte (14). None has an importer outside tests.
      //       - TWO are bootstrap entry points, 27 statements: `src/main.ts` and
      //         `src/dashboard/main.ts`. What they do is mount the app, and a
      //         unit test that mounts the mounter asserts nothing the visual and
      //         integration suites do not already cover better.
      //       - ONE was live, untested library code: `lib/copy-text.ts`, 27
      //         statements, now covered by `lib/__tests__/copy-text.test.ts`
      //         including the branch its own header calls out — reporting a
      //         success it did not have.
      //
      //     They stay inside the measured set. Excluding them would raise the
      //     percentage and lose the inventory, and the inventory is the useful
      //     part: it says 407 statements of this webview are dead rather than
      //     untested. Two further files report 0% with no executable statements
      //     at all — `PipelineBuilderEditors/types.ts` and
      //     `activity-feed/types.ts` — which is v8 describing type-only modules,
      //     not a gap.
      //
      // Floors are `floor(measured) − 5` per metric, ratcheted by
      // `scripts/check-coverage-headroom.mjs`, which runs after every coverage
      // run and fails when a floor has fallen more than a point behind the
      // intended `floor(measured) − 5`. FR-R3-027 set the headroom and recorded
      // that nothing ever raised it; without the ratchet, coverage could fall
      // five points run after run and every run would stay green. Lowering a
      // floor remains possible and remains deliberate — an edit in a diff, which
      // is where a decision to accept less coverage belongs.
      //
      // Measured against
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
