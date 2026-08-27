# The composition root, decided

**Decided 2026-08-27** · `FR-R3-119`

## The decision

**Extract, not waive.** `wireStage2()` in `src/extension.ts` is the composition root's
largest instance and it is being reduced into `src/activation/*-wiring.ts` modules
under a shrink-only function bound, rather than accepted under a waiver.

## What was measured

| # | Measurement | Source |
|---|---|---|
| 1 | `wireStage2` spanned lines 263–1483: **1,221 lines**, ~245 top-level statements | `src/extension.ts` |
| 2 | 77 file-level imports | `grep -c '^import'` |
| 3 | `src/activation/` was 1,863 lines across 11 modules; largest `ui-wiring.ts` at 387 | `wc -l src/activation/*.ts` |
| 4 | The LOC entry was a **ceiling at 1,490 against a 1,489-line file** — one line of headroom, no recorded decision | `source-loc-budget.test.ts:349` |
| 5 | Its two **larger** peers, `workspace-state.ts` (2,768) and `queue-manager.ts` (1,841), both carried dated waivers with ratchets | same file |
| 6 | `WAIVER_FACTOR` catches a ceiling set at a large multiple of its file; a ceiling set one line above it is invisible by construction | same file |

The finding is row 4 against row 5: **the largest cohesion problem in the tree was the
one the waiver machinery never saw**, and nobody ever had to write down why.

## Why extract rather than waive

`FR-R3-027` made the waiver a first-class outcome, and it was genuinely available.
It is not taken, for one reason: a waiver has to quote a decision, and the decision it
would have to quote contradicts `ARCHITECTURE.md`, which asserted that
`src/activation/` **is** the composition root. Waiving would have meant reconciling
that sentence downward — weakening a documented boundary to match a file. Extraction
reconciles it the other way.

## What this cycle did, and what it did not

**Did**: extracted the largest independent span — 240 lines of `MessageRouter`
construction — into `src/activation/sidebar-router-wiring.ts`. `wireStage2` went
**1,221 → 1,010**; `src/extension.ts` went **1,489 → 1,270**; eleven imports became
dead and were removed. No behavioural change: every wiring call runs in the same order,
under the same conditions (`FR-059`), and `tests/unit/extension/activate.test.ts` plus
the full host suite hold it.

Three of the twenty-eight bindings the span closed over — `context`, `output`,
`config` — are **not** parameters of the new module, because the router reads none of
them. They were in scope, which is not the same as being depended on. The extraction is
what made that visible.

**Did not**: reach 400. The remaining spans are small and densely interdependent —
after the extraction the largest is 67 lines, so further reduction means grouping
*regions* whose outputs feed each other, four to six of them, on the extension's
activation path. That is a single-change risk this feature's plan explicitly refused,
and a bound nobody can meet is a bound that gets deleted.

## The bound, and the mutation that fixed its first draft

**400 lines**, applied to every function in `src/extension.ts` and `src/activation/`.
400 is observed, not invented: `ui-wiring.ts`, the largest existing module, is 387.

`wireStage2` carries a **named, shrink-only legacy exemption at 1,010** — the only
entry, and the list is closed.

The first draft did not look like that. It enforced a single flat mark of 1,010 across
the whole scope, on the reasoning that a ratchet records where you are. **Mutation
testing killed it**: a new 407-line function added to `src/activation/` passed, because
407 < 1,010. A ratchet set to the worst offender licenses every newcomer up to the worst
offender, which is the exact inverse of its purpose. Recorded because the flat form
looked right and reads right, and only driving it red exposed the difference.

Three mutations were driven red and reverted:

| Mutation | Result |
|---|---|
| a 407-line function in `src/activation/` | red — over the 400 bound |
| the exemption raised 1,010 → 1,500 | red — "an exemption may be lowered, never raised" |
| `extension.ts`'s ceiling set to 1,271 against a 1,270-line file | red — un-decided debt |

## Row 6, closed

The budget gate now reports a **plain ceiling sitting within `max(25, 2%)` of its
file** as un-decided debt. Two parts, because one does not fit both ends: 2% alone gives
a 250-line file five lines of slack, which is ordinary editing; 25 alone gives a
2,700-line file under 1%, which is noise.

