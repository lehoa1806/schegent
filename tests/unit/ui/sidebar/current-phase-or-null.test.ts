// Bug "the phase log that asked for a phase named done" (2026-09-02), third
// finding — one name for a rule that had three independent copies.
//
// `'done'` is a terminal *state* of the phase state machine, not a Phase
// definition. Three projection sites had to know that and each open-coded it:
//
//   projector-bookkeeping.ts  run.currentPhase === 'done' ? null : (run.currentPhase as PhaseName)
//   snapshot-composer.ts:183  run && run.currentPhase !== 'done' ? run.currentPhase : null
//   snapshot-composer.ts:189  run?.currentPhase ?? null                    // <- the drift
//
// Two spellings of one rule, and the third site never got it. That is the
// defect: nothing named the rule, so nothing could be reused or checked. This
// covers the extracted helper directly; the projection-level consequence is
// covered by `terminal-phase-sentinel-projection.test.ts` beside this file.

import { describe, it, expect } from 'vitest';
import { currentPhaseOrNull, phaseNameOrNull } from '../../../../src/ui/sidebar/phase-projector';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import type { Phase } from '../../../../src/controller/phase';

function runAt(currentPhase: Phase): WorkflowRun {
  return { currentPhase } as unknown as WorkflowRun;
}

describe('currentPhaseOrNull', () => {
  it('maps the terminal sentinel to null', () => {
    expect(currentPhaseOrNull(runAt('done'))).toBeNull();
  });

  it('passes a real phase through unchanged', () => {
    expect(currentPhaseOrNull(runAt('speckit-plan'))).toBe('speckit-plan');
  });

  it('treats an absent Run as no phase, so callers need no null dance', () => {
    // Both composer call sites read an optional Run. Folding the null check in
    // is what let those two lines become the same expression rather than two
    // spellings that could drift apart again.
    expect(currentPhaseOrNull(null)).toBeNull();
    expect(currentPhaseOrNull(undefined)).toBeNull();
  });

  it('does not filter a phase merely because its name contains the sentinel', () => {
    // The rule is the exact terminal state, not a substring. An operator-
    // authored catalog can name a phase anything (`PhaseName` is `string` on
    // purpose — see `src/contracts/phase-identity.ts`), and swallowing one
    // would be the same class of defect pointed the other way.
    expect(currentPhaseOrNull(runAt('done-reviewing'))).toBe('done-reviewing');
    expect(currentPhaseOrNull(runAt('predone'))).toBe('predone');
  });
});

describe('phaseNameOrNull', () => {
  // The primitive the four remaining sites were consolidated onto. They did not
  // all hold a Run: `projector-bookkeeping` and `audit-tail-projector` read
  // `entry.phase` off an audit entry, and `phase-projector` reads
  // `run.lastRetryDecision.phase`.

  it('maps the terminal sentinel to null', () => {
    expect(phaseNameOrNull('done')).toBeNull();
  });

  it('maps the empty string to null, because a nameless phase is not a phase', () => {
    // Folded in rather than dropped: every site consolidated here already
    // checked length separately, and `extractPhaseId` in `audit-tail-projector`
    // would otherwise start returning `''` as though it were a phase id.
    expect(phaseNameOrNull('')).toBeNull();
  });

  it('maps an absent phase to null', () => {
    expect(phaseNameOrNull(null)).toBeNull();
    expect(phaseNameOrNull(undefined)).toBeNull();
  });

  it('passes a real phase through unchanged', () => {
    expect(phaseNameOrNull('speckit-implement')).toBe('speckit-implement');
  });
});
