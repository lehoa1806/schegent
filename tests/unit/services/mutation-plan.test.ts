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
