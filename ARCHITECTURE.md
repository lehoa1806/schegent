# Schegent Architecture

This is a code-level map of the Schegent VS Code extension as it stands
today. Read this before changing host structure, IPC contracts, or
persistence boundaries.

> **Synchronization**: this document is updated alongside any PR that
> touches host structure, IPC contracts, or persistence boundaries (see
> [CLAUDE.md](CLAUDE.md) "Project conventions" — Architecture drift).
> Last substantive update tracked the principal-architecture-hardening
> work on branch `056-principal-arch-hardening`.

## Top-level shape

```
VS Code Extension Host
├── extension.ts           — activate(), wires everything together
├── commands/              — VS Code command palette entrypoints
├── controller/            — workflow state machine + phase runner
├── runner/                — Claude CLI subprocess wrapper
├── monitor/               — live CLI monitor (stdout/stderr, stall, rate-limit)
├── parser/                — stdout/audit log parsers
├── queue/                 — feature request queue manager + queue registry
├── state/                 — workspace state, history, lock, workflow run
├── audit/                 — sanitized JSONL audit log writer + raw session transcript writer + verbose diagnostic writer
├── watchdog/              — credit watchdog (rate-limit recovery)
├── config/                — pipeline + phase catalog (dynamic-pipelines, 009)
├── lib/                   — sanitized logger, fatal-signature registry, retry-condition DSL, runtime-log sink (019)
├── ui/
│   ├── sidebar/           — Svelte sidebar + state projector + IPC router
│   ├── dashboard/         — full-window operator console
│   ├── status-bar.ts      — VS Code status bar projection
│   └── notifications.ts   — toast wrappers
└── contracts/             — single-source-of-truth typed contracts (see below)

webview-ui/                — Svelte 5 + Vite 5 build for both webviews
```

## Trust boundaries

Trust flows in one direction: **the host trusts itself; everything outside
is validated**.

- **Webview → host**: every inbound message is parsed by `MessageRouter`
  through hand-rolled type guards from `src/contracts/runtime-validators.ts`.
  Unknown shapes are rejected and audited as `audit.invalid_command`.
- **Host → webview**: snapshots are projected by `StateProjector` and
  pass through `logger.sanitize()` for every user-controllable string
  (`lastErrorSummary`, `pausedReason`, audit summaries).
- **CLI process**: invoked with `--dangerously-skip-permissions`. The
  spawned subprocess inherits environment but writes flow back through
  `parser/stdout-parser` and `monitor/claude-cli-monitor`, both of which
  pass each line through `logger.sanitize()` before the line reaches
  audit, projection, or UI.
- **Persistence**: queue/run state is stored in VS Code `workspaceState`;
  structured audit evidence is appended under `.schegent/audit.log`
  inside the open workspace folder; wake-up invocation/session logs live
  under the extension's global storage wake-up directory. Schemas are
  versioned (`AUDIT_SCHEMA_VERSION`, `STATE_SCHEMA_VERSION`). A separate
  raw session transcript is appended at
  `.schegent/sessions/raw-<runId>.log` per run — it is intentionally
  unredacted, gitignored, and never read back into memory or surfaced to a
  webview (see [docs/security/threat-model.md](docs/security/threat-model.md)
  T8).

## Main components

### Workflow controller (`src/controller/workflow-controller.ts`)

Owns the workflow state machine. Drives one run from `specify` through
`finalize`. Responsibilities:

- Acquire/release the workspace lock around a run.
- Validate input (CLI available, scaffold present, description) BEFORE
  acquiring the lock when possible; run `driveRun()` inside
  `WorkspaceLockManager.withLock()`. Terminal paths release through the
  wrapper's `finally`; pause-style exits call `session.retain()`.
- Persist phase transitions to `WorkspaceStateStore`.
- Append `phase-start` / `phase-end` audit entries.
- Delegate the history-write side effect at every terminal transition
  to `HistoryRecorder` (`src/services/history-recorder.ts`).
- Delegate the auto-drain four-step gate (paused → inFlightId →
  peekNextPending → lock.tryAcquire → controller.startNew) to
  `AutoDrainCoordinator` (`src/services/auto-drain-coordinator.ts`).
- Enforce per-run phase overrides (`skipped` / `disabled` / `removed`) without
  mutating the frozen `WorkflowRun.pipeline` snapshot.
- Provide each phase invocation with the canonical
  `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/phase-message.env`
  sidecar path and inject only the immediately preceding phase's
  sanitized flat key/value message into the next prompt.
- Feature 028 — own the future-phase breakpoint state machine. `setPhaseBreakpoint(runId, phaseId)`
  appends a one-shot `PhaseBreakpoint` to the run, validated per Decision 10 (phase
  exists in the immutable pipeline, not active/completed, no override action, not
  already armed). `clearPhaseBreakpoint(runId, phaseId)` removes it. The
  `pauseActivePhase(runId)` path now also calls `QueueManager.cascadedPause()`
  on the run's queue; `resumeActivePhase(runId)` calls `QueueManager.cascadedResume()`
  (no-op when the queue is operator-paused). When a downstream phase fires
  (see Phase runner), `driveRun()` filters the consumed entry, sets
  `manualPauseCause = 'breakpoint-paused'` + `resumeTargetPhaseId = phaseId`,
  cascade-pauses the queue, and releases the lock. Run termination
  paths (`completed`/`failed`/`cancelled`) clear all remaining breakpoints
  and emit `phase-breakpoint-cleared { cause: 'run-ended' }` per entry.
  Applying a `skipped`/`disabled`/`removed` override on a phase that has
  a breakpoint auto-clears the breakpoint with cause `'override-applied'`.

Feature 013 Wave 7 (US7) decomposed two well-contained concerns into
their own service modules to shrink the controller's surface area:

- `HistoryRecorder` — owns the `historyStore.append` +
  `buildHistoryEntry` plumbing + error swallowing. Sanitization happens
  inside `buildHistoryEntry` via the injected logger (FR-029
  sanitize-once invariant).
- `AutoDrainCoordinator` — owns the four-step gate that promotes the
  next pending feature when a run terminates.

The `driveRun()` state-machine loop and the delayed-retry surface
(watchdog + rate-limit handler) deliberately remain inline. See
[specs/013-correctness-trust-refactor/decisions.md](specs/013-correctness-trust-refactor/decisions.md)
"Wave 7 — scope deviation: T096 and T097 NOT extracted" for the
rationale (byte-identical audit-event sequencing requirement and the
lock-retain/release invariant).

### Phase runner (`src/controller/phase-runner.ts`)

Spawns the Claude CLI for a single phase prompt, captures stdout/stderr,
applies output cap and timeout, and emits a `PhaseResult`.

Feature 017 keeps the deterministic stdout contract intact by treating
inter-phase messages as an optional sidecar. The runner first probes the
host-computed canonical `phase-message.env` path under the current run's
diagnostics directory. If it must consider audit-reported
`files_created` / `files_modified` candidates, each candidate must
canonicalize to that same path; outside paths are rejected with
`phase-message-invalid`. The raw file is capped at 4096 UTF-8 bytes.
Values are sanitized through the logger before downstream prompt
consumption; audit events carry metadata only
(`phase-message-emitted`, `phase-message-truncated`,
`phase-message-invalid`) and never include message values.

Feature 028 adds a no-cache `PhaseBreakpointAccessor` (mirrors the pattern
of `VerboseDiagnosticsAccessor` / `FatalSignaturesAccessor` /
`AutoCompactOverrideAccessor`). At the top of every `run()`, the runner
reads the accessor — a `ReadonlySet<string>` of armed phase ids. If the
about-to-run phase id is in the set, the runner appends a
`phase-breakpoint-fired` audit event with `{runId, pipelineId, phaseId,
iterationN}` and returns `{ outcome: 'paused-at-breakpoint', phaseId }`
BEFORE any CLI spawn. The runner never mutates `WorkflowRun.phaseBreakpoints`
directly — only `WorkflowController` writes that state.

### Backend runners (`src/runner/`)

`BackendRunnerFactory` selects the concrete subprocess adapter from
`schegent.backend.runner`. The default `claude` adapter owns the Claude
CLI lifecycle in `src/runner/claude-cli.ts`; the `codex` adapter owns the
Codex CLI lifecycle in `src/runner/codex-cli.ts`. Both implement the same
controller-facing runner contract so backend selection does not change
workflow orchestration. Operational details live in
`docs/operations/backends.md`.

### CLI monitor (`src/monitor/claude-cli-monitor.ts`)

Tails the running subprocess, emits live structured events to the audit
pipeline (`monitor-stdout-line`, `monitor-stderr-line`, `monitor-stall`,
`monitor-rate-limited`, `monitor-progress`, `monitor-invocation-summary`).
All output is sanitized before append.

### Queue manager (`src/queue/queue-manager.ts`)

Single source of truth for `FeatureRequest` items. Status taxonomy:
`pending | in-flight | completed | failed | cancelled`. The literal
`"running"` is **not** used — it has been canonicalized to `"in-flight"`.

