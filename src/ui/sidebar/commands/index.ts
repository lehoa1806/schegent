import {
  CMD_CANCEL,
  CMD_CLEAR_ALL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_DISABLE_PHASE,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_ENABLE_PHASE,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_OPEN_QUEUE_ITEM_DETAILS,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_PAUSE_PHASE,
  CMD_PAUSE_QUEUE,
  CMD_READ_METRICS,
  CMD_READ_PHASE_LOG,
  CMD_READ_WAKEUP_SESSION_LOG,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESET,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESUME,
  CMD_RESUME_PHASE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_ACTIVE_RUN,
  CMD_RETRY_PHASE_NOW,
  CMD_RETRY_QUEUE_ITEM,
  CMD_REVEAL_WAKEUP_SESSION_LOG,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_WAKEUP_SETTINGS,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SKIP_PHASE,
  CMD_START,
  CMD_START_PHASE_LOG_TAIL,
  CMD_START_QUEUE,
  CMD_STOP_PHASE_LOG_TAIL,
  CMD_WAKE_UP_NOW
} from '../messages';
import type { CommandHandler } from './handler-contract';

import { handler as cancel } from './cmd-cancel';
import { handler as clearAll } from './cmd-clear-all';
import { handler as clearCompleted } from './cmd-clear-completed';
import { handler as clearFailed } from './cmd-clear-failed';
import { handler as clearPhaseBreakpoint } from './cmd-clear-phase-breakpoint';
import { handler as disablePhase } from './cmd-disable-phase';
import { handler as dismissMigrationNotice } from './cmd-dismiss-migration-notice';
import { handler as enablePhase } from './cmd-enable-phase';
import { handler as modifyTask } from './cmd-modify-task';
import { handler as moveQueueItemDown } from './cmd-move-queue-item-down';
import { handler as moveQueueItemUp } from './cmd-move-queue-item-up';
import { handler as openAuditLog } from './cmd-open-audit-log';
import { handler as openDashboard } from './cmd-open-dashboard';
import { handler as openHistoryItemDetails } from './cmd-open-history-item-details';
import { handler as openQueueItemDetails } from './cmd-open-queue-item-details';
import { handler as openVerboseSetting } from './cmd-open-verbose-setting';
import { handler as pausePhase } from './cmd-pause-phase';
import { handler as pauseQueue } from './cmd-pause-queue';
import { handler as readMetrics } from './cmd-read-metrics';
import { handler as readPhaseLog } from './cmd-read-phase-log';
import { handler as readWakeupSessionLog } from './cmd-read-wakeup-session-log';
import { handler as removeQueueItem } from './cmd-remove-queue-item';
import { handler as removeTaskPhase } from './cmd-remove-task-phase';
import { handler as reorderTask } from './cmd-reorder-task';
import { handler as rerunFromHistory } from './cmd-rerun-from-history';
import { handler as reset } from './cmd-reset';
import { handler as restartCanceledTask } from './cmd-restart-canceled-task';
import { handler as restartPhase } from './cmd-restart-phase';
import { handler as resume } from './cmd-resume';
import { handler as resumePhase } from './cmd-resume-phase';
import { handler as resumeQueue } from './cmd-resume-queue';
import { handler as retryActiveRun } from './cmd-retry-active-run';
import { handler as retryPhaseNow } from './cmd-retry-phase-now';
import { handler as retryQueueItem } from './cmd-retry-queue-item';
import { handler as revealWakeupSessionLog } from './cmd-reveal-wakeup-session-log';
import { handler as saveGeneralSettings } from './cmd-save-general-settings';
import { handler as saveModels } from './cmd-save-models';
import { handler as savePhases } from './cmd-save-phases';
import { handler as savePipelines } from './cmd-save-pipelines';
import { handler as saveWakeupSettings } from './cmd-save-wakeup-settings';
import { handler as setConfirmSuppression } from './cmd-set-confirm-suppression';
import { handler as setPhaseBreakpoint } from './cmd-set-phase-breakpoint';
import { handler as skipPhase } from './cmd-skip-phase';
import { handler as start } from './cmd-start';
import { handler as startPhaseLogTail } from './cmd-start-phase-log-tail';
import { handler as startQueue } from './cmd-start-queue';
import { handler as stopPhaseLogTail } from './cmd-stop-phase-log-tail';
import { handler as wakeUpNow } from './cmd-wake-up-now';

