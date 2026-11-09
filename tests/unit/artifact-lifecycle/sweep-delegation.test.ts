import { describe, expect, it } from 'vitest';
import type {
  ArtifactRecord,
  ArtifactReference,
  ReferencePurpose
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { evaluateSweepCandidate } from '../../../src/services/artifact-lifecycle';

const NOW = 1_800_000_000_000;

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: 'art-1',
    managed: true,
    lifecycleRevision: 1,
    ownerRunId: 'run-1',
    ownerAttemptId: null,
    sensitivity: 'content',
    retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
    storeKind: 'checkpoint',
    immutability: 'immutable',
    digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    generation: null,
    extentBytes: null,
    byteSize: 40,
    availability: 'present',
    mediaType: 'application/octet-stream',
    displayName: 'checkpoint',
    createdAtMs: NOW,
    terminalSettledAtMs: null,
    expiresAtMs: null,
    updatedAtMs: NOW,
    ...overrides
  };
}

function reference(purpose: ReferencePurpose, overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    referenceId: 'f'.repeat(64),
    artifactId: 'art-1',
    ownerType: 'run',
    ownerId: 'run-1',
    purpose,
    protective: true,
    active: true,
    createdRevision: 1,
    releasedRevision: null,
    releaseReason: null,
    createdAtMs: NOW,
    releasedAtMs: null,
    ...overrides
  };
}

describe('FR-R6-F05 sweep evaluation delegates to F02 evaluateRetentionSweep', () => {
  it('preserves an artifact an active recovery reference pins', () => {
    const outcome = evaluateSweepCandidate({
      record: record(),
      references: [reference('paused-recovery')],
      eligibleByAgeOrSize: true
    });
    expect(outcome.action).toBe('preserved-pinned');
    expect(outcome.resultingAvailability).toBe('present');
  });

  it('collects an eligible artifact once its only reference is released', () => {
    const released = reference('paused-recovery', { active: false, releasedRevision: 2, releaseReason: 'owner-durable' });
    const outcome = evaluateSweepCandidate({ record: record(), references: [released], eligibleByAgeOrSize: true });
    expect(outcome.action).toBe('collected');
    expect(outcome.resultingAvailability).toBe('expired');
  });

  it('never makes an audit or provider-session artifact eligible', () => {
    for (const storeKind of ['audit', 'provider-session'] as const) {
      const outcome = evaluateSweepCandidate({ record: record({ storeKind }), references: [], eligibleByAgeOrSize: true });
      expect(outcome.action).toBe('preserved-ineligible');
    }
  });

  it('preserves a protective F05-only purpose that F02 does not know', () => {
    const outcome = evaluateSweepCandidate({
      record: record(),
      references: [reference('operator-hold')],
      eligibleByAgeOrSize: true
    });
    expect(outcome.action).toBe('preserved-pinned');
  });

  it('reports the consequence of an authorized deletion of a recovery dependency', () => {
    const outcome = evaluateSweepCandidate({
      record: record(),
      references: [reference('active-recovery')],
      eligibleByAgeOrSize: true,
      explicitlyAuthorizedDeletion: true
    });
    expect(outcome.action).toBe('authorized-deleted-recovery-dependency');
    expect(outcome.consequenceReported).toBe(true);
  });
});
