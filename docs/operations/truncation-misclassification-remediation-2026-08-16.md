# Output-volume misclassification — remediation, 2026-08-16

A `speckit-plan` phase that succeeded was recorded as `failed`, and the task
it belonged to was stamped FAILED with six phases never attempted. Nothing in
the phase's work went wrong. It emitted too many bytes.

This document records the diagnosis, the five changes made, and the reasoning
behind the two that are judgement calls rather than repairs.

## What happened

| Evidence | Value |
|---|---|
| `phase-end` outcome | `failed`, `terminationReason: 'error'`, `exitCode: 0` |
| Task row | `terminalStatus: 'failed'`, `phasesCompleted: 2` of 9 |
| Runtime log, 1 ms later | `WARN output-truncated-unclassifiable` |
| `speckit-plan` stdout | 4,795,881 bytes against a 4,194,304-byte cap |
| CLI result line | `is_error: false`, `stop_reason: 'end_turn'` |
| Final assistant message | contained `[SCHEGENT_STATUS: CLEAR]` and a complete audit block |
| Plan artifacts on disk | all five present |

The chain, each link verified in source rather than inferred:

1. `ZippedStreamBuffer.truncated` is `observedBytes > maxBytes`. 4.79 MiB
   over a 4 MiB cap set it.
2. `failClosedOnTruncatedOutput` discarded the `clean` parse and rebuilt it as
   `malformed` carrying `output-truncated-unclassifiable`.
3. `mapOutcome` returned `failed` for that warning; `mapTerminationReason`
   returned `error`. That `failed`/`error`/exit-0 triple is reachable through
   exactly one branch, which is what makes the attribution a proof rather
   than a correlation.
4. `transition()` treats `failed` on a **required** phase as an unconditional
   run-terminal halt — it bypasses `retryCondition` and `iterationCap`
   entirely (FR-010).
5. `queue.finish` wrote the task row.

The preceding phases were 0.9 MiB, 0.7 MiB and 0.1 MiB. Nothing about this
phase was anomalous except its size.

## Why this was hard to diagnose

The `phase-end` audit entry recorded `outcome: 'failed'` and
`terminationReason: 'error'` and **nothing else**. `projectPhaseEnd` builds a
closed shape and silently drops any field not on it; `warnings` was not on it
and `cause` is deliberately omitted. The only record of *why* the run failed
lived in the transient runtime log, one millisecond away from the audit entry
that could not explain itself.

That is finding E, and it is listed first because it is the one that made the
other four expensive to find.

## The five changes

### E — the audit records the codes that explain its own verdict

`src/audit/audit-payload.ts` gains `warnings` and `omittedWarningCount` on
`PhaseEndPayloadV3`.

This is an **allowlist**, not a passthrough, and the first attempt at it was
wrong in a way worth recording. The warning list reaching the audit layer
also carries the matched fatal signature verbatim and parser messages that
splice in up to 60 characters of model output — both are exactly what
`OMITTED_KEYS` exists to keep out of the log, and two existing tests assert
they never appear there. `RECORDABLE_PHASE_END_WARNINGS` is therefore a closed
set of five code-resident literals with no interpolated content; everything
else increments `omittedWarningCount`.

Drift is contained by construction. If an emitter changes its literal, the
warning stops matching and is counted instead of recorded — the entry degrades
to "something was warned about" rather than recording the wrong thing or
leaking content.

The projection also cannot use `projectValue`, which *throws* on over-long or
path-shaped strings. `appendRequiredAudit` turns an audit failure into
`RequiredEvidenceUnavailableError`, so a throw here would cost the entire
`phase-end` record to save a diagnostic field.

### A — `MAX_STREAM_BUFFER_BYTES`: 4 MiB to 64 MiB

The observed phase was 4.8 MiB, so 4 MiB was not a generous bound being
stressed by an outlier; it was below routine. 64 MiB is ~13x that phase.

The cap is legitimate — the extension host is a shared Node process and other
extensions live in it — so this is a resizing, not a removal. What made 4 MiB
defensible was never retention itself (~0.66x the cap: gzip-compressed head
plus raw tail) but peak heap during classification, which was several
multiples of it. Change B removes that multiplier; A without B would have put
peak heap in the hundreds of MiB per invocation, doubled for two buffers and
multiplied by concurrent runs.

Measured, not assumed: gzip on the real 4.8 MiB stream-json stream gives 3.1x,
not the 5-10x that would have flattered the estimate.

### B — `unwrapStreamJson` stops materializing the stream

`src/parser/stream-json-unwrapper.ts` collected every parsed line from the
whole stream into an array and then looped over it. It now consumes each line
as it is parsed, through a `processLine` closure, and releases the `rawText`
fallback accumulator the moment model text is found — `rawText` is only ever
returned when no model text exists, so past that point it is a second full
copy of the stream that cannot be reached.

One subtlety: converting the loop body into a closure turns `continue` into
`return`. That is behaviour-preserving here only because a record typed
`assistant` is never also an `item_completed`. It is noted inline at the site.

### C — fatal classification stops depending on retention

