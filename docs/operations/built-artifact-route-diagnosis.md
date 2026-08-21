# Built-artifact route diagnosis

**Status**: mechanism identified, both documented hypotheses refuted
**Opened**: 2026-08-21
**Source finding**: `FR-R3-021` (built-artifact route integrity)

## What was observed

`npm run test:visual` failed on one test: the mobile-viewport route walk in
`tests/visual/webview.visual.spec.ts`. Activating the `history` route left
the `dashboard-route-loading` branch in the DOM until the locator timed out.
`dashboard-route-error` never appeared, and neither did the History surface.

The failure was reported as a locator timeout. That report named the symptom
and nothing else, which is why two mutually exclusive hypotheses survived in
the source document for as long as they did.

## The measurements

All four measurements below come from one instrumented Playwright run against
the built bundle, driving the same interaction the failing test performs.

### Chunk delivery

| Requested | Status |
|---|---|
| 6 JavaScript chunks | all `200` |
| 3 CSS files | all `200` |

No request failed, was aborted, or hung. The route's own chunk
(`chunks/HistoryDashboard.js`) was fetched and served.

### Direct import probe

Evaluated in the page, after the failure, against the same module specifier
the loader uses:

```
{ ok: true, keys: "default", ms: 0 }
```

The module was already resolved and cached by the browser. A bare
`import('/chunks/HistoryDashboard.js')` settled in 0 ms with its `default`
export present.

### Render-branch census

At the point the test would have timed out:

| Branch | Count |
|---|---|
| `dashboard-route-loading` | 1 |
| `dashboard-route-error` | 0 |
| History mount target | 0 |

### The uncaught error and its stack

```
TypeError: Cannot read properties of undefined (reading 'localeCompare')
  at zt   (byLabel)
  at Array.sort
  at Pe   (optionsFrom)
  at Yt   (historyFilterOptions)
  at get options
```

Read through the minified names, that is `byLabel` in
`webview-ui/src/lib/history-filters.ts:280`, reached from `Array.sort` inside
`optionsFrom`, reached from `historyFilterOptions`, reached from a `$derived`
read during the surface's first render.

## Which hypothesis the evidence supports: neither

### H1 — "the first lazy chunk load in the page never settles" — refuted

Refuted by two independent observations, not by absence of evidence:

- every chunk request returned `200`, so nothing was pending on the network;
- a bare `import()` of the same specifier resolved in 0 ms with `default`
  present, so the module graph had already evaluated successfully.

A load that never settles cannot produce either result.

### H2 — "a preload/navigate race drops the assignment" — refuted

Refuted by a causal second pass in the same run: the identical
`pointerenter`-then-`click` interleave, under the same `hasTouch` and viewport
options, against the same build, **mounts successfully** once the fixture
carries `queueId`. One field distinguishes the failing pass from the passing
one. The interleave is not the variable.

### The third mechanism, which neither hypothesis covered

A **synchronous throw during mount**, invisible to the loader promise.

The sequence:

1. The dynamic import resolves. The `.then` handler runs and assigns
   `ActiveRouteComponent`.
2. Svelte enters the `{:else if ActiveRouteComponent}` branch and begins
   mounting the surface.
3. A `$derived` read reaches `byLabel`, which throws.
4. Svelte abandons the render. The DOM is left as it was — showing the
   loading branch that had been rendered while the import was in flight.
5. `routeLoadError` is never assigned, because a mount throw is not a promise
   rejection. `.catch()` is never reached.

The route outlet has four branches: `operations`, a mounted component, an
error, and loading. **None of them represents "loaded, then threw."** The
loading branch is not a state the loader is still in; it is the last state
anything successfully rendered.

## Correction to the source document, §2.2

The source document states that "neither handler ran." That does not follow
from the evidence it cites.

The `.then` handler **did** run and **did** assign `ActiveRouteComponent`. The
inference was drawn from an accessibility snapshot showing the loading branch
still present — but the fourth branch can be present without the state that
names it, precisely because a mount throw leaves the previous render in place
without touching either promise handler. Observing the loading branch says
nothing about whether the handlers ran.

This distinction is what makes the fix a different fix. Had "neither handler
ran" been true, the loader was at fault. It was not; the loader worked, and
the failure was in what the route outlet is able to display.

## The trigger: fixture drift

The throw is reachable only from a malformed snapshot. Typing
`tests/visual/fixtures/workflow-snapshot.json` against the host producer type
in `src/ui/sidebar/snapshot.ts` surfaces three drifts:

| Site | Missing | Effect |
|---|---|---|
| `history[0]` | `queueId` | **crashes the History route** |
| `queue.inFlight` | `liveness`, `progress` | latent |
| `generalSettings.scopes` | `retryForceContinueOnCap`, `codexPath`, `agyPath`, `rawTranscriptMode` | latent |

