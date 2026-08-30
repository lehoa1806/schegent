// Authoritative sidebar IPC contract; host and webview shims re-export it.
/**
 * FR-R3-110 (FR-103) — renamed from `SCHEMA_VERSION`.
 *
 * THE COLLISION. Two constants named `SCHEMA_VERSION` sat on the same host -> webview path with
 * DIFFERENT values: this one (3, the IPC envelope) and `src/ui/sidebar/snapshot.ts`'s (4, the
 * snapshot body). An unqualified `import { SCHEMA_VERSION }` picked a number by module path, and
 * both numbers are plausible in both places — so a wrong import would not look wrong, it would
 * just version the wrong thing.
 *
 * There was a third, and it is why renaming one was not enough on its own to make the class
 * safe: `src/state/workspace-state.ts` exports `SCHEMA_VERSION = '1.0.0'`, a STRING. Three
 * constants, one name, two types.
 *
 * Renaming this one rather than the snapshot's: it has the fewest importers, and
 * `SIDEBAR_IPC_SCHEMA_VERSION` says what it versions where the bare name did not. The value is
 * unchanged — this is a naming fix so the compiler can find every site, not a version bump.
 */
export const SIDEBAR_IPC_SCHEMA_VERSION = 3 as const;
// -- Command literals (webview → host) ---------------------------------------

