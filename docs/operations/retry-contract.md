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

### Stopping a loop whose judged metrics stop changing

`schegent.loop.maxUnchangedComparisons` (FR-R4-F17) lets an operator fail a retry loop before its
iteration cap, when the figures its retry condition reads stop changing. The host already counts those
comparisons for the cap warning; this setting acts on the count.

1. **What it measures.** Only the figures the retry condition names, compared by presence and value. A
   figure missing on both sides counts as unchanged, and a comparison in which none of the named figures
   is present produces no count at all.
2. **The false-stop trade-off.** A figure the condition does not name, or a change to the working tree,
   does not reset the count. Unchanged figures do not prove that no work happened, which is why the
   notice says so and why the setting is off by default.
3. **It ships off.** The default is `0`. A value from `1` to `49` turns it on, and `2` is a suggested
   starting value, not a default. Any other value is read as `0`.
4. **Precedence.** Terminal and pause outcomes are decided first. A falsy or erroring condition advances.
   At the cap, the cap outcome decides. The bound applies only below the cap and only where the cap
   outcome is to fail, so a phase that continues at the cap is never failed by it.
5. **Resume.** The count lives in memory only and restarts after any pause, halt, resume or window
   restart. A resumed run re-runs the stopped iteration as a new baseline and needs the bound plus one
   more comparable iterations to stop again. The cap is not reset, so the iterations already spent still
   count against it, and a failed run is never resumed by an unattended wakeup.
6. **Where to see it.** The per-run limits view shows the bound in effect, the layer that set it, and
   whether it applies to the current phase. It reads "not applied" when the phase has no retry
   condition, or when the phase's cap outcome is to continue.

<!-- Source: src/contracts/unchanged-comparison-bound.ts -->
<!-- Source: src/controller/phase.ts -->
<!-- Source: src/controller/phase-retry-evaluator.ts -->

## When a run fails: its cause and what to do next

FR-R4-F14 gives every failed run one cause from a closed list of ten and a notice that says what
stopped and which action, if any, is worth taking. It was written from source at `9cc9e16b`, the
`develop` head the feature branch was cut from, plus the feature's own change set. It names the cause;
it changes no halt, counter, cap or resume behavior.

| Cause | Label | What happened | What the notice advises |
|---|---|---|---|
| `cap_exhausted` | Iteration cap reached | The phase's retry condition was still true at its iteration cap, and the cap outcome is to fail (the default). | A Resume gives the phase one more attempt, and it fails the same way unless the blocker is resolved first. Work finished by hand is recorded with "Mark '…' as completed". |
| `last_phase_issues_remain` | Last phase ended with issues open | The last required phase ended with issues still open, so the run failed instead of completing. (A bugfix verify phase pauses instead.) | Fix the issues first, then Resume to run the phase again, or record work finished by hand. |
| `incomplete_turn_unresolved` | Phase turn left unfinished | The phase's turn ended unfinished, with work still open in the background or no contract block, and the automatic resumes of that turn did not finish it. | A Resume runs the phase again. |
| `fatal_signature` | Fatal error pattern matched | The backend's output matched a fatal error pattern. | Find the error in the run's transcript or the runtime log and fix its cause before a Resume. |
| `phase_failed` | Phase failed | A required phase failed for a reason that is not a timeout or a fatal pattern: a non-zero exit, an API error, a prompt-delivery failure or a pre-spawn refusal. | Check the run's transcript for what went wrong before a Resume. |
| `phase_timeout` | Phase ran out of time | A required phase reached the idle bound, or the absolute invocation deadline. | A Resume runs the phase again. If it keeps running out of time, check what it was waiting on first. |
| `runner_probe_failed` | Backend CLI unavailable | The backend's CLI was missing or did not start, before the first phase. | Install or repair the CLI, then Resume: the resume checks the CLI again. |
| `audit_evidence_unavailable` | Audit evidence unavailable | Required structured audit evidence was unavailable, so the run failed closed. | Resolve the evidence sink and reload the workspace before resuming. This failure writes no terminal event; the rollup records it. |
| `start_failed` | Host refusal or error | A throw out of the start or the drive: a held workspace lock, a backend containment or capability refusal, a failed consent write or an unexpected error. | None of its own: the notice is the start failure's announcement, and it names no action. |
| `judged_metrics_unchanged` | Judged metrics unchanged | The figures the phase's retry condition reads were unchanged across the number of consecutive comparisons set by `schegent.loop.maxUnchangedComparisons`, below the iteration cap, and the cap outcome is to fail. | Work the condition does not measure may still have happened. Resolve what blocks the condition first; a Resume then runs the phase again at the same iteration, with the iterations left up to the cap. Work finished by hand is recorded with "Mark '…' as completed". |

<!-- Source: src/contracts/failure-cause.ts -->
<!-- Source: src/services/failure-notice.ts -->
<!-- Source: src/controller/fail-decision-cause.ts -->

**Where the cause is recorded.** On the failed run, on its `task-execution-ended` audit event, and on
its metrics rollup record (version 2). A failed run's detail in History shows the cause as
`{label} ({code})`, or "Cause not recorded" for a run that failed before causes were recorded. The
rollup keeps the first failure's cause for a run id, and the audit log has each failure's. A
failure that reaches the Run before any Run exists has no cause: there is nothing to record it on.

**Resume, Retry and Restart.** They are different actions.

- "Schegent: Resume Paused or Failed Workflow" resumes the workspace's one paused or failed run at the
  iteration it failed on. It does not reset the phase's iteration count, so a phase that failed at its
  cap runs once more at the same iteration number.
- "Retry feature '…'" returns the Task to its queue behind the in-flight one. The drain resumes the same
  run when the queue still holds it as failed or paused, and starts a fresh run from the first phase
  otherwise. Either way it happens only when the drain runs.
- "Schegent: Resume Queue" resumes a paused queue, not a run.
- Restart, in a run's detail, runs the current phase again from iteration 1, so unlike a Resume it
  gives the phase a fresh set of attempts.

<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/controller/resume-pause-fields.ts -->

**Recording work finished by hand.** "Mark '…' as completed" on a queue row records a Task as
completed without running anything. The cap and last-phase notices name it, with the Task's title
cut to the first 24 characters as the row's button cuts it.

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
