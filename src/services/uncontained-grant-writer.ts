// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Writes one configuration key when a caller has already established consent. It
// starts nothing and spawns nothing.

// FR-R3-144 (FR-003, FR-006, D-3) — the ONE writer for the uncontained grant list.
//
// FR-R3-146 wrote this list from inside `activation/uncontained-consent.ts`, where
// it was reached by exactly one caller, in one direction: append the backend the
// operator just approved in a modal. This item adds a Settings surface with a
// control per backend, so there is now a second caller and a second direction —
// revoke. Two callers writing one security setting is the point at which the write
// stops being an implementation detail of a modal and becomes a thing with its own
// rules, so it moved here and the modal now delegates to it.
//
// WHY IT IS NOT `writeGeneralSettings`
//
// `schegent.backend.uncontainedBackends` deliberately has no `KEY_SPECS` entry
// (plan C7-1). That surface is a generic key/value writer whose failure mode is a
// rejected value; this one is a per-id read-modify-write at application scope whose
// failure mode is a lost grant. Routing a security grant through the same batched
// draft-save as `logging.verbose` would mean an unrelated rejected field could take
// the grant down with it, and a partial save could leave the operator unsure which
// half landed.
//
// THE READ-MODIFY-WRITE, AND WHY THE READ HAPPENS HERE
//
// The current value is re-read at WRITE time rather than captured by the caller.
// FR-R3-146's docblock made this argument for the modal: two windows can be refused
// at the same moment for different backends, and each appending to the list it read
// before prompting means whichever wrote second overwrites the other's entry with a
// list that never contained it. The Settings tab makes the same hazard worse, not
// better — a tab renders its checkboxes from the list it read when it opened and
// can sit there for a session, so "send the list this tab has, plus the box that
// changed" spans minutes rather than one `await`. Re-reading here is what makes the
// stale copy unable to reach the write at all: callers pass an INTENT (this id,
// this direction), never an array.

import type { SanitizedLogger } from '../lib/logger';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { UncontainedConsentOutcome } from '../controller/uncontained-consent-gate';
import {
  ALLOW_UNCONTAINED_SETTING,
  resolveUncontainedGrant,
  type UncontainedEntryProblem
} from './backend-containment-policy';
import { CONFIGURATION_TARGET_GLOBAL } from '../config/general-settings';
import { errorMessage } from '../lib/errors';

/**
 * The configuration seam. Full dotted keys, so the caller supplies
 * `getConfiguration()` with no section and this module keeps the one key it owns.
 *
 * DECLARED HERE, re-exported by `activation/uncontained-consent.ts` under the same
 * name. It moved with the write it describes; the re-export exists because the
 * FR-R3-146 suite imports it from that module and those tests must pass unmodified
 * — an edited 146 test would mean these semantics moved, which is exactly what
 * this refactor must not do.
 */
export interface UncontainedConsentConfig {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown, target: number): Promise<void> | Thenable<void>;
}

/**
 * FR-R3-146's three outcomes, plus the one this caller can reach and that one
 * could not.
 *
 * The modal only ever asks about a backend that was just REFUSED, so it can only
 * name an id that is both real and uncontained. A Settings tab renders a control
 * for every backend, and an IPC payload can carry anything, so this writer must
 * also answer "that id is not something this list governs" — for `codex`, which
 * carries an OS-enforced bound and was never refused, and for an id that is not a
 * backend at all.
 *
 * `not-applicable` rather than `denied`, because they are different facts and the
 * operator acts on them differently: `denied` means the grant is not in force and
 * ticking the box would put it there; `not-applicable` means there is no box to
 * tick. Reporting the second as the first sends an operator to look for a control
 * that should not exist. This is the same distinction FR-R3-146 drew when it
 * refused to report `write-failed` as `denied`.
 *
 * The `message` is `resolveUncontainedGrant`'s, obtained by asking it — see
 * `classify` below.
 */
export type UncontainedGrantOutcome =
  | UncontainedConsentOutcome
  | {
      readonly decision: 'not-applicable';
      readonly problem: UncontainedEntryProblem['problem'];
      readonly message: string;
    };

