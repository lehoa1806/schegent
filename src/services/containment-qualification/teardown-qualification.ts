// FR-R6-F09 (FR-009, FR-010; research R12) -- the teardown ladder's result, stated in the
// qualification vocabulary.
//
// NO NEW MECHANISM. The ladder and its host observations stand; this only names what each result
// proves. A confirmed group exit always carries `descendants-outside-group-undetectable`, because a
// descendant that left the process group is invisible to the host, so no outcome claims that every
// descendant is gone.
//
// NO RELEASE WORD. The vocabulary has no outcome that means "the tree is gone, redispatch". An
// elapsed bound is a residual, never a confirmation, so time alone cannot turn uncertainty into
// permission (FR-010); recovery stays occupied as it already does.

import type { TreeTeardownResult } from '../../contracts/backend-runner';
import type { TeardownQualification } from '../../contracts/containment-qualification';

function qualification(
  outcome: TeardownQualification['outcome'],
  residuals: TeardownQualification['residuals']
): TeardownQualification {
  return Object.freeze({ outcome, residuals: Object.freeze([...residuals]) });
}

const BY_LADDER_RESULT: Readonly<Record<TreeTeardownResult, TeardownQualification>> = Object.freeze({
  'group-gone': qualification('group-exit-confirmed', ['descendants-outside-group-undetectable']),
  'tree-unconfirmed': qualification('residual', ['group-survived']),
  'bound-elapsed': qualification('residual', ['bound-elapsed']),
  'platform-unanswerable': qualification('unanswerable', [])
});

/** The qualification for one ladder result. Pure; the answer is frozen and shared. */
export function qualifyTeardown(result: TreeTeardownResult): TeardownQualification {
  return BY_LADDER_RESULT[result];
}