`finish()` records a `SanitizedFailureMetadata` (`{ code, message, phase,
correlationId }`) on failure, sanitized through `logger.sanitize()`.

Feature 030 collapsed the queue surface to single-queue mode. The
`QueueRegistry` retains its shape (the entry carries id/state/pauseSource)
but now persists exactly one entry — the canonical `'default'` queue —
with `MAX_QUEUES = 1` and `schedule = null`. The v6 schema invariant in
[src/queue/queue-registry.ts](src/queue/queue-registry.ts)
`validateQueueRegistry()` rejects multi-entry registries, non-default ids,
non-zero `position`, and any non-null `schedule`. The multi-queue
management surface (`createNamedQueue`, `renameNamedQueue`,
`deleteNamedQueue`, `moveTask`, `setSchedule`, `clearSchedule`) and
the seven multi-queue IPC commands (`CMD_CREATE_QUEUE`,
`CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`, `CMD_SET_QUEUE_SCHEDULE`,
`CMD_CLEAR_QUEUE_SCHEDULE`, `CMD_SAVE_QUEUE_SETTINGS`, `CMD_MOVE_TASK`)
were dropped. The task-level mutators (`reorderTask`, `modifyTask`,
`removeTask`, `retry`) and the pause-control surface (`setQueuePausedState`,
`cascadedPause`, `cascadedResume`) remain.

`peekNextPending()` walks the single `'default'` entry, returning `null`
when the entry is `manually-paused`. Queue-level pause can set
`WorkflowRun.manualPauseCause = 'queue-paused-mid-run'` only for the
matching in-flight task; queue resume clears only that queue-sourced
cause.

Feature 022 widens task deletion from pending-only removal to confirmed
all-status removal. `QueueManager.removeTask()` returns the task id, queue id,
prior status, and run id for audit attribution. Deleting an in-flight task
routes through `SchegentWorkflowController.deleteTask()` so the active
controller is aborted, the run is marked canceled, the lock is released, and
the task row is removed from subsequent snapshots.

Feature 028 adds `QueueRegistryEntry.pauseSource: 'operator' | 'cascade' | null`
(null iff `state !== 'manually-paused'`) and two internal helpers:
`cascadedPause(queueId)` sets `state: 'manually-paused', pauseSource:
'cascade'`; `cascadedResume(queueId)` flips back to `state: 'active',
pauseSource: null` ONLY when current `pauseSource === 'cascade'`. The
operator-wins guarantee — an operator-initiated queue pause survives a
phase resume — depends on this no-op-when-`pauseSource !== 'cascade'`
behavior. The existing `queue-paused` / `queue-resumed` audit events
carry a required `source: 'operator' | 'cascade'` field after 028.

The `ScheduleWatchdog` (`src/controller/schedule-watchdog.ts`) and
`QueueManager.fireDueSchedules()` are retained but a no-op in
single-queue mode (the registry never carries a schedule under v6).

### State store (`src/state/workspace-state.ts`)

Wraps VS Code `workspaceState`. Schema-versioned: writes both
`schemaVersion` (numeric) and `schemaVersionString` on every persist.
`initialize()` rejects state from a future runtime version with a
hard error; older versions migrate forward best-effort.

Stores `WorkflowRun`, queue, lock, history (capped at `HISTORY_CAP`),
and watchdog state.

State schema v3 includes queue registry/settings, queue-aware task position,
`WorkflowRun.phaseOverrides`, and the `manualPauseAt` /
`manualPauseCause` both-null-or-both-non-null invariant. State schema v4 adds
the `removed` phase override action plus optional `priorPhaseState` metadata.
Removed phases are task-scoped state: projections hide them and execution skips
them without mutating `WorkflowRun.pipeline`. State schema v5 (feature 028)
adds `WorkflowRun.phaseBreakpoints` (one-shot future-phase markers),
`WorkflowRun.resumeTargetPhaseId` (non-null iff `manualPauseCause ===
'breakpoint-paused'`), and `QueueRegistryEntry.pauseSource`
(`'operator' | 'cascade' | null`, null iff `state !== 'manually-paused'`).
State schema v6 (feature 030) is the single-queue collapse: the v5 → v6
migrator in
[src/state/queue-state-migrator.ts](src/state/queue-state-migrator.ts)
`migrateV5ToV6()` coalesces any persisted multi-queue registry into the
single `'default'` entry, rewrites every `FeatureRequest.queueId` to
`'default'`, densely repositions pending tasks by source queue
`createdAt` ascending (then within-queue position), preserves the
single in-flight task (defensively demoting any extras), inherits a
`manually-paused` queue state if **any** source queue carried one,
clears the (now-unsupported) schedule field, and rewrites the
`WorkflowRun.queueId` field to `'default'`. The migrator emits a
single `state-migrated` audit event with
`{ fromVersion: 5, toVersion: 6, sourceQueueCount, pendingTaskCount,
inFlightTaskCount, inheritedPausedState, coalesceRule: 'createdAt-ascending' }`.
The migrator is idempotent — a second activation on v6 state is a no-op.

### State migration history

| From | To | Trigger | What changes |
|------|----|---------|--------------|
| pre-v1 | v1 | initial introduction | numeric `schemaVersionNumeric` written alongside the string `schemaVersion` |
| v1 | v2 | feature 011 | `delayedRetryCount`, `pendingRetryAt`, `pendingRetryCause` on `WorkflowRun` (both-null-or-both-non-null invariant) |
| v2 | v3 | feature 017 | queue registry / settings shape; queue-aware `FeatureRequest.queueId` + `position`; `WorkflowRun.phaseOverrides`; `manualPauseAt` / `manualPauseCause` |
| v3 | v4 | feature 022 | `removed` phase override action + optional `priorPhaseState`; task-scoped phase deletion |
| v4 | v5 | feature 028 | `WorkflowRun.phaseBreakpoints`, `WorkflowRun.resumeTargetPhaseId`, `QueueRegistryEntry.pauseSource` |
| v5 | v6 | feature 030 | multi-queue → single-queue collapse; `MAX_QUEUES = 1`; rewrites all `queueId` fields to `'default'`; clears registry schedule |

### Lock (`src/state/lock.ts`)

`tryAcquire`/`release` over `WorkspaceLock` with an `ownerId` and
heartbeat. `release()` is idempotent: a no-op when the lock is already
released or owned by someone else. Stale locks beyond
`STALENESS_THRESHOLD_MS` are reclaimable.

### Pipeline catalog (`src/config/`)

In-memory source of truth for the active phase + pipeline definitions
(spec 009). The catalog is a snapshot derived from VS Code's
configuration system with workspace > user > built-in precedence:

- `pipeline-config.ts` — pure types (`PhaseDef`, `PipelineDef`,
  `PipelineCatalog`), constants (`BUILT_IN_PHASES`, `BUILT_IN_PIPELINES`,
  `BUILT_IN_CATALOG`, `BUILT_IN_PIPELINE_ID`), and pure functions
  (`mergeCatalog`, `validateCatalog`, `buildCatalog`).
- `pipeline-config-loader.ts` — `loadCatalog(reader?)` ingests the three
  `schegent.phases` / `schegent.pipelines` / `schegent.defaultPipelineId`
  settings keys, coerces them through hand-rolled runtime validators,
  merges with built-ins, and falls back to `BUILT_IN_CATALOG` on any
  validation error.

The catalog is loaded once per activation and re-loaded on configuration
change. In-flight `WorkflowRun` records carry a frozen
`WorkflowRun.pipeline` snapshot of the active `PipelineDef` plus the
referenced `PhaseDef[]` so that mid-run settings edits cannot retarget
or mutate a live run (FR-013). New runs always start from the latest
catalog snapshot.

Custom phases flow through the **same** redaction set, audit pipeline,
and raw-transcript writer as built-in phases — no new code path bypasses
`appendAudit` or its sanitization point. Custom-phase invocations emit
`pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs`
on their audit payloads. See
[docs/security/threat-model.md](docs/security/threat-model.md) T9.

### Per-phase Effort + Bugfix pipeline (feature 026)

Feature 026 extends the catalog without changing its shape:

- **Built-ins**: `BUILT_IN_PHASES` grows from 8 → 13 entries (the new
  `bugfix-report`, `bugfix-patch`, `bugfix-verify-pre`,
  `bugfix-implement`, `bugfix-verify-post` join). `BUILT_IN_PIPELINES`
  grows from 1 → 2 entries (`speckit-new-feature` plus a new
  `speckit-bugfix` whose `phases` array is the 5-tuple above).
  `BUILT_IN_PIPELINE_ID` remains `'speckit-new-feature'` — the default
  enqueue target is unchanged (FR-019 catalog-merge surfaces +
  research Decision 3 default-preservation).
