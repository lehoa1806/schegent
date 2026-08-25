import type { BackendRunnerKind } from './backend-kinds';
import type { BackendContainment } from '../services/backend-containment-policy';
import type { TerminationReason } from '../state/workflow-run';
import type { RunnerLabel, TreeEscalation } from './backend-runner';
// Feature FR-R3-006 — the reset transaction's phase and refusal literals are
// declared once, in a module that imports nothing, and the audit payload reuses
// them rather than restating them. A restated copy is a second source of truth
// for a closed union, and the way it goes wrong is that the audit records a
// phase name the transaction can no longer reach.
import type { ResetPhase, ResetRefusalReason } from '../state/reset-transaction';
// Feature 100 (T513) — `CatalogLifecyclePayload.resourceKind` reuses the store's
// own closed union for the same reason the reset literals above are reused: a
// restated copy would be a second source of truth, and the way it goes wrong is
// that the audit records a kind the store can no longer produce.
import type { CatalogKind } from './catalog-store';

// Wake-up withdrawal — the `wakeup-runner-invocation` and
// `wakeup-daemon-*` event types were removed with the capability that
// emitted them. Historical entries in existing audit logs are NOT
// rewritten: the parser at `src/parser/audit-log-parser.ts` preserves
// entries whose type it does not recognize (warning + preserve, per the
// CLAUDE.md hard rule "Never drop unknown audit event types from the
// parser"), so a log written by an earlier release still reads. Nothing
// in this release emits them, and no on-disk migration is required.
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
export const AUDIT_SCHEMA_VERSION = 3 as const;

export type {
  AuditPermissionMode,
  CliInvocationPayloadV3,
  PhaseEndPayloadV3
} from '../audit/audit-payload';

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
//
// Session reuse — extended with `sessionReuse: boolean`. The field is
// MANDATORY (always present on the payload); `undefined` on
// `PhaseRunInputs.sessionReuse` records `false`. Indicates the
// invocation reused a prior CLI session via `--resume <id>` for cost
// optimization (prompt cache preservation). Semantically distinct
// from `isContinue`. Additive — no `AUDIT_SCHEMA_VERSION` bump.
/**
 * Feature 098 (T045, FR-034) — `pipelineId` is optional on the four payloads an
 * invocation can reach without one. It used to be mandatory, and the emitters
 * kept it so by substituting the built-in Pipeline id whenever the invocation
 * supplied none. That id named a Pipeline the product no longer ships, so the
 * guarantee the mandatory field offered was that a reader always found *an*
 * attribution — not that the attribution was true. Absent is the honest shape:
 * a reader that finds no id knows none was claimed.
 */
export interface PhaseStartPayload {
  readonly pipelineId?: string;
  readonly phaseId: string;
  readonly runner: BackendRunnerKind;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly isContinue: boolean;
  readonly sessionReuse: boolean;
}

export const RUNNER_EVENT_TYPES = ['cli-invocation', 'file-write', 'runner-probe-failed'] as const;

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
  // Feature FR-R3-007 (T360) — READ-ONLY. Nothing writes these two any more.
  //
  // `monitor-stdout-line` was one entry per line of CLI stdout and accounted
  // for 93.2% of `audit.log`'s bytes while being read by nothing, which capped
  // the metrics horizon at roughly forty runs. Both writers were removed from
  // `src/monitor/claude-cli-monitor.ts`; the line content now goes to the
  // bounded sink in `src/monitor/cli-transport-sink.ts` and the volume is
  // carried once per invocation by `monitor-invocation-summary`.
  //
  // They stay in this list forever, and that is not politeness toward old
  // files — it is the warn-and-preserve rule. Live logs and archives on
  // operator disks hold thousands of these entries (1,839 in the workspace
  // that produced the measurement), and a type absent from the registry is a
  // type the parser reports as unknown on every cold-start scan. Removing
  // either name would turn a clean read of an existing archive into a stream
  // of `audit-schema-warning`s, which is exactly the outcome the rule forbids.
  // `AUDIT_SCHEMA_VERSION` did not bump for the same reason: removing a writer
  // is not an envelope change.
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

// Sensitive local session-artifact lifecycle. Payloads contain aggregate
// counts/bytes and policy values only — never run ids, filenames, or paths.
export const SESSION_ARTIFACT_EVENT_TYPES = ['session-retention-applied'] as const;

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