Adding the check found **eight** files in that shape, not one — the pattern is
systemic, which is itself the finding: every one was arrived at the same way, by an
edit raising the number by exactly what the edit added. Failing all eight inside a
feature scoped to one of them is how a useful gate gets reverted, so the existing seven
are a recorded shrink-only baseline and a ninth cannot arrive. `src/extension.ts` is
**absent** from that baseline: it is what coming off the list looks like. Its ceiling is
now 1,300 against 1,270 — thirty lines, chosen as room for an ordinary edit rather than
pinned to the measurement, which is what makes it a budget again.

## What is left

`wireStage2` at 1,010, walking down to 400 by the same mechanism
`compiler-strictness-ratchet.test.ts` uses on 1,279 pinned diagnostics: lower the
exemption whenever an edit earns it, and when it reaches 400 delete the entry and the
`ARCHITECTURE.md` qualification with it.


## Second decrement — 2026-08-27

**`wireStage2` 1,010 → 894; `src/extension.ts` 1,270 → 1,138.**
`src/activation/backend-execution-wiring.ts` took 148 lines: the monitor, the telemetry sampler,
the runner registry, and the collaborators they need.

**Why this region.** Of the three candidates measured, it had by far the narrowest input boundary —
**nine** bindings in, against 22 for the watchdog region and 30 for the projector region — while
producing a coherent bundle. Coupling, not size, chose it.

### The part that would have broken silently

Three of the region's bindings are the deliberate late-binding pattern: declared `null`, **captured
by closures inside the region**, and assigned ~280 lines later once the controller and projector
exist.

| Binding | Captured by | Assigned |
|---|---|---|
| `livenessRecorder` | the monitor's activity callback | `controller` |
| `telemetryProjector` | the sampler's snapshot callback | `projector` |
| `capabilityProjector` | backend-diagnostics `onDidChange` | `projector` |

Returning these as plain values and letting the caller reassign its own destructured copy would
leave every closure inside the module still holding `null`. **Nothing would fail to compile and no
test asserts the wiring directly** — the monitor would quietly stop recording activity, the sampler
would stop reaching the UI, and the capability panel would stop refreshing.

So the module returns `bindLivenessRecorder`, `bindTelemetryProjector` and
`bindCapabilityProjector`. That is strictly clearer than the `let x = null` reassigned 280 lines
away that it replaces: the dependency is now named at both ends, and the compiler sees it.

Recorded because it is the failure mode of *every* extraction out of a composition root, and the
one a typechecker cannot catch.

### Four gates followed the construction

`backend-kind-placement`, `tree-degradation-emission-funnel`, `uncontained-backend-not-hardcoded`
and `source-loc-budget` all pinned `src/extension.ts` as the site. Each now reads
`src/activation/backend-execution-wiring.ts` — which is `src/activation/`, the directory
`ARCHITECTURE.md` calls the composition root, so the gates are closer to their own premise than
they were. **None was suppressed**; each follows the construction rather than the filename.

### The ratchet worked as designed

Nothing filed this. Nobody scheduled it. The number came down because the bound makes the debt
visible every time somebody opens the file, and 894 is now the mark. That is the whole argument for
a shrink-only ratchet over a one-off decision: **it is still there when the next person has ten
minutes.**

Remaining: 894 of a 400-line target.


## Third decrement — 2026-08-27

**`wireStage2` 894 → 871; `src/extension.ts` 1,138 → 1,114.**
`src/activation/workspace-settings.ts` took the 36 lines that resolve workspace configuration.

The cleanest cut available and likely the cleanest that remains: **two** bindings in
(`workspaceRoot`, `logger`), nine values out, **no side effects, no construction, no late binding**.
It is configuration resolution, which lived in the composition root only because that is where it
was first written — not because anything about it belongs there.

Worth noting against the two before it: this one needed no design decision at all. The first
extraction needed a parameter object for 28 bindings; the second needed setters to preserve late
binding that would otherwise have broken silently. This one is a function that reads settings and
returns them. **The regions get easier as the coupling drains out**, which is the argument for
taking them in coupling order rather than size order.

