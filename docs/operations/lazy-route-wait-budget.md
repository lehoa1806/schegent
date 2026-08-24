# Lazy-route wait budget — the sweep, and what was observed

FR-R3-068. Two assertions in `webview-ui/src/dashboard/__tests__/App.nav.test.ts` waited on a lazily
imported route component with no explicit timeout, so vitest's 1000 ms default applied — and under load that
default was a coin flip.

**The measurement that chose the budget lives beside the constant**, in the comment on
`LAZY_ROUTE_WAIT_MS` in that test file. It is not repeated here: two copies of a measurement is how
measurements drift, which is the defect `FR-R3-067` spent a cycle removing immediately before this item.
This page records the *sweep* and the *observations*, which is different work.

## The sweep

**2026-08-24.** 43 `waitFor` calls in `webview-ui/src`, **none** carrying an explicit timeout before this
change.

**The classification rule**: does the awaited thing arrive through a dynamic `import()` that is **not
mocked**? Only then does the wait carry a first-time transform, which is the cost this item is about. A wait
on a spy, or on text inside an already-mounted component, is a different thing and is not covered by a
timeout sized for a transform.

| Group | Count | Disposition |
|---|---|---|
| `App.nav.test.ts` — the history and runs route waits | 2 | **FIXED.** This file mocks only `lib/vscode-api`, verified, so both route imports resolve for real |
| `App.route-loading.test.ts` | 13 | **JUDGED SAFE**, and for two reasons together rather than the one it is tempting to write down. It `vi.mock`s five of the six lazy route components — `HistoryDashboard`, `MetricsDashboard`, `SystemTab`, `PipelineBuilder`, `SettingsSurface` (plus the eagerly-rendered `OperationsSurface`) — so those resolve from vitest's registry, and each mock factory substitutes a 9-to-25-line ledger fixture whose own transform is negligible. It does **not** mock `RunsSurface.svelte`, the 293-line component this item measured at its worst; that is safe only because the file never navigates to the `runs` route at all — no `runs` occurrence in it. Both halves are load-bearing: verified by reading its mock list and its route coverage, not assumed from its filename |
| drilldown, settings, history, builder and modal suites | 28 | **OUT OF SCOPE.** Waits on spies being called or on text appearing in a mounted component; no dynamic import involved |

**And the token was not the rule.** The enumeration above greps `waitFor(`; the rule it declares is the
*mechanism*. The other family carrying an implicit 1000 ms budget is testing-library's `findBy*`, whose
`asyncUtilTimeout` defaults to 1000 ms in `@testing-library/dom` and is never `configure()`d in this
workspace — **28 call sites** in `webview-ui/src`, none with an explicit timeout. Twenty-seven await
something inside a statically imported component. **One does not**: `awaitTier` in
`src/components/__tests__/OperationsSurface.test.ts` awaits `queue-detail-tier` and `run-detail-tier`, which
arrive through the `import()` calls in `OperationsSurface.svelte` — the second lazy-import site in this
webview and the only one outside `route-loader.ts`, neither of them mocked there. It does not flake because
that file pre-warms both modules in a `beforeAll`, whose comment names this exact race. That is a different
answer to the same question, and a defensible one: its assertions are about the `{#await}` transition, not
about the cold import, so warming the transform costs it nothing — which is precisely why the same move is
refused below, where the cold import *is* the subject. Recorded so the next sweep starts from the mechanism
rather than from the token, and so the two files' divergence is a decision on the page instead of a
discrepancy to rediscover.

The 13 safe ones are the interesting entry. That file's whole subject is lazy route loading, so a sweep that
classified by *topic* would have flagged them all; classifying by *mechanism* shows they carry none of the
cost. Recorded because the distinction is what makes the boundary auditable.

**And recorded with its gap named**, because "that file mocks every route component" is the shorter sentence
and it is false. The unmocked one is `RunsSurface`, the most expensive component here. A contributor who
adds a `runs` case to that file — the obvious place to add one — inherits the real transform and, reading
only the shorter sentence, would write the bare wait this item just removed. The disposition above therefore
states the route coverage as well as the mock list, so the next person sees which half is doing the work.

## Observed: it still detects a real regression

**2026-08-24, darwin/arm64.** Both lazy imports in `route-loader.ts` were replaced with
`Promise.reject(...)`, then restored (`git diff` on that path empty afterwards).

