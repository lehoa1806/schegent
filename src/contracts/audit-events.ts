// Feature 031 — bumped 1 → 2 to reflect the three additive scalar fields on
// the `wakeup-runner-invocation` audit payload: `correlationId` (UUIDv4),
// `requestedModel` (operator selection literal), `actualModel` (closed enum
// reflecting what the runner actually invoked). All three fields are
// additive and OPTIONAL on read: a v1 reader encountering a v2 event
// ignores them; a v2 reader encountering a v1 event treats them as
// absent. No payload field was removed or repurposed; no audit event
// type was renamed. The migration story is "additive-tolerant readers,
// no breaking change" — the audit-log parser at
// `src/parser/audit-log-parser.ts` already preserves entries with
// unknown `schemaVersion` values (warning + preserve, per the existing
// CLAUDE.md hard rule "Never drop unknown audit event types from the
// parser"). No on-disk migration is required.
//
// Feature 034 — additive boolean `sessionCleaned: boolean` on the
// `task-removed` payload. Reflects the best-effort on-disk cleanup
// outcome at task deletion: `true` iff `runId` was non-null AND
// `cleanupSessionArtifacts` resolved `true`; `false` otherwise. The
// payload remains paths-free (no `path`, `filePath`, `workspaceRoot`,
// `sessionLogPath`, etc.) — the actual paths removed are recorded
// only in the runtime-log WARN line on cleanup failure. Additive — no
// `AUDIT_SCHEMA_VERSION` bump (follows 028 / 030 / 031 / 032 precedent).
// Historical records lack the field and are backwards-compatible per
// the warn-and-preserve parser discipline.
export const AUDIT_SCHEMA_VERSION = 2 as const;

export const PHASE_EVENT_TYPES = ['phase-start', 'phase-end'] as const;

// Feature 026 — type-only contract for the `phase-start` audit payload.
// The runtime emission lives at src/controller/phase-runner.ts (it reads
// the immutable `WorkflowRun.pipeline` snapshot's PhaseDef; `model` and
// `effort` are omitted entirely when absent — no empty strings, no
// `null`). This shape is the schema downstream consumers (tests,
// dashboards, lint) match against; it must NOT be re-derived from a
// live catalog at emit time (FR-013, immutable-run-snapshot invariant).
//
// Feature 032 — extended with `isContinue: boolean`. The field is
// MANDATORY (always present on the payload); `undefined` on
// `PhaseRunInputs.isContinue` records `false`. Matches the strict
// `=== true` gate used by `ClaudeCliRunner.invoke` for the `-c` argv
// append so the audit record and the spawned argv stay in lock-step.
// Additive — no `AUDIT_SCHEMA_VERSION` bump (follows 028 / 030
// precedent). Historical records lack the field and are
// backwards-compatible per the warn-and-preserve parser discipline.
export interface PhaseStartPayload {
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly isContinue: boolean;
}

export const RUNNER_EVENT_TYPES = ['cli-invocation', 'file-write'] as const;

export const LOOP_EVENT_TYPES = ['loop-iteration'] as const;

export const LIFECYCLE_EVENT_TYPES = [
  'pause',
  'resume',
  'warning',
  'error',
  'cancel'
] as const;

export const MONITOR_EVENT_TYPES = [
  'monitor-invocation-started',
  'monitor-stdout-line',
  'monitor-stderr-line',
  'monitor-progress',
  'monitor-stall',
  'monitor-rate-limited',
  'monitor-invocation-completed',
  'monitor-invocation-failed',
  'monitor-invocation-canceled',
  'monitor-invocation-summary'
] as const;

export const AUDIT_PIPELINE_EVENT_TYPES = [
  'audit-rotated',
  'audit-retention-applied',
  'audit-hydration-warning',
  'audit-schema-warning'
] as const;

// Feature 010 — retry-condition decision records.
// Uses dot-style identifier deliberately to avoid colliding with the
// existing phase-* dash-style naming (see specs/010-pipeline-resilience/research.md R3).
export const RETRY_CONDITION_EVENT_TYPES = ['phase.retry_evaluated'] as const;