// Feature FR-R3-006 (T348) — the workspace-state reset transaction, recorded
// once per attempt. Deliberately one event rather than one per phase: a reset
// either happened or it did not, and six entries describing the same operator
// action would make the audit longer without making it more answerable.
//
// The event is emitted for a refusal and a failure as well as a success, which
// is the point — before this feature a reset that quietly did nothing left the
// same trace as one that did everything, namely none. It is also the event the
// audit log itself survives: reset never touches `.schegent/audit.log`, so the
// entry sits directly after the state it describes clearing.
//
// Additive — no `AUDIT_SCHEMA_VERSION` bump (follows the 058 / 059 / 063
// precedent). Historical records lack the event entirely, which the
// warn-and-preserve parser discipline already handles.
export const RESET_TRANSACTION_EVENT_TYPES = ['workspace-state-reset'] as const;

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
  'automation-enqueue-no-start-mode',
  // BUG-006 / FR-026: emitted when the retry handler converts a
  // retry-cap-exhausted rate-limit pause into a system-armed scheduled
  // restore via `GuardedRunService.transitionToScheduledRestore`.
  'system-pause-scheduled-restore',
  // BUG-006 / FR-027: emitted when the retry handler falls back to the
  // legacy `operator-paused` lifecycle because the reset timestamp could
  // not be parsed or is outside the 7-day horizon.
  'system-pause-restore-unavailable'
] as const;

// Feature 065 — emitted by `WorkspaceStateStore.initialize()` (via
// extension.ts) after a v6 → v7 lift completes. The payload is structural
// (counts + version literals + timestamp) and passes `SECRET_PATTERNS`
// unchanged. Additive — no `AUDIT_SCHEMA_VERSION` bump.
export const MIGRATION_V7_EVENT_TYPES = ['state-migrated-v6-to-v7'] as const;

// Feature 093 — emitted by `WorkspaceStateStore.initialize()` (via
// `migration-audit-forwarder.ts`) when the v10 → v11 reshape turns the singular
// `KEYS.run` record into the per-queue map, plus one event per repair the
// migrator had to make on the way. Three types rather than one: the reshape is
// the record an auditor correlates on, and a Run that had to be reassigned or a
// record that had to be repaired are separate facts about that same reshape —
// folding them into the reshape's payload would make "what happened to my Run"
// depend on parsing a count.
//
// Every payload is identifiers, counts and closed reason codes. A queue name is
// operator-authored content and never reaches the audit log, so `SECRET_PATTERNS`
// is unchanged. Additive — no `AUDIT_SCHEMA_VERSION` bump (follows the 030 / 065
// migration-event precedent); historical records lack these events entirely and
// stay readable under the warn-and-preserve parser discipline.
export const MIGRATION_V11_EVENT_TYPES = [
  'state-migrated-v10-to-v11',
  'run-reassigned-to-default-queue',
  'run-record-repaired'
] as const;

// FR-R3-010 — emitted by `WorkspaceStateStore.initialize()` (via
// `migration-audit-forwarder.ts`) when the v11 → v12 reshape partitions the flat
// `KEYS.history` array into the per-queue map. Same three-shape structure as the
// v11 family above and for the same reason: the reshape is what an auditor
// correlates on, and entries that could not be attributed to a queue are a
// separate fact about that reshape rather than a count buried in its payload.
//
// `history-record-repaired` is deliberately a distinct type from v11's
// `run-record-repaired` — the two migrations repair different keys, and one type
// covering both would make "which record was unreadable" a question the payload
// could not answer.
//
// Every payload is queue identifiers, counts and closed reason codes. A history
// entry carries a task description, an error summary and a feature id; none of
// the three reaches the log, so `SECRET_PATTERNS` is unchanged. Additive — no
// `AUDIT_SCHEMA_VERSION` bump, following the 030 / 065 / 093 migration-event
// precedent.
export const MIGRATION_V12_EVENT_TYPES = [
  'state-migrated-v11-to-v12',
  'history-entries-unattributed',
  'history-record-repaired'
] as const;

// Feature 072 — task-level execution lifecycle events. Bridges the gap
// between operator-driven queue events (task-enqueued, task-removed, etc.)
// and system-driven phase events (phase-start, phase-end). Enables the
// Metrics Dashboard (073) to derive task-level timing, counts, and terminal
// status directly from the append-only audit log. `phase-jumped` is grouped
// here because it co-ships and is a task lifecycle concern (prevents task
// failure metric corruption when Feature 071 "Jump to Next Step" fires).
// Additive — no `AUDIT_SCHEMA_VERSION` bump.
export const TASK_EXECUTION_EVENT_TYPES = [
  'task-execution-started',
  'task-execution-ended',
  'task-execution-paused',
  'phase-jumped'
] as const;

// Feature 076 — emitted after an optional phase reaches a terminal failed or
// timed-out outcome and the sequencer continues to the next phase. The
// payload is deliberately structural and paths-free: no configured CLI path,
// stdout/stderr, environment value, operator-authored instruction, or stack
// trace is permitted. The ordinary `phase-end` remains the authoritative
// failure evidence; this event records only the continuation decision.
export const OPTIONAL_PHASE_EVENT_TYPES = [
  'phase-optional-failure-continued'
] as const;

