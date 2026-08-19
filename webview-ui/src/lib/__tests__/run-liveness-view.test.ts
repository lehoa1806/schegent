// FR-R3-008 (T380) — absent is unknown, never zero.
//
// The acceptance criterion covers the render half explicitly: a Run whose record
// predates the feature must show these two readings as unknown, not as `0s ago`
// and not as `0%`. Both of those pass a naive "it renders" check while being
// actively misleading — `0s ago` reads as *just now*, which is the opposite of
// what an absent stamp means, and `0%` reads as a measured lack of progress. So
// the rule lives in one helper and this file pins it.

import { describe, expect, it } from 'vitest';
import {
  deriveRunLivenessView,
  deriveRunProgressView,
  UNKNOWN_LABEL
} from '../run-liveness-view';

const NOW = Date.parse('2026-05-10T12:00:00.000Z');

describe('deriveRunLivenessView', () => {
  it('reports unknown for a record that carries no stamp', () => {
    for (const absent of [null, undefined]) {
      const view = deriveRunLivenessView(absent, NOW);
      expect(view.known).toBe(false);
      expect(view.label).toBe(UNKNOWN_LABEL);
      // Not "0s ago", which would read as activity a moment ago.
      expect(view.label).not.toMatch(/0s/);
      expect(view.detail).toBe('');
    }
  });

  it('reports the age of a stamp it does have', () => {
    const view = deriveRunLivenessView(
      {
        lastActivityAt: new Date(NOW - 134_000).toISOString(),
        stdoutLines: 1204,
        stderrLines: 3
      },
      NOW
    );
    expect(view.known).toBe(true);
    expect(view.label).toBe('last output 2m 14s ago');
    expect(view.detail).toBe('1204 stdout / 3 stderr lines this phase');
  });

  it('distinguishes a run that is working from one that is hung', () => {
    const working = deriveRunLivenessView(
      { lastActivityAt: new Date(NOW - 4_000).toISOString(), stdoutLines: 90, stderrLines: 0 },
      NOW
    );
    const hung = deriveRunLivenessView(
      {
        lastActivityAt: new Date(NOW - 3.6 * 60 * 60 * 1_000).toISOString(),
        stdoutLines: 90,
        stderrLines: 0
      },
      NOW
    );
    expect(working.label).toBe('last output 4s ago');
    expect(hung.label).toBe('last output 3h 36m ago');
    expect(working.label).not.toBe(hung.label);
  });

  it('floors a stamp from the future rather than showing a negative age', () => {
    const view = deriveRunLivenessView(
      { lastActivityAt: new Date(NOW + 5_000).toISOString(), stdoutLines: 1, stderrLines: 0 },
      NOW
    );
    expect(view.label).toBe('last output 0s ago');
    expect(view.known).toBe(true);
  });

  it('reports unknown for a stamp it cannot parse', () => {
    const view = deriveRunLivenessView(
      { lastActivityAt: 'not a date', stdoutLines: 1, stderrLines: 0 },
      NOW
    );
    expect(view.known).toBe(false);
    expect(view.label).toBe(UNKNOWN_LABEL);
  });
});

describe('deriveRunProgressView', () => {
  it('reports unknown for a record with no total', () => {
    for (const absent of [null, undefined]) {
      const view = deriveRunProgressView(absent);
      expect(view.known).toBe(false);
      expect(view.label).toBe(UNKNOWN_LABEL);
      // `null`, not `0` — a meter drawn at zero width is a measurement claim.
      expect(view.percent).toBeNull();
      expect(view.detail).toBe('');
    }
  });

  it('reports the fraction the host computed, without recomputing it', () => {
    const view = deriveRunProgressView({
      phasesCompleted: 3,
      phaseCount: 7,
      iterationCap: 5,
      maxPhaseInvocations: 11,
      // Deliberately not 3/7 — the host owns the arithmetic, and this side must
      // publish what it was given rather than quietly disagreeing with it.
      percent: 43
    });
    expect(view.label).toBe('3 of 7 phases (43%)');
    expect(view.percent).toBe(43);
    expect(view.detail).toBe("up to 11 invocations at this run's frozen cap of 5");
  });

  it('says phase rather than phases for a single-phase plan', () => {
    const view = deriveRunProgressView({
      phasesCompleted: 0,
      phaseCount: 1,
      iterationCap: 10,
      maxPhaseInvocations: 1,
      percent: 0
    });
    expect(view.label).toBe('0 of 1 phase (0%)');
    // 0% is a *known* reading here: the plan has one phase and it has not run.
    expect(view.known).toBe(true);
    expect(view.percent).toBe(0);
  });

  it('clamps a percent outside 0..100 rather than drawing past the end', () => {
    const over = deriveRunProgressView({
      phasesCompleted: 9,
      phaseCount: 4,
      iterationCap: 5,
      maxPhaseInvocations: 8,
      percent: 225
    });
    expect(over.percent).toBe(100);
    const under = deriveRunProgressView({
      phasesCompleted: 0,
      phaseCount: 4,
      iterationCap: 5,
      maxPhaseInvocations: 8,
      percent: -12
    });
    expect(under.percent).toBe(0);
  });

  it('reports unknown for a percent it cannot use', () => {
    const view = deriveRunProgressView({
      phasesCompleted: 1,
      phaseCount: 4,
      iterationCap: 5,
      maxPhaseInvocations: 8,
      percent: Number.NaN
    });
    expect(view.known).toBe(false);
    expect(view.percent).toBeNull();
  });
});
