// Feature 095 (T004, FR-008) — the schedule read seam.
//
// The assertion that carries the feature's correction is `not gated on
// lifecycle`: an earlier draft of the spec proposed a new host field readable
// only while the queue was `idle-pending`, mirroring the persistence lockstep
// rule that governs feature 065's `QueueState.scheduledStartAt`. That rule does
// not govern this field. A queue can be `running` and armed at the same time,
// and its target must still read.

import { describe, expect, it } from 'vitest';

import {
  findQueueSummary,
  formatScheduleTarget,
  queueSchedule
} from '../queue-schedule-view';
import type {
  QueueLifecycle,
  QueueProjection,
  QueueSummary,
  WorkflowSnapshot
} from '../snapshot-types';

const TARGET_AT = '2026-08-15T09:30:00.000Z';

function summary(id: string, overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    id,
    name: id,
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0,
    ...overrides
  };
}

function snapshot(
  queues: readonly QueueSummary[],
  lifecycle: QueueLifecycle = 'active-empty'
): Pick<WorkflowSnapshot, 'queue'> {
  const queue: QueueProjection = {
    inFlight: null,
    pending: [],
    recent: [],
    orderedItems: [],
    queues,
    paused: false,
    lifecycle
  };
  return { queue };
}

const ARMED = summary('q-beta', {
  position: 1,
  schedule: { expression: 'in 2 hours', kind: 'relative', targetAt: TARGET_AT }
});

describe('findQueueSummary', () => {
  it('answers the summary the snapshot publishes for the named queue', () => {
    const found = findQueueSummary(snapshot([summary('default'), ARMED]), 'q-beta');
    expect(found?.id).toBe('q-beta');
  });

  it('answers null for a queue the snapshot does not carry', () => {
    expect(findQueueSummary(snapshot([summary('default')]), 'q-missing')).toBeNull();
  });

  it('answers null before the host has projected the registry', () => {
    expect(findQueueSummary(snapshot([]), 'default')).toBeNull();
    expect(findQueueSummary(null, 'default')).toBeNull();
    expect(findQueueSummary(undefined, 'default')).toBeNull();
    // A projection with no `queues` key at all — distinct from the empty-array
    // case above, and not a cast: `queues` is optional on `QueueProjection`, so
    // this is a shape the host genuinely publishes before it projects the
    // registry.
    const unprojected: QueueProjection = {
      inFlight: null,
      pending: [],
      recent: [],
      orderedItems: [],
      paused: false
    };
    expect(findQueueSummary({ queue: unprojected }, 'default')).toBeNull();
  });
});

describe('queueSchedule', () => {
  it('answers the schedule an armed queue carries', () => {
    expect(queueSchedule(snapshot([summary('default'), ARMED]), 'q-beta')).toEqual({
      expression: 'in 2 hours',
      kind: 'relative',
      targetAt: TARGET_AT
    });
  });

  it('answers null for an unarmed queue', () => {
    expect(queueSchedule(snapshot([summary('default')]), 'default')).toBeNull();
  });

  it('answers null for an unknown queue', () => {
    expect(queueSchedule(snapshot([summary('default')]), 'q-missing')).toBeNull();
  });

  // The correction. `QueueSummary.schedule` is written by CMD_SET_QUEUE_SCHEDULE
  // and paired with nothing; the `idle-pending` lockstep belongs to a different
  // field written by a different command (plan R4).
  it('is not gated on lifecycle — every lifecycle reads the same schedule', () => {
    const lifecycles: readonly QueueLifecycle[] = [
      'running',
      'operator-paused',
      'idle-pending',
      'active-empty'
    ];
    for (const lifecycle of lifecycles) {
      expect(queueSchedule(snapshot([ARMED], lifecycle), 'q-beta')).toEqual({
        expression: 'in 2 hours',
        kind: 'relative',
        targetAt: TARGET_AT
      });
    }
  });
});

describe('formatScheduleTarget', () => {
  it('formats the host-resolved ISO target without recomputing it', () => {
    const formatted = formatScheduleTarget(TARGET_AT);
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Same instant, rendered locally — the webview derives no new instant.
    expect(new Date(TARGET_AT).getFullYear()).toBe(Number(formatted.slice(0, 4)));
  });

  it('falls back to the raw value rather than rendering empty', () => {
    expect(formatScheduleTarget('not-a-timestamp')).toBe('not-a-timestamp');
  });
});
