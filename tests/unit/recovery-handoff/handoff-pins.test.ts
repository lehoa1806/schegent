// FR-R6-F08 T010 — handoff pins (research R4, R5).
//
// WHAT THIS PINS:
//   - `pinPurposeFor` maps every state and the paused flag to its F05 purpose;
//   - pinning a revision adds one protective reference per manifest reference, owned by
//     `('handoff', handoffId)`; a refused pin is recorded with its F05 code and listed;
//   - a refused required pin leaves the handoff `preparing`;
//   - a purpose switch adds the new purpose before releasing the old one, so `isProtected`
//     never turns false between the two;
//   - one F05 slot stays in reserve, so a switch always has room;
//   - a switch interrupted after the add and finished by reconciliation releases only this
//     handoff's keys, never another owner's reference to the same artifact;
//   - `handoffOwnerResolution` returns the R5 table.

import { describe, expect, it } from 'vitest';
import { ARTIFACT_PINS_PER_OWNER_MAX } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  HANDOFF_STATES,
  type HandoffReferenceRole,
  type HandoffState
} from '../../../src/contracts/recovery-handoff/handoff-types';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import {
  handoffOwnerResolution,
  pinPurposeFor,
  pinRevision,
  reconcilePins,
  releaseAll,
  switchPurpose,
  type HandoffPinLifecycle
} from '../../../src/services/recovery-handoff/handoff-pins';
import { createHandoffStore, type SqliteHandoffStore } from '../../../src/services/recovery-handoff/handoff-store';
import { checkpointArtifact, lifecycleFixture, NOW } from '../artifact-lifecycle/lifecycle-fixture';

const HANDOFF_ID = 'a'.repeat(64);
const OTHER_HANDOFF_ID = 'b'.repeat(64);

interface Harness {
  readonly store: SqliteHandoffStore;
  readonly lifecycle: ArtifactLifecycleService;
  readonly conn: ReturnType<typeof lifecycleFixture>['conn'];
}

function harness(): Harness {
  const fixture = lifecycleFixture();
  const lifecycle = fixture.build();
  const store = createHandoffStore(fixture.conn);
  return { store, lifecycle, conn: fixture.conn };
}

function register(h: Harness, ...artifactIds: readonly string[]): void {
  for (const artifactId of artifactIds) {
    const result = h.lifecycle.registerArtifact(checkpointArtifact(artifactId));
    if (!result.ok) throw new Error(`register failed: ${result.refusal.code}`);
  }
}

interface Ref {
  readonly artifactId: string;
  readonly role?: HandoffReferenceRole;
  readonly required?: boolean;
}

function seedRevision(h: Harness, refs: readonly Ref[], handoffId = HANDOFF_ID, revisionNo = 1): void {
  h.store.insertHandoff({
    handoffId,
    workspaceId: 'ws-1',
    rootExecutionId: 'root-1',
    invocationId: 'inv-1',
    sourceAttemptId: handoffId === HANDOFF_ID ? 'att-1' : 'att-9',
    legacyProvenance: null,
    nowMs: NOW
  });
  h.store.insertRevision({
    handoffId,
    revisionNo,
    cutoffKey: String(revisionNo).repeat(64),
    executionRevision: `exec-${revisionNo}`,
    usageRevision: 0,
    factCutoffMs: NOW,
    manifestVersion: 1,
    manifestJson: '{"version":1}',
    manifestDigest: 'd'.repeat(64),
    certainty: 'uncertain',
    coverage: 'partial'
  });
  for (const ref of refs) {
    h.store.insertReference({
      handoffId,
      revisionNo,
      artifactId: ref.artifactId,
      role: ref.role ?? 'validated',
      required: ref.required ?? true,
      expectedDigest: null
    });
  }
}

function deps(h: Harness, lifecycle: HandoffPinLifecycle = h.lifecycle): Parameters<typeof pinRevision>[0] {
  return { store: h.store, lifecycle, nowMs: () => NOW };
}

function activeKeys(h: Harness, artifactId: string): readonly string[] {
  const listed = h.lifecycle.listReferences(artifactId);
  if (!listed.ok) throw new Error(listed.refusal.code);
  return listed.value
    .filter((reference) => reference.active)
    .map((reference) => `${reference.ownerType}:${reference.ownerId}:${reference.purpose}:${String(reference.protective)}`)
    .sort();
}