export const CMD_START = 'CMD_START' as const;
export const CMD_CANCEL = 'CMD_CANCEL' as const;
export const CMD_REMOVE_QUEUE_ITEM = 'CMD_REMOVE_QUEUE_ITEM' as const;
export const CMD_OPEN_AUDIT_LOG = 'CMD_OPEN_AUDIT_LOG' as const;
export const CMD_RETRY_QUEUE_ITEM = 'CMD_RETRY_QUEUE_ITEM' as const;
export const CMD_MOVE_QUEUE_ITEM_UP = 'CMD_MOVE_QUEUE_ITEM_UP' as const;
export const CMD_MOVE_QUEUE_ITEM_DOWN = 'CMD_MOVE_QUEUE_ITEM_DOWN' as const;
export const CMD_CLEAR_COMPLETED = 'CMD_CLEAR_COMPLETED' as const;
export const CMD_PAUSE_QUEUE = 'CMD_PAUSE_QUEUE' as const;
export const CMD_RESUME_QUEUE = 'CMD_RESUME_QUEUE' as const;
export const CMD_OPEN_DASHBOARD = 'CMD_OPEN_DASHBOARD' as const;
export const CMD_RERUN_FROM_HISTORY = 'CMD_RERUN_FROM_HISTORY' as const;
export const CMD_OPEN_HISTORY_ITEM_DETAILS = 'CMD_OPEN_HISTORY_ITEM_DETAILS' as const;
// Feature 011 — the Model Catalog save, the last catalog written through
// configuration. Feature 100 (T509) retired its three siblings — `SAVE_PIPELINES`,
// `SAVE_PHASES`, `SAVE_WORKFLOWS` — with the whole-array layer envelope they
// carried; the six commands below replace them.
export const CMD_SAVE_MODELS = 'CMD_SAVE_MODELS' as const;
// Feature 100 (FR-R3-016) — the per-definition lifecycle. These are what the
// three layer saves above become: one definition, one declared operation. All
// six are mutating and all six are registered in `MUTATING_COMMAND_REASONS`.
// Only the first name carries a verb the naming-convention lint recognises, so
// the other five entries there are deliberate rather than incidental.
export const CMD_SAVE_DEFINITION_DRAFT = 'CMD_SAVE_DEFINITION_DRAFT' as const;
export const CMD_PUBLISH_DEFINITION = 'CMD_PUBLISH_DEFINITION' as const;
export const CMD_DEACTIVATE_DEFINITION = 'CMD_DEACTIVATE_DEFINITION' as const;
export const CMD_RESTORE_DEFINITION_VERSION = 'CMD_RESTORE_DEFINITION_VERSION' as const;
export const CMD_DISCARD_DEFINITION_DRAFT = 'CMD_DISCARD_DEFINITION_DRAFT' as const;
export const CMD_PUBLISH_PACKAGE = 'CMD_PUBLISH_PACKAGE' as const;
export const CMD_READ_DEFINITION_VERSION = 'CMD_READ_DEFINITION_VERSION' as const;
// Feature 011 — scalar settings save + manual delayed-retry trigger.
export const CMD_SAVE_GENERAL_SETTINGS = 'CMD_SAVE_GENERAL_SETTINGS' as const;
export const CMD_RETRY_PHASE_NOW = 'CMD_RETRY_PHASE_NOW' as const;
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
// Feature 092 (US1, FR-019/FR-020) — the seven multi-queue mutation commands
// feature 030 removed for the single-queue collapse. `CMD_REORDER_TASK` still
// drives both the drag-and-drop drop event and the up/down arrow buttons
// *within* a queue; `CMD_MOVE_TASK` is the across-queues move.
export const CMD_CREATE_QUEUE = 'CMD_CREATE_QUEUE' as const;
export const CMD_RENAME_QUEUE = 'CMD_RENAME_QUEUE' as const;
export const CMD_DELETE_QUEUE = 'CMD_DELETE_QUEUE' as const;
export const CMD_SAVE_QUEUE_SETTINGS = 'CMD_SAVE_QUEUE_SETTINGS' as const;
export const CMD_MOVE_TASK = 'CMD_MOVE_TASK' as const;
export const CMD_MODIFY_TASK = 'CMD_MODIFY_TASK' as const;
export const CMD_REORDER_TASK = 'CMD_REORDER_TASK' as const;
// Feature 017 — BUG-001. Transition a `canceled` `FeatureRequest` back
// to `pending` by id; the host command behind it then asks the queue to
// drain, which is what starts the Task. (This used to say "so the queue
// dequeue pump picks it up again on the next tick". There is no dequeue
// pump — `AutoDrainCoordinator` is edge-triggered — and this was the
// third and last site repeating that claim.) Distinct from
// `CMD_RETRY_QUEUE_ITEM` (which already generalizes to `canceled` via
// FR-034) so the dashboard "Restart" affordance for canceled rows has a
// single, taxonomy-correct command.
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
// FR-R3-010 — resolve a completed Run's `auditLogPointer` to its audit records.
// READ-ONLY, so out of `MUTATING_COMMANDS`; `cmd-resolve-audit-pointer.ts` says why.
export const CMD_RESOLVE_AUDIT_POINTER = 'CMD_RESOLVE_AUDIT_POINTER' as const;
// FR-R3-071 — resolve a completed Run's stored description for replay.
// READ-ONLY, so out of `MUTATING_COMMANDS`; `cmd-resolve-history-description.ts` says why.
export const CMD_RESOLVE_HISTORY_DESCRIPTION = 'CMD_RESOLVE_HISTORY_DESCRIPTION' as const;
// Feature 028 — future-phase breakpoints. Operator marks a pending phase
// as a "pause when reached" point. The pipeline runs preceding phases
// then halts before invoking the marked phase. Both are mutating —
// members of `MUTATING_COMMANDS` (primary-host-only gate).
// See specs/028-advanced-phase-pausing/contracts/ipc.md.
export const CMD_SET_PHASE_BREAKPOINT = 'CMD_SET_PHASE_BREAKPOINT' as const;
export const CMD_CLEAR_PHASE_BREAKPOINT = 'CMD_CLEAR_PHASE_BREAKPOINT' as const;
// BUG-002 (FR-012a) — queue-start trigger. Mutating: promotes the oldest
// pending task to in-flight via `controller.drainQueuedWork()`. Member of
// `MUTATING_COMMANDS` and gated by the primary-host check.
export const CMD_START_QUEUE = 'CMD_START_QUEUE' as const;
// Feature 063 — Clean All atomic queue reset. Subsumes the separate
// CMD_CLEAR_COMPLETED and CMD_CLEAR_FAILED commands; the lifecycle
// round-check of 2026-08-30 (finding D) deleted the latter, which had
// carried a handler, a guard and a validator arm for a route no webview
// surface took after FR-R3-140 removed ControlPanel.svelte. Mutating: drops
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
// Feature 084 — read-only Phase export. NOT a member of
// `MUTATING_COMMAND_REASONS`: it writes a file the operator named in a host
// dialog and changes no extension state. Import commits through
// `CMD_PUBLISH_PACKAGE`, so the exchange feature adds no mutating command.
export const CMD_EXPORT_PROCESS_YAML = 'CMD_EXPORT_PROCESS_YAML' as const;
// Feature 084 — read-only import preflight. Also NOT mutating: it reads the
// operator's chosen document once and returns a plan. Nothing is written until
// the operator confirms, and that confirmation is a `CMD_PUBLISH_PACKAGE`.
export const CMD_PREFLIGHT_PROCESS_YAML = 'CMD_PREFLIGHT_PROCESS_YAML' as const;
// Feature 087 — compose, validate, freeze, enqueue. Mutating, unlike the two
// exchange commands above; see `MUTATING_COMMAND_REASONS`.
export const CMD_LAUNCH_PIPELINE = 'CMD_LAUNCH_PIPELINE' as const;
// Feature 088 — connected Workflow runs. Both mutating: the first creates the
// aggregate and enqueues its first child, the second appends an attempt and
// increments the revision. Neither name carries a mutating verb prefix, so the
// naming-convention lint would not have caught an omission from
// `MUTATING_COMMAND_REASONS` — both entries are deliberate.
export const CMD_LAUNCH_WORKFLOW = 'CMD_LAUNCH_WORKFLOW' as const;
export const CMD_CONTINUE_WORKFLOW = 'CMD_CONTINUE_WORKFLOW' as const;

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
  CMD_REMOVE_QUEUE_ITEM,
  CMD_OPEN_AUDIT_LOG,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_OPEN_DASHBOARD,
  CMD_RERUN_FROM_HISTORY,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_SAVE_MODELS,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_DEACTIVATE_DEFINITION,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_PACKAGE,
  CMD_READ_DEFINITION_VERSION,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_RETRY_PHASE_NOW,
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  CMD_CREATE_QUEUE,
  CMD_RENAME_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_MOVE_TASK,
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_RESOLVE_AUDIT_POINTER,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_START_QUEUE,
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_READ_METRICS,
  CMD_PING_BACKEND,
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_CONTINUE_WORKFLOW
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
import type { ReadMetricsCommand } from './sidebar-ipc/metrics';
import { isReadMetricsRequest } from './sidebar-ipc/metrics';
import type { ResolveAuditPointerCommand } from './sidebar-ipc/history-evidence';
import type { ResolveHistoryDescriptionCommand } from './sidebar-ipc/history-description';
export type {
  ResolveHistoryDescriptionRequest,
  ResolveHistoryDescriptionCommand,
  ResolveHistoryDescriptionResponse
} from './sidebar-ipc/history-description';
export type { HistoryEvidenceEntry, ResolveAuditPointerRequest, ResolveAuditPointerCommand,
  ResolveAuditPointerResponse } from './sidebar-ipc/history-evidence';
