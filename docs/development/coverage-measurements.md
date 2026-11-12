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

| Metric | Enforced floor | Recorded 2026-09-03 measurement |
|---|---:|---:|
| Statements | 84% | 89.13% (`14,809 / 16,615`) |
| Branches | 75% | 80.67% (`5,429 / 6,730`) |
| Functions | 77% | 82.87% (`953 / 1,150`) |
| Lines | 84% | 89.13% |

The recorded webview run instrumented 215 source files: 122 Svelte files and 93 non-test TypeScript files. Unimported shipping components remain in the measured set and therefore count as zero rather than disappearing from the denominator.

This row replaces the 2026-08-29 measurement rather than sitting beside it: this page states current enforced values, and the history is in git. All four floors are re-derived from the single post-`FR-R3-154` run, and the denominators are what make that necessary rather than tidy — 15,232 statements became 16,615 as features 189-193 added source, so a floor carried over from the earlier run would be pinned to a tree that no longer exists. The headroom ratchet had flagged statements and lines only; branches and functions are raised here from their own measured values, so no floor is inferred from another. See [`../architecture/webview-dead-surface-removal.md`](../architecture/webview-dead-surface-removal.md) for the 2026-08-29 deletion that set the previous row.

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