Remaining: **871 of a 400-line target**, across three decrements in one session — 1,221 → 1,010 →
894 → 871.

### What the remaining regions look like

Measured after this cut, by input boundary rather than size:

| Region | Lines | Bindings in | Notes |
|---|---|---|---|
| catalog + ownership + UI shell | ~105 | 10 | next best; constructs collaborators, so it needs a returned bundle |
| controller construction | 91 | 18 | the coupling hub — most things reach it |
| watchdogs + scheduled start | 111 | 25 | |
| projector | 71 | 17 | |

None has a late-binding hazard. The next decrement is the catalog/ownership region.


## The ratchet's own guard was not ratcheting — 2026-08-27

Found while reviewing the third decrement, and worth more than the decrement itself.

The exemption came down 1,010 → 894 → 871. The **never-raise guard beside it stayed at 1,010**
the whole time, because it was written once as a literal and nothing tied the two together. So for
three decrements the exemption could have been raised from 871 all the way back to 1,010 without
failing anything.

> A ratchet that only refuses going backwards past where it *started* is not a ratchet. It is a
> memory of one.

Every part of the mechanism looked right in isolation: a shrink-only exemption, a guard asserting
it, a mutation test proving the guard fires. The mutation test proved it fires **above 1,010** —
which was true, and useless once the number had moved.

Fixed by lowering the ceiling in step with the exemption, and by recording that the two must move
together. Verified: raising the exemption to 900 now fails where before it passed.

The general shape, since this is not specific to LoC budgets: **a ratchet needs its guard tied to
its current value, not to its initial one**, and a mutation test that only probes far past the
current value cannot tell the difference.


## Fourth decrement — 2026-08-27

**`wireStage2` 871 → 823; `src/extension.ts` 1,114 → 1,046.**
`src/activation/workspace-session.ts` took 77 lines: what this window owns — the catalog, both
leases, the primacy claim — and the status bar and notifier that report it.

`lockResult` is **returned rather than acted on**. What a failed claim *means* is a decision for the
composition root; making it was never this region's job.

### The lazy read that had to survive

`catalogStore`'s retained-history enumerator reads `historyStore` inside a thunk, and
`historyStore` is built ~180 lines further down by `backend-execution-wiring.ts`. The original
comment says so in as many words: *"the store is built here, `queue` below it and `historyStore`
further down still, so both enumerators close over their sources and re-read per question."*

Taking the value would have forced the caller to build the history store first — **reordering
activation to suit an extraction**, which is the tail wagging the dog and which `FR-059` forbids.
The module takes `getHistoryStore: () => HistoryStore` instead, and the lazy read is preserved
exactly.

Second extraction in a row where the hazard was a deferred read, and the second different shape of
it: the backend module needed *setters* so late assignment reached its closures; this one needed a
*getter* so an early closure could reach a late value. Worth naming as a pair, because a composition
root is mostly deferred reads and each direction fails differently.

### Five gates followed the construction, one of which needed real thought

`ownership-registry-wiring`, `destructive-fs-requires-containment`,
`mount-probe-does-not-gate-activation` and `source-loc-budget` were path updates.

**`elect-before-recovering` was not.** Its rule 1 asserted that the election textually precedes
every recovery landmark — a statement about ordering *within one file*, and the election had just
left that file. The property still held (the session is awaited before any recovery installer
runs), so the check was **split** rather than dropped: the election must live in
`workspace-session.ts`, and the awaited call to it must precede every landmark in `extension.ts`.

Weakening it to "the election exists somewhere" would have been one line and would have retired the
ordering guarantee the gate exists for.

### Trajectory

**1,221 → 1,010 → 894 → 871 → 823**, four decrements in one session, no behavioural change at any
step. `src/extension.ts` 1,489 → 1,046; `src/activation/` 11 modules → 15.

Remaining: 823 of a 400-line target.


## Fifth decrement — 2026-08-27

**`wireStage2` 823 → 695; `src/extension.ts` 1,046 → 916.**
`src/activation/scheduled-work-wiring.ts` took 168 lines: the three things that act on a clock —
scheduled starts, the credit watchdog, the queue-schedule watchdog. Seventeen bindings in, three
out; the best remaining ratio.

