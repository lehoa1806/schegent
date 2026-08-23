# Coverage measurements and gates

This page records the coverage sets, floors, and commands currently encoded in the repository. Percentages are measurements captured in configuration comments, not promises about a future checkout; rerun the commands before using them to judge a new change.

## Host coverage

Run from the repository root:

```bash
npm run test:coverage
```

The command runs the default Vitest suite with V8 coverage. The measured set is `src/**/*.ts`, excluding only `src/ui/sidebar/messages.ts`. Reports are written to `coverage/` in text, JSON, HTML, and LCOV forms.

| Metric | Enforced floor | Recorded 2026-08-22 measurement |
|---|---:|---:|
| Statements | 80% | 89.64% (`38,720 / 43,192`) |
| Branches | 75% | 88.11% (`13,088 / 14,854`) |
| Functions | 80% | 91.65% (`2,437 / 2,659`) |
| Lines | 80% | 89.64% |

The recorded host run measured 411 files with `src/extension.ts` included. The configuration warns that V8 branch attribution moved by 0.02 percentage points across runs, so floors are intentionally below the observed snapshot rather than pinned to it.

<!-- Source: package.json -->
<!-- Source: vitest.config.ts -->

## Webview coverage

Run from the repository root:

```bash
npm run test:webview:coverage
```

The webview command first checks generated queue-projection mocks, then runs Vitest with V8 coverage, and finally runs the coverage-headroom ratchet. It measures shipping `webview-ui/src/**/*.ts` and `webview-ui/src/**/*.svelte`, excluding test files and `__tests__` fixtures. Reports are written to `webview-ui/coverage/`.

| Metric | Enforced floor | Recorded 2026-08-22 measurement |
|---|---:|---:|
| Statements | 79% | 84.97% (`12,466 / 14,671`) |
| Branches | 74% | 79.60% (`4,747 / 5,963`) |
| Functions | 76% | 81.06% (`865 / 1,067`) |
| Lines | 79% | 84.97% |

The recorded webview run instrumented 189 source files: 107 Svelte files and 82 non-test TypeScript files. Unimported shipping components remain in the measured set and therefore count as zero rather than disappearing from the denominator.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/vitest.config.ts -->

## Headroom ratchet

`scripts/check-coverage-headroom.mjs` reads `webview-ui/coverage/coverage-final.json` after a coverage run. For statements, branches, functions, and lines, it computes an intended floor of `floor(measured) - 5`. A configured floor may lag that intended value by at most one point; a larger gap fails and asks the maintainer to raise the floor.

The ratchet never edits configuration. Lowering a floor remains a deliberate code change, while rising coverage must eventually be banked in `webview-ui/vitest.config.ts`.

<!-- Source: scripts/check-coverage-headroom.mjs -->
<!-- Source: webview-ui/vitest.config.ts -->

## Where coverage runs

`npm run verify:all` includes the default host tests and webview coverage. The main CI workflow also runs the host `test:coverage` target on Linux. Evaluation, performance, browser-visual, E2E, and Extension Host integration suites are separate targets; their presence in CI does not add their execution to the V8 coverage sets above.

<!-- Source: package.json -->
<!-- Source: .github/workflows/ci.yml -->
<!-- Source: vitest.config.ts -->
<!-- Source: vitest.evals.config.ts -->
<!-- Source: vitest.perf.config.ts -->
<!-- Source: vitest.e2e.config.ts -->
