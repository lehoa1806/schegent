# Concurrent-run isolation measurement — attribution at 1/2/4/8

**Measured**: 2026-08-27 · **Item**: `FR-R3-124` (T1468) · **Produced by**:
`repo/tests/integration/checkpoints/attribution-concurrency-sweep.test.ts`

This record answers "what cap should I use?" with a measurement instead of the theoretical maximum.
It is the companion to [concurrent-run resource measurement](concurrent-run-resource-measurement.md),
which measured the resource half at the ceiling on 2026-08-25; this one measures the half the audit of
2026-08-27 said was architectural — whether the attribution machinery can still decompose the tree.

**Recommended operating ceiling: 2.** §5 derives it. The setting's maximum stays 20 and the default
stays 1; this is a recommendation from evidence, not a new bound.

<!-- Source: docs/architecture/run-isolation-decision.md -->
<!-- Source: docs/operations/multi-queue-concurrency.md -->

## 1. What was measured, and what was not

Measured: at concurrency 1, 2, 4 and 8, what an operator actually receives when each Run reaches a
Git-capable phase and a recovery checkpoint is taken — a patch, or a decline, and which decline.

Not measured, and stated so the figures are not over-read:

- **Large-workspace behaviour.** The fixture is a small synthetic repository. The attribution question
  turns on whether two Runs' *declared path sets* overlap, not on tree size or history depth, so a
  large repository moves the resource figures and not the outcome distribution. Activation and
  large-workspace percentiles are `FR-R3-130`'s subject.
- **Resident heap as a bound.** The per-level heap figures below are **observations**. The asserted
  resource bound remains `tests/perf/aggregate-resource-soak.test.ts` (400 MiB, derived by
  `FR-R3-081` from measurement at the ceiling). A heap assertion in the hermetic suite would be an
  environment-dependent failure, which is the flake `FR-R3-042` separated the perf config to avoid.
- **Real backend behaviour.** Phases are simulated: the fixture opens the ledger window, writes, and
  closes it with a declaration, exactly as `RunDriver.dispatchObserved` does. What is not simulated is
  a backend that writes outside its declaration — that case declines as
  `unattributed-worktree-change` and is covered by `run-checkpoint-attribution.test.ts`, not here.

## 2. Method

Per level *N* and per write pattern:

1. A fresh temporary Git repository with one empty commit.
2. One `RunMutationLedger` over that tree; *N* Run fixtures created **after** it, so
   `observedFromStart` holds and the evidence is complete. (A Run that began before the ledger has
   writes no ledger saw; that is a deliberate incomplete-evidence case and is not this measurement.)
3. **Every window is opened before any Run writes**, and every window is closed after all of them
   have. Serializing them would measure a situation concurrency does not produce, and would pass
   against an attribution rule that only works when windows do not overlap.
4. Each Run writes its own file; in the `overlapping` pattern each Run additionally appends to one
   shared file and declares it. `git add -A` follows, because `git diff HEAD` cannot see an untracked
   file.
5. One `RunCheckpointService.checkpoint()` per Run, with `countInFlightRuns: () => N`.
6. The artifacts on disk are read: a `.patch` plus its manifest's `attribution.mode`, or a
   `.declined.json` and its `reason`.

Two patterns, which are the two things that can happen in one tree:

- **disjoint** — every Run declares and writes only its own paths.
- **overlapping** — every Run additionally writes one shared path. The semantic conflict, in its
  simplest true form.

## 3. The tree

| | |
|---|---|
| Execution repo | `59584747` on `develop`, product version `0.2.0` |
| Platform | Darwin arm64, 10 cores |
| Node | v24.19.0 |
| Git | 2.50.1 (Apple Git-155) |
| Suite | `test:host` (hermetic config), single run, idle machine |

