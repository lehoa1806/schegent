// Authoritative sidebar IPC contract; host and webview shims re-export it.
export const SCHEMA_VERSION = 3 as const;
// -- Command literals (webview → host) ---------------------------------------

export const CMD_START = 'CMD_START' as const;
export const CMD_CANCEL = 'CMD_CANCEL' as const;
export const CMD_RESUME = 'CMD_RESUME' as const;
export const CMD_RESET = 'CMD_RESET' as const;
export const CMD_REMOVE_QUEUE_ITEM = 'CMD_REMOVE_QUEUE_ITEM' as const;
export const CMD_OPEN_AUDIT_LOG = 'CMD_OPEN_AUDIT_LOG' as const;
export const CMD_RETRY_QUEUE_ITEM = 'CMD_RETRY_QUEUE_ITEM' as const;
export const CMD_MOVE_QUEUE_ITEM_UP = 'CMD_MOVE_QUEUE_ITEM_UP' as const;
export const CMD_MOVE_QUEUE_ITEM_DOWN = 'CMD_MOVE_QUEUE_ITEM_DOWN' as const;
export const CMD_CLEAR_COMPLETED = 'CMD_CLEAR_COMPLETED' as const;
export const CMD_CLEAR_FAILED = 'CMD_CLEAR_FAILED' as const;
export const CMD_PAUSE_QUEUE = 'CMD_PAUSE_QUEUE' as const;
export const CMD_RESUME_QUEUE = 'CMD_RESUME_QUEUE' as const;
export const CMD_OPEN_DASHBOARD = 'CMD_OPEN_DASHBOARD' as const;
export const CMD_RETRY_ACTIVE_RUN = 'CMD_RETRY_ACTIVE_RUN' as const;
export const CMD_RERUN_FROM_HISTORY = 'CMD_RERUN_FROM_HISTORY' as const;
export const CMD_OPEN_QUEUE_ITEM_DETAILS = 'CMD_OPEN_QUEUE_ITEM_DETAILS' as const;
export const CMD_OPEN_HISTORY_ITEM_DETAILS = 'CMD_OPEN_HISTORY_ITEM_DETAILS' as const;
// Feature 011 — pipelines/phases/models catalog save (operator-authored).
export const CMD_SAVE_PIPELINES = 'CMD_SAVE_PIPELINES' as const;
export const CMD_SAVE_PHASES = 'CMD_SAVE_PHASES' as const;
export const CMD_SAVE_MODELS = 'CMD_SAVE_MODELS' as const;
export const CMD_SAVE_WORKFLOWS = 'CMD_SAVE_WORKFLOWS' as const; // Feature 083.
// Feature 011 — scalar settings save + manual delayed-retry trigger.
export const CMD_SAVE_GENERAL_SETTINGS = 'CMD_SAVE_GENERAL_SETTINGS' as const;
export const CMD_RETRY_PHASE_NOW = 'CMD_RETRY_PHASE_NOW' as const;
// Feature 014 — Wake up settings save (Global-scope; primary-host only).
// Persists `schegent.wakeUp.*` settings transactionally and drives the
// per-user OS daemon (launchd / Task Scheduler / cron / systemd-user).
// See specs/014-wake-up/contracts/wakeup-settings-ipc.md.
export const CMD_SAVE_WAKEUP_SETTINGS = 'CMD_SAVE_WAKEUP_SETTINGS' as const;
export const CMD_WAKE_UP_NOW = 'CMD_WAKE_UP_NOW' as const;
// Feature 017 — phase controls, multi-queue CRUD/scheduling, task CRUD, and
// queue settings. Existing queue commands above (`CMD_START`,
// `CMD_REMOVE_QUEUE_ITEM`, `CMD_PAUSE_QUEUE`, `CMD_RESUME_QUEUE`) are
// generalized by payload rather than duplicated.
export const CMD_PAUSE_PHASE = 'CMD_PAUSE_PHASE' as const;
export const CMD_RESUME_PHASE = 'CMD_RESUME_PHASE' as const;
export const CMD_RESTART_PHASE = 'CMD_RESTART_PHASE' as const;
export const CMD_SKIP_PHASE = 'CMD_SKIP_PHASE' as const;
export const CMD_DISABLE_PHASE = 'CMD_DISABLE_PHASE' as const;
export const CMD_ENABLE_PHASE = 'CMD_ENABLE_PHASE' as const;
export const CMD_REMOVE_TASK_PHASE = 'CMD_REMOVE_TASK_PHASE' as const;
// Feature 030 — single-queue mode removed multi-queue mutation commands:
//   CMD_CREATE_QUEUE, CMD_RENAME_QUEUE, CMD_DELETE_QUEUE,
//   CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE,
//   CMD_SAVE_QUEUE_SETTINGS, CMD_MOVE_TASK.
// The unified queue is reorder-only; `CMD_REORDER_TASK` drives both the
// drag-and-drop drop event and the up/down arrow buttons.
export const CMD_MODIFY_TASK = 'CMD_MODIFY_TASK' as const;
export const CMD_REORDER_TASK = 'CMD_REORDER_TASK' as const;
// Feature 017 — BUG-001. Transition a `canceled` `FeatureRequest` back
// to `pending` by id so the queue dequeue pump picks it up again on the
// next tick. Distinct from `CMD_RETRY_QUEUE_ITEM` (which already
// generalizes to `canceled` via FR-034) so the dashboard "Restart"
// affordance for canceled rows has a single, taxonomy-correct command.
export const CMD_RESTART_CANCELED_TASK = 'CMD_RESTART_CANCELED_TASK' as const;