The crashing path: with `queueId` absent, `labelFor(queueId, names)` in
`history-rows.ts` returns `undefined`, `queues.set(undefined, undefined)`
stores an entry with an undefined label, and `byLabel` reads `.localeCompare`
off it inside `Array.sort`.

**No host can emit such an entry.** `queueId` is not a stored field —
`KEYS.history` is keyed by queue, `HistoryRecord` is
`HistoryEntry & { readonly queueId: string }`, and `ensureHistoryEntry(raw,
queueId)` stamps it from the partition key its caller already holds. The
malformed input exists only in a hand-maintained test fixture that drifted
away from the type it stands in for. That is why the fix repairs the fixture
and the *presentation* of a mount crash, and does not harden the History data
path: there is no operator path to the crash. Malformed-input hardening
belongs to `FR-R3-028`.

### This has happened before

The same cause — a fixture drifting from a contract that tightened around it —
already bit this repository once, on `fixtures/metrics-response.json`. Making
`cumulative` and `coverage` required invalidated the fixture,
`isValidReadMetricsResponse` rejected it, `fetchMetrics()` returned early, and
the dashboard rendered an empty table that a pixel diff would have adopted as
the new baseline. `SURFACE_CONTRACTS` was added to close that hole for five
surfaces. The cause reappeared on a sixth path with a different presentation,
which is the argument for stopping the fixture from drifting at all rather
than enumerating the ways a drifted fixture can present.

## Code-splitting baseline

Measured from `dist/webview/chunks/` on the unmodified tree, before any change
in this feature:

**19 lazily-loaded chunks.**

Recorded because it has to be captured before the change to be worth anything.
Note that the source document asserts sixteen. Sixteen is not this build's
count and no observation in the source document substantiates it, so a
criterion of "at least sixteen" would have been satisfied by a build that had
silently lost three chunks. The criterion is the measured number, compared
against itself after the change.

## Pre-fix run of the new assertions

Run against the unmodified loader and the unrepaired fixture, before Phase 3 or
Phase 4 of this feature landed.

### The route walk

Failed, as required, and failed with the cause rather than the symptom:

```
history: the page reported an error
  Expected: []
  Received: ["pageerror: TypeError: Cannot read properties of undefined (reading 'localeCompare')"]
  at assertNoPageErrors (tests/visual/webview.visual.spec.ts)
  at assertRouteMounted (tests/visual/webview.visual.spec.ts)
```

Compare the report this replaces, which named a testid that never appeared and
gave no reason. The error-channel check runs before the visibility check, so the
`TypeError` wins the race against the locator's clock instead of losing it.

### The previously-uncovered route

`runs` is walked before `history`, and it passed every assertion in the walk —
mount target visible, one `main` landmark, no page-level horizontal overflow, no
undersized coarse-pointer control, no unnamed form control. Uncovered since
Feature 091 shipped it, and correct all along; the point is that nothing knew
that until the walk named it.

### The route-coverage gate

Observed failing on the real files, not only on synthetic input. Removing
`runs: 'runs-surface'` from `ROUTE_MOUNT_TARGETS`:

```
these DASHBOARD_ROUTES entries are never activated by the browser suite, so
nothing would notice if their surfaces stopped mounting: expected [ 'runs' ] to
deeply equal []
```

Restored, the gate is green at 11/11. The gate also carries its own fault
injection — a route with no target, a target for a retired route, and three
unparseable-source cases — so the verdicts stay observed in both directions after
the tree is correct and the real-file injection is no longer available.

The gate's first run found a defect in itself worth recording: it located
`DASHBOARD_ROUTES` and then took the first `[` after the identifier, which
belongs to the type annotation `readonly DashboardRoute[]`. Those brackets
balance immediately, the body parsed empty, and the gate reported all seven
routes as stale — the same output it should produce for a genuinely stale list.
The empty-parse check is what distinguished the two, and is the reason FR-024a
requires an unparseable list to fail rather than pass.

## The fixture repair, in isolation

Run after the fixture became a typed module and before any change to the route
loader, so every result below is attributable to the fixture alone.

### The count of drifts was wrong, and could not have been right

The source document records three drifts. Typing the fixture against the host
producer found **sixteen missing fields across five sites**, plus one field the
host emits that its own interface never declared.

| Site | Missing | Found on run |
|---|---|---|
| `queues[0].inFlightRun` | `liveness`, `progress` | 1 |
| `history[0]` | `queueId` | 1 |
| `generalSettings.scopes` | `retryForceContinueOnCap`, `codexPath`, `agyPath`, `rawTranscriptMode` | 1 |
| root | `configuredModels`, `backendPingState`, `sessionArtifacts`, `evidenceHealth` | 2 |
| `generalSettings` | `claudeAutoCompactPctOverride`, `retryForceContinueOnCap`, `codexPath`, `agyPath`, `rawTranscriptMode` | 3 |

