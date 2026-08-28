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
      //   * 189 source files are instrumented — 104 `.svelte` and 85
      //     non-test `.ts` — so un-imported components are counted at 0%
      //     rather than omitted. No shipping `.svelte` path is excluded;
      //     excluding the component majority would make the percentage a
      //     statement about the `lib/` helpers only, over roughly half the
      //     statements.
      //
      //     Taken from the coverage run below, not from a `find`: the two are
      //     different questions that produce similar-looking numbers. The
      //     previous triple read 189 / 107 / 82 and was already wrong before
      //     FR-R3-140 touched it — that feature deleted ten `.svelte` files,
      //     which cannot take 107 to 104. The total landing on 189 again is a
      //     coincidence and means something different now.
      //   * Under v8, `lines` and `statements` are the same measure, which
      //     is why those two percentages are identical (as they are in the
      //     host config).
      //   * The dead-code inventory that used to sit here is gone, because the
      //     code is. FR-R3-140 deleted the six Svelte components it enumerated
      //     — 407 of what were then 461 zero-coverage statements — after
      //     measuring each unreachable from both bundle entry points. The
      //     reachability gate no longer excuses them; its allowlist is empty and
      //     an entry now needs an owner and an expiry date. See
      //     ../docs/architecture/webview-dead-surface-removal.md.
      //
      //     What still measures 0% is small and classified. TWO bootstrap entry
      //     points, 27 statements: `src/main.ts` and `src/dashboard/main.ts`.
      //     What they do is mount the app, and a unit test that mounts the
      //     mounter asserts nothing the visual and integration suites do not
      //     already cover better. They are not a dead-code inventory and must
      //     not be governed as one — asking whether an entry point has an
      //     importer is the wrong question, which is why FR-R3-140 retired the
      //     gate that would have been repointed at them rather than inventing a
      //     claim for it to hold. Two further files report 0% with no executable
      //     statements at all — `PipelineBuilderEditors/types.ts` and
      //     `activity-feed/types.ts` — which is v8 describing type-only
      //     modules, not a gap.
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
      // Measured 2026-08-29 on darwin, branch
      // 204-delete-unreachable-webview, after FR-R3-140's deletion:
      // 87.75% statements (13366/15232) / 79.46% branches (4878/6139) /
      // 81.42% functions (881/1082) / 87.75% lines.
      //
      // All four floors are re-derived from that one run. Deleting whole files
      // moves the four denominators by different amounts and not all in the
      // same direction — statements rose 84.97 → 87.75 as 407 zero-coverage
      // statements left the denominator, functions rose 81.06 → 81.42, and
      // branches *fell* slightly, 79.60 → 79.46. No floor may be inferred from
      // another. Branches and functions land on the same floors they had, which
      // is a measured result and not an untouched line.
      //
      // Five points of headroom is room for a legitimate refactor; pinning a
      // floor to what the tree happens to measure today makes the next one red
      // for nothing. Full run recorded in
      // ../docs/development/coverage-measurements.md.
      thresholds: {
        statements: 82,
        branches: 74,
        functions: 76,
        lines: 82
      }
    }
  }
});