// Feature 075 — operator-requested backend diagnostics. Payloads are bounded
// structural data only: runner, status, timing, generic cause, and numeric
// exit code. Paths, environment values, output, and stack traces are forbidden.
export const BACKEND_PING_EVENT_TYPES = ['backend-ping'] as const;

// Feature 073 — Metrics Dashboard adoption tracking (FR-022). Emitted at
// most once per session on first Metrics tab activation. Additive — no
// `AUDIT_SCHEMA_VERSION` bump.
export const METRICS_EVENT_TYPES = ['metrics-view-opened'] as const;

// FR-R3-064 — the per-run record of which backend a run was admitted to and
// under what containment posture. Additive — no `AUDIT_SCHEMA_VERSION` bump
// (follows the 028 / 030 / 031 / 032 precedent recorded above). Historical logs
// lack the event entirely, which the warn-and-preserve parser already tolerates.
//
// WHY THIS EXISTS
//
// `schegent.backend.allowUncontainedBackends`' shipped description promised that
// "every run that uses an uncontained backend records the fact in the audit log"
// and nothing recorded it. FR-R3-056 shipped the refusal at
// `createBackendRunner` and filed the missing per-run record as outstanding in
// `docs/architecture/agent-capability-posture.md`; this closes it (shape B).
//
// WHAT IT IS NOT
//
// It is not the enforcement. `createBackendRunner` still refuses at the last
// point before an uncontained backend exists as an object, and this event does
// not move, weaken, or duplicate that. It is not a consent *prompt* either — the
// setting is the consent surface, which is shape 3's recorded decision.
//
// ONE EVENT, BOTH CLASSIFICATIONS
//
// A `codex` run records `containment: 'os-enforced'`. That is deliberate: the
// absence of an entry has to mean "not recorded", so the contained case is
// recorded evidence rather than silence. Consent is the `containment: 'none'`
// case, which is a property of the payload rather than of a second event type.
export const BACKEND_POSTURE_EVENT_TYPES = ['backend-posture-admitted'] as const;

/**
 * FR-R3-083 / FR-R3-054 §5 — a terminal state that does not lie, in EVIDENCE.
 *
 * When the backend's process group cannot be proven gone within the grace window
 * after SIGKILL, the runner logs a warning. `FR-R3-054`'s acceptance asks for the
 * degraded path to be "visibly recorded in evidence", and a runtime-log line is not
 * evidence: it is not in the audit record, so an operator reconstructing why a
 * later phase saw foreign writes has nothing to read.
 *
 * SIGKILL is not catchable, so a group that survives it is a group Schegent does
 * not own. That is a fact about a Run and belongs in the Run's record.
 *
 * WHY AN EVENT AND NOT A `TerminationReason`
 *
 * `FR-R3-054` §5 named the reason it did not ship one: that union is closed and
 * persisted in `WorkflowRun`, so extending it is a state-schema change with its own
 * migration story. `FR-R3-064` established the shape used instead — an audit event
 * carrying the Run's identity, needing no migration — and this follows it.
 *
 * ABSENCE IS THE SIGNAL. No event is emitted when the tree is confirmed gone, so a
 * Run with no such entry is a Run whose descendants were accounted for.
 */
export const PROCESS_TREE_EVENT_TYPES = ['process-tree-unconfirmed'] as const;

/**
 * The closed payload for a `process-tree-unconfirmed` entry.
 *
 * Identifiers and a bounded classification, and nothing else. No path, no argv, no
 * operator-authored content, no message — the same discipline
 * `BackendPostureAdmittedPayload` states for itself, and for the same reason: a
 * payload with nowhere to put a secret needs no redaction to be safe.
 *
 * `pid` is the direct child's, and is present because an operator with a surviving
 * process to find needs somewhere to start. It is a runtime identifier of a process
 * this product spawned, not a property of the workspace.
 */
export interface ProcessTreeUnconfirmedPayload {
  /**
   * Which adapter's tree it was. A closed union, so this payload's "nowhere to put
   * a secret" claim is enforced by the type rather than asserted by a comment.
   */
  readonly runner: RunnerLabel;
  /** The direct child's pid, or `null` when the child never had one. */
  readonly pid: number | null;
  /**
   * WHICH RUNGS ACTUALLY RAN before the group was found alive.
   *
   * One member today — `sigterm-then-sigkill` — because the ladder escalates on the
   * GROUP, so a report is only reachable after a delivered SIGKILL. See
   * `TreeEscalation` for the arm that existed briefly and was removed, and why.
   *
   * Carried from the runner rather than stamped here: if a rung is ever added, it
   * reaches the audit record without an edit to the recorder.
   */
  readonly escalation: TreeEscalation;
}

