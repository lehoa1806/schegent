# Verification tiers

**Added**: 2026-08-28 (`FR-R3-132`, T1503) · **Updated**: 2026-11-19 (`FR-R7-08`) · **Step list**: `repo/scripts/verification-steps.json` · **Generator**: `repo/scripts/generate-verification-scripts.mjs` · **Gate**: `repo/tests/lint/verification-tiers.test.ts`

Four commands, cheapest first. Each one runs everything the one before it runs, and `tests/lint/verification-tiers.test.ts` proves that independently as a set relation over `package.json` rather than trusting this page or sharing logic with the generator.

| Tier | Command | Roughly | Run it |
|---|---|---|---|
| Fast gates | `npm run test:gates` | lint, parity, and contract suites only (~27s) | after editing comments, docs, contracts, or lint rules |
| Edit loop | `npm run verify:edit` | fast gates + webview build + typechecks + both unit suites | after a small change, before you look away |
| Pre-push | `npm run verify:push` | the edit tier + lint, contracts, docs, security, licences | before the result matters to anyone else |
| Release | `npm run verify:release` | everything: coverage, evals, visual, a11y, perf, e2e, packaging, integration, and `verify:linux` | before a release |

## Single verification step list (`FR-R7-08`)

All seven aggregate scripts in `repo/package.json` (`verify:edit`, `verify:push`, `verify:release`, `verify:all`, `ci:fast`, `ci`, `gate`) are generated from one machine-readable step list: `repo/scripts/verification-steps.json`. Each step declares its `name`, `command`, `firstTier`, `requiresWebviewBuild`, and `category` (plus any runtime `precondition`).

- **Regenerate** after editing `scripts/verification-steps.json`: `node scripts/generate-verification-scripts.mjs` (rewrites only the seven generated aggregate entries in `package.json`).
- **Verify freshness**: `node scripts/generate-verification-scripts.mjs --check` (wired into `npm run docs:check`). Hand-editing any generated aggregate entry in `package.json` fails `--check`.
- **Independent proof**: `tests/lint/verification-tiers.test.ts` parses `package.json` directly and never reads `scripts/verification-steps.json` or `scripts/generate-verification-scripts.mjs`, so generator bugs cannot mask a missing lower-tier step.

### Measured `test:gates` duration and SC-002 transitive-target comparison (2026-11-19)

Measured on darwin/arm64 (Node `24.19.0`):

- `npm run test:gates` (`vitest run tests/lint tests/parity tests/contract`): **269 test files** (~27.0s vitest duration, 27.4s wall clock).
- `npm run test:host` (`vitest run`): **1,502 test files** (~180–240s wall clock).
- `tests/lint/test-gates-parity.test.ts` proves `test:gates` matches the exact lint, parity, and contract subset of `vitest.config.ts` and fails if a new gate directory is added without updating `test:gates`.

Transitive leaf-target comparison against the pre-`FR-R7-08` hand-maintained aggregates:

| Aggregate | Pre-FR-R7-08 leaves | Post-FR-R7-08 leaves | Deliberate delta and reason |
|---|---|---|---|
| `verify:edit` | 6 | 7 | `+test:gates` (lowest tier included in every higher tier so the subset proof holds) |
| `verify:push` | 13 | 14 | `+test:gates` (via `verify:edit`); `docs:check` also runs `generate-verification-scripts.mjs --check` |
| `verify:release` | 22 | 24 | `+test:gates` (via `verify:edit`) and `+verify:linux` (GC-18 local Linux container leg placed in the release tier) |
| `verify:all` | 13 | 13 | Exact match (0 leaf delta) |
| `ci:fast` | 17 | 17 | Exact match (0 leaf delta) |
| `ci` | 15 | 15 | Exact match (0 leaf delta) |
| `gate` | 20 | 20 | Exact match (0 leaf delta; `docs:check` now includes `--check`) |

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

### `test:gates` — structural, parity, and contract invariants hold

`vitest run tests/lint tests/parity tests/contract` (explicit path arguments checked against `vitest.config.ts` by `tests/lint/test-gates-parity.test.ts`).