// Feature 020 — phase log read + tail commands. All READ-ONLY; they
// MUST stay out of `MUTATING_COMMANDS` so a secondary VS Code host can
// still read phase logs in a multi-window session. See
// specs/020-phase-level-logs/contracts/phase-log-ipc.md.
export const CMD_READ_PHASE_LOG = 'CMD_READ_PHASE_LOG' as const;
export const CMD_START_PHASE_LOG_TAIL = 'CMD_START_PHASE_LOG_TAIL' as const;
export const CMD_STOP_PHASE_LOG_TAIL = 'CMD_STOP_PHASE_LOG_TAIL' as const;
// Feature 020 — small helper command that opens the VS Code Settings
// editor scoped to `schegent.logging.verbose`. Powers the empty-state
// "Open Settings" CTA when verbose diagnostics is disabled. Read-only
// (the operator still has to flip the toggle by hand).
export const CMD_OPEN_VERBOSE_SETTING = 'CMD_OPEN_VERBOSE_SETTING' as const;
// Feature 028 — future-phase breakpoints. Operator marks a pending phase
// as a "pause when reached" point. The pipeline runs preceding phases
// then halts before invoking the marked phase. Both are mutating —
// members of `MUTATING_COMMANDS` (primary-host-only gate).
// See specs/028-advanced-phase-pausing/contracts/ipc.md.
export const CMD_SET_PHASE_BREAKPOINT = 'CMD_SET_PHASE_BREAKPOINT' as const;
export const CMD_CLEAR_PHASE_BREAKPOINT = 'CMD_CLEAR_PHASE_BREAKPOINT' as const;
// Feature 031 — wake-up session-log read + reveal. Both are READ-ONLY;
// they MUST stay out of `MUTATING_COMMANDS` so a secondary VS Code host
// can still inspect captured sessions in a multi-window session. The
// dispatcher still enforces the primary-host gate for the reveal IPC
// (the host-side `revealFileInOS` side effect MUST originate from a
// single host so we don't open multiple OS file-manager windows).
// See specs/031-advanced-wakeup-logs-models/contracts/wakeup-session-log-ipc.md
// and contracts/wakeup-reveal-session-log-ipc.md.
export const CMD_READ_WAKEUP_SESSION_LOG = 'CMD_READ_WAKEUP_SESSION_LOG' as const;
export const CMD_REVEAL_WAKEUP_SESSION_LOG = 'CMD_REVEAL_WAKEUP_SESSION_LOG' as const;
// BUG-002 (FR-012a) — queue-start trigger. Mutating: promotes the oldest
// pending task to in-flight via `controller.drainQueuedWork()`. Member of
// `MUTATING_COMMANDS` and gated by the primary-host check.
export const CMD_START_QUEUE = 'CMD_START_QUEUE' as const;
// Feature 063 — Clean All atomic queue reset. Replaces the separate
// CMD_CLEAR_COMPLETED and CMD_CLEAR_FAILED commands. Mutating: drops
// every queue item (pending, in-flight, paused), cancels the active
// runner if any, and clears the watchdog backoff window in a single
// batched memento write. Member of `MUTATING_COMMAND_REASONS` and
// gated by the primary-host + workspace-lock guards.
export const CMD_CLEAR_ALL = 'CMD_CLEAR_ALL' as const;
// Feature 063 — per-action confirmation-prompt suppression persistence.
// Mutating: writes to the `schegent.ui.confirmSuppression` memento via
// `WorkspaceState`. Member of `MUTATING_COMMAND_REASONS` for audit
// completeness, even though it does not touch run state.
export const CMD_SET_CONFIRM_SUPPRESSION = 'CMD_SET_CONFIRM_SUPPRESSION' as const;
// Feature 065 (T054a / FR-020) — operator dismisses the one-time post-migration
// notice that surfaces when at least one queue migrated into `idle-pending`.
// NON-mutating: the handler performs a single `setQueue({...migrationNotice:
// 'dismissed'})` write that flips a UI flag and does NOT touch workflow,
// queue, or task state. NOT a member of `MUTATING_COMMANDS` — the dismiss
// is non-destructive UX state per FR-020 and parity with the other
// `CMD_OPEN_*` non-mutating commands.
export const CMD_DISMISS_MIGRATION_NOTICE = 'CMD_DISMISS_MIGRATION_NOTICE' as const;
// Feature 073 — read-only Metrics Dashboard scan.
export const CMD_READ_METRICS = 'CMD_READ_METRICS' as const;
export const CMD_PING_BACKEND = 'CMD_PING_BACKEND' as const;

// -- Host message literals (host → webview) ----------------------------------

export const STATE_SNAPSHOT = 'STATE_SNAPSHOT' as const;
export const CMD_ACK = 'CMD_ACK' as const;
// Feature 020 — host → webview push for a single new phase-log entry
// while a tail session is active. See `MSG_PHASE_LOG_ENTRY` payload
// shape below.
export const MSG_PHASE_LOG_ENTRY = 'MSG_PHASE_LOG_ENTRY' as const;

export const COMMAND_TYPES = [
  CMD_START,
  CMD_CANCEL,
  CMD_RESUME,
  CMD_RESET,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_OPEN_AUDIT_LOG,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_OPEN_DASHBOARD,
  CMD_RETRY_ACTIVE_RUN,
  CMD_RERUN_FROM_HISTORY,
  CMD_OPEN_QUEUE_ITEM_DETAILS,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_PHASES,
  CMD_SAVE_MODELS,
  CMD_SAVE_WORKFLOWS,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_RETRY_PHASE_NOW,
  CMD_SAVE_WAKEUP_SETTINGS,
  CMD_WAKE_UP_NOW,
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_READ_WAKEUP_SESSION_LOG,
  CMD_REVEAL_WAKEUP_SESSION_LOG,
  CMD_START_QUEUE,
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_READ_METRICS,
  CMD_PING_BACKEND
] as const;