describe('FR-R6-F08 T010 — pinPurposeFor', () => {
  it('maps every live state to its purpose and every closed state to none', () => {
    const expected: Record<HandoffState, string | null> = {
      preparing: 'pending-handoff',
      ready: 'pending-handoff',
      delivering: 'pending-handoff',
      acknowledged: 'pending-handoff',
      uncertain: 'uncertain-recovery',
      unsupported: 'pending-handoff',
      consumed: null,
      superseded: null
    };
    for (const state of HANDOFF_STATES) {
      expect(pinPurposeFor(state, false), state).toBe(expected[state]);
    }
  });

  it('gives paused-recovery for any paused live state, and none for a paused closed state', () => {
    for (const state of HANDOFF_STATES) {
      const closed = state === 'consumed' || state === 'superseded';
      expect(pinPurposeFor(state, true), state).toBe(closed ? null : 'paused-recovery');
    }
  });
});

describe('FR-R6-F08 T010 — pinRevision', () => {
  it('adds one protective reference per manifest reference, owned by the handoff', () => {
    const h = harness();
    register(h, 'art-1', 'art-2');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2', role: 'partial', required: false }]);

    const result = pinRevision(deps(h), HANDOFF_ID, 1);

    expect(result.refusals).toEqual([]);
    expect(activeKeys(h, 'art-1')).toEqual([`handoff:${HANDOFF_ID}:pending-handoff:true`]);
    expect(activeKeys(h, 'art-2')).toEqual([`handoff:${HANDOFF_ID}:pending-handoff:true`]);
    expect(h.store.listReferences(HANDOFF_ID, 1).map((row) => row.pinState)).toEqual(['pinned', 'pinned']);
    expect(h.store.getHandoff(HANDOFF_ID)?.pinPurpose).toBe('pending-handoff');
    expect(h.lifecycle.isProtected('art-1').protected).toBe(true);
  });

  it('is idempotent: a repeat adds nothing', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    pinRevision(deps(h), HANDOFF_ID, 1);
    pinRevision(deps(h), HANDOFF_ID, 1);
    const listed = h.lifecycle.listReferences('art-1');
    expect(listed.ok && listed.value.length).toBe(1);
  });

  it('records a refused required pin and leaves the handoff preparing', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-unregistered' }]);

    const result = pinRevision(deps(h), HANDOFF_ID, 1);

    expect(result.refusals).toEqual([{ artifactId: 'art-unregistered', required: true, code: 'not-found' }]);
    expect(h.store.getHandoff(HANDOFF_ID)?.state).toBe('preparing');
    const row = h.store.listReferences(HANDOFF_ID, 1).find((ref) => ref.artifactId === 'art-unregistered');
    expect(row?.pinState).toBe('refused');
    expect(row?.pinRefusal).toBe('not-found');
  });

  it('lists a refused optional pin', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-gone', role: 'evidence', required: false }]);

    const result = pinRevision(deps(h), HANDOFF_ID, 1);

    expect(result.refusals).toEqual([{ artifactId: 'art-gone', required: false, code: 'not-found' }]);
  });

  it('keeps one F05 slot in reserve, pinning required references first', () => {
    const h = harness();
    const ids = Array.from({ length: ARTIFACT_PINS_PER_OWNER_MAX }, (_, index) => `art-${String(index).padStart(2, '0')}`);
    register(h, ...ids);
    // The optional reference sorts first; the required ones still take the slots before it.
    seedRevision(
      h,
      ids.map((artifactId, index) => ({ artifactId, required: index !== 0 }))
    );

    const result = pinRevision(deps(h), HANDOFF_ID, 1);

    expect(result.refusals).toEqual([{ artifactId: 'art-00', required: false, code: 'pin-quota-reached' }]);
    const pinned = h.store.listReferences(HANDOFF_ID, 1).filter((row) => row.pinState === 'pinned');
    expect(pinned).toHaveLength(ARTIFACT_PINS_PER_OWNER_MAX - 1);
  });
});