/**
 * Whether this list governs `kind` at all, answered by the module that owns the
 * question.
 *
 * Asking `resolveUncontainedGrant` with a one-entry list rather than re-deriving
 * membership from `SUPPORTED_BACKENDS` and `containmentOf` here: those are the two
 * facts it already combines, and its two sentences — the typo and the no-op — are
 * already written, already tested, and already what `resolveUncontainedGrant`
 * reports for the same entry when it is read back out of the setting. A second
 * derivation would be a second authority for one classification, which is the
 * defect `containmentOf` exists to prevent one directory over.
 *
 * `undefined` means the list governs it and a write may proceed.
 */
function classify(kind: BackendRunnerKind): UncontainedEntryProblem | undefined {
  return resolveUncontainedGrant([kind]).problems[0];
}

/**
 * Add or remove exactly ONE backend id in the grant list, at application scope.
 *
 * `granted` is the state asked for, and the returned decision is the state that
 * holds afterwards: `granted` when the id is in the list, `denied` when it is not,
 * `write-failed` when the host refused the write and the operator must be told the
 * setting did not move. A revoke that reports success while the write was rejected
 * is the worst of the four, because it tells an operator a grant is gone while it
 * is still in force.
 */
export async function setUncontainedGrant(
  deps: {
    readonly config: UncontainedConsentConfig;
    readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  },
  kind: BackendRunnerKind,
  granted: boolean
): Promise<UncontainedGrantOutcome> {
  const problem = classify(kind);
  if (problem !== undefined) {
    deps.logger.info(
      `backend.uncontained-consent not-applicable kind=${problem.entry} problem=${problem.problem}`
    );
    return { decision: 'not-applicable', problem: problem.problem, message: problem.message };
  }

  const current = readGrantedIds(deps.config);
  const present = current.includes(kind);
  // Nothing to write. The state asked for is the state that holds — the operator
  // granted it in another window while this surface was open, or by hand, or is
  // revoking something that was never there. Writing an identical list anyway would
  // report a failure they cannot act on if the profile is read-only.
  if (present === granted) {
    deps.logger.info(
      `backend.uncontained-consent already-${granted ? 'granted' : 'absent'} kind=${kind}`
    );
    return { decision: granted ? 'granted' : 'denied' };
  }

  // `filter`, not an index removal: a hand-edited `settings.json` can hold the same
  // id twice, and removing the first occurrence would leave the grant in force
  // while reporting it revoked.
  const next = granted ? [...current, kind] : current.filter((entry) => entry !== kind);

  try {
    await deps.config.update(ALLOW_UNCONTAINED_SETTING, next, CONFIGURATION_TARGET_GLOBAL);
  } catch (error) {
    // Via `errorMessage`, not a cast to Error: a host that rejects with a string or
    // a plain object would otherwise put "undefined" in front of an operator who
    // has to act on it.
    const reason = errorMessage(error);
    deps.logger.warn(
      `backend.uncontained-consent write-failed kind=${kind} granted=${granted} ` +
        `setting=${ALLOW_UNCONTAINED_SETTING} reason=${reason}`
    );
    return { decision: 'write-failed', reason };
  }

  deps.logger.info(
    `backend.uncontained-consent ${granted ? 'granted' : 'revoked'} kind=${kind} ` +
      `scope=application setting=${ALLOW_UNCONTAINED_SETTING}`
  );
  return { decision: granted ? 'granted' : 'denied' };
}

/**
 * The list as it stands, reduced to the entries a write can preserve.
 *
 * A non-array value grants nothing today — `resolveUncontainedGrant` fails closed
 * on it — so replacing it with a one-entry list loses no grant. Non-string elements
 * are dropped for the same reason and because the manifest declares `string[]`;
 * unsupported and already-contained ids are KEPT verbatim, because reporting those
 * is `resolveUncontainedGrant`'s job and quietly deleting an operator's typo is how
 * they never learn they made one.
 *
 * A revoke that finds nothing to remove therefore writes NOTHING rather than
 * writing the cleaned list: repairing a malformed value is a decision with its own
 * consequences, and the far side of a revoke button is not where an operator should
 * discover it was made for them.
 */
function readGrantedIds(config: UncontainedConsentConfig): readonly string[] {
  const raw = config.get<unknown>(ALLOW_UNCONTAINED_SETTING);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}