New: `src/lib/incremental-fatal-scanner.ts`, wired through
`InvocationRequest.effectiveFatalSignatures` and
`RawInvocationOutput.streamFatalMatch` into `claude-cli.ts` and consulted by
`stdout-parser.ts`.

Above the cap, `classifyFatal` reads a head plus a rolling tail, so a
signature in the discarded middle is invisible to it. That is the actual
reason truncation had to be treated as unclassifiable. The scanner runs on
each chunk as it arrives, so its coverage is every observed byte.

It reproduces `classifyFatal`'s answer exactly rather than approximating it,
which rests on two properties:

- `classifyFatal` returns the **lowest-index** entry that matches anywhere,
  not the earliest match in the text. Tracking the best index seen and only
  scanning entries below it converges on the same entry under any chunking.
- It checks stdout before stderr per entry, so ties resolve to stdout.
  `combineStreamScans` applies the same rule.

Signatures are verbatim substrings, so the only chunking hazard is a signature
straddling a boundary; a carry of `longest - 1` characters is sufficient and
bounded. The equivalence is tested by feeding both streams one character at a
time and comparing against `classifyFatal` directly.

The scan can only **add** a classification the retained text would have
missed. It never suppresses one, so the code-resident floor is neither
widened nor narrowed. The signature list is passed per invocation and never
held beyond it.

### D — "could not classify" stops meaning "classified as failed"

`mapOutcome` now returns `transient_error` for `output-truncated-unclassifiable`
instead of `failed`. `fatalCause` still returns `failed`.

The fail-closed guarantee is *never advance*. It was implemented as *fail the
run*, and on a required phase those are very different: the second discards
every subsequent phase. `transient_error` still halts — it never advances —
but halts to paused and takes the existing 15-minute delayed-retry path.

Reusing `transient_error` rather than adding a `PostPhaseDecision` arm is
deliberate. `toDelayedRetryCause` recognises `'transient_error'` and returns
it directly; a cause it does *not* recognise falls through to
`pause-rate-limit`, which would have reported an unclassifiable-output pause
as a rate limit. The existing outcome routes correctly through plumbing that
is already tested.

`mapTerminationReason` is unchanged: `transient_error` reports `'error'` too,
so only the outcome diverged.

A phase that reliably exceeds 64 MiB does not retry forever. `DELAYED_RETRY_CAP`
bounds it at five attempts, after which `retry-handler.ts` pauses the queue and
emits `queue-paused` with the cause and final count. The end state is an
operator-visible pause naming the reason, rather than an instant run-terminal
failure that named nothing.

## What is still true after the change

- Truncation still blocks advancement. API-error and completion-marker
  evidence is only recoverable from retained text, so the warning still fires
  above the cap.
- A fatal signature is still terminal, now on better evidence than before.
- The cap still bounds host memory.

## Verification

| Check | Result |
|---|---|
| `typecheck`, `typecheck:tests`, `typecheck:webview` | pass |
| `lint`, `lint:webview` | pass |
| `test:host` | 6675 pass, 1 pre-existing failure (below) |
| `test:webview` | 1549 pass |
| `test:perf` | 14 pass |
| `test:evals` | 10 pass |
| `contracts:check`, `docs:check`, `security:secrets`, `security:actions`, `license:check` | pass |

The truncating path was exercised end-to-end through the production runner at
`SCHEGENT_SUSTAINED_RECORD_COUNT=70000`: 146,090,064 bytes emitted, retention
pinned at exactly 64 MiB per stream, raw transcript hashing complete at full
size.

**Pre-existing failure, unrelated to this work:** `agents-claude-parity`
reports `AGENTS.md` still pointing at spec 095 while `CLAUDE.md` points at
096. `/speckit-plan` updates `CLAUDE.md` only; `AGENTS.md` needs the same edit
by hand. Neither file is touched by this change.

## Budget and fixture adjustments

- `tests/perf/budgets.json` — `MAX_STREAM_BUFFER_BYTES` budget to 67108864.
- `tests/lint/phase-runner-loc-budget.test.ts` — `phase-outcome-mapper.ts`
  budget 100 to 110, with the reason recorded at the entry. The file gained no
  responsibility; the lines are the explanation of why the truncation arm no
  longer returns `failed`, and a reader assuming the old mapping was
  deliberate is precisely how this defect survived.
- `tests/perf/sustained-evidence-path.test.ts` — the two truncation assertions
  now compare against whether emitted volume exceeds the cap, which is exact
  in both directions rather than skipped in one. At the default record count
  the profile asserts the *absence* of truncation, catching a spurious
  truncation as surely as the old assertion caught a cap that never engaged.
  Scaling the default past 64 MiB was rejected: it would have driven ~270 MB
  of live strings through the test process for coverage that
  `zipped-stream-buffer.test.ts` already provides against explicit small caps.
- `tests/evals/fixtures/backend-outcomes.json` — the `truncated-output`
  scenario's `phaseOutcome` to `transient_error`. Its `mayAdvance: false` is
  unchanged, which is the load-bearing half.