- **Precedence projection** ([src/config/phase-precedence.ts](src/config/phase-precedence.ts)) —
  a **pure host-side projection module** (no I/O, no `vscode` import)
  that walks the union of phase ids × the 5 per-phase tunable keys
  (`model`, `effort`, `timeoutSeconds`, `loopable`, `retryCondition`)
  and emits a plain `Record<string, 'workspace' | 'user' | 'built-in'
  | 'unset'>` keyed by `"<phaseId>::<fieldKey>"`. The result rides
  the existing snapshot envelope under `phasePrecedence?` (additive —
  no `AUDIT_SCHEMA_VERSION` or `STATE_SCHEMA_VERSION` bump) and is
  **never persisted or logged**: UI-only.
- **Webview consumption** — the augmented
  [PipelineBuilder.svelte](webview-ui/src/components/PipelineBuilder.svelte)
  reads `snapshot.phasePrecedence` and renders the precedence badge
  inline next to the Effort + Model controls; it never recomputes
  precedence locally. The single CMD_SAVE_PHASES call site is the
  shared helper at
  [webview-ui/src/lib/save-phases.ts](webview-ui/src/lib/save-phases.ts).
- **Run-time emission** — `PhaseRunner` already emits `model` and
  `effort` on `phase-start` from the immutable
  `WorkflowRun.pipeline` snapshot's frozen `PhaseDef`. Feature 026
  added the `PhaseStartPayload` type contract in
  [src/contracts/audit-events.ts](src/contracts/audit-events.ts) so
  downstream consumers see the schema without runtime drift. Absent
  fields are omitted (no empty strings, no `null`); the existing
  single sanitization point handles redaction.
- **Verify-fail pause** — `bugfix-verify-pre` and `bugfix-verify-post`
  are `loopable: false` with no `retryCondition`. The
  workflow-controller pauses the run via the existing `phase-paused`
  cause on a non-clean verify outcome (FR-016 reuse, no new
  literal); resume re-invokes the same failed verify phase rather
  than silently advancing to the next phase.

No new IPC command was added (the existing `CMD_SAVE_PHASES` carries
the new optional fields per-row); no state-schema migration was
required (catalog and immutable-run-snapshot shapes are unchanged).

### Audit pipeline (`src/audit/audit-log-writer.ts`)

Append-only JSONL writer with:

1. **Single-sanitization point**: `logger.sanitizeRecord(entry)` runs
   once. The same sanitized payload is then written to disk **and**
   delivered to subscribers. There is no code path where listeners see
   raw fields.
2. **Schema versioning**: `schemaVersion: AUDIT_SCHEMA_VERSION` and
   `correlationId: entry.correlationId ?? entry.runId` are stamped on
   every entry.
3. **Rotation**: `audit.log` rotates at `rotationSizeBytes` (5 MB
   default) or `rotationMaxAgeMs` (30 days default).
4. **Retention**: rotated archives are pruned to the most recent
   `retentionMaxArchives` (10 default) and not older than
   `retentionMaxArchiveAgeMs` (90 days default).

Feature 017 queue, schedule, task, phase-control, and phase-message events
all use the same append path. Queue/control events include operator/system
actor attribution and state-transition envelope fields; phase-message audit
events expose metadata only. Feature 022 extends this surface with
`task-removed` payloads that include `priorStatus` and `runId`, and with
`phase-removed` for task-scoped phase deletion. Deletion never removes prior
audit entries, raw transcripts, or verbose diagnostic files.

### Raw session transcript writer (`src/audit/raw-transcript-writer.ts`)

Parallel to the structured audit pipeline, but **strictly separate**.
`PhaseRunner` wraps every `runner.invoke()` call with
`appendStart()` (header + verbatim prompt) before the spawn and
`appendEnd()` (verbatim stdout/stderr + exit code) after the spawn —
including on the timeout and cancel branches. Writes target
`<workspaceRoot>/.schegent/sessions/raw-<runId>.log`, one file per
workflow run, append-only, no rotation, no retention, no sanitization.

The writer is best-effort: I/O failures (read-only FS, EACCES, ENOSPC)
are caught and surfaced once per `runId` as a warn-level audit log
line and never abort the workflow run. Per-`runId` write chains
(`Map<string, Promise<void>>`) preserve start-then-end ordering even
under concurrent runs.

This file is **never** read back by the host, **never** plumbed into
any webview/dashboard/output channel, and **never** sanitized — the
single sanitization point at `src/audit/audit-log-writer.ts` remains
the source of truth for the structured, exfil-safe audit pipeline.
The raw transcript is the developer-debug equivalent of terminal
scrollback. See [docs/security/threat-model.md](docs/security/threat-model.md)
T8 for the trust boundary and
[docs/operations/inspect-raw-transcripts.md](docs/operations/inspect-raw-transcripts.md)
for the operator guide.

### Verbose diagnostic writer (`src/audit/verbose-diagnostic-writer.ts`)

A **sibling sink** to the raw-transcript writer (not a replacement),
gated entirely on the workspace setting `schegent.logging.verbose`
(default `false`). When enabled, `PhaseRunner` constructs a
`VerboseDiagnosticTarget` per invocation and threads it into the CLI
runner, which appends `--debug-file <debugFile>`,
`--output-format stream-json`, and `--verbose` to the spawn argv and
tees CLI stdout / stderr into the corresponding sibling files:

```
<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
                                          ├── debug.json     (CLI --debug-file payload)
                                          ├── stream.jsonl   (teed stdout — stream-json events)
                                          └── verbose.log    (teed stderr — verbose trace)
```

The setting is read at `PhaseRunner.run()` entry on every invocation
(never cached) so toggling mid-run applies to the next phase. Writes
are **best-effort and unredacted**: directory or per-file failures
fold into a single one-shot warning per slot appended to
`AuditEntryFields.warnings`, never failing the run. The structured
`.schegent/audit.log` is byte-identical between verbose-on and
verbose-off runs of the same fixture (excluding wall-clock timestamps
and run-scoped IDs). Feature 008's `raw-<runId>.log` is independent
and continues to be written in both modes. See
[docs/security/threat-model.md](docs/security/threat-model.md) T10.

### Runtime log sink (`src/lib/runtime-log/`, feature 019)

A **third** sink in the logging surface (sibling to `.schegent/audit.log`
and the verbose diagnostic files), driven by an operator-configurable
severity filter and file path. Module layout:

```
src/lib/runtime-log/
├── runtime-log-level.ts     — 4-level ladder DEBUG<INFO<WARN<ERROR + `shouldEmit()`
├── runtime-log-path.ts      — path resolver (default `<workspace>/.schegent/syslog`)
├── runtime-log-settings.ts  — RuntimeLogAccessor: `read() => { level, path } | null`
└── runtime-log-sink.ts      — LogSink implementation with retry-once-via-mkdir + per-path suppression map
```

`SanitizedLogger.addSink(runtimeLogSink)` registers the sink at activation.
On every emit, the sink reads the accessor — never cached, mirrors
`VerboseDiagnosticsAccessor` / `FatalSignaturesAccessor` /
`AutoCompactOverrideAccessor` — and:

1. If the accessor returns `null` (path unresolvable, e.g. no workspace
   open), the line is dropped silently.
2. The level token parsed from the formatted line is compared against
   the configured filter via `shouldEmit()`; a short-circuit BEFORE
   any formatting work keeps the DEBUG-on hot path allocation-light.
3. `fs.promises.appendFile(path, line + '\n')` writes the redacted
   line (the sink reuses `SanitizedLogger`'s output — `SECRET_PATTERNS`
   stays the single source of truth; the sink never forks redaction).
4. On `ENOENT` (missing parent directory), the sink calls
   `mkdir(dirname, { recursive: true })` and retries **once**.
5. On any other failure (`EACCES`, `EROFS`, unknown), a one-shot WARN
   is emitted through the fallback logger and the (path, cause) pair
   is recorded in the suppression map. Subsequent emits for the same
   path are dropped silently until `clearSuppression(path)` is invoked.
6. `clearSuppression(path)` is invoked from the post-save callback in
   `writeGeneralSettings` whenever either `schegent.logging.runtimeLogLevel`
   or `schegent.logging.runtimeLogFilePath` is mutated, so an operator's
   correction (level change, path change, permission fix) unlocks the
   next emit.

Writes are per-path serialized via an internal write-chain Map so emits
arriving during an in-flight ENOENT-recovery wait for recovery to land
before issuing their own `appendFile`. POSIX guarantees write atomicity
up to PIPE_BUF (≥ 512 bytes) for append-mode writes; the chain is the
cross-platform belt-and-suspenders for emit bursts.

The path defaults to `<workspaceRoot>/.schegent/syslog` (resolved by
`runtime-log-path.ts`); operators may override to an absolute path or
a workspace-relative path. Relative paths containing `..` are rejected
at validator time (the same `KEY_SPECS` validator in
`src/config/general-settings.ts` that gates every other dotted-key
setting). The runtime-log sink is the ONLY component in the codebase
authorised to `fs.appendFile(...)` against a syslog path — enforced
by the grep regression at
[tests/lint/no-direct-syslog-fs-writes.test.ts](tests/lint/no-direct-syslog-fs-writes.test.ts).
See [docs/operations/runtime-log.md](docs/operations/runtime-log.md)
for the operator guide and
[docs/security/threat-model.md](docs/security/threat-model.md) T19 for
the threat surface.

