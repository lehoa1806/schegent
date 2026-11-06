import {
  CMD_ATTEST_TASK_COMPLETED,
  CMD_CANCEL,
  CMD_CLEAR_QUEUE,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_CONTINUE_WORKFLOW,
  CMD_CREATE_QUEUE,
  CMD_DEACTIVATE_DEFINITION,
  CMD_DELETE_QUEUE,
  CMD_DISABLE_PHASE,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_ENABLE_PHASE,
  CMD_EXPORT_PROCESS_YAML,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_TASK,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_OPEN_TRUST_SETTINGS,
  CMD_PAUSE_PHASE,
  CMD_OPEN_DECISION_RECORD,
  CMD_PAUSE_QUEUE,
  CMD_PING_BACKEND,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_READ_DEFINITION_VERSION,
  CMD_READ_METRICS,
  CMD_READ_FAILURE_RECORD,
  CMD_READ_PHASE_LOG,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_RENAME_QUEUE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESOLVE_AUDIT_POINTER,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_PHASE_NOW,
  CMD_RETRY_QUEUE_ITEM,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SET_QUEUE_FAILURE_POLICY,
  CMD_SET_UNCONTAINED_BACKEND_GRANT,
  CMD_SKIP_PHASE,
  CMD_START,
  CMD_START_PHASE_LOG_TAIL,
  CMD_START_QUEUE,
  CMD_STOP_PHASE_LOG_TAIL,
  type CommandType,
  type SidebarCommand
} from '../messages';
import type { CommandHandler } from './handler-contract';

import { handler as attestTaskCompleted } from './cmd-attest-task-completed';
import { handler as cancel } from './cmd-cancel';
import { handler as clearQueue } from './cmd-clear-queue';
import { handler as clearCompleted } from './cmd-clear-completed';
import { handler as clearPhaseBreakpoint } from './cmd-clear-phase-breakpoint';
import { handler as continueWorkflow } from './cmd-continue-workflow';
import { handler as createQueue } from './cmd-create-queue';
import { handler as deleteQueue } from './cmd-delete-queue';
import { handler as disablePhase } from './cmd-disable-phase';
import { handler as dismissMigrationNotice } from './cmd-dismiss-migration-notice';
import { handler as enablePhase } from './cmd-enable-phase';
import { handler as exportProcessYaml } from './cmd-export-process-yaml';
import { handler as launchPipeline } from './cmd-launch-pipeline';
import { handler as launchWorkflow } from './cmd-launch-workflow';
import { handler as modifyTask } from './cmd-modify-task';
import { handler as moveQueueItemDown } from './cmd-move-queue-item-down';
import { handler as moveQueueItemUp } from './cmd-move-queue-item-up';
import { handler as moveTask } from './cmd-move-task';
import { handler as openAuditLog } from './cmd-open-audit-log';
import { handler as openDashboard } from './cmd-open-dashboard';
import { handler as openHistoryItemDetails } from './cmd-open-history-item-details';
import { handler as openVerboseSetting } from './cmd-open-verbose-setting';
import { handler as openTrustSettings } from './cmd-open-trust-settings';
import { handler as pausePhase } from './cmd-pause-phase';
import { handler as pauseQueue } from './cmd-pause-queue';
import { handler as pingBackend } from './cmd-ping-backend';
import { handler as preflightProcessYaml } from './cmd-preflight-process-yaml';
import { handler as readDefinitionVersion } from './cmd-read-definition-version';
import { handler as readMetrics } from './cmd-read-metrics';
import { handler as openDecisionRecord } from './cmd-open-decision-record';
import { handler as readFailureRecord } from './cmd-read-failure-record';
import { handler as readPhaseLog } from './cmd-read-phase-log';
import { handler as removeQueueItem } from './cmd-remove-queue-item';
import { handler as removeTaskPhase } from './cmd-remove-task-phase';
import { handler as renameQueue } from './cmd-rename-queue';
import { handler as reorderTask } from './cmd-reorder-task';
import { handler as rerunFromHistory } from './cmd-rerun-from-history';
import { handler as resolveAuditPointer } from './cmd-resolve-audit-pointer';
import { handler as resolveHistoryDescription } from './cmd-resolve-history-description';
import { handler as restartCanceledTask } from './cmd-restart-canceled-task';
import { handler as restartPhase } from './cmd-restart-phase';
import { handler as resumePhase } from './cmd-resume-phase';
import { handler as resumeQueue } from './cmd-resume-queue';
import { handler as retryPhaseNow } from './cmd-retry-phase-now';
import { handler as retryQueueItem } from './cmd-retry-queue-item';
import {
  deactivateDefinition,
  discardDefinitionDraft,
  publishDefinition,
  publishDefinitionPackage,
  restoreDefinitionVersion,
  saveDefinitionDraft
} from './cmd-catalog-lifecycle';
import { handler as saveGeneralSettings } from './cmd-save-general-settings';
import { handler as saveModels } from './cmd-save-models';
import { handler as saveQueueSettings } from './cmd-save-queue-settings';
import { handler as setConfirmSuppression } from './cmd-set-confirm-suppression';
import { handler as setQueueFailurePolicy } from './cmd-set-queue-failure-policy';
import { handler as setUncontainedBackendGrant } from './cmd-set-uncontained-backend-grant';
import { handler as setPhaseBreakpoint } from './cmd-set-phase-breakpoint';
import { handler as skipPhase } from './cmd-skip-phase';
import { handler as start } from './cmd-start';
import { handler as startPhaseLogTail } from './cmd-start-phase-log-tail';
import { handler as startQueue } from './cmd-start-queue';
import { handler as stopPhaseLogTail } from './cmd-stop-phase-log-tail';

