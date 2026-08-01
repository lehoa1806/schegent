import {
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_START_QUEUE,
  type SidebarCommand
} from '../sidebar-ipc';
import { isValidStartQueueIntent } from '../start-intent-types';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// Accepts the legacy empty start request and the optional explicit intent.
// This parser must stay in lockstep with isCmdStartQueue in sidebar-ipc.ts.
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
  if (hasUnexpectedKeys(value, ['startIntent'])) {
    return fail('unexpected-payload-fields', { type: CMD_START_QUEUE, correlationId });
  }
  const startIntent = value['startIntent'];
  if (startIntent === undefined) {
    return ok({ type: CMD_START_QUEUE, correlationId, payload: {} } as SidebarCommand);
  }
  if (!isValidStartQueueIntent(startIntent)) {
    return fail('invalid-start-intent', { type: CMD_START_QUEUE, correlationId });
  }
  return ok({
    type: CMD_START_QUEUE,
    correlationId,
    payload: { startIntent }
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