### Phase log feed (`src/services/phase-log/`, feature 020)

A host-side adapter that turns the per-phase verbose diagnostic
`stream.jsonl` files (written by the verbose diagnostic writer above)
into the Dashboard's Activity Feed. The bytes on disk are NEVER
altered — sanitization is layered on at the host → webview IPC
boundary so the operator-opt-in diagnostic sink stays intentionally
unredacted (010 T10 invariant). Module layout:

```
src/services/phase-log/
├── phase-log-path.ts                 — pure path composition (no I/O)
├── phase-log-iteration-discovery.ts  — directory scan, iter-N most-recent-first
├── phase-log-jsonl-parser.ts         — \n-delimited JSONL with partial-line buffer
├── phase-log-display-projector.ts    — drops framing kinds, keeps text/tool_use/tool_result/system/result
├── phase-log-truncator.ts            — per-field UTF-8 byte cap (default 4096) with codepoint snap
├── verbose-diagnostics-detector.ts   — derives the empty-state banner kind
├── phase-log-reader.ts               — composes the above into one manifest read
├── phase-log-service.ts              — validates the selection tuple against the snapshot, drives the reader
├── phase-log-tail-session.ts         — per-session offset/seq/partial-line state + `tick()` + synthetic `tail-ended`
├── phase-log-tail-registry.ts        — cap-of-1 invariant, fs.watch (with polling fallback), audit emit
├── types.ts                          — `PhaseLogDisplayEntry`, `IterationManifest`, `PhaseLogReadResult`
└── index.ts                          — barrel re-exports
```

Sanitization is performed at exactly TWO places, both inside the
service module, both using the injected `sanitize` callback (which is
always `SanitizedLogger.sanitize`): `phase-log-reader.ts` for the
manifest read, and `phase-log-tail-session.ts` for the live tail push.
Order is fixed: project (drop framing) → truncate (bound size) →
sanitize (final boundary scrub). A second sanitizer is forbidden;
double-sanitization is forbidden.

Tail-session lifecycle:

1. `CMD_START_PHASE_LOG_TAIL` invokes `PhaseLogTailRegistry.start()`.
   The registry validates the file exists, disposes any prior session
   (cap-of-1), and constructs a new `PhaseLogTailSession`. The
   watcher mechanism is decided here: `fs.watch` first, polling
   (`setInterval(500ms).unref()`) when `fs.watch` throws.
2. Each watcher event triggers `session.tick()`, which reads bytes
   from the current offset, parses, projects, truncates, sanitizes,
   stamps an entry-seq, and emits a `MSG_PHASE_LOG_ENTRY` push.
3. Three teardown paths emit a synthetic `tail-ended` push with a
   distinct `reason`:
   - `webview-stop` — operator-initiated stop (cap-of-1 swap or
     `CMD_STOP_PHASE_LOG_TAIL`)
   - `webview-dispose` — webview view disposed
   - `phase-complete` — `onTaskNoLongerInFlight` signal fires for the
     tail's `runId` (the active task left the in-flight slot)
4. Both `phase-log-tail-started` and `phase-log-tail-stopped` audit
   events are emitted with `{sessionId, queueId, taskId, pipelineId,
   phaseId, iterationN, mechanism?, reason?, outcome}`. Audit
   payloads are paths-free — only the selection tuple + counts +
   outcome cross the audit boundary.

The activity feed component (`webview-ui/src/components/PhaseLogFeed/`)
drives the cascade Queue → Task → Phase, the iteration stepper, and
the reading pane; the per-instance store in
`webview-ui/src/lib/phase-log-store.svelte.ts` owns the manifest cache
and the tail-session correlation. When the operator's selection
resolves to (a) the latest known iteration, AND (b) the in-flight
task, AND (c) the in-flight task's `currentPhase`, the feed
auto-attaches a tail via `CMD_START_PHASE_LOG_TAIL`.

See specs/020-phase-level-logs/contracts/phase-log-ipc.md for the wire
contracts and contracts/phase-log-service.md for the host-side
projection rules.

### Claude auto-compaction percentage override (feature 012)

