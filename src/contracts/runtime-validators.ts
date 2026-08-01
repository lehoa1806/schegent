// Authoritative runtime validators for inbound webview→host IPC messages.
//
// Feature 013 — Wave 5 (US5): this file is the SINGLE source of truth for
// the `validateInboundMessage` helper and its private validators. The
// sidebar shim at `src/ui/sidebar/ipc-validator.ts` is a thin re-export
// of this module. The lint test at
// `tests/lint/no-duplicate-ipc-validators.test.ts` guards against drift.
//
// Validator scope: each validator covers exactly one command literal from
// `COMMAND_TYPES` (defined in the authoritative IPC contract module
// `src/contracts/sidebar-ipc.ts`). Cross-context payload validation
// (e.g., pipelines, phases) intentionally validates only the structural
// shape at the IPC boundary; downstream host code (e.g., the workspace
// settings writer) re-validates against typed allowlists.

import {
  CMD_CANCEL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_OPEN_QUEUE_ITEM_DETAILS,
  CMD_PAUSE_QUEUE,
  CMD_REMOVE_TASK_PHASE,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESET,
  CMD_RESUME,
  CMD_RESUME_QUEUE,
  CMD_RETRY_ACTIVE_RUN,
  CMD_RETRY_QUEUE_ITEM,
  CMD_START,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_PHASES,
  CMD_SAVE_MODELS,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_RETRY_PHASE_NOW,
  CMD_SAVE_WAKEUP_SETTINGS,
  CMD_WAKE_UP_NOW,
  CMD_PAUSE_PHASE,
  CMD_PING_BACKEND,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_OPEN_VERBOSE_SETTING,
  // Feature 030 — single-queue mode dropped CMD_CREATE_QUEUE,
  // CMD_RENAME_QUEUE, CMD_DELETE_QUEUE, CMD_SAVE_QUEUE_SETTINGS,
  // CMD_MOVE_TASK, CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE.
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_READ_PHASE_LOG,
  CMD_READ_WAKEUP_SESSION_LOG,
  CMD_REVEAL_WAKEUP_SESSION_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_START_QUEUE, CMD_READ_METRICS,
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_DISMISS_MIGRATION_NOTICE,
  type SidebarCommand
} from './sidebar-ipc';
import { isValidEnqueueStartIntent } from './start-intent-types';
import {
  validateReadPhaseLog,
  validateStartPhaseLogTail,
  validateStopPhaseLogTail
} from './validators/phase-log';
import { validateReadMetrics } from './validators/metrics';
import { validateSetConfirmSuppression, validateStartQueue } from './validators/queue';
import {
  validateReadWakeupSessionLog,
  validateRevealWakeupSessionLog,
  validateSaveWakeUpSettings
} from './validators/wakeup';
import {
  CORRELATION_ID_MAX,
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationResult
} from './validators/shared';

export { isValidReadMetricsResponse } from './validators/metrics';
export type { IpcValidationError, IpcValidationResult } from './validators/shared';

