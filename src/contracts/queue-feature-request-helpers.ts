/**
 * FR-R7-07 — Pure feature-request bounds and record normalizers relocated from
 * `src/queue/feature-request.ts` into `src/contracts/` so `src/state/` does not
 * value-import `src/queue/`. The `FeatureRequest` and `QueueState` interface
 * declarations remain in `src/queue/feature-request.ts` (type-imported here)
 * so generated contract schemas (`contracts:check`) remain byte-identical.
 */

import type { FeatureRequest, FeatureRequestStatus } from '../queue/feature-request';

export const MAX_DESCRIPTION_LENGTH = 32_000;
export const MAX_PENDING_TASKS_PER_QUEUE = 100;

export function validateDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error('Feature description must be non-empty');
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Feature description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return trimmed;
}

export function ensureExtendedFeatureRequest(
  raw: Partial<FeatureRequest> & {
    id: string;
    description: string;
    enqueuedAt: number;
    status: FeatureRequestStatus;
    position: number;
    runId: string | null;
  }
): FeatureRequest {
  return {
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    queueId: 'default',
    pauseCause: null,
    startedAt: null,
    completedAt: null,
    createdAt: raw.enqueuedAt,
    updatedAt: raw.enqueuedAt,
    ...raw
  };
}