`PhaseRunner` takes an additional ctor parameter
`AutoCompactOverrideAccessor` (mirrors `VerboseDiagnosticsAccessor` and
`FatalSignaturesAccessor`): a `() => number | null` accessor that reads
the `schegent.claude.autoCompactPctOverride` workspace setting fresh at
the top of every `PhaseRunner.run()` (never cached). When the accessor
returns an integer in `[1, 100]`, the runner exports
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<n>` into the spawn environment of the
Claude CLI subprocess so the CLI compacts context at the configured
threshold; when the accessor returns `null` or an out-of-range value,
the env var is omitted and the CLI uses its built-in default. The
override flows through the existing `CMD_SAVE_GENERAL_SETTINGS`
primary-only IPC gate (no new mutating command, no trust-boundary
change). See
[`docs/operations/configuration.md`](docs/operations/configuration.md)
for the operator surface.

### Fatal signature registry (`src/lib/fatal-signature-registry.ts`)

Code-level allowlist of fatal CLI substrings that should fail-fast
the active phase regardless of exit code. The v1 registry is a
`Object.freeze`-d array (`"You're out of extra usage"`, `"error: unknown option"`).
Public surface: `FATAL_SIGNATURES`, `getEffectiveSignatures(operatorAdditions)`,
the type aliases (including `EffectiveSignature`, `FatalSource`), and
`classifyFatal(stdout, stderr, effective?)` — adding a code-resident
signature is a single edit to the array with no parser, controller,
or audit-pipeline change.

**Feature 011 extension — operator-additive merge (FR-033 / FR-038)**:
Operators MAY contribute additive entries via the
`schegent.fatalSignatures` workspace setting. `getEffectiveSignatures()`
merges built-ins first (canonical order, attributed `built-in`) with
operator additions (insertion order, attributed `operator-defined`,
deduped against built-ins and each other). The returned array is
frozen. The code-resident floor cannot be removed or re-ordered by
operator config — the CLAUDE.md 010 T12 hard rule on the floor stays
in force. The merge is computed per-invocation (read fresh from
`schegent.fatalSignatures` every call, never cached) so operator edits
take effect on the next CLI invocation — same pattern as
`schegent.logging.verbose`.

`classifyFatal` scans stdout and stderr independently
(`String.includes`, deterministic stdout-first order) and never
concatenates streams. Built-ins-first ordering guarantees the
built-in `source` wins when both a built-in and an operator addition
would match the same text. The classifier is called from
`src/parser/stdout-parser.ts` **before** contract-block detection;
a match maps directly to a `failed` `PhaseOutcome` in `PhaseRunner`
and flows through the existing `decision.kind === 'halt'` branch in
`WorkflowController.driveRun()` so the lock-release path is unchanged.
The matched signature text reaches `payload.cause` on the `phase-end`
event AND a dedicated `fatal-signature-matched` audit event carrying
`{ signature, source }` is emitted (FR-037). Sanitization runs once
at `audit-log-writer.ts`.

### Retry-condition DSL (`src/lib/retry-condition.ts`)

Sandboxed boolean expression evaluator that drives per-phase loop /
advance decisions for custom phases. Operators declare
`retryCondition: "<expression>"` on `schegent.phases[]` entries.
Grammar (normative EBNF at
[specs/010-pipeline-resilience/contracts/retry-condition-grammar.ebnf](specs/010-pipeline-resilience/contracts/retry-condition-grammar.ebnf)):

- Identifiers, signed numeric literals, comparisons
  (`> >= < <= == !=`), logical combinators (`and / or / && / ||`),
  unary `not / !`, parentheses.
- No arithmetic, no function calls, no member access, no chained
  comparisons, no unary `-` on identifiers — by design.
- Operator precedence: `not`/`!` > comparisons > `and`/`&&` > `or`/`||`.

Public surface: `validate(source) → ParseResult` (used by
`pipeline-config-loader.ts` to strip malformed expressions at load
time with a single host-logger warning), and
`evaluate(expression, metrics) → EvaluatorResult` (used by
`phase.ts` `transition()` on every well-formed parser outcome).
`evaluate` **never throws** — runtime failures return
`{ ok: false, error }` and the controller treats them as advance.
The audit-log parser captures top-level `<identifier>: <number>`
lines into `AuditEntryFields.metrics` (whitespace-tolerant, finite-only,
last-occurrence-wins, identifier-pattern-gated, reserved-key-excluded).
Cap exhaustion with a truthy expression on the final permitted
invocation halts the phase with `payload.cause: "cap_exhausted"`.

### Audit event additions (010)

- **`phase.retry_evaluated`** (envelope `outcome: 'info'`) — emitted
  once per consulted decision with `payload.expression`,
  `payload.metrics`, `payload.decision` (loop=true / advance=false),
  and on the runtime-error path `evaluationError: true` plus a
  sanitized `errorMessage`. Not emitted when the parser outcome is
  `malformed`. The dot-style identifier is deliberate (it is the only
  audit event added since the existing kebab-style set; further
  additions should match the prevailing case for that subsystem).
- **`phase-end` extension** — optional `payload.cause?: string`
  field. Populated by US1 (verbatim redacted fatal signature) and
  US2 (`"cap_exhausted"`). Absent for generic phase failures.

### Audit event additions (011)

- **`retry-scheduled`** (envelope `outcome: 'info'`) — emitted when a
  non-fatal failure is classified as `transient_error` (15-min backoff)
  or `rate_limit` (60-min backoff). Payload carries `cause`,
  `delayedRetryCount`, `pendingRetryAt`, and `pipelineId/phaseId`.
- **`retry-manual`** — emitted when "Retry Phase Now" cancels the
  pending timer; resets `delayedRetryCount` to 0.
- **`retry-recovered`** — emitted when a previously delayed phase
  exits cleanly; carries the recovered counter.
- **`queue-paused`** — emitted when 5 consecutive delayed retries are
  exhausted (`DELAYED_RETRY_CAP`) and the queue is paused with
  `pausedReason: retry-cap-exhausted:<runId>`.
- **`fatal-signature-matched`** (envelope `outcome: 'failure'`) —
  carries `{ signature, source: 'built-in' | 'operator-defined' }` per
  FR-037; emitted from `PhaseRunner` immediately after `parseInvocation`
  returns a malformed result with a `fatalCause`. Sanitization of the
  matched signature flows through the single `audit-log-writer.ts`
  sanitization point.

### Delayed-retry state machine (011)

`WorkflowRun` gained three new optional fields (`delayedRetryCount`,
`pendingRetryAt`, `pendingRetryCause`) guarded by the
`STATE_SCHEMA_VERSION` migrator at `src/state/workflow-run-migrator.ts`.
Invariant: `pendingRetryAt` and `pendingRetryCause` are either both
`null` or both non-null (asserted in `setRun()`). The pending timer is
held by `CreditWatchdog`; the new
`cancelPendingTimer()` method lets `retryPhaseNow` clear it without
touching the persisted state directly (the controller does that). The
constants live in `src/controller/retry-constants.ts`
(`TRANSIENT_BACKOFF_MS`, `RATE_LIMIT_BACKOFF_MS`, `DELAYED_RETRY_CAP`).

### Context-preserving retries (032)

The Claude CLI accepts a `-c` (`--continue`) short flag that resumes the
prior conversation rather than starting fresh. Feature 032 wires this
across the controller's dispatch matrix so a delayed retry or a manual
resume preserves long-running session context (especially valuable for
`speckit-implement`):

- **Carrier** — two additive optional booleans:
  - `InvocationRequest.isContinue?: boolean` in
    `src/runner/invocation-result.ts`.
  - `PhaseRunInputs.isContinue?: boolean` in
    `src/controller/phase-runner.ts`.
- **Source** — `SchegentWorkflowController` owns a private
  `nextDispatchIsContinue` instance flag. It is armed at retry/resume
  entry points (`retryPhaseNow`, `resumeActivePhase`, and inside
  `resumeExisting` when the persisted run has a non-null pause-cause
  or pending-retry-cause). `driveRun()` consumes the flag on the first
  `runner.run()` call and resets it immediately so subsequent loop
  iterations and phase advancements within the same `driveRun`
  invocation revert to `isContinue: false`.
- **Effect** — `ClaudeCliRunner.invoke` appends `-c` to `baseArgs`
  immediately after `--dangerously-skip-permissions` and immediately
  before the transport-specific flag (`-p`, `--prompt-file`,
  `--prompt-stdin`) when `request.isContinue === true`. The gate is
  strict equality (truthy-non-boolean values do NOT trigger the
  append).
- **Negative cases** — `restartActivePhase`, `startNew`, loop
  iterations, and bugfix-loop iterations deliberately do NOT arm the
  flag. They produce argv without `-c`.
- **Audit projection** — every `phase-start` audit payload now carries
  a mandatory `isContinue: boolean` field (additive; no
  `AUDIT_SCHEMA_VERSION` bump). The `PhaseStartPayload` interface in
  `src/contracts/audit-events.ts` was extended. The field uses the
  same strict `=== true` gate as the runner, so the audit record and
  the spawned argv stay in lock-step. The boolean flows through the
  existing `SanitizedLogger.sanitize` pipeline unchanged.
- **Carrier types and tests** — see `specs/032-context-preserving-retries/`
  for the full spec, plan, contracts, and quickstart; the integration
  smoke is at `tests/integration/continue-flag-end-to-end.test.ts`.

### Aggressive phase pausing and process telemetry (033)

Feature 033 layers two thin additions onto the existing pause/resume and
CLI-runner machinery:

- **Aggressive pause (US1)** — `SchegentWorkflowController.pauseActivePhase()`
  inserts `this.cancelActive()` between `store.setRun(updated)` and the
  `phase-pause-requested` audit event. The existing `AbortController`
  plumbing through the runner sends SIGTERM to the live Claude CLI
  subprocess at click time; the runner's pre-existing `SIGKILL_DELAY_MS`
  window in `runClaudeCli` escalates to SIGKILL when the subprocess
  ignores SIGTERM. No new audit event, no new IPC, no schema bump — the
  cascade-pause invariant from 028 (`pauseSource: 'cascade'` on the host
  queue) is unchanged.
- **Process telemetry (US2)** — a new `src/telemetry/` module hosts a
  `TelemetrySamplerImpl` that polls the active subprocess every
  `TELEMETRY_SAMPLE_INTERVAL_MS = 2000` via the injected platform
  `ShellOutFn`. The platform adapters
  (`src/telemetry/platform/platform-ps.ts`,
  `src/telemetry/platform/platform-windows.ts`) shell out to
  `ps -o %cpu,rss,stat,etime -p <PID>` on macOS/Linux or
  `powershell.exe Get-Process` on Windows with `shell: false` and a
  1-second bounded timeout per call. Parsing is pure — the
  `parsePsOutput` / `parsePowerShellOutput` helpers are tested directly
  with fixture strings, no real process spawn. The sampler is started
  by the runner's `MonitorSidecarHook` `started` event and stopped by
  `exited`; on stop it synthesizes one final sample
  (`status: 'exited' | 'killed'` via `synthesizeExitSample`) and then
  emits `null` to clear the projection.
- **Wiring** — `src/extension.ts` constructs the sampler BEFORE the
  runner (the runner's `MonitorSidecarHook` callback closes over the
  sampler reference) and binds `onSample` to a forward-declared
  `telemetryProjector` ref that points at the live `StateProjector`
  after `projector.start()`. The `dispose` hook is pushed to
  `context.subscriptions` so VS Code's deactivation flow tears the
  sampler down.
- **Projection** — `StateProjector.updateTelemetry(snap)` sanitizes the
  `status` field exactly once via the existing `SanitizedLogger.sanitize`
  call (single sanitization point — FR-022), clamps `cpuPercent` and
  `memoryRssBytes` to non-negative, freezes the projection, and stages
  it for the next snapshot publish via the existing debounce
  (FR-021 — slow sampler does not block phase-end publishes; fast
  sampler does not flood IPC).
- **Snapshot field** — `WorkflowSnapshot.telemetry?:
  TelemetrySnapshot | null` (optional for legacy-tolerance). The
  webview mirror in `webview-ui/src/lib/snapshot-types.ts` is hand-
  written to match (the bundle cannot import host source). The sidebar
  `CurrentTask.svelte` renders a compact inline summary
  (`PID <n> · <cpu>% CPU · <rss_mb> MB · <uptime_mmss>`) next to the
  monitor row; `status === 'unavailable'` renders `telemetry unavailable`.
- **Hard invariants (policed by lint)** — `tests/lint/no-vscode-import-in-telemetry.test.ts`
  fails the build if any file under `src/telemetry/` imports `vscode`.
  Telemetry is ephemeral: never persisted to `WorkflowRun`, never written
  to the audit log, never present on disk. The PID integer is the only
  telemetry-adjacent value that already enters audit payloads (via the
  existing `phase-end.signal` / `monitor-invocation-summary` events).
- **Tests + spec** — see `specs/033-aggressive-pause-telemetry/` for the
  full spec, plan, contracts, and quickstart. Unit tests live under
  `tests/unit/controller/aggressive-pause.test.ts` (controller insertion
  ordering) and `tests/unit/telemetry/` (sampler lifecycle + platform
  parsers); the integration regression at
  `tests/integration/pause-resume-continue.test.ts` covers the 032
  isContinue lock-step survival across pause+resume AND the US3
  breakpoint / operator-queue-pause interactions.

### Settings webview surface (011)

The webview now has two top-level routes (Operations + Settings),
switched at `webview-ui/src/dashboard/App.svelte`. The Settings route
mounts `SettingsSurface.svelte` which is a 5-tab nav (General /
Phases / Pipelines / Models / Fatal Signatures). Pipelines and Models
reuse `PipelineBuilder.svelte` with `lockedTab` and `hideHeader` props
to render a single inner tab without its own header. Phases hosts the
real `PhaseDefinition` editor with two sub-modes: a structured form
(includes the `RetryConditionEditor` when `phase.loopable === true`,
per FR-023) and a `RawJsonPhaseEditor` toggled by the per-phase
"Edit as Raw JSON" button (FR-028). The retry-condition validator is
mirrored from the host in `webview-ui/src/lib/retry-condition.ts`
(byte-equality enforced by `tests/parity/retry-condition-parity.test.ts`);
the host re-validates every `retryCondition` value on
`CMD_SAVE_PHASES` (FR-030). `FATAL_SIGNATURES` is mirrored in
`webview-ui/src/lib/fatal-signature-registry.ts` with the same parity
discipline (`tests/parity/fatal-signatures-parity.test.ts`).

### Wake up — pre-warming the Claude allocation (014)

The **Wake up** subsystem schedules a context-isolated 1-token CLI ping
through the host OS's native scheduler so the operator's 5-hour rolling
allocation window can start ahead of a heavy development block — without
the priming invocation accidentally ingesting any workspace tokens.

```
src/wakeup/
├── settings.ts              — VS Code config reader/writer (one source of truth)
├── platform-detect.ts       — process.platform → { 'mac' | 'win' | 'linux-systemd' | 'linux-cron' }
├── schedule-spec.ts         — pure parser/validator for chronological + periodic inputs
├── daemon-manager.ts        — installer-agnostic orchestrator (apply/reconcile/uninstall/inspect)
├── platforms/
│   ├── installer-registry.ts  — platform → DaemonInstaller factory
│   ├── launchd.ts             — macOS plist + launchctl bootstrap/bootout
│   ├── task-scheduler.ts      — Windows schtasks XML + /Create /Delete /Query
│   ├── cron.ts                — Linux crontab line management
│   ├── systemd-user.ts        — Linux systemd-user .service + .timer
│   └── node-resolver.ts       — locates the system node binary for the runner
├── runner-bundle.ts         — copies dist/wakeup-runner.js into <globalStorageUri>/wakeup/
├── invocation-log.ts        — append-only JSONL writer + sanitized latest-5 projection
├── manual-trigger.ts        — one-shot "Wake up now" facade (no scheduler mutation)
├── save-handler.ts          — webview→host CMD_SAVE_WAKEUP_SETTINGS handler (single call site)
└── activation.ts            — extension activate/deactivate hooks

