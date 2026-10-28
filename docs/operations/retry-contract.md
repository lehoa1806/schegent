# Retry contract

**Written from source at `5d700407`, 2026-10-28 (FR-R4-F02, FR-025).** This page says which
failures retry, pause or fail, where each delay comes from, and where automatic attempts stop. It
describes what the code does. It does not widen it: no failure class gains a retry here, and a
class that fails today is listed as failing.

The offline rows are **predictions written from reading the source**, kept apart from any real
observation. A stub CLI drives them through the real path
(`tests/integration/offline-retry-path.test.ts`), and `platform-observation-record.md` lists the
real-output observations as not yet made.

## How a failed invocation is decided

One path, in this order:

1. The runner spawns the CLI and keeps the exit status, the kill and timeout facts, and bounded
   copies of both streams.
2. `unwrapStreamJson` reads the stream-json stdout into text and an `apiError` (a result record
   with `is_error`).
3. `classifyFatal` (hard rule 17) looks for a registered fatal signature on diagnostic lines.
4. `detectCreditError` looks for a rate limit: qualified forms on stderr diagnostic lines, and on
   stdout only a genuine top-level `rate_limit_event` record whose status is `rejected`. Exit
   zero is never a rate limit.
5. `parseInvocation` combines the facts into one result: fatal, rate-limited, API error,
   unfinished turn, transient error (a non-zero exit with no clean token), or a contract block.
6. `mapOutcome` turns the result into the Phase outcome, and the sequencer's `transition()` turns
   the outcome into a decision: advance, loop, fail or pause.
7. A pause for a rate limit or a transient error becomes a delayed retry. `RetryHandler` computes
   the delay and the cap, and `RetryCoordinator` arms the deadline.

## Which failures retry, pause or fail

| Failure | Classified as | Outcome | Delay source | Automatic attempts |
|---|---|---|---|---|
| Rate limit: a genuine rejected record or a qualified stderr form, with a parseable reset | `rate_limited` | Paused, delayed retry | The parsed reset plus `RETRY_BUFFER_MS` (60 s), never below `RETRY_FLOOR_MS` (60 s) | Up to the cap |
| Rate limit with no parseable reset | `rate_limited` | Paused, delayed retry | `RATE_LIMIT_BACKOFF_MS` (60 min) | Up to the cap |
| Out of credits, reset already in the past | `rate_limited` (`out-of-credits`) | Paused, delayed retry | `RATE_LIMIT_BACKOFF_MS`; the floor is not applied (hard rule 37) | Up to the cap |
| DNS refusal (`getaddrinfo ENOTFOUND`), non-zero exit | `transient_error` | Paused, delayed retry | `TRANSIENT_BACKOFF_MS` (15 min) | Up to the cap |
| Connection reset (`ECONNRESET`), non-zero exit | `transient_error` | Paused, delayed retry | `TRANSIENT_BACKOFF_MS` | Up to the cap |
| Proxy failure (`407`, `502`), non-zero exit | `transient_error` | Paused, delayed retry | `TRANSIENT_BACKOFF_MS` | Up to the cap |
| Stale credit text, then a network failure | `transient_error`: the network failure decides | Paused, delayed retry | `TRANSIENT_BACKOFF_MS` | Up to the cap |
| No output until the idle bound; the host terminates | `timeout` | Fails the Phase; an optional Phase advances | None | None |
| Auth failure: a result with `is_error`, non-zero exit | `malformed` with an API error, mapped to `failed` | Fails the Phase | None | None |
| Provider overload: a result with `is_error`, non-zero exit | `malformed` with an API error, mapped to `failed` | Fails the Phase | None | None |
| A registered fatal signature | `malformed` with a fatal cause, mapped to `failed` | Fails the Phase | None | None |
| A settled turn the host ended with SIGTERM, no contract block | `incomplete_turn` | Resumed at once; fails if the resumes do not finish it | None | The unfinished-turn resume bound |

<!-- Source: src/controller/phase-outcome-mapper.ts -->
<!-- Source: src/controller/phase.ts -->
<!-- Source: src/controller/rate-limit-backoff.ts -->
<!-- Source: src/contracts/retry-bounds.ts -->
<!-- Source: src/parser/stdout-parser.ts -->

`mapOutcome` decides the outcome column, `transition()` the outcome-to-decision step,
`backoffForCause` the delay source column, and `parseInvocation` the classification column.

### Stale credit text does not override a network failure

Stdout is read for rate limits as records only. A `rate_limit_event` that a tool result merely
quotes is not a record, and neither is prose that says "credits exhausted". Stderr is read per
line on diagnostic lines, so a quoted envelope cannot match either. A network failure that follows
such text therefore reaches the transient-error row, and the text earlier in the output has no
vote (FR-024). A genuine rejected record in the same invocation is a different case and is a rate
limit.

<!-- Source: src/parser/credit-error-detector.ts -->

## Where automatic attempts stop

The cap is `DELAYED_RETRY_CAP` (5) and it is a count of failures, not of retries. The first four
failures of one Run arm a delayed retry each. The fifth does not: `handleDelayedRetry` sees
`delayedRetryCount >= cap - 1` and calls `scheduleQueuePauseAndFail`, which pauses the queue with
`pendingRetryAt` and `pendingRetryCause` cleared and the count left at the cap. For a rate limit
with a usable reset inside the seven-day horizon the queue is instead scheduled to restart at the
reset. Nothing then retries the Run automatically.

<!-- Source: src/controller/retry-handler.ts -->

An operator interrupts a countdown at any point:

- **Pause** cancels that queue's deadline (`cancelPendingTimer(queueId)`) and stamps the manual
  pause (`manualPauseCause: operator-paused`). The Run waits for the operator.
- **Cancel** writes `canceledRunPatch`, which ends the Run and clears the retry pair, so a
  deadline that still fires finds nothing to resume.
- **Resume** and **retry now** override the countdown and reset the count.

<!-- Source: src/controller/phase-control-service.ts -->
<!-- Source: src/commands/cancel.ts -->

## How the watchdog handles them

A delayed retry and a credit pause are two machineries with two timers (feature 240, US2 and US6).

- A delayed retry runs on the retry coordinator's own timer. It never reaches the watchdog and
  never runs `/status`: when its deadline elapses the coordinator hands the queue on as a
  `backoff-elapsed` wakeup, and the unattended admission resumes it if the Run is still eligible.
- The credit watchdog polls only for a Run with an open `creditPause`. Each poll classifies
  `/status` with `classifyCreditStatus`: `unreachable` for a poll that threw, exited nonzero, was
  killed or timed out, and otherwise `recovered` only for a line that states recovery in the
  bounded exact grammar, with `not-recovered` for anything negated, quoted, structured or unclear.
- The first poll starts a 24-hour window for that Run (`CREDIT_POLL_WINDOW_MS`, a constant, not a
  setting). At the poll after it ends the Run is stamped stopped and left paused, one notice is
  raised for it, and polling ends when no Run holds an open window. A stopped Run shows "Credit
  polling stopped" with **Resume**, which resumes it with no status check and no new window.
- After a reload, `reattachOnActivation` re-reads `creditPause` from the Runs. A persisted watchdog
  record with no open window behind it is cleared with one log line and polls nothing, and the
  window is never started over.

<!-- Source: src/watchdog/credit-watchdog.ts -->
<!-- Source: src/watchdog/credit-window.ts -->
<!-- Source: src/parser/credit-status.ts -->
<!-- Source: src/services/retry-coordinator.ts -->
