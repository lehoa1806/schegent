// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/phase-log.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  type AckPhaseLogTailCommand,
  type ReadPhaseLogCommand,
  type StartPhaseLogTailCommand,
  type StopPhaseLogTailCommand
} from '../../sidebar-ipc';
import { fail, isSafePathSegment, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export function validateReadPhaseLog(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['selection'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selectionRaw: unknown = validatedObj['selection'];
  if (validated_selectionRaw === null || typeof validated_selectionRaw !== 'object') {
    return fail('invalid-selection', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selectionObj = validated_selectionRaw as Record<string, unknown>;
  if (hasUnexpectedKeys(validated_selectionObj, ['queueId', 'taskId', 'pipelineId', 'phaseId', 'iterationN'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selection_queueIdRaw: unknown = validated_selectionObj['queueId'];
  if (!isSafePathSegment(validated_selection_queueIdRaw)) {
    return fail('invalid-queueId', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selection_queueId: string = validated_selection_queueIdRaw;
  const validated_selection_taskIdRaw: unknown = validated_selectionObj['taskId'];
  if (!isSafePathSegment(validated_selection_taskIdRaw)) {
    return fail('invalid-taskId', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selection_taskId: string = validated_selection_taskIdRaw;
  const validated_selection_pipelineIdRaw: unknown = validated_selectionObj['pipelineId'];
  if (!isSafePathSegment(validated_selection_pipelineIdRaw)) {
    return fail('invalid-pipelineId', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selection_pipelineId: string = validated_selection_pipelineIdRaw;
  const validated_selection_phaseIdRaw: unknown = validated_selectionObj['phaseId'];
  if (!isSafePathSegment(validated_selection_phaseIdRaw)) {
    return fail('invalid-phaseId', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const validated_selection_phaseId: string = validated_selection_phaseIdRaw;
  const validated_selection_iterationNRaw: unknown = validated_selectionObj['iterationN'];
  let validated_selection_iterationN: number | null;
  if (validated_selection_iterationNRaw === null || validated_selection_iterationNRaw === undefined) {
    validated_selection_iterationN = null;
  } else {
    if (typeof validated_selection_iterationNRaw !== 'number' || !Number.isInteger(validated_selection_iterationNRaw) || validated_selection_iterationNRaw < 1) {
      return fail('invalid-iterationN', { type: CMD_READ_PHASE_LOG, correlationId });
    }
    const validated_selection_iterationNNum: number = validated_selection_iterationNRaw;
    validated_selection_iterationN = validated_selection_iterationNNum;
  }
  const validated_selection = { queueId: validated_selection_queueId, taskId: validated_selection_taskId, pipelineId: validated_selection_pipelineId, phaseId: validated_selection_phaseId, iterationN: validated_selection_iterationN };
  const validated = { selection: validated_selection };
  const command: ReadPhaseLogCommand = { type: CMD_READ_PHASE_LOG, correlationId, payload: validated };
  return ok(command);
}

export function validateStartPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['selection', 'consumer', 'fromCursor'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selectionRaw: unknown = validatedObj['selection'];
  if (validated_selectionRaw === null || typeof validated_selectionRaw !== 'object') {
    return fail('invalid-selection', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selectionObj = validated_selectionRaw as Record<string, unknown>;
  if (hasUnexpectedKeys(validated_selectionObj, ['queueId', 'taskId', 'pipelineId', 'phaseId', 'iterationN'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_queueIdRaw: unknown = validated_selectionObj['queueId'];
  if (!isSafePathSegment(validated_selection_queueIdRaw)) {
    return fail('invalid-queueId', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_queueId: string = validated_selection_queueIdRaw;
  const validated_selection_taskIdRaw: unknown = validated_selectionObj['taskId'];
  if (!isSafePathSegment(validated_selection_taskIdRaw)) {
    return fail('invalid-taskId', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_taskId: string = validated_selection_taskIdRaw;
  const validated_selection_pipelineIdRaw: unknown = validated_selectionObj['pipelineId'];
  if (!isSafePathSegment(validated_selection_pipelineIdRaw)) {
    return fail('invalid-pipelineId', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_pipelineId: string = validated_selection_pipelineIdRaw;
  const validated_selection_phaseIdRaw: unknown = validated_selectionObj['phaseId'];
  if (!isSafePathSegment(validated_selection_phaseIdRaw)) {
    return fail('invalid-phaseId', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_phaseId: string = validated_selection_phaseIdRaw;
  const validated_selection_iterationNRaw: unknown = validated_selectionObj['iterationN'];
  if (typeof validated_selection_iterationNRaw !== 'number' || !Number.isInteger(validated_selection_iterationNRaw) || validated_selection_iterationNRaw < 1) {
    return fail('invalid-iterationN', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const validated_selection_iterationN: number = validated_selection_iterationNRaw;
  const validated_selection = { queueId: validated_selection_queueId, taskId: validated_selection_taskId, pipelineId: validated_selection_pipelineId, phaseId: validated_selection_phaseId, iterationN: validated_selection_iterationN };
  const validated_consumerRaw: unknown = validatedObj['consumer'];
  let validated_consumer: string | undefined;
  if (validated_consumerRaw !== undefined) {
    if (typeof validated_consumerRaw !== 'string') {
      return fail('invalid-consumer', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
    }
    if (validated_consumerRaw.length < 1 || validated_consumerRaw.length > 64) {
      return fail('invalid-consumer', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
    }
    const validated_consumerChecked: string = validated_consumerRaw;
    validated_consumer = validated_consumerChecked;
  }
  const validated_fromCursorRaw: unknown = validatedObj['fromCursor'];
  let validated_fromCursor: string | undefined;
  if (validated_fromCursorRaw !== undefined) {
    if (typeof validated_fromCursorRaw !== 'string') {
      return fail('invalid-fromCursor', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
    }
    if (validated_fromCursorRaw.length < 1 || validated_fromCursorRaw.length > 160 || !PRINTABLE_ASCII.test(validated_fromCursorRaw)) {
      return fail('invalid-fromCursor', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
    }
    const validated_fromCursorChecked: string = validated_fromCursorRaw;
    validated_fromCursor = validated_fromCursorChecked;
  }
  const validated = { selection: validated_selection, ...(validated_consumer === undefined ? {} : { consumer: validated_consumer }), ...(validated_fromCursor === undefined ? {} : { fromCursor: validated_fromCursor }) };
  const command: StartPhaseLogTailCommand = { type: CMD_START_PHASE_LOG_TAIL, correlationId, payload: validated };
  return ok(command);
}

export function validateStopPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['sessionId'])) {
    return fail('unexpected-payload-fields', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  const validated_sessionIdRaw: unknown = validatedObj['sessionId'];
  if (typeof validated_sessionIdRaw !== 'string') {
    return fail('invalid-sessionId', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  if (validated_sessionIdRaw.length < 1 || validated_sessionIdRaw.length > 256) {
    return fail('invalid-sessionId', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  const validated_sessionId: string = validated_sessionIdRaw;
  const validated = { sessionId: validated_sessionId };
  const command: StopPhaseLogTailCommand = { type: CMD_STOP_PHASE_LOG_TAIL, correlationId, payload: validated };
  return ok(command);
}

export function validateAckPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['sessionId', 'batchSeq', 'resync', 'duplicate'])) {
    return fail('unexpected-payload-fields', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
  }
  const validated_sessionIdRaw: unknown = validatedObj['sessionId'];
  if (typeof validated_sessionIdRaw !== 'string') {
    return fail('invalid-sessionId', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
  }
  if (validated_sessionIdRaw.length < 1 || validated_sessionIdRaw.length > 256) {
    return fail('invalid-sessionId', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
  }
  const validated_sessionId: string = validated_sessionIdRaw;
  const validated_batchSeqRaw: unknown = validatedObj['batchSeq'];
  if (typeof validated_batchSeqRaw !== 'number' || !Number.isSafeInteger(validated_batchSeqRaw) || validated_batchSeqRaw < 0) {
    return fail('invalid-batchSeq', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
  }
  const validated_batchSeq: number = validated_batchSeqRaw;
  const validated_resyncRaw: unknown = validatedObj['resync'];
  let validated_resync: boolean | undefined;
  if (validated_resyncRaw !== undefined) {
    if (typeof validated_resyncRaw !== 'boolean') {
      return fail('invalid-resync', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
    }
    const validated_resyncChecked: boolean = validated_resyncRaw;
    validated_resync = validated_resyncChecked;
  }
  const validated_duplicateRaw: unknown = validatedObj['duplicate'];
  let validated_duplicate: boolean | undefined;
  if (validated_duplicateRaw !== undefined) {
    if (typeof validated_duplicateRaw !== 'boolean') {
      return fail('invalid-duplicate', { type: CMD_ACK_PHASE_LOG_TAIL, correlationId });
    }
    const validated_duplicateChecked: boolean = validated_duplicateRaw;
    validated_duplicate = validated_duplicateChecked;
  }
  const validated = { sessionId: validated_sessionId, batchSeq: validated_batchSeq, ...(validated_resync === undefined ? {} : { resync: validated_resync }), ...(validated_duplicate === undefined ? {} : { duplicate: validated_duplicate }) };
  const command: AckPhaseLogTailCommand = { type: CMD_ACK_PHASE_LOG_TAIL, correlationId, payload: validated };
  return ok(command);
}
