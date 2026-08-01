import {
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationError,
  type IpcValidationResult
} from './shared';

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
  if (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX) {
    return fail('invalid-queueId', { type, correlationId });
  }
  const taskId = selection['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > QUEUE_ID_MAX) {
    return fail('invalid-taskId', { type, correlationId });
  }
  const pipelineId = selection['pipelineId'];
  if (
    typeof pipelineId !== 'string' ||
    pipelineId.length === 0 ||
    pipelineId.length > QUEUE_ID_MAX
  ) {
    return fail('invalid-pipelineId', { type, correlationId });
  }
  const phaseId = selection['phaseId'];
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
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
  if (hasUnexpectedKeys(value, ['selection'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_PHASE_LOG_TAIL, correlationId });
  }
  const selection = validatePhaseLogSelection(
    value['selection'],
    CMD_START_PHASE_LOG_TAIL,
    correlationId,
    { iterationNRequired: true }
  );
  if (!selection.ok) return selection;
  return ok({
    type: CMD_START_PHASE_LOG_TAIL,
    correlationId,
    payload: {
      selection: selection.selection as ValidatedPhaseLogSelection & {
        readonly iterationN: number;
      }
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