describe('FR-R6-F08 T010 — switchPurpose', () => {
  it('adds the new purpose before releasing the old one: isProtected never turns false', () => {
    const h = harness();
    register(h, 'art-1', 'art-2');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2', required: false }]);
    pinRevision(deps(h), HANDOFF_ID, 1);

    const observed: boolean[] = [];
    const calls: string[] = [];
    const watch = (): void => {
      observed.push(h.lifecycle.isProtected('art-1').protected, h.lifecycle.isProtected('art-2').protected);
    };
    const spy: HandoffPinLifecycle = {
      addReference: (input) => {
        calls.push(`add:${input.artifactId}:${input.purpose}`);
        const result = h.lifecycle.addReference(input);
        watch();
        return result;
      },
      releaseReference: (input) => {
        calls.push(`release:${input.artifactId}:${input.purpose}`);
        const result = h.lifecycle.releaseReference(input);
        watch();
        return result;
      }
    };

    const result = switchPurpose(deps(h, spy), HANDOFF_ID, 'uncertain-recovery');

    expect(result.complete).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(Boolean)).toBe(true);
    for (const artifactId of ['art-1', 'art-2']) {
      expect(calls.indexOf(`add:${artifactId}:uncertain-recovery`)).toBeLessThan(
        calls.indexOf(`release:${artifactId}:pending-handoff`)
      );
      expect(activeKeys(h, artifactId)).toEqual([`handoff:${HANDOFF_ID}:uncertain-recovery:true`]);
    }
    const handoff = h.store.getHandoff(HANDOFF_ID);
    expect(handoff?.pinPurpose).toBe('uncertain-recovery');
    expect(handoff?.pinPurposeTarget).toBeNull();
  });

  it('completes a switch with the reserve in use', () => {
    const h = harness();
    const ids = Array.from({ length: ARTIFACT_PINS_PER_OWNER_MAX - 1 }, (_, index) => `art-${String(index)}`);
    register(h, ...ids);
    seedRevision(
      h,
      ids.map((artifactId) => ({ artifactId }))
    );
    pinRevision(deps(h), HANDOFF_ID, 1);

    const result = switchPurpose(deps(h), HANDOFF_ID, 'paused-recovery');

    expect(result.complete).toBe(true);
    expect(ids.every((artifactId) => activeKeys(h, artifactId).length === 1)).toBe(true);
    expect(activeKeys(h, ids.at(0) ?? '')).toEqual([`handoff:${HANDOFF_ID}:paused-recovery:true`]);
  });

  it('is a no-op when the purpose is already the target', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    pinRevision(deps(h), HANDOFF_ID, 1);
    const result = switchPurpose(deps(h), HANDOFF_ID, 'pending-handoff');
    expect(result.complete).toBe(true);
    expect(activeKeys(h, 'art-1')).toEqual([`handoff:${HANDOFF_ID}:pending-handoff:true`]);
  });
});

describe('FR-R6-F08 T010 — reconcilePins', () => {
  it('finishes a switch interrupted after the add, releasing only this handoff keys', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    seedRevision(h, [{ artifactId: 'art-1' }], OTHER_HANDOFF_ID);
    pinRevision(deps(h), HANDOFF_ID, 1);
    pinRevision(deps(h), OTHER_HANDOFF_ID, 1);
    const runPin = h.lifecycle.addReference({
      artifactId: 'art-1',
      ownerType: 'run',
      ownerId: 'run-1',
      purpose: 'pending-handoff',
      protective: true
    });
    expect(runPin.ok).toBe(true);

    // Interrupted: the target is recorded and its pin added; the old pin is not yet released.
    h.store.updateHandoff(HANDOFF_ID, { pinPurposeTarget: 'uncertain-recovery' }, NOW);
    h.lifecycle.addReference({
      artifactId: 'art-1',
      ownerType: 'handoff',
      ownerId: HANDOFF_ID,
      purpose: 'uncertain-recovery',
      protective: true
    });

    const result = reconcilePins(deps(h), HANDOFF_ID);

    expect(result.switchFinished).toBe(true);
    expect(activeKeys(h, 'art-1')).toEqual([
      `handoff:${OTHER_HANDOFF_ID}:pending-handoff:true`,
      `handoff:${HANDOFF_ID}:uncertain-recovery:true`,
      'run:run-1:pending-handoff:true'
    ].sort());
    expect(h.store.getHandoff(HANDOFF_ID)?.pinPurposeTarget).toBeNull();
    expect(h.store.getHandoff(HANDOFF_ID)?.pinPurpose).toBe('uncertain-recovery');
  });

  it('retries a refused pin once its artifact exists', () => {
    const h = harness();
    seedRevision(h, [{ artifactId: 'art-late' }]);
    expect(pinRevision(deps(h), HANDOFF_ID, 1).refusals).toHaveLength(1);
    register(h, 'art-late');

    const result = reconcilePins(deps(h), HANDOFF_ID);

    expect(result.pinsRetried).toBe(1);
    expect(h.store.listReferences(HANDOFF_ID, 1).at(0)?.pinState).toBe('pinned');
    expect(h.store.listReferences(HANDOFF_ID, 1).at(0)?.pinRefusal).toBeNull();
  });

  it('releases every pin of a closed handoff left behind by an interrupted close', () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    pinRevision(deps(h), HANDOFF_ID, 1);
    h.store.updateHandoff(HANDOFF_ID, { state: 'consumed', closedReason: 'delivered' }, NOW);

    reconcilePins(deps(h), HANDOFF_ID);

    expect(activeKeys(h, 'art-1')).toEqual([]);
    expect(h.store.listReferences(HANDOFF_ID, 1).at(0)?.pinState).toBe('released');
  });
});