import type {
  ExportProcessYamlCommand,
  PreflightProcessYamlCommand
} from './sidebar-ipc/process-yaml';
import { admitsExportInclusion } from './sidebar-ipc/process-yaml';
import { isLaunchPipelinePayload, type LaunchPipelineCommand } from './sidebar-ipc/run-launcher';
export type {
  LaunchPipelineRequest, LaunchPipelineCommand, LaunchPipelineResult,
  LaunchPipelineOutcome, LaunchPipelineRejectionReason } from './sidebar-ipc/run-launcher';
import {
  isContinueWorkflowPayload, isLaunchWorkflowPayload,
  type ContinueWorkflowCommand, type LaunchWorkflowCommand } from './sidebar-ipc/workflow-run';
export type {
  ConnectedNodeAction, ConnectedNodeProjection, ConnectedNodeState,
  ConnectedRunProjection, ConnectedRunStateRefusal, ContinueWorkflowCommand,
  ContinueWorkflowOutcome, ContinueWorkflowPayload, ContinueWorkflowResult,
  LaunchWorkflowCommand, LaunchWorkflowOutcome, LaunchWorkflowPayload,
  LaunchWorkflowResult, WorkflowDefinitionRefusal } from './sidebar-ipc/workflow-run';
// Feature 092 (US1, FR-019/FR-020) — the seven reinstated queue commands. Their
// wire shapes live in sidebar-ipc/queue.ts, as every family since 084 does; what
// stays here is the registration the drift test requires be exhaustive — the
// literal, the SIDEBAR_COMMAND_TYPES entry, this re-export, the SidebarCommand
// member, and the COMMAND_GUARDS entry.
import type {
  CreateQueueCommand, DeleteQueueCommand, MoveTaskCommand,
  RenameQueueCommand, SaveQueueSettingsCommand } from './sidebar-ipc/queue';
export type {
  CreateQueueCommand, DeleteQueueCommand, MoveTaskCommand,
  RenameQueueCommand, SaveQueueSettingsCommand } from './sidebar-ipc/queue';

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
  PhaseRecord,
  TaskRecord,
  PhaseTypeAggregate,
  CostTimelinePoint,
  CumulativeTotals,
  MetricsCoverage,
  MetricsRunSummary,
  ReadMetricsRequest,
  ReadMetricsCommand,
  ReadMetricsResponse
} from './sidebar-ipc/metrics';
export { READ_METRICS_RUN_IDS_MAX, isReadMetricsRunIdList } from './sidebar-ipc/metrics';
export type {
  ProcessYamlResourceKind,
  PipelineExportInclusion,
  WorkflowExportInclusion,
  ExportProcessYamlRequest,
  ExportProcessYamlCommand,
  ExportProcessYamlResult,
  ExportProcessYamlUnavailable,
  ExportProcessYamlUnavailableReason,
  PreflightProcessYamlRequest,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  BlockedDependency,
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  ProcessYamlCatalogRevision
} from './sidebar-ipc/process-yaml';
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

