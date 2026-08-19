// Feature 065 (T019) — Unit tests for `migrateV6ToV7()` covering the v6→v7
// derivation table from contracts/state-schema.diff.md §Migration semantics.
// Every (inFlightId, paused, pending.length) tuple maps to a specific
// `(queueLifecycle, scheduledStartAt, scheduledStartSource)`. Pending tasks
// MUST be preserved byte-for-byte (SC-005). A single
// `state-migrated-v6-to-v7` audit event is emitted with the per-lifecycle
// counts.

import { describe, expect, it } from 'vitest';
import {
  deriveLifecycle,
  migrateV6ToV7
} from '../../../src/state/queue-state-migrator';
import type {
  FeatureRequest,
  QueueState
} from '../../../src/queue/feature-request';

function feature(id: string, opts: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id,
    description: `task-${id}`,
    enqueuedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    startedAt: null,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    status: 'pending',
    position: 0,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...opts
  };
}

function v6State(opts: Partial<QueueState>): QueueState {
  // Type erase: simulate a v6 record that lacks the new v7 fields.
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 1_700_000_000_000,
    // v7 fields are intentionally NOT provided on a true v6 record; the
    // migrator detects this via the absence of `queueLifecycle`.
    queueLifecycle: undefined as unknown as QueueState['queueLifecycle'],
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...opts
  };
}

describe('Feature 065 — migrateV6ToV7 derivation table', () => {
  it('inFlight=null, paused=false, pendingCount=0 → active-empty', () => {
    expect(deriveLifecycle(null, false, 0)).toBe('active-empty');
  });

  it('inFlight=null, paused=false, pendingCount>0 → idle-pending', () => {
    expect(deriveLifecycle(null, false, 1)).toBe('idle-pending');
    expect(deriveLifecycle(null, false, 7)).toBe('idle-pending');
  });

  it('inFlight=null, paused=true → operator-paused (irrespective of pendingCount)', () => {
    expect(deriveLifecycle(null, true, 0)).toBe('operator-paused');
    expect(deriveLifecycle(null, true, 5)).toBe('operator-paused');
  });

  it('inFlight=string → running (irrespective of paused/pendingCount)', () => {
    expect(deriveLifecycle('r-1', false, 0)).toBe('running');
    expect(deriveLifecycle('r-1', true, 0)).toBe('running');
    expect(deriveLifecycle('r-1', false, 3)).toBe('running');
  });
});

describe('Feature 065 — migrateV6ToV7 result shape', () => {
  it('migrates an idle-pending v6 record and emits migration-default source', () => {
    const v6 = v6State({
      requests: [feature('r-1', { status: 'pending' })],
      inFlightId: null,
      paused: false
    });
    const result = migrateV6ToV7(v6, 1_700_000_001_000);
    expect(result.migrated).toBe(true);
    expect(result.queueState.queueLifecycle).toBe('idle-pending');
    expect(result.queueState.scheduledStartAt).toBeNull();
    expect(result.queueState.scheduledStartSource).toBe('migration-default');
    expect(result.queueState.migrationNotice).toBe('pending');
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0].type).toBe('state-migrated-v6-to-v7');
    expect(result.auditEvents[0].counts.idlePending).toBe(1);
  });

  it('migrates a running v6 record with scheduledStartSource=null', () => {
    const v6 = v6State({
      requests: [
        feature('r-1', { status: 'in-flight' as FeatureRequest['status'] })
      ],
      inFlightId: 'r-1',
      paused: false
    });
    const result = migrateV6ToV7(v6, 1_700_000_002_000);
    expect(result.queueState.queueLifecycle).toBe('running');
    expect(result.queueState.scheduledStartSource).toBeNull();
    expect(result.queueState.migrationNotice).toBeUndefined();
    expect(result.auditEvents[0].counts.running).toBe(1);
  });

  it('migrates an operator-paused v6 record', () => {
    const v6 = v6State({
      requests: [feature('r-1', { status: 'pending' })],
      paused: true,
      pausedReason: 'operator'
    });
    const result = migrateV6ToV7(v6);
    expect(result.queueState.queueLifecycle).toBe('operator-paused');
    expect(result.queueState.scheduledStartSource).toBeNull();
    expect(result.auditEvents[0].counts.operatorPaused).toBe(1);
  });

  it('migrates an active-empty v6 record', () => {
    const v6 = v6State({ requests: [] });
    const result = migrateV6ToV7(v6);
    expect(result.queueState.queueLifecycle).toBe('active-empty');
    expect(result.queueState.scheduledStartSource).toBeNull();
    expect(result.auditEvents[0].counts.activeEmpty).toBe(1);
  });

  it('preserves pending tasks byte-for-byte (SC-005)', () => {
    const r1 = feature('r-1', { status: 'pending', description: 'TASK ONE' });
    const r2 = feature('r-2', { status: 'pending', description: 'TASK TWO' });
    const v6 = v6State({ requests: [r1, r2] });
    const result = migrateV6ToV7(v6);
    expect(result.queueState.requests).toHaveLength(2);
    expect(result.queueState.requests[0]).toEqual(r1);
    expect(result.queueState.requests[1]).toEqual(r2);
    // Reference-identity is preserved (no copy of pending tasks):
    expect(result.queueState.requests[0].id).toBe(r1.id);
    expect(result.queueState.requests[0].description).toBe(r1.description);
    expect(result.queueState.requests[0].enqueuedAt).toBe(r1.enqueuedAt);
  });

  it('is idempotent: a v7-shaped record is returned unchanged with migrated=false', () => {
    const v7: QueueState = {
      requests: [feature('r-1')],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 1_700_000_005_000,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: 'migration-default',
      migrationNotice: 'pending'
    };
    const result = migrateV6ToV7(v7);
    expect(result.migrated).toBe(false);
    expect(result.queueState).toBe(v7);
    expect(result.auditEvents).toHaveLength(0);
  });
});
