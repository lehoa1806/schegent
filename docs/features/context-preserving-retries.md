# Context-Preserving Retries

When a phase pauses and resumes, or when a delayed retry fires after a transient failure, the next CLI invocation typically wants to **continue** the prior conversation rather than start fresh. Schegent uses the Claude CLI's `--continue` flag (`-c`) to make this work.

This page explains when `--continue` is appended, when it is not, and why the distinction matters.

## The flag and its effect

The Claude CLI accepts `-c` (alias for `--continue`). When present, the CLI resumes the prior conversation in its session-tracking storage rather than starting a new one. The model retains its tool-use history, its in-context memory of the task, and its in-progress reasoning.

Without `-c`, a re-spawned CLI starts a fresh conversation. The phase's prompt is delivered as a first message; any prior history is lost.

## The dispatch matrix

The workflow controller is the single source of truth for whether `--continue` is appended. The decision lives in a private flag, `nextDispatchIsContinue`, that the controller arms before dispatching the next phase invocation. The runner consumes-and-resets the flag on the first call.

Here is when the flag is armed:

| Dispatch reason | `--continue`? |
|---|---|
| **Retry Active Run** (`schegent.retryActiveRun`) | **Yes** |
| **Resume Active Phase** (operator clicks Resume on a paused phase) | **Yes** |
| **Resume Existing run with a non-null pause-cause** | **Yes** |
| **Resume Existing run with a non-null pending-retry-cause** | **Yes** |
| **Restart Active Phase** (operator chose Restart rather than Resume) | **No** |
| **Start New** (a fresh task entering in-flight from pending) | **No** |
| **Loop iterations within the same invocation** (after the first) | **No** |
| **Phase advancements within the same invocation** | **No** |
| **Bugfix loop iterations** | **No** |

The flag is consumed on the **first** runner call after being armed. Subsequent loop iterations and phase advancements within the same invocation revert to `isContinue: false`. This matches the CLI's semantics — once the conversation is resumed, subsequent prompts within that session do not need the flag.

## How the audit trail stays in sync

Every `phase-start` event records the `isContinue` boolean. The strict `=== true` gate is used in **both** places:

1. In `ClaudeCliRunner.invoke`, where the host decides whether to append `-c` to the spawned argv.
2. In the `phase-start` audit emission, where the host decides what `isContinue` field to record.

The audit record and the spawned argv stay in lock-step. If you look at a `phase-start` event with `isContinue: true`, you can be sure the CLI was actually spawned with `-c`.

## Why the dispatch reasons differ

### Why Resume and Retry are `--continue`

Both Resume and Retry are mid-run interventions. The operator is saying: "the work in progress is good; just pick up where you left off". The model has already produced partial output; throwing that away would be wasteful and would lose context that the operator could not easily reproduce.

### Why Restart is *not* `--continue`

Restart is the operator saying: "the work in progress is not good; start the phase over". Continuing the conversation would carry forward the bad state. Restart deliberately starts fresh.

### Why Start New is *not* `--continue`

A new task has no prior conversation to continue. The CLI's session for that task does not exist yet.

### Why loop iterations are *not* `--continue` after the first

