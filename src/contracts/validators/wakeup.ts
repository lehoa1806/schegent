import {
  CMD_READ_WAKEUP_SESSION_LOG,
  CMD_REVEAL_WAKEUP_SESSION_LOG,
  CMD_SAVE_WAKEUP_SETTINGS,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  CORRELATION_ID_MAX,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationResult
} from './shared';

// Shape validation only. Schedule invariants and model allowlists belong to
// the host save handler in src/wakeup/save-handler.ts.
export function validateSaveWakeUpSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (
    hasUnexpectedKeys(value, [
      'enabled',
      'schedulerType',
      'chronologicalTime',
      'periodicInterval',
      'model'
    ])
  ) {
    return fail('unexpected-payload-fields', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const enabled = value['enabled'];
  if (typeof enabled !== 'boolean') {
    return fail('invalid-enabled', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const schedulerType = value['schedulerType'];
  if (schedulerType !== 'chronological' && schedulerType !== 'periodic') {
    return fail('invalid-scheduler-type', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const chronologicalTime = value['chronologicalTime'];
  if (typeof chronologicalTime !== 'string') {
    return fail('invalid-chronological-time', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const periodicInterval = value['periodicInterval'];
  if (typeof periodicInterval !== 'string') {
    return fail('invalid-periodic-interval', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  const model = value['model'];
  if (model !== undefined && typeof model !== 'string') {
    return fail('invalid-model', { type: CMD_SAVE_WAKEUP_SETTINGS, correlationId });
  }
  return ok({
    type: CMD_SAVE_WAKEUP_SETTINGS,
    correlationId,
    payload: {
      enabled,
      schedulerType,
      chronologicalTime,
      periodicInterval,
      ...(typeof model === 'string' ? { model } : {})
    }
  } as SidebarCommand);
}

export function validateReadWakeupSessionLog(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_READ_WAKEUP_SESSION_LOG, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['correlationId'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_WAKEUP_SESSION_LOG, correlationId });
  }
  const sessionCorrelationId = value['correlationId'];
  if (
    typeof sessionCorrelationId !== 'string' ||
    sessionCorrelationId.length === 0 ||
    sessionCorrelationId.length > CORRELATION_ID_MAX
  ) {
    return fail('invalid-correlationId', { type: CMD_READ_WAKEUP_SESSION_LOG, correlationId });
  }
  return ok({
    type: CMD_READ_WAKEUP_SESSION_LOG,
    correlationId,
    payload: { correlationId: sessionCorrelationId }
  } as SidebarCommand);
}

export function validateRevealWakeupSessionLog(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === undefined) {
    return ok({ type: CMD_REVEAL_WAKEUP_SESSION_LOG, correlationId } as SidebarCommand);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('invalid-payload', { type: CMD_REVEAL_WAKEUP_SESSION_LOG, correlationId });
  }
  if (Object.keys(payload as object).length !== 0) {
    return fail('unexpected-payload-fields', { type: CMD_REVEAL_WAKEUP_SESSION_LOG, correlationId });
  }
  return ok({
    type: CMD_REVEAL_WAKEUP_SESSION_LOG,
    correlationId,
    payload: {}
  } as SidebarCommand);
}