const DESCRIPTION_MAX = 4096;
// Feature 013 — US4 (FR-016): mirror the projector cap so payloads
// produced by the projector are guaranteed to validate. The projector
// at state-projector.ts:PAUSED_REASON_MAX_LENGTH writes ≤500 chars to
// host→webview snapshots; this validator enforces the same cap on the
// inverse webview→host direction (operator-typed pause reason).
const PAUSED_REASON_MAX_LENGTH = 500;

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

  switch (type) {
    case CMD_START:
      return validateStart(obj, correlationId);
    case CMD_CANCEL:
      // Feature 017 — BUG-001: CMD_CANCEL carries the operator's intended
      // target taskId so the host resolves the run by FeatureRequest.id
      // instead of via the singular `store.getRun()` projection.
      return validateTaskIdPayload(CMD_CANCEL, obj, correlationId);
    case CMD_RESUME:
      return validateNoPayload(CMD_RESUME, obj, correlationId);
    case CMD_RESET:
      return validateReset(obj, correlationId);
    case CMD_REMOVE_QUEUE_ITEM:
      return validateConfirmedRemoveQueueItem(obj, correlationId);
    case CMD_OPEN_AUDIT_LOG:
      return validateNoPayload(CMD_OPEN_AUDIT_LOG, obj, correlationId);
    case CMD_RETRY_QUEUE_ITEM:
      return validateIdPayload(CMD_RETRY_QUEUE_ITEM, obj, correlationId);
    case CMD_MOVE_QUEUE_ITEM_UP:
      return validateIdPayload(CMD_MOVE_QUEUE_ITEM_UP, obj, correlationId);
    case CMD_MOVE_QUEUE_ITEM_DOWN:
      return validateIdPayload(CMD_MOVE_QUEUE_ITEM_DOWN, obj, correlationId);
    case CMD_OPEN_QUEUE_ITEM_DETAILS:
      return validateIdPayload(CMD_OPEN_QUEUE_ITEM_DETAILS, obj, correlationId);
    case CMD_OPEN_HISTORY_ITEM_DETAILS:
      return validateIdPayload(CMD_OPEN_HISTORY_ITEM_DETAILS, obj, correlationId);
    case CMD_RERUN_FROM_HISTORY:
      return validateRunIdPayload(CMD_RERUN_FROM_HISTORY, obj, correlationId);
    case CMD_PAUSE_QUEUE:
      return validatePauseQueue(obj, correlationId);
    case CMD_RESUME_QUEUE:
      return validateResumeQueue(obj, correlationId);
    case CMD_CLEAR_COMPLETED:
      return validateNoPayload(CMD_CLEAR_COMPLETED, obj, correlationId);
    case CMD_CLEAR_FAILED:
      return validateNoPayload(CMD_CLEAR_FAILED, obj, correlationId);
    case CMD_CLEAR_ALL:
      return validateOptionalEmptyPayload(CMD_CLEAR_ALL, obj, correlationId);
    case CMD_SET_CONFIRM_SUPPRESSION:
      return validateSetConfirmSuppression(obj, correlationId);
    case CMD_DISMISS_MIGRATION_NOTICE:
      // Feature 065 (T054a / FR-020). No payload — the empty discriminator
      // is enough; the host idempotency-guards the flip to 'dismissed'.
      return validateNoPayload(CMD_DISMISS_MIGRATION_NOTICE, obj, correlationId);
    case CMD_OPEN_DASHBOARD:
      return validateNoPayload(CMD_OPEN_DASHBOARD, obj, correlationId);
    case CMD_RETRY_ACTIVE_RUN:
      return validateNoPayload(CMD_RETRY_ACTIVE_RUN, obj, correlationId);
    case CMD_SAVE_PIPELINES:
      return validateSavePipelines(obj, correlationId);
    case CMD_SAVE_PHASES:
      return validateSavePhases(obj, correlationId);
    case CMD_SAVE_MODELS:
      return validateSaveModels(obj, correlationId);
    case CMD_SAVE_GENERAL_SETTINGS:
      return validateSaveGeneralSettings(obj, correlationId);
    case CMD_RETRY_PHASE_NOW:
      return validateNoPayload(CMD_RETRY_PHASE_NOW, obj, correlationId);
    case CMD_SAVE_WAKEUP_SETTINGS:
      return validateSaveWakeUpSettings(obj, correlationId);
    case CMD_WAKE_UP_NOW:
      return validateWakeUpNow(obj, correlationId);
    // Feature 030 — single-queue mode: validators for CMD_CREATE_QUEUE,
    // CMD_RENAME_QUEUE, CMD_DELETE_QUEUE, CMD_SAVE_QUEUE_SETTINGS,
    // CMD_MOVE_TASK, CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE
    // removed because the commands no longer exist.
    case CMD_MODIFY_TASK:
      return validateModifyTask(obj, correlationId);
    case CMD_REORDER_TASK:
      return validateReorderTask(obj, correlationId);
    case CMD_RESTART_CANCELED_TASK:
      return validateTaskIdPayload(CMD_RESTART_CANCELED_TASK, obj, correlationId);
    case CMD_PAUSE_PHASE:
      return validateNoPayload(CMD_PAUSE_PHASE, obj, correlationId);
    case CMD_RESUME_PHASE:
      return validateNoPayload(CMD_RESUME_PHASE, obj, correlationId);
    case CMD_RESTART_PHASE:
      return validatePhaseIdPayload(CMD_RESTART_PHASE, obj, correlationId);
    case CMD_SKIP_PHASE:
      return validatePhaseIdPayload(CMD_SKIP_PHASE, obj, correlationId);
    case CMD_DISABLE_PHASE:
      return validatePhaseIdPayload(CMD_DISABLE_PHASE, obj, correlationId);
    case CMD_ENABLE_PHASE:
      return validatePhaseIdPayload(CMD_ENABLE_PHASE, obj, correlationId);
    case CMD_REMOVE_TASK_PHASE:
      return validateRemoveTaskPhase(obj, correlationId);
    case CMD_READ_PHASE_LOG:
      return validateReadPhaseLog(obj, correlationId);
    case CMD_READ_WAKEUP_SESSION_LOG:
      return validateReadWakeupSessionLog(obj, correlationId);
    case CMD_REVEAL_WAKEUP_SESSION_LOG:
      return validateRevealWakeupSessionLog(obj, correlationId);
    case CMD_START_PHASE_LOG_TAIL:
      return validateStartPhaseLogTail(obj, correlationId);
    case CMD_STOP_PHASE_LOG_TAIL:
      return validateStopPhaseLogTail(obj, correlationId);
    case CMD_OPEN_VERBOSE_SETTING:
      return validateNoPayload(CMD_OPEN_VERBOSE_SETTING, obj, correlationId);
    case CMD_SET_PHASE_BREAKPOINT:
      return validatePhaseBreakpointPayload(CMD_SET_PHASE_BREAKPOINT, obj, correlationId);
    case CMD_CLEAR_PHASE_BREAKPOINT:
      return validatePhaseBreakpointPayload(CMD_CLEAR_PHASE_BREAKPOINT, obj, correlationId);
    // Feature 065 (BUG-002 / FR-012a) — start-queue accepts no payload,
    // an empty `{}`, or `{ startIntent: StartQueueIntent }`. The empty
    // forms preserve the feature 020 / FR-012a legacy semantic.
    case CMD_START_QUEUE:
      return validateStartQueue(obj, correlationId);
    case CMD_READ_METRICS:
      return validateReadMetrics(obj, correlationId);
    case CMD_PING_BACKEND:
      return validatePingBackend(obj, correlationId);
    default:
      return fail('unknown-type', { type, correlationId });
  }
}

