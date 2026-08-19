import { describe, expect, it } from 'vitest';
import {
  IDLE_LIVE_ACTIVITY,
  SCHEMA_VERSION,
  buildIdleSnapshot,
  isRecursivePhase
} from '../../../../src/ui/sidebar/snapshot';

// Feature 098 (T083) — the seven-placeholder-tile case is gone, with
// `buildEmptyPhases()` and the two name lists it read. The projector answers an
// empty catalog with zero tiles now (T055), and what replaces this case lives in
// `tests/unit/ui/sidebar/phase-projector.test.ts`: zero tiles paired with the
// import guidance. Nothing here builds a Phase list any more, so there is no
// canonical order left for this file to have an opinion about.

describe('snapshot builders', () => {
  it('exports SCHEMA_VERSION === 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  // Feature 092 (T091/T096) — the per-run singulars (`status`, `phases`,
  // `activeFeature`, `workflowElapsedMs`, `liveActivity`) no longer sit at the
  // snapshot root; they fold under the queue that owns the Run. An idle
  // snapshot has read no registry yet, so it publishes *no* queue rather than a
  // fabricated default one — which is why there is nothing left here to read a
  // singular off of, and why `queues: []` is the assertion that replaces them.
  it('idle snapshot is fully frozen and includes v4 fields', () => {
    const snap = buildIdleSnapshot({ isPrimary: true });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.queues)).toBe(true);
    expect(snap.queues).toEqual([]);
    expect(snap.queue.inFlight).toBeNull();
    expect(snap.queue.pending).toEqual([]);
    expect(snap.queue.recent).toEqual([]);
    expect(snap.queue.paused).toBe(false);
    expect(snap.auditTail).toEqual([]);
    expect(snap.schemaVersion).toBe(4);
    expect(snap.monitor).toBeNull();
    expect(snap.history).toEqual([]);
    expect(typeof snap.producedAt).toBe('string');
  });

  it('idle snapshot honors isPrimary', () => {
    const primary = buildIdleSnapshot({ isPrimary: true });
    const secondary = buildIdleSnapshot({ isPrimary: false });
    expect(primary.isPrimary).toBe(true);
    expect(secondary.isPrimary).toBe(false);
  });

  it('IDLE_LIVE_ACTIVITY is frozen with idle defaults', () => {
    expect(Object.isFrozen(IDLE_LIVE_ACTIVITY)).toBe(true);
    expect(IDLE_LIVE_ACTIVITY).toEqual({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    });
  });

  // Feature 082 (US1, T020) — `pipelineCatalog` is additive and optional, so a
  // snapshot built before the host resolves a catalog still validates at
  // SCHEMA_VERSION 4. The C1-C10 projection guarantees live in
  // `snapshot-composer.test.ts`; this pins only the envelope tolerance.
  it('idle snapshot omits pipelineCatalog without changing SCHEMA_VERSION', () => {
    const snap = buildIdleSnapshot({ isPrimary: true });
    expect(snap.schemaVersion).toBe(4);
    expect('pipelineCatalog' in snap).toBe(false);
    expect(snap.pipelineCatalog).toBeUndefined();
    expect(snap.availablePipelines).toEqual([]);
  });

  // Feature 098 (T080) — this case used to sweep the exported `PHASE_NAMES` and
  // recompute the predicate for each entry, which meant it agreed with
  // `isRecursivePhase` by construction. With that list gone the two ids it
  // recognises are named outright, and a Phase id the operator imported stands as
  // the negative case that matters: the predicate answers on the id alone, and
  // there is no longer a fixed vocabulary for it to consult.
  it('isRecursivePhase identifies clarify and analyze only', () => {
    expect(isRecursivePhase('speckit-clarify')).toBe(true);
    expect(isRecursivePhase('speckit-analyze')).toBe(true);
    for (const name of ['speckit-specify', 'speckit-implement', 'finalize', 'fixture-first']) {
      expect(isRecursivePhase(name)).toBe(false);
    }
  });
});
