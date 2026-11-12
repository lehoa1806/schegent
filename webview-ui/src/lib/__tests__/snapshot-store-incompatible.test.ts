// Review gap GC-16 (2026-11-12).
//
// WHAT THIS PINS:
//   - a snapshot the view cannot read (an unknown `schemaVersion`, or `queues` that is not an
//     array) is recorded where a surface can show it, not only in a `console.warn` nobody sees;
//     the view used to freeze on its last state, or on "Connecting", with no message at all;
//   - the next readable snapshot clears it, and so does a sync reset;
//   - the store holds the snapshot it was given, not a deep reactive proxy of it: snapshots are
//     replaced whole and never mutated, so a deep proxy only costs a wrapper per nested read.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIdleSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { resetHostTransport, setHostTransport } from '../host-transport';
import { STATE_SNAPSHOT, type HostMessage } from '../messages';
import { snapshotStore } from '../snapshot-store.svelte';
import type { WorkflowSnapshot } from '../snapshot-types';

const PRODUCED_AT = '2026-11-12T00:00:00.000Z';
const FUTURE_SCHEMA_VERSION = 99;

function idle(): WorkflowSnapshot {
  return buildIdleSnapshot({ isPrimary: true, producedAt: PRODUCED_AT }) as unknown as WorkflowSnapshot;
}

function full(payload: WorkflowSnapshot, revision: number): HostMessage<WorkflowSnapshot> {
  return { type: STATE_SNAPSHOT, payload, sync: { mode: 'full', revision } };
}

beforeEach(() => {
  snapshotStore.resetSyncState();
  resetHostTransport();
  setHostTransport({
    postMessage() {},
    onMessage() {
      return () => {};
    },
    getState() {
      return undefined;
    },
    setState() {}
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GC-16 — a snapshot the view cannot read is visible', () => {
  it('records an unknown schema version, and the view is not ready', () => {
    snapshotStore.apply(full({ ...idle(), schemaVersion: FUTURE_SCHEMA_VERSION } as unknown as WorkflowSnapshot, 1));

    expect(snapshotStore.isReady).toBe(false);
    expect(snapshotStore.incompatibleSnapshot).toEqual({ reason: 'unknown-schema', schemaVersion: String(FUTURE_SCHEMA_VERSION) });
  });

  it('records malformed queues', () => {
    snapshotStore.apply(full({ ...idle(), queues: 'not-a-list' } as unknown as WorkflowSnapshot, 1));

    expect(snapshotStore.incompatibleSnapshot).toEqual({ reason: 'malformed-queues', schemaVersion: null });
  });

  it('keeps the last readable snapshot on screen while it records the unreadable one', () => {
    snapshotStore.apply(full(idle(), 1));
    snapshotStore.apply(full({ ...idle(), schemaVersion: FUTURE_SCHEMA_VERSION } as unknown as WorkflowSnapshot, 2));

    expect(snapshotStore.isReady).toBe(true);
    expect(snapshotStore.incompatibleSnapshot?.reason).toBe('unknown-schema');
  });

  it('clears on the next readable snapshot', () => {
    snapshotStore.apply(full({ ...idle(), schemaVersion: FUTURE_SCHEMA_VERSION } as unknown as WorkflowSnapshot, 1));
    snapshotStore.apply(full(idle(), 2));

    expect(snapshotStore.incompatibleSnapshot).toBeNull();
    expect(snapshotStore.isReady).toBe(true);
  });

  it('clears on a sync reset', () => {
    snapshotStore.apply(full({ ...idle(), schemaVersion: FUTURE_SCHEMA_VERSION } as unknown as WorkflowSnapshot, 1));
    snapshotStore.resetSyncState();

    expect(snapshotStore.incompatibleSnapshot).toBeNull();
  });

  it('bounds a hostile schema version before it reaches the screen', () => {
    snapshotStore.apply(full({ ...idle(), schemaVersion: 'x'.repeat(500) } as unknown as WorkflowSnapshot, 1));

    expect(snapshotStore.incompatibleSnapshot?.schemaVersion?.length).toBeLessThanOrEqual(32);
  });
});

describe('GC-16 — the store holds the snapshot, not a deep proxy of it', () => {
  it('returns the nested arrays it was given', () => {
    const payload = idle();

    snapshotStore.apply(full(payload, 1));

    expect(snapshotStore.snapshot?.queues).toBe(payload.queues);
    expect(snapshotStore.snapshot?.history).toBe(payload.history);
  });
});
