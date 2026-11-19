// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/queue-management.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate
//
// Concurrency cap authority: docs/architecture/local-queue-parallelism-ratification.md
// Enforces globalConcurrencyCap in [1, MAX_QUEUES] (MAX_QUEUES defined in src/contracts/queue-bounds.ts).

import {
  CMD_ATTEST_TASK_COMPLETED,
  CMD_CREATE_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_RENAME_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_QUEUE_FAILURE_POLICY,
  type AttestTaskCompletedCommand,
  type CreateQueueCommand,
  type DeleteQueueCommand,
  type MoveTaskCommand,
  type RenameQueueCommand,
  type SaveQueueSettingsCommand,
  type SetQueueFailurePolicyCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';

export function validateCreateQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_CREATE_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['name'])) {
    return fail('unexpected-payload-fields', { type: CMD_CREATE_QUEUE, correlationId });
  }
  const validated_nameRaw: unknown = validatedObj['name'];
  if (typeof validated_nameRaw !== 'string') {
    return fail('invalid-queue-name', { type: CMD_CREATE_QUEUE, correlationId });
  }
  const validated_nameTrimmed = validated_nameRaw.trim();
  if (validated_nameTrimmed.length < 1 || validated_nameTrimmed.length > 64) {
    return fail('invalid-queue-name', { type: CMD_CREATE_QUEUE, correlationId });
  }
  const validated_name: string = validated_nameTrimmed;
  const validated = { name: validated_name };
  const command: CreateQueueCommand = { type: CMD_CREATE_QUEUE, correlationId, payload: validated };
  return ok(command);
}

export function validateRenameQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'name'])) {
    return fail('unexpected-payload-fields', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_RENAME_QUEUE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_nameRaw: unknown = validatedObj['name'];
  if (typeof validated_nameRaw !== 'string') {
    return fail('invalid-queue-name', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const validated_nameTrimmed = validated_nameRaw.trim();
  if (validated_nameTrimmed.length < 1 || validated_nameTrimmed.length > 64) {
    return fail('invalid-queue-name', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const validated_name: string = validated_nameTrimmed;
  const validated = { queueId: validated_queueId, name: validated_name };
  const command: RenameQueueCommand = { type: CMD_RENAME_QUEUE, correlationId, payload: validated };
  return ok(command);
}

export function validateDeleteQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_DELETE_QUEUE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_DELETE_QUEUE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_DELETE_QUEUE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_DELETE_QUEUE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_confirmedRaw: unknown = validatedObj['confirmed'];
  let validated_confirmed: true | undefined;
  if (validated_confirmedRaw !== undefined) {
    if (validated_confirmedRaw !== true) {
      return fail('invalid-confirmation', { type: CMD_DELETE_QUEUE, correlationId });
    }
    const validated_confirmedChecked = true as const;
    validated_confirmed = validated_confirmedChecked;
  }
  const validated = { queueId: validated_queueId, ...(validated_confirmed === true ? { confirmed: true as const } : {}) };
  const command: DeleteQueueCommand = { type: CMD_DELETE_QUEUE, correlationId, payload: validated };
  return ok(command);
}

export function validateSaveQueueSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['globalConcurrencyCap', 'defaultQueueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  const validated_globalConcurrencyCapRaw: unknown = validatedObj['globalConcurrencyCap'];
  if (typeof validated_globalConcurrencyCapRaw !== 'number' || !Number.isInteger(validated_globalConcurrencyCapRaw) || validated_globalConcurrencyCapRaw < 1 || validated_globalConcurrencyCapRaw > 20) {
    return fail('invalid-concurrency-cap', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  const validated_globalConcurrencyCap: number = validated_globalConcurrencyCapRaw;
  const validated_defaultQueueIdRaw: unknown = validatedObj['defaultQueueId'];
  if (typeof validated_defaultQueueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  if (validated_defaultQueueIdRaw.length < 1 || validated_defaultQueueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  const validated_defaultQueueId: string = validated_defaultQueueIdRaw;
  const validated = { globalConcurrencyCap: validated_globalConcurrencyCap, defaultQueueId: validated_defaultQueueId };
  const command: SaveQueueSettingsCommand = { type: CMD_SAVE_QUEUE_SETTINGS, correlationId, payload: validated };
  return ok(command);
}

export function validateSetQueueFailurePolicy(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'policy'])) {
    return fail('unexpected-payload-fields', { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_policyRaw: unknown = validatedObj['policy'];
  let validated_policy: 'halt-on-failure' | 'continue' | null;
  if (validated_policyRaw === null) {
    validated_policy = null;
  } else {
    if (!(validated_policyRaw === 'halt-on-failure' || validated_policyRaw === 'continue')) {
      return fail('invalid-failure-policy', { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId });
    }
    const validated_policyVal: 'halt-on-failure' | 'continue' = validated_policyRaw;
    validated_policy = validated_policyVal;
  }
  const validated = { queueId: validated_queueId, policy: validated_policy };
  const command: SetQueueFailurePolicyCommand = { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId, payload: validated };
  return ok(command);
}

export function validateAttestTaskCompleted(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_ATTEST_TASK_COMPLETED, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId', 'confirmed'])) {
    return fail('unexpected-payload-fields', { type: CMD_ATTEST_TASK_COMPLETED, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_ATTEST_TASK_COMPLETED, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_ATTEST_TASK_COMPLETED, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated_confirmedRaw: unknown = validatedObj['confirmed'];
  if (validated_confirmedRaw !== true) {
    return fail('missing-confirmation', { type: CMD_ATTEST_TASK_COMPLETED, correlationId });
  }
  const validated_confirmed = true as const;
  const validated = { taskId: validated_taskId, confirmed: validated_confirmed };
  const command: AttestTaskCompletedCommand = { type: CMD_ATTEST_TASK_COMPLETED, correlationId, payload: validated };
  return ok(command);
}

export function validateMoveTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_MOVE_TASK, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['taskId', 'targetQueueId', 'position'])) {
    return fail('unexpected-payload-fields', { type: CMD_MOVE_TASK, correlationId });
  }
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (typeof validated_taskIdRaw !== 'string') {
    return fail('invalid-taskId', { type: CMD_MOVE_TASK, correlationId });
  }
  if (validated_taskIdRaw.length < 1 || validated_taskIdRaw.length > 256) {
    return fail('invalid-taskId', { type: CMD_MOVE_TASK, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated_targetQueueIdRaw: unknown = validatedObj['targetQueueId'];
  if (typeof validated_targetQueueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_MOVE_TASK, correlationId });
  }
  if (validated_targetQueueIdRaw.length < 1 || validated_targetQueueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_MOVE_TASK, correlationId });
  }
  const validated_targetQueueId: string = validated_targetQueueIdRaw;
  const validated_positionRaw: unknown = validatedObj['position'];
  let validated_position: number | undefined;
  if (validated_positionRaw !== undefined) {
    if (typeof validated_positionRaw !== 'number' || !Number.isInteger(validated_positionRaw) || validated_positionRaw < 0) {
      return fail('invalid-position', { type: CMD_MOVE_TASK, correlationId });
    }
    const validated_positionChecked: number = validated_positionRaw;
    validated_position = validated_positionChecked;
  }
  const validated = { taskId: validated_taskId, targetQueueId: validated_targetQueueId, ...(validated_position === undefined ? {} : { position: validated_position }) };
  const command: MoveTaskCommand = { type: CMD_MOVE_TASK, correlationId, payload: validated };
  return ok(command);
}
