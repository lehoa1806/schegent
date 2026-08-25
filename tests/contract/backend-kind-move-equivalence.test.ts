// FR-R3-089 / FR-011 — the identity move is a MOVE, and this is what makes that
// checkable rather than asserted.
//
// WHY THIS TEST EXISTS AND NOT JUST A GREEN SUITE
//
// "No behaviour change" was the acceptance criterion for moving
// `BackendRunnerKind`, `SUPPORTED_BACKENDS`, `DEFAULT_BACKEND` and
// `isBackendRunnerKind` out of `src/runner/backend-runner-factory.ts` into
// `src/contracts/backend-kinds.ts`. A green suite is weak evidence for that: the
// suite would also stay green if the move silently reordered the enum, dropped a
// member from the frozen list, or changed a validator's verdict for an input no
// existing test happens to cover. Pass/fail counts cannot see a property nobody
// asserted — the same observation `scanning-gates-prove-they-scanned.test.ts`
// was built on.
//
// So the expectations below are written as LITERALS, captured from the pre-move
// behaviour. They are deliberately not derived from the module under test: a
// test that reads `SUPPORTED_BACKENDS` and asserts it equals `SUPPORTED_BACKENDS`
// is the "re-asserts the predicate that built its own input" shape that gate
// already catches elsewhere.
//
// WHAT ORDER MEANS HERE. `SUPPORTED_BACKENDS`'s order is observable:
// `containmentByBackend()` builds its Map from it, and the settings enumeration
// projects it. So the order is pinned, not merely the membership.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  isBackendRunnerKind
} from '../../src/contracts/backend-kinds';
import {
  containmentByBackend,
  containmentOf
} from '../../src/services/backend-containment-policy';
import { validatePipelineDefinition } from '../../src/config/pipeline-definition-validator';
import { validatePhaseDefinition } from '../../src/config/process-definition-validator';

/** Captured from the tree before the move. Changing one of these is the finding. */
const PRE_MOVE_BACKENDS = ['claude', 'codex', 'agy'] as const;
const PRE_MOVE_DEFAULT = 'claude';
const PRE_MOVE_CONTAINMENT: ReadonlyArray<readonly [string, string]> = [
  ['claude', 'none'],
  ['codex', 'os-enforced'],
  ['agy', 'none']
];

describe('FR-011 — the backend identity move preserves behaviour', () => {
  it('SUPPORTED_BACKENDS has the same members in the same order', () => {
    expect([...SUPPORTED_BACKENDS]).toEqual([...PRE_MOVE_BACKENDS]);
  });

  it('SUPPORTED_BACKENDS is still frozen, so a caller cannot reorder it in place', () => {
    expect(Object.isFrozen(SUPPORTED_BACKENDS)).toBe(true);
  });

  it('DEFAULT_BACKEND is unchanged', () => {
    expect(DEFAULT_BACKEND).toBe(PRE_MOVE_DEFAULT);
  });

  it('isBackendRunnerKind gives the same verdict for every backend and for rejected values', () => {
    for (const kind of PRE_MOVE_BACKENDS) expect(isBackendRunnerKind(kind)).toBe(true);
    for (const rejected of ['', ' claude', 'CLAUDE', 'gemini', null, undefined, 3, {}, ['claude']]) {
      expect(isBackendRunnerKind(rejected)).toBe(false);
    }
  });

  it('containmentByBackend produces the same map, in the same iteration order', () => {
    expect([...containmentByBackend().entries()]).toEqual(
      PRE_MOVE_CONTAINMENT.map(([kind, verdict]) => [kind, verdict])
    );
    for (const [kind, verdict] of PRE_MOVE_CONTAINMENT) {
      expect(containmentOf(kind as (typeof PRE_MOVE_BACKENDS)[number])).toBe(verdict);
    }
  });

  it('the pipeline validator returns the same verdict for each backend and for a rejected one', () => {
    // The Pipeline carries the backend on `executionDefaults.runner`, which is
    // the site that reads SUPPORTED_BACKENDS (pipeline-definition-validator.ts:493).
    const FIELD = 'executionDefaults.runner';
    const base = {
      pipelineId: 'equivalence-probe',
      name: 'Equivalence probe',
      phases: [{ phaseId: 'a', timeoutSeconds: 60 }]
    };
    for (const kind of PRE_MOVE_BACKENDS) {
      const result = validatePipelineDefinition({ ...base, executionDefaults: { runner: kind } });
      expect(result.errors.filter((error) => error.field === FIELD)).toEqual([]);
    }
    const rejected = validatePipelineDefinition({
      ...base,
      executionDefaults: { runner: 'gemini' }
    });
    expect(rejected.errors.some((error) => error.field === FIELD)).toBe(true);
  });

  it('the phase validator returns the same verdict for each backend and for a rejected one', () => {
    const base = { phaseId: 'equivalence-probe', name: 'Equivalence probe', timeoutSeconds: 60 };
    for (const kind of PRE_MOVE_BACKENDS) {
      const result = validatePhaseDefinition({ ...base, runner: kind });
      expect(result.errors.filter((error) => error.field === 'runner')).toEqual([]);
    }
    const rejected = validatePhaseDefinition({ ...base, runner: 'gemini' });
    expect(rejected.errors.some((error) => error.field === 'runner')).toBe(true);
  });

  it('the literals above are not read from the module under test', () => {
    // A guard against the equivalence check being quietly rewritten into a
    // tautology. If these two ever become the same object the test is vacuous.
    expect(PRE_MOVE_BACKENDS).not.toBe(SUPPORTED_BACKENDS);
  });
});