// Frozen registry of per-command handlers. The dispatcher in
// `message-router.ts` looks up handlers by command type literal and invokes
// them with a `HandlerContext` carrying deps, postAck, and the
// correlationId. The recipe for adding a command, including its authority
// declaration, is the header of `message-router.ts`; this registry is its fifth
// step. The drift-guard at `tests/unit/contracts/sidebar-ipc-drift.test.ts`
// enforces that `messages.ts` re-exports from the authoritative module.
export type CommandHandlerTable = {
  readonly [K in CommandType]: CommandHandler<Extract<SidebarCommand, { readonly type: K }>>;
};

// Exhaustive compile-time table keyed by `CommandType`. Omitting any
// `CommandType` member fails `tsc` here before runtime.
export const HANDLER_TABLE: CommandHandlerTable = Object.freeze({
  [CMD_ATTEST_TASK_COMPLETED]: attestTaskCompleted,
  [CMD_CANCEL]: cancel,
  [CMD_CLEAR_QUEUE]: clearQueue,
  [CMD_CLEAR_COMPLETED]: clearCompleted,
  [CMD_CLEAR_PHASE_BREAKPOINT]: clearPhaseBreakpoint,
  [CMD_CONTINUE_WORKFLOW]: continueWorkflow,
  [CMD_CREATE_QUEUE]: createQueue,
  [CMD_DELETE_QUEUE]: deleteQueue,
  [CMD_DISABLE_PHASE]: disablePhase,
  [CMD_DISMISS_MIGRATION_NOTICE]: dismissMigrationNotice,
  [CMD_ENABLE_PHASE]: enablePhase,
  [CMD_EXPORT_PROCESS_YAML]: exportProcessYaml,
  [CMD_LAUNCH_PIPELINE]: launchPipeline,
  [CMD_LAUNCH_WORKFLOW]: launchWorkflow,
  [CMD_MODIFY_TASK]: modifyTask,
  [CMD_MOVE_QUEUE_ITEM_DOWN]: moveQueueItemDown,
  [CMD_MOVE_QUEUE_ITEM_UP]: moveQueueItemUp,
  [CMD_MOVE_TASK]: moveTask,
  [CMD_OPEN_AUDIT_LOG]: openAuditLog,
  [CMD_OPEN_DASHBOARD]: openDashboard,
  [CMD_OPEN_HISTORY_ITEM_DETAILS]: openHistoryItemDetails,
  [CMD_OPEN_VERBOSE_SETTING]: openVerboseSetting,
  [CMD_OPEN_TRUST_SETTINGS]: openTrustSettings,
  [CMD_PAUSE_PHASE]: pausePhase,
  [CMD_PAUSE_QUEUE]: pauseQueue,
  [CMD_PING_BACKEND]: pingBackend,
  [CMD_PREFLIGHT_PROCESS_YAML]: preflightProcessYaml,
  [CMD_READ_DEFINITION_VERSION]: readDefinitionVersion,
  [CMD_READ_METRICS]: readMetrics,
  [CMD_OPEN_DECISION_RECORD]: openDecisionRecord,
  [CMD_READ_FAILURE_RECORD]: readFailureRecord,
  [CMD_READ_PHASE_LOG]: readPhaseLog,
  [CMD_REMOVE_QUEUE_ITEM]: removeQueueItem,
  [CMD_REMOVE_TASK_PHASE]: removeTaskPhase,
  [CMD_RENAME_QUEUE]: renameQueue,
  [CMD_REORDER_TASK]: reorderTask,
  [CMD_RERUN_FROM_HISTORY]: rerunFromHistory,
  [CMD_RESOLVE_AUDIT_POINTER]: resolveAuditPointer,
  [CMD_RESOLVE_HISTORY_DESCRIPTION]: resolveHistoryDescription,
  [CMD_RESTART_CANCELED_TASK]: restartCanceledTask,
  [CMD_RESTART_PHASE]: restartPhase,
  [CMD_RESUME_PHASE]: resumePhase,
  [CMD_RESUME_QUEUE]: resumeQueue,
  [CMD_RETRY_PHASE_NOW]: retryPhaseNow,
  [CMD_RETRY_QUEUE_ITEM]: retryQueueItem,
  // Feature 100 (T508) — the six lifecycle commands, all six from one module.
  [CMD_DEACTIVATE_DEFINITION]: deactivateDefinition,
  [CMD_DISCARD_DEFINITION_DRAFT]: discardDefinitionDraft,
  [CMD_PUBLISH_DEFINITION]: publishDefinition,
  [CMD_PUBLISH_PACKAGE]: publishDefinitionPackage,
  [CMD_RESTORE_DEFINITION_VERSION]: restoreDefinitionVersion,
  [CMD_SAVE_DEFINITION_DRAFT]: saveDefinitionDraft,
  [CMD_SAVE_GENERAL_SETTINGS]: saveGeneralSettings,
  [CMD_SAVE_MODELS]: saveModels,
  [CMD_SAVE_QUEUE_SETTINGS]: saveQueueSettings,
  [CMD_SET_CONFIRM_SUPPRESSION]: setConfirmSuppression,
  [CMD_SET_PHASE_BREAKPOINT]: setPhaseBreakpoint,
  [CMD_SET_QUEUE_FAILURE_POLICY]: setQueueFailurePolicy,
  [CMD_SET_UNCONTAINED_BACKEND_GRANT]: setUncontainedBackendGrant,
  [CMD_SKIP_PHASE]: skipPhase,
  [CMD_START]: start,
  [CMD_START_PHASE_LOG_TAIL]: startPhaseLogTail,
  [CMD_START_QUEUE]: startQueue,
  [CMD_STOP_PHASE_LOG_TAIL]: stopPhaseLogTail
});

export const HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<
  string,
  CommandHandler
>(Object.entries(HANDLER_TABLE) as Array<[string, CommandHandler]>);