export const HOST_MESSAGE_TYPES = [STATE_SNAPSHOT, CMD_ACK, MSG_PHASE_LOG_ENTRY] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];
export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number];
// -- Command payload interfaces ---------------------------------------------

export interface CommandBase<T extends CommandType> {
  readonly type: T;
  readonly correlationId: string;
}

// Feature 065 — start-intent types (StartMode, EnqueueStartIntent,
// StartQueueIntent, IpcScheduledStartSource) live in a sibling module
// to keep this file within its LOC budget. Re-exported here for
// backward-compat with consumers that import from sidebar-ipc.ts.
export type {
  StartMode,
  IpcScheduledStartSource,
  EnqueueStartIntent,
  StartQueueIntent
} from './start-intent-types';

import type { EnqueueStartIntent, StartQueueIntent } from './start-intent-types';
import {
  isValidEnqueueStartIntent,
  isValidStartQueueIntent
} from './start-intent-types';
import type {
  ReadPhaseLogCommand,
  StartPhaseLogTailCommand,
  StopPhaseLogTailCommand
} from './sidebar-ipc/phase-log';
import type {
  ReadWakeupSessionLogCommand,
  RevealWakeupSessionLogCommand
} from './sidebar-ipc/wakeup';
import type { ReadMetricsCommand } from './sidebar-ipc/metrics';

export type {
  ReadPhaseLogRequest,
  ReadPhaseLogCommand,
  ReadPhaseLogResponse,
  StartPhaseLogTailRequest,
  StartPhaseLogTailCommand,
  StartPhaseLogTailResponse,
  StopPhaseLogTailRequest,
  StopPhaseLogTailCommand,
  StopPhaseLogTailResponse
} from './sidebar-ipc/phase-log';
export type {
  ReadWakeupSessionLogCommand,
  ReadWakeupSessionLogResponseSuccess,
  ReadWakeupSessionLogResponseRejected,
  ReadWakeupSessionLogResponse,
  RevealWakeupSessionLogCommand,
  RevealWakeupSessionLogResponseSuccess,
  RevealWakeupSessionLogResponseRejected,
  RevealWakeupSessionLogResponse
} from './sidebar-ipc/wakeup';
export type {
  PhaseRecord,
  TaskRecord,
  PhaseTypeAggregate,
  CostTimelinePoint,
  ReadMetricsRequest,
  ReadMetricsCommand,
  ReadMetricsResponse
} from './sidebar-ipc/metrics';
export { TRUST_DENIED_REASONS } from './sidebar-ipc/trust';
export type {
  TrustCapability,
  ResolvedScope,
  TrustDeniedReason,
  TrustDeniedError
} from './sidebar-ipc/trust';
export type {
  StateSnapshotMessage,
  CommandAckMessage,
  PhaseLogEntryPushMessage,
  HostMessage
} from './sidebar-ipc/host-messages';

export interface StartCommand extends CommandBase<typeof CMD_START> {
  readonly payload: {
    readonly description: string;
    // Feature 011 — optional catalog pipeline override; absent payload
    // means "use the default pipeline at submission time".
    readonly pipelineId?: string;
    // Feature 017 — optional target queue and insertion position. Missing
    // `queueId` resolves to the configured default queue; missing `position`
    // appends at the end of that queue.
    readonly queueId?: string;
    readonly position?: number;
    // Feature 065 — optional start-mode intent (additive). Omission is
    // valid; the host's policy table routes it to the chooser default or
    // the warn-level automation default. See sidebar-ipc.diff.md.
    readonly startIntent?: EnqueueStartIntent;
  };
}

// Feature 017 — BUG-001. The required `taskId` resolves the operator's
// intended cancel target by `FeatureRequest.id` instead of via the
// singular `store.getRun()` projection. This preserves action identity
// when `globalConcurrencyCap > 1` AND after a queue pause/resume swaps
// the current in-flight run.
export interface CancelCommand extends CommandBase<typeof CMD_CANCEL> {
  readonly payload: { readonly taskId: string };
}
export interface ResumeCommand extends CommandBase<typeof CMD_RESUME> {
  readonly payload?: { readonly prompt?: string };
}

export interface ResetCommand extends CommandBase<typeof CMD_RESET> {
  readonly payload: { readonly confirmed: true };
}

export interface RemoveQueueItemCommand extends CommandBase<typeof CMD_REMOVE_QUEUE_ITEM> {
  readonly payload: { readonly id: string; readonly confirmed: true };
}

export interface OpenAuditLogCommand extends CommandBase<typeof CMD_OPEN_AUDIT_LOG> {}

export interface RetryQueueItemCommand extends CommandBase<typeof CMD_RETRY_QUEUE_ITEM> {
  readonly payload: { readonly id: string };
}

export interface MoveQueueItemUpCommand extends CommandBase<typeof CMD_MOVE_QUEUE_ITEM_UP> {
  readonly payload: { readonly id: string };
}

export interface MoveQueueItemDownCommand extends CommandBase<typeof CMD_MOVE_QUEUE_ITEM_DOWN> {
  readonly payload: { readonly id: string };
}

export interface ClearCompletedCommand extends CommandBase<typeof CMD_CLEAR_COMPLETED> {}
export interface ClearFailedCommand extends CommandBase<typeof CMD_CLEAR_FAILED> {}

// Feature 063 — Clean All atomic queue reset. Empty payload object so the
// router can distinguish "operator confirmed" from a malformed message
// without introducing optional fields.
export interface ClearAllCommand extends CommandBase<typeof CMD_CLEAR_ALL> {
  readonly payload?: Record<string, never>;
}

