// FR-R6-F09 T019 -- the consent gate and a containment admission refusal (research R3).
//
// WHAT THIS PINS:
//   - a non-consentable admission refusal is reported and the modal is never shown;
//   - a consentable one is offered, and a granted consent with a fingerprint calls
//     `onAccepted(kind, fingerprint)` BEFORE the retry;
//   - an acceptance that cannot be recorded reports the refusal instead of retrying;
//   - a plain uncontained refusal keeps its FR-R3-146 behaviour and never calls `onAccepted`.

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type { FingerprintRecord } from '../../../src/contracts/containment-qualification';
import {
  UncontainedConsentGate,
  driveUnderConsent,
  type UncontainedConsentOutcome,
  type UncontainedRefusal
} from '../../../src/controller/uncontained-consent-gate';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';
import { computeFingerprint } from '../../../src/services/containment-qualification/fingerprint';

const FINGERPRINT: FingerprintRecord = computeFingerprint({
  kind: 'codex',
  executable: 'resolved',
  versionMinor: '0.164',
  os: 'darwin',
  arch: 'arm64',
  environmentPolicyDigest: 'e'.repeat(64)
});

const identity = (raw: string): string => raw;

function harness(decision: UncontainedConsentOutcome['decision'] = 'granted') {
  const asked: UncontainedRefusal[] = [];
  const events: string[] = [];
  const accepted: Array<{ kind: BackendRunnerKind; fingerprint: FingerprintRecord }> = [];
  const request = async (refusal: UncontainedRefusal): Promise<UncontainedConsentOutcome> => {
    asked.push(refusal);
    events.push('asked');
    return decision === 'write-failed' ? { decision, reason: 'disk full' } : { decision };
  };
  const onAccepted = async (kind: BackendRunnerKind, fingerprint: FingerprintRecord): Promise<void> => {
    accepted.push({ kind, fingerprint });
    events.push('accepted');
  };
  return { asked, events, accepted, request, onAccepted };
}

describe('FR-R6-F09 T019 -- a non-consentable refusal is reported, never offered', () => {
  it.each([
    new ContainmentAdmissionRefusedError({ kind: 'codex', reason: 'backend-executable-unresolved', cause: 'not-found' }),
    new ContainmentAdmissionRefusedError({ kind: 'claude', reason: 'workspace-untrusted-at-spawn' }),
    new ContainmentAdmissionRefusedError({
      kind: 'claude',
      reason: 'acceptance-fingerprint-changed',
      consentable: false,
      fingerprint: FINGERPRINT
    })
  ])('$reason', async (err) => {
    const h = harness();
    const gate = new UncontainedConsentGate(h.request, identity, h.onAccepted);
    const next = await gate.decide(err);
    expect(next).toEqual({ action: 'report', err });
    expect(h.asked).toEqual([]);
    expect(h.accepted).toEqual([]);
  });
});

describe('FR-R6-F09 T019 -- a consentable refusal is offered, and the acceptance is recorded first', () => {
  it('calls onAccepted with the kind and the fingerprint before the retry', async () => {
    const h = harness();
    const gate = new UncontainedConsentGate(h.request, identity, h.onAccepted);
    const err = new ContainmentAdmissionRefusedError({
      kind: 'codex',
      reason: 'containment-unqualified-for-tuple',
      fingerprint: FINGERPRINT
    });
    let attempts = 0;
    const reported: unknown[] = [];
    await driveUnderConsent(
      gate,
      async () => {
        attempts += 1;
        h.events.push(`drive-${attempts}`);
        if (attempts === 1) throw err;
      },
      async (failure) => {
        reported.push(failure);
      }
    );
    expect(h.events).toEqual(['drive-1', 'asked', 'accepted', 'drive-2']);
    expect(h.accepted).toEqual([{ kind: 'codex', fingerprint: FINGERPRINT }]);
    expect(h.asked.at(0)?.message).toBe(err.message);
    expect(reported).toEqual([]);
  });

  it('reports the refusal, and does not retry, when the acceptance cannot be recorded', async () => {
    const h = harness();
    const failing = async (): Promise<void> => {
      throw new Error('memento unavailable');
    };
    const gate = new UncontainedConsentGate(h.request, identity, failing);
    const err = new ContainmentAdmissionRefusedError({
      kind: 'claude',
      reason: 'acceptance-fingerprint-changed',
      fingerprint: FINGERPRINT,
      changedComponent: 'version'
    });
    expect(await gate.decide(err)).toEqual({ action: 'report', err });
  });

  it('does not record an acceptance the operator declined', async () => {
    const h = harness('denied');
    const gate = new UncontainedConsentGate(h.request, identity, h.onAccepted);
    const err = new ContainmentAdmissionRefusedError({
      kind: 'codex',
      reason: 'containment-unqualified-for-tuple',
      fingerprint: FINGERPRINT
    });
    expect(await gate.decide(err)).toEqual({ action: 'report', err });
    expect(h.accepted).toEqual([]);
  });

  it('retries without onAccepted when none is wired', async () => {
    const h = harness();
    const gate = new UncontainedConsentGate(h.request, identity);
    const err = new ContainmentAdmissionRefusedError({
      kind: 'codex',
      reason: 'containment-unqualified-for-tuple',
      fingerprint: FINGERPRINT
    });
    expect(await gate.decide(err)).toEqual({ action: 'retry' });
  });
});

describe('FR-R6-F09 T019 -- the FR-R3-146 refusal is unchanged', () => {
  it('offers a plain uncontained refusal and never calls onAccepted', async () => {
    const h = harness();
    const gate = new UncontainedConsentGate(h.request, identity, h.onAccepted);
    const next = await gate.decide(new UncontainedBackendRefusedError('claude', 'add it'));
    expect(next).toEqual({ action: 'retry' });
    expect(h.asked.at(0)?.kind).toBe('claude');
    expect(h.accepted).toEqual([]);
  });
});
