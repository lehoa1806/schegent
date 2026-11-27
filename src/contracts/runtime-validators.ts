// Authoritative runtime validators for inbound webview→host IPC messages.
//
// Feature 013 — Wave 5 (US5): this file is the SINGLE source of truth for
// `validateInboundMessage`. The sidebar shim at `src/ui/sidebar/ipc-validator.ts`
// is a thin re-export of this module. The lint test at
// `tests/lint/no-duplicate-ipc-validators.test.ts` guards against drift.
//
// FR-R7-05 — Per-command inbound validators are generated from the declarative
// descriptors under `scripts/contracts/ipc-descriptors/` into
// `src/contracts/generated/validators/<family>.ts`. Each generated validator
// constructs a statically typed member of `SidebarCommand` with zero casts.

import {
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_ATTEST_TASK_COMPLETED,
  CMD_CANCEL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_CLEAR_QUEUE,
  CMD_CONTINUE_WORKFLOW,
  CMD_CREATE_QUEUE,
  CMD_DEACTIVATE_DEFINITION,
  CMD_DECIDE_PHASE_HANDOFF,
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
  CMD_MUTATE_REPORT,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_DECISION_RECORD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_OPEN_TRUST_SETTINGS,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_PAUSE_PHASE,
  CMD_PAUSE_QUEUE,
  CMD_PING_BACKEND,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_READ_DEFINITION_VERSION,
  CMD_READ_EXECUTION_VISIBILITY,
  CMD_READ_FAILURE_RECORD,
  CMD_READ_METRICS,
  CMD_READ_PHASE_LOG,
  CMD_READ_REPORT,
  CMD_READ_STORAGE_DETAILS,
  CMD_READ_USAGE_ACCOUNTING,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_RENAME_QUEUE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESOLVE_AUDIT_POINTER,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_RESUME_PHASE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_PHASE_NOW,
  CMD_RETRY_QUEUE_ITEM,
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
  SIDEBAR_IPC_SCHEMA_VERSION
} from './sidebar-ipc';
import {
  validateMutateReport,
  validateReadMetrics,
  validateReadReport,
  validateReadStorageDetails,
  validateReadUsageAccounting
} from './generated/validators/analytics-reporting';
import {
  validateDeactivateDefinition,
  validateDiscardDefinitionDraft,
  validateExportProcessYaml,
  validatePreflightProcessYaml,
  validatePublishDefinition,
  validatePublishPackage,
  validateReadDefinitionVersion,
  validateRestoreDefinitionVersion,
  validateSaveDefinitionDraft
} from './generated/validators/catalog';
import {
  validateContinueWorkflow,
  validateDecidePhaseHandoff,
  validateLaunchPipeline,
  validateLaunchWorkflow,
  validateOpenChangeReview,
  validateReadExecutionVisibility
} from './generated/validators/execution-workflow';
import {
  validateOpenDecisionRecord,
  validateOpenHistoryItemDetails,
  validateReadFailureRecord,
  validateRerunFromHistory,
  validateResolveAuditPointer,
  validateResolveHistoryDescription
} from './generated/validators/history-evidence';
import {
  validateDismissMigrationNotice,
  validateOpenAuditLog,
  validateOpenDashboard,
  validateOpenTrustSettings,
  validateOpenVerboseSetting,
  validatePingBackend,
  validateSaveGeneralSettings,
  validateSaveModels,
  validateSetConfirmSuppression,
  validateSetUncontainedBackendGrant
} from './generated/validators/navigation-settings';
import {
  validateClearPhaseBreakpoint,
  validateDisablePhase,
  validateEnablePhase,
  validatePausePhase,
  validateRestartPhase,
  validateResumePhase,
  validateRetryPhaseNow,
  validateSetPhaseBreakpoint,
  validateSkipPhase
} from './generated/validators/phase-control';
import {
  validateAckPhaseLogTail,
  validateReadPhaseLog,
  validateStartPhaseLogTail,
  validateStopPhaseLogTail
} from './generated/validators/phase-log';
import {
  validateCancel,
  validateClearCompleted,
  validateClearQueue,
  validateModifyTask,
  validateMoveQueueItemDown,
  validateMoveQueueItemUp,
  validatePauseQueue,
  validateRemoveQueueItem,
  validateRemoveTaskPhase,
  validateReorderTask,
  validateRestartCanceledTask,
  validateResumeQueue,
  validateRetryQueueItem,
  validateStart,
  validateStartQueue
} from './generated/validators/queue-core';
import {
  validateAttestTaskCompleted,
  validateCreateQueue,
  validateDeleteQueue,
  validateMoveTask,
  validateRenameQueue,
  validateSaveQueueSettings,
  validateSetQueueFailurePolicy
} from './generated/validators/queue-management';
import {
  CORRELATION_ID_MAX,
  fail,
  type IpcValidationResult
} from './validators/shared';