export interface RerunFromHistoryCommand extends CommandBase<typeof CMD_RERUN_FROM_HISTORY> {
  // Feature 013 — Wave 6 (US6, FR-031): `force` is the operator opt-in for
  // legacy entries (recorded before `originalDescription` was persisted).
  // When `force === true`, the rerun proceeds with the truncated preview;
  // otherwise the command rejects with a sanitized warning.
  readonly payload: { readonly runId: string; readonly force?: boolean };
}

export interface OpenHistoryItemDetailsCommand extends CommandBase<typeof CMD_OPEN_HISTORY_ITEM_DETAILS> {
  readonly payload: { readonly id: string };
}

// Feature 100 — the per-definition lifecycle shapes and their payload
// predicates. Same split as the launcher commands: the payload checks live in
// the sub-module and need nothing from here; only the discriminator does.
import {
  isDefinitionOperationPayload,
  isPublishPackagePayload,
  isRestoreDefinitionVersionPayload,
  isSaveDefinitionDraftPayload,
  type DeactivateDefinitionCommand,
  type DiscardDefinitionDraftCommand,
  type PublishDefinitionCommand,
  type PublishPackageCommand,
  type RestoreDefinitionVersionCommand,
  type SaveDefinitionDraftCommand
} from './sidebar-ipc/catalog-lifecycle';
export type {
  DeactivateDefinitionCommand,
  DiscardDefinitionDraftCommand,
  PublishDefinitionCommand,
  PublishPackageCommand,
  RestoreDefinitionVersionCommand,
  SaveDefinitionDraftCommand
} from './sidebar-ipc/catalog-lifecycle';
import { isCmdReadDefinitionVersion, type ReadDefinitionVersionCommand } from './sidebar-ipc/catalog-history';
export * from './sidebar-ipc/catalog-history';

export interface SaveModelsCommand extends CommandBase<typeof CMD_SAVE_MODELS> {
  readonly payload: {
    readonly models: Record<string, readonly string[]>;
    /**
     * Feature 096 — present only on the import-confirm call site
     * (`mutation` always accompanies it there); the manual add/remove call
     * site omits both and keeps its unconditional-write behavior unchanged.
     */
    readonly expectedRevision?: string;
    readonly mutation?: { readonly kind: 'manual-edit' | 'import-package' };
  };
}

// Feature 011 — keys in `updates` are unprefixed scalar setting names;
// the host prepends `schegent.` and validates the full batch against an
// allowlist before writing any key. If a later workspace write fails, the
// host compensates by restoring any keys already written by that batch. See
// specs/011-webui-config-editor/contracts/general-settings-ipc.md.
//
// Supported keys: the `AllowedKey` union in src/config/general-settings.ts, which
// `KEY_SPECS` is keyed by. The webview mirrors that list and is NOT the source of
// truth; a key absent from it is refused as `unknown-key:<key>`.
//
// FR-R3-145 (T1569) deleted the copy of the list that stood here rather than
// correcting it. Measured against `AllowedKey` at that point, the copy named 17 of
// 22 keys, listed one that no longer existed (`queue.globalConcurrencyCap`, removed
// by T1572), and omitted six that did — `codex.path`, `agy.path`,
// `retry.forceContinueOnCap`, `logging.sessionRetentionMaxAgeDays`,
// `logging.sessionRetentionMaxBytes`, `logging.rawTranscriptMode`. Restating a
// union in a comment beside it buys nothing and drifts silently: the reader who
// trusted this list would have sent a key the host refuses, and missed six it takes.
export interface SaveGeneralSettingsCommand
  extends CommandBase<typeof CMD_SAVE_GENERAL_SETTINGS> {
  readonly payload: {
    readonly updates: Readonly<Record<string, unknown>>;
  };
}

// The live-queue controls — the phase controls, the two breakpoint commands,
// and the task edits — moved to a focused module in feature 100 (FR-R3-016).
// The ratchet in tests/lint/source-loc-budget.test.ts is what asked: this
// barrel keeps literals, guards, and registrations, and domain wire shapes go
// to sub-modules. The guards below stay because they need the literals as
// runtime values, which is the import cycle the split exists to avoid.
import type {
  ClearPhaseBreakpointCommand,
  DisablePhaseCommand,
  EnablePhaseCommand,
  ModifyTaskCommand,
  PausePhaseCommand,
  RemoveTaskPhaseCommand,
  ReorderTaskCommand,
  RestartCanceledTaskCommand,
  RestartPhaseCommand,
  ResumePhaseCommand,
  RetryPhaseNowCommand,
  RunControlCommand,
  SetPhaseBreakpointCommand,
  SkipPhaseCommand
} from './sidebar-ipc/run-controls';
export type * from './sidebar-ipc/run-controls';

