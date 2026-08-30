// FR-R3-144 (T021, T048, D-4) — every backend's containment posture, derived
// once per compose.
//
// Extracted from `snapshot-composer.ts` for the reason `trust-projection.ts` gives
// in its own header: the composer's job is composing a snapshot from projections,
// and each projection lives in its own module. The composer's cost for this one is
// an import and a spread.
//
// DERIVED, NEVER STORED, AND NEVER RESTATED
//
// Every field comes from `services/backend-containment-policy.ts` —
// `containmentByBackend()`, `mechanismOf()` and `resolveUncontainedGrant()`. That
// is the same module `judgeBackendContainment` consults when it refuses a spawn,
// which is what makes this projection unable to disagree with the enforcement. A
// surface that computed its own answer would be a second authority for one fact,
// and the two would part company the first time a backend's mechanism changed —
// silently, and in the direction that shows an operator a grant they do not have.
//
// ENUMERATED OVER `SUPPORTED_BACKENDS`, NEVER SAMPLED
//
// A backend added to the platform gets a posture row on the day it is added,
// without an edit here. `tests/unit/ui/sidebar/backend-posture-projection.test.ts`
// asserts the same way — over the enumeration, not over three named ids — so a row
// added to `MECHANISM_BY_BACKEND` with no projection change fails it.

import {
  containmentOf,
  judgeBackendContainment,
  mechanismOf,
  resolveUncontainedGrant
} from '../../services/backend-containment-policy';
import { SUPPORTED_BACKENDS } from '../../contracts/backend-kinds';
import type { BackendGrantState, BackendPosture } from './snapshot';

export interface BackendPostureProjection {
  readonly backendPostures: readonly BackendPosture[];
  readonly backendGrantProblems: readonly string[];
}

/**
 * Whether this backend's grant is in force, in three states.
 *
 * `not-required` is decided FIRST, and that order is the point (A-2). `codex`
 * carries an OS-enforced bound, so it never appears in the granted set even when
 * an operator has listed it by hand — asking about membership first would report
 * `not-granted` for a backend that needs no grant, and those two states have
 * opposite remedies.
 */
function grantStateOf(
  kind: (typeof SUPPORTED_BACKENDS)[number],
  granted: ReadonlySet<(typeof SUPPORTED_BACKENDS)[number]>
): BackendGrantState {
  if (containmentOf(kind) === 'os-enforced') return 'not-required';
  return granted.has(kind) ? 'granted' : 'not-granted';
}

/**
 * Compose the posture list and the entry problems from the setting's raw value.
 *
 * @param rawSetting The unparsed value of `schegent.backend.uncontainedBackends`.
 *   Unparsed on purpose — see `StateProjectorDeps.getUncontainedGrantSetting`.
 *   `resolveUncontainedGrant` fails closed on anything that is not an array of
 *   strings, so `undefined` from an unwired host yields no grants and no problems,
 *   which is the same answer a fresh install's `[]` gives.
 */
export function composeBackendPostures(rawSetting: unknown): BackendPostureProjection {
  const resolved = resolveUncontainedGrant(rawSetting);

  // Problems that name a real backend hang off that backend's row; problems that
  // name nothing — the `"claud"` typo FR-004 keeps tolerable on the way in — have
  // no row to hang off and travel separately. Indexed rather than searched per
  // row so the projection stays linear in the number of entries.
  const problemByKind = new Map<string, string>();
  const unmatched: string[] = [];
  for (const problem of resolved.problems) {
    if ((SUPPORTED_BACKENDS as readonly string[]).includes(problem.entry)) {
      problemByKind.set(problem.entry, problem.message);
    } else {
      unmatched.push(problem.message);
    }
  }

  const postures = SUPPORTED_BACKENDS.map((kind) => {
    const problem = problemByKind.get(kind);
    // T033, T035 — the refusal the operator would hit, asked of the same function
    // the spawn path asks. Not reconstructed from `grant`: `judgeBackendContainment`
    // decides the outcome AND words it, so a posture that said `not-granted` while
    // the runner factory allowed the spawn would be a projection bug rather than a
    // wording one, and asking the judge is what makes that unrepresentable.
    const verdict = judgeBackendContainment(kind, resolved.granted);
    const base = {
      kind,
      containment: containmentOf(kind),
      mechanism: mechanismOf(kind),
      grant: grantStateOf(kind, resolved.granted)
    };
    // Keys are omitted rather than set to `undefined`: both fields are optional on
    // `BackendPosture`, and a snapshot that ships `problem: undefined` on every
    // row makes the ordinary case look like it carries a fact it does not.
    return Object.freeze({
      ...base,
      ...(problem === undefined ? {} : { problem }),
      ...(verdict.outcome === 'refused' ? { refusal: verdict.message } : {})
    });
  });

  return Object.freeze({
    backendPostures: Object.freeze(postures) as readonly BackendPosture[],
    backendGrantProblems: Object.freeze(unmatched) as readonly string[]
  });
}
