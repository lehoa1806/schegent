// Authoritative IPC contract module for the sidebar webview boundary.
//
// Single source of truth — host (`src/ui/sidebar/messages.ts`) and webview
// (`webview-ui/src/lib/messages.ts`) both re-export this module via a
// single `export *` statement. Adding a new command MUST happen here
// first; the two shims are mechanical re-exports.
//
// The drift test at `tests/unit/contracts/sidebar-ipc-drift.test.ts`
// guards module identity (host and webview literals must `===` resolve
// to this module) and the single-export-* shape of both shims.

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
  CMD_REVEAL_WAKEUP_SESSION_LOG
] as const;

export const HOST_MESSAGE_TYPES = [STATE_SNAPSHOT, CMD_ACK, MSG_PHASE_LOG_ENTRY] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number];

// -- Command payload interfaces ---------------------------------------------

export interface CommandBase<T extends CommandType> {
  readonly type: T;
  readonly correlationId: string;
}

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
export interface ResumeCommand extends CommandBase<typeof CMD_RESUME> {}

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

export interface PauseQueueCommand extends CommandBase<typeof CMD_PAUSE_QUEUE> {
  readonly payload?: { readonly queueId?: string; readonly reason?: string };
}

export interface ResumeQueueCommand extends CommandBase<typeof CMD_RESUME_QUEUE> {
  readonly payload?: { readonly queueId?: string };
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

// Feature 011 — pipelines/phases/models catalog save. The payload arrays
// are typed as `readonly unknown[]` at the contract boundary because the
// canonical narrow types live in two different module trees that cannot
// import each other directly (host: `src/config/pipeline-config.ts`;
// webview: `webview-ui/src/lib/snapshot-types.ts`). Narrow validation
// happens in `ipc-validator.ts` before the payload reaches any
// pipeline-shaped consumer.
export interface SavePipelinesCommand extends CommandBase<typeof CMD_SAVE_PIPELINES> {
  readonly payload: { readonly pipelines: readonly unknown[] };
}

export interface SavePhasesCommand extends CommandBase<typeof CMD_SAVE_PHASES> {
  readonly payload: { readonly phases: readonly unknown[] };
}

export interface SaveModelsCommand extends CommandBase<typeof CMD_SAVE_MODELS> {
  readonly payload: { readonly models: readonly string[] };
}

// Feature 011 — keys in `updates` are unprefixed scalar setting names;
// the host prepends `schegent.` and validates against an allowlist
// before applying any update transactionally. See
// specs/011-webui-config-editor/contracts/general-settings-ipc.md.
//
// Supported keys (host-side allowlist lives in
// src/config/general-settings.ts `KEY_SPECS` — webview must mirror but
// is NOT the source of truth):
//   - cli.path, logging.verbose, loop.maxIterations,
//     invocation.timeoutSeconds, watchdog.pollIntervalMinutes,
//     audit.rotation.sizeMB, audit.rotation.maxAgeDays,
//     rules.injectPerPhase, defaultPipelineId, fatalSignatures.
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
export interface ResumePhaseCommand extends CommandBase<typeof CMD_RESUME_PHASE> {}

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

// Feature 020 — phase log read + tail. The selection tuple is host-
// validated against the current snapshot before any path is composed;
// operator-supplied path components are NEVER consumed (paths come from
// snapshot, not from IPC request fields). See
// specs/020-phase-level-logs/contracts/phase-log-ipc.md.
export interface ReadPhaseLogRequest {
  readonly selection: {
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number | null;
  };
}

export interface ReadPhaseLogCommand extends CommandBase<typeof CMD_READ_PHASE_LOG> {
  readonly payload: ReadPhaseLogRequest;
}

// Feature 020 — wire-format response payload for CMD_READ_PHASE_LOG.
// Carried inside the `CommandAckMessage.result` field. The host
// guarantees: (a) every `body.*` string has passed through
// `SanitizedLogger.sanitize()` exactly once; (b) no `body.*` string
// exceeds 4096 UTF-8 bytes; (c) no field carries an absolute path.
//
// The `kind` union mirrors `PhaseLogDisplayEntryKind` from
// `src/services/phase-log/types.ts`. `'tail-ended'` is emitted ONLY by
// the tail push channel (`MSG_PHASE_LOG_ENTRY`) at runtime — read
// responses never carry it — but the wire type stays aligned with the
// runtime type to eliminate contract-vs-runtime drift.
export type ReadPhaseLogResponse =
  | {
      readonly outcome: 'success';
      readonly manifest: {
        readonly iterations: readonly number[];
        readonly selectedIteration: number | null;
        readonly entries: readonly {
          readonly seq: number;
          readonly kind:
            | 'assistant-text'
            | 'tool-use'
            | 'tool-result'
            | 'system'
            | 'result'
            | 'truncated-head'
            | 'tail-ended';
          readonly ts: string | null;
          readonly body: Readonly<Record<string, unknown>>;
          readonly bodyTruncated: Readonly<
            Record<string, { readonly originalLength: number }>
          > | null;
        }[];
        readonly skippedLines: number;
        readonly truncatedCount: number;
        readonly verboseDiagnosticsState:
          | { readonly kind: 'enabled-with-sessions' }
          | { readonly kind: 'enabled-no-sessions-for-tuple' }
          | { readonly kind: 'disabled-no-sessions'; readonly settingKey: string };
        readonly isInFlight: boolean;
      };
    }
  | {
      readonly outcome: 'failure';
      readonly reason: 'unknown-tuple' | 'permission-denied' | 'internal-error';
    };

export interface StartPhaseLogTailRequest {
  readonly selection: {
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number;
  };
}

export interface StartPhaseLogTailCommand
  extends CommandBase<typeof CMD_START_PHASE_LOG_TAIL> {
  readonly payload: StartPhaseLogTailRequest;
}

export type StartPhaseLogTailResponse =
  | {
      readonly outcome: 'success';
      readonly sessionId: string;
      readonly mechanism: 'fs.watch' | 'polling';
    }
  | {
      readonly outcome: 'failure';
      readonly reason:
        | 'unknown-tuple'
        | 'not-in-flight'
        | 'permission-denied'
        | 'internal-error';
    };

export interface StopPhaseLogTailRequest {
  readonly sessionId: string;
}

export interface StopPhaseLogTailCommand
  extends CommandBase<typeof CMD_STOP_PHASE_LOG_TAIL> {
  readonly payload: StopPhaseLogTailRequest;
}

export interface StopPhaseLogTailResponse {
  readonly outcome: 'success' | 'failure';
  readonly sessionId: string;
  readonly reason?: 'unknown-session' | 'internal-error';
}

export interface OpenVerboseSettingCommand
  extends CommandBase<typeof CMD_OPEN_VERBOSE_SETTING> {}

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

// Feature 031 — read-only IPC to fetch the sanitized session-log
// projection for one wake-up invocation. The host validates
// `correlationId` shape and re-validates it against the JSONL
// invocation log BEFORE composing any filesystem path. The session-log
// path is host-owned (composed from `globalStorageUri`) — operators
// never supply a path. See
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-session-log-ipc.md.
export interface ReadWakeupSessionLogCommand
  extends CommandBase<typeof CMD_READ_WAKEUP_SESSION_LOG> {
  readonly payload: { readonly correlationId: string };
}

// Feature 031 — wire-format response payload for
// CMD_READ_WAKEUP_SESSION_LOG. Carried inside the
// `CommandAckMessage.result` field. The host guarantees:
//   (a) `body` has passed through `SanitizedLogger.sanitize()` exactly
//       once at the IPC boundary;
//   (b) `body` does NOT exceed SESSION_PROJECTION_MAX_BYTES = 32 KiB;
//   (c) `bodyTruncated === true` iff the on-disk block body exceeded
//       the projection cap; the operator can inspect the full body via
//       the on-disk `session.log` file (path projected separately on
//       the snapshot's `wakeUp.sessionLogPath` field);
//   (d) `outcome` collapses the runner's `status` → 'succeeded' |
//       'failed' (skipped / timed-out records do not write a session
//       block and therefore cannot reach this response).
//
// The rejection vocabulary is closed; new reasons require a code
// change + PR review (mirrors `ReadPhaseLogResponse`).
export interface ReadWakeupSessionLogResponseSuccess {
  readonly status: 'success';
  readonly correlationId: string;
  readonly capturedAtMs: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly model: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly fullBlockBytesOnDisk: number;
}

export interface ReadWakeupSessionLogResponseRejected {
  readonly status: 'rejected';
  readonly reason:
    | 'not-primary-host'
    | 'invalid-correlation-id'
    | 'unknown-correlation-id'
    | 'session-log-unavailable'
    | 'unknown-error';
}

export type ReadWakeupSessionLogResponse =
  | ReadWakeupSessionLogResponseSuccess
  | ReadWakeupSessionLogResponseRejected;

// Feature 031 — read-only IPC to reveal the on-disk session.log file
// in the OS file manager. Carries no operator-supplied path; the host
// composes the path internally. See
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-reveal-session-log-ipc.md.
export interface RevealWakeupSessionLogCommand
  extends CommandBase<typeof CMD_REVEAL_WAKEUP_SESSION_LOG> {
  readonly payload?: Record<string, never>;
}

export interface RevealWakeupSessionLogResponseSuccess {
  readonly status: 'success';
}

export interface RevealWakeupSessionLogResponseRejected {
  readonly status: 'rejected';
  readonly reason:
    | 'not-primary-host'
    | 'session-log-unavailable'
    | 'reveal-failed'
    | 'unknown-error';
}

export type RevealWakeupSessionLogResponse =
  | RevealWakeupSessionLogResponseSuccess
  | RevealWakeupSessionLogResponseRejected;

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
  | RevealWakeupSessionLogCommand;

// -- Host messages (host → webview) -----------------------------------------

export interface StateSnapshotMessage<S> {
  readonly type: typeof STATE_SNAPSHOT;
  readonly payload: S;
}

export interface CommandAckMessage {
  readonly type: typeof CMD_ACK;
  readonly correlationId: string;
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
  // Feature 020 — optional typed payload for commands that need to
  // return a result alongside the ack (currently
  // `CMD_READ_PHASE_LOG` → `ReadPhaseLogResponse`,
  // `CMD_START_PHASE_LOG_TAIL` → `StartPhaseLogTailResponse`,
  // `CMD_STOP_PHASE_LOG_TAIL` → `StopPhaseLogTailResponse`). All
  // other commands MUST leave this field absent. Mutating commands
  // continue to communicate via `status` + `reason` only — the
  // result channel is reserved for read-only queries.
  readonly result?: unknown;
}

// Feature 020 — phase log push. The body field has been sanitized by
// `SanitizedLogger.sanitize` and truncated to ≤ 4 KiB per field at the
// IPC boundary. The webview drops messages whose `tailSessionId` does
// not match the currently active session (defense against late
// delivery after navigate-away).
export interface PhaseLogEntryPushMessage {
  readonly type: typeof MSG_PHASE_LOG_ENTRY;
  readonly payload: {
    readonly tailSessionId: string;
    readonly entrySeq: number;
    readonly entry: {
      readonly seq: number;
      readonly kind:
        | 'assistant-text'
        | 'tool-use'
        | 'tool-result'
        | 'system'
        | 'result'
        | 'truncated-head'
        | 'tail-ended';
      readonly ts: string | null;
      readonly body: Readonly<Record<string, unknown>>;
      readonly bodyTruncated: Readonly<Record<string, { readonly originalLength: number }>> | null;
    };
  };
}

export type HostMessage<S> = StateSnapshotMessage<S> | CommandAckMessage | PhaseLogEntryPushMessage;

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
  return isObjectWithType(value, CMD_START);
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
  [CMD_REVEAL_WAKEUP_SESSION_LOG]: isCmdRevealWakeupSessionLog
});
