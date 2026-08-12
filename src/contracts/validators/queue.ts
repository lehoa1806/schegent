import {
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_START_QUEUE,
  type SidebarCommand
} from '../sidebar-ipc';
import { isValidStartQueueIntent } from '../start-intent-types';
import { QUEUE_ID_MAX, fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// Accepts the legacy empty start request and the optional explicit intent.
// This parser must stay in lockstep with isCmdStartQueue in sidebar-ipc.ts.
//
// Feature 092 (T061, FR-034) — `queueId` joins the allowlist and is held to
// the same `QUEUE_ID_MAX` bound `validateStart` applies to CMD_START's, so
// the two start-path entrances that cross this boundary cannot disagree on
// what a queue id is. Omission still yields the legacy empty payload, so a
// pre-092 sender is parsed byte for byte as before.
export function validateStartQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === undefined) {
    return ok({ type: CMD_START_QUEUE, correlationId, payload: {} } as SidebarCommand);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail('invalid-payload', { type: CMD_START_QUEUE, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['queueId', 'startIntent'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_QUEUE, correlationId });
  }
  const queueId = value['queueId'];
  if (
    queueId !== undefined &&
    (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX)
  ) {
    return fail('invalid-queueId', { type: CMD_START_QUEUE, correlationId });
  }
  const startIntent = value['startIntent'];
  if (startIntent !== undefined && !isValidStartQueueIntent(startIntent)) {
    return fail('invalid-start-intent', { type: CMD_START_QUEUE, correlationId });
  }
  if (queueId === undefined && startIntent === undefined) {
    return ok({ type: CMD_START_QUEUE, correlationId, payload: {} } as SidebarCommand);
  }
  return ok({
    type: CMD_START_QUEUE,
    correlationId,
    payload: {
      ...(queueId ? { queueId } : {}),
      ...(startIntent !== undefined ? { startIntent } : {})
    }
  } as SidebarCommand);
}

export function validateSetConfirmSuppression(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'] as Record<string, unknown> | undefined;
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.actionKey !== 'string' ||
    typeof payload.suppressed !== 'boolean'
  ) {
    return fail('invalid-payload', { type: CMD_SET_CONFIRM_SUPPRESSION, correlationId });
  }
  return ok({
    type: CMD_SET_CONFIRM_SUPPRESSION,
    correlationId,
    payload: {
      actionKey: payload.actionKey,
      suppressed: payload.suppressed
    }
  } as SidebarCommand);
}
