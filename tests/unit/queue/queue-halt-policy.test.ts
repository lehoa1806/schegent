// Feature 195 (T003, FR-006, SC-005) — the blocking-status census.
//
// Iterates `FEATURE_REQUEST_STATUSES` — the generated, schema-derived census
// of `FeatureRequestStatus` (`src/contracts/generated/boundary-contracts.ts`)
// — rather than a hand-written list of six. A seventh status added to the
// union later widens that generated array too, so this test fails on the new
// member instead of silently reading it as non-blocking.

import { describe, it, expect } from 'vitest';
import { FEATURE_REQUEST_STATUSES } from '../../../src/contracts/generated/boundary-contracts';
import {
  isBlockingTaskStatus,
  evaluateQueueHalt
} from '../../../src/queue/queue-halt-policy';
import type { FeatureRequest, FeatureRequestStatus } from '../../../src/queue/feature-request';

describe('feature 195 (T003, FR-006) — isBlockingTaskStatus', () => {
  it('blocks on failed and only failed, across the whole status census', () => {
    const results = new Map(
      FEATURE_REQUEST_STATUSES.map((status) => [
        status,
        isBlockingTaskStatus(status as FeatureRequestStatus)
      ])
    );
    expect(results.get('failed')).toBe(true);
    for (const status of FEATURE_REQUEST_STATUSES) {
      if (status === 'failed') continue;
      expect(results.get(status), `status "${status}" must not block`).toBe(false);
    }
  });
});

function row(id: string, status: FeatureRequestStatus, position: number): FeatureRequest {
  return {
    id,
    description: `task ${id}`,
    enqueuedAt: 0,
    createdAt: 0,
    startedAt: null,
    updatedAt: 0,
    completedAt: null,
    status,
    position,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

describe('feature 195 (T005, FR-005, FR-008) — evaluateQueueHalt', () => {
  it('returns null under "continue" regardless of rows', () => {
    expect(evaluateQueueHalt('continue', [row('t1', 'failed', 0)])).toBeNull();
  });

  it('returns null under "halt-on-failure" with no blocking row', () => {
    expect(
      evaluateQueueHalt('halt-on-failure', [row('t1', 'pending', 0), row('t2', 'completed', 1)])
    ).toBeNull();
  });

  it('names the failed row under "halt-on-failure"', () => {
    const verdict = evaluateQueueHalt('halt-on-failure', [
      row('t1', 'completed', 0),
      row('t2', 'failed', 1),
      row('t3', 'pending', 2)
    ]);
    expect(verdict).toEqual({ taskId: 't2', taskName: 'task t2' });
  });

  it('names the earliest failed row in position order when several block', () => {
    const verdict = evaluateQueueHalt('halt-on-failure', [
      row('later', 'failed', 5),
      row('earlier', 'failed', 1)
    ]);
    expect(verdict?.taskId).toBe('earlier');
  });

  it('does not block on a canceled row', () => {
    expect(evaluateQueueHalt('halt-on-failure', [row('t1', 'canceled', 0)])).toBeNull();
  });
});