// Feature 063 — per-action confirmation-prompt suppression. The actionKey
// is validated against the closed `ActionKey` union in the suppression
// handler before any memento write.
export interface SetConfirmSuppressionCommand
  extends CommandBase<typeof CMD_SET_CONFIRM_SUPPRESSION> {
  readonly payload: {
    readonly actionKey: string;
    readonly suppressed: boolean;
  };
}

// Feature 065 (T054a / FR-020) — operator dismisses the one-time post-migration
// notice. Payload is empty (the dismiss applies to the single workspace queue;
// the host writes `migrationNotice: 'dismissed'` via `setQueue({...})`).
export interface DismissMigrationNoticeCommand
  extends CommandBase<typeof CMD_DISMISS_MIGRATION_NOTICE> {}

export interface PauseQueueCommand extends CommandBase<typeof CMD_PAUSE_QUEUE> {
  readonly payload?: { readonly queueId?: string; readonly reason?: string };
}

export interface ResumeQueueCommand extends CommandBase<typeof CMD_RESUME_QUEUE> {
  readonly payload?: { readonly queueId?: string; readonly prompt?: string };
}
export interface OpenDashboardCommand extends CommandBase<typeof CMD_OPEN_DASHBOARD> {}
export interface RetryActiveRunCommand extends CommandBase<typeof CMD_RETRY_ACTIVE_RUN> {}

export interface RerunFromHistoryCommand extends CommandBase<typeof CMD_RERUN_FROM_HISTORY> {
  // Feature 013 — Wave 6 (US6, FR-031): `force` is the operator opt-in for
  // legacy entries (recorded before `originalDescription` was persisted).
  // When `force === true`, the rerun proceeds with the truncated preview;
  // otherwise the command rejects with a sanitized warning.
  readonly payload: { readonly runId: string; readonly force?: boolean };
}

export interface OpenQueueItemDetailsCommand extends CommandBase<typeof CMD_OPEN_QUEUE_ITEM_DETAILS> {
  readonly payload: { readonly id: string };
}

export interface OpenHistoryItemDetailsCommand extends CommandBase<typeof CMD_OPEN_HISTORY_ITEM_DETAILS> {
  readonly payload: { readonly id: string };
}

// Catalog saves carry a scoped, revisioned complete-layer envelope; the shapes
// live in a focused module and the barrel stays the single import site.
import type { SavePhasesCommand, SavePipelinesCommand } from './sidebar-ipc/catalog-save';
import type { SaveWorkflowsCommand } from './sidebar-ipc/catalog-save';
export type { SavePhasesCommand, SavePipelinesCommand } from './sidebar-ipc/catalog-save';
export type { SaveWorkflowsCommand } from './sidebar-ipc/catalog-save';

export interface SaveModelsCommand extends CommandBase<typeof CMD_SAVE_MODELS> {
  readonly payload: { readonly models: Record<string, readonly string[]> };
}

// Feature 011 — keys in `updates` are unprefixed scalar setting names;
// the host prepends `schegent.` and validates the full batch against an
// allowlist before writing any key. If a later workspace write fails, the
// host compensates by restoring any keys already written by that batch. See
// specs/011-webui-config-editor/contracts/general-settings-ipc.md.
//
// Supported keys (host-side allowlist lives in
// src/config/general-settings.ts `KEY_SPECS` — webview must mirror but
// is NOT the source of truth):
//   - cli.path, logging.verbose, loop.maxIterations,
//     invocation.timeoutSeconds, watchdog.pollIntervalMinutes,
//     audit.rotation.sizeMB, audit.rotation.maxAgeDays,
//     defaultPipelineId, fatalSignatures,
//     queue.globalConcurrencyCap, logging.runtimeLogLevel,
//     logging.runtimeLogFilePath, logging.runtimeLogMaxBytes,
//     logging.runtimeLogMaxGenerations, retry.maxAttempts.
//   - Feature 012: `claude.autoCompactPctOverride`.
export interface SaveGeneralSettingsCommand
  extends CommandBase<typeof CMD_SAVE_GENERAL_SETTINGS> {
  readonly payload: {
    readonly updates: Readonly<Record<string, unknown>>;
  };
}

// Feature 011 — operates on the active run; no payload. Rejections:
// 'no-active-run', 'not-pending-retry', 'already-retrying',
// 'secondary-window-readonly'.
export interface RetryPhaseNowCommand extends CommandBase<typeof CMD_RETRY_PHASE_NOW> {}

// Feature 014 — Wake up settings save. The payload mirrors the four
// `schegent.wakeUp.*` keys; the host enforces invariants from
// data-model.md (HH:MM regex, "Every Nm/h" regex with ≥ 1-minute floor,
// schedulerType literal) before writing to ConfigurationTarget.Global.
// Rejection reasons are enumerated in
// specs/014-wake-up/contracts/wakeup-settings-ipc.md §Reject-reason vocabulary.
//
// Feature 031 — extended with the optional `model` field carrying the
// operator's `WakeUpModelSelection` (the closed registry plus the
// `'runner-default'` sentinel). The host re-validates membership and
// rejects with `'invalid-model'` for any string outside that set
// (see specs/031-advanced-wakeup-logs-models/contracts/wakeup-settings-ipc.diff.md).
export interface SaveWakeUpSettingsCommand
  extends CommandBase<typeof CMD_SAVE_WAKEUP_SETTINGS> {
  readonly payload: {
    readonly enabled: boolean;
    readonly schedulerType: 'chronological' | 'periodic';
    readonly chronologicalTime: string;
    readonly periodicInterval: string;
    readonly model?: string;
  };
}

export interface WakeUpNowResult {
  readonly outcome: 'started' | 'succeeded' | 'failed' | 'skipped';
  readonly message: string;
  readonly attempt: unknown;
}