// Frozen registry of per-command handlers. The dispatcher in
// `message-router.ts` looks up handlers by command type literal and invokes
// them with a `HandlerContext` carrying deps, postAck, and the
// correlationId. Adding a new command requires (1) adding the CMD_ constant
// + interface in `src/contracts/sidebar-ipc.ts`, (2) creating the
// per-command handler file in this directory, and (3) wiring it here. The
// drift-guard at `tests/unit/contracts/sidebar-ipc-drift.test.ts` enforces
// that `messages.ts` re-exports from the authoritative module.
export const HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<
  string,
  CommandHandler
>([
  [CMD_CANCEL, cancel as CommandHandler],
  [CMD_CLEAR_ALL, clearAll as CommandHandler],
  [CMD_CLEAR_COMPLETED, clearCompleted as CommandHandler],
  [CMD_CLEAR_FAILED, clearFailed as CommandHandler],
  [CMD_CLEAR_PHASE_BREAKPOINT, clearPhaseBreakpoint as CommandHandler],
  [CMD_DISABLE_PHASE, disablePhase as CommandHandler],
  [CMD_DISMISS_MIGRATION_NOTICE, dismissMigrationNotice as CommandHandler],
  [CMD_ENABLE_PHASE, enablePhase as CommandHandler],
  [CMD_MODIFY_TASK, modifyTask as CommandHandler],
  [CMD_MOVE_QUEUE_ITEM_DOWN, moveQueueItemDown as CommandHandler],
  [CMD_MOVE_QUEUE_ITEM_UP, moveQueueItemUp as CommandHandler],
  [CMD_OPEN_AUDIT_LOG, openAuditLog as CommandHandler],
  [CMD_OPEN_DASHBOARD, openDashboard as CommandHandler],
  [CMD_OPEN_HISTORY_ITEM_DETAILS, openHistoryItemDetails as CommandHandler],
  [CMD_OPEN_QUEUE_ITEM_DETAILS, openQueueItemDetails as CommandHandler],
  [CMD_OPEN_VERBOSE_SETTING, openVerboseSetting as CommandHandler],
  [CMD_PAUSE_PHASE, pausePhase as CommandHandler],
  [CMD_PAUSE_QUEUE, pauseQueue as CommandHandler],
  [CMD_READ_METRICS, readMetrics as CommandHandler],
  [CMD_READ_PHASE_LOG, readPhaseLog as CommandHandler],
  [CMD_READ_WAKEUP_SESSION_LOG, readWakeupSessionLog as CommandHandler],
  [CMD_REMOVE_QUEUE_ITEM, removeQueueItem as CommandHandler],
  [CMD_REMOVE_TASK_PHASE, removeTaskPhase as CommandHandler],
  [CMD_REORDER_TASK, reorderTask as CommandHandler],
  [CMD_RERUN_FROM_HISTORY, rerunFromHistory as CommandHandler],
  [CMD_RESET, reset as CommandHandler],
  [CMD_RESTART_CANCELED_TASK, restartCanceledTask as CommandHandler],
  [CMD_RESTART_PHASE, restartPhase as CommandHandler],
  [CMD_RESUME, resume as CommandHandler],
  [CMD_RESUME_PHASE, resumePhase as CommandHandler],
  [CMD_RESUME_QUEUE, resumeQueue as CommandHandler],
  [CMD_RETRY_ACTIVE_RUN, retryActiveRun as CommandHandler],
  [CMD_RETRY_PHASE_NOW, retryPhaseNow as CommandHandler],
  [CMD_RETRY_QUEUE_ITEM, retryQueueItem as CommandHandler],
  [CMD_REVEAL_WAKEUP_SESSION_LOG, revealWakeupSessionLog as CommandHandler],
  [CMD_SAVE_GENERAL_SETTINGS, saveGeneralSettings as CommandHandler],
  [CMD_SAVE_MODELS, saveModels as CommandHandler],
  [CMD_SAVE_PHASES, savePhases as CommandHandler],
  [CMD_SAVE_PIPELINES, savePipelines as CommandHandler],
  [CMD_SAVE_WAKEUP_SETTINGS, saveWakeupSettings as CommandHandler],
  [CMD_SET_CONFIRM_SUPPRESSION, setConfirmSuppression as CommandHandler],
  [CMD_SET_PHASE_BREAKPOINT, setPhaseBreakpoint as CommandHandler],
  [CMD_SKIP_PHASE, skipPhase as CommandHandler],
  [CMD_START, start as CommandHandler],
  [CMD_START_PHASE_LOG_TAIL, startPhaseLogTail as CommandHandler],
  [CMD_START_QUEUE, startQueue as CommandHandler],
  [CMD_STOP_PHASE_LOG_TAIL, stopPhaseLogTail as CommandHandler],
  [CMD_WAKE_UP_NOW, wakeUpNow as CommandHandler]
]);
