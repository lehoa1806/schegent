// FR-R4-F14 (spec 242, contract V2.3, D2) — which failure cause a `fail` decision carries.
//
// The helper takes closed facts only: the transition's halt cause, whether a fatal signature matched
// (never its text), the outcome and the termination reason. One row per rule of the precedence, and
// the collisions that decide it: a transition cause beats a fatal match, a fatal match beats a
// timeout, and a cause from another vocabulary falls through to `phase_failed`.
import { describe, expect, it } from 'vitest';
import { CAP_EXHAUSTED_CAUSE, PRE_SPAWN_REFUSAL_CAUSE } from '../../../src/audit/audit-payload';
import {
  failureCauseOf,
  type FailDecisionFacts
} from '../../../src/controller/fail-decision-cause';
import {
  INCOMPLETE_TURN_UNRESOLVED_CAUSE,
  LAST_PHASE_ISSUES_REMAIN_CAUSE
} from '../../../src/controller/phase';
import { isFailureCause } from '../../../src/contracts/failure-cause';

function facts(overrides: Partial<FailDecisionFacts> = {}): FailDecisionFacts {
  return {
    decisionCause: undefined,
    fatalMatched: false,
    outcome: 'failed',
    terminationReason: 'error',
    ...overrides
  };
}

describe('failureCauseOf — the sequencer chooses one closed code (D2)', () => {
  it('a cap failure is cap_exhausted, even with a fatal match beside it', () => {
    expect(
      failureCauseOf(facts({ decisionCause: CAP_EXHAUSTED_CAUSE, fatalMatched: true, outcome: 'failed' }))
    ).toBe('cap_exhausted');
  });

  it('a last-phase failure is last_phase_issues_remain', () => {
    expect(
      failureCauseOf(
        facts({
          decisionCause: LAST_PHASE_ISSUES_REMAIN_CAUSE,
          outcome: 'issues_remain',
          terminationReason: 'remaining_issues'
        })
      )
    ).toBe('last_phase_issues_remain');
  });

  it('an unresolved unfinished turn is incomplete_turn_unresolved', () => {
    expect(
      failureCauseOf(
        facts({
          decisionCause: INCOMPLETE_TURN_UNRESOLVED_CAUSE,
          outcome: 'incomplete_turn',
          terminationReason: 'incomplete_turn'
        })
      )
    ).toBe('incomplete_turn_unresolved');
  });

  it('a fatal match on a timed-out phase is fatal_signature (the spec edge case)', () => {
    expect(
      failureCauseOf(facts({ fatalMatched: true, outcome: 'timeout', terminationReason: 'timeout' }))
    ).toBe('fatal_signature');
  });

  it('a fatal match on a failed phase is fatal_signature', () => {
    expect(failureCauseOf(facts({ fatalMatched: true, outcome: 'failed' }))).toBe('fatal_signature');
  });

  it('an idle timeout with no signature is phase_timeout', () => {
    expect(failureCauseOf(facts({ outcome: 'timeout', terminationReason: 'timeout' }))).toBe(
      'phase_timeout'
    );
  });

  it('the absolute deadline, reported as a failed outcome, is phase_timeout (P1)', () => {
    expect(failureCauseOf(facts({ outcome: 'failed', terminationReason: 'deadline' }))).toBe(
      'phase_timeout'
    );
  });

  it('a non-zero exit with nothing else is phase_failed', () => {
    expect(failureCauseOf(facts({ outcome: 'failed', terminationReason: 'error' }))).toBe('phase_failed');
  });

  it('a phase-end cause from another vocabulary falls through to phase_failed (D2)', () => {
    expect(
      failureCauseOf(facts({ decisionCause: PRE_SPAWN_REFUSAL_CAUSE, outcome: 'failed' }))
    ).toBe('phase_failed');
  });

  it('a pause cause is not a member and falls through to phase_failed', () => {
    expect(failureCauseOf(facts({ decisionCause: 'rate_limit', outcome: 'failed' }))).toBe('phase_failed');
  });

  it('always returns a member of the closed vocabulary', () => {
    const decisionCauses = [
      undefined,
      CAP_EXHAUSTED_CAUSE,
      LAST_PHASE_ISSUES_REMAIN_CAUSE,
      INCOMPLETE_TURN_UNRESOLVED_CAUSE,
      PRE_SPAWN_REFUSAL_CAUSE,
      'rate_limit',
      'anything the transition might say next'
    ];
    for (const decisionCause of decisionCauses) {
      for (const fatalMatched of [false, true]) {
        for (const terminationReason of ['error', 'timeout', 'deadline', 'cancel'] as const) {
          const cause = failureCauseOf(facts({ decisionCause, fatalMatched, terminationReason }));
          expect(isFailureCause(cause), `${String(decisionCause)} ${fatalMatched} ${terminationReason}`).toBe(
            true
          );
        }
      }
    }
  });
});