export interface WakeUpNowCommand extends CommandBase<typeof CMD_WAKE_UP_NOW> {
  readonly payload?: Record<string, never>;
}

export interface PausePhaseCommand extends CommandBase<typeof CMD_PAUSE_PHASE> {}
export interface ResumePhaseCommand extends CommandBase<typeof CMD_RESUME_PHASE> {
  readonly payload?: { readonly prompt?: string };
}

export interface RestartPhaseCommand extends CommandBase<typeof CMD_RESTART_PHASE> {
  readonly payload: { readonly phaseId: string };
}

export interface SkipPhaseCommand extends CommandBase<typeof CMD_SKIP_PHASE> {
  readonly payload: { readonly phaseId: string };
}

export interface DisablePhaseCommand extends CommandBase<typeof CMD_DISABLE_PHASE> {
  readonly payload: { readonly phaseId: string };
}

export interface EnablePhaseCommand extends CommandBase<typeof CMD_ENABLE_PHASE> {
  readonly payload: { readonly phaseId: string };
}

export interface RemoveTaskPhaseCommand extends CommandBase<typeof CMD_REMOVE_TASK_PHASE> {
  readonly payload: { readonly taskId: string; readonly phaseId: string; readonly confirmed: true };
}

// Feature 030 — removed: CreateQueueCommand, RenameQueueCommand,
// DeleteQueueCommand, SetQueueScheduleCommand, ClearQueueScheduleCommand,
// MoveTaskCommand, SaveQueueSettingsCommand (no multi-queue surface).
export interface ModifyTaskCommand extends CommandBase<typeof CMD_MODIFY_TASK> {
  readonly payload: { readonly taskId: string; readonly description: string };
}

export interface ReorderTaskCommand extends CommandBase<typeof CMD_REORDER_TASK> {
  readonly payload: { readonly taskId: string; readonly newPosition: number };
}

// Feature 017 — BUG-001. Transitions a `canceled` `FeatureRequest` back
// to `pending`. Host rejects with `not-found` when no task matches, or
// `illegal-state` when the matched task is not in `canceled` status.
export interface RestartCanceledTaskCommand
  extends CommandBase<typeof CMD_RESTART_CANCELED_TASK> {
  readonly payload: { readonly taskId: string };
}

export interface OpenVerboseSettingCommand
  extends CommandBase<typeof CMD_OPEN_VERBOSE_SETTING> {}

export interface PingBackendCommand extends CommandBase<typeof CMD_PING_BACKEND> {
  readonly payload: { readonly runner: 'claude' | 'codex' | 'agy' }; }

// Feature 028 — set/clear future-phase breakpoint. Both commands carry
// `{ runId, phaseId }` payloads. The host validates the (runId, phaseId)
// tuple against the run's immutable pipeline snapshot before mutating
// `WorkflowRun.phaseBreakpoints`. Failure codes are enumerated in
// specs/028-advanced-phase-pausing/contracts/ipc.md.
export interface SetPhaseBreakpointCommand
  extends CommandBase<typeof CMD_SET_PHASE_BREAKPOINT> {
  readonly payload: { readonly runId: string; readonly phaseId: string };
}

export interface ClearPhaseBreakpointCommand
  extends CommandBase<typeof CMD_CLEAR_PHASE_BREAKPOINT> {
  readonly payload: { readonly runId: string; readonly phaseId: string };
}

// BUG-002 (FR-012a) — start-queue command. No payload; the host promotes
// the oldest pending task to in-flight. Rejected when no pending tasks
// exist, when the queue is paused, or when a run is already in-flight.
//
// Feature 065 — optional `startIntent` payload (additive). Carries
// `startMode` for now/scheduled/cancel-schedule and the `'operator-restart'`
// source literal. Omission preserves the legacy "no-op promote" semantics.
export interface StartQueueCommand extends CommandBase<typeof CMD_START_QUEUE> {
  readonly payload?: { readonly startIntent?: StartQueueIntent } | Record<string, never>;
}

export type SidebarCommand =
  | StartCommand
  | CancelCommand
  | ResumeCommand
  | ResetCommand
  | RemoveQueueItemCommand
  | OpenAuditLogCommand
  | RetryQueueItemCommand
  | MoveQueueItemUpCommand
  | MoveQueueItemDownCommand
  | ClearCompletedCommand
  | ClearFailedCommand
  | PauseQueueCommand
  | ResumeQueueCommand
  | OpenDashboardCommand
  | RetryActiveRunCommand
  | RerunFromHistoryCommand
  | OpenQueueItemDetailsCommand
  | OpenHistoryItemDetailsCommand
  | SavePipelinesCommand
  | SavePhasesCommand
  | SaveModelsCommand
  | SaveWorkflowsCommand
  | SaveGeneralSettingsCommand
  | RetryPhaseNowCommand
  | SaveWakeUpSettingsCommand
  | WakeUpNowCommand
  | PausePhaseCommand
  | ResumePhaseCommand
  | RestartPhaseCommand
  | SkipPhaseCommand
  | DisablePhaseCommand
  | EnablePhaseCommand
  | RemoveTaskPhaseCommand
  // Feature 030 — single-queue mode dropped CreateQueueCommand,
  // RenameQueueCommand, DeleteQueueCommand, SetQueueScheduleCommand,
  // ClearQueueScheduleCommand, MoveTaskCommand, SaveQueueSettingsCommand.
  | ModifyTaskCommand
  | ReorderTaskCommand
  | RestartCanceledTaskCommand
  | ReadPhaseLogCommand
  | StartPhaseLogTailCommand
  | StopPhaseLogTailCommand
  | OpenVerboseSettingCommand
  | SetPhaseBreakpointCommand
  | ClearPhaseBreakpointCommand
  | ReadWakeupSessionLogCommand
  | RevealWakeupSessionLogCommand
  | StartQueueCommand
  | ClearAllCommand
  | SetConfirmSuppressionCommand
  | DismissMigrationNoticeCommand
  | ReadMetricsCommand
  | PingBackendCommand;