src/headless/
└── wakeup-runner.ts         — STANDALONE: bundled to dist/wakeup-runner.js, ZERO vscode imports
```

**Bundling**: `esbuild.config.mjs` emits a second standalone entry —
`dist/wakeup-runner.js` — from `src/headless/wakeup-runner.ts`. The
runner has **no** `import 'vscode'`-reachable code; a lint test fails
the build on any drift. It spawns the Claude CLI with cwd anchored to a
per-run temp directory (NOT the workspace) and only inherits a scrubbed
allowlist of environment variables (`PATH`, `HOME`, `LANG`, `LC_*`,
`TMPDIR`). The structured output is appended to a workspace-roots-aware
`invocations.log`.

**Persistence layout** under `<globalStorageUri>/wakeup/`:

```
wakeup/
├── runner.js                — copy of dist/wakeup-runner.js installed at Save
├── workspace-roots.json     — mirrored on activation and on Save (roots only, no paths surfaced to audit)
└── invocations.log          — append-only outcome log (rotated by size)
```

**OS-scheduler artifacts** (one entry per host, identifier
`com.schegent.wakeup`):

| Platform | Artifact path |
|---|---|
| macOS | `~/Library/LaunchAgents/com.schegent.wakeup.plist` |
| Windows | Task Scheduler entry `\Schegent\WakeUp` |
| Linux (systemd-user) | `~/.config/systemd/user/com.schegent.wakeup.{service,timer}` |
| Linux (cron) | crontab line tagged `# schegent-wakeup` |

**Settings webview surface**: `webview-ui/src/components/settings/WakeUpTab.svelte`
hosts the four-field form (enable toggle, scheduler type, schedule
input, Save), a primary-host-gated **Wake up now** action, and a
latest-5 attempts log. The webview posts `CMD_SAVE_WAKEUP_SETTINGS`
through `webview-ui/src/lib/save-wakeup-settings.ts` and posts
`CMD_WAKE_UP_NOW` through `webview-ui/src/lib/wake-up-now.ts`; components
do not inline either command literal.

**Audit event vocabulary** (all flow through the single
`audit-log-writer.ts` sanitization point; synthetic identifiers
`runId='wakeup-system'`, `phase='wakeup'`, `iteration=0` when the
event originates outside a workflow run):

- `wakeup-daemon-installed` (`info`) — fresh install succeeded.
- `wakeup-daemon-updated` (`info`) — settings change rewrote the entry.
- `wakeup-daemon-uninstalled` (`info`) — toggle off / deactivate removed it.
- `wakeup-daemon-install-failed` (`failure`) — installer rejected, save aborted.
- `wakeup-daemon-uninstall-failed-on-deactivate` (`failure`) — best-effort
  cleanup at extension deactivate failed; never blocks shutdown (FR-023).
- `wakeup-workspace-roots-updated` (`info`) — carries `rootCount` only;
  paths are NEVER serialized into the audit pipeline (defense-in-depth).
- `wakeup-runner-invocation` (`info` / `failure`) — emitted from the
  runner via `invocations.log` ingestion at next activation.

**IPC additions**: `CMD_SAVE_WAKEUP_SETTINGS` accepts the 4-key payload
`{ enabled, schedulerType, chronologicalTime, periodicInterval }`. The
host re-validates every key transactionally; reject-reason vocabulary
is fixed (e.g. `chronological-time-malformed`,
`periodic-interval-malformed`, `installer-failed:<platform>:<detail>`).
The command is a member of `MUTATING_COMMANDS` and goes through the
primary-only gate. `CMD_WAKE_UP_NOW` carries no shell arguments and is
also mutating/primary-only; the host runs the same isolated runner
semantics once, appends a `triggerSource: "manual"` invocation record,
and kicks snapshot projection. `WorkflowSnapshot.wakeUpLog` contains
only sanitized/capped latest-5 rows and never projects cwd, workspace
roots, env vars, command args, or stack traces.

### Wake up — Advanced session logs & model selection (031)

Feature 031 extends the wake-up subsystem with operator model selection
plus full session capture without changing the 014 trust boundary
(workspace-roots defense, ephemeral cwd, env scrubbing, zero `vscode`
reachability in `src/headless/wakeup-runner.ts`, paths-free audit
invariant). Layout additions:

```
src/wakeup/
├── session-log-constants.ts   — shared 64 KB / 32 KB / 32 MB / 128 MB caps + BLOCK_HEADER_* delimiters (vscode-free)
├── session-capture-ring.ts    — FIFO ring buffering CLI stdout/stderr; single sanitize callback; projection = last 4 KB
├── session-log-writer.ts      — append-only on-disk SINK; recursive mkdir + hard-cap pre-check + soft-cap trim-at-boundary + canonicalized errno reasons; vscode-free, never-throws
├── session-log-reader.ts      — host-side reader; locates a block by UUIDv4 substring, projects last 32 KB, single sanitize pass
└── settings.ts                — extended with `model: WakeUpModelSelection` (closed registry: 'runner-default' | 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-6'); `coerceWakeUpModel()` collapses legacy/corrupt mirror values to `runner-default`
```

**New on-disk artifact**: `<globalStorageUri>/wakeup/session.log`. An
append-only text file. Each successful or failed runner invocation
appends one delimited block:

```
=== wakeup-block <iso8601> id=<uuid> trigger=<scheduled|manual> model=<id|runner-default> status=<succeeded|failed> ===
OUT: <sanitized stdout line>
ERR: <sanitized stderr line>
…
```

Retention: 32 MB soft trim at block boundary (`SESSION_LOG_MAX_BYTES`);
128 MB hard-cap emergency truncate (`SESSION_LOG_HARD_CAP_BYTES`)
defense-in-depth. Lock-skipped invocations write NO block (the JSONL
`InvocationRecord.correlationId` is `undefined` so no consumer can
attempt a read).

**Extended `InvocationRecord` schema** (in `<globalStorageUri>/wakeup/invocations.log`):
adds optional `correlationId` (UUIDv4 string), `requestedModel`
(operator-selected literal), `actualModel` (`'runner-default'` or a
member of `WAKEUP_SUPPORTED_MODELS`), `sessionLogBytesAppended`
(number, ground truth from the writer), `sessionLogTrimmed` (boolean).
Legacy 014/024 rows omit all five — readers tolerate absence.

