// FR-R5-F10 (NF-12, NU-08, F-20) — correlated queue creation helper and fixed
// refusal vocabulary for `QueuesTier.svelte`.

import { OUTCOME_NOT_YET_KNOWN_TEXT, refusalTextFrom } from './boundary-refusal-text';
import { sendIntent } from './intent-ledger';
import type { CommandType } from './messages';
import type { AckResult } from './snapshot-store.svelte';

export const CREATE_QUEUE_TIMEOUT_MS = 5000;

export type CreateQueueOutcome =
  | { readonly status: 'accepted'; readonly queueId?: string }
  | { readonly status: 'refused'; readonly reason: string; readonly message: string }
  | { readonly status: 'cancelled' };

const CREATE_QUEUE_REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'duplicate-queue-name': 'A queue with that name already exists. Choose a different name.',
  'queue-cap-reached':
    'The maximum number of queues (20) has been reached. Delete an unused queue first.',
  'invalid-queue-name':
    'Queue names must be 1–48 characters using letters, numbers, spaces, hyphens, or underscores.',
  'storage-write-failed':
    'The queue could not be saved to workspace state. Check the Schegent log and try again.',
  'ownership-lost': 'This window no longer holds workspace primacy, so it cannot create a queue.',
  'fence-superseded':
    'Another window took over workspace primacy before the queue could be created.',
  'secondary-window-readonly':
    'This window is not the primary one, so it cannot create a queue.',
  'untrusted-workspace': 'The workspace is not trusted, so queue creation is unavailable.',
  'workspace-not-trusted': 'The workspace is not trusted, so queue creation is unavailable.',
  timeout: OUTCOME_NOT_YET_KNOWN_TEXT
});

export function createQueueRefusalText(reason: string): string {
  return refusalTextFrom(CREATE_QUEUE_REFUSAL_TEXT, reason);
}

function mapCreateQueueAck(ack: AckResult): CreateQueueOutcome {
  if (ack.status === 'accepted') {
    const result = ack.result as { queueId?: unknown } | undefined;
    return {
      status: 'accepted',
      ...(typeof result?.queueId === 'string' ? { queueId: result.queueId } : {})
    };
  }
  const reason = ack.reason ?? 'operation-rejected';
  return {
    status: 'refused',
    reason,
    message: createQueueRefusalText(reason)
  };
}

export async function sendCreateQueueIntent(options: {
  readonly type: CommandType;
  readonly name: string;
  readonly post: (correlationId: string, payload: { readonly name: string }) => void;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onLateOutcome?: (outcome: CreateQueueOutcome) => void;
}): Promise<CreateQueueOutcome> {
  const { onLateOutcome } = options;
  const result = await sendIntent({
    type: options.type,
    payload: { name: options.name },
    post: options.post,
    timeoutMs: options.timeoutMs ?? CREATE_QUEUE_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack: AckResult) => onLateOutcome(mapCreateQueueAck(ack)) })
  });
  if (result.kind === 'ack') return mapCreateQueueAck(result.ack);
  if (result.kind === 'cancelled') return { status: 'cancelled' };
  return {
    status: 'refused',
    reason: 'timeout',
    message: createQueueRefusalText('timeout')
  };
}

