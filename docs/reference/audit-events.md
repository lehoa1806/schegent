# Audit Events Reference

The structured audit log (`<workspaceRoot>/.schegent/audit.log`) is JSONL — one event per line. Every event has at least:

```jsonc
{
  "timestamp": "2026-05-17T12:34:56.789Z",
  "eventType": "phase-start",
  "schemaVersion": 3,
  "runId": "<uuid>",
  "pipelineId": "speckit-new-feature",
  "phaseId": "speckit-implement",
  "outcome": "info"
}
```

Field details:

- `timestamp` — ISO-8601 UTC.
- `eventType` — one of the values listed below.
- `schemaVersion` — current value is `3`; readers preserve v1/v2 rows and tolerate unknown future values (`warn-and-preserve`).
- `outcome` — `success` | `failure` | `info`.
- Per-event payload fields are described per event below.

Logs written by an earlier release may contain event types this reference no longer lists — notably the five `wakeup-daemon-*` types plus `wakeup-workspace-roots-updated` and `wakeup-runner-invocation`, all retired with the Wake-up scheduler. The parser preserves entries whose type it does not recognize (`warn-and-preserve`), so those logs still read; nothing in the current release emits them.

Every v3 payload passes through `projectAuditPayload`: strings are bounded, numbers must be finite, arrays are capped, the full payload is limited to 32 KiB, sensitive execution fields are omitted, and residual paths/endpoints or secrets fail the append.

## Event categories

The 58 audit event types fall into 16 categories.