This is where the regions stop being obvious. The four before it were "everything between these two
declarations"; this one is *what shares a reason to exist* — each of the three wakes on its own
schedule and decides whether this window may act.

### The recovery landmark deliberately did not move

The region contained `await scheduledStartCoordinator.reArm()`, one of three recovery landmarks
`elect-before-recovering` reasons about: it asserts each is preceded by the election and gated on
`lockResult.acquired`, **in the composition root**.

Moving a landmark into the module that builds its coordinator would not have made it safer. It
would have made it **unwatched**, and the gate would have gone quiet rather than red. So the module
builds the coordinator and returns it, and the caller decides when to act on a primacy result —
the same split `openWorkspaceSession` makes with `lockResult`.

A useful by-product: `lockResult` then stopped being a dependency of this module at all. The first
draft took it; the only use was that one decision, and once the decision stayed behind, so did the
argument. **Construction needs no verdict.**

### Six gates followed the construction; one rule was re-sited rather than relaxed

`no-direct-run-start`, `no-running-state-literal`, `primacy-predicate-split`,
`message-router-primacy-wiring` and `source-loc-budget` were declarations or path updates —
`no-direct-run-start` in particular fired exactly as designed: *"A new file reaches the start path.
Declare it."* It was declared, not widened.

`elect-before-recovering`'s **rule 3** needed re-siting: the watchdog resume sweep must re-read
`hasPrimacy()` before claiming elapsed retries, because it fires long after activation. That
ordering is the whole rule and is unchanged; the sweep now lives in the new module, so the check
reads it there.

### Trajectory

**1,221 → 1,010 → 894 → 871 → 823 → 695**, five decrements in one session, no behavioural change at
any step. `src/extension.ts` 1,489 → 916 — **it has lost 573 lines and is now below the 950 ceiling
that was 1,490 this morning.** `src/activation/` 11 modules → 16.

Remaining: 695 of a 400-line target. The next candidates are `projector + phaseLogTail` (143 lines,
27 bindings in) and `auditWriter + retention` (97 lines, 16 in) — both meaningfully more coupled
than anything taken so far, which is the expected shape as a composition root drains.


## Sixth decrement — 2026-08-27

**`wireStage2` 695 → 630; `src/extension.ts` 916 → 846.**
`src/activation/evidence-wiring.ts` took 91 lines: the audit writer, the session-artifact retention
sweep, and the two thunks that tell them what is still live.

**The migration events are parameters, not a re-derivation.** `v6`/`v7`/`v11`/`v12` and the
run-repair events come from `store.initialize()` at the very top of activation and are consumed
here, because the audit writer is the first thing that exists which can record them. Asking the
store again would return nothing the second time — or re-run a migration. Their types are derived
from the forwarder's own signature (`Parameters<typeof forwardMigrationAuditEvents>[0]`) rather than
restated, so a change to the event shapes cannot drift past this module.

**The two readers stay thunks**, unchanged: both re-read per call so a catalog reload reaches the
next decision and `protectedSessionRunIds` sees runs that started after this wiring ran. Freezing
either into a value at construction is the bug they exist to avoid — the third distinct deferred-read
shape in six extractions.

### Two gates followed

`no-running-state-literal` (a declared-file list) and `run-record-quarantine`, which asserts that
**activation** drains the quarantine rather than only its own test. The drain moved with the audit
writer; the property is unchanged.

### Trajectory

**1,221 → 1,010 → 894 → 871 → 823 → 695 → 630**, six decrements, no behavioural change at any step.
`src/extension.ts` 1,489 → 846 — it has lost **643 lines, 43% of the file**. `src/activation/`
11 modules → 17.

Remaining: 630 of a 400-line target.

**What is left is the coupled core**, and the numbers say so: `projector + phaseLogTail` (143 lines,
27 bindings in), `uiWiring` (67, 22), the phase-runner accessors (70, 17) and the controller itself
(91, 18). Every region taken so far had a boundary of nine to eighteen; the remainder starts at
seventeen and rises. That is the expected shape — a composition root drains from the edges inward,
and what stays is what genuinely composes.


