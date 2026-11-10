// FR-R6-F09 (FR-001, FR-002, FR-004, FR-005; research R10) -- `qualifyBackend`, the per-effect
// record for one identity. Pure: no clock, no I/O.
//
// HOW A CELL IS CHOSEN. Among the evidence rows for the backend and effect whose os and arch match
// (exactly or by `*`):
//   1. the most specific row whose version matches (exactly or by `*`) gives the cell, unless
//   2. a version-bound observed row at least as specific exists for another version: then the
//      evidence is about this tuple but not this version, and the cell is `stale` (or `unverified`
//      when the version could not be read);
//   3. with no row at all, the cell is `unverified` with no basis.

import {
  CONTAINMENT_EFFECTS,
  type BackendIdentity,
  type ContainmentEffect,
  type EffectQualification,
  type QualificationRecord
} from '../../contracts/containment-qualification';
import { mechanismOf } from '../backend-containment-policy';
import { CONFIRMED_FLAGS } from '../capability-confirmed-flags';
import { ANY, EVIDENCE_MATRIX, MECHANISM_CLAIMS, type EvidenceRow } from './evidence-matrix';
import { UNVERIFIED_VERSION, computeFingerprint } from './fingerprint';

function matches(column: string, value: string): boolean {
  return column === ANY || column === value;
}

function specificity(evidence: EvidenceRow): number {
  return [evidence.os, evidence.arch, evidence.versionMinor].filter((column) => column !== ANY).length;
}

function mostSpecific(rows: readonly EvidenceRow[]): EvidenceRow | undefined {
  let best: EvidenceRow | undefined;
  for (const candidate of rows) {
    if (best === undefined || specificity(candidate) > specificity(best)) best = candidate;
  }
  return best;
}

function fromRow(evidence: EvidenceRow): EffectQualification {
  return Object.freeze({
    effect: evidence.effect,
    outcome: evidence.outcome,
    basis: evidence.basis,
    components: evidence.components,
    residuals: evidence.residuals,
    observedAt: evidence.observedAt
  });
}

function unverified(effect: ContainmentEffect): EffectQualification {
  return Object.freeze({ effect, outcome: 'unverified', basis: 'none', components: [], residuals: [], observedAt: null });
}

function cellFor(identity: BackendIdentity, effect: ContainmentEffect): EffectQualification {
  const candidates = EVIDENCE_MATRIX.filter(
    (evidence) =>
      evidence.backend === identity.kind &&
      evidence.effect === effect &&
      matches(evidence.os, identity.os) &&
      matches(evidence.arch, identity.arch)
  );
  const current = mostSpecific(
    candidates.filter((evidence) => evidence.versionMinor === ANY || evidence.versionMinor === identity.versionMinor)
  );
  if (current !== undefined && current.versionMinor !== ANY) return fromRow(current);

  const other = mostSpecific(
    candidates.filter((evidence) => evidence.versionMinor !== ANY && evidence.basis === 'observed-behavior')
  );
  if (other !== undefined && (current === undefined || specificity(other) >= specificity(current))) {
    if (identity.versionMinor === null) return unverified(effect);
    return Object.freeze({ ...fromRow(other), outcome: 'stale' });
  }
  return current === undefined ? unverified(effect) : fromRow(current);
}

export function qualifyBackend(identity: BackendIdentity): QualificationRecord {
  const mechanism = mechanismOf(identity.kind);
  const version = identity.versionMinor ?? UNVERIFIED_VERSION;
  const effects = Object.freeze(CONTAINMENT_EFFECTS.map((effect) => cellFor(identity, effect)));
  const claims = MECHANISM_CLAIMS[mechanism];
  const qualified =
    claims.length > 0 &&
    claims.every((claimed) => effects.some((entry) => entry.effect === claimed && entry.outcome === 'observed-enforced'));
  return Object.freeze({
    key: Object.freeze({
      kind: identity.kind,
      versionMinor: version,
      os: identity.os,
      arch: identity.arch,
      mechanism,
      mechanismVersion: version,
      fingerprint: computeFingerprint(identity).digest,
      capabilitySet: Object.freeze([...CONFIRMED_FLAGS[identity.kind]].sort()),
      acp: 'not-applicable'
    }),
    effects,
    qualified,
    identityState: identity.versionMinor === null ? 'unverified' : 'observed'
  });
}
