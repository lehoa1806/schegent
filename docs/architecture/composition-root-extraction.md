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