/**
 * FR-R3-064 — the closed payload for a backend-posture audit entry.
 *
 * Three bounded primitives and nothing else. No argv, no CLI path, no cwd, no
 * workspace root, no message, no free-form text. `SECRET_PATTERNS` is unchanged
 * because the payload has nowhere to put a secret — the same discipline
 * `ProcessExchangePayload` states for itself, and for the same reason: keeping
 * a value out is more reliable than filtering it on the way through.
 */
export interface BackendPostureAdmittedPayload {
  /** The backend this run was admitted to. */
  readonly runner: BackendRunnerKind;
  /**
   * The classification that backend's own argv carries, from
   * `services/backend-containment-policy`. Derived at emission from the runner
   * kind — never passed in, so it cannot disagree with the policy.
   */
  readonly containment: BackendContainment;
  /**
   * `schegent.backend.allowUncontainedBackends` as it read at THIS emission.
   *
   * Never a cached value. `extension.ts` reads the setting once at activation
   * for the registry's construction-time refusal; reusing that would record an
   * activation-time posture for a run happening now, which is the cached-verdict
   * defect FR-R3-056 finding 1 removed.
   */
  readonly uncontainedAllowed: boolean;
}

// Feature 084 — Phase exchange (FR-047, FR-049). The payload records the
// operation, the resource ids, the scope, the per-resource outcomes, and the
// counts, and nothing else. Document contents, instruction or skill text, file
// names, absolute paths, and workspace roots are forbidden (FR-048) — see
// `ProcessExchangePayload` below, which has no field that could carry them.
//
// `process-exchange-import-refused` is what makes FR-049 hold on the read side:
// a document this build declined leaves a record, so a blocked import is
// distinguishable from an import that never happened. A refusal that a
// capability gate produced is audited by the trust gate at commit instead, under
// `trust.capability-denied` — the two are separate events because they are
// separate decisions, taken at different times, about different things.
//
// Feature 085 adds `process-exchange-import-committed`, and only because a
// package can land in pieces (FR-042a). 084 audited no write at all: one Phase
// either landed or it did not, and the catalog was the record. A package writes
// two layers that can succeed independently, so two layers agreeing with each
// other no longer says anything about the document that produced them — the
// commit record is what makes a partial import distinguishable from an operator
// who imported the Phases alone (FR-061).
// Additive — no `AUDIT_SCHEMA_VERSION` bump.
export const PROCESS_EXCHANGE_EVENT_TYPES = [
  'process-exchange-export',
  'process-exchange-import-refused',
  'process-exchange-import-committed'
] as const;

// Feature 092 (T066, FR-038, FR-038a) — one record per overlap *episode*, not
// per drain tick: emitted the moment the workspace's in-flight count crosses
// from one to two, and not again until it has dropped back below two. The
// payload carries the FR-023a core fields plus `queueIds`, the identifiers of
// the queues in flight at that instant. Identifiers only — a queue name is
// operator-authored content and the audit log never learns one; the UI resolves
// ids to names at display time.
export const CONCURRENCY_EVENT_TYPES = ['runs-overlapped'] as const;

// FR-R3-077 / FR-R3-079 (feature 153) — the two point-of-effect refusals this
// round added, as evidence rather than as log lines.
//
// `run-snapshot-declined` is the read side of the execution fence: a driver
// loaded a Run record stamped at a generation the ownership registry has since
// superseded, and refused to act on it. `output-target-refused-at-dispatch` is
// the output target's second verdict, taken immediately before the frozen plan
// reaches the runner, when a component of the target's path stopped resolving
// inside the workspace after the operator confirmed it.
//
// Both record a refusal (`failure` in the three-arm outcome vocabulary) and both are additive — no `AUDIT_SCHEMA_VERSION`
// bump. A refusal nobody can see afterwards is a refusal nobody can act on.
export const POINT_OF_EFFECT_EVENT_TYPES = [
  'run-snapshot-declined',
  'output-target-refused-at-dispatch'
] as const;