export interface OpenVerboseSettingCommand
  extends CommandBase<typeof CMD_OPEN_VERBOSE_SETTING> {}

export interface PingBackendCommand extends CommandBase<typeof CMD_PING_BACKEND> {
  readonly payload: { readonly runner: 'claude' | 'codex' | 'agy' }; }

// BUG-002 (FR-012a) — start-queue command. No payload; the host promotes
// the oldest pending task to in-flight. Rejected when no pending tasks
// exist, when the queue is paused, or when a run is already in-flight.
//
// Feature 065 — optional `startIntent` payload (additive). Carries
// `startMode` for now/scheduled/cancel-schedule and the `'operator-restart'`
// source literal. Omission preserves the legacy "no-op promote" semantics.
//
// Feature 092 (T061, FR-034) — optional `queueId` (additive). It names which
// queue the start addresses; omission means the default queue, which is what
// every pre-092 sender meant when there was only one. Sending it is how the
// webview addresses a specific queue now that several may exist.
export interface StartQueueCommand extends CommandBase<typeof CMD_START_QUEUE> {
  readonly payload?: {
    readonly queueId?: string;
    readonly startIntent?: StartQueueIntent;
  } | Record<string, never>;
}

export type SidebarCommand =
  | StartCommand
  | CancelCommand
  | RemoveQueueItemCommand
  | OpenAuditLogCommand
  | RetryQueueItemCommand
  | MoveQueueItemUpCommand
  | MoveQueueItemDownCommand
  | ClearCompletedCommand
  | PauseQueueCommand
  | ResumeQueueCommand
  | OpenDashboardCommand
  | RerunFromHistoryCommand
  | OpenHistoryItemDetailsCommand
  | SaveModelsCommand
  | SaveDefinitionDraftCommand
  | PublishDefinitionCommand
  | DeactivateDefinitionCommand
  | RestoreDefinitionVersionCommand
  | DiscardDefinitionDraftCommand
  | PublishPackageCommand
  | ReadDefinitionVersionCommand
  | SaveGeneralSettingsCommand
  // Thirteen live-queue controls, named as the one family they are; the arms
  // are spelled out in sidebar-ipc/run-controls.ts.
  | RunControlCommand
  | CreateQueueCommand
  | RenameQueueCommand
  | DeleteQueueCommand
  | SaveQueueSettingsCommand
  | MoveTaskCommand
  | ReadPhaseLogCommand
  | StartPhaseLogTailCommand
  | StopPhaseLogTailCommand
  | OpenVerboseSettingCommand
  | ResolveAuditPointerCommand
  | ResolveHistoryDescriptionCommand
  | StartQueueCommand
  | ClearAllCommand
  | SetConfirmSuppressionCommand
  | DismissMigrationNoticeCommand
  | ReadMetricsCommand
  | PingBackendCommand
  | ExportProcessYamlCommand
  | PreflightProcessYamlCommand
  | LaunchPipelineCommand
  | LaunchWorkflowCommand
  | ContinueWorkflowCommand;

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
export function isCmdPauseQueue(value: unknown): value is PauseQueueCommand {
  return isObjectWithType(value, CMD_PAUSE_QUEUE);
}
export function isCmdResumeQueue(value: unknown): value is ResumeQueueCommand {
  return isObjectWithType(value, CMD_RESUME_QUEUE);
}
export function isCmdOpenDashboard(value: unknown): value is OpenDashboardCommand {
  return isObjectWithType(value, CMD_OPEN_DASHBOARD);
}
export function isCmdRerunFromHistory(value: unknown): value is RerunFromHistoryCommand {
  return isObjectWithType(value, CMD_RERUN_FROM_HISTORY);
}
export function isCmdOpenHistoryItemDetails(value: unknown): value is OpenHistoryItemDetailsCommand {
  return isObjectWithType(value, CMD_OPEN_HISTORY_ITEM_DETAILS);
}
// Feature 011 catalog/settings/retry guards.
// Feature 100 lifecycle guards. Unlike the layer saves above, these check the
// payload: `kind`, `id`, and `expectedDraftVersion` choose which definition is
// written and gate the write, so an absent one must not reach the store as
// `undefined`. The definition body stays `unknown` at the boundary as ever.
export function isCmdSaveDefinitionDraft(value: unknown): value is SaveDefinitionDraftCommand {
  return isObjectWithType(value, CMD_SAVE_DEFINITION_DRAFT)
    && isSaveDefinitionDraftPayload((value as { payload?: unknown }).payload);
}
export function isCmdPublishDefinition(value: unknown): value is PublishDefinitionCommand {
  return isObjectWithType(value, CMD_PUBLISH_DEFINITION)
    && isDefinitionOperationPayload((value as { payload?: unknown }).payload);
}
export function isCmdDeactivateDefinition(value: unknown): value is DeactivateDefinitionCommand {
  return isObjectWithType(value, CMD_DEACTIVATE_DEFINITION)
    && isDefinitionOperationPayload((value as { payload?: unknown }).payload);
}
export function isCmdRestoreDefinitionVersion(
  value: unknown
): value is RestoreDefinitionVersionCommand {
  return isObjectWithType(value, CMD_RESTORE_DEFINITION_VERSION)
    && isRestoreDefinitionVersionPayload((value as { payload?: unknown }).payload);
}
export function isCmdDiscardDefinitionDraft(
  value: unknown
): value is DiscardDefinitionDraftCommand {
  return isObjectWithType(value, CMD_DISCARD_DEFINITION_DRAFT)
    && isDefinitionOperationPayload((value as { payload?: unknown }).payload);
}
export function isCmdPublishPackage(value: unknown): value is PublishPackageCommand {
  return isObjectWithType(value, CMD_PUBLISH_PACKAGE)
    && isPublishPackagePayload((value as { payload?: unknown }).payload);
}
export function isCmdSaveModels(value: unknown): value is SaveModelsCommand {
  if (!isObjectWithType(value, CMD_SAVE_MODELS)) return false;
  // Feature 096 — `expectedRevision`/`mutation` are optional; omission is
  // always valid (the manual add/remove call site), presence requires shape
  // (the import-confirm call site, contracts/model-catalog-exchange.md §4).
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object') return false;
  const { expectedRevision, mutation } = payload as {
    expectedRevision?: unknown;
    mutation?: unknown;
  };
  if (expectedRevision !== undefined && typeof expectedRevision !== 'string') return false;
  if (mutation === undefined) return true;
  if (mutation === null || typeof mutation !== 'object') return false;
  const kind = (mutation as { kind?: unknown }).kind;
  return kind === 'manual-edit' || kind === 'import-package';
}
export function isCmdSaveGeneralSettings(value: unknown): value is SaveGeneralSettingsCommand {
  return isObjectWithType(value, CMD_SAVE_GENERAL_SETTINGS);
}
export function isCmdRetryPhaseNow(value: unknown): value is RetryPhaseNowCommand {
  return isObjectWithType(value, CMD_RETRY_PHASE_NOW);
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
export function isCmdCreateQueue(value: unknown): value is CreateQueueCommand {
  return isObjectWithType(value, CMD_CREATE_QUEUE);
}
export function isCmdRenameQueue(value: unknown): value is RenameQueueCommand {
  return isObjectWithType(value, CMD_RENAME_QUEUE);
}
export function isCmdDeleteQueue(value: unknown): value is DeleteQueueCommand {
  return isObjectWithType(value, CMD_DELETE_QUEUE);
}
export function isCmdSaveQueueSettings(value: unknown): value is SaveQueueSettingsCommand {
  return isObjectWithType(value, CMD_SAVE_QUEUE_SETTINGS);
}
export function isCmdMoveTask(value: unknown): value is MoveTaskCommand {
  return isObjectWithType(value, CMD_MOVE_TASK);
}
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
export function isCmdResolveAuditPointer(value: unknown): value is ResolveAuditPointerCommand {
  return isObjectWithType(value, CMD_RESOLVE_AUDIT_POINTER);
}
export function isCmdResolveHistoryDescription(
  value: unknown
): value is ResolveHistoryDescriptionCommand {
  return isObjectWithType(value, CMD_RESOLVE_HISTORY_DESCRIPTION);
}
// Feature 028 — phase breakpoint set/clear guards.
export function isCmdSetPhaseBreakpoint(value: unknown): value is SetPhaseBreakpointCommand {
  return isObjectWithType(value, CMD_SET_PHASE_BREAKPOINT);
}
export function isCmdClearPhaseBreakpoint(value: unknown): value is ClearPhaseBreakpointCommand {
  return isObjectWithType(value, CMD_CLEAR_PHASE_BREAKPOINT);
}
// BUG-002 (FR-012a) — start-queue guard.
// Feature 065 — also accepts `payload.startIntent` (additive) per
// sidebar-ipc.diff.md. Empty-object payload remains valid for back-compat.
// Feature 092 (T061, FR-034) — also accepts `payload.queueId` (additive).
// The key set stays closed: an unknown key is still a rejection, so a
// misspelled `queueID` fails at the boundary rather than silently
// addressing the default queue. This predicate checks shape only, as every
// predicate in this file does — the `QUEUE_ID_MAX` length bound is
// `validateStartQueue`'s, the ingress gate this must stay in lockstep with,
// and membership of the id in the registry is the host's business.
export function isCmdStartQueue(value: unknown): value is StartQueueCommand {
  if (!isObjectWithType(value, CMD_START_QUEUE)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === undefined) return true;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== 'queueId' && key !== 'startIntent')) return false;
  const { queueId, startIntent } = payload as {
    queueId?: unknown;
    startIntent?: unknown;
  };
  if (queueId !== undefined && (typeof queueId !== 'string' || queueId.length === 0)) {
    return false;
  }
  return startIntent === undefined || isValidStartQueueIntent(startIntent);
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

