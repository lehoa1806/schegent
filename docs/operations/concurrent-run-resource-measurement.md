# Concurrent-run resource measurement

**Item**: FR-R3-081 (T1079, T1080) · **Taken**: 2026-08-25 · **Status**: measured; mechanism decision
recorded in [§5](#5-the-decision-this-measurement-supports).

This record exists because a figure was argued from arithmetic and the arithmetic was about the wrong
quantity. It states what was measured, how, on which tree, and what follows from it.

## 1. The figure this replaces

`F-10` / `REL-05` of the retired 2026-08-24 architecture/security review proposed an aggregate
resource budget from a multiplication:

```
MAX_STREAM_BUFFER_BYTES (64 MiB) × 2 streams per run × globalConcurrencyCap max (20) = 2.56 GiB
```

`R-06` of the [2026-08-25 verification audit](../../../docs/features/round_3/00_INDEX.md#9-audit-consolidation-and-the-retired-corpus)
corrected that **in place**, and the correction is the whole reason this measurement was required
before any mechanism: `MAX_STREAM_BUFFER_BYTES` is an **accepted-input** bound — how much output the
buffer will take before it starts discarding — and not resident heap. The head half of each stream is
retained gzip-compressed at roughly 0.66× the per-stream cap (the figure the buffer's own header
documents), and ordinary phase output is text, which compresses far below that.

`00_INDEX.md` §7 item 4 states the consequence as a rule: *"any future mechanism work
should be argued from measured resident heap"*.

**Do not re-publish 2.56 GiB as a heap number.** It is an accepted-input byte budget. Repeating the
uncorrected framing would reintroduce a defect a verification already found.

## 2. Method

`repo/tests/perf/aggregate-resource-soak.test.ts`, run through `npm run test:perf`.

Forty `ZippedStreamBuffer` instances — two streams for each of twenty concurrent runs, which is the
maximum the workspace-wide concurrency cap admits — each filled past
`MAX_STREAM_BUFFER_BYTES` so every buffer is at its accepted-input ceiling with its retention policy
fully engaged. All forty are held live across the measurement, because the question is what they cost
while they are held.

Two input shapes, because they compress differently and one of them is the adversarial case:

- **Ordinary text output** — newline-terminated lines of realistic width.
- **The no-newline case** — a single unterminated line, forever. This defeats any line-oriented
  bound, so it is the shape a resident-heap claim has to survive.

Heap is `process.memoryUsage().heapUsed`, sampled before and after, with a GC hint where the runtime
exposes one. Descriptors are the entry count of `/dev/fd`; on a platform that cannot be asked, the
measurement reports that it could not be taken rather than reporting zero.

## 3. The tree

| | |
|---|---|
| `repo/` HEAD | `782f78a79a750a6a846d3cc3248062f7ecdd5f0a` |
| Workspace HEAD | `442063724ff5f85f524c1621cf83a316a9523e66` |
| Node | v24.19.0 |
| Platform | macOS 26.6.2, arm64 |

## 4. Figures

| Load | Resident heap delta | Arithmetic figure for the same load |
|---|---|---|
| 40 buffers, ordinary text | **75.0 MiB** | 2.50 GiB |
| 40 buffers, no-newline | **below the noise floor** (see below) | 2.50 GiB |

| Descriptors | Before | After |
|---|---|---|
| Open file descriptors across the load | 21 | 21 |

**On the no-newline row.** The measured delta was *negative* (−53.3 MiB): a garbage collection landed
inside the window, so the process finished the load holding less than it started with. That is a
measurement artifact and it is recorded as one rather than rounded to zero or quietly dropped. What it
supports is the weaker and sufficient claim: the no-newline case does not cost materially more than
the text case, which is what one would expect — a single long run of one character compresses to
almost nothing, so the retained head is small for the same reason.

**The ratio is the finding.** Measured resident heap for the text case is roughly **1/34** of the
accepted-input arithmetic. The gap is not a rounding difference; it is the difference between "how
much output will be accepted" and "how much memory is held", which are the two quantities `R-06`
separated.

## 5. The decision this measurement supports

Recorded under T1087/T1088, and stated here because a measurement whose conclusion lives elsewhere
invites the next reader to re-derive it:

**Admission control is not built.** At the maximum cap, on the pathological input, the aggregate
stream-buffer cost is under 100 MiB — an order of magnitude below anything that would justify holding
a run back, and far below the heap a VS Code extension host carries anyway. A mechanism that queued
runs against this budget would refuse work for a resource that is not scarce, and it would do so with
a hold an operator has to understand.

What is built instead, unconditionally, because none of it depended on the answer:

- the sampler covers **every** concurrent run (T1083), so this measurement could be taken at all and
  so a future one can be;
- the transcript writer's chain map is **bounded** (T1081) — `M-10`'s unaudited half;
- this soak runs in `test:perf` (T1086) and asserts a ceiling **derived from the figures above**, not
  from `MAX_STREAM_BUFFER_BYTES` arithmetic. A soak whose threshold traced back to the arithmetic
  would be the uncorrected framing wearing a test's clothes.

The ceiling in the soak is set with headroom over the measured 75 MiB for GC timing and for the
pathological case. **If it ever fails, re-measure and re-argue — do not raise the number.** That is
the whole discipline this record exists to keep.

## 6. Compression latency, measured separately

The review named the synchronous `gzipSync`/`gunzipSync` calls as a latency finding independent of the
memory one, and called it *"the half no measurement can dismiss"*. It was measured anyway, on the same
tree and at this buffer's real 1 MiB flush threshold, over 40 rounds of realistic phase text:

| Call | p50 | p95 | max |
|---|---|---|---|
| `gzipSync` | 1.84 ms | 1.96 ms | 2.00 ms |
| `gunzipSync` | 0.32 ms | 0.41 ms | 0.62 ms |

**They stay synchronous.** A ~2 ms stall once per megabyte of accepted output, against a 16 ms frame
budget, does not justify the change — and the change is not free: `zlib`'s async forms complete out of
order, so a correct move needs compression serialized per buffer, which is a queue, an ordering
invariant and a new way for output to interleave. Adding a failure mode for a 2 ms stall is the worse
trade.

The reasoning is repeated at the call site in `repo/src/runner/zipped-stream-buffer.ts`, because that
is where someone would go to make the change. If the flush threshold rises materially, re-measure: the
cost is linear in the flush size, and the argument is about the number rather than the shape.

## 7. What is unchanged

The per-stream cap (`FR-R3-052` established it), the default concurrency cap of 1, the
uncontained-backend refusal default and the Codex sandbox flags. Nothing here is a reason to raise
any of them.
