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

| Metric | Enforced floor | Recorded 2026-11-26 measurement (Principal Review F4/F7) |
|---|---:|---:|
| Statements | 88% | 93.32% |
| Branches | 75% | 81.55% |
| Functions | 85% | 90.20% |
| Lines | 88% | 93.32% |

The November 18 port tip (`2ce9b6f1`) instrumented 281 source files (`91.85%` statements/lines, `81.08%` branches, `88.12%` functions), `FR-R7-17` raised statements/lines coverage to `93.05%` (floors `88%`), and Principal Review F4/F7 tests raised function coverage to `90.20%`, triggering the headroom ratchet to raise the functions floor to `85%`. Unimported shipping components remain in the measured set and therefore count as zero rather than disappearing from the denominator.

### Function coverage variance investigation (FR-R7-15 W13)

At the November 18 port tip (`2ce9b6f1`), 18 of 19 runs measured `88.12%` (`1,491 / 1,692`) webview functions while one run at commit 118 measured `88.21%` (+0.09 percentage points), attributed to `MetricsDashboard.svelte`. Two factors explained that shift:

1. **Unawaited lazy route import racing `cleanup()`**: `webview-ui/src/dashboard/__tests__/App.nav.test.ts` clicked `dashboard-route-metrics` — triggering `route-loader.ts`'s dynamic `import('../components/MetricsDashboard/MetricsDashboard.svelte')` — and exited immediately into `afterEach(() => cleanup())` without waiting for the chunk to mount. Running `App.nav.test.ts` alone under `@vitest/coverage-v8` produced a partial 1-function, 0-hit entry (`MetricsDashboard@L1: 0`) for `MetricsDashboard.svelte`, whereas `MetricsDashboard.test.ts` in another worker produced the full Svelte-compiled function table. When commit `0cee6e06` had not yet added tab-switching coverage to `MetricsDashboard.test.ts`, worker timing differences during dynamic-import teardown could shift `@vitest/coverage-v8` / `ast-v8-to-istanbul` merged function counts by 1–2 functions (~0.06–0.12 percentage points).
2. **Stabilization and repeated isolated verification (2026-11-23)**:
   - Pre-fix (5 identical isolated runs of `npm --prefix webview-ui run test:coverage` on darwin): all 5 runs measured identical webview function coverage `89.0519%` (`1,578 / 1,772`, `MetricsDashboard.svelte` `14 / 16` functions, 0.00 percentage-point variance across all files).
   - `App.nav.test.ts` now awaits every lazy route landmark (`pipeline-builder-root`, `system-tab`, `settings-surface-root`, `history-dashboard`, and `metrics-section`) before advancing or tearing down (with all three lazy-route tests governed by `BUDGETED_TESTS`), and `MetricsDashboard.test.ts` adds deterministic keyboard tab-switching coverage (`onTabKeydown`).
   - Post-fix (5 identical isolated runs on darwin): all 5 runs measured `92.50%` statements (`23,473 / 25,376`), `81.21%` branches (`9,271 / 11,416` to `9,273 / 11,418`, ±1 synthetic V8 branch), `89.1084%` functions (`1,579 / 1,772`, `MetricsDashboard.svelte` `15 / 16` functions, 0.0000 percentage-point variance across all files), and `92.50%` lines. Enforced floors at that commit were `86 / 75 / 83 / 86` (all within the headroom ratchet's 1-point tolerance), before `FR-R7-17` raised statements and lines to `88%`.

This row replaces the 2026-09-03 measurement rather than sitting beside it: this page states current enforced values, and the history is in git. The 2026-09-03 run set the floors at 84%, 75%, 77% and 84%, all four re-derived from that one run. Each later raise took only what the headroom ratchet flagged: feature 252 took statements and lines to 86% and functions to 79%, `FR-R6-F05` took functions to 81%, the webview redesign port took functions to 83%, `FR-R7-17` took statements and lines to 88%, and Principal Review F4/F7 remediation took functions to 85%. Branches have stayed at 75%. See [`../architecture/webview-dead-surface-removal.md`](../architecture/webview-dead-surface-removal.md) for the 2026-08-29 deletion that set the row before the 2026-09-03 one.

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

## Lazy-route teardown stabilization (`FR-R8-04` `04-06`)

In addition to awaiting lazy route landmarks in `App.nav.test.ts`, `RouteOutlet.svelte` now resolves its internal expiry race with `ROUTE_LOAD_CANCELLED` inside its `$effect` cleanup, `route-loader.ts` tracks in-flight lazy imports (`whenSettled()` / `dispose()`), and `App.svelte` cancels pending focus/scroll animation loops and calls `loader.dispose()` on unmount. This removes the dangling timer/microtask teardown window when a component unmounts mid-import.

## Conditional skip inventory (`FR-R8-04` `04-06`)

Unconditional `describe.skip` suites are forbidden by `tests/lint/no-unconditional-describe-skip.test.ts` (zero unconditional skips exist across `tests/` and `webview-ui/src/`). Every skipped test observed in a macOS local `npm run gate` run (`14` skipped across `5` files out of `24,210+` host tests) is an explicit environment guard:

| Guard Condition | Affected Suites | Reason |
|---|---|---|
| `process.platform === 'win32'` / `!IS_WINDOWS` | `tests/unit/platform/windows-*.test.ts` | Windows-only reparse-point, CWD executable, and sentinel tests skip on darwin/linux; conversely POSIX permission/symlink/signal tests skip on `win32`. |
| `!IS_LINUX` | `tests/unit/platform/linux-case-sensitivity.test.ts` | Linux-only case-sensitivity filesystem checks skip on macOS/Windows. |
| `process.getuid() === 0` (`isRoot`) | `tests/unit/audit/audit-append-*.test.ts`, `evidence-delete.test.ts`, `failure-record-store.test.ts` | `chmod 0o500` permission-refusal tests cannot fail under root uid `0`. |
| `!envelopePresent()` / `!HAS_SPECS_ENVELOPE` | Envelope governance lint tests (`agents-claude-parity`, `spec-traceability-governance`, etc.) | Skipped only in standalone `repo/` checkouts without the planning envelope; execute in full inside a paired checkout. |
| `!ENABLED` (`SCHEGENT_MATRIX_C_REAL_CLI`) | `tests/integration/matrix-c-real-cli.test.ts` | Paid live-CLI matrix is opt-in and never executed during offline local gates. |
| `!hasLocalAgy` / `!hasBuiltBridge` / `existsSync(BUNDLE_HTML)` | `profiles-and-bridges.test.ts`, `csp-end-to-end.test.ts`, `bundle-size.test.ts` | Require optional local `agy` binary or built `dist/` artifacts (`build:webview` and `build:host` run before every bridge-consuming suite across `verify:edit`, `verify:all`, `verify:release`, `ci`, `ci:fast`, and `npm test`, and packaged bridge tests verify the built bundle SHA-256 against `dist/module-graph/host.json`). |

## Focused regression commands and fixture requirements (`FR-R8-04` `04-06`)

| Verification Tier | Command (run inside `repo/`) | Fixtures / Prerequisites |
|---|---|---|
| **Round 8 defect reproducers** | `npx vitest run tests/integration/round8-defect-reproducers.test.ts` | Self-contained disposable temp dirs and SQLite stores (`node:sqlite`); no network or paid CLI. |
| **Workflow capability effects & desktop composition types** | `npx vitest run tests/integration/workflow-capability-effects.test.ts tests/unit/services/workflow-execution/production-workflow-composition-types.test.ts` | Disposable SQLite WAL stores; `npm run typecheck:tests` verifies `@ts-expect-error` assertions. |
| **Dependency acyclicity & layer direction** | `npx vitest run tests/lint/import-graph-acyclic.test.ts tests/lint/layer-dependency-direction.test.ts tests/lint/dependency-direction.test.ts` | Hermetic AST scan over `src/` and `webview-ui/src/`. |
| **Boundary compatibility & extension seams** | `npx vitest run tests/integration/boundary-compatibility-matrix.test.ts tests/integration/extension-point-exercise.test.ts` | Disposable SQLite stores and in-test fixtures under `tests/`. |
| **Packaged ACP bridge E2E** | `npm run build && npm run test:e2e` | Built `dist/acp-stdio-bridge.js` and fake deterministic CLI fixtures (no paid provider). |
| **Webview navigation & teardown stress** | `npm --prefix webview-ui run test:coverage` | Locked `webview-ui/node_modules` install. |
| **Full clean-tree candidate gate** | `npm run gate:record` | Clean git tree, both locked `node_modules` trees, Playwright Chromium, and VS Code test binary cache. |

<!-- Source: package.json -->
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: vitest.config.ts -->
<!-- Source: vitest.evals.config.ts -->
<!-- Source: vitest.perf.config.ts -->
<!-- Source: vitest.e2e.config.ts -->