// Feature 011 — delayed-retry resilience audit events. Emitted by the
// workflow-controller when a non-fatal failure is classified as
// `transient_error` (15-min backoff) or `rate_limit` (60-min backoff),
// when a manual retry overrides the scheduled timer, when a previously
// failing phase recovers via clean exit, and when the cap is exhausted
// (5 consecutive delayed retries) and the queue is paused.
export const DELAYED_RETRY_EVENT_TYPES = [
  'retry-scheduled',
  'retry-manual',
  'retry-recovered',
  'queue-paused'
] as const;

// Feature 017 — operator phase-control audit events.
export const PHASE_CONTROL_EVENT_TYPES = [
  'phase-pause-requested',
  'phase-paused',
  'phase-resumed',
  'phase-restarted',
  'phase-skipped',
  'phase-disabled',
  'phase-enabled',
  'phase-removed'
] as const;

export const QUEUE_CONTROL_EVENT_TYPES = [
  'queue-created',
  'queue-renamed',
  'queue-deleted',
  'queue-resumed',
  'queue-settings-saved',
  'task-modified',
  'task-removed',
  'task-reordered',
  'task-moved',
  // Feature 017 — BUG-001. Operator-driven task lifecycle transitions
  // distinct from the controller-side `cancel` lifecycle event. Both
  // payloads carry `{ taskId, runId? }` and route through the existing
  // `appendAudit()` sanitization point.
  'task-canceled',
  'task-restarted-from-canceled',
  // Feature 017 — BUG-003. Operator submission accepted as a pending
  // task. Distinct from `task-modified` / `task-reordered` because it
  // marks the queue-entry creation moment. Payload: `{ taskId,
  // queueId, via }` where `via` is one of `'dashboard-submit'` or
  // `'command-palette'`. Flows through the existing `appendAudit()`
  // sanitization point.
  'task-enqueued',
  'schedule-set',
  'schedule-cleared',
  'schedule-fired'
] as const;

export const PHASE_MESSAGE_EVENT_TYPES = [
  'phase-message-emitted',
  'phase-message-truncated',
  'phase-message-invalid'
] as const;

// Feature 010 — fatal-signature classification event. Feature 011 extends
// the payload with `source: 'built-in' | 'operator-defined'`; the event
// type itself was already known.
export const FATAL_SIGNATURE_EVENT_TYPES = ['fatal-signature-matched'] as const;

// Feature 012 — emitted by PhaseRunner when `schegent.claude.autoCompactPctOverride`
// is set and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` has been merged into the
// CLI invocation env. Payload: { runId, phaseId, value }.
export const AUTO_COMPACT_OVERRIDE_EVENT_TYPES = ['auto-compact-override-applied'] as const;

// Feature 014 — wake-up daemon lifecycle. Emitted by the save-handler
// after a successful settings write + daemon driver call, by the
// install-failure rollback path, by the workspace-roots mirror writer
// (US2 traceability), and by the deactivate hook on a swallowed
// uninstall failure (US4 FR-023). Payloads are sanitized; see
// specs/014-wake-up/contracts/wakeup-settings-ipc.md §Audit event payloads.
export const WAKEUP_DAEMON_EVENT_TYPES = [
  'wakeup-daemon-installed',
  'wakeup-daemon-updated',
  'wakeup-daemon-uninstalled',
  'wakeup-daemon-install-failed',
  'wakeup-workspace-roots-updated',
  'wakeup-daemon-uninstall-failed-on-deactivate'
] as const;

// Feature 020 — phase log IPC events. Emitted by the sidebar message
// router after each `CMD_READ_PHASE_LOG` / `CMD_START_PHASE_LOG_TAIL` /
// `CMD_STOP_PHASE_LOG_TAIL` handler runs. Payloads are paths-free:
// they carry the selection tuple plus outcome/counts only. See
// specs/020-phase-level-logs/contracts/phase-log-ipc.md.
export const PHASE_LOG_EVENT_TYPES = [
  'phase-log-read',
  'phase-log-tail-started',
  'phase-log-tail-stopped'
] as const;

// Feature 028 — phase breakpoint lifecycle events. Emitted by the
// workflow controller on set/clear and by the phase runner on fire.
// Additive — no `AUDIT_SCHEMA_VERSION` bump (follows 010/011 precedent).
// See specs/028-advanced-phase-pausing/contracts/audit-events.md.
export const PHASE_BREAKPOINT_EVENT_TYPES = [
  'phase-breakpoint-set',
  'phase-breakpoint-cleared',
  'phase-breakpoint-fired'
] as const;