**Extended `wakeup-runner-invocation` audit payload**: three new
scalar fields — `correlationId`, `requestedModel`, `actualModel`.
The byte-count and trim-marker JSONL fields are intentionally NOT
mirrored into the audit payload (audit stays enum/intent-only; counters
live in JSONL). Paths-free invariant unchanged: no `path`, no
`sessionLogPath`, no roots. `AUDIT_SCHEMA_VERSION` bumps 1 → 2; the
parser is additive-tolerant so 014 hosts reading 031 audit logs ignore
the new fields, and 031 hosts reading 014 audit logs treat the fields
as absent (legacy-tolerant).

**Read-only IPCs** (NOT members of `MUTATING_COMMANDS`):

- **`CMD_READ_WAKEUP_SESSION_LOG`** — accepts `{ correlationId }`
  (UUIDv4 re-validated at the IPC boundary). Host enforces the
  primary-host gate inside the handler, re-validates the UUID, locates
  the on-disk block by id substring, single-sanitizes the projection
  (≤32 KB), and returns a typed discriminated-union response:
  `{ status: 'success', correlationId, capturedAtMs, trigger, model,
  outcome, body, bodyTruncated, fullBlockBytesOnDisk }` OR
  `{ status: 'rejected', reason: 'not-primary-host' |
  'invalid-correlation-id' | 'unknown-correlation-id' |
  'session-log-unavailable' | 'unknown-error' }`. The webview never
  supplies a path; the host composes the path from the wake-up home
  convention (014 layout). The single call site for the command is
  [webview-ui/src/lib/wakeup-session-log-ipc.ts](webview-ui/src/lib/wakeup-session-log-ipc.ts).
- **`CMD_REVEAL_WAKEUP_SESSION_LOG`** — accepts `{}` (no operator
  input). Host enforces primary-host gate, re-composes the path
  internally, stat-checks the file, then dispatches
  `vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path))`.
  Response: `{ status: 'success' }` OR
  `{ status: 'rejected', reason: 'not-primary-host' |
  'session-log-unavailable' | 'reveal-failed' | 'unknown-error' }`.
  Single call site: [webview-ui/src/lib/reveal-wakeup-session-log.ts](webview-ui/src/lib/reveal-wakeup-session-log.ts).

Both helpers use the standard `markPending + onceAck + 5s timeout`
correlation pattern. Repo-grep regressions pin the single-call-site
discipline:
[tests/lint/no-inline-read-wakeup-session-log.test.ts](tests/lint/no-inline-read-wakeup-session-log.test.ts)
and
[tests/lint/no-inline-reveal-wakeup-session-log.test.ts](tests/lint/no-inline-reveal-wakeup-session-log.test.ts).

**Snapshot envelope additions** (UI-only, not persisted, not logged):
`WorkflowSnapshot.wakeUp?: { model: WakeUpModelSelection,
sessionLogPath: string | null }`. The path is host-composed from
`globalStorageUri`; the webview never sends the path back over IPC.
`WakeUpLogProjectionEntry` gains an optional `correlationId` that the
webview uses to decide whether to show the "Expand session" affordance
(present on 031-era rows, absent on legacy 014/024 rows).

**Webview surface**: `webview-ui/src/components/settings/wakeup/`
hosts the new components: `WakeupModelSelector.svelte` (dropdown
listing `Default (runner-chosen)` + the three registry members),
`WakeupSessionLogPanel.svelte` (lazy-loaded expansion panel rendering
the projected body as plain `<pre>{text}</pre>` — no `{@html}`), and
`WakeupSessionLogPathDisplay.svelte` ("Session log file:" strip + a
"Reveal in OS file manager" button). All three mount inside
`WakeUpTab.svelte` adjacent to the existing four-field form and the
latest-5 log section. The 029 lint regression
([tests/lint/no-html-interpolation-in-activity-feed.test.ts](tests/lint/no-html-interpolation-in-activity-feed.test.ts))
covers these components.

**Trust boundary unchanged**: the runner stays `vscode`-import-free
even with the new on-disk writer (the lint regression at
[tests/lint/no-vscode-import-in-headless.test.ts](tests/lint/no-vscode-import-in-headless.test.ts)
still passes). `WAKEUP_SUPPORTED_MODELS` is a code-resident closed
registry — operators cannot add models via workspace settings (v1
intentional scope). The writer is a SINK, not a sanitizer: it appends
the already-sanitized capture bytes the ring produced, and the
canonicalized `session-log-write-failed:<lower-errno>` reason flows
into the JSONL but never gates the wake-up's success outcome.

### IPC additions (011)

- **`CMD_SAVE_GENERAL_SETTINGS`** — accepts `{ updates: Record<key, value> }`.
  The router validates every key against `ALLOWED_KEYS` and every
  value against its `RuntimeType` (`string`/`number`/`boolean`/
  `array-of-string`). Transactional: any single failure rejects the
  whole batch. Writes target `ConfigurationTarget.Workspace` only
  (FR-020). The webview tracks correlation IDs via the new
  `snapshotStore.onceAck()` listener registry.
- **`CMD_RETRY_PHASE_NOW`** — cancels the pending delayed-retry timer
  and immediately re-invokes the active phase; emits a `retry-manual`
  audit event. Primary-only gate enforced by `WorkflowController`.
- **`CMD_SAVE_PHASES`** — extended with a final-validation pass that
  rejects the save with
  `retry-condition-invalid:<phaseId>:<error>` when any phase's
  `retryCondition` fails the host validator (FR-030).

### IPC additions (020)

Three read-only commands + one host → webview push message expose
the phase-log service through the sidebar IPC boundary. None of the
three mutate workspace state — they are explicitly excluded from
`MUTATING_COMMANDS` in [src/ui/sidebar/messages.ts](src/ui/sidebar/messages.ts)
because they never write workspace settings.

- **`CMD_READ_PHASE_LOG`** — accepts `{ selection: { queueId, taskId,
  pipelineId, phaseId, iterationN } }`. The host re-validates the
  tuple against the current `WorkflowSnapshot` (queue membership,
  task in `inFlight ∪ pending ∪ recent ∪ history`, pipeline/phase
  catalog membership) BEFORE composing any filesystem path —
  operator-supplied path components are NEVER consumed. Returns a
  projected `IterationManifest` with sanitized + truncated entries.
- **`CMD_START_PHASE_LOG_TAIL`** — accepts `{ selection: { …,
  iterationN } }` (iterationN required). Hands off to
  `PhaseLogTailRegistry.start()`. Returns `{ sessionId, mechanism }`.
- **`CMD_STOP_PHASE_LOG_TAIL`** — accepts `{ sessionId }`. Hands off
  to `PhaseLogTailRegistry.stop()`.
- **`MSG_PHASE_LOG_ENTRY`** (host → webview) — sole push channel for
  tail entries. Payload `{ tailSessionId, entrySeq, entry }`. The
  webview correlates by `tailSessionId`; entries with a stale id are
  discarded. Entry-seq is monotonic per session, starting at 1.

The synthetic `tail-ended` entry is emitted via the same
`MSG_PHASE_LOG_ENTRY` channel — only the `entry.kind` distinguishes
it. Read responses (`CMD_READ_PHASE_LOG`) never carry `tail-ended`.

### IPC additions (022)

- **`CMD_REMOVE_QUEUE_ITEM`** — now requires payload
  `{ id: string, confirmed: true }` and can delete pending, in-flight,
  paused, failed, canceled, or completed tasks. The host rejects missing
  confirmation before mutation, primary-host gates the command through
  `MUTATING_COMMANDS`, and emits one `task-removed` audit entry on success.
- **`CMD_REMOVE_TASK_PHASE`** — accepts
  `{ taskId: string, phaseId: string, confirmed: true }`. The host writes a
  per-run `PhaseOverride.action = 'removed'`, hides the phase from projected
  progression, skips future execution, and emits `phase-removed`. The frozen
  pipeline snapshot remains unchanged.

### IPC additions (028)

- **`CMD_SET_PHASE_BREAKPOINT`** — accepts `{ runId: string, phaseId: string }`.
  The host validates per Decision 10 (phase exists, not active/completed, no
  override action, not already armed), appends a `PhaseBreakpoint` entry to
  `WorkflowRun.phaseBreakpoints`, persists, and emits `phase-breakpoint-set`.
  Primary-host gated via `MUTATING_COMMANDS`.
- **`CMD_CLEAR_PHASE_BREAKPOINT`** — accepts `{ runId: string, phaseId: string }`.
  Filters the matching entry out of `WorkflowRun.phaseBreakpoints` and emits
  `phase-breakpoint-cleared { cause: 'operator' }`. Primary-host gated.
- Webview helper: [webview-ui/src/lib/phase-breakpoint-ipc.ts](webview-ui/src/lib/phase-breakpoint-ipc.ts)
  is the SINGLE call-site for both commands. The lint regression at
  [tests/lint/no-inline-phase-breakpoint-ipc.test.ts](tests/lint/no-inline-phase-breakpoint-ipc.test.ts)
  fails the build on any drift.
- Audit event additions (additive — no `AUDIT_SCHEMA_VERSION` bump):
  `phase-breakpoint-set`, `phase-breakpoint-cleared` (with cause
  `'operator' | 'consumed-by-fire' | 'override-applied' | 'run-ended'`),
  `phase-breakpoint-fired`. All payloads route through the existing
  single-sanitization point in `audit-log-writer.ts`.