// -- Runtime guards ----------------------------------------------------------
//
// Each guard validates the discriminator literal only — the deeper
// payload validation is performed by `src/ui/sidebar/ipc-validator.ts`.
// The exhaustive `COMMAND_GUARDS` registry is what the message router
// uses to reject unknown command types before any further processing.

function isObjectWithType<T extends string>(value: unknown, type: T): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === type
  );
}

export function isCmdStart(value: unknown): value is StartCommand {
  if (!isObjectWithType(value, CMD_START)) return false;
  // Feature 065 — optional `startIntent` validation. Omission is always
  // valid; presence requires shape per the IPC diff doc.
  const payload = (value as { payload?: unknown }).payload;
  if (payload === undefined || payload === null) return true;
  if (typeof payload !== 'object') return false;
  const intent = (payload as { startIntent?: unknown }).startIntent;
  if (intent === undefined) return true;
  return isValidEnqueueStartIntent(intent);
}

export function isCmdCancel(value: unknown): value is CancelCommand {
  return isObjectWithType(value, CMD_CANCEL);
}
export function isCmdResume(value: unknown): value is ResumeCommand {
  return isObjectWithType(value, CMD_RESUME);
}
export function isCmdReset(value: unknown): value is ResetCommand {
  return isObjectWithType(value, CMD_RESET);
}
export function isCmdRemoveQueueItem(value: unknown): value is RemoveQueueItemCommand {
  return isObjectWithType(value, CMD_REMOVE_QUEUE_ITEM);
}
export function isCmdOpenAuditLog(value: unknown): value is OpenAuditLogCommand {
  return isObjectWithType(value, CMD_OPEN_AUDIT_LOG);
}
export function isCmdRetryQueueItem(value: unknown): value is RetryQueueItemCommand {
  return isObjectWithType(value, CMD_RETRY_QUEUE_ITEM);
}
export function isCmdMoveQueueItemUp(value: unknown): value is MoveQueueItemUpCommand {
  return isObjectWithType(value, CMD_MOVE_QUEUE_ITEM_UP);
}
export function isCmdMoveQueueItemDown(value: unknown): value is MoveQueueItemDownCommand {
  return isObjectWithType(value, CMD_MOVE_QUEUE_ITEM_DOWN);
}
export function isCmdClearCompleted(value: unknown): value is ClearCompletedCommand {
  return isObjectWithType(value, CMD_CLEAR_COMPLETED);
}
export function isCmdClearFailed(value: unknown): value is ClearFailedCommand {
  return isObjectWithType(value, CMD_CLEAR_FAILED);
}
export function isCmdPauseQueue(value: unknown): value is PauseQueueCommand {
  return isObjectWithType(value, CMD_PAUSE_QUEUE);
}
export function isCmdResumeQueue(value: unknown): value is ResumeQueueCommand {
  return isObjectWithType(value, CMD_RESUME_QUEUE);
}
export function isCmdOpenDashboard(value: unknown): value is OpenDashboardCommand {
  return isObjectWithType(value, CMD_OPEN_DASHBOARD);
}
export function isCmdRetryActiveRun(value: unknown): value is RetryActiveRunCommand {
  return isObjectWithType(value, CMD_RETRY_ACTIVE_RUN);
}
export function isCmdRerunFromHistory(value: unknown): value is RerunFromHistoryCommand {
  return isObjectWithType(value, CMD_RERUN_FROM_HISTORY);
}
export function isCmdOpenQueueItemDetails(value: unknown): value is OpenQueueItemDetailsCommand {
  return isObjectWithType(value, CMD_OPEN_QUEUE_ITEM_DETAILS);
}
export function isCmdOpenHistoryItemDetails(value: unknown): value is OpenHistoryItemDetailsCommand {
  return isObjectWithType(value, CMD_OPEN_HISTORY_ITEM_DETAILS);
}
// Feature 011 catalog/settings/retry guards.
export function isCmdSavePipelines(value: unknown): value is SavePipelinesCommand {
  return isObjectWithType(value, CMD_SAVE_PIPELINES);
}
export function isCmdSavePhases(value: unknown): value is SavePhasesCommand {
  return isObjectWithType(value, CMD_SAVE_PHASES);
}
export function isCmdSaveWorkflows(value: unknown): value is SaveWorkflowsCommand {
  return isObjectWithType(value, CMD_SAVE_WORKFLOWS);
}
export function isCmdSaveModels(value: unknown): value is SaveModelsCommand {
  return isObjectWithType(value, CMD_SAVE_MODELS);
}
export function isCmdSaveGeneralSettings(value: unknown): value is SaveGeneralSettingsCommand {
  return isObjectWithType(value, CMD_SAVE_GENERAL_SETTINGS);
}
export function isCmdRetryPhaseNow(value: unknown): value is RetryPhaseNowCommand {
  return isObjectWithType(value, CMD_RETRY_PHASE_NOW);
}
// Feature 014 — Wake up save guard.
export function isCmdSaveWakeUpSettings(value: unknown): value is SaveWakeUpSettingsCommand {
  return isObjectWithType(value, CMD_SAVE_WAKEUP_SETTINGS);
}
export function isCmdWakeUpNow(value: unknown): value is WakeUpNowCommand {
  if (!isObjectWithType(value, CMD_WAKE_UP_NOW)) return false;
  const payload = (value as { payload?: unknown }).payload;
  return payload === undefined
    || (
      payload !== null
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && Object.keys(payload).length === 0
    );
}
export function isCmdPausePhase(value: unknown): value is PausePhaseCommand {
  return isObjectWithType(value, CMD_PAUSE_PHASE);
}
export function isCmdResumePhase(value: unknown): value is ResumePhaseCommand {
  return isObjectWithType(value, CMD_RESUME_PHASE);
}
export function isCmdRestartPhase(value: unknown): value is RestartPhaseCommand {
  return isObjectWithType(value, CMD_RESTART_PHASE);
}
export function isCmdSkipPhase(value: unknown): value is SkipPhaseCommand {
  return isObjectWithType(value, CMD_SKIP_PHASE);
}
export function isCmdDisablePhase(value: unknown): value is DisablePhaseCommand {
  return isObjectWithType(value, CMD_DISABLE_PHASE);
}
export function isCmdEnablePhase(value: unknown): value is EnablePhaseCommand {
  return isObjectWithType(value, CMD_ENABLE_PHASE);
}
export function isCmdRemoveTaskPhase(value: unknown): value is RemoveTaskPhaseCommand {
  return isObjectWithType(value, CMD_REMOVE_TASK_PHASE);
}
// Feature 030 — removed type guards for CMD_CREATE_QUEUE, CMD_RENAME_QUEUE,
// CMD_DELETE_QUEUE, CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE,
// CMD_MOVE_TASK, CMD_SAVE_QUEUE_SETTINGS (no multi-queue surface).
export function isCmdModifyTask(value: unknown): value is ModifyTaskCommand {
  return isObjectWithType(value, CMD_MODIFY_TASK);
}
export function isCmdReorderTask(value: unknown): value is ReorderTaskCommand {
  return isObjectWithType(value, CMD_REORDER_TASK);
}
export function isCmdRestartCanceledTask(value: unknown): value is RestartCanceledTaskCommand {
  return isObjectWithType(value, CMD_RESTART_CANCELED_TASK);
}
// Feature 020 — phase-log read + tail guards.
export function isCmdReadPhaseLog(value: unknown): value is ReadPhaseLogCommand {
  return isObjectWithType(value, CMD_READ_PHASE_LOG);
}
export function isCmdStartPhaseLogTail(value: unknown): value is StartPhaseLogTailCommand {
  return isObjectWithType(value, CMD_START_PHASE_LOG_TAIL);
}
export function isCmdStopPhaseLogTail(value: unknown): value is StopPhaseLogTailCommand {
  return isObjectWithType(value, CMD_STOP_PHASE_LOG_TAIL);
}
export function isCmdOpenVerboseSetting(value: unknown): value is OpenVerboseSettingCommand {
  return isObjectWithType(value, CMD_OPEN_VERBOSE_SETTING);
}
// Feature 028 — phase breakpoint set/clear guards.
export function isCmdSetPhaseBreakpoint(value: unknown): value is SetPhaseBreakpointCommand {
  return isObjectWithType(value, CMD_SET_PHASE_BREAKPOINT);
}
export function isCmdClearPhaseBreakpoint(value: unknown): value is ClearPhaseBreakpointCommand {
  return isObjectWithType(value, CMD_CLEAR_PHASE_BREAKPOINT);
}
// Feature 031 — wake-up session-log read + reveal guards (read-only).
export function isCmdReadWakeupSessionLog(value: unknown): value is ReadWakeupSessionLogCommand {
  return isObjectWithType(value, CMD_READ_WAKEUP_SESSION_LOG);
}
export function isCmdRevealWakeupSessionLog(value: unknown): value is RevealWakeupSessionLogCommand {
  return isObjectWithType(value, CMD_REVEAL_WAKEUP_SESSION_LOG);
}
// BUG-002 (FR-012a) — start-queue guard.
// Feature 065 — also accepts `payload.startIntent` (additive) per
// sidebar-ipc.diff.md. Empty-object payload remains valid for back-compat.
export function isCmdStartQueue(value: unknown): value is StartQueueCommand {
  if (!isObjectWithType(value, CMD_START_QUEUE)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === undefined) return true;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === 'startIntent') {
    const intent = (payload as { startIntent?: unknown }).startIntent;
    return intent === undefined || isValidStartQueueIntent(intent);
  }
  return false;
}
// Feature 063 — Clean All guard. Accepts `payload` absent or as an empty
// object; rejects arrays and non-empty payloads.
export function isCmdClearAll(value: unknown): value is ClearAllCommand {
  if (!isObjectWithType(value, CMD_CLEAR_ALL)) return false;
  const payload = (value as { payload?: unknown }).payload;
  return payload === undefined
    || (
      payload !== null
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && Object.keys(payload).length === 0
    );
}
// Feature 063 — confirmation-suppression guard. Validates the discriminator
// and the payload shape `{ actionKey: string; suppressed: boolean }`.
// Action-key membership is enforced by the suppression handler against
// the closed ActionKey union — keeping the per-string check out of the
// IPC contract layer.
export function isCmdSetConfirmSuppression(
  value: unknown
): value is SetConfirmSuppressionCommand {
  if (!isObjectWithType(value, CMD_SET_CONFIRM_SUPPRESSION)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const { actionKey, suppressed } = payload as {
    actionKey?: unknown;
    suppressed?: unknown;
  };
  return typeof actionKey === 'string'
    && actionKey.length > 0
    && typeof suppressed === 'boolean';
}

// Feature 065 (T054a / FR-020) — dismiss-migration-notice guard. Discriminator-only
// (no payload).
export function isCmdDismissMigrationNotice(
  value: unknown
): value is DismissMigrationNoticeCommand {
  return isObjectWithType(value, CMD_DISMISS_MIGRATION_NOTICE);
}

// Feature 073 — read-only metrics scan guard. Payload is required (an empty
// object `{}` satisfies it — see ReadMetricsCommand's field comment) to
// match validateReadMetrics's actual runtime gate; `includeArchives` must be
// a boolean if provided.
export function isCmdReadMetrics(value: unknown): value is ReadMetricsCommand {
  if (!isObjectWithType(value, CMD_READ_METRICS)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const { includeArchives } = payload as { includeArchives?: unknown };
  return includeArchives === undefined || typeof includeArchives === 'boolean';
}

export function isCmdPingBackend(value: unknown): value is PingBackendCommand {
  if (!isObjectWithType(value, CMD_PING_BACKEND)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).length !== 1) return false;
  const runner = (payload as { runner?: unknown }).runner;
  return runner === 'claude' || runner === 'codex' || runner === 'agy';
}

// Exhaustive guard registry. The drift test asserts the keys of this
// record equal `COMMAND_TYPES`; missing entries fail the test.
export const COMMAND_GUARDS: Readonly<
  Record<CommandType, (value: unknown) => boolean>
> = Object.freeze({
  [CMD_START]: isCmdStart,
  [CMD_CANCEL]: isCmdCancel,
  [CMD_RESUME]: isCmdResume,
  [CMD_RESET]: isCmdReset,
  [CMD_REMOVE_QUEUE_ITEM]: isCmdRemoveQueueItem,
  [CMD_OPEN_AUDIT_LOG]: isCmdOpenAuditLog,
  [CMD_RETRY_QUEUE_ITEM]: isCmdRetryQueueItem,
  [CMD_MOVE_QUEUE_ITEM_UP]: isCmdMoveQueueItemUp,
  [CMD_MOVE_QUEUE_ITEM_DOWN]: isCmdMoveQueueItemDown,
  [CMD_CLEAR_COMPLETED]: isCmdClearCompleted,
  [CMD_CLEAR_FAILED]: isCmdClearFailed,
  [CMD_PAUSE_QUEUE]: isCmdPauseQueue,
  [CMD_RESUME_QUEUE]: isCmdResumeQueue,
  [CMD_OPEN_DASHBOARD]: isCmdOpenDashboard,
  [CMD_RETRY_ACTIVE_RUN]: isCmdRetryActiveRun,
  [CMD_RERUN_FROM_HISTORY]: isCmdRerunFromHistory,
  [CMD_OPEN_QUEUE_ITEM_DETAILS]: isCmdOpenQueueItemDetails,
  [CMD_OPEN_HISTORY_ITEM_DETAILS]: isCmdOpenHistoryItemDetails,
  [CMD_SAVE_PIPELINES]: isCmdSavePipelines,
  [CMD_SAVE_PHASES]: isCmdSavePhases,
  [CMD_SAVE_WORKFLOWS]: isCmdSaveWorkflows,
  [CMD_SAVE_MODELS]: isCmdSaveModels,
  [CMD_SAVE_GENERAL_SETTINGS]: isCmdSaveGeneralSettings,
  [CMD_RETRY_PHASE_NOW]: isCmdRetryPhaseNow,
  [CMD_SAVE_WAKEUP_SETTINGS]: isCmdSaveWakeUpSettings,
  [CMD_WAKE_UP_NOW]: isCmdWakeUpNow,
  [CMD_PAUSE_PHASE]: isCmdPausePhase,
  [CMD_RESUME_PHASE]: isCmdResumePhase,
  [CMD_RESTART_PHASE]: isCmdRestartPhase,
  [CMD_SKIP_PHASE]: isCmdSkipPhase,
  [CMD_DISABLE_PHASE]: isCmdDisablePhase,
  [CMD_ENABLE_PHASE]: isCmdEnablePhase,
  [CMD_REMOVE_TASK_PHASE]: isCmdRemoveTaskPhase,
  // Feature 030 — removed CMD_CREATE_QUEUE, CMD_RENAME_QUEUE,
  // CMD_DELETE_QUEUE, CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE,
  // CMD_MOVE_TASK, CMD_SAVE_QUEUE_SETTINGS (single-queue mode).
  [CMD_MODIFY_TASK]: isCmdModifyTask,
  [CMD_REORDER_TASK]: isCmdReorderTask,
  [CMD_RESTART_CANCELED_TASK]: isCmdRestartCanceledTask,
  [CMD_READ_PHASE_LOG]: isCmdReadPhaseLog,
  [CMD_START_PHASE_LOG_TAIL]: isCmdStartPhaseLogTail,
  [CMD_STOP_PHASE_LOG_TAIL]: isCmdStopPhaseLogTail,
  [CMD_OPEN_VERBOSE_SETTING]: isCmdOpenVerboseSetting,
  [CMD_SET_PHASE_BREAKPOINT]: isCmdSetPhaseBreakpoint,
  [CMD_CLEAR_PHASE_BREAKPOINT]: isCmdClearPhaseBreakpoint,
  [CMD_READ_WAKEUP_SESSION_LOG]: isCmdReadWakeupSessionLog,
  [CMD_REVEAL_WAKEUP_SESSION_LOG]: isCmdRevealWakeupSessionLog,
  [CMD_START_QUEUE]: isCmdStartQueue,
  [CMD_CLEAR_ALL]: isCmdClearAll,
  [CMD_SET_CONFIRM_SUPPRESSION]: isCmdSetConfirmSuppression,
  [CMD_DISMISS_MIGRATION_NOTICE]: isCmdDismissMigrationNotice,
  [CMD_READ_METRICS]: isCmdReadMetrics,
  [CMD_PING_BACKEND]: isCmdPingBackend
});