// Feature 030 — forward-only state migration audit events. Emitted by
// `WorkspaceStateStore.initialize()` (via extension.ts) after a v5 → v6
// coalesce so an operator can reconcile the single-queue collapse from
// the audit log alone. The payload is structural (counts + booleans +
// enum literals); it passes `SECRET_PATTERNS` unchanged. Additive — no
// `AUDIT_SCHEMA_VERSION` bump (follows 028 precedent).
export const STATE_MIGRATION_EVENT_TYPES = ['state-migrated', 'workflow-run-repaired'] as const;

// Feature 058 — multi-root workspace activation lifecycle audit event.
// Emitted by `extension.ts` at activation when the workspace contains more
// than one folder AND the `schegent.multiRoot.suppressWarning` setting is
// not `true`. The payload is bounded to `folderCount` (number) and
// `canonicalFolderName` (string — folder `.name` only, NEVER `.uri.fsPath`).
// Hard rule: NEVER serialize workspace root paths into the structured audit
// log. Additive — no `AUDIT_SCHEMA_VERSION` bump (follows 028 / 030 / 031 /
// 032 precedent). Historical records lack the event entirely and are
// backwards-compatible per the warn-and-preserve parser discipline.
export const WORKSPACE_LIFECYCLE_EVENT_TYPES = ['multi-root.warning-shown'] as const;

// Feature 059 — per-capability trust scope denial events. Emitted by
// the save-command handlers when an `isCapabilityAllowed(capability)`
// check returns `false` for a non-default payload. The payload is
// bounded to four primitives (capability/resolvedScope/reason from
// closed enums; `workspaceBasename` derived via `path.basename`). No
// operator-supplied string flows through this event, so
// `SECRET_PATTERNS` is unchanged. Additive — no `AUDIT_SCHEMA_VERSION`
// bump (follows 028 / 058 precedent). Historical records lack the
// event entirely and are backwards-compatible per the warn-and-preserve
// parser discipline.
export const TRUST_GATE_EVENT_TYPES = ['trust.capability-denied'] as const;

// Feature 063 — atomic queue full-reset event. Emitted by the
// `CMD_CLEAR_ALL` handler after the batched memento write completes
// and the runner has either acked the cancel signal or the 2s window
// has elapsed (FR-007). Payload is structural counts + a boolean +
// a closed-enum runner-state literal, so `SECRET_PATTERNS` is
// unchanged. Additive — no `AUDIT_SCHEMA_VERSION` bump (follows 058 /
// 059 precedent). No event is emitted when the operation is a no-op
// (FR-018 cancel path AND the idempotency rule from
// contracts/cmd-clear-all.md §Idempotency).
export const QUEUE_FULL_RESET_EVENT_TYPES = ['queue-cleared-all'] as const;

// Feature 065 — scheduled-start lifecycle and idle-pending transition events.
// Emitted by `ScheduledStartCoordinator`, the sidebar message router (intent
// validation), and `GuardedRunService` (horizon rejection / past-timestamp
// coercion / no-start-mode automation default). All payloads are structural
// (timestamps, queue id, source enums, counts) and pass `SECRET_PATTERNS`
// unchanged. Additive — no `AUDIT_SCHEMA_VERSION` bump (follows the
// 028/030/031/032/034 additive precedent). See
// specs/065-enqueue-start-separation/contracts/audit-events.diff.md.
export const SCHEDULE_EVENT_TYPES = [
  'scheduled-start-armed',
  'scheduled-start-fired',
  'scheduled-start-canceled',
  'scheduled-start-superseded',
  'scheduled-start-horizon-rejected',
  'scheduled-start-past-timestamp-coerced-to-now',
  'idle-pending-entered',
  'idle-pending-exited',
  'automation-enqueue-no-start-mode'
] as const;

// Feature 065 — emitted by `WorkspaceStateStore.initialize()` (via
// extension.ts) after a v6 → v7 lift completes. The payload is structural
// (counts + version literals + timestamp) and passes `SECRET_PATTERNS`
// unchanged. Additive — no `AUDIT_SCHEMA_VERSION` bump.
export const MIGRATION_V7_EVENT_TYPES = ['state-migrated-v6-to-v7'] as const;

