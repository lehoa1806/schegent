// FR-R6-F09 (FR-014, SC-005; research R13) -- one backend's `BackendPosture.qualification`.
//
// Composed from `qualifyBackend` and `judgeSpawnAdmission`, the functions the spawn gate and the
// headless inspection call, over the identity the gate last observed and the stored binding. No
// probe runs here: an unobserved backend reads `not-observed` until its first admission.

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type { AdmissionVerdict, BackendIdentity, BindingInput } from '../../contracts/containment-qualification';
import type {
  BackendAdmissionProjection,
  BackendQualificationProjection
} from '../../contracts/sidebar-ipc/uncontained-grant';
import { judgeSpawnAdmission } from '../../services/containment-qualification/admission';
import { qualifyBackend } from '../../services/containment-qualification/qualify';

/** What the projection reads: the gate's last observed identity and the stored binding. */
export interface BackendQualificationSource {
  identityOf(kind: BackendRunnerKind): BackendIdentity | null;
  bindingOf(kind: BackendRunnerKind): BindingInput;
}

function admissionWord(verdict: AdmissionVerdict): BackendAdmissionProjection {
  if (verdict.outcome === 'admitted') return verdict.containment === 'contained' ? 'contained' : 'accepted';
  return verdict.reason === 'backend-executable-unresolved' ? 'executable-unresolved' : 'acceptance-required';
}

export function projectBackendQualification(
  kind: BackendRunnerKind,
  granted: ReadonlySet<BackendRunnerKind>,
  source: BackendQualificationSource
): BackendQualificationProjection {
  const identity = source.identityOf(kind);
  if (identity === null) {
    return Object.freeze({
      identityState: 'not-observed',
      versionMinor: null,
      effects: Object.freeze([]),
      admission: granted.has(kind) ? 'accepted' : 'acceptance-required'
    });
  }
  const record = qualifyBackend(identity);
  const verdict = judgeSpawnAdmission({ identity, granted, binding: source.bindingOf(kind) });
  return Object.freeze({
    identityState: record.identityState,
    versionMinor: identity.versionMinor,
    effects: Object.freeze(record.effects.map(({ effect, outcome, basis }) => Object.freeze({ effect, outcome, basis }))),
    admission: admissionWord(verdict)
  });
}