| Category | Count |
|---|---|
| [Phase lifecycle](#phase-lifecycle) | 2 |
| [Runner](#runner) | 2 |
| [Loop](#loop) | 1 |
| [Workflow lifecycle](#workflow-lifecycle) | 5 |
| [Monitor](#monitor) | 10 |
| [Audit pipeline](#audit-pipeline) | 4 |
| [Retry condition](#retry-condition) | 1 |
| [Delayed retry](#delayed-retry) | 4 |
| [Phase control](#phase-control) | 8 |
| [Queue control](#queue-control) | 14 |
| [Phase message](#phase-message) | 3 |
| [Fatal signature](#fatal-signature) | 1 |
| [Auto-compact override](#auto-compact-override) | 1 |
| [Phase log IPC](#phase-log-ipc) | 3 |
| [Phase breakpoint](#phase-breakpoint) | 3 |
| [State migration](#state-migration) | 1 |

## Phase lifecycle

### `phase-start`

Emitted by the phase runner before a phase invocation begins.

Payload fields:
- `pipelineId` — frozen on the run snapshot.
- `phaseId` — current phase id.
- `model` — optional. Omitted entirely when absent.
- `effort` — optional.
- `timeoutMs` — optional.
- `isContinue` — mandatory boolean. `true` when the spawned argv includes `-c` for context preservation.

### `phase-end`

Emitted after the phase invocation terminates.

Payload includes the outcome, numeric exit code, a closed termination reason,
finite metrics, file-change counts, host-observed tool-category counts, and
omitted-evidence counts. It never includes filenames, commands, notes, model
errors, or fatal-signature text. When the CLI stdout includes a stream-json
`result` row, numeric usage/cost metrics may include:
`cliDurationMs`, `numTurns`, `totalCostUsd`, `inputTokens`,
`outputTokens`, `cacheCreationInputTokens`, and
`cacheReadInputTokens`.

## Runner

### `cli-invocation`

Emitted for each CLI invocation. Carries runner, operation (`phase`, `session-compaction`, or `probe`), permission mode, continuation/session-reuse booleans, optional model/effort ids, and whether diagnostics were enabled. Executable path, argv, command text, PID, and session id are omitted.

### `file-write`

Emitted when the phase writes a file to the workspace. The path is **not** included — only metadata.

## Loop

### `loop-iteration`

Emitted at the boundary of each iteration of a loopable phase (`speckit-clarify`, `speckit-analyze`, or any custom phase with `loopable: true`).

## Workflow lifecycle

### `pause`

The run was paused. Sub-causes appear in the payload's `reason` field.

### `resume`

The run was resumed.

### `warning`

A non-fatal warning the host wants to make visible.

### `error`

A non-fatal error that did not terminate the run.

### `cancel`

The run was canceled by the operator. Mirrors the queue-control `task-canceled` event but at the controller layer.

## Monitor

The monitor is the per-invocation watcher that runs in parallel with each phase. It samples stdout, stderr, progress, and signals stall, rate-limit, and termination outcomes.

### `monitor-invocation-started`

Carries the PID of the spawned CLI process.

### `monitor-stdout-line` (retired — no longer written)

A sanitized stdout line from the CLI, one event per line. **Nothing writes this
event any more.** It measured 93.2% of `audit.log` and no part of the product
read it back, so the line content moved to
[`.schegent/cli-transport.log`](file-layout.md#cli-transportlog) and the counts
to `monitor-invocation-summary` below.

The event type stays registered and stays parseable, permanently: rotated
archives are full of these entries, and dropping the type would turn one archive
read into a stream of `unknown eventType` warnings. If you are looking at a log
written by an older release, expect to find them; if you are looking at a fresh
one, expect not to.

### `monitor-stderr-line` (retired — no longer written)

A sanitized stderr line. Retired on the same terms as `monitor-stdout-line`
above. Note that the *judgement* the host makes about a stderr line is still an
audit event — a rate-limit indicator still produces `monitor-rate-limited` — it
is only the transported line itself that moved.

### `monitor-progress`

Periodic progress sample. Used to derive the elapsed-time and PID indicators in the sidebar.

### `monitor-stall`

The CLI has produced no stdout for the configured stall threshold.

### `monitor-rate-limited`

A rate-limit indicator was detected on the CLI streams. The `cause` field discriminates between known indicator kinds.

### `monitor-invocation-completed`

The CLI terminated cleanly (exit code 0).

### `monitor-invocation-failed`

The CLI terminated with a non-zero exit code or a fatal signature match. The classification appears in the `cause`.

### `monitor-invocation-canceled`

The CLI was killed by the operator or a parent control flow.

### `monitor-invocation-summary`

End-of-invocation summary record, and with the per-line events retired this is
the audit log's whole account of how much the CLI emitted:

| Field | Meaning |
|---|---|
| `status` | Terminal monitor status — `completed`, `failed`, `timed_out`, `canceled` |
| `durationMs` | Elapsed time, excluding any interval the run spent paused |
| `exitCode`, `signal` | How the process ended |
| `stdoutLines`, `stderrLines` | Complete lines seen on each stream |
| `firstOutputAt` | When either stream first produced anything. The gap between this and the invocation start is the CLI's own startup cost |
| `lastOutputAt` | The later of the two most recent stream timestamps |
| `detectedIssues` | `rate_limited` and/or `stall`, if either fired |

`firstOutputAt` and `lastOutputAt` are new alongside the retirement above: they
are the interval over which the line counts accumulated, which the per-line
timestamps used to be the only record of.

## Audit pipeline

These events are about the audit log itself.

### `audit-rotated`

The active `audit.log` was rotated to a timestamped archive.

### `audit-retention-applied`

Archive pruning ran. Payload reports how many archives were retained vs. deleted.

### `audit-hydration-warning`

The host attempted to parse an existing `audit.log` line and could not. The line is preserved verbatim in the file; the warning is emitted so operators can investigate.

### `audit-schema-warning`

The host encountered an `audit.log` entry with an unknown `schemaVersion`. The entry is preserved (warn-and-preserve discipline).

### `session-retention-applied`

The unredacted session-artifact retention sweep ran. The payload contains only
aggregate counts, byte totals, policy limits, and failure counts. It never
contains run identifiers, filenames, workspace paths, prompts, or transcript
content. The active structured `audit.log` is outside the sweep root and is
never pruned by this event's service.

## Retry condition

### `phase.retry_evaluated`

A loop phase with a `retryCondition` DSL expression evaluated it. Payload:

- `pipelineId`
- `phaseId`
- `expression` — the DSL string evaluated.
- `metrics` — the `Record<string, number>` extracted from the audit-log block in the phase's stdout.
- `decision` — boolean. `true` means loop; `false` means advance.
- `missingKeys` — optional array of identifiers the expression referenced but the metrics map did not contain.
- `evaluationError` — optional `true` when the expression failed to evaluate.
- `errorMessage` — optional sanitized error message.

The dot-style `eventType` was chosen deliberately to avoid colliding with the `phase-*` dash-style naming.

## Delayed retry

### `retry-scheduled`

A phase failure was classified as `transient_error` or `rate_limit` and a delayed retry was scheduled. Payload carries the pre-buffer `resetsAtMs` (when known) so the retry time is derivable from logs alone.

### `retry-manual`

The operator manually triggered a retry via `schegent.retryActiveRun`. Cancels any pending delayed-retry timer.

### `retry-recovered`

A previously-failing phase recovered (clean exit on the retry). The cumulative delayed-retry count is reset.

### `queue-paused`

The queue was paused. The `pauseSource` discriminator distinguishes operator-initiated pauses (`'operator'`) from automatic pauses caused by exhausting the delayed-retry cap (`'cascade'`).

## Phase control

Eight events covering the operator-initiated phase control surface.

### `phase-pause-requested`

The operator clicked Pause. The persisted pause-cause and the kill of the active subprocess follow.

### `phase-paused`

The run is now persisted as paused.

### `phase-resumed`

The operator clicked Resume. The next dispatch will arm `--continue` for context preservation.

### `phase-restarted`

The operator chose to restart the active phase rather than resume from its mid-point.

### `phase-skipped`

The operator chose to skip the active phase. Advances to the next phase in the snapshot.

### `phase-disabled`

The operator disabled a phase via per-run overrides. The disable persists on the run; the snapshot itself is immutable.

### `phase-enabled`

Reverses a `phase-disabled`.

### `phase-removed`

A phase definition was removed from the operator's `schegent.phases` setting. Newly-enqueued runs will see the change; the in-flight run continues against its frozen snapshot.

## Queue control

Fourteen events covering the queue-level operator surface.

### `queue-created`

(Historical — v6 collapsed multi-queue mode. New events of this type are not emitted on current versions.)

### `queue-renamed`

(Historical.)

### `queue-deleted`

(Historical.)

### `queue-resumed`

The queue was resumed (mirror of the lifecycle `queue-paused` with `pauseSource`).

### `queue-settings-saved`

Queue-level settings were saved via the sidebar.

### `task-modified`

A pending task's description or phase overrides were edited.

### `task-removed`

A task was removed from the queue (history bucket or by bulk Clear).

Payload includes:
- `taskId`
- `runId` (when known)
- `sessionCleaned` — boolean. `true` iff the per-run session tree was successfully removed; `false` if the operator declined the cleanup, or if the cleanup failed.

The audit log itself is never modified by task removal.

### `task-reordered`

A pending task was moved to a new position. Payload:
- `queueId: 'default'` — always.
- `taskId`
- `fromPosition` / `toPosition` — integers.
- `source` — `'drag'` (drag-and-drop) or `'arrow'` (up/down arrow command).
- `outcome` — `'success'` or `'rejected'`.
- `cause` — optional. One of `'secondary-host'`, `'task-not-pending'`, `'invalid-position'`, `'no-op'` when the outcome is `'rejected'`.

### `task-moved`

(Historical — replaced by `task-reordered`. Preserved for legacy logs.)

### `task-canceled`

An operator-initiated task cancellation. Distinct from the controller-side `cancel` lifecycle event.

### `task-restarted-from-canceled`

A previously-canceled task was restarted by the operator.

### `task-enqueued`

A new pending task was created. Payload:
- `taskId`
- `queueId: 'default'`
- `via` — `'dashboard-submit'` | `'command-palette'` | `'rerun-from-history'`.

### `schedule-set`

(Historical — preserved for legacy logs.)

### `schedule-cleared`

(Historical.)

### `schedule-fired`

(Historical.)

## Phase message

The phase-message channel is a canonical sidecar file at `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/phase-message.env` used to pass small typed values between phases.

### `phase-message-emitted`

The phase wrote a readable phase-message sidecar. Payload carries metadata
only: `pipelineId`, `phaseId`, `entryCount`, `byteSize`, and the optional
`model`, `effort`, and `timeoutMs` fields when they were active for the
phase. The sanitized key/value map is consumed by the next phase through the
host prompt path and is not echoed into this audit event or the UI.

### `phase-message-truncated`

The phase-message file exceeded the whole-file byte cap. The host rejects the
sidecar for cross-phase forwarding and emits metadata only; raw file bytes are
left in the diagnostics directory for local inspection.

### `phase-message-invalid`

The phase-message sidecar could not be safely consumed. Reasons include
`malformed-lines`, `duplicate-keys`, `missing-sidecar`, `duplicate-sidecar`,
`path-outside-run-dir`, and `path-symlink-redirect`. Malformed content is
rejected; the file is preserved verbatim for local inspection when it exists.

## Fatal signature

### `fatal-signature-matched`

A fatal-signature substring matched the CLI's stdout or stderr. Payload:
- `signature` — the matched substring.

## State migration

### `workflow-run-repaired`

A persisted `WorkflowRun` snapshot was repaired during state initialization. Current repair payloads are structural only:
- `pipelineId`
- `repair`
- `removedPhaseCount`
- `removedBreakpointCount`
- `remainingPhaseCount`.
- `source` — `'built-in'` (the immutable code-resident registry) or `'operator-defined'` (an entry in `schegent.fatalSignatures`).
- `where` — `'stdout'` | `'stderr'`.

Built-in signatures win the attribution when both could match.

## Auto-compact override

### `auto-compact-override-applied`

Emitted when `schegent.claude.autoCompactPctOverride` is set to a valid integer and the CLI invocation has the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var merged. Payload: `runId`, `phaseId`, `value`.

## Phase log IPC

Three events recording the operator's phase-log-feed interactions.

### `phase-log-read`

The webview requested a phase log read. Payload carries the selection tuple `{ queueId, taskId, pipelineId, phaseId, iterationN }` plus the outcome.

### `phase-log-tail-started`

A live tail session was started.

### `phase-log-tail-stopped`

The tail session was stopped, either by the operator, by `task-leaves-in-flight`, or by a synthetic `tail-ended` push.

## Phase breakpoint

Three events covering the operator-set breakpoint lifecycle.

### `phase-breakpoint-set`

Payload: `runId`, `phaseId`, `actor` (`'operator'` | `'system'`).

### `phase-breakpoint-cleared`

Payload: `runId`, `phaseId`, `cause` (`'operator'` | `'consumed-by-fire'` | `'override-applied'` | `'run-ended'`).

### `phase-breakpoint-fired`

The runner hit the breakpoint and paused before the phase. Payload: `runId`, `phaseId`, `pipelineId`, `iterationN`.

## State migration

### `state-migrated`

Emitted by the state store on activation after a forward migration ran. Payload is structural (counts + booleans + enum literals); the v5 → v6 single-queue coalesce is the most operator-visible case.

## Workspace lifecycle

### `multi-root.warning-shown`

Emitted once at activation when the active workspace contains more than one folder AND `schegent.multiRoot.suppressWarning` is `false`. Records that the operator was informed of the canonical-folder rule. The audit emission strictly precedes the toast, so a notifier failure cannot drop the record.

Payload is primitive-only:

| Key | Type | Notes |
|---|---|---|
| `folderCount` | number | The total number of folders in the active workspace (always `>= 2` for this event). |
| `canonicalFolderName` | string | The `WorkspaceFolder.name` of the first folder. **Folder name only — never `fsPath`** (the [hard rule](../../../CLAUDE.md#hard-rules-when-changing-host-code) forbids path strings in audit payloads). |

The synthetic envelope uses `runId: 'workspace-activation'` and `phase: 'activation'` because the event is workspace-scoped, not run-scoped. See [The Workspace Lock → Multi-root workspaces](../concepts/workspace-lock.md#multi-root-workspaces).

## Schema versioning

`schemaVersion` on every audit event is currently `2`. The version bumps only when a payload field changes type or semantics; *additive* fields (new optional keys) do not bump the version.

Reader discipline is **warn-and-preserve**:

- Unknown `eventType` → log a warning, preserve the line in the file.
- Unknown `schemaVersion` → log a warning, preserve the line.

The audit log is therefore forward-compatible with future host versions. Old archives stay readable indefinitely.

## Outcome semantics

The `outcome` field on every event is one of `success`, `failure`, or `info`:

- `success` — the operation completed normally (e.g., a phase invocation that returned a clean exit).
- `failure` — the operation failed (e.g., a non-zero exit, a fatal signature match, a stall).
- `info` — neither success nor failure; the event is informational (e.g., `pause`, `resume`, `task-enqueued`).

Operators can grep for `"outcome":"failure"` to surface only the points where something went wrong.

The next reference page is [File Layout](file-layout.md).
