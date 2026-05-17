import { describe, expect, it } from 'vitest';
import {
  IDLE_LIVE_ACTIVITY,
  PHASE_NAMES,
  SCHEMA_VERSION,
  buildEmptyPhases,
  buildIdleSnapshot,
  isRecursivePhase
} from '../../../../src/ui/sidebar/snapshot';

describe('snapshot builders', () => {
  it('exports SCHEMA_VERSION === 3', () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it('builds 7 phase tiles in canonical order with v2 fields', () => {
    const phases = buildEmptyPhases();
    expect(phases).toHaveLength(7);
    phases.forEach((tile, idx) => {
      expect(tile.name).toBe(PHASE_NAMES[idx]);
      expect(tile.order).toBe(idx + 1);
      expect(tile.state).toBe('not-started');
      expect(tile.iteration).toBe(0);
      expect(tile.lastResult).toBeNull();
      expect(tile.elapsedMs).toBe(0);
      expect(tile.subProgress).toBeNull();
    });
  });

  it('idle snapshot is fully frozen and includes v3 fields', () => {
    const snap = buildIdleSnapshot({ isPrimary: true });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.phases)).toBe(true);
    expect(snap.status).toBe('idle');
    expect(snap.activeFeature).toBeNull();
    expect(snap.queue.inFlight).toBeNull();
    expect(snap.queue.pending).toEqual([]);
    expect(snap.queue.recent).toEqual([]);
    expect(snap.queue.paused).toBe(false);
    expect(snap.auditTail).toEqual([]);
    expect(snap.schemaVersion).toBe(3);
    expect(snap.workflowElapsedMs).toBeNull();
    expect(snap.monitor).toBeNull();
    expect(snap.history).toEqual([]);
    expect(snap.liveActivity).toEqual(IDLE_LIVE_ACTIVITY);
    expect(snap.liveActivity.freshness).toBe('idle');
    expect(snap.liveActivity.staleSeconds).toBeNull();
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

  it('isRecursivePhase identifies clarify and analyze only', () => {
    for (const name of PHASE_NAMES) {
      const expected = name === 'speckit-clarify' || name === 'speckit-analyze';
      expect(isRecursivePhase(name)).toBe(expected);
    }
  });
});