## 4. Figures

    N= 1 disjoint    declined=0/1 heapDelta= 0.77MiB elapsed= 79ms  sole-run=1
    N= 1 overlapping declined=0/1 heapDelta= 0.62MiB elapsed= 88ms  sole-run=1
    N= 2 disjoint    declined=0/2 heapDelta= 1.19MiB elapsed=148ms  scoped=2
    N= 2 overlapping declined=2/2 heapDelta= 1.14MiB elapsed=154ms  path-mutated-by-multiple-runs=2
    N= 4 disjoint    declined=0/4 heapDelta=-3.02MiB elapsed=259ms  scoped=4
    N= 4 overlapping declined=4/4 heapDelta= 2.12MiB elapsed=262ms  path-mutated-by-multiple-runs=4
    N= 8 disjoint    declined=0/8 heapDelta=-0.72MiB elapsed=516ms  scoped=8
    N= 8 overlapping declined=8/8 heapDelta=-1.55MiB elapsed=541ms  path-mutated-by-multiple-runs=8

Read as a table:

| N | disjoint | overlapping (one shared path) |
|---:|---|---|
| 1 | 1/1 patch, `sole-run` | 1/1 patch, `sole-run` — no sibling exists to contest with |
| 2 | 2/2 patches, `scoped` | **0/2 patches**, all `path-mutated-by-multiple-runs` |
| 4 | 4/4 patches, `scoped` | **0/4 patches**, all `path-mutated-by-multiple-runs` |
| 8 | 8/8 patches, `scoped` | **0/8 patches**, all `path-mutated-by-multiple-runs` |

**Three readings, and the second is the one that matters.**

1. **Attribution is not unreliable, and the audit did not say it was.** Disjoint concurrent work is
   attributable at 8 Runs exactly as at 2 — every Run receives a patch containing only its own
   sections, at every level. The machinery `FR-R3-004` built does what it claims.
2. **One contested path costs every participant its checkpoint, and the loss does not degrade
   gracefully with N.** At 8 Runs sharing one file the operator receives eight declines and zero
   recovery patches. This is the *correct* behaviour — an unattributable patch is worse than none,
   which is why `decide()` writes only a marker with `restorable: false` — and it is what
   "attribution is not isolation" means in outcomes rather than in the abstract. The mechanism's
   answer to a semantic conflict is that nobody gets a recovery point.
3. **Cost is linear in N and is not the binding constraint.** The whole open/write/close/checkpoint
   cycle costs roughly 65 ms per Run (79 ms at N=1 to 516 ms at N=8), dominated by Git subprocess
   spawns at each window edge. Heap deltas are noise at this scale: two levels measured **negative**,
   because a collection landed inside the window — the same artifact `FR-R3-081`'s soak recorded, and
   the reason these figures are observations rather than budgets.

## 5. Where the recommendation comes from

The outcome is **binary in overlap, not graded in N**: nothing degrades between 2 and 8, and a single
contested path is total for everyone who declared it. So the ceiling cannot be read off a degradation
curve — there is no curve. It is read off what *rises* with N, which is the number of ways an overlap
can occur:

| N | Run pairs that could contest a path | Checkpoints lost if any one pair does |
|---:|---:|---|
| 2 | 1 | 2 |
| 4 | 6 | all Runs declaring the contested path |
| 8 | 28 | as above |

**Recommended ceiling: 2.** At two Runs an operator can hold both Pipelines in mind and judge whether
they touch disjoint paths — there is exactly one pair to reason about, and the measurement says that
if the judgement is right both Runs are fully attributable. At four the operator is reasoning about
six pairs and at eight about twenty-eight, and being wrong about any one of them costs every
overlapping Run its recovery point with no partial result.

This is a recommendation about what a person can verify, grounded in a measured binary outcome and a
counted pair growth — not a resource limit. The resource figures say the machinery would happily run
at 8.

**Until per-Run isolation exists, that is the whole basis available.** The shape is decided and gated
in [run-isolation-decision.md](../architecture/run-isolation-decision.md); once a Run has its own
working tree, overlap stops being a question the operator has to answer in advance, and this
recommendation is expected to be retired rather than raised.

## 6. Re-running this

    cd repo
    npx vitest run tests/integration/checkpoints/attribution-concurrency-sweep.test.ts

The figures print to stdout. The assertions are the deterministic outcome distributions, so a change
in the attribution machinery fails the test rather than silently changing this record — which is what
keeps a measurement nobody repeats from drifting.

If the distributions move, **the finding is the movement**. Update this record with the new figures
and the cause; do not adjust the expectations to match.