// Feature 100 (T513, FR-052, FR-053, FR-054, FR-055) — the three catalog
// lifecycle transitions that move a definition's pointers. Three event types
// rather than one with an `operation` field, because FR-052 asks for exactly
// that: an operator reading the log filters on the event type, and three
// literals make "what publications happened" a selection rather than a scan
// with a predicate.
//
// The three that are here are the three that move a pointer. `saveDraft` and
// `discardDraft` are deliberately absent (FR-054, SC-010): a draft is work in
// progress, its record is the store's own version history, and auditing every
// keystroke-adjacent save would turn the log into a second copy of that history
// — 085's rule for `import`, applied to the operations it applies to.
//
// The payload is `CatalogLifecyclePayload` below, which has no field a body, a
// note, or a workspace root could ride out in. Additive — no
// `AUDIT_SCHEMA_VERSION` bump: `isKnownAuditEventType` already skips a literal
// it does not recognize and the parser's warn-and-preserve discipline carries an
// unknown one through, so no existing consumer breaks on these (FR-055, and the
// same reasoning 084/085/092 recorded above).
export const CATALOG_LIFECYCLE_EVENT_TYPES = [
  'definition-published',
  'definition-deactivated',
  'definition-restored'
] as const;

export const ALL_AUDIT_EVENT_TYPES = [
  ...PHASE_EVENT_TYPES,
  ...RUNNER_EVENT_TYPES,
  ...LOOP_EVENT_TYPES,
  ...LIFECYCLE_EVENT_TYPES,
  ...MONITOR_EVENT_TYPES,
  ...AUDIT_PIPELINE_EVENT_TYPES,
  ...SESSION_ARTIFACT_EVENT_TYPES,
  ...RETRY_CONDITION_EVENT_TYPES,
  ...DELAYED_RETRY_EVENT_TYPES,
  ...PHASE_CONTROL_EVENT_TYPES,
  ...QUEUE_CONTROL_EVENT_TYPES,
  ...PHASE_MESSAGE_EVENT_TYPES,
  ...FATAL_SIGNATURE_EVENT_TYPES,
  ...AUTO_COMPACT_OVERRIDE_EVENT_TYPES,
  ...PHASE_LOG_EVENT_TYPES,
  ...PHASE_BREAKPOINT_EVENT_TYPES,
  ...STATE_MIGRATION_EVENT_TYPES,
  ...WORKSPACE_LIFECYCLE_EVENT_TYPES,
  ...TRUST_GATE_EVENT_TYPES,
  ...QUEUE_FULL_RESET_EVENT_TYPES,
  ...RESET_TRANSACTION_EVENT_TYPES,
  ...SCHEDULE_EVENT_TYPES,
  ...MIGRATION_V7_EVENT_TYPES,
  ...MIGRATION_V11_EVENT_TYPES,
  ...MIGRATION_V12_EVENT_TYPES,
  ...TASK_EXECUTION_EVENT_TYPES,
  ...OPTIONAL_PHASE_EVENT_TYPES,
  ...BACKEND_PING_EVENT_TYPES,
  ...BACKEND_POSTURE_EVENT_TYPES,
  ...PROCESS_TREE_EVENT_TYPES,
  ...METRICS_EVENT_TYPES,
  ...PROCESS_EXCHANGE_EVENT_TYPES,
  ...CONCURRENCY_EVENT_TYPES,
  ...POINT_OF_EFFECT_EVENT_TYPES,
  ...CATALOG_LIFECYCLE_EVENT_TYPES
] as const;

export type PhaseEventType = (typeof PHASE_EVENT_TYPES)[number];
export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];
export type LoopEventType = (typeof LOOP_EVENT_TYPES)[number];
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
export type MonitorAuditEventType = (typeof MONITOR_EVENT_TYPES)[number];
export type AuditPipelineEventType = (typeof AUDIT_PIPELINE_EVENT_TYPES)[number];
export type SessionArtifactEventType = (typeof SESSION_ARTIFACT_EVENT_TYPES)[number];
export type RetryConditionEventType = (typeof RETRY_CONDITION_EVENT_TYPES)[number];
export type DelayedRetryEventType = (typeof DELAYED_RETRY_EVENT_TYPES)[number];
export type PhaseControlEventType = (typeof PHASE_CONTROL_EVENT_TYPES)[number];
export type QueueControlEventType = (typeof QUEUE_CONTROL_EVENT_TYPES)[number];
export type PhaseMessageEventType = (typeof PHASE_MESSAGE_EVENT_TYPES)[number];
export type FatalSignatureEventType = (typeof FATAL_SIGNATURE_EVENT_TYPES)[number];
export type AutoCompactOverrideEventType = (typeof AUTO_COMPACT_OVERRIDE_EVENT_TYPES)[number];
export type PhaseLogEventType = (typeof PHASE_LOG_EVENT_TYPES)[number];
export type PhaseBreakpointEventType = (typeof PHASE_BREAKPOINT_EVENT_TYPES)[number];
export type StateMigrationEventType = (typeof STATE_MIGRATION_EVENT_TYPES)[number];
export type WorkspaceLifecycleEventType = (typeof WORKSPACE_LIFECYCLE_EVENT_TYPES)[number];
export type TrustGateEventType = (typeof TRUST_GATE_EVENT_TYPES)[number];
export type QueueFullResetEventType = (typeof QUEUE_FULL_RESET_EVENT_TYPES)[number];
export type ResetTransactionEventType = (typeof RESET_TRANSACTION_EVENT_TYPES)[number];
export type ScheduleAuditEventType = (typeof SCHEDULE_EVENT_TYPES)[number];
export type MigrationV7EventType = (typeof MIGRATION_V7_EVENT_TYPES)[number];
export type MigrationV11EventType = (typeof MIGRATION_V11_EVENT_TYPES)[number];
export type MigrationV12EventType = (typeof MIGRATION_V12_EVENT_TYPES)[number];
export type TaskExecutionEventType = (typeof TASK_EXECUTION_EVENT_TYPES)[number];
export type BackendPingEventType = (typeof BACKEND_PING_EVENT_TYPES)[number];
export type BackendPostureEventType = (typeof BACKEND_POSTURE_EVENT_TYPES)[number];
export type ProcessTreeEventType = (typeof PROCESS_TREE_EVENT_TYPES)[number];
export type OptionalPhaseEventType = (typeof OPTIONAL_PHASE_EVENT_TYPES)[number];
export type MetricsEventType = (typeof METRICS_EVENT_TYPES)[number];
export type ProcessExchangeEventType = (typeof PROCESS_EXCHANGE_EVENT_TYPES)[number];
export type CatalogLifecycleEventType = (typeof CATALOG_LIFECYCLE_EVENT_TYPES)[number];

