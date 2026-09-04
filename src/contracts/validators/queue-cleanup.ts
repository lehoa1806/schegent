import { CMD_CLEAR_COMPLETED, CMD_CLEAR_QUEUE, type SidebarCommand } from '../sidebar-ipc';
import { QUEUE_ID_MAX, fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// FR-R3-150 (T1618/T1621a) — both Clear Done and the queue-scoped Clean All
// carry only the queue they address, and a request that doesn't identify a
// valid, known queue must be refused rather than silently applied to a
// default or fallback queue (FR-011). Shape/type is checked here, at the
// sidebar IPC boundary — required, non-empty, length-bounded. Whether the
// id names a queue that actually exists in the registry is a separate
// check one layer down, in `QueueManager` (`'unknown-queue-id'`), which is
// where the registry lives; this validator has no store access and cannot
// make that determination.
export type QueueCleanupCommandType = typeof CMD_CLEAR_COMPLETED | typeof CMD_CLEAR_QUEUE;

export function validateQueueCleanupPayload(
  type: QueueCleanupCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = p['queueId'];
  if (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX) {
    return fail('invalid-queueId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { queueId } } as SidebarCommand);
}
