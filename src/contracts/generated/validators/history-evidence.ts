// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/history-evidence.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_OPEN_DECISION_RECORD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_READ_FAILURE_RECORD,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESOLVE_AUDIT_POINTER,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  type OpenDecisionRecordCommand,
  type OpenHistoryItemDetailsCommand,
  type ReadFailureRecordCommand,
  type RerunFromHistoryCommand,
  type ResolveAuditPointerCommand,
  type ResolveHistoryDescriptionCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
function isRecordIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && RECORD_ID_PATTERN.test(value);
}

export function validateRerunFromHistory(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RERUN_FROM_HISTORY, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['runId', 'force'])) {
    return fail('unexpected-payload-fields', { type: CMD_RERUN_FROM_HISTORY, correlationId });
  }
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_RERUN_FROM_HISTORY, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_RERUN_FROM_HISTORY, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated_forceRaw: unknown = validatedObj['force'];
  let validated_force: boolean | undefined;
  if (validated_forceRaw !== undefined) {
    if (typeof validated_forceRaw !== 'boolean') {
      return fail('force-not-boolean', { type: CMD_RERUN_FROM_HISTORY, correlationId });
    }
    const validated_forceChecked: boolean = validated_forceRaw;
    validated_force = validated_forceChecked;
  }
  const validated = { runId: validated_runId, ...(validated_force === true ? { force: true as const } : {}) };
  const command: RerunFromHistoryCommand = { type: CMD_RERUN_FROM_HISTORY, correlationId, payload: validated };
  return ok(command);
}

export function validateOpenHistoryItemDetails(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_OPEN_HISTORY_ITEM_DETAILS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['id'])) {
    return fail('unexpected-payload-fields', { type: CMD_OPEN_HISTORY_ITEM_DETAILS, correlationId });
  }
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-id', { type: CMD_OPEN_HISTORY_ITEM_DETAILS, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 256) {
    return fail('invalid-id', { type: CMD_OPEN_HISTORY_ITEM_DETAILS, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated = { id: validated_id };
  const command: OpenHistoryItemDetailsCommand = { type: CMD_OPEN_HISTORY_ITEM_DETAILS, correlationId, payload: validated };
  return ok(command);
}

export function validateResolveAuditPointer(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['runId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated = { runId: validated_runId };
  const command: ResolveAuditPointerCommand = { type: CMD_RESOLVE_AUDIT_POINTER, correlationId, payload: validated };
  return ok(command);
}

export function validateResolveHistoryDescription(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['runId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated = { runId: validated_runId };
  const command: ResolveHistoryDescriptionCommand = { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId, payload: validated };
  return ok(command);
}

export function validateReadFailureRecord(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_FAILURE_RECORD, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'taskId'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_FAILURE_RECORD, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (!isRecordIdentifier(validated_queueIdRaw)) {
    return fail('invalid-queueId', { type: CMD_READ_FAILURE_RECORD, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_taskIdRaw: unknown = validatedObj['taskId'];
  if (!isRecordIdentifier(validated_taskIdRaw)) {
    return fail('invalid-taskId', { type: CMD_READ_FAILURE_RECORD, correlationId });
  }
  const validated_taskId: string = validated_taskIdRaw;
  const validated = { queueId: validated_queueId, taskId: validated_taskId };
  const command: ReadFailureRecordCommand = { type: CMD_READ_FAILURE_RECORD, correlationId, payload: validated };
  return ok(command);
}

export function validateOpenDecisionRecord(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_OPEN_DECISION_RECORD, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['rowId'])) {
    return fail('unexpected-payload-fields', { type: CMD_OPEN_DECISION_RECORD, correlationId });
  }
  const validated_rowIdRaw: unknown = validatedObj['rowId'];
  if (!isRecordIdentifier(validated_rowIdRaw)) {
    return fail('invalid-rowId', { type: CMD_OPEN_DECISION_RECORD, correlationId });
  }
  const validated_rowId: string = validated_rowIdRaw;
  const validated = { rowId: validated_rowId };
  const command: OpenDecisionRecordCommand = { type: CMD_OPEN_DECISION_RECORD, correlationId, payload: validated };
  return ok(command);
}