- Existing `queue-paused` / `queue-resumed` audit events extended with a
  required `source: 'operator' | 'cascade'` field.

### Reserved metric keys (`src/audit/audit-entry.ts`)

`AuditEntryFields` carries two new fields:

- `metrics: Readonly<Record<string, number>>` — captured numeric
  metrics from the SCHEGENT AUDIT LOG block (top-level lines only).
- `warnings: ReadonlyArray<string>` — one-shot per-invocation
  diagnostics (reserved-key collision, non-finite drop, missing-key,
  diagnostic-write failures, runtime evaluator errors).

`RESERVED_METRIC_KEYS: ReadonlySet<string>` enumerates names that
must NOT appear in `metrics`. The set has two subsets, co-located
with the `AuditEntry` type:

- **(a) Envelope fields** (mandatory co-maintenance): `id`,
  `timestamp`, `runId`, `phase`, `iteration`, `eventType`, `payload`,
  `outcome`, `schemaVersion`, `correlationId`. The audit-entry test
  asserts `RESERVED_METRIC_KEYS` is a superset of these envelope
  fields so adding a new top-level `AuditEntry` field without
  updating the set will fail the test.
- **(b) Well-known payload field names** (recommended co-maintenance):
  `status`, `model`, `effort`, `pipelineId`, `phaseId`,
  `startTimestamp`, `endTimestamp`, `durationMs`, `type`, `cause`,
  `warnings`, `prompt`, `output`. Best-effort — the test does not
  enforce subset (b), but new payload conventions should be added
  here to avoid future metric collisions.

### Audit parser (`src/parser/audit-log-parser.ts`)

Hydrates the audit log on startup. Recognizes every event type in
`KNOWN_AUDIT_EVENT_TYPE_SET`. Unknown event types or future
`schemaVersion` values produce a warning and **preserve** the entry
rather than dropping it. The detailed variant
(`parseAuditLogLineDetailed`) returns the warning string for surfacing
in the live activity feed.

### State projector (`src/ui/sidebar/state-projector.ts`)

Pure read-only projection of the workspace state into a
`WorkflowSnapshot`. Subscribes to the store, audit log, monitor, and
history store. Debounced at ~100 ms. Sanitizes every projected
user-controllable string (`lastErrorSummary`, `pausedReason`, audit
`summary`).

The projector does **not** mutate state — it only reads.

Feature 013 Wave 7 (US7) extracted four pure-function projector
modules from `state-projector.ts` to isolate the per-slice projection
logic. The orchestrator remains in `state-projector.ts`; each
projector below is a single exported function (or small set):

| File | Public API |
|---|---|
| `src/ui/sidebar/queue-projector.ts` | `projectQueue`, `sanitizeAndCap`, `PAUSED_REASON_MAX_LENGTH`, `truncateLabel` |
| `src/ui/sidebar/audit-tail-projector.ts` | `projectAuditEntry` |
| `src/ui/sidebar/history-projector.ts` | `projectHistory` |
| `src/ui/sidebar/monitor-projector.ts` | `projectMonitor` (collapses terminal monitor states to `null`) |

All four projectors are pure functions with no class state; they
import their inputs as plain types. The orchestrator
(`state-projector.ts`) holds the only mutable bookkeeping that cannot
be safely extracted (monotonic phase-timer counters, transition
detection, debounced emit). The 850 → 732-line reduction is partial;
see `specs/013-correctness-trust-refactor/decisions.md` for the
scope-deviation rationale.

### Message router (`src/ui/sidebar/message-router.ts`)

Validates inbound webview messages with the runtime guards from
`src/contracts/runtime-validators.ts`. Dispatches to VS Code commands
through argument-object types defined in `src/contracts/command-args.ts`.
The router does **not** translate command shapes by convention — every
expected command has a typed shape declared in `src/contracts/`.

### Sidebar / dashboard webviews (`webview-ui/`)

Svelte 5 + Vite 5. Both load with strict CSP:
`default-src 'none'; script-src ${cspSource} 'nonce-…'; …`. Inline
scripts are nonced. No remote sources.

The Dashboard's Activity Feed is implemented by the Phase Log Feed
component (`webview-ui/src/components/PhaseLogFeed/`), backed by the
host module at [src/services/phase-log/](src/services/phase-log/). It
displays per-phase logs sourced from the verbose diagnostic
`stream.jsonl` files (feature 020) — not the audit log. See the
"Phase log feed" main-components section above.

## Persistence boundaries

| Surface | Backing store | Schema |
|---|---|---|
| Workflow run | VS Code `workspaceState` | `STATE_SCHEMA_VERSION` |
| Queue | VS Code `workspaceState` | shared with run |
| History | VS Code `workspaceState` | shared with run |
| Lock | VS Code `workspaceState` | shared with run |
| Watchdog | VS Code `workspaceState` | shared with run |
| Audit log | `.schegent/audit.log` (JSONL) | `AUDIT_SCHEMA_VERSION` |
| Audit archives | `.schegent/audit.log.<stamp>` | shared with audit log |
| Raw session transcripts | `.schegent/sessions/raw-<runId>.log` (text) | unversioned (developer-debug, gitignored) |
| Verbose diagnostic files | `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/{debug.json,stream.jsonl,verbose.log}` | unversioned (operator opt-in, gitignored) |
| Runtime log file | `<workspaceRoot>/.schegent/syslog` (default; operator-configurable) | unversioned (sanitized append-only, gitignored) |
| Wake-up runner bundle | `<globalStorageUri>/wakeup/runner.js` | unversioned (mirror of `dist/wakeup-runner.js`) |
| Wake-up workspace roots mirror | `<globalStorageUri>/wakeup/workspace-roots.json` | unversioned |
| Wake-up invocation log | `<globalStorageUri>/wakeup/invocations.log` | unversioned (append-only, size-rotated) |
| Wake-up session log | `<globalStorageUri>/wakeup/session.log` | unversioned (append-only, 32 MB soft / 128 MB hard cap) |
| Wake-up OS scheduler entries | platform-native (see "Wake up" section) | n/a — owned by OS scheduler |

## Contracts module (`src/contracts/`)

Single source of truth for cross-boundary types and runtime guards.
Every UI surface, command handler, and persistence layer imports from
this module.

| File | What it exposes |
|---|---|
| `audit-events.ts` | `AUDIT_SCHEMA_VERSION`, `AuditEventType`, `KNOWN_AUDIT_EVENT_TYPE_SET`, `isKnownAuditEventType()` |
| `correlation.ts` | `newCorrelationId()`, `isCorrelationId()` |
| `state-schema.ts` | `STATE_SCHEMA_VERSION` |
| `monitor-events.ts` | `MonitorEvent`, `MonitorSnapshot`, `MONITOR_SNAPSHOT_EVENT_TYPES` |
| `queue-snapshot.ts` | `QueueStatus`, `QueueItemSnapshot`, `SanitizedFailureMetadata` |
| `webview-commands.ts` | `WebviewCommand` discriminated union |
| `webview-snapshots.ts` | host→webview message types |
| `command-args.ts` | argument-object shapes for every VS Code command |
| `runtime-validators.ts` | hand-rolled guards (no zod dependency) |

## Backend runner interface

`src/runner/claude-cli.ts` is the only implementation today, but it
implements an interface declared in the contracts module so future
backends can be added without controller changes. The interface
documents subprocess spawn, output cap, timeout, and exit-code surface.

## Build pipeline

- **Host**: `esbuild.config.mjs` bundles `src/extension.ts` to
  `dist/extension.js`.
- **Headless wake-up runner**: `esbuild.config.mjs` also emits
  `dist/wakeup-runner.js` from `src/headless/wakeup-runner.ts` as a
  standalone CommonJS entry. The bundle MUST NOT reach `import 'vscode'`
  — guarded by a lint regression in `tests/lint/`.
- **Webview**: `webview-ui/` is a Vite app that emits `dist/webview/index.html`
  + `dist/webview/dashboard.html`, both with `__CSP__` and `__NONCE__`
  placeholders that the host renderer replaces at activation.

## Testing layout

- `tests/unit/` — Vitest unit tests for the host (no VS Code).
- `tests/integration/` — Vitest integration-style tests (no VS Code) that
  exercise multi-component flows.
- `tests/integration-host/` — `@vscode/test-electron` smoke tests
  requiring a real VS Code extension host.
- `webview-ui/tests/` — webview component tests.
- `tests/perf/` — performance budgets for projection, hydration.

The Vitest config excludes `*.host.test.ts` so the extension-host runner
does not compete for the same files.

## See also

- [docs/security/threat-model.md](docs/security/threat-model.md)
- [docs/security/security-note.md](docs/security/security-note.md)
- [docs/operations/](docs/operations/) — operator runbooks
- [specs/005-stabilization-refactor/](specs/005-stabilization-refactor/)
  — the active stabilization plan
