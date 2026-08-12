// Feature 092 (T109, FR-047) — a connected run is ONE row on the Queue Detail
// tier, not N rows, one per node.
//
// The collapse is derived, never published: membership comes from each node's
// `latestQueueItemId`, which the connected-run projection already carries so the
// existing Run surfaces can be reused. Nothing new is added to the wire for it,
// and a Task that belongs to no connected run keeps its own row.

import { describe, expect, it } from 'vitest';

import { buildQueueRunRows } from '../queue-run-rows';
import type { ConnectedRunProjection, QueueItem } from '../snapshot-types';

function task(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    label: `task ${id}`,
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  };
}

function connectedRun(
  connectedRunId: string,
  queueItemIds: readonly (string | undefined)[],
  overrides: Partial<ConnectedRunProjection> = {}
): ConnectedRunProjection {
  return {
    connectedRunId,
    workflowId: `wf-${connectedRunId}`,
    revision: 1,
    hydrating: false,
    nodes: queueItemIds.map((queueItemId, index) => ({
      nodeId: `n${index}`,
      pipelineId: `p${index}`,
      state: 'unvisited' as const,
      actions: [],
      attemptCount: queueItemId === undefined ? 0 : 1,
      ...(queueItemId === undefined ? {} : { latestQueueItemId: queueItemId })
    })),
    ...overrides
  };
}

describe('buildQueueRunRows — a connected run occupies one row (FR-047)', () => {
  it('collapses every member Task of a connected run into a single row', () => {
    const tasks = [task('a', { position: 0 }), task('b', { position: 1 }), task('c', { position: 2 })];
    const runs = [connectedRun('cr-1', ['a', 'b', 'c'])];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, runs);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.connectedRunId).toBe('cr-1');
    expect(rows[0]?.memberTaskIds).toEqual(['a', 'b', 'c']);
    expect(standaloneTasks).toEqual([]);
  });

  it('excludes member Tasks from the standalone list so nothing is listed twice', () => {
    const tasks = [task('a', { position: 0 }), task('solo', { position: 1 }), task('b', { position: 2 })];
    const runs = [connectedRun('cr-1', ['a', 'b'])];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, runs);

    expect(rows).toHaveLength(1);
    expect(standaloneTasks.map((item) => item.id)).toEqual(['solo']);
  });

  it('keeps a Task that belongs to no connected run as its own row', () => {
    const tasks = [task('solo-1', { position: 0 }), task('solo-2', { position: 1 })];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, []);

    expect(rows).toEqual([]);
    expect(standaloneTasks.map((item) => item.id)).toEqual(['solo-1', 'solo-2']);
  });

  it('drops a connected run whose nodes name none of this queue’s Tasks', () => {
    // The run belongs to another queue. It is not this queue's row, and it does
    // not fabricate one from ids the queue does not hold.
    const tasks = [task('mine', { position: 0 })];
    const runs = [connectedRun('cr-elsewhere', ['theirs-1', 'theirs-2'])];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, runs);

    expect(rows).toEqual([]);
    expect(standaloneTasks.map((item) => item.id)).toEqual(['mine']);
  });

  it('ignores nodes that have not run yet rather than treating them as members', () => {
    const tasks = [task('a', { position: 0 })];
    const runs = [connectedRun('cr-1', ['a', undefined, undefined])];

    const { rows } = buildQueueRunRows(tasks, runs);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberTaskIds).toEqual(['a']);
    expect(rows[0]?.nodeCount).toBe(3);
  });

  it('orders rows by their earliest member position, interleaved with standalone Tasks', () => {
    const tasks = [
      task('early-solo', { position: 0 }),
      task('cr-member-late', { position: 5 }),
      task('cr-member-early', { position: 2 }),
      task('late-solo', { position: 9 })
    ];
    const runs = [connectedRun('cr-1', ['cr-member-late', 'cr-member-early'])];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, runs);

    expect(rows[0]?.position).toBe(2);
    expect(standaloneTasks.map((item) => item.position)).toEqual([0, 9]);
  });

  it('summarises the row from its member Tasks so the row can be rendered without a second read', () => {
    const tasks = [
      task('a', { position: 0, status: 'completed', label: 'first node task' }),
      task('b', { position: 1, status: 'in-flight', currentPhase: 'implement' })
    ];
    const runs = [connectedRun('cr-1', ['a', 'b'])];

    const { rows } = buildQueueRunRows(tasks, runs);

    expect(rows[0]?.label).toBe('first node task');
    expect(rows[0]?.status).toBe('in-flight');
    expect(rows[0]?.completedNodeCount).toBe(1);
  });

  it('reports a hydrating run as hydrating rather than inventing a status', () => {
    const tasks = [task('a', { position: 0, status: 'pending' })];
    const runs = [connectedRun('cr-1', ['a'], { hydrating: true })];

    const { rows } = buildQueueRunRows(tasks, runs);

    expect(rows[0]?.hydrating).toBe(true);
  });

  it('assigns a Task claimed by two connected runs to the first run only', () => {
    // Not a shape the host should publish, but the helper must not emit the same
    // Task under two rows if it ever does.
    const tasks = [task('shared', { position: 0 })];
    const runs = [connectedRun('cr-1', ['shared']), connectedRun('cr-2', ['shared'])];

    const { rows, standaloneTasks } = buildQueueRunRows(tasks, runs);

    expect(rows.map((row) => row.connectedRunId)).toEqual(['cr-1']);
    expect(standaloneTasks).toEqual([]);
  });

  it('returns frozen results so a consumer cannot mutate the derived view', () => {
    const { rows, standaloneTasks } = buildQueueRunRows([task('a')], [connectedRun('cr-1', ['a'])]);

    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(standaloneTasks)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it('handles an absent connected-run list as no connected runs', () => {
    const { rows, standaloneTasks } = buildQueueRunRows([task('a')], undefined);

    expect(rows).toEqual([]);
    expect(standaloneTasks.map((item) => item.id)).toEqual(['a']);
  });
});