/**
 * Feature 084 — the closed payload for a process exchange audit entry, widened
 * by feature 085 to name the Pipeline kind as well. Closed on purpose: FR-048
 * forbids document contents, authored text, file names, absolute paths, and
 * workspace roots, and the way to keep them out is to give the payload nowhere
 * to put them.
 *
 * Widening `resourceKind` adds a second literal and nothing else. A Pipeline
 * document carries strictly more operator-authored text than a Phase one — port
 * labels, binding keys, a whole referenced sequence — so the way the envelope
 * holds is that it still has no field any of that could go in. Feature 096's
 * `'modelCatalog'` literal holds for the same reason: a model id and a backend
 * name are still just declared identifiers, and the envelope has nowhere to
 * put either beyond `resourceIds`.
 *
 * `import-commit` is the third and last operation: what a confirmed package
 * write did to one catalog layer. It reuses this envelope rather than getting
 * one of its own (research R10), so the fields a package import can record stay
 * the fields a Phase export could record, which is the property FR-060 rests on.
 */
export interface ProcessExchangePayload {
  readonly operation: 'export' | 'import-preflight' | 'import-commit';
  /** Feature 086 adds `'workflow'`; feature 096 adds `'modelCatalog'`. */
  readonly resourceKind: 'phase' | 'pipeline' | 'workflow' | 'modelCatalog';
  /**
   * Empty for a document-level refusal: a refused document named no resource,
   * which is itself the fact worth recording (FR-027).
   */
  readonly resourceIds: readonly string[];
  // Feature 099 (T490b, FR-043) — `scope: PhaseDefinitionScope | null` stood here,
  // recording which layer an exported definition resolved from. There is one layer,
  // so the field's only remaining value would have been `null` on every event, and a
  // field that is always null is a layer tier that has been hidden rather than
  // removed. Deleted, not narrowed.
  //
  // No `AUDIT_SCHEMA_VERSION` bump follows (FR-060): nothing reads this field back
  // — `audit-log-parser.ts` never projected it — so no reader of a historical log
  // loses information it was using, and pre-release there is no installed base of
  // logs to stay shape-compatible with. This feature still emits zero audit events;
  // it only narrows what an existing one carries.
  /**
   * For an export, the result outcome. For a refusal, the refusal code — one of a
   * closed set of seven literals, never document-derived text (FR-048). For a
   * commit, `'imported'` or the rejection reason the save gate returned, which is
   * likewise a literal this build chose.
   */
  readonly outcomes: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Feature 100 (T513, FR-053, FR-054) — the closed payload shared by all three
 * `CATALOG_LIFECYCLE_EVENT_TYPES`.
 *
 * Three fields, and the closure is the requirement rather than an economy. FR-054
 * forbids a definition body, operator-authored description text, and a workspace
 * root path, and the way to keep them out is to give the payload nowhere to put
 * them — 084's envelope discipline, applied to a different write. There is no
 * `body`, no `draftBody`, no `note`, no `name`, no `workspaceRoot`, and no `path`.
 *
 * FR-053's fourth item — "the time it occurred" — is the audit entry's own
 * `timestamp` and is deliberately NOT a payload field. Every entry carries one,
 * so a `publishedAt` here would be a second clock reading of the same instant,
 * and two timestamps that can disagree is worse than one that cannot.
 *
 * `versionId` names a different version per event, because each operation is
 * about a different one, and the event type is what says which:
 *
 *   definition-published    → the version that BECAME active.
 *   definition-deactivated  → the version that WAS active and is now held as the
 *                             definition's draft (FR-024a). Deactivation writes no
 *                             new record, so this is the version that stopped
 *                             being live, which is the fact worth recording.
 *   definition-restored     → the version restored FROM — the operator's
 *                             selection, and the only thing that distinguishes one
 *                             restore from another. The draft it produced is
 *                             bookkeeping the store already holds.
 *
 * One envelope with a per-event reading, rather than three payload types or three
 * differently-named fields: the union of a `fromVersionId`, an `activeVersionId`,
 * and a `deactivatedVersionId` would be three optional fields of which exactly one
 * is ever set, which is a discriminated union spelled badly.
 */
export interface CatalogLifecyclePayload {
  readonly resourceKind: CatalogKind;
  /** The definition's id — sanitized and length-bounded by the emitter. */
  readonly resourceId: string;
  /** A store-assigned `v<N>`; see the per-event reading above. */
  readonly versionId: string;
}

export type AuditEventType = (typeof ALL_AUDIT_EVENT_TYPES)[number];

/**
 * FR-R3-077 (T1040) — both generations, never a bare "declined".
 *
 * An operator reading this needs to know which generation wrote the record and
 * which one is live; the difference between them is the whole finding.
 */
export interface RunSnapshotDeclinedPayload {
  readonly runId: string;
  readonly writtenAtFence: number;
  readonly liveFence: number;
}

/**
 * FR-R3-079 (T1058) — which output port was refused, and what the checked walk
 * refused it for. The path itself is deliberately absent: workspace paths are
 * not serialized into the structured audit log.
 */
export interface OutputTargetRefusedAtDispatchPayload {
  readonly runId: string;
  readonly portId: string;
  readonly reason: string;
}

export interface OptionalPhaseFailureContinuedPayload {
  readonly runId: string;
  readonly pipelineId?: string;
  readonly phaseId: string;
  readonly runner: BackendRunnerKind;
  readonly iteration: number;
  readonly terminationReason: TerminationReason;
}

// Feature 072 — payload interfaces for task-level execution lifecycle events.

// Emitted by `QueueManager.markInFlight()` when a pending task transitions
// to `in-flight`. `isResume` is `true` when the entry is via restart or
// resume (derived from `FeatureRequest.status` at call time).
export interface TaskExecutionStartedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly queueId: string;
  readonly pipelineId: string;
  readonly isResume: boolean;
  readonly scheduledStartAt?: number;
}

