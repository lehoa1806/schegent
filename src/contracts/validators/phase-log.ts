import {
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  QUEUE_ID_MAX,
  isSafePathSegment,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationError,
  type IpcValidationResult
} from './shared';

// FR-R6-F07 — the start's consumer name is free text up to 64 characters (an
// unknown name is answered `busy` by the host, not refused here) and a cursor
// is up to 160 printable ASCII characters. The cursor is parsed by the host;
// this only bounds it.
const CONSUMER_MAX_CHARS = 64;
const CURSOR_MAX_CHARS = 160;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

// Wire format pinned in specs/020-phase-level-logs/contracts/phase-log-ipc.md.
// A null iteration on reads asks the host to select the latest iteration;
// tailing requires a concrete positive iteration number.
const PHASE_LOG_SELECTION_KEYS = [
  'queueId',
  'taskId',
  'pipelineId',
  'phaseId',
  'iterationN'
] as const;

type ValidatedPhaseLogSelection = {
  readonly queueId: string;
  readonly taskId: string;
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iterationN: number | null;
};

type SelectionValidationOutcome =
  | { readonly ok: true; readonly selection: ValidatedPhaseLogSelection }
  | IpcValidationError;

function validatePhaseLogSelection(
  raw: unknown,
  type: string,
  correlationId: string,
  opts: { readonly iterationNRequired: boolean }
): SelectionValidationOutcome {
  if (raw === null || typeof raw !== 'object') {
    return fail('invalid-selection', { type, correlationId });
  }
  const selection = raw as Record<string, unknown>;
  if (hasUnexpectedKeys(selection, PHASE_LOG_SELECTION_KEYS)) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = selection['queueId'];
  // FR-R3-080 (T1073) — shape as well as size. Each of these becomes a path
  // component in `phase-log-path.ts`, and a bounded identifier is not a safe
  // path segment.
  if (!isSafePathSegment(queueId)) {
    return fail('invalid-queueId', { type, correlationId });
  }
  const taskId = selection['taskId'];
  // FR-R3-080 (T1073) — shape as well as size. Each of these becomes a path
  // component in `phase-log-path.ts`, and a bounded identifier is not a safe
  // path segment.
  if (!isSafePathSegment(taskId)) {
    return fail('invalid-taskId', { type, correlationId });
  }
  const pipelineId = selection['pipelineId'];
  if (!isSafePathSegment(pipelineId)) {
    return fail('invalid-pipelineId', { type, correlationId });
  }
  const phaseId = selection['phaseId'];
  // FR-R3-080 (T1073) — shape as well as size. Each of these becomes a path
  // component in `phase-log-path.ts`, and a bounded identifier is not a safe
  // path segment.
  if (!isSafePathSegment(phaseId)) {
    return fail('invalid-phaseId', { type, correlationId });
  }

  const rawIteration = selection['iterationN'];
  let iterationN: number | null;
  if (opts.iterationNRequired) {
    if (typeof rawIteration !== 'number' || !Number.isInteger(rawIteration) || rawIteration < 1) {
      return fail('invalid-iterationN', { type, correlationId });
    }
    iterationN = rawIteration;
  } else if (rawIteration === null || rawIteration === undefined) {
    iterationN = null;
  } else if (
    typeof rawIteration === 'number' &&
    Number.isInteger(rawIteration) &&
    rawIteration >= 1
  ) {
    iterationN = rawIteration;
  } else {
    return fail('invalid-iterationN', { type, correlationId });
  }

  return {
    ok: true,
    selection: { queueId, taskId, pipelineId, phaseId, iterationN }
  };
}

export function validateReadPhaseLog(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['selection'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_PHASE_LOG, correlationId });
  }
  const selection = validatePhaseLogSelection(
    value['selection'],
    CMD_READ_PHASE_LOG,
    correlationId,
    { iterationNRequired: false }
  );
  if (!selection.ok) return selection;
  return ok({
    type: CMD_READ_PHASE_LOG,
    correlationId,
    payload: { selection: selection.selection }
  } as SidebarCommand);
}

export function validateStartPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['selection', 'consumer', 'fromCursor'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const selection = validatePhaseLogSelection(
    value['selection'],
    CMD_START_PHASE_LOG_TAIL,
    correlationId,
    { iterationNRequired: true }
  );
  if (!selection.ok) return selection;
  const { consumer, fromCursor } = value;
  if (consumer !== undefined && !isBoundedString(consumer, CONSUMER_MAX_CHARS)) {
    return fail('invalid-consumer', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const cursorOk = isBoundedString(fromCursor, CURSOR_MAX_CHARS) && PRINTABLE_ASCII.test(fromCursor);
  if (fromCursor !== undefined && !cursorOk) {
    return fail('invalid-fromCursor', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  return ok({
    type: CMD_START_PHASE_LOG_TAIL,
    correlationId,
    payload: {
      selection: selection.selection as ValidatedPhaseLogSelection & {
        readonly iterationN: number;
      },
      ...(consumer === undefined ? {} : { consumer }),
      ...(fromCursor === undefined ? {} : { fromCursor })
    }
  } as SidebarCommand);
}

export function validateStopPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['sessionId'])) {
    return fail('unexpected-payload-fields', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  const sessionId = value['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > QUEUE_ID_MAX) {
    return fail('invalid-sessionId', { type: CMD_STOP_PHASE_LOG_TAIL, correlationId });
  }
  return ok({
    type: CMD_STOP_PHASE_LOG_TAIL,
    correlationId,
    payload: { sessionId }
  } as SidebarCommand);
}

// FR-R6-F07 (FR-009) — `batchSeq` 0 is the ready ack; the flags are optional
// booleans and are passed through only when present.
export function validateAckPhaseLogTail(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const type = CMD_ACK_PHASE_LOG_TAIL;
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['sessionId', 'batchSeq', 'resync', 'duplicate'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const { sessionId, batchSeq, resync, duplicate } = value;
  if (!isBoundedString(sessionId, QUEUE_ID_MAX)) {
    return fail('invalid-sessionId', { type, correlationId });
  }
  if (typeof batchSeq !== 'number' || !Number.isSafeInteger(batchSeq) || batchSeq < 0) {
    return fail('invalid-batchSeq', { type, correlationId });
  }
  if (resync !== undefined && typeof resync !== 'boolean') {
    return fail('invalid-resync', { type, correlationId });
  }
  if (duplicate !== undefined && typeof duplicate !== 'boolean') {
    return fail('invalid-duplicate', { type, correlationId });
  }
  return ok({
    type,
    correlationId,
    payload: {
      sessionId,
      batchSeq,
      ...(resync === undefined ? {} : { resync }),
      ...(duplicate === undefined ? {} : { duplicate })
    }
  } as SidebarCommand);
}
