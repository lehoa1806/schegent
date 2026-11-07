import { beforeEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_RESYNC_REQUEST } from '../../../../src/contracts/snapshot-bounds.js';
import { SnapshotTransport } from '../../../../src/ui/sidebar/snapshot-transport';
import { buildIdleSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { setHostTransport, resetHostTransport } from '../host-transport';
import { STATE_SNAPSHOT, type HostMessage } from '../messages';
import { snapshotStore } from '../snapshot-store.svelte';
import type { WorkflowSnapshot } from '../snapshot-types';

function makeSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const base = buildIdleSnapshot({
    isPrimary: true,
    producedAt: '2026-11-06T00:00:00.000Z'
  }) as unknown as WorkflowSnapshot;
  return Object.freeze({
    ...base,
    ...overrides
  });
}

describe('SnapshotStore synchronization, slice reconstruction, and resync (FR-R5-F12)', () => {
  const postedToHost: unknown[] = [];

  beforeEach(() => {
    postedToHost.length = 0;
    snapshotStore.resetSyncState();
    resetHostTransport();
    setHostTransport({
      postMessage(msg: unknown) {
        postedToHost.push(msg);
      },
      onMessage() {
        return () => {};
      },
      getState() {
        return undefined;
      },
      setState() {}
    });
  });

  it('reconstructs omitted slices on routine updates and preserves unchanged slice references', () => {
    const transport = new SnapshotTransport();
    const history = Object.freeze([
      Object.freeze({
        runId: 'run-101',
        featureId: 'feat-101',
        descriptionPreview: 'initial history row',
        terminalStatus: 'completed' as const,
        startedAt: '2026-11-06T00:00:00.000Z',
        completedAt: '2026-11-06T00:00:01.000Z',
        durationMs: 1_000,
        lastErrorSummary: null,
        auditLogPointer: 'runId:run-101',
        queueId: 'default'
      })
    ]);

    const snap1 = makeSnapshot({ history, producedAt: '2026-11-06T00:00:01.000Z' });
    const post1 = transport.preparePost(snap1);
    snapshotStore.apply(post1.message as HostMessage<WorkflowSnapshot>);

    expect(snapshotStore.isReady).toBe(true);
    expect(snapshotStore.lastRevision).toBe(1);
    const historyRef1 = snapshotStore.history;
    const queuesRef1 = snapshotStore.queueRuntimes;
    expect(historyRef1).toHaveLength(1);

    // Routine update: history omitted on the wire, only producedAt changed
    const snap2 = makeSnapshot({ history, producedAt: '2026-11-06T00:00:02.000Z' });
    const post2 = transport.preparePost(snap2);
    expect(post2.sync.mode).toBe('routine');
    expect('history' in (post2.message.payload as unknown as Record<string, unknown>)).toBe(false);

    snapshotStore.apply(post2.message as HostMessage<WorkflowSnapshot>);
    expect(snapshotStore.lastRevision).toBe(2);
    expect(snapshotStore.snapshot?.producedAt).toBe('2026-11-06T00:00:02.000Z');
    // Omitted slice reconstructed AND exact reference identity preserved
    expect(snapshotStore.history).toBe(historyRef1);
    expect(snapshotStore.queueRuntimes).toBe(queuesRef1);
  });

  it('preserves unchanged slice references even when a full resync snapshot arrives with fresh clones', () => {
    const history1 = [
      {
        runId: 'run-1',
        featureId: 'feat-1',
        descriptionPreview: 'preview',
        terminalStatus: 'completed' as const,
        startedAt: '2026-11-06T00:00:00.000Z',
        completedAt: '2026-11-06T00:00:01.000Z',
        durationMs: 1_000,
        lastErrorSummary: null,
        auditLogPointer: 'runId:run-1',
        queueId: 'default'
      }
    ];
    const snap1 = makeSnapshot({ history: history1, producedAt: '2026-11-06T00:00:01.000Z' });
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: snap1,
      sync: { mode: 'full', revision: 1 }
    });
    const initialHistoryRef = snapshotStore.history;

    // Freshly deserialized clone of the identical history array arrives in a full resync
    const history2 = JSON.parse(JSON.stringify(history1)) as typeof history1;
    expect(history2).not.toBe(history1);
    const snap2 = makeSnapshot({ history: history2, producedAt: '2026-11-06T00:00:05.000Z' });
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: snap2,
      sync: { mode: 'full', revision: 2 }
    });

    expect(snapshotStore.lastRevision).toBe(2);
    expect(snapshotStore.history).toBe(initialHistoryRef);
  });

  it('ignores out-of-order or duplicate revisions without overwriting newer state', () => {
    const snap1 = makeSnapshot({ producedAt: '2026-11-06T00:00:01.000Z' });
    const snap2 = makeSnapshot({ producedAt: '2026-11-06T00:00:02.000Z' });
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: snap2,
      sync: { mode: 'full', revision: 2 }
    });
    expect(snapshotStore.lastRevision).toBe(2);
    expect(snapshotStore.snapshot?.producedAt).toBe('2026-11-06T00:00:02.000Z');

    // Stale revision 1 arrives late
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: snap1,
      sync: { mode: 'full', revision: 1 }
    });
    expect(snapshotStore.droppedStaleCount).toBe(1);
    expect(snapshotStore.lastRevision).toBe(2);
    expect(snapshotStore.snapshot?.producedAt).toBe('2026-11-06T00:00:02.000Z');
  });

  it('rejects a routine delta when a message was dropped and requests a full resync from the host', () => {
    const transport = new SnapshotTransport();
    const snap1 = makeSnapshot({ producedAt: '2026-11-06T00:00:01.000Z' });
    const snap2 = makeSnapshot({ producedAt: '2026-11-06T00:00:02.000Z' });
    const snap3 = makeSnapshot({ producedAt: '2026-11-06T00:00:03.000Z' });

    const post1 = transport.preparePost(snap1);
    const _droppedPost2 = transport.preparePost(snap2);
    const post3 = transport.preparePost(snap3);

    snapshotStore.apply(post1.message as HostMessage<WorkflowSnapshot>);
    expect(snapshotStore.lastRevision).toBe(1);

    // post2 is lost in transit; post3 arrives with baseRevision: 2 !== lastRevision: 1
    snapshotStore.apply(post3.message as HostMessage<WorkflowSnapshot>);
    expect(snapshotStore.resyncCount).toBe(1);
    // State stays at revision 1 rather than applying a delta with a missing intermediate revision
    expect(snapshotStore.lastRevision).toBe(1);
    expect(snapshotStore.snapshot?.producedAt).toBe('2026-11-06T00:00:01.000Z');
    expect(postedToHost).toEqual([
      {
        type: SNAPSHOT_RESYNC_REQUEST,
        lastRevision: 1
      }
    ]);

    // Host responds to SNAPSHOT_RESYNC_REQUEST with forceFullResync()
    transport.forceFullResync();
    const resyncPost = transport.preparePost(snap3);
    expect(resyncPost.sync).toEqual({ mode: 'full', revision: 4 });
    snapshotStore.apply(resyncPost.message as HostMessage<WorkflowSnapshot>);
    expect(snapshotStore.lastRevision).toBe(4);
    expect(snapshotStore.snapshot?.producedAt).toBe('2026-11-06T00:00:03.000Z');
  });
});
