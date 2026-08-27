# Verification tiers

**Added**: 2026-08-28 (`FR-R3-132`, T1503) · **Gate**: `repo/tests/lint/verification-tiers.test.ts`

Three commands, cheapest first. Each one runs everything the one before it runs, and the gate above
proves that as a set relation rather than trusting this page.

| Tier | Command | Roughly | Run it |
|---|---|---|---|
| Edit loop | `npm run verify:edit` | typechecks + both unit suites | after a small change, before you look away |
| Pre-push | `npm run verify:push` | the edit tier + lint, contracts, docs, security, licences | before the result matters to anyone else |
| Release | `npm run verify:release` | everything: coverage, evals, visual, a11y, perf, e2e, packaging, integration | before a release, and in CI |

## Why this exists

The full local gate is long, and a contributor facing a twenty-minute wait for a two-line change runs
it or skips it — mostly skips it. That is not a discipline problem; it is a missing tier. The audit of
2026-08-27 recommended the model and named the one caveat that makes it safe (below).

`ci:fast` was the evidence that somebody had already wanted this. Its name promises a fast loop and
its body runs the eval corpus, the visual suite, the perf suite, a host build and a VSIX smoke test.
`repo/tests/lint/lint-gates-are-hermetic.test.ts` had already recorded that the same script's
*description* drifted from what it runs. **`ci:fast` is not retired and it is not a tier**: it is the
CI-shaped route that skips the coverage instrumentation, and it is named here so nobody reaches for it
expecting the edit loop.

## What a tier is not

**A tier changes WHEN a gate runs. It never changes WHETHER a gate runs.** Every target named by a
lower tier is named by every higher one, and `verify:release` covers every leaf command the release
`gate` covers. `FR-R3-121`'s census of the governance surface found nothing retirable, and trading
visible friction for invisible regressions is the trade the audit warns against by name.

The gate compares **leaf commands**, not script names. A first draft compared names and failed:
`verify:release` does not invoke the name `ci` while running everything `ci` runs. A composite name is
a route to work; the set that matters is the work.

## No tier may reuse a build

This is the audit's one caching caveat and it is load-bearing. The strictness ratchets and the lint
baselines read **source**, so they cannot be stale. A build can: a tier that reused a previous `dist/`
would pass a gate against code that is no longer in the tree, and unlike a source-reading ratchet,
nothing about a stale artifact announces itself. No tier caches, and the gate refuses the flags that
would introduce one.

## What each tier establishes

### `verify:edit` — the change compiles and behaves

`typecheck`, `typecheck:webview`, `typecheck:tests`, `test:host`, `test:webview`.

**What this tier does NOT establish**: that the change is lint-clean, that the generated contracts
still match their sources, that the documentation links resolve, that no secret was committed, or
anything a browser must render. A green edit tier means *"I have not broken behaviour I can see"*. It
supports no claim outside your own working tree.

### `verify:push` — the change is fit for someone else to read

The edit tier, plus `lint`, `lint:webview`, `contracts:check`, `docs:check`, `security:secrets`,
`security:actions`, `license:check`.

**What this tier does NOT establish**: coverage thresholds, visual stability, accessibility, perf
budgets, packaging, or that the extension activates. A green push tier supports *"this is reviewable"*
— it does not support a release note, a performance claim, or an accessibility claim.

### `verify:release` — everything the release gate covers

The push tier, plus `build:webview`, `test:coverage`, `test:webview:coverage`, `test:evals`,
`test:visual`, `a11y`, `test:perf`, `test:e2e`, `build`, `package:smoke`, `test:integration`.

**What this tier does NOT establish**: conformance of any kind. A green a11y scan is not WCAG
conformance (see [`RELEASE.md`](../../RELEASE.md) and
[the AT matrix](../release/accessibility-at-matrix.md)), the perf figures support only the two claims
`RELEASE.md` bounds, and every platform except darwin/arm64 remains in the declared `unverified` tier
([platform observation record](../operations/platform-observation-record.md)).

## The successor to `verify:edit`, and what it needs

Selecting tests by changed file is the better edit loop, and it is deliberately not what this is.
There is no affected-test selector in `repo/`, git-based selection depends on which base ref exists
locally, and a selector that silently resolves to *nothing* is worse than a slow gate: it reports
green over an empty set, which is the vacuity failure this repository has a whole meta-gate family for.

What it would need, if someone takes it: a selector that **fails when it selects nothing**, a recorded
measurement of what it misses against the fixed subset, and a rule that `verify:push` never uses it.
Until then the fixed subset is honest about its coverage, which is the property that matters more than
its speed.
