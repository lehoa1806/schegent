// Feature FR-R3-006 (T349) — reset clears every key, and the ones it does not
// are decisions rather than omissions.
//
// This is the test the feature exists for. The defect it closes is not that
// `reset()` had a bug — it is that the set of keys reset touched was maintained
// by hand, so the *correct* implementation and the *incomplete* one were the
// same code. `KEYS.executionLeases` (feature 092) and `KEYS.concurrencyNotice`
// (feature 092, FR-037) both shipped and neither reached the clear; an operator
// resetting a workspace to get rid of a stuck per-queue lease kept the lease.
// Nothing failed, because nothing was checking.
//
// So the check is a partition: `RESET_CLEARED_KEYS` and `RESET_EXEMPT_KEYS` must
// together be exactly `KEYS`, with no overlap and nothing left over. Adding a key
// to `KEYS` and to neither list fails here. That is deliberately annoying — it is
// a two-second decision at the point where the person adding the key still knows
// the answer, in place of a silent leak that took two features to notice.
//
// The exemption side is checked as prose, not just as membership: an exempt key
// with no recorded reason is indistinguishable from one someone parked there to
// make this test pass.

import { describe, expect, it } from 'vitest';
import {
  KEYS,
  RESET_CLEARED_KEYS,
  RESET_EXEMPT_KEYS,
  STATE_SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';

class RecordingMemento implements Memento {
  public readonly writes: Array<{ key: string; value: unknown }> = [];
  private readonly map = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.writes.push({ key, value });
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const ALL_KEYS: readonly string[] = Object.values(KEYS);

describe('FR-R3-006 — reset accounts for every state key', () => {
  it('partitions KEYS into cleared and exempt, with nothing missing', () => {
    const accounted = new Set([...RESET_CLEARED_KEYS, ...Object.keys(RESET_EXEMPT_KEYS)]);
    const unaccounted = ALL_KEYS.filter((key) => !accounted.has(key));
    expect(
      unaccounted,
      'every key in KEYS must be cleared by reset or listed in RESET_EXEMPT_KEYS ' +
        'with a recorded reason; a key in neither is silently preserved by a ' +
        'reset the operator was told cleared everything'
    ).toEqual([]);
  });

  it('never lists a key as both cleared and exempt', () => {
    const overlap = RESET_CLEARED_KEYS.filter((key) => key in RESET_EXEMPT_KEYS);
    expect(overlap, 'a key cannot be both cleared and exempt').toEqual([]);
  });

  it('lists no exempt key that is not in KEYS', () => {
    const known = new Set(ALL_KEYS);
    const stale = Object.keys(RESET_EXEMPT_KEYS).filter((key) => !known.has(key));
    expect(
      stale,
      'an exemption for a key that no longer exists is a stale reason nobody will ' +
        'reread; delete it with the key'
    ).toEqual([]);
  });

  it('records a substantive reason for every exemption', () => {
    for (const [key, reason] of Object.entries(RESET_EXEMPT_KEYS)) {
      expect(typeof reason, `${key} must carry a reason string`).toBe('string');
      expect(
        reason.trim().length,
        `${key}'s exemption reason must say why, not merely exist`
      ).toBeGreaterThan(40);
    }
  });

  it('exempts exactly the three keys the design names, and no others', () => {
    // Pinned rather than derived. Widening the exempt set is the one change that
    // silently shrinks what a reset does, so it should be a visible diff here.
    expect(Object.keys(RESET_EXEMPT_KEYS).sort()).toEqual(
      [KEYS.schemaVersion, KEYS.schemaVersionNumeric, KEYS.resetMarker].sort()
    );
  });

  it('clears the two keys the hand-maintained list missed', () => {
    // Named explicitly because they are the regression, not just an example of
    // it. A derivation that stopped deriving would still pass the partition test
    // above if someone re-listed the keys by hand.
    expect(RESET_CLEARED_KEYS).toContain(KEYS.executionLeases);
    expect(RESET_CLEARED_KEYS).toContain(KEYS.concurrencyNotice);
  });

  it('writes undefined to every cleared key when reset runs', async () => {
    const memento = new RecordingMemento();
    // Seed every key so a clear is observable rather than a no-op on an empty
    // store — the pre-feature implementation would also "pass" against an empty
    // memento, since it never had to touch anything.
    for (const key of ALL_KEYS) await memento.update(key, { seeded: true });
    const store = new WorkspaceStateStore(memento);
    memento.writes.length = 0;

    await store.reset();

    for (const key of RESET_CLEARED_KEYS) {
      const cleared = memento.writes.filter((w) => w.key === key && w.value === undefined);
      expect(cleared.length, `${key} must be cleared exactly once`).toBe(1);
      expect(memento.get(key), `${key} must be absent after reset`).toBeUndefined();
    }
  });

  it('leaves the exempt keys readable after reset', async () => {
    const memento = new RecordingMemento();
    for (const key of ALL_KEYS) await memento.update(key, { seeded: true });
    const store = new WorkspaceStateStore(memento);

    const generation = await store.reset();

    // The version keys are re-stamped, not preserved verbatim: a reset workspace
    // is current-schema, and the numeric key is what `initialize()` reads first.
    expect(memento.get(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
    // The marker survives and reads as a finished reset.
    expect(store.getResetMarker()).toEqual({ generation, status: 'complete' });
    expect(memento.get(KEYS.schemaVersion)).not.toBeUndefined();
  });

  it('advances the generation on each reset', async () => {
    const store = new WorkspaceStateStore(new RecordingMemento());
    expect(await store.reset()).toBe(1);
    expect(await store.reset()).toBe(2);
    expect(await store.reset()).toBe(3);
  });
});