// Feature 073 — read-only metrics scan guard. The payload rule itself is
// `isReadMetricsRequest`, extracted beside the shape it describes for the
// reason the 087 entry in this file's LOC budget gives: a predicate needing
// none of this module's runtime values belongs there, and what stays here is
// the discriminator check, which cannot leave without creating a cycle.
export function isCmdReadMetrics(value: unknown): value is ReadMetricsCommand {
  if (!isObjectWithType(value, CMD_READ_METRICS)) return false;
  return isReadMetricsRequest((value as { payload?: unknown }).payload);
}

export function isCmdPingBackend(value: unknown): value is PingBackendCommand {
  if (!isObjectWithType(value, CMD_PING_BACKEND)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).length !== 1) return false;
  const runner = (payload as { runner?: unknown }).runner;
  return runner === 'claude' || runner === 'codex' || runner === 'agy';
}

// Feature 084 / feature 085 — read-only export guard. The payload is the
// discriminated union `ExportProcessYamlRequest`: a Phase carries an id and
// nothing else, a Pipeline additionally carries the operator's inclusion choice
// (FR-012). The two arms are checked separately so `inclusion` cannot ride along
// on a Phase export — that is the whole reason the wire type is a union rather
// than an optional field, and a guard that ignored it would let the boundary
// admit a shape the type forbids. Length bounds stay in
// `src/contracts/validators/process-yaml.ts`, which is what the router runs.
export function isCmdExportProcessYaml(value: unknown): value is ExportProcessYamlCommand {
  if (!isObjectWithType(value, CMD_EXPORT_PROCESS_YAML)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const { resourceKind, resourceId, inclusion } = payload as {
    resourceKind?: unknown;
    resourceId?: unknown;
    inclusion?: unknown;
  };
  // Feature 096 — modelCatalog has exactly one catalog, so it carries no
  // resourceId; every other kind still requires one, unchanged.
  if (resourceKind === 'modelCatalog') {
    return resourceId === undefined && admitsExportInclusion(resourceKind, inclusion);
  }
  if (typeof resourceId !== 'string') return false;
  return admitsExportInclusion(resourceKind, inclusion);
}

// Feature 084 / feature 085 — read-only import preflight guard. The payload is
// empty and stays empty: no location, no bytes, no scope (FR-020a), and as of
// 085 no kind either, because the host dispatches on the `kind:` the document
// itself declares (FR-055a). Every field is rejected rather than ignored, so a
// kind can only come back by a deliberate edit here.
export function isCmdPreflightProcessYaml(
  value: unknown
): value is PreflightProcessYamlCommand {
  if (!isObjectWithType(value, CMD_PREFLIGHT_PROCESS_YAML)) return false;
  const payload = (value as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.keys(payload).length === 0;
}

// Feature 087 — only the discriminator needs a runtime value from this module.
export function isCmdLaunchPipeline(value: unknown): value is LaunchPipelineCommand {
  return isObjectWithType(value, CMD_LAUNCH_PIPELINE)
    && isLaunchPipelinePayload((value as { payload?: unknown }).payload);
}

// Feature 088 — same split: the payload predicates live in the sub-module and
// need nothing from here; only the discriminator does.
export function isCmdLaunchWorkflow(value: unknown): value is LaunchWorkflowCommand {
  return isObjectWithType(value, CMD_LAUNCH_WORKFLOW)
    && isLaunchWorkflowPayload((value as { payload?: unknown }).payload);
}

export function isCmdContinueWorkflow(value: unknown): value is ContinueWorkflowCommand {
  return isObjectWithType(value, CMD_CONTINUE_WORKFLOW)
    && isContinueWorkflowPayload((value as { payload?: unknown }).payload);
}

// Exhaustive guard registry. The drift test asserts the keys of this
// record equal `COMMAND_TYPES`; missing entries fail the test.
export const COMMAND_GUARDS: Readonly<
  Record<CommandType, (value: unknown) => boolean>
> = Object.freeze({
  [CMD_START]: isCmdStart,
  [CMD_CANCEL]: isCmdCancel,
  [CMD_REMOVE_QUEUE_ITEM]: isCmdRemoveQueueItem,
  [CMD_OPEN_AUDIT_LOG]: isCmdOpenAuditLog,
  [CMD_RETRY_QUEUE_ITEM]: isCmdRetryQueueItem,
  [CMD_MOVE_QUEUE_ITEM_UP]: isCmdMoveQueueItemUp,
  [CMD_MOVE_QUEUE_ITEM_DOWN]: isCmdMoveQueueItemDown,
  [CMD_CLEAR_COMPLETED]: isCmdClearCompleted,
  [CMD_PAUSE_QUEUE]: isCmdPauseQueue,
  [CMD_RESUME_QUEUE]: isCmdResumeQueue,
  [CMD_OPEN_DASHBOARD]: isCmdOpenDashboard,
  [CMD_RERUN_FROM_HISTORY]: isCmdRerunFromHistory,
  [CMD_OPEN_HISTORY_ITEM_DETAILS]: isCmdOpenHistoryItemDetails,
  [CMD_SAVE_MODELS]: isCmdSaveModels,
  [CMD_SAVE_DEFINITION_DRAFT]: isCmdSaveDefinitionDraft,
  [CMD_PUBLISH_DEFINITION]: isCmdPublishDefinition,
  [CMD_DEACTIVATE_DEFINITION]: isCmdDeactivateDefinition,
  [CMD_RESTORE_DEFINITION_VERSION]: isCmdRestoreDefinitionVersion,
  [CMD_DISCARD_DEFINITION_DRAFT]: isCmdDiscardDefinitionDraft,
  [CMD_PUBLISH_PACKAGE]: isCmdPublishPackage,
  [CMD_READ_DEFINITION_VERSION]: isCmdReadDefinitionVersion,
  [CMD_SAVE_GENERAL_SETTINGS]: isCmdSaveGeneralSettings,
  [CMD_RETRY_PHASE_NOW]: isCmdRetryPhaseNow,
  [CMD_PAUSE_PHASE]: isCmdPausePhase,
  [CMD_RESUME_PHASE]: isCmdResumePhase,
  [CMD_RESTART_PHASE]: isCmdRestartPhase,
  [CMD_SKIP_PHASE]: isCmdSkipPhase,
  [CMD_DISABLE_PHASE]: isCmdDisablePhase,
  [CMD_ENABLE_PHASE]: isCmdEnablePhase,
  [CMD_REMOVE_TASK_PHASE]: isCmdRemoveTaskPhase,
  [CMD_CREATE_QUEUE]: isCmdCreateQueue,
  [CMD_RENAME_QUEUE]: isCmdRenameQueue,
  [CMD_DELETE_QUEUE]: isCmdDeleteQueue,
  [CMD_SAVE_QUEUE_SETTINGS]: isCmdSaveQueueSettings,
  [CMD_MOVE_TASK]: isCmdMoveTask,
  [CMD_MODIFY_TASK]: isCmdModifyTask,
  [CMD_REORDER_TASK]: isCmdReorderTask,
  [CMD_RESTART_CANCELED_TASK]: isCmdRestartCanceledTask,
  [CMD_READ_PHASE_LOG]: isCmdReadPhaseLog,
  [CMD_START_PHASE_LOG_TAIL]: isCmdStartPhaseLogTail,
  [CMD_STOP_PHASE_LOG_TAIL]: isCmdStopPhaseLogTail,
  [CMD_OPEN_VERBOSE_SETTING]: isCmdOpenVerboseSetting,
  [CMD_RESOLVE_AUDIT_POINTER]: isCmdResolveAuditPointer,
  [CMD_RESOLVE_HISTORY_DESCRIPTION]: isCmdResolveHistoryDescription,
  [CMD_SET_PHASE_BREAKPOINT]: isCmdSetPhaseBreakpoint,
  [CMD_CLEAR_PHASE_BREAKPOINT]: isCmdClearPhaseBreakpoint,
  [CMD_START_QUEUE]: isCmdStartQueue,
  [CMD_CLEAR_ALL]: isCmdClearAll,
  [CMD_SET_CONFIRM_SUPPRESSION]: isCmdSetConfirmSuppression,
  [CMD_DISMISS_MIGRATION_NOTICE]: isCmdDismissMigrationNotice,
  [CMD_READ_METRICS]: isCmdReadMetrics,
  [CMD_PING_BACKEND]: isCmdPingBackend,
  [CMD_EXPORT_PROCESS_YAML]: isCmdExportProcessYaml,
  [CMD_PREFLIGHT_PROCESS_YAML]: isCmdPreflightProcessYaml,
  [CMD_LAUNCH_PIPELINE]: isCmdLaunchPipeline,
  [CMD_LAUNCH_WORKFLOW]: isCmdLaunchWorkflow,
  [CMD_CONTINUE_WORKFLOW]: isCmdContinueWorkflow
});
