import { describe, expect, it } from 'vitest';
import { buildMutationPlan, mutationPlanIsApproved } from '../../../src/services/mutation-plan';

describe('mutation plan', () => {
  const pipeline = {
    id: 'p', name: 'P', phases: [
      { id: 'read', name: 'Read', instruction: 'x', sideEffects: 'none' as const },
      { id: 'git', name: 'Git', instruction: 'x', sideEffects: 'git' as const }
    ]
  };

  it('fingerprints execution-relevant fields deterministically', () => {
    const a = buildMutationPlan(pipeline, 1);
    const b = buildMutationPlan(pipeline, 2);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.gitCapablePhaseIds).toEqual(['git']);
  });

  // Feature 098 (FR-005) made `workspace` the default a Phase takes when it
  // declares no `sideEffects`, and the `gitCapablePhaseIds` filter above reads
  // an omission that way. The canonical form did not: it substituted
  // `unrestricted`, the pre-098 default for an unrecognised Phase.
  //
  // The consequence is not a wrong containment class — nothing reads the
  // canonical string for policy — but a fingerprint that stops identifying the
  // plan it names. Two Pipelines with different `gitCapablePhaseIds` hashed
  // identically, and the fingerprint is the whole basis on which a stored
  // approval receipt is still deemed to apply.
  describe('an omitted sideEffects is the workspace default, not unrestricted', () => {
    const omitted = {
      id: 'p', name: 'P', phases: [{ id: 'a', name: 'A', instruction: 'x' }]
    };
    const unrestricted = {
      id: 'p', name: 'P',
      phases: [{ id: 'a', name: 'A', instruction: 'x', sideEffects: 'unrestricted' as const }]
    };
    const workspace = {
      id: 'p', name: 'P',
      phases: [{ id: 'a', name: 'A', instruction: 'x', sideEffects: 'workspace' as const }]
    };

    it('does not give the omission the same fingerprint as an explicit unrestricted', () => {
      // These two plans differ in `gitCapablePhaseIds`, so they must differ in
      // the value that stands for the plan's identity.
      const a = buildMutationPlan(omitted, 1);
      const b = buildMutationPlan(unrestricted, 1);
      expect(a.gitCapablePhaseIds).toEqual([]);
      expect(b.gitCapablePhaseIds).toEqual(['a']);
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it('gives the omission the same fingerprint as an explicit workspace', () => {
      // The other half: the default and the declaration of that default are the
      // same plan, so an operator who writes it out explicitly does not
      // invalidate an approval they already granted.
      expect(buildMutationPlan(omitted, 1).fingerprint).toBe(
        buildMutationPlan(workspace, 1).fingerprint
      );
    });
  });

  it('rejects a receipt from a different frozen plan', () => {
    const plan = buildMutationPlan(pipeline, 1);
    expect(mutationPlanIsApproved(plan, {
      approvedAt: 1, planFingerprint: 'different', approvedPhaseIds: ['git']
    })).toBe(false);
    expect(mutationPlanIsApproved(plan, {
      approvedAt: 1, planFingerprint: plan.fingerprint, approvedPhaseIds: ['git']
    })).toBe(true);
  });
});