The right-hand column is the finding. **The compiler enumerates drift
incrementally**: a mismatch at one depth masks mismatches at another, so each
repair reveals the next. It took three runs to reach a fixed point, and a fourth
to surface the excess-property case below. Any count taken from a single run is
a lower bound presented as a total — which is exactly how "three" became
authoritative, and the reason SC-006 asks for an observed failure rather than a
number.

Two of the recorded three were also misplaced. `queue.inFlight` carries a queue
*item* projection with no run-level fields at all; the site is
`queues[0].inFlightRun`. Naming the wrong site is a small error with a large
consequence — it is the difference between a repair the compiler confirms and a
repair that appears to have been made.

### A field the producer emits and its own type does not declare

`confirmationsEnabled` failed as an excess property: the fixture carried it, the
webview mirror declared it, and the host's `WorkflowSnapshot` did not — while
`snapshot-composer.ts:304` has emitted it since feature 063.

It survived four features because of how it is emitted. A conditional spread —
`...(confirmationsEnabled !== undefined ? { confirmationsEnabled } : {})` — is
not a fresh object literal, and excess-property checking only reaches those. The
producer could publish a field its published type omitted, and no gate on either
side of the boundary was positioned to notice: the host type was the one artifact
that disagreed, and nothing compared it to the composer's actual output.

The fix is one optional field on the host interface, matching what the composer
already emits and what the mirror already declares. `SCHEMA_VERSION` does not
move; the field was always on the wire.

The composer's five other conditional spreads (`launchables`, `phaseCatalog`,
`pipelineCatalog`, `workflowCatalog`, `connectedRuns`, `confirmSuppression`) were
checked against the interface and all are declared. This was the only one.

### The check can fail, three ways

Injected against the repaired fixture, one at a time, each reverted after:

| Injection | Reported |
|---|---|
| remove `history[0].queueId` | `TS2741: Property 'queueId' is missing … but required in type 'HistoryEntry'` |
| add `phasePrecedence: {}` | `TS2353: Object literal may only specify known properties, and '"phasePrecedence"' does not exist in type 'WorkflowSnapshot'` |
| misspell `lifecycle: 'runnning'` | `TS2820: Type '"runnning"' is not assignable to type 'QueueLifecycle'. Did you mean '"running"'?` |

The third is why `as const` is load-bearing rather than decorative. A JSON module
import widens `lifecycle` to `string`, and a widened union accepts the typo
silently; `as const` cannot be applied to an imported binding, so an inline
literal is the only form of this fixture a compiler can adjudicate. The fixture
contains exactly one type assertion — that `as const` — and no cast, no `any`,
and no suppression comment.

### The causal test

With the fixture repaired and **nothing else changed** — same loader, same build,
same `pointerenter`-then-`click` interleave, same viewport and `hasTouch`
options — the route walk passes all seven routes, `history` included. One field
separates the failing run from the passing one. That closes H2 and confirms the
mechanism: the mount threw, and the throw was reachable only from a malformed
snapshot.

### No screenshot baseline changed, and that is a finding too

All fifteen screenshot tests passed against their existing baselines. No
baseline was updated, and none needed to be.

That is not because sixteen new fields render as nothing. It is because
`liveness` and `progress` are read in exactly one place — `RunDetailTier.svelte`,
the drilldown — and the four new root blocks render on the System, Settings, and
Models surfaces. **None of those is photographed.** The five screenshot surfaces
are `sidebar`, `queues`, `builder`, `metrics`, and `activity-feed`, and the
`queues` surface photographs the queue tier, not the drilldown beneath it.

So the repair is invisible to the pixel suite by construction. FR-017's
inspection came back empty because there was nothing to inspect — not because an
unexamined update absorbed a change. The two readings the drilldown would now
show (`2 of 7 phases (29%)`, and a last-activity stamp) are rendered by no test
that photographs or asserts them. That gap is named here and left alone: it is
coverage breadth, which belongs to `FR-R3-027`, not to this item.

### Code splitting, after the fixture change

**19 lazily-loaded chunks** — unchanged from the pre-change baseline, as expected
for a change that touched no webview source. Recorded because the comparison
SC-012 asks for is only meaningful if it is taken at both ends.

## Post-fix run of the new assertions

Run against the loader and boundary this feature added, on a freshly built
`dist/webview`. The visual suite runs the artifact, so every measurement below
was taken after `build:webview`, not after an edit to source.

### The route walk

Green on all seven routes. That is the same verdict the fixture repair already
produced, and on its own it says little — the repair had closed the only failure
the walk knew about. What it says here is that the boundary, the loader, and the
extracted markup did not reintroduce one.

Except that on their first run, they had.

### The defect the walk found in this feature's own change

The walk failed once after Phase 4 landed, with:

