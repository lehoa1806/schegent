import { describe, expect, it } from 'vitest';
import { snapshotStore } from '../snapshot-store.svelte';
import { CMD_ACK, STATE_SNAPSHOT } from '../messages';

/**
 * FR-R3-106 (FR-071) — an unrelated snapshot leaves a pending command pending, and only its
 * own acknowledgement clears it.
 *
 * THE DEFECT. `applySnapshot` ended with `if (this._pending.size > 0) this._pending = new
 * Set()` — any accepted snapshot wiped the ENTIRE pending set with no correlation
 * filtering. Snapshots arrive on a 1 Hz tick as well as on real state changes, so a tick
 * that had nothing to do with an in-flight command re-enabled its button before the
 * mutation landed. The operator sees a control go live again and reasonably clicks it
 * twice — on a destructive action, twice is the problem.
 *
 * The targeted `clearPending(correlationId)` already existed eight lines above this code.
 * The snapshot path simply did not use it.
 *
 * Nothing here corrupts state: the host's own detection and persistence were unaffected
 * throughout. What was broken is the display's correspondence to what the run was doing,
 * which is the whole of what this item is about.
 */
const SCHEMA_VERSION = 4;

/** The minimum a snapshot needs to be accepted by the store's guards. */
const snapshot = (over: Record<string, unknown> = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  queues: [],
  ...over
});

describe('FR-R3-106 — a pending command survives an unrelated snapshot', () => {
  it('the snapshot messages below are actually ACCEPTED, not ignored for the wrong reason', () => {
    // Authoring this file the first time, the snapshot messages carried `type: 'snapshot'`
    // and a `snapshot:` field. The store ignores an unknown type outright, so every
    // "a pending command survived" assertion passed while the store never looked at the
    // message at all — a test that proved nothing and looked green. This asserts the
    // message really lands, so the survival assertions mean what they say.
    snapshotStore.apply({ type: STATE_SNAPSHOT, payload: snapshot({ queues: [] }) } as never);
    expect(snapshotStore.snapshot, 'the snapshot must have been accepted').not.toBeNull();
  });

  it('a tick snapshot does not clear a pending command', () => {
    snapshotStore.markPending('corr-a');
    expect(snapshotStore.isPending('corr-a')).toBe(true);

    // The 1 Hz tick: a perfectly valid snapshot that resolves nothing.
    snapshotStore.apply({ type: STATE_SNAPSHOT, payload: snapshot() } as never);

    expect(
      snapshotStore.isPending('corr-a'),
      'a snapshot carries no correlation id, so it cannot say which command it resolves'
    ).toBe(true);
  });

  it('the command own acknowledgement clears it', () => {
    snapshotStore.markPending('corr-b');
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: 'corr-b',
      status: 'ok'
    } as never);
    expect(snapshotStore.isPending('corr-b')).toBe(false);
  });

  it('an acknowledgement for a DIFFERENT command leaves this one pending', () => {
    snapshotStore.markPending('corr-c');
    snapshotStore.markPending('corr-d');
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: 'corr-c',
      status: 'ok'
    } as never);
    expect(snapshotStore.isPending('corr-c')).toBe(false);
    expect(snapshotStore.isPending('corr-d'), 'only the acknowledged command clears').toBe(true);
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: 'corr-d',
      status: 'ok'
    } as never);
  });

  it('many snapshots in a row still leave a pending command pending', () => {
    // The realistic shape of the defect: a mutation in flight while ticks keep arriving.
    snapshotStore.markPending('corr-e');
    for (let i = 0; i < 10; i++) {
      snapshotStore.apply({ type: STATE_SNAPSHOT, payload: snapshot() } as never);
    }
    expect(snapshotStore.isPending('corr-e')).toBe(true);
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: 'corr-e',
      status: 'ok'
    } as never);
    expect(snapshotStore.isPending('corr-e')).toBe(false);
  });

  it('a REJECTED snapshot also leaves pendings alone', () => {
    // The rejection paths return early, so they never reached the wipe; asserted so a
    // future edit cannot add one there.
    snapshotStore.markPending('corr-f');
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: { schemaVersion: 999, queues: [] }
    } as never);
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: { schemaVersion: SCHEMA_VERSION, queues: 'not-an-array' }
    } as never);
    expect(snapshotStore.isPending('corr-f')).toBe(true);
    snapshotStore.apply({
      type: CMD_ACK,
      correlationId: 'corr-f',
      status: 'ok'
    } as never);
  });
});