export const ALL_AUDIT_EVENT_TYPES = [
  ...PHASE_EVENT_TYPES,
  ...RUNNER_EVENT_TYPES,
  ...LOOP_EVENT_TYPES,
  ...LIFECYCLE_EVENT_TYPES,
  ...MONITOR_EVENT_TYPES,
  ...AUDIT_PIPELINE_EVENT_TYPES,
  ...RETRY_CONDITION_EVENT_TYPES,
  ...DELAYED_RETRY_EVENT_TYPES,
  ...PHASE_CONTROL_EVENT_TYPES,
  ...QUEUE_CONTROL_EVENT_TYPES,
  ...PHASE_MESSAGE_EVENT_TYPES,
  ...FATAL_SIGNATURE_EVENT_TYPES,
  ...AUTO_COMPACT_OVERRIDE_EVENT_TYPES,
  ...WAKEUP_DAEMON_EVENT_TYPES,
  ...PHASE_LOG_EVENT_TYPES,
  ...PHASE_BREAKPOINT_EVENT_TYPES,
  ...STATE_MIGRATION_EVENT_TYPES,
  ...WORKSPACE_LIFECYCLE_EVENT_TYPES,
  ...TRUST_GATE_EVENT_TYPES,
  ...QUEUE_FULL_RESET_EVENT_TYPES,
  ...SCHEDULE_EVENT_TYPES,
  ...MIGRATION_V7_EVENT_TYPES
] as const;

export type PhaseEventType = (typeof PHASE_EVENT_TYPES)[number];
export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];
export type LoopEventType = (typeof LOOP_EVENT_TYPES)[number];
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
export type MonitorAuditEventType = (typeof MONITOR_EVENT_TYPES)[number];
export type AuditPipelineEventType = (typeof AUDIT_PIPELINE_EVENT_TYPES)[number];
export type RetryConditionEventType = (typeof RETRY_CONDITION_EVENT_TYPES)[number];
export type DelayedRetryEventType = (typeof DELAYED_RETRY_EVENT_TYPES)[number];
export type PhaseControlEventType = (typeof PHASE_CONTROL_EVENT_TYPES)[number];
export type QueueControlEventType = (typeof QUEUE_CONTROL_EVENT_TYPES)[number];
export type PhaseMessageEventType = (typeof PHASE_MESSAGE_EVENT_TYPES)[number];
export type FatalSignatureEventType = (typeof FATAL_SIGNATURE_EVENT_TYPES)[number];
export type AutoCompactOverrideEventType = (typeof AUTO_COMPACT_OVERRIDE_EVENT_TYPES)[number];
export type WakeUpDaemonEventType = (typeof WAKEUP_DAEMON_EVENT_TYPES)[number];
export type PhaseLogEventType = (typeof PHASE_LOG_EVENT_TYPES)[number];
export type PhaseBreakpointEventType = (typeof PHASE_BREAKPOINT_EVENT_TYPES)[number];
export type StateMigrationEventType = (typeof STATE_MIGRATION_EVENT_TYPES)[number];
export type WorkspaceLifecycleEventType = (typeof WORKSPACE_LIFECYCLE_EVENT_TYPES)[number];
export type TrustGateEventType = (typeof TRUST_GATE_EVENT_TYPES)[number];
export type QueueFullResetEventType = (typeof QUEUE_FULL_RESET_EVENT_TYPES)[number];
export type ScheduleAuditEventType = (typeof SCHEDULE_EVENT_TYPES)[number];
export type MigrationV7EventType = (typeof MIGRATION_V7_EVENT_TYPES)[number];

export type AuditEventType = (typeof ALL_AUDIT_EVENT_TYPES)[number];

// Feature 058 — payload for the `multi-root.warning-shown` audit event.
// Bounded to two primitives: `folderCount` (the workspace folder count,
// always >= 2 when emitted) and `canonicalFolderName` (the canonical
// folder's `.name`). NEVER includes `folder.uri.fsPath` or any other
// path-bearing field — see workspace root path serialization hard rule.
export interface MultiRootWarningShownPayload {
  readonly folderCount: number;
  readonly canonicalFolderName: string;
}

