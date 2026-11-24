# Coverage measurements and gates

This page records the coverage sets, floors, and commands currently encoded in the repository. Percentages are measurements captured in configuration comments, not promises about a future checkout; rerun the commands before using them to judge a new change.

## Host coverage

Run from the repository root:

```bash
npm run test:coverage
```

The command runs the default Vitest suite with V8 coverage. The measured set is `src/**/*.ts`, excluding only `src/ui/sidebar/messages.ts`. Reports are written to `coverage/` in text, JSON, HTML, and LCOV forms.

| Metric | Enforced floor | Recorded 2026-11-12 measurement |
|---|---:|---:|
| Statements | 84% | 89.07% (`121,229 / 136,105`) |
| Branches | 81% | 86.28% (`39,739 / 46,059`) |
| Functions | 88% | 93.73% (`7,261 / 7,747`) |
| Lines | 84% | 89.07% |

The recorded host run measured 984 files on darwin. The configuration warns that V8 branch attribution moves by a few hundredths of a point across runs, so floors are intentionally below the observed snapshot rather than pinned to it. Review gap GC-17 raised them from 80/75/80/80, which had drifted 9 to 13 points below measured coverage, and put the host under the same headroom ratchet as the webview (below).

<!-- Source: package.json -->
<!-- Source: vitest.config.ts -->

## Webview coverage

Run from the repository root:

```bash
npm run test:webview:coverage
```

The webview command first checks generated queue-projection mocks, then runs Vitest with V8 coverage, and finally runs the coverage-headroom ratchet. It measures shipping `webview-ui/src/**/*.ts` and `webview-ui/src/**/*.svelte`, excluding test files and `__tests__` fixtures. Reports are written to `webview-ui/coverage/`.

| Metric | Enforced floor | Recorded 2026-11-23 measurement (`FR-R7-17`) |
|---|---:|---:|
| Statements | 88% | 93.05% |
| Branches | 75% | 81.21% (`FR-R7-15` W13 baseline) |
| Functions | 83% | 89.11% (`1,579 / 1,772`, `FR-R7-15` W13 baseline) |
| Lines | 88% | 93.05% |

The November 18 port tip (`2ce9b6f1`) instrumented 281 source files (`91.85%` statements/lines, `81.08%` branches, `88.12%` functions), and `FR-R7-17` subsequently raised statements/lines coverage to `93.05%`, triggering the headroom ratchet to raise statements and lines floors to `88%`. Unimported shipping components remain in the measured set and therefore count as zero rather than disappearing from the denominator.

### Function coverage variance investigation (FR-R7-15 W13)

At the November 18 port tip (`2ce9b6f1`), 18 of 19 runs measured `88.12%` (`1,491 / 1,692`) webview functions while one run at commit 118 measured `88.21%` (+0.09 percentage points), attributed to `MetricsDashboard.svelte`. Two factors explained that shift:

1. **Unawaited lazy route import racing `cleanup()`**: `webview-ui/src/dashboard/__tests__/App.nav.test.ts` clicked `dashboard-route-metrics` — triggering `route-loader.ts`'s dynamic `import('../components/MetricsDashboard/MetricsDashboard.svelte')` — and exited immediately into `afterEach(() => cleanup())` without waiting for the chunk to mount. Running `App.nav.test.ts` alone under `@vitest/coverage-v8` produced a partial 1-function, 0-hit entry (`MetricsDashboard@L1: 0`) for `MetricsDashboard.svelte`, whereas `MetricsDashboard.test.ts` in another worker produced the full Svelte-compiled function table. When commit `0cee6e06` had not yet added tab-switching coverage to `MetricsDashboard.test.ts`, worker timing differences during dynamic-import teardown could shift `@vitest/coverage-v8` / `ast-v8-to-istanbul` merged function counts by 1–2 functions (~0.06–0.12 percentage points).
2. **Stabilization and repeated isolated verification (2026-11-23)**:
   - Pre-fix (5 identical isolated runs of `npm --prefix webview-ui run test:coverage` on darwin): all 5 runs measured identical webview function coverage `89.0519%` (`1,578 / 1,772`, `MetricsDashboard.svelte` `14 / 16` functions, 0.00 percentage-point variance across all files).
   - `App.nav.test.ts` now awaits every lazy route landmark (`pipeline-builder-root`, `system-tab`, `settings-surface-root`, `history-dashboard`, and `metrics-section`) before advancing or tearing down (with all three lazy-route tests governed by `BUDGETED_TESTS`), and `MetricsDashboard.test.ts` adds deterministic keyboard tab-switching coverage (`onTabKeydown`).
   - Post-fix (5 identical isolated runs on darwin): all 5 runs measured `92.50%` statements (`23,473 / 25,376`), `81.21%` branches (`9,271 / 11,416` to `9,273 / 11,418`, ±1 synthetic V8 branch), `89.1084%` functions (`1,579 / 1,772`, `MetricsDashboard.svelte` `15 / 16` functions, 0.0000 percentage-point variance across all files), and `92.50%` lines. Enforced floors at that commit were `86 / 75 / 83 / 86` (all within the headroom ratchet's 1-point tolerance), before `FR-R7-17` raised statements and lines to `88%`.

This row replaces the 2026-09-03 measurement rather than sitting beside it: this page states current enforced values, and the history is in git. The 2026-09-03 run set the floors at 84%, 75%, 77% and 84%, all four re-derived from that one run. Each later raise took only what the headroom ratchet flagged: feature 252 took statements and lines to 86% and functions to 79%, `FR-R6-F05` took functions to 81%, the webview redesign port took functions to 83%, and `FR-R7-17` took statements and lines to 88%. Branches have stayed at 75%. See [`../architecture/webview-dead-surface-removal.md`](../architecture/webview-dead-surface-removal.md) for the 2026-08-29 deletion that set the row before the 2026-09-03 one.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/vitest.config.ts -->

## Headroom ratchet

`scripts/check-coverage-headroom.mjs` reads a coverage report after a coverage run: `webview-ui/coverage/coverage-final.json` at the end of the webview `test:coverage`, and the host `coverage/coverage-final.json` through `npm run coverage:headroom`, which `ci` and `verify:release` run straight after the host `test:coverage`. The host check is a separate script because the host `test:coverage` must stay one command (the `webview-build-precedes-host-suite` gate), and it is not in `ci:fast`, which writes no coverage report. For statements, branches, functions, and lines, it computes an intended floor of `floor(measured) - 5`. A configured floor may lag that intended value by at most one point; a larger gap fails and asks the maintainer to raise the floor.

The ratchet never edits configuration. Lowering a floor remains a deliberate code change, while rising coverage must eventually be banked in `vitest.config.ts` or `webview-ui/vitest.config.ts`.

<!-- Source: scripts/check-coverage-headroom.mjs -->
<!-- Source: vitest.config.ts -->
<!-- Source: webview-ui/vitest.config.ts -->

## Where coverage runs

`npm run verify:all` includes the default host tests and webview coverage. `npm run ci` runs the host `test:coverage` target, and since hosted CI was retired on 2026-08-26 (`FR-R3-099`) that local run is the only one — the Linux job that also ran it is gone, so these figures are measured on whatever platform the operator used. Evaluation, performance, browser-visual, E2E, and Extension Host integration suites are separate targets; running them does not add their execution to the V8 coverage sets above.

<!-- Source: package.json -->
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: vitest.config.ts -->
<!-- Source: vitest.evals.config.ts -->
<!-- Source: vitest.perf.config.ts -->
<!-- Source: vitest.e2e.config.ts -->