describe('FR-R6-F08 T010 — releaseAll', () => {
  it('releases every purpose this handoff holds and leaves another owner alone', () => {
    const h = harness();
    register(h, 'art-1', 'art-2');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2' }]);
    seedRevision(h, [{ artifactId: 'art-1' }], OTHER_HANDOFF_ID);
    pinRevision(deps(h), HANDOFF_ID, 1);
    pinRevision(deps(h), OTHER_HANDOFF_ID, 1);
    h.store.updateHandoff(HANDOFF_ID, { pinPurposeTarget: 'paused-recovery' }, NOW);
    h.lifecycle.addReference({
      artifactId: 'art-2',
      ownerType: 'handoff',
      ownerId: HANDOFF_ID,
      purpose: 'paused-recovery',
      protective: true
    });

    releaseAll(deps(h), HANDOFF_ID);

    expect(activeKeys(h, 'art-1')).toEqual([`handoff:${OTHER_HANDOFF_ID}:pending-handoff:true`]);
    expect(activeKeys(h, 'art-2')).toEqual([]);
    expect(h.store.listReferences(HANDOFF_ID, 1).map((row) => row.pinState)).toEqual(['released', 'released']);
    expect(h.store.getHandoff(HANDOFF_ID)?.pinPurposeTarget).toBeNull();
  });
});

describe('FR-R6-F08 T010 — handoffOwnerResolution (R5)', () => {
  it('returns live for every non-closed state, settled for closed ones, unresolved for an unknown id', () => {
    const h = harness();
    seedRevision(h, []);
    const expected: Record<HandoffState, string> = {
      preparing: 'live',
      ready: 'live',
      delivering: 'live',
      acknowledged: 'live',
      uncertain: 'live',
      unsupported: 'live',
      consumed: 'settled',
      superseded: 'settled'
    };
    for (const state of HANDOFF_STATES) {
      const closedReason = expected[state] === 'settled' ? 'delivered' : null;
      h.conn.run(
        'UPDATE recovery_handoffs SET state = ?, closed_reason = ?, paused = 0 WHERE handoff_id = ?',
        state,
        closedReason,
        HANDOFF_ID
      );
      expect(handoffOwnerResolution(h.conn, HANDOFF_ID), state).toBe(expected[state]);
    }
    h.conn.run(`UPDATE recovery_handoffs SET state = 'ready', paused = 1 WHERE handoff_id = ?`, HANDOFF_ID);
    expect(handoffOwnerResolution(h.conn, HANDOFF_ID)).toBe('live');
    expect(handoffOwnerResolution(h.conn, 'z'.repeat(64))).toBe('unresolved');
  });

  it('returns unresolved for every id on a store written by a newer build', () => {
    const h = harness();
    seedRevision(h, []);
    h.conn.run(
      `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (99, 'future', ?, ?)`,
      'f'.repeat(64),
      NOW
    );
    expect(handoffOwnerResolution(h.conn, HANDOFF_ID)).toBe('unresolved');
  });
});