// Emitted by `RunDriver.drive()` when a task reaches a terminal state.
// `terminalStatus` mirrors `HistoryEntry.terminalStatus`. `durationMs` is
// wall-clock time: `Date.now() - WorkflowRun.startedAt`, consistent with
// `buildHistoryEntry()`. `lastErrorSummary` is already sanitized by
// `SanitizedFailureMetadata`.
export interface TaskExecutionEndedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly terminalStatus: 'completed' | 'failed' | 'canceled';
  readonly durationMs: number;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly lastErrorSummary?: string;
}

// Emitted by `WorkflowController.pauseActivePhase()` when a task stops
// making forward progress. Separate from `phase-pause-requested` (which
// describes what is being paused) and `queue-paused` (queue-level impact).
export interface TaskExecutionPausedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly pauseCause:
    | 'operator-paused'
    | 'breakpoint-paused'
    | 'queue-paused-mid-run'
    | 'rate-limit'
    | 'retry-cap-exhausted';
}

// Emitted at the jump cancellation boundary when Feature 071's "Jump to
// next step" cancels a running or paused phase. REPLACES what would
// otherwise be a `phase-end { outcome: 'failed' }` emission for the
// jumped phase — `phase-jumped` and `phase-end` are mutually exclusive
// for a given phase execution. Must NOT trigger `RetryCoordinator`
// delayed-retry logic or contribute to `DELAYED_RETRY_CAP` exhaustion.
export interface PhaseJumpedPayload {
  readonly phaseId: string;
  readonly runId: string;
  readonly pipelineId: string;
  readonly durationMs: number;
  readonly iterationN: number;
  readonly reason: 'operator-jump';
}

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
  // Feature 099 (T492, FR-046) — the two layer-override capabilities are gone;
  // these two gate document content and stay.
  readonly capability: 'phases' | 'retryConditions';
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