## Seventh decrement — 2026-08-27

**`wireStage2` 630 → 525; `src/extension.ts` 846 → 735.**
`src/activation/live-picture-wiring.ts` took 140 lines: the state projector, the connected-run
service it reads, and the phase-log tail that feeds it.

**The first region taken from the coupled core**, and the binding count says so: **22 in**, where
every earlier region ran nine to eighteen.

### Two of the twenty-two are narrowings, not dependencies

`backend-execution-wiring.ts` returns `bindCapabilityProjector` and `bindTelemetryProjector` so its
closures can reach a projector built later — and the projector is built *here*, so the calls that
bind it belong here too. Passing the whole `backend` bundle to reach two setters would have made
this module depend on everything that bundle holds; the two functions are passed individually
instead.

That is the third time an extraction has *reduced* a dependency by forcing it to be named
(`context`/`output`/`config` in the first, `lockResult` in the fifth, these two here). The parameter
list is the honest measure of coupling, and writing it down keeps shrinking it.

### `refreshCatalog` is returned, not duplicated

It moved with the region because the catalog-settings save path here calls it directly — but the
sidebar router calls it too. It is returned rather than re-created, because two functions that
re-resolve the catalog differently is precisely the drift this codebase keeps closing.

### No gate needed re-siting

The first decrement in the series where `npm run gate` passed on the first run. Six of the seven
required a gate to follow the construction — this one moved nothing any gate was pinning, which is
a small piece of evidence that the remaining core is less entangled with the enforcement layer than
the edges were.

### Trajectory

**1,221 → 1,010 → 894 → 871 → 823 → 695 → 630 → 525**, seven decrements, no behavioural change at
any step. `src/extension.ts` 1,489 → 735 — **it has lost 754 lines, just over half the file**.
`src/activation/` 11 modules → 18.

Remaining: 525 of a 400-line target. What is left is the controller construction, the phase-runner
accessors, `uiWiring`, and the dispose/reset tail — the parts that genuinely compose.


## Eighth decrement — 2026-08-27

**`wireStage2` 525 → 480; `src/extension.ts` 735 → 684.**
`src/activation/phase-execution-wiring.ts` took 69 lines: the four call-time setting accessors, the
retry-decision sink, the phase runner, and the run-safety net.

**The four accessors are the point of the grouping.** Each reads its setting at *call* time rather
than construction time, and each exists because caching it was a defect — `AGENTS.md` carries four
separate rules of the form *"never cache the X setting on long-lived runner state"*, one per
accessor. Sitting apart they read as four unrelated options; together they read as one rule applied
four times, which is what they are.

Gate passed on the first run again — the second in a row, and consistent with the observation from
the seventh: the enforcement layer was pinned to the *edges* of this function, not its core.

### Trajectory

**1,221 → 1,010 → 894 → 871 → 823 → 695 → 630 → 525 → 480**, eight decrements, no behavioural change
at any step. `src/extension.ts` 1,489 → 684 — **it has lost 805 lines, 54% of the file**.
`src/activation/` 11 modules → 19.

Remaining: 480 of a 400-line target.

### Where this stops, and why

What is left is `controller + guardedRunService` at **36 bindings in** — by a wide margin the most
coupled region in the function, and the only one whose parameter object would be larger than the
code it replaces. That is not a region that has failed to be extracted; **it is the composition
itself.** Moving it would relocate the composition root rather than reduce it.

Beside it sit `uiWiring` (67 lines, 22 in) and the `dispose`/`resetSupport` tail (34 lines, 14 in) —
the latter being this function's own teardown contract, which belongs with the function that
allocated the things it releases.

So the honest reading of the remaining 80 lines over target: the next extraction is available
(`uiWiring`), and the one after that is not. **400 may not be the right destination any more** — it
was derived from `ui-wiring.ts`'s 387 lines when `wireStage2` was 1,221 and nothing about its shape
was known. A composition root that has shed 61% of itself and holds only what genuinely composes is
the outcome that was wanted; the number was the instrument. That judgement is for whoever takes the
ninth decrement, with the evidence above.