function validatePingBackend(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_PING_BACKEND, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['runner'])) {
    return fail('unexpected-payload-fields', { type: CMD_PING_BACKEND, correlationId });
  }
  const runner = p['runner'];
  if (runner !== 'claude' && runner !== 'codex' && runner !== 'agy') {
    return fail('invalid-runner', { type: CMD_PING_BACKEND, correlationId });
  }
  return ok({ type: CMD_PING_BACKEND, correlationId, payload: { runner } });
}

function validateStart(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_START, correlationId });
  }
  const p = payload as Record<string, unknown>;
  // BUG-002 (Feature 065) — `startIntent` is an optional payload field;
  // shape is validated below via `isValidEnqueueStartIntent`. Keep this
  // allowlist in lockstep with the `isCmdStart` predicate in
  // `sidebar-ipc.ts`.
  if (hasUnexpectedKeys(p, ['description', 'pipelineId', 'queueId', 'position', 'startIntent'])) {
    return fail('unexpected-payload-fields', { type: CMD_START, correlationId });
  }
  const description = p['description'];
  if (typeof description !== 'string') {
    return fail('description-not-string', { type: CMD_START, correlationId });
  }
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed.length > DESCRIPTION_MAX) {
    return fail('description-out-of-range', { type: CMD_START, correlationId });
  }
  const pipelineId = p['pipelineId'];
  if (pipelineId !== undefined && typeof pipelineId !== 'string') {
    return fail('pipelineId-not-string', { type: CMD_START, correlationId });
  }
  const queueId = p['queueId'];
  if (
    queueId !== undefined &&
    (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX)
  ) {
    return fail('invalid-queueId', { type: CMD_START, correlationId });
  }
  const position = p['position'];
  if (
    position !== undefined &&
    (typeof position !== 'number' || !Number.isInteger(position) || position < 0)
  ) {
    return fail('invalid-position', { type: CMD_START, correlationId });
  }
  const startIntent = p['startIntent'];
  if (startIntent !== undefined && !isValidEnqueueStartIntent(startIntent)) {
    return fail('invalid-start-intent', { type: CMD_START, correlationId });
  }
  return ok({
    type: CMD_START,
    correlationId,
    payload: {
      description: trimmed,
      ...(pipelineId ? { pipelineId } : {}),
      ...(queueId ? { queueId } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(startIntent !== undefined ? { startIntent } : {})
    }
  });
}