**What this tier does NOT establish**: that the TypeScript compiler accepts the tree, that the webview builds, that unit or integration behaviour tests pass, that ESLint is clean, or anything requiring a browser or container runtime. A green `test:gates` run means *"none of the structural, parity, or contract gates broke"* — and because the LoC budget gates measure lexical code lines (`tests/lint/code-lines.ts`), adding explanatory comments or blank lines never trips them.

### `verify:edit` — the change compiles and behaves

`test:gates`, `build:webview`, `typecheck`, `typecheck:webview`, `typecheck:tests`, `test:host`, `test:webview`.

**What this tier does NOT establish**: that the change is lint-clean, that the generated contracts
still match their sources, that the documentation links name files that exist and that the sections
live documents name in other files exist ([what that check reads](section-reference-check.md)), that
no secret was committed, or
anything a browser must render. A green edit tier means *"I have not broken behaviour I can see"*. It
supports no claim outside your own working tree.

### `verify:push` — the change is fit for someone else to read

The edit tier, plus `lint`, `lint:webview`, `contracts:check`, `docs:check`, `security:secrets`,
`security:actions`, `license:check`.

**What this tier does NOT establish**: coverage thresholds, visual stability, accessibility, perf
budgets, packaging, or that the extension activates. A green push tier supports *"this is reviewable"*
— it does not support a release note, a performance claim, or an accessibility claim.

### `verify:release` — everything the release gate covers, plus the local Linux leg

The push tier, plus `build:webview`, `test:coverage`, `coverage:headroom`, `test:webview:coverage`, `test:evals`, `test:visual`, `a11y`, `test:perf`, `test:e2e`, `build`, `package:smoke`, `test:integration`, `verify:linux`.

**What this tier does NOT establish**: conformance of any kind. A green a11y scan is not WCAG
conformance (see [`RELEASE.md`](../../RELEASE.md) and
[the AT matrix](../release/accessibility-at-matrix.md)), the perf figures support only the two claims
`RELEASE.md` bounds, and every platform except darwin/arm64 remains in the declared `unverified` tier
([platform observation record](../operations/platform-observation-record.md)).

## `verify:linux` is a release-tier platform step, not a standalone tier

Added 2026-11-12 (review gap GC-18) and placed in `scripts/verification-steps.json` at tier `release`
on 2026-11-19 (`FR-R7-08`). `npm run verify:linux` runs the install, the build, the SBOM,
both typechecks, lint, `contracts:check` and `test:host` in a Linux container
(`scripts/linux-leg/Dockerfile`) against a commit, `HEAD` by default, piped in with `git archive`. The
script refuses to run while its own files (`scripts/linux-leg.sh`, `scripts/linux-leg/`) differ from
`HEAD`, so neither the tree under test nor the harness can carry uncommitted work. It needs a running Docker daemon — on a machine without one, it fails immediately with `linux-leg: no Docker daemon answered; start Docker (or OrbStack) and run again.` It is the operator's local
replacement for the hosted Linux leg that `FR-R3-099` retired.

It is a step of `verify:release` rather than a tier between `verify:push` and `verify:release`, because
on its own it is not a superset of `verify:push`: it skips the docs, security and licence checks and
every webview check, and runs part of the release gate on another platform instead. It establishes the
unit tier on Linux and nothing more: no extension host, browser or real CLI runs in it, so a green run
does not move Linux out of the `unverified` tier. What it has observed is recorded in the
[platform observation record](../operations/platform-observation-record.md#local-linux-leg-2026-11-12).

## The successor to `verify:edit`, and what it needs

Selecting tests by changed file is the better edit loop, and it is deliberately not what this is.
There is no affected-test selector in `repo/`, git-based selection depends on which base ref exists
locally, and a selector that silently resolves to *nothing* is worse than a slow gate: it reports
green over an empty set, which is the vacuity failure this repository has a whole meta-gate family for.

What it would need, if someone takes it: a selector that **fails when it selects nothing**, a recorded
measurement of what it misses against the fixed subset, and a rule that `verify:push` never uses it.
Until then the fixed subset is honest about its coverage, which is the property that matters more than
its speed.
