/**
 * FR-R6-F05 — sweep evaluation of one artifact, delegated to the F02
 * `evaluateRetentionSweep` rule (T018) so F05 never forks the pin semantics.
 *
 * F05 adds two things around the delegation, both fail-safe:
 *   - a never-eligible store kind (audit, provider-session; FR-008) is never
 *     offered to the rule as eligible;
 *   - a protective reference whose purpose F02 does not know (`phase-context`,
 *     `operator-hold`) preserves the artifact even under an authorized deletion:
 *     the holder releases it first, through the early-release preview.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  NEVER_ELIGIBLE_STORE_KINDS,
  type ArtifactPinPurpose,
  type ArtifactRecord,
  type ArtifactReference,
  type ArtifactSensitivity,
  type ArtifactStoreKind
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  evaluateRetentionSweep,
  type ArtifactDescriptor,
  type ArtifactPinRecord,
  type RetentionSweepOutcomeItem
} from '../../contracts/shared-memory-storage/artifacts-streams-and-acp';
import { SHARED_STORAGE_CONTRACT_VERSION } from '../../contracts/shared-memory-storage/inventories';
import { includesValue } from './lifecycle-results';

export interface SweepCandidateInput {
  readonly record: ArtifactRecord;
  readonly references: readonly ArtifactReference[];
  readonly eligibleByAgeOrSize: boolean;
  readonly explicitlyAuthorizedDeletion?: boolean;
}

const F02_PIN_PURPOSES = [
  'active-recovery',
  'paused-recovery',
  'uncertain-recovery',
  'pending-handoff',
  'report-lease',
  'export-operation'
] as const satisfies readonly ArtifactPinPurpose[];

const F02_ARTIFACT_KINDS = [
  'transcript',
  'diagnostic',
  'checkpoint',
  'report',
  'handoff-context',
  'review-report',
  'live-log-segment'
] as const satisfies readonly ArtifactDescriptor['kind'][];

/** Store kinds F02 has no name for are described as diagnostics; the rule never reads the kind. */
const F02_FALLBACK_KIND: ArtifactDescriptor['kind'] = 'diagnostic';

const F02_SENSITIVITY: Readonly<Record<ArtifactSensitivity, ArtifactDescriptor['sensitivity']>> = {
  metadata: 'metadata-only',
  content: 'redacted-content',
  'secret-adjacent': 'sensitive-raw'
};

function f02Kind(storeKind: ArtifactStoreKind): ArtifactDescriptor['kind'] {
  return includesValue(F02_ARTIFACT_KINDS, storeKind) ? storeKind : F02_FALLBACK_KIND;
}

function toPins(references: readonly ArtifactReference[]): readonly ArtifactPinRecord[] {
  const pins: ArtifactPinRecord[] = [];
  for (const reference of references) {
    if (!reference.active || !includesValue(F02_PIN_PURPOSES, reference.purpose)) continue;
    pins.push({ pinId: reference.referenceId, ownerId: reference.ownerId, purpose: reference.purpose });
  }
  return pins;
}

function toDescriptor(record: ArtifactRecord, pins: readonly ArtifactPinRecord[]): ArtifactDescriptor {
  return {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    artifactId: record.artifactId,
    originAttemptId: record.ownerAttemptId ?? '',
    originAttemptTerminalStatus: record.terminalSettledAtMs === null ? 'in-flight' : 'completed',
    kind: f02Kind(record.storeKind),
    immutableVersion: record.lifecycleRevision,
    digestAlgorithm: 'sha256',
    digestHex: record.digest?.value ?? null,
    byteSize: record.byteSize,
    createdAtUtc: new Date(record.createdAtMs).toISOString(),
    sensitivity: F02_SENSITIVITY[record.sensitivity],
    validationState: record.digest === null ? 'unverified-live-prefix' : 'verified',
    availability: record.availability,
    retentionClass: record.retentionClass,
    displayName: record.displayName,
    pins
  };
}

function holdsF05OnlyProtection(references: readonly ArtifactReference[]): boolean {
  return references.some(
    (reference) => reference.active && reference.protective && !includesValue(F02_PIN_PURPOSES, reference.purpose)
  );
}

function preservedPinned(record: ArtifactRecord): RetentionSweepOutcomeItem {
  return {
    artifactId: record.artifactId,
    action: 'preserved-pinned',
    aggregateContributionCommitted: false,
    deletionWatermarkCommitted: false,
    consequenceReported: false,
    resultingAvailability: record.availability,
    missingEvidenceStatePersisted: false
  };
}

/** The F02 sweep verdict for one artifact and its F05 references. */
export function evaluateSweepCandidate(input: SweepCandidateInput): RetentionSweepOutcomeItem {
  const { record, references } = input;
  if (holdsF05OnlyProtection(references)) return preservedPinned(record);
  const neverEligible = NEVER_ELIGIBLE_STORE_KINDS.includes(record.storeKind);
  const outcome = evaluateRetentionSweep([
    {
      artifact: toDescriptor(record, toPins(references)),
      eligibleByAgeOrSize: input.eligibleByAgeOrSize && !neverEligible,
      explicitlyAuthorizedDeletion: input.explicitlyAuthorizedDeletion === true && !neverEligible
    }
  ]).at(0);
  return outcome ?? preservedPinned(record);
}