```
route mount failed route=metrics message=Cannot read properties of undefined (reading 'history')
```

Two things in that line are worth separating.

**The message was real; the label was a misattribution.** `MetricsDashboard.js`
contains no read of `.history`, so the route named in the diagnostic could not be
the route that threw. A stack-logging probe placed the throw inside
`chunks/HistoryDashboard.js`. The cause is that `reportMountFailure` reads the
live `route` when it formats the message, and by the time the boundary catches,
`route` has already moved on. The diagnostic names *where navigation is*, not
*what failed*. That is a real weakness and it is left in place, named here,
rather than papered over: the label is still the fastest thing an operator has,
and it is correct in the common case where a route fails on arrival.

**The failure was torn state.** The markup selected props by `route` while taking
the component from a separate signal. `route` changes on the nav click; the
loader effect clears the mounted component a flush later. In that window the two
disagree, and the branch rendered the *previous* route's component with the
*next* route's props — History with `active={true}` and no `snapshot`, which
threw inside History's `$derived`. The fix pairs them into one `MountedRoute`
value and reads `mounted.route` in every branch, because one value cannot
disagree with itself.

This is exactly the class of defect the feature exists to eliminate, introduced
by the feature. It is recorded rather than quietly fixed because the reason it
reached the browser suite is the more useful finding: **the jsdom suite could not
see it.** Every test there arrives at one route and stays. The defect lives in
the transition. The gap was closed by asserting that navigating *away* from a
route does not re-create it — a branch change destroys and re-creates the
subtree, so the tear shows up as a mount count going 1 → 2 — and the assertion
was then proven by restoring the defective markup (`expected 2 to be 1`).

### Retry recovers a failed mount and cannot recover a failed load

Both halves measured in the browser, counting requests to
`/chunks/HistoryDashboard.js`.

A **mount** failure, provoked by publishing a snapshot with `history[0].queueId`
absent: the error branch renders with `role=alert`, exactly one chunk request has
gone out, and Retry re-mounts — second mount diagnostic, still one chunk request.
Recovery comes from the already-loaded module, which is what the design intends.

A **load** rejection, provoked by aborting the chunk request at the network: the
error branch renders. Lift the abort, press Retry, wait two seconds — a fixed
wait, because `expect.poll` returns on its first look and so cannot prove an
absence — and the count is *still one*. No second request is ever issued.

Two caches sit between a dynamic `import()` and the network, and application code
owns neither. The ES module map records the failed fetch and rejects subsequent
`import()` of the same specifier without going out; Vite's `__vitePreload` keeps
its own set of handled deps. Escaping both requires a fresh specifier — a
cache-busting query — which forfeits the static analysis Vite splits chunks by,
and with it FR-013/SC-012.

So the cache eviction on failure is necessary but not sufficient: it is correct
at the layer it governs, and a rejected chunk load stays rejected until the
webview reloads. SC-009b originally claimed Retry would be "observed
re-fetching". The assertion written to hold that claim disproved it. The
criterion now records the measurement, and the test asserts the measured
outcome plus a control — an unpoisoned route still loads and requests its chunk
once, so what is broken is one module and not the loader.

### The assertions can fail

Three mutations against the built artifact, each rebuilt into `dist/webview`
before the run because the suite reads the artifact: the `onerror` handler
removed, mount-failure Retry made inert, and the rejection branch made to render
nothing. All three were caught. Ten mutations against the jsdom suite, all
caught. And the transition assertion above, caught by restoring the markup that
shipped.

### The same class of defect, one layer down, in a fenced file

The new jsdom suite builds its snapshot by copying the builder out of
`App.nav.test.ts`, cast and all. Dropping that cast — `as unknown as
WorkflowSnapshot` — made the typechecker say what it had been silenced about:
`availableModels` was an array where the interface declares
`Record<BackendRunnerKind, readonly string[]>`, and `availableBackends` was
absent entirely. The new copy is corrected and now carries no cast; the builder is
annotated, so it is checked against the interface rather than asserted into it.

`App.nav.test.ts` still carries the uncorrected version, and is left exactly as
it was. FR-028 fences it because it is the pre-existing coverage this feature must
not be able to rewrite to suit itself, and that fence is worth more than the
tidy-up. Its nine assertions include `as unknown as unknown as
WorkflowSnapshot` — a double assertion through `unknown`, which no amount of type
drift can ever fail.

Recorded because it is the same shape as the defect this feature was opened for:
a fixture claiming a type it did not have, with the check that would have caught
it turned off at the call site. The visual fixture was one instance. This is
another, in the test suite rather than the fixtures, and it is not this item's to
fix.

### Code splitting, after the loader change

**19 lazily-loaded chunks** — unchanged from the pre-change baseline. The route
modules are still reached by a statically analysable `import()` per route, which
is the property the count is standing in for.