// Feature 059 — payload for the `trust.capability-denied` audit event.
// Bounded to four primitives sourced from closed enums and a basename:
//   - `capability` (TrustCapability literal — closed enum).
//   - `resolvedScope` (ResolvedScope literal — closed enum).
//   - `workspaceBasename` (the canonical folder's `path.basename(...)`;
//     MUST NOT contain `/` or `\\`; never the full `.uri.fsPath`).
//   - `reason` (TrustDeniedReason literal from `TRUST_DENIED_REASONS`).
// NEVER includes workspace root paths, operator-authored phase prompts,
// or any other free-form text. See contracts/trust-capability-denied-
// audit-contract.md (I-1..I-6) and the workspace-root-serialization
// hard rule.
export interface TrustCapabilityDeniedPayload {
  readonly capability: 'phases' | 'retryConditions' | 'pipelineOverrides';
  readonly resolvedScope: 'user' | 'workspace' | 'workspace-trust';
  readonly workspaceBasename: string;
  readonly reason: string;
  readonly rowIndex?: number;
}

// Feature 063 — payload for the `queue-cleared-all` audit event. Bounded
// to structural counts + a boolean + closed-enum runner-state literal.
// NEVER includes operator descriptions, task ids, queue names, or any
// free-form text — operator input MUST NOT flow through this event so
// `SECRET_PATTERNS` invariants are preserved.
//
//   - `removedPending` — count of pending tasks dropped (≥0).
//   - `removedInFlight` — 0 or 1 (single-queue single-runner mode).
//   - `pauseStateCleared` — `true` if a paused-queue flag was cleared
//     by the operation, `false` otherwise.
//   - `runnerState` — the runner's terminal acknowledgement state in
//     the bounded 2s window (FR-007):
//       * `'acked'`       — runner acknowledged cancel within window.
//       * `'timed-out'`   — 2s window elapsed without ack; state was
//         still flipped atomically and operator was toast-warned.
//       * `'no-active-run'` — no `WorkflowRun` existed; the cancel
//         signal was a no-op.
//   - `watchdogBackoffCleared` — `true` if a non-default watchdog
//     backoff window was reset by the operation.
//
// Emitted only when the Clean All operation actually mutated state.
// Per the idempotency rule (contracts/cmd-clear-all.md §Idempotency),
// no event is emitted when the queue was already empty AND there was
// no active run AND no watchdog backoff and no pause state.
export interface QueueClearedAllPayload {
  readonly removedPending: number;
  readonly removedInFlight: number;
  readonly pauseStateCleared: boolean;
  readonly runnerState: 'acked' | 'timed-out' | 'no-active-run';
  readonly watchdogBackoffCleared: boolean;
}

export interface RetryEvaluatedPayload {
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly expression: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly decision: boolean;
  readonly missingKeys?: ReadonlyArray<string>;
  readonly evaluationError?: true;
  readonly errorMessage?: string;
}

// Feature 028 — phase breakpoint audit payloads. The runtime emissions
// live at src/controller/workflow-controller.ts (set/clear) and
// src/controller/phase-runner.ts (fired). All fields are structural —
// enum literals, catalog ids, numbers. No free-form text flows through
// these events, so they pass `SECRET_PATTERNS` redaction unchanged.
export interface PhaseBreakpointSetPayload {
  readonly runId: string;
  readonly phaseId: string;
  readonly actor: 'operator' | 'system';
}

export type PhaseBreakpointClearedCause =
  | 'operator'
  | 'consumed-by-fire'
  | 'override-applied'
  | 'run-ended';

export interface PhaseBreakpointClearedPayload {
  readonly runId: string;
  readonly phaseId: string;
  readonly cause: PhaseBreakpointClearedCause;
}

export interface PhaseBreakpointFiredPayload {
  readonly runId: string;
  readonly phaseId: string;
  readonly pipelineId: string;
  readonly iterationN: number;
}

// Feature 028 — additive `source` discriminator on `queue-paused` /
// `queue-resumed`. Existing readers ignore unknown fields; the additive
// field has no schema-version impact.
export type QueuePauseSource = 'operator' | 'cascade';