export { isValidReadMetricsResponse } from './validators/metrics';
export { isValidReadDefinitionVersionResponse } from './validators/catalog-history';
export { isValidResolveAuditPointerResponse } from './validators/history-evidence';
export { isValidResolveHistoryDescriptionResponse } from './validators/history-description';
export { isValidReadFailureRecordResponse } from './validators/failure-record';
export { isValidReadStorageDetailsResponse } from './validators/artifact-lifecycle';
export { isValidReadUsageAccountingResponse } from './validators/usage-accounting';
export {
  isValidMutateReportResponse,
  isValidReadReportResponse
} from './validators/reporting-ipc';
export {
  isValidDecidePhaseHandoffResponse,
  isValidOpenChangeReviewResponse,
  isValidReadExecutionVisibilityResponse
} from './validators/execution-visibility-ipc';
export type { IpcValidationError, IpcValidationResult } from './validators/shared';

export function validateInboundMessage(raw: unknown): IpcValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return fail('not-an-object');
  }
  const obj = raw as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type !== 'string') return fail('missing-or-non-string-type');
  const correlationId = obj['correlationId'];
  if (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > CORRELATION_ID_MAX) {
    return fail('invalid-correlationId', { type });
  }
  if ('schemaVersion' in obj && obj['schemaVersion'] !== undefined && obj['schemaVersion'] !== SIDEBAR_IPC_SCHEMA_VERSION) {
    return fail('unsupported-ipc-schema-version', {
      code: 'unsupported-ipc-schema-version',
      type,
      correlationId
    });
  }

  switch (type) {
    case CMD_START:
      return validateStart(obj, correlationId);
    case CMD_CANCEL:
      return validateCancel(obj, correlationId);
    case CMD_REMOVE_QUEUE_ITEM:
      return validateRemoveQueueItem(obj, correlationId);
    case CMD_OPEN_AUDIT_LOG:
      return validateOpenAuditLog(obj, correlationId);
    case CMD_RETRY_QUEUE_ITEM:
      return validateRetryQueueItem(obj, correlationId);
    case CMD_MOVE_QUEUE_ITEM_UP:
      return validateMoveQueueItemUp(obj, correlationId);
    case CMD_MOVE_QUEUE_ITEM_DOWN:
      return validateMoveQueueItemDown(obj, correlationId);
    case CMD_OPEN_HISTORY_ITEM_DETAILS:
      return validateOpenHistoryItemDetails(obj, correlationId);
    case CMD_RERUN_FROM_HISTORY:
      return validateRerunFromHistory(obj, correlationId);
    case CMD_PAUSE_QUEUE:
      return validatePauseQueue(obj, correlationId);
    case CMD_RESUME_QUEUE:
      return validateResumeQueue(obj, correlationId);
    case CMD_CLEAR_COMPLETED:
      return validateClearCompleted(obj, correlationId);
    case CMD_CLEAR_QUEUE:
      return validateClearQueue(obj, correlationId);
    case CMD_SET_CONFIRM_SUPPRESSION:
      return validateSetConfirmSuppression(obj, correlationId);
    case CMD_DISMISS_MIGRATION_NOTICE:
      return validateDismissMigrationNotice(obj, correlationId);
    case CMD_OPEN_DASHBOARD:
      return validateOpenDashboard(obj, correlationId);
    case CMD_SAVE_DEFINITION_DRAFT:
      return validateSaveDefinitionDraft(obj, correlationId);
    case CMD_PUBLISH_DEFINITION:
      return validatePublishDefinition(obj, correlationId);
    case CMD_DEACTIVATE_DEFINITION:
      return validateDeactivateDefinition(obj, correlationId);
    case CMD_RESTORE_DEFINITION_VERSION:
      return validateRestoreDefinitionVersion(obj, correlationId);
    case CMD_DISCARD_DEFINITION_DRAFT:
      return validateDiscardDefinitionDraft(obj, correlationId);
    case CMD_PUBLISH_PACKAGE:
      return validatePublishPackage(obj, correlationId);
    case CMD_READ_DEFINITION_VERSION:
      return validateReadDefinitionVersion(obj, correlationId);
    case CMD_SAVE_MODELS:
      return validateSaveModels(obj, correlationId);
    case CMD_SAVE_GENERAL_SETTINGS:
      return validateSaveGeneralSettings(obj, correlationId);
    case CMD_RETRY_PHASE_NOW:
      return validateRetryPhaseNow(obj, correlationId);
    case CMD_CREATE_QUEUE:
      return validateCreateQueue(obj, correlationId);
    case CMD_RENAME_QUEUE:
      return validateRenameQueue(obj, correlationId);
    case CMD_DELETE_QUEUE:
      return validateDeleteQueue(obj, correlationId);
    case CMD_SAVE_QUEUE_SETTINGS:
      return validateSaveQueueSettings(obj, correlationId);
    case CMD_SET_QUEUE_FAILURE_POLICY:
      return validateSetQueueFailurePolicy(obj, correlationId);
    case CMD_ATTEST_TASK_COMPLETED:
      return validateAttestTaskCompleted(obj, correlationId);
    case CMD_MOVE_TASK:
      return validateMoveTask(obj, correlationId);
    case CMD_MODIFY_TASK:
      return validateModifyTask(obj, correlationId);
    case CMD_REORDER_TASK:
      return validateReorderTask(obj, correlationId);
    case CMD_RESTART_CANCELED_TASK:
      return validateRestartCanceledTask(obj, correlationId);
    case CMD_PAUSE_PHASE:
      return validatePausePhase(obj, correlationId);
    case CMD_RESUME_PHASE:
      return validateResumePhase(obj, correlationId);
    case CMD_RESTART_PHASE:
      return validateRestartPhase(obj, correlationId);
    case CMD_SKIP_PHASE:
      return validateSkipPhase(obj, correlationId);
    case CMD_DISABLE_PHASE:
      return validateDisablePhase(obj, correlationId);
    case CMD_ENABLE_PHASE:
      return validateEnablePhase(obj, correlationId);
    case CMD_REMOVE_TASK_PHASE:
      return validateRemoveTaskPhase(obj, correlationId);
    case CMD_READ_PHASE_LOG:
      return validateReadPhaseLog(obj, correlationId);
    case CMD_START_PHASE_LOG_TAIL:
      return validateStartPhaseLogTail(obj, correlationId);
    case CMD_STOP_PHASE_LOG_TAIL:
      return validateStopPhaseLogTail(obj, correlationId);
    case CMD_ACK_PHASE_LOG_TAIL:
      return validateAckPhaseLogTail(obj, correlationId);
    case CMD_OPEN_VERBOSE_SETTING:
      return validateOpenVerboseSetting(obj, correlationId);
    case CMD_OPEN_TRUST_SETTINGS:
      return validateOpenTrustSettings(obj, correlationId);
    case CMD_RESOLVE_AUDIT_POINTER:
      return validateResolveAuditPointer(obj, correlationId);
    case CMD_RESOLVE_HISTORY_DESCRIPTION:
      return validateResolveHistoryDescription(obj, correlationId);
    case CMD_READ_FAILURE_RECORD:
      return validateReadFailureRecord(obj, correlationId);
    case CMD_OPEN_DECISION_RECORD:
      return validateOpenDecisionRecord(obj, correlationId);
    case CMD_READ_STORAGE_DETAILS:
      return validateReadStorageDetails(obj, correlationId);
    case CMD_READ_USAGE_ACCOUNTING:
      return validateReadUsageAccounting(obj, correlationId);
    case CMD_READ_REPORT:
      return validateReadReport(obj, correlationId);
    case CMD_MUTATE_REPORT:
      return validateMutateReport(obj, correlationId);
    case CMD_READ_EXECUTION_VISIBILITY:
      return validateReadExecutionVisibility(obj, correlationId);
    case CMD_OPEN_CHANGE_REVIEW:
      return validateOpenChangeReview(obj, correlationId);
    case CMD_DECIDE_PHASE_HANDOFF:
      return validateDecidePhaseHandoff(obj, correlationId);
    case CMD_SET_PHASE_BREAKPOINT:
      return validateSetPhaseBreakpoint(obj, correlationId);
    case CMD_CLEAR_PHASE_BREAKPOINT:
      return validateClearPhaseBreakpoint(obj, correlationId);
    case CMD_START_QUEUE:
      return validateStartQueue(obj, correlationId);
    case CMD_READ_METRICS:
      return validateReadMetrics(obj, correlationId);
    case CMD_PING_BACKEND:
      return validatePingBackend(obj, correlationId);
    case CMD_EXPORT_PROCESS_YAML:
      return validateExportProcessYaml(obj, correlationId);
    case CMD_PREFLIGHT_PROCESS_YAML:
      return validatePreflightProcessYaml(obj, correlationId);
    case CMD_LAUNCH_PIPELINE:
      return validateLaunchPipeline(obj, correlationId);
    case CMD_LAUNCH_WORKFLOW:
      return validateLaunchWorkflow(obj, correlationId);
    case CMD_CONTINUE_WORKFLOW:
      return validateContinueWorkflow(obj, correlationId);
    case CMD_SET_UNCONTAINED_BACKEND_GRANT:
      return validateSetUncontainedBackendGrant(obj, correlationId);
    default:
      return fail('unknown-type', { type, correlationId });
  }
}
