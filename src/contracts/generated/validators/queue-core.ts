// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/queue-core.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_CANCEL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_QUEUE,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_PAUSE_QUEUE,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESUME_QUEUE,
  CMD_RETRY_QUEUE_ITEM,
  CMD_START,
  CMD_START_QUEUE,
  type CancelCommand,
  type ClearCompletedCommand,
  type ClearQueueCommand,
  type ModifyTaskCommand,
  type MoveQueueItemDownCommand,
  type MoveQueueItemUpCommand,
  type PauseQueueCommand,
  type RemoveQueueItemCommand,
  type RemoveTaskPhaseCommand,
  type ReorderTaskCommand,
  type RestartCanceledTaskCommand,
  type ResumeQueueCommand,
  type RetryQueueItemCommand,
  type StartCommand,
  type StartQueueCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';
import { isValidEnqueueStartIntent, isValidStartQueueIntent } from '../../start-intent-types';
import type { EnqueueStartIntent, StartQueueIntent } from '../../start-intent-types';

export function validateStart(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_START, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['description', 'pipelineId', 'queueId', 'position', 'startIntent'])) {
    return fail('unexpected-payload-fields', { type: CMD_START, correlationId });
  }
  const validated_descriptionRaw: unknown = validatedObj['description'];
  if (typeof validated_descriptionRaw !== 'string') {
    return fail('description-not-string', { type: CMD_START, correlationId });
  }
  const validated_descriptionTrimmed = validated_descriptionRaw.trim();
  if (validated_descriptionTrimmed.length < 1 || validated_descriptionTrimmed.length > 4096) {
    return fail('description-out-of-range', { type: CMD_START, correlationId });
  }
  const validated_description: string = validated_descriptionTrimmed;
  const validated_pipelineIdRaw: unknown = validatedObj['pipelineId'];
  let validated_pipelineId: string | undefined;
  if (validated_pipelineIdRaw !== undefined) {
    if (typeof validated_pipelineIdRaw !== 'string') {
      return fail('pipelineId-not-string', { type: CMD_START, correlationId });
    }
    const validated_pipelineIdChecked: string = validated_pipelineIdRaw;
    validated_pipelineId = validated_pipelineIdChecked;
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-queueId', { type: CMD_START, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-queueId', { type: CMD_START, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated_positionRaw: unknown = validatedObj['position'];
  let validated_position: number | undefined;
  if (validated_positionRaw !== undefined) {
    if (typeof validated_positionRaw !== 'number' || !Number.isInteger(validated_positionRaw) || validated_positionRaw < 0) {
      return fail('invalid-position', { type: CMD_START, correlationId });
    }
    const validated_positionChecked: number = validated_positionRaw;
    validated_position = validated_positionChecked;
  }
  const validated_startIntentRaw: unknown = validatedObj['startIntent'];
  let validated_startIntent: EnqueueStartIntent | undefined;
  if (validated_startIntentRaw !== undefined) {
    if (!isValidEnqueueStartIntent(validated_startIntentRaw)) {
      return fail('invalid-start-intent', { type: CMD_START, correlationId });
    }
    const validated_startIntentChecked = validated_startIntentRaw;
    validated_startIntent = validated_startIntentChecked;
  }
  const validated = { description: validated_description, ...(validated_pipelineId ? { pipelineId: validated_pipelineId } : {}), ...(validated_queueId ? { queueId: validated_queueId } : {}), ...(validated_position === undefined ? {} : { position: validated_position }), ...(validated_startIntent === undefined ? {} : { startIntent: validated_startIntent }) };
  const command: StartCommand = { type: CMD_START, correlationId, payload: validated };
  return ok(command);
}

export function validateCancel(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_CANCEL, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId'])) {
    return fail('unexpected-payload-fields', { type: CMD_CANCEL, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_CANCEL, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_CANCEL, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated = { taskId: validated_taskId };
  const command: CancelCommand = { type: CMD_CANCEL, correlationId, payload: validated };
  return ok(command);
}

export function validateRemoveQueueItem(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['id', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-id', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 256) {
    return fail('invalid-id', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_confirmedRaw: unknown = validatedObj['confirmed'];
  if (validated_confirmedRaw !== true) {
    return fail('missing-confirmation', { type: CMD_REMOVE_QUEUE_ITEM, correlationId });
  }
  const validated_confirmed = true as const;
  const validated = { id: validated_id, confirmed: validated_confirmed };
  const command: RemoveQueueItemCommand = { type: CMD_REMOVE_QUEUE_ITEM, correlationId, payload: validated };
  return ok(command);
}

export function validateRetryQueueItem(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RETRY_QUEUE_ITEM, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['id'])) {
    return fail('unexpected-payload-fields', { type: CMD_RETRY_QUEUE_ITEM, correlationId });
  }
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-id', { type: CMD_RETRY_QUEUE_ITEM, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 256) {
    return fail('invalid-id', { type: CMD_RETRY_QUEUE_ITEM, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated = { id: validated_id };
  const command: RetryQueueItemCommand = { type: CMD_RETRY_QUEUE_ITEM, correlationId, payload: validated };
  return ok(command);
}

export function validateMoveQueueItemUp(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['id'])) {
    return fail('unexpected-payload-fields', { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId });
  }
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-id', { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 256) {
    return fail('invalid-id', { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated = { id: validated_id };
  const command: MoveQueueItemUpCommand = { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId, payload: validated };
  return ok(command);
}

export function validateMoveQueueItemDown(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['id'])) {
    return fail('unexpected-payload-fields', { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId });
  }
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-id', { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 256) {
    return fail('invalid-id', { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated = { id: validated_id };
  const command: MoveQueueItemDownCommand = { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId, payload: validated };
  return ok(command);
}

export function validatePauseQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === undefined) {
    const command: PauseQueueCommand = { type: CMD_PAUSE_QUEUE, correlationId };
    return ok(command);
  }
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('invalid-payload', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'reason'])) {
    return fail('unexpected-payload-fields', { type: CMD_PAUSE_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-queueId', { type: CMD_PAUSE_QUEUE, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-queueId', { type: CMD_PAUSE_QUEUE, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated_reasonRaw: unknown = validatedObj['reason'];
  let validated_reason: string | undefined;
  if (validated_reasonRaw !== undefined) {
    if (typeof validated_reasonRaw !== 'string') {
      return fail('reason-not-string', { type: CMD_PAUSE_QUEUE, correlationId });
    }
    if (validated_reasonRaw.length > 500) {
      return fail('reason-too-long', { type: CMD_PAUSE_QUEUE, correlationId });
    }
    const validated_reasonChecked: string = validated_reasonRaw;
    validated_reason = validated_reasonChecked;
  }
  const validated = { ...(validated_queueId ? { queueId: validated_queueId } : {}), ...(validated_reason === undefined ? {} : { reason: validated_reason }) };
  const hasAny = Object.keys(validated).length > 0;
  const command: PauseQueueCommand = { type: CMD_PAUSE_QUEUE, correlationId, payload: hasAny ? validated : undefined };
  return ok(command);
}

export function validateResumeQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === undefined) {
    const command: ResumeQueueCommand = { type: CMD_RESUME_QUEUE, correlationId };
    return ok(command);
  }
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('invalid-payload', { type: CMD_RESUME_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESUME_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-queueId', { type: CMD_RESUME_QUEUE, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-queueId', { type: CMD_RESUME_QUEUE, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated = { ...(validated_queueId ? { queueId: validated_queueId } : {}) };
  const hasAny = Object.keys(validated).length > 0;
  const command: ResumeQueueCommand = { type: CMD_RESUME_QUEUE, correlationId, payload: hasAny ? validated : undefined };
  return ok(command);
}

export function validateStartQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === undefined) {
    const command: StartQueueCommand = { type: CMD_START_QUEUE, correlationId, payload: {} };
    return ok(command);
  }
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('invalid-payload', { type: CMD_START_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'startIntent'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-queueId', { type: CMD_START_QUEUE, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-queueId', { type: CMD_START_QUEUE, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated_startIntentRaw: unknown = validatedObj['startIntent'];
  let validated_startIntent: StartQueueIntent | undefined;
  if (validated_startIntentRaw !== undefined) {
    if (!isValidStartQueueIntent(validated_startIntentRaw)) {
      return fail('invalid-start-intent', { type: CMD_START_QUEUE, correlationId });
    }
    const validated_startIntentChecked = validated_startIntentRaw;
    validated_startIntent = validated_startIntentChecked;
  }
  const validated = { ...(validated_queueId ? { queueId: validated_queueId } : {}), ...(validated_startIntent === undefined ? {} : { startIntent: validated_startIntent }) };
  const command: StartQueueCommand = { type: CMD_START_QUEUE, correlationId, payload: validated };
  return ok(command);
}

export function validateClearCompleted(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_CLEAR_COMPLETED, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_CLEAR_COMPLETED, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_CLEAR_COMPLETED, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_CLEAR_COMPLETED, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated = { queueId: validated_queueId };
  const command: ClearCompletedCommand = { type: CMD_CLEAR_COMPLETED, correlationId, payload: validated };
  return ok(command);
}

export function validateClearQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_CLEAR_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_CLEAR_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_CLEAR_QUEUE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_CLEAR_QUEUE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated = { queueId: validated_queueId };
  const command: ClearQueueCommand = { type: CMD_CLEAR_QUEUE, correlationId, payload: validated };
  return ok(command);
}

export function validateModifyTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_MODIFY_TASK, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId', 'description'])) {
    return fail('unexpected-payload-fields', { type: CMD_MODIFY_TASK, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_MODIFY_TASK, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_MODIFY_TASK, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated_descriptionRaw: unknown = validatedObj['description'];
  if (typeof validated_descriptionRaw !== 'string') {
    return fail('description-not-string', { type: CMD_MODIFY_TASK, correlationId });
  }
  const validated_descriptionTrimmed = validated_descriptionRaw.trim();
  if (validated_descriptionTrimmed.length < 1 || validated_descriptionTrimmed.length > 4096) {
    return fail('description-out-of-range', { type: CMD_MODIFY_TASK, correlationId });
  }
  const validated_description: string = validated_descriptionTrimmed;
  const validated = { taskId: validated_taskId, description: validated_description };
  const command: ModifyTaskCommand = { type: CMD_MODIFY_TASK, correlationId, payload: validated };
  return ok(command);
}

export function validateReorderTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_REORDER_TASK, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId', 'newPosition'])) {
    return fail('unexpected-payload-fields', { type: CMD_REORDER_TASK, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_REORDER_TASK, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_REORDER_TASK, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated_newPositionRaw: unknown = validatedObj['newPosition'];
  if (typeof validated_newPositionRaw !== 'number' || !Number.isInteger(validated_newPositionRaw) || validated_newPositionRaw < 0) {
    return fail('invalid-position', { type: CMD_REORDER_TASK, correlationId });
  }
  const validated_newPosition: number = validated_newPositionRaw;
  const validated = { taskId: validated_taskId, newPosition: validated_newPosition };
  const command: ReorderTaskCommand = { type: CMD_REORDER_TASK, correlationId, payload: validated };
  return ok(command);
}

export function validateRestartCanceledTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RESTART_CANCELED_TASK, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESTART_CANCELED_TASK, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_RESTART_CANCELED_TASK, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_RESTART_CANCELED_TASK, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated = { taskId: validated_taskId };
  const command: RestartCanceledTaskCommand = { type: CMD_RESTART_CANCELED_TASK, correlationId, payload: validated };
  return ok(command);
}

export function validateRemoveTaskPhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId', 'phaseId', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated_confirmedRaw: unknown = validatedObj['confirmed'];
  if (validated_confirmedRaw !== true) {
    return fail('missing-confirmation', { type: CMD_REMOVE_TASK_PHASE, correlationId });
  }
  const validated_confirmed = true as const;
  const validated = { taskId: validated_taskId, phaseId: validated_phaseId, confirmed: validated_confirmed };
  const command: RemoveTaskPhaseCommand = { type: CMD_REMOVE_TASK_PHASE, correlationId, payload: validated };
  return ok(command);
}
