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
  ...STATE_MIGRATION_EVENT_TYPES
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

export type AuditEventType = (typeof ALL_AUDIT_EVENT_TYPES)[number];

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