| | Result |
|---|---|
| Both assertions | **failed** — 2 failed / 7 passed |
| Elapsed, per assertion | **3015 ms** and **3008 ms** |
| Failure shape | `vi.waitFor.timeout` carrying the original assertion, `expected null not to be null` |

The elapsed times are the point. They land at the **wait budget**, not at the 5000 ms per-test timeout — so
a broken import produces a diagnosable wait failure that names the assertion, rather than a bare "test timed
out". A budget set near the per-test ceiling would never have fired, and this is why the budget's upper bound
was measured as well as its lower one.

## Observed: the flake is gone

**2026-08-24, darwin/arm64.** `App.nav.test.ts` run **8 times**, with the Vite cache cleared before every
run, while the host suite, a full build and the performance suite ran concurrently — the same load under
which the transform was measured overshooting.

**8 passed, 0 failed.**

For contrast, the recorded measurement beside `LAZY_ROUTE_WAIT_MS` shows the loaded transform distribution
straddling the old default and sitting entirely below the new budget. The old default was not marginally too
small; it was inside the distribution. The figures are not repeated here — see that comment, which is the
one place they live.

## Observed: the bounds gate is non-vacuous

**2026-08-24, darwin/arm64.** Command in every case:
`npx vitest run src/dashboard/__tests__/App.nav.test.ts` from `webview-ui/`. Each seed reverted.

| Seed | Result |
|---|---|
| `{ timeout: 2000 }` on the runs-route test | **red** — "must stay well under the 2000 ms per-test timeout in force for \"loads its surface on demand when the route is opened\" … expected 3000 to be less than 1400". A bounds test reading its *own* task stayed green on this seed, which is why it does not |
| the runs-route test renamed | **red** — the stale-name assertion, not the comparison: "both tests this budget governs must still be present under these names, or the bounds below are checked against nothing" |
| `--retry=1` | **red**, naming the governed test whose retry count arrived from the command line |

Unseeded: **9 passed**.

## Observed: the full chain

**2026-08-24.** `npm run verify:all` — **exit 0**, with the host suite running immediately before the
webview leg, which is the ordering that produced the original reproduction.

## What was deliberately not done

- **No retry.** A retried flake is a flake with worse diagnostics, and it would let a genuine intermittent
  route-load failure through — which is the class `REL-N1` was. Asserted rather than only stated: the
  budget's bounds test reads the retry count in force from each of the two tests it governs and requires
  zero, so a `retry` arriving from the config, from `--retry` on the command line, or from an `it`/`describe`
  option on either test turns the suite red instead of quietly masking what this budget was measured to
  remove.
- **No skip, no selector loosened, no assertion removed.** The diff changes the wait budget and nothing else.
- **No pre-warming of the transform.** Hoisting the import into a setup hook would make the budget small and
  meaningless: the cold-import path is what these two assertions exercise.
- **The per-test timeout was not raised.** `webview-ui/vitest.config.ts` is unchanged. Raising it is the move
  the source item calls out as looking like a fix while changing nothing — `--testTimeout` does not govern
  `vi.waitFor`, which carries its own default. The upper bound is checked against the timeout *in force*,
  rather than against a restatement of vitest's default: a restated ceiling is a second number to maintain,
  and it would stay green while a lowered `testTimeout` slid underneath the budget and turned every
  broken-import failure back into a bare timeout. It reads that timeout from **the two tests it governs**,
  found by name in the collected suite tree, not from the bounds test's own task — a self-read sees a config
  or command-line `testTimeout` and nothing else, so an `it(name, { timeout }, fn)` or
  `describe(name, { timeout }, fn)` on either route test would have reinstated the bare timeout while the
  bound stayed green. A rename of either test fails the lookup rather than silently checking nothing.
- **Coverage was not moved.** `tests/visual/` remains the honest coverage for this behaviour, per
  `FR-R3-021`; this item does not shift responsibility onto the jsdom test.

## Known limits

- **One machine.** The margin exists because shared CI runners are slower than the machine measured here; it
  is not measured there. If the flake recurs on a runner, re-measurement is the next step, not a bigger
  number chosen by feel.
- **Sub-budget slowness is undetected.** A route that legitimately regressed to a couple of seconds would
  still pass. This budget catches a route that fails to load, not one that became slow. That is the price of
  not flaking under load, and it is stated so nobody has to rediscover it.
