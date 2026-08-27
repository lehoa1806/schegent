# Large-workspace resource measurement — concurrency 1/2/4/8

**Measured**: 2026-08-27 · **Item**: `FR-R3-130` (T1494) · **Produced by**:
`repo/tests/perf/large-workspace-resource-sweep.test.ts`

This is the measurement `FR-R3-081` ruled a prerequisite for any mechanism work on the aggregate
stream bound, and the resource half that
[`FR-R3-124`'s attribution sweep](concurrent-run-isolation-measurement.md) explicitly pointed here for.

**The headline: resident heap tracks accepted input at roughly 1:1 below the per-stream cap, and Git
is unaffected by concurrency.** §4 is the table; §5 is what it does not establish.

<!-- Source: tests/perf/large-workspace-resource-sweep.test.ts -->
<!-- Source: tests/perf/aggregate-resource-soak.test.ts -->
<!-- Source: src/runner/zipped-stream-buffer.ts -->

## 1. What this measures that the existing soak does not

`aggregate-resource-soak.test.ts` (`FR-R3-081`, 2026-08-25) fills `2 × cap` buffers to their
accepted-input cap and measures resident heap. It is the right shape for its question — what does the
64 MiB-per-stream bound actually cost — and it runs against **no workspace at all**. Two things an
operator on a real repository asks are therefore unanswered by it:

1. **Does the working tree stay usable while N Runs are in flight?** Every Git-capable phase runs
   `git status` and `git diff`; a checkout that slows under concurrency is a Run that slows.
2. **Do descriptors accumulate?** A stream buffer holds memory, not a handle — but that is a claim,
   and a claim about resource behaviour is what a measurement is for.

## 2. Method

Per level *N* ∈ {1, 2, 4, 8}:

1. A fresh Git repository with **2,000 tracked files across 40 directories, 5.9 MiB** of content,
   committed. See §3 for why that size.
2. `2 × N` `ZippedStreamBuffer`s, filled **together** — the way concurrent Runs fill them, not one
   after another — with 4 MiB of realistic line-oriented output each.
3. `git status --porcelain=v1` over the fixture **while the buffers are held**.
4. Resident-heap delta, open-descriptor delta (`/dev/fd` or `/proc/self/fd`; skipped where neither is
   readable), accepted bytes, and retained bytes.

**4 MiB per stream, not the 64 MiB cap.** At cap 8 the cap would be 1 GiB of accepted input and a
multi-minute test, and `FR-R3-081` already measured the ceiling. What this sweep needs is a load that
scales with the level so the *shape* of the growth is readable.

## 3. The fixture, and why this size

2,000 files / 5.9 MiB is the point where `git status` stops being instantaneous on a warm cache while
the fixture still builds in seconds. **A fixture nobody runs is a measurement nobody repeats**, and the
existing perf suite is run on every `ci`.

It is **not** a claim about the largest workspace this product supports. §5.

| | |
|---|---|
| Platform | Darwin arm64, macOS 26.6.2, 10 cores |
| Node | v24.19.0 · Git 2.50.1 |
| Execution repo | `9789b49e` on `develop`, product version `0.2.0` |
| Suite | `test:perf`, single-threaded (`FR-R3-042`), idle machine |

## 4. Figures

    run 1
    N= 1  accepted= 8.1 MiB  retained= 8.08 MiB  heapDelta= -2.72 MiB  fdDelta=0  git status=25 ms
    N= 2  accepted=16.2 MiB  retained=16.16 MiB  heapDelta=  1.89 MiB  fdDelta=0  git status=24 ms
    N= 4  accepted=32.3 MiB  retained=32.31 MiB  heapDelta=  3.80 MiB  fdDelta=0  git status=27 ms
    N= 8  accepted=64.6 MiB  retained=64.63 MiB  heapDelta= 62.71 MiB  fdDelta=0  git status=25 ms

    run 2, same commit, same machine, minutes later
    N= 1  accepted= 8.1 MiB  retained= 8.08 MiB  heapDelta= -2.70 MiB  fdDelta=0  git status=26 ms
    N= 2  accepted=16.2 MiB  retained=16.16 MiB  heapDelta= 34.16 MiB  fdDelta=0  git status=23 ms
    N= 4  accepted=32.3 MiB  retained=32.31 MiB  heapDelta= 18.97 MiB  fdDelta=0  git status=23 ms
    N= 8  accepted=64.6 MiB  retained=64.63 MiB  heapDelta= 26.70 MiB  fdDelta=0  git status=23 ms

**Four readings, and the second is the one that changes a recommendation.**

1. **Git is flat.** 24–27 ms at every level, with 2,000 tracked files and up to 64 MiB of buffered
   stream output held in the same process. Concurrency does not slow the working tree, and the
   *shared-tree* risk `FR-R3-124` measured is a correctness risk, not a performance one.
2. **Retained ≈ accepted, at this scale.** `FR-R3-081`'s record credits the compressed head — *"the
   head half is retained gzip-compressed at roughly 0.66× the cap"* — and at 4 MiB per stream **that
   saving is not present**: retained tracks accepted to within 0.1%. The compression is a property of
   the *cap-relative* head/tail split, so it only pays once a stream approaches its 64 MiB bound. An
   operator whose phases produce a few MiB per stream should expect to pay for what the process
   accepted, not 0.66× of it. **This is the correction this measurement makes to how the earlier
   figure is likely to be read.**
3. **Descriptors are flat** — zero delta at every level, on the platform that can be asked. The claim
   that a stream buffer is memory and not a handle now has a measurement behind it.
4. **The heap column is UNUSABLE as a coefficient, and both runs are printed to show why.** Same
   commit, same machine, minutes apart: N=8 read **62.71 MiB** then **26.70 MiB**, and N=2 read
   **1.89 MiB** then **34.16 MiB**. GC timing dominates a window this short — N=1 measured negative
   in both runs, a collection landing inside it. `FR-R3-081` recorded the same artifact.

   **The retained column is identical across both runs to two decimal places.** That is the column the
   model in §5 reads. A first draft of the advice module took its coefficient from the heap column and
   would have been a different number every afternoon; the second run is what caught it, which is the
   argument for printing both rather than the tidier one.

## 5. The model, and the one number derived from it

For an operator sizing a cap, the useful form of §4 reading 2 is:

    retained bytes ≈ cap × 2 streams × min(bytes a phase's stream produces, 64 MiB) × 1.0

The coefficient is **1.0**, from the retained column: 8.08/8.1, 16.16/16.2, 32.31/32.3, 64.63/64.6 —
within 0.1% at every level, and identical across both runs. The 0.66× compression discount `FR-R3-081`
credits is **not** available at these sizes; it is a property of the cap-relative head/tail split and
only pays as a stream approaches its own 64 MiB bound.

`repo/src/contracts/stream-pressure-advice.ts` implements exactly that, against `os.totalmem()`, and
it is what warns at the point an operator raises the cap. **It reads its coefficient from this
measurement**, and its own test asserts the coefficient against this section — so a stale record fails
a test rather than misleading an operator.

The warning threshold — a quarter of machine memory — is **not** derived from this measurement and is
not presented as if it were. It is a judgement about the extension host sharing a process with an
editor, a language server and a browser, and it is stated as a judgement beside the constant.

## 5a. Activation-path percentiles, and the release-claim floor (T1497)

Measured on the same fixture, 20 samples:

    p50 = 42 ms   p95 = 45 ms   min = 39 ms   max = 45 ms

**What was measured**: the two activation-path reads whose cost scales with the workspace — a
recursive walk of the tree (what the retention sweep and the mount-capability probe both do) and a
`git status` (what the checkpoint baseline probe does), over 2,000 tracked files.

**What was not**: the full activation chain. That needs an extension host and
`tests/integration/activation-eager.host.test.ts` owns it under a 5 s budget over the whole chain.
This is the workspace-scaling part, which is the part a large workspace changes.

**The release-claim floor this establishes**, and it is a ceiling on the *claim* rather than a budget
on the code:

> On a workspace of ~2,000 tracked files, the workspace-scaling part of activation completes in
> **under 100 ms at p95** on darwin/arm64 with a warm cache. Nothing here supports a claim about
> activation end to end, about a cold cache, about a network volume, or about any other platform.

100 ms is the measured 45 ms with roughly 2× headroom, which is what a loaded machine costs — not a
target, and not a number to defend by tuning. `repo/RELEASE.md` cites this section; if the figures
move, the finding is the movement.

## 6. What this measurement does not establish

- **It is not the largest workspace.** 2,000 files is representative of a mid-sized repository. A
  monorepo of 200,000 files is a different measurement and this record does not stand in for it. What
  transfers is reading 2, which is about the buffers and not about the tree.
- **It measures one platform.** Darwin arm64. Windows and Linux remain in the declared `unverified`
  tier ([`FR-R3-115`](platform-observation-record.md)), and a descriptor claim in particular is
  platform-shaped.
- **No figure here is a budget.** The asserted resource bound stays
  `tests/perf/aggregate-resource-soak.test.ts`'s 400 MiB. This sweep asserts only that it ran and that
  accepted input scales with the level; a measurement that asserted its own numbers would be adjusted
  rather than re-run.
- **The activation figure is not a claim about activation.** §5a states the boundary in its own
  words: the workspace-scaling reads, warm cache, one platform.
- **It does not measure a real backend's output volume.** The fill is generated. What a real phase
  produces is the operator's workload and the reason the model in §5 takes it as an input rather than
  assuming it.

## 7. Re-running this

    cd repo
    npx vitest run --config vitest.perf.config.ts tests/perf/large-workspace-resource-sweep.test.ts

If the figures move, **the finding is the movement**: update §4 and §5's coefficient with the cause.
The advice module's assertion reads that coefficient, so a stale record fails a test rather than
misleading an operator.
