// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Returns a requester. The modal is shown and the setting written only when a Run
// was refused, and no Run starts in an untrusted window.

// FR-R3-146 (FR-002, FR-003, FR-004) — operator consent for an uncontained backend.
//
// This module exists because the shipped defaults refuse each other: `claude` is
// the default backend and `[]` is the default grant, so a fresh install's first run
// ended at `judgeBackendContainment`'s refusal with no way to answer it. The
// refusal names the setting and the exact value to add — and the operator never saw
// that half, because the generic handler cut the message at 240 characters, in the
// middle of the word "choose".
//
// WHY A MODAL IS A BOUND AND A DOCUMENT IS NOT
//
// FR-R3-125 recorded that the SETTING is the consent surface, not a prompt, and
// FR-R3-056 rejected disclosure with "a document does not bound a process". Both
// still hold. What they rejected was a notice shown BESIDE a spawn that happened
// anyway. This is answered BEFORE one: the refusal is thrown inside
// `createBackendRunner`, so no runner object exists when the dialog opens, and the
// retry constructs a second time only after the grant is written. The manifest
// default stays `[]` — nothing here makes the shipped posture permissive, and an
// operator who never answers is exactly as bounded as before.
//
// Three properties matter and each is pinned by a test:
//
//   1. Only the explicit affirmative action grants. Cancel, dismissal, and a
//      dialog that could not be shown all deny — `git-approval.ts:16-22`'s rule,
//      unchanged, because a gate that opens when nobody could be asked is not one.
//   2. Exactly ONE backend id is added. The operator was asked about one backend;
//      granting a second because it was convenient is the silent widening this
//      whole feature is a correction for.
//   3. The modal does not RESTATE the policy. It carries the policy module's own
//      message verbatim, so the three substances FR-R3-125's gate asserts —
//      local user authority, application scope, per-backend shape — are the same
//      words on every surface rather than a copy that drifts (plan A4).
//
// The dialog and the configuration are injected rather than imported so the
// decision logic is testable without a VS Code host; `run-safety-wiring.ts`
// supplies both, exactly as it supplies the Git modal.

import type { SanitizedLogger } from '../lib/logger';
import type { ModalConfirm } from './git-approval';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type {
  UncontainedConsentOutcome,
  UncontainedRefusal
} from '../controller/uncontained-consent-gate';
import { ALLOW_UNCONTAINED_SETTING } from '../services/backend-containment-policy';
import { CONFIGURATION_TARGET_GLOBAL } from '../config/general-settings';
import { errorMessage } from '../lib/errors';

// The port's shapes are declared by the consumer, in
// `controller/uncontained-consent-gate.ts`, and deliberately NOT re-exported from
// here: a second name for one type is how two modules come to disagree about which
// one a caller is holding. The `UncontainedRefusal.message` arriving here has
// already been through the caller's sanitizer, so redaction keeps one authority and
// this module never decides what is safe to show.

/**
 * The configuration seam. Full dotted keys, so the caller supplies
 * `getConfiguration()` with no section and this module keeps the one key it owns.
 */
export interface UncontainedConsentConfig {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown, target: number): Promise<void> | Thenable<void>;
}

/** The modal's headline. One line: which backend, and that nothing has started. */
export function uncontainedConsentHeadline(kind: BackendRunnerKind): string {
  return `Schegent cannot start the '${kind}' backend without your approval.`;
}

/**
 * The affirmative action. Anything else — including dismissal — denies.
 *
 * It names the backend and the scope of what it is about to write, because that is
 * what the button actually does: `ConfigurationTarget.Global` is this installation,
 * every workspace in it. A label reading "Allow" would claim less than the grant.
 */
export function uncontainedConsentApproveLabel(kind: BackendRunnerKind): string {
  return `Enable '${kind}' for This Installation`;
}

export function createUncontainedConsentRequester(deps: {
  readonly confirm: ModalConfirm;
  readonly config: UncontainedConsentConfig;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}): (refusal: UncontainedRefusal) => Promise<UncontainedConsentOutcome> {
  return async (refusal: UncontainedRefusal): Promise<UncontainedConsentOutcome> => {
    const approveLabel = uncontainedConsentApproveLabel(refusal.kind);

    let choice: string | undefined;
    try {
      choice = await deps.confirm(
        uncontainedConsentHeadline(refusal.kind),
        // Verbatim. This is the message the operator never got to read, and the
        // half that was cut is the half that says what to do about it.
        refusal.message,
        approveLabel
      );
    } catch (error) {
      // No UI host, or the dialog failed. An unanswerable prompt is a denial: the
      // alternative is granting local user authority because nobody could be
      // asked. Same shape as `git-approval.ts:62-71`, and the same reason.
      deps.logger.warn(
        `backend.uncontained-consent unavailable kind=${refusal.kind} ` +
          `reason=${errorMessage(error)}`
      );
      return { decision: 'denied' };
    }

    if (choice !== approveLabel) {
      deps.logger.info(`backend.uncontained-consent denied kind=${refusal.kind}`);
      return { decision: 'denied' };
    }

    return grantUncontainedBackend(deps, refusal.kind);
  };
}

/**
 * Add ONE backend id to the grant list at application scope.
 *
 * The current value is re-read HERE, after the modal was answered, rather than
 * captured when the prompt opened. Two windows can be refused at the same moment
 * for different backends; if each appended to the list it read before prompting,
 * whichever wrote second would overwrite the other's entry with a list that never
 * contained it. Re-reading at write time makes the lost grant a race that has to be
 * won inside one `await`, instead of one that spans however long an operator takes
 * to read a modal.
 */
async function grantUncontainedBackend(
  deps: {
    readonly config: UncontainedConsentConfig;
    readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  },
  kind: BackendRunnerKind
): Promise<UncontainedConsentOutcome> {
  const current = readGrantedIds(deps.config);
  // Already there — the operator granted it in another window while this modal was
  // open, or by hand. Nothing to write, and writing an identical list anyway would
  // report a failure the operator cannot act on if the profile is read-only.
  if (current.includes(kind)) {
    deps.logger.info(`backend.uncontained-consent already-granted kind=${kind}`);
    return { decision: 'granted' };
  }

  try {
    await deps.config.update(
      ALLOW_UNCONTAINED_SETTING,
      [...current, kind],
      CONFIGURATION_TARGET_GLOBAL
    );
  } catch (error) {
    // Via `errorMessage`, not a cast to Error: a host that rejects with a string or
    // a plain object would otherwise put "undefined" in front of an operator who
    // has to act on it.
    const reason = errorMessage(error);
    deps.logger.warn(
      `backend.uncontained-consent write-failed kind=${kind} ` +
        `setting=${ALLOW_UNCONTAINED_SETTING} reason=${reason}`
    );
    return { decision: 'write-failed', reason };
  }

  deps.logger.info(
    `backend.uncontained-consent granted kind=${kind} scope=application ` +
      `setting=${ALLOW_UNCONTAINED_SETTING}`
  );
  return { decision: 'granted' };
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
 */
function readGrantedIds(config: UncontainedConsentConfig): readonly string[] {
  const raw = config.get<unknown>(ALLOW_UNCONTAINED_SETTING);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}