The first iteration of a loop phase that arrived via a resume gets `--continue` (it inherits the resume's intent). Subsequent iterations of the same loop are within the same CLI session — no need to flag again.

### Why bugfix loop iterations are *not* `--continue`

The bugfix pipeline has its own loop semantics where each iteration is intentionally a fresh conversation. The phase definition documents this.

## State persistence

`isContinue` is **not** persisted on `WorkflowRun`. It is a per-dispatch hint, computed at dispatch time from the controller's reason for dispatching. The audit record is the only persistent trace.

This is by design. If you reload the extension mid-run, the dispatch reason on the next dispatch is re-derived from the persisted run state (pause-cause, pending-retry-cause, etc.); the previous in-memory `nextDispatchIsContinue` value does not matter.

## The strict `=== true` gate

The runner appends `-c` *only* when `request.isContinue === true`. Any other value (`false`, `undefined`, `null`) does not arm the flag. This is the only append site for `-c`; the runner does not consult env vars, retry counters, or upstream argv inspection.

Forbidden patterns:

- Appending `-c` from a different module.
- Appending based on a retry counter ("after the 2nd attempt, add `-c`").
- Appending based on an env var (e.g., `CLAUDE_CONTINUE=1`).
- Stripping `-c` after the controller armed it (without consuming the flag).

Forbidden patterns are blocked by code review and tests.

## What happens if `--continue` is appended incorrectly

Two failure modes:

### Missing `-c` when it should be present

Symptom: the operator clicks Resume on a paused implement phase, and the CLI re-spawns with a clean context. The model forgets what it was doing; it re-reads the task list and starts over. Work is lost (best case) or duplicated (worst case).

### Extraneous `-c` when it should not be present

Symptom: a fresh `speckit-specify` phase spawns with `-c`. The CLI attempts to resume a non-existent session for this task and either errors or reuses an unrelated session. Output is corrupted.

The dispatch matrix is designed to prevent both. The strict `=== true` gate is the last line of defense.

## Worked examples

### Example 1: Operator pauses and resumes

1. `speckit-implement` is in-flight, on iteration 1.
2. Operator clicks **Pause**. Audit: `phase-pause-requested`, `phase-paused`.
3. Operator clicks **Resume**. Audit: `phase-resumed`.
4. Controller arms `nextDispatchIsContinue = true`.
5. Next runner call: `phase-start` with `isContinue: true`. CLI argv includes `-c`.
6. The model resumes from where it left off.

### Example 2: Delayed retry after rate limit

1. `speckit-implement` hits a rate limit. Audit: `monitor-rate-limited`, `phase-end` with `cause: 'rate_limit'`, `retry-scheduled`.
2. The host persists `pendingRetryAt` and `pendingRetryCause = 'rate_limit'` on the run.
3. The delay timer fires. The controller dispatches with reason `resumeExisting` because the persisted run has a non-null pending-retry-cause.
4. Controller arms `nextDispatchIsContinue = true`.
5. Next runner call: `phase-start` with `isContinue: true`. CLI argv includes `-c`.
6. The model continues; the audit log shows the recovery.

### Example 3: Operator chooses Restart

1. `speckit-implement` is paused.
2. Operator clicks **Restart Active Phase** (instead of Resume).
3. The controller does **not** arm `nextDispatchIsContinue`.
4. Next runner call: `phase-start` with `isContinue: false`. CLI argv does **not** include `-c`.
5. The model starts the phase over, fresh.

### Example 4: Phase advances cleanly

1. `speckit-specify` completes. `phase-end` with `outcome: success`.
2. The controller advances to `speckit-clarify`. Internal call within the same invocation.
3. `nextDispatchIsContinue` is not armed (it was consumed on the first call of this invocation, or was never armed for this run).
4. `phase-start` for `speckit-clarify`: `isContinue: false`. New CLI session.

This is by design — `speckit-clarify` is a distinct phase with a distinct prompt; continuing the `speckit-specify` session would be wrong.

## Audit log query: when is `--continue` used?

To survey the history of `--continue` use, grep the audit log for `phase-start` events:

```bash
grep '"eventType":"phase-start"' .schegent/audit.log | \
  jq 'select(.isContinue == true) | {phaseId, runId, timestamp}'
```

Or to find runs where Resume happened:

```bash
grep '"eventType":"phase-resumed"' .schegent/audit.log
```

## Limits

- **No `--continue` for a fresh task.** This is the correct behavior.
- **No way to override.** The decision is in the controller; no setting exposes it. This is by design — the dispatch matrix is the contract.
- **Per dispatch, not per phase.** A multi-phase run only arms the flag once per dispatch reason; phase advancement within the same invocation does not re-arm.

The next feature is [Aggressive Pause](aggressive-pause.md).