function validateReset(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_RESET, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESET, correlationId });
  }
  if (p['confirmed'] !== true) {
    return fail('reset-not-confirmed', { type: CMD_RESET, correlationId });
  }
  return ok({ type: CMD_RESET, correlationId, payload: { confirmed: true } });
}

type IdCommandType =
  | typeof CMD_RETRY_QUEUE_ITEM
  | typeof CMD_MOVE_QUEUE_ITEM_UP
  | typeof CMD_MOVE_QUEUE_ITEM_DOWN
  | typeof CMD_OPEN_QUEUE_ITEM_DETAILS
  | typeof CMD_OPEN_HISTORY_ITEM_DETAILS;

function validateIdPayload(type: IdCommandType, obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['id'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const id = p['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > QUEUE_ID_MAX) {
    return fail('invalid-id', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { id } } as SidebarCommand);
}

function validateConfirmedRemoveQueueItem(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['id', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const id = p['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > QUEUE_ID_MAX) {
    return fail('invalid-id', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  if (p['confirmed'] !== true) {
    return fail('missing-confirmation', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  return ok({ type: CMD_REMOVE_QUEUE_ITEM, correlationId, payload: { id, confirmed: true } });
}

function validateRemoveTaskPhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['taskId', 'phaseId', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const taskId = p['taskId'];
  const phaseId = p['phaseId'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > QUEUE_ID_MAX) {
    return fail('invalid-taskId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
    return fail('invalid-phaseId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  if (p['confirmed'] !== true) {
    return fail('missing-confirmation', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  return ok({
    type: CMD_REMOVE_TASK_PHASE,
    correlationId,
    payload: { taskId, phaseId, confirmed: true }
  });
}

function validateRunIdPayload(
  type: typeof CMD_RERUN_FROM_HISTORY,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  // Feature 013 — Wave 6 (US6, FR-031): `force` is an optional boolean
  // operator opt-in for replaying legacy entries with the truncated
  // preview. Defaults to `false` (refuse with warning) when absent.
  if (hasUnexpectedKeys(p, ['runId', 'force'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const runId = p['runId'];
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > QUEUE_ID_MAX) {
    return fail('invalid-runId', { type, correlationId });
  }
  const force = p['force'];
  if (force !== undefined && typeof force !== 'boolean') {
    return fail('force-not-boolean', { type, correlationId });
  }
  return ok({
    type,
    correlationId,
    payload: { runId, ...(force === true ? { force: true } : {}) }
  } as SidebarCommand);
}

function validatePauseQueue(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === undefined) {
    return ok({ type: CMD_PAUSE_QUEUE, correlationId } as SidebarCommand);
  }
  if (payload === null || typeof payload !== 'object') {
    return fail('invalid-payload', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId', 'reason'])) {
    return fail('unexpected-payload-fields', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  const queueId = p['queueId'];
  if (
    queueId !== undefined &&
    (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX)
  ) {
    return fail('invalid-queueId', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  const reason = p['reason'];
  if (reason !== undefined && typeof reason !== 'string') {
    return fail('reason-not-string', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  if (typeof reason === 'string' && reason.length > PAUSED_REASON_MAX_LENGTH) {
    return fail('reason-too-long', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  return ok({
    type: CMD_PAUSE_QUEUE,
    correlationId,
    payload:
      queueId !== undefined || reason !== undefined
        ? { ...(queueId ? { queueId } : {}), ...(reason !== undefined ? { reason } : {}) }
        : undefined
  } as SidebarCommand);
}

function validateResumeQueue(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === undefined) {
    return ok({ type: CMD_RESUME_QUEUE, correlationId } as SidebarCommand);
  }
  if (payload === null || typeof payload !== 'object') {
    return fail('invalid-payload', { type: CMD_RESUME_QUEUE, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESUME_QUEUE, correlationId });
  }
  const queueId = p['queueId'];
  if (
    queueId !== undefined &&
    (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX)
  ) {
    return fail('invalid-queueId', { type: CMD_RESUME_QUEUE, correlationId });
  }
  return ok({
    type: CMD_RESUME_QUEUE,
    correlationId,
    payload: queueId ? { queueId } : undefined
  } as SidebarCommand);
}

type NoPayloadType =
  | typeof CMD_RESUME
  | typeof CMD_OPEN_AUDIT_LOG
  | typeof CMD_CLEAR_COMPLETED
  | typeof CMD_CLEAR_FAILED
  | typeof CMD_OPEN_DASHBOARD
  | typeof CMD_RETRY_ACTIVE_RUN
  | typeof CMD_RETRY_PHASE_NOW
  | typeof CMD_PAUSE_PHASE
  | typeof CMD_RESUME_PHASE
  | typeof CMD_OPEN_VERBOSE_SETTING
  | typeof CMD_DISMISS_MIGRATION_NOTICE;

// Feature 017 — BUG-001. Both CMD_CANCEL and CMD_RESTART_CANCELED_TASK
// carry a single `taskId: string` payload.
type TaskIdCommandType = typeof CMD_CANCEL | typeof CMD_RESTART_CANCELED_TASK;

function validateTaskIdPayload(
  type: TaskIdCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['taskId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const taskId = p['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > QUEUE_ID_MAX) {
    return fail('invalid-taskId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { taskId } } as SidebarCommand);
}

function validateNoPayload(
  type: NoPayloadType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type, correlationId });
  }
  return ok({ type, correlationId } as SidebarCommand);
}

// Feature 014 — CMD_WAKE_UP_NOW accepts either no payload or an empty
// object `{}` (the webview sends `payload: {}`). Rejects any non-empty
// payload.
function validateWakeUpNow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === undefined) {
    return ok({ type: CMD_WAKE_UP_NOW, correlationId } as SidebarCommand);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('invalid-payload', { type: CMD_WAKE_UP_NOW, correlationId });
  }
  if (Object.keys(payload as object).length !== 0) {
    return fail('unexpected-payload-fields', { type: CMD_WAKE_UP_NOW, correlationId });
  }
  return ok({ type: CMD_WAKE_UP_NOW, correlationId, payload: {} } as SidebarCommand);
}

// Feature 017 — phase-control commands that carry a single `phaseId` string.
type PhaseIdCommandType =
  | typeof CMD_RESTART_PHASE
  | typeof CMD_SKIP_PHASE
  | typeof CMD_DISABLE_PHASE
  | typeof CMD_ENABLE_PHASE;

function validatePhaseIdPayload(
  type: PhaseIdCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['phaseId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const phaseId = p['phaseId'];
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
    return fail('invalid-phaseId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { phaseId } } as SidebarCommand);
}

// Feature 028 — phase breakpoint commands carry `{ runId, phaseId }`.
type PhaseBreakpointCommandType =
  | typeof CMD_SET_PHASE_BREAKPOINT
  | typeof CMD_CLEAR_PHASE_BREAKPOINT;

function validatePhaseBreakpointPayload(
  type: PhaseBreakpointCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['runId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const runId = p['runId'];
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > QUEUE_ID_MAX) {
    return fail('invalid-runId', { type, correlationId });
  }
  const phaseId = p['phaseId'];
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
    return fail('invalid-phaseId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { runId, phaseId } } as SidebarCommand);
}

function validateSavePipelines(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_PIPELINES, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.pipelines)) {
    return fail('invalid-payload', { type: CMD_SAVE_PIPELINES, correlationId });
  }
  return ok({ type: CMD_SAVE_PIPELINES, correlationId, payload: { pipelines: p.pipelines } } as SidebarCommand);
}

function validateSavePhases(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_PHASES, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.phases)) {
    return fail('invalid-payload', { type: CMD_SAVE_PHASES, correlationId });
  }
  return ok({ type: CMD_SAVE_PHASES, correlationId, payload: { phases: p.phases } } as SidebarCommand);
}

function validateSaveModels(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_MODELS, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.models)) {
    return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
  }
  for (const v of p.models) {
    if (typeof v !== 'string' || v.length === 0) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
  }
  return ok({ type: CMD_SAVE_MODELS, correlationId, payload: { models: p.models } } as SidebarCommand);
}

// Feature 011 — CMD_SAVE_GENERAL_SETTINGS payload contract.
// Keys are unprefixed (host adds the `schegent.` prefix). Per-key allowlist
// and type validation happen in the host router (out-of-scope for IPC
// shape validation; this validator only confirms the basic object shape).
function validateSaveGeneralSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['updates'])) {
    return fail('unexpected-payload-fields', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  const updates = p['updates'];
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    return fail('invalid-updates', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  return ok({
    type: CMD_SAVE_GENERAL_SETTINGS,
    correlationId,
    payload: { updates: updates as Record<string, unknown> }
  } as SidebarCommand);
}

// Feature 030 — single-queue mode: validators for CMD_CREATE_QUEUE,
// CMD_RENAME_QUEUE, CMD_DELETE_QUEUE, CMD_SAVE_QUEUE_SETTINGS removed
// because the commands no longer exist.

function validateModifyTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_MODIFY_TASK, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['taskId', 'description'])) {
    return fail('unexpected-payload-fields', { type: CMD_MODIFY_TASK, correlationId });
  }
  const taskId = p['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > QUEUE_ID_MAX) {
    return fail('invalid-taskId', { type: CMD_MODIFY_TASK, correlationId });
  }
  const description = p['description'];
  if (typeof description !== 'string') {
    return fail('description-not-string', { type: CMD_MODIFY_TASK, correlationId });
  }
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed.length > DESCRIPTION_MAX) {
    return fail('description-out-of-range', { type: CMD_MODIFY_TASK, correlationId });
  }
  return ok({
    type: CMD_MODIFY_TASK,
    correlationId,
    payload: { taskId, description: trimmed }
  } as SidebarCommand);
}

function validateReorderTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_REORDER_TASK, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['taskId', 'newPosition'])) {
    return fail('unexpected-payload-fields', { type: CMD_REORDER_TASK, correlationId });
  }
  const taskId = p['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > QUEUE_ID_MAX) {
    return fail('invalid-taskId', { type: CMD_REORDER_TASK, correlationId });
  }
  const newPosition = p['newPosition'];
  if (typeof newPosition !== 'number' || !Number.isInteger(newPosition) || newPosition < 0) {
    return fail('invalid-position', { type: CMD_REORDER_TASK, correlationId });
  }
  return ok({
    type: CMD_REORDER_TASK,
    correlationId,
    payload: { taskId, newPosition }
  } as SidebarCommand);
}

// Feature 030 — single-queue mode: validators for CMD_MOVE_TASK,
// CMD_SET_QUEUE_SCHEDULE, CMD_CLEAR_QUEUE_SCHEDULE removed because the
// commands no longer exist.

// BUG-002 (FR-012a) — generic validator for commands that accept either
// no payload at all or an empty object `{}`. Shared by feature 020's
// legacy CMD_START_QUEUE consumers (no longer routed through this fn,
// kept for CMD_CLEAR_ALL) and structurally identical to the inline
// pattern in validateWakeUpNow.
function validateOptionalEmptyPayload(
  type: string,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload !== undefined) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return fail('invalid-payload', { type, correlationId });
    }
    if (Object.keys(payload).length > 0) {
      return fail('unexpected-payload-fields', { type, correlationId });
    }
  }
  return ok({ type, correlationId, payload: {} } as SidebarCommand);
}