// Feature FR-R3-006 (T348) — payload for `workspace-state-reset`. Five fields,
// every one of them either a counter this build produced or a literal from a
// closed union declared in `reset-transaction.ts`. Nothing operator-authored
// can reach it, which is how the "no paths, no task descriptions" constraint is
// kept: the envelope has nowhere to put either.
//
// `phaseReached` is the interesting field on a failure. The six phases exist in
// one order for a reason, so naming the one the transaction stopped at says
// what did and did not happen — a stop at `quiesce` cleared nothing and left
// the wiring up, a stop at `clear` means producers were already torn down and
// the marker is `in-progress`. A boolean success flag could not distinguish
// those, and they need different operator responses.
//
// `generation` is null only when the transaction never reached the mark, so a
// refusal reads as "no reset happened" rather than as generation 0.
export interface WorkspaceStateResetPayload {
  readonly outcome: 'completed' | 'refused' | 'failed';
  readonly phaseReached: ResetPhase;
  readonly generation: number | null;
  /** Null on success; one of the closed refusal reasons otherwise. */
  readonly refusalReason: ResetRefusalReason | null;
  /**
   * How many Runs the quiesce phase cancelled. A count, never an id — which
   * Run it was is a task-scoped fact and this is a workspace-scoped event.
   */
  readonly canceledRunCount: number;
}

export interface RetryEvaluatedPayload {
  readonly pipelineId?: string;
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
  readonly pipelineId?: string;
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

// Feature 073 — payload for `metrics-view-opened` (FR-022 adoption
// tracking). Bounded to a single session identifier — no workspace root
// path, no operator-authored content (contracts/metrics-view-opened-event.md).
export interface MetricsViewOpenedPayload {
  readonly sessionId: string;
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
    'session-retention-applied',
    // State migration / repair
    'state-migrated',
    'workflow-run-repaired',
    'state-migrated-v6-to-v7',
    // Feature FR-R3-006 — the reset transaction. System-scoped without
    // qualification: it is the one event whose subject is the whole workspace
    // state rather than any Run, and it carries no runId to resolve against a
    // Run that, by the time the entry lands, no longer exists.
    'workspace-state-reset',
    // Feature 093 — the v10 → v11 reshape and its repairs. System-scoped even
    // though `run-reassigned-to-default-queue` names a Run: it is emitted before
    // any Run is driven, so the runId it carries has no reachable Run behind it
    // yet and an Activity Feed entry would hang off nothing.
    'state-migrated-v10-to-v11',
    'run-reassigned-to-default-queue',
    'run-record-repaired',
    // FR-R3-010 — the v11 → v12 history partition and its repairs. System-scoped
    // on the same reasoning: emitted before any Run is driven, and the entries it
    // reshapes belong to Runs that have already ended, so there is no live Run for
    // an Activity Feed entry to hang off.
    'state-migrated-v11-to-v12',
    'history-entries-unattributed',
    'history-record-repaired',
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
    // Feature 092 — a concurrency overlap is a property of the workspace, not
    // of any one Run, so it belongs in the System tab rather than an Activity
    // Feed entry that would have to pick a run to hang off.
    'runs-overlapped',
    // BUG-006 — system-armed scheduled restore after retry-cap-exhausted
    // rate-limit pause (FR-026); fallback when reset is unparseable or
    // outside the 7-day horizon (FR-027).
    'system-pause-scheduled-restore',
    'system-pause-restore-unavailable',
    // Workspace / trust gates
    'multi-root.warning-shown',
    'trust.capability-denied',
    // Feature 073 — Metrics Dashboard adoption tracking; not tied to a
    // specific workflow run.
    'backend-ping',
    'metrics-view-opened',
    // Feature 084 — Phase exchange is a catalog operation, not part of any
    // workflow run, so it belongs in the System scope alongside the other
    // run-independent events above.
    'process-exchange-export',
    'process-exchange-import-refused',
    // Feature 085 — a package import commit is the same kind of thing: a
    // catalog write the operator asked for, belonging to no run.
    'process-exchange-import-committed',
    // Feature 100 (T513) — the three lifecycle transitions are catalog writes on
    // the same footing: the operator asked for them, they belong to no run, and
    // they carry no `runId` an Activity Feed entry could hang off. A run holding a
    // frozen plan is unaffected by them by construction (FR-010, FR-026), so there
    // is not even an indirect run for the task scope to claim.
    'definition-published',
    'definition-deactivated',
    'definition-restored'
  ])
);

// Feature 064 — pure classifier mapping an event-type literal to the
// snapshot scope. Unknown event types default to `'task'` scope (FR-011).
// O(1), side-effect free.
export function classifyAuditEvent(eventType: string): AuditScope {
  return SYSTEM_SCOPED_EVENT_TYPES.has(eventType as AuditEventType) ? 'system' : 'task';
}
