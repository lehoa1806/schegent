// FR-R6-F09 (FR-003, FR-004, FR-008, FR-013; research R11 steps 3, 5, 6, 7) -- the admission
// judgement for one identity. Pure: the gate gathers the inputs, performs the binding write the
// verdict asks for, and owns steps 1, 2, 4 and 8.
//
// ORDER. The executable resolves, or nothing else matters. A qualified record is contained and
// needs no acceptance. Anything else needs a grant; a grant needs a binding to the fingerprint it
// was given for. No binding yet is a first use, bound on admission. A binding a newer host wrote
// is never overwritten and never accepted here.

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type {
  AdmissionVerdict,
  BackendIdentity,
  BindingInput,
  FingerprintRecord
} from '../../contracts/containment-qualification';
import { mechanismOf } from '../backend-containment-policy';
import { UNVERIFIED_VERSION, computeFingerprint, diffFingerprint } from './fingerprint';
import { qualifyBackend } from './qualify';

export interface SpawnAdmissionInput {
  readonly identity: BackendIdentity;
  readonly granted: ReadonlySet<BackendRunnerKind>;
  readonly binding: BindingInput;
}

function refuse(verdict: Omit<Extract<AdmissionVerdict, { outcome: 'refused' }>, 'outcome'>): AdmissionVerdict {
  return Object.freeze({ outcome: 'refused', ...verdict });
}

function acceptedContainment(kind: BackendRunnerKind): 'accepted-uncontained' | 'accepted-unqualified' {
  return mechanismOf(kind) === 'none' ? 'accepted-uncontained' : 'accepted-unqualified';
}

function isUnverified(fingerprint: FingerprintRecord): boolean {
  return fingerprint.components.version === UNVERIFIED_VERSION;
}

/**
 * FR-013: an unreadable version never blocks a backend that claims no containment. That holds on
 * either side of a comparison: the version stored with a binding or kept for a Run may be the
 * unreadable one (review R1, R2). A backend that claims containment always compares it.
 */
export function versionIsIgnorable(kind: BackendRunnerKind, before: FingerprintRecord, after: FingerprintRecord): boolean {
  return mechanismOf(kind) === 'none' && (isUnverified(before) || isUnverified(after));
}

function judgeBinding(identity: BackendIdentity, fingerprint: FingerprintRecord, binding: BindingInput): AdmissionVerdict {
  const containment = acceptedContainment(identity.kind);
  if (binding === 'future-schema') {
    return refuse({ reason: 'acceptance-fingerprint-changed', consentable: false, fingerprint });
  }
  if (binding === null) {
    return Object.freeze({ outcome: 'admitted', containment, fingerprint, bindingWrite: 'legacy-first-use' });
  }
  const ignoreVersion = versionIsIgnorable(identity.kind, binding.fingerprint, fingerprint);
  const changed = diffFingerprint(binding.fingerprint, fingerprint, { ignoreVersion });
  if (changed === null) {
    // A binding made while the version was unreadable is completed by the first version that
    // reads, under the origin it was given, so a later version change is detected again.
    const completes = isUnverified(binding.fingerprint) && !isUnverified(fingerprint);
    return Object.freeze({
      outcome: 'admitted',
      containment,
      fingerprint,
      ...(completes ? { bindingWrite: binding.origin } : {})
    });
  }
  return refuse({ reason: 'acceptance-fingerprint-changed', consentable: true, fingerprint, changedComponent: changed });
}

export function judgeSpawnAdmission(input: SpawnAdmissionInput): AdmissionVerdict {
  const { identity } = input;
  if (identity.executable !== 'resolved') {
    return refuse({ reason: 'backend-executable-unresolved', consentable: false, cause: identity.executable });
  }
  const fingerprint = computeFingerprint(identity);
  if (qualifyBackend(identity).qualified) {
    return Object.freeze({ outcome: 'admitted', containment: 'contained', fingerprint });
  }
  if (!input.granted.has(identity.kind)) {
    return refuse({ reason: 'containment-unqualified-for-tuple', consentable: true, fingerprint });
  }
  return judgeBinding(identity, fingerprint, input.binding);
}
