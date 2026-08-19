// Feature 098 T009 — the Git-runner rule keys on the declared class
// (FR-007, FR-008, SC-006, spec §Edge Cases).
//
// The module had no test file before this one. What it had was a five-id set,
// `GIT_METADATA_WRITE_PHASE_IDS`, and a rule that read: if the Phase is one of
// these five, its runner must be Git-capable. Two things were wrong with that
// once the built-in layer goes away. A Phase that genuinely writes Git metadata
// under any other id was unprotected — the rule could not see it, so an
// operator's imported commit Phase would run under a Codex workspace-write
// sandbox with `.git` read-only and fail mid-run. And the five ids themselves
// stopped meaning anything, because nothing ships them any more.
//
// So the rule now asks the Phase what it does. Every positive case below uses
// an id the product does not recognise, and the negative case uses `finalize` —
// one of the five the set used to claim — declaring a class that is not `git`.
// A reintroduced id list fails the negative case; a rule that ignored the
// declaration fails the positive ones.
//
// The last describe covers the asymmetry the spec's Edge Cases section names:
// the save-time gates return early when a Phase declares no runner of its own,
// so a `git` Phase with no declared runner reaches launch unrefused and the
// launch-time binding is the only place the combination is caught.

import { describe, expect, it } from 'vitest';
import {
  assertPhaseRunnerPolicy,
  phaseRunnerPolicyError
} from '../../../src/config/phase-runner-policy';
import type { PhaseSideEffects } from '../../../src/contracts/process-definitions';
import type { BackendRunnerKind } from '../../../src/runner/backend-runner-factory';

/** An id no list ever claimed, so only the declaration can drive the verdict. */
const UNKNOWN_ID = 'fixture-commit-phase';

/** The runners that can write `.git`; the rest keep it read-only. */
const GIT_CAPABLE: readonly BackendRunnerKind[] = ['claude', 'agy'];
const NOT_GIT_CAPABLE: readonly BackendRunnerKind[] = ['codex'];

describe('phaseRunnerPolicyError — refuses on the declared class (FR-007)', () => {
  it.each(NOT_GIT_CAPABLE)(
    'refuses a Phase declaring git under an unrecognised id with the %s runner',
    (runner) => {
      const message = phaseRunnerPolicyError(UNKNOWN_ID, 'git', runner);
      expect(message).not.toBeNull();
      expect(message).toContain(UNKNOWN_ID);
      expect(message).toContain('Git-capable');
    }
  );

  it.each(GIT_CAPABLE)('admits a Phase declaring git with the %s runner', (runner) => {
    expect(phaseRunnerPolicyError(UNKNOWN_ID, 'git', runner)).toBeNull();
  });

  it.each(['none', 'workspace', 'unrestricted'] as const)(
    'admits a Phase declaring %s with a runner that cannot write .git',
    (sideEffects) => {
      expect(phaseRunnerPolicyError(UNKNOWN_ID, sideEffects, 'codex')).toBeNull();
    }
  );

  it('admits a Phase that declares nothing, because the default is workspace', () => {
    expect(phaseRunnerPolicyError(UNKNOWN_ID, undefined, 'codex')).toBeNull();
  });
});

describe('phaseRunnerPolicyError — the id carries no authority (FR-008, SC-006)', () => {
  it('does not refuse `finalize` when it declares no Git side effects', () => {
    // `finalize` was in `GIT_METADATA_WRITE_PHASE_IDS`. Under the id-based rule
    // this combination was refused; under the declaration-based rule the id is
    // just a name and the Phase is admitted.
    expect(phaseRunnerPolicyError('finalize', 'workspace', 'codex')).toBeNull();
  });

  it.each(['speckit-specify', 'specify-brainstorm', 'superpowers-implement', 'finalize',
    'superpowers-review-close'])(
    'does not refuse the formerly-listed id %s on its name alone',
    (phaseId) => {
      expect(phaseRunnerPolicyError(phaseId, 'workspace', 'codex')).toBeNull();
      expect(phaseRunnerPolicyError(phaseId, undefined, 'codex')).toBeNull();
    }
  );

  it('refuses the same formerly-listed id once it declares git', () => {
    expect(phaseRunnerPolicyError('finalize', 'git', 'codex')).not.toBeNull();
  });

  it('reaches the same verdict for two ids declaring the same class', () => {
    const listed = phaseRunnerPolicyError('finalize', 'git', 'codex');
    const unlisted = phaseRunnerPolicyError(UNKNOWN_ID, 'git', 'codex');
    expect(listed === null).toBe(unlisted === null);
  });
});

describe('assertPhaseRunnerPolicy — the launch-time binding point (spec §Edge Cases)', () => {
  it('throws when a git Phase is bound to a runner that cannot write .git', () => {
    expect(() => assertPhaseRunnerPolicy(UNKNOWN_ID, 'git', 'codex')).toThrow(/Git-capable/);
  });

  it('does not throw for the same Phase bound to a Git-capable runner', () => {
    for (const runner of GIT_CAPABLE) {
      expect(() => assertPhaseRunnerPolicy(UNKNOWN_ID, 'git', runner)).not.toThrow();
    }
  });

  it('catches the combination the save gates cannot see', () => {
    // Both save-side gates (`process-catalog.ts` parseLayer and
    // `cmd-save-phases.ts`) return early when `definition.runner === undefined`,
    // so a Phase declaring `git` and no runner is saved without a verdict. At
    // launch the runner is resolved from the global default, and this is the
    // only place the resulting pair is checked.
    const resolvedFromGlobalDefault: BackendRunnerKind = 'codex';
    const declared: PhaseSideEffects = 'git';
    expect(() =>
      assertPhaseRunnerPolicy(UNKNOWN_ID, declared, resolvedFromGlobalDefault)
    ).toThrow(/Git-capable/);
  });

  it('does not throw for a Phase declaring nothing under any runner', () => {
    for (const runner of [...GIT_CAPABLE, ...NOT_GIT_CAPABLE]) {
      expect(() => assertPhaseRunnerPolicy(UNKNOWN_ID, undefined, runner)).not.toThrow();
    }
  });
});