// Feature 030 — payload contract for the unified `task-reordered` audit
// event. Single-queue mode collapses the prior multi-queue reorder
// surface into a single position-only mutation against the canonical
// `'default'` queue. The runtime emission lives at the sidebar message
// router; the `source` discriminates which UI affordance fired the
// command (drag-and-drop drop event vs. up/down arrow). Sanitized
// through `SanitizedLogger.sanitize` like every other audit payload.
export type TaskReorderedSource = 'drag' | 'arrow';
export type TaskReorderedRejectCause =
  | 'secondary-host'
  | 'task-not-pending'
  | 'invalid-position'
  | 'no-op';
export interface TaskReorderedPayload {
  readonly queueId: 'default';
  readonly taskId: string;
  readonly fromPosition: number;
  readonly toPosition: number;
  readonly source: TaskReorderedSource;
  readonly outcome: 'success' | 'rejected';
  readonly cause?: TaskReorderedRejectCause;
}

export interface PhaseEndCauseExtension {
  readonly cause?: string;
}

export type AuditOutcome = 'success' | 'failure' | 'info';

export const KNOWN_AUDIT_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(ALL_AUDIT_EVENT_TYPES);

export function isKnownAuditEventType(value: string): value is AuditEventType {
  return KNOWN_AUDIT_EVENT_TYPE_SET.has(value);
}

// Feature 064 — closed-union audit scope for the snapshot projection. Each
// `AuditTailEntry` carries a scope literal so the webview can split the
// audit tail into the Activity Feed (task-scoped + reachable runId) and
// the System tab (system-scoped, always visible). See
// specs/064-system-tab-audit-split/contracts/audit-event-classification.md.
export type AuditScope = 'task' | 'system';

// Feature 064 — frozen set of event-type literals that are classified as
// `'system'` scope. Mirrors the authoritative classification table at
// specs/064-system-tab-audit-split/contracts/audit-event-classification.md.
// Event types not present here resolve to `'task'` scope (FR-011), which
// preserves the warn-and-preserve parser discipline for unknown event
// types (CLAUDE.md hard rule).
export const SYSTEM_SCOPED_EVENT_TYPES: ReadonlySet<AuditEventType> = Object.freeze(
  new Set<AuditEventType>([
    // Queue mutation
    'queue-cleared-all',
    'queue-created',
    'queue-renamed',
    'queue-deleted',
    'queue-resumed',
    'queue-settings-saved',
    'task-enqueued',
    'task-modified',
    'task-removed',
    'task-reordered',
    'task-moved',
    'task-canceled',
    'task-restarted-from-canceled',
    'schedule-set',
    'schedule-cleared',
    'schedule-fired',
    // Pause / queue-level lifecycle (LIFECYCLE_EVENT_TYPES subset)
    'pause',
    'resume',
    // Delayed-retry / runner-level scheduling (DELAYED_RETRY_EVENT_TYPES)
    'retry-scheduled',
    'retry-manual',
    'retry-recovered',
    'queue-paused',
    // Audit pipeline housekeeping
    'audit-rotated',
    'audit-retention-applied',
    'audit-hydration-warning',
    'audit-schema-warning',
    // State migration / repair
    'state-migrated',
    'workflow-run-repaired',
    'state-migrated-v6-to-v7',
    // Feature 065 — scheduled-start lifecycle / idle-pending transitions
    'scheduled-start-armed',
    'scheduled-start-fired',
    'scheduled-start-canceled',
    'scheduled-start-superseded',
    'scheduled-start-horizon-rejected',
    'scheduled-start-past-timestamp-coerced-to-now',
    'idle-pending-entered',
    'idle-pending-exited',
    'automation-enqueue-no-start-mode',
    // Wake-up daemon lifecycle
    'wakeup-daemon-installed',
    'wakeup-daemon-updated',
    'wakeup-daemon-uninstalled',
    'wakeup-daemon-install-failed',
    'wakeup-workspace-roots-updated',
    'wakeup-daemon-uninstall-failed-on-deactivate',
    // Workspace / trust gates
    'multi-root.warning-shown',
    'trust.capability-denied'
  ])
);

// Feature 064 — pure classifier mapping an event-type literal to the
// snapshot scope. Unknown event types default to `'task'` scope (FR-011).
// O(1), side-effect free.
export function classifyAuditEvent(eventType: string): AuditScope {
  return SYSTEM_SCOPED_EVENT_TYPES.has(eventType as AuditEventType) ? 'system' : 'task';
}
