// Feature 014 T015 — unit tests for the schedule normalizer.
//
// Validates the projection from user-facing strings into the typed
// `NormalizedSchedule` shape, plus the R-07 sub-five-hour warning gate.

import { describe, it, expect } from 'vitest';
import { normalizeSchedule, isSubFiveHourPeriodic } from '../../../src/wakeup/schedule-spec';
import type { WakeUpSettings } from '../../../src/wakeup/settings';

function settings(over: Partial<WakeUpSettings>): WakeUpSettings {
  return {
    enabled: true,
    schedulerType: 'chronological',
    chronologicalTime: '04:00',
    periodicInterval: 'Every 4h',
    model: 'runner-default',
    ...over
  };
}

describe('normalizeSchedule', () => {
  it('chronological → {kind, hour, minute}', () => {
    const r = normalizeSchedule(settings({ chronologicalTime: '23:59' }));
    expect(r).toEqual({ kind: 'chronological', hour: 23, minute: 59 });
  });

  it('chronological pads the hour correctly', () => {
    const r = normalizeSchedule(settings({ chronologicalTime: '04:00' }));
    expect(r).toEqual({ kind: 'chronological', hour: 4, minute: 0 });
  });

  it('periodic → {kind, everyMs}', () => {
    const r = normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every 15m' }));
    expect(r).toEqual({ kind: 'periodic', everyMs: 15 * 60 * 1000 });
  });

  it('throws for invalid chronological string', () => {
    expect(() => normalizeSchedule(settings({ chronologicalTime: '4:00' })))
      .toThrowError(/invalid chronological time/);
  });

  it('throws for invalid periodic string', () => {
    expect(() => normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every soon' })))
      .toThrowError(/invalid periodic interval/);
  });
});

describe('isSubFiveHourPeriodic', () => {
  it('flags Every 15m', () => {
    const s = normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every 15m' }));
    expect(isSubFiveHourPeriodic(s)).toBe(true);
  });

  it('flags Every 4h', () => {
    const s = normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every 4h' }));
    expect(isSubFiveHourPeriodic(s)).toBe(true);
  });

  it('does NOT flag exactly Every 5h', () => {
    const s = normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every 5h' }));
    expect(isSubFiveHourPeriodic(s)).toBe(false);
  });

  it('does NOT flag Every 6h', () => {
    const s = normalizeSchedule(settings({ schedulerType: 'periodic', periodicInterval: 'Every 6h' }));
    expect(isSubFiveHourPeriodic(s)).toBe(false);
  });

  it('does NOT flag chronological', () => {
    const s = normalizeSchedule(settings({ chronologicalTime: '03:30' }));
    expect(isSubFiveHourPeriodic(s)).toBe(false);
  });
});
