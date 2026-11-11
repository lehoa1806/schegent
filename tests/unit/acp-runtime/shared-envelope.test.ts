// FR-R6-F13 T019 (FR-015, FR-022, research R6) — every ACP observation maps to an F02 envelope
// that F02's own normalization accepts; history and idle observations create no turn row; an
// earlier generation is historical-unattributed; usage never becomes a token delta.
import { describe, expect, it } from 'vitest';

import type { AcpObservation, AcpStopReason, AgentProfile } from '../../../src/contracts/acp-runtime';
import {
  normalizeAcpEventToDomainFixtures,
  type AcpNormalizationContext
} from '../../../src/contracts/shared-memory-storage/artifacts-streams-and-acp';
import { createObservationLedgerState } from '../../../src/contracts/shared-memory-storage/identity-and-observations';
import { toSharedAcpEnvelope } from '../../../src/services/acp-runtime/shared-envelope';
import type { AcpNormalizedEvent } from '../../../src/services/phase-log/acp-live-projection';
import type { AcpAttemptBinding } from '../../../src/services/usage-accounting/acp-usage-mapping';

const PROFILE: AgentProfile = {
  profileId: 'fixture-agent',
  revision: 3,
  kind: 'native',
  executableRef: 'fake-acp-agent-bin',
  attribution: { provider: 'fixture-provider', backend: 'fixture-backend', model: 'fixture-model' },
  requiredCapabilities: [],
  qualification: 'fixture'
};
const AT = '2026-11-11T00:00:00.000Z';
const BINDING: AcpAttemptBinding = {
  profileId: 'fixture-agent',
  acpSessionId: 'sess-1',
  connectionGeneration: 7,
  turnId: 'turn-7-1',
  rootId: 'root-1',
  attemptId: 'attempt-1'
};
const LIVE = { origin: 'live', turnId: 'turn-7-1', attemptId: 'attempt-1', binding: BINDING } as const;
const IDLE = { origin: 'live', turnId: 'idle-7', attemptId: null, binding: null } as const;
const HISTORY = { origin: 'history', turnId: 'history-7', attemptId: null, binding: null } as const;
const DISPLAY_EVENT: AcpNormalizedEvent = {
  connectionGeneration: '7',
  attemptId: 'attempt-1',
  sourceEventId: null,
  origin: 'live',
  kind: 'message',
  text: 'Hello'
};

type Attribution = typeof LIVE | typeof IDLE | typeof HISTORY;

function base(attribution: Attribution, seq = 1): Omit<AcpObservation, 'kind'> {
  return { generation: 7, hostReceiveSeq: seq, observedAtUtc: AT, acpSessionId: 'sess-1', ...attribution };
}

function started(requestId = 3): AcpObservation {
  return { ...base(LIVE), kind: 'turn-started', requestId };
}

function completed(stopReason: AcpStopReason): AcpObservation {
  return { ...base(LIVE, 2), kind: 'turn-completed', requestId: 3, stopReason };
}

function display(attribution: Attribution): AcpObservation {
  return { ...base(attribution, 4), kind: 'display', event: DISPLAY_EVENT };
}

function usage(attribution: Attribution): AcpObservation {
  return {
    ...base(attribution, 5),
    kind: 'usage',
    usage: {
      profileId: 'fixture-agent',
      acpSessionId: 'sess-1',
      connectionGeneration: 7,
      turnId: attribution.turnId,
      hostReceiveSeq: 5,
      eventUtc: AT,
      replayed: attribution.origin === 'history',
      used: 1200,
      size: 200000,
      hasQualifiedSessionBaseline: false
    }
  };
}

function context(activeConnectionGeneration = 7): AcpNormalizationContext {
  return {
    workspaceId: 'ws-1',
    queueId: 'default',
    rootExecutionId: 'root-1',
    invocationId: 'inv-1',
    attemptId: 'attempt-1',
    activeConnectionGeneration,
    hostResultValidated: false,
    ledger: createObservationLedgerState()
  };
}

function accepted(observation: AcpObservation, ctx = context()) {
  const outcome = normalizeAcpEventToDomainFixtures(toSharedAcpEnvelope(observation, PROFILE), ctx);
  if (outcome.status !== 'accepted') throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome.value;
}

describe('toSharedAcpEnvelope', () => {
  it('maps a turn start with the decimal request id and no provider session', () => {
    expect(toSharedAcpEnvelope(started(), PROFILE)).toEqual({
      profileId: 'fixture-agent',
      profileRevision: 3,
      connectionGeneration: 7,
      acpSessionId: 'sess-1',
      turnId: 'turn-7-1',
      jsonRpcRequestId: '3',
      hostReceiveSeq: 1,
      observedAtUtc: AT,
      messageKind: 'turn-started'
    });
  });

  it('builds a turn row for the attempt and a receipt that still needs host validation', () => {
    const bundle = accepted(started());
    expect(bundle.agentTurnRow).toEqual({
      turnId: 'turn-7-1',
      attemptId: 'attempt-1',
      internalSessionKey: 'fixture-agent@3:sess-1',
      connectionGeneration: 7,
      connectionLocalRequestId: '3'
    });
    expect(bundle.protocolReceiptRow).toMatchObject({
      receiptId: 'acp-receipt:7:seq-1',
      disposition: 'accepted-domain-observation',
      replayQuality: 'unavailable',
      phaseSettledByWireFrame: false,
      permissionGrantedByWireFrame: false,
      requiresHostResultValidation: true,
      effectivePhaseSettled: false
    });
    expect(bundle.providerSessionRow).toBeNull();
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['cancelled', 'canceled'],
    ['max_turn_requests', undefined],
    ['refusal', undefined]
  ] as const)('maps stop reason %s to the F02 stop reason %s', (acp, shared) => {
    const envelope = toSharedAcpEnvelope(completed(acp), PROFILE);
    expect(envelope.messageKind).toBe('turn-completed');
    expect(envelope.stopReason).toBe(shared);
    expect(Object.hasOwn(envelope, 'stopReason')).toBe(shared !== undefined);
    expect(accepted(completed(acp)).protocolReceiptRow.messageKind).toBe('turn-completed');
  });

  it('maps a live display update during a prompt to a session update of that turn', () => {
    const envelope = toSharedAcpEnvelope(display(LIVE), PROFILE);
    expect(envelope).toMatchObject({ messageKind: 'session-update', turnId: 'turn-7-1', hostReceiveSeq: 4 });
    expect(Object.hasOwn(envelope, 'jsonRpcRequestId')).toBe(false);
    expect(accepted(display(LIVE)).agentTurnRow).toMatchObject({ turnId: 'turn-7-1', connectionLocalRequestId: null });
  });

  it.each([
    ['history', HISTORY],
    ['idle', IDLE]
  ] as const)('gives a %s observation no turn and no request id, so no turn row', (_label, attribution) => {
    for (const observation of [display(attribution), usage(attribution)]) {
      const envelope = toSharedAcpEnvelope(observation, PROFILE);
      expect(Object.hasOwn(envelope, 'turnId')).toBe(false);
      expect(Object.hasOwn(envelope, 'jsonRpcRequestId')).toBe(false);
      const bundle = accepted(observation);
      expect(bundle.agentTurnRow).toBeNull();
      expect(bundle.protocolReceiptRow.turnId).toBeNull();
    }
  });

  it('maps usage to a usage update with no token delta, so the F02 ledger stays empty', () => {
    const ctx = context();
    const envelope = toSharedAcpEnvelope(usage(LIVE), PROFILE);
    expect(envelope.messageKind).toBe('usage-update');
    expect(Object.hasOwn(envelope, 'usageDelta')).toBe(false);
    expect(accepted(usage(LIVE), ctx).usageObservationRow).toBeNull();
    expect(ctx.ledger.observationsById.size).toBe(0);
  });

  it('is historical-unattributed when the observation is from an earlier generation', () => {
    const bundle = accepted(started(), context(8));
    expect(bundle.protocolReceiptRow.disposition).toBe('historical-unattributed');
    expect(bundle.agentConnectionRow.lifecycle).toBe('stale-historical');
    expect(bundle.agentTurnRow).toBeNull();
  });

  it('leaves F02 to refuse a request id that equals a global identity', () => {
    const outcome = normalizeAcpEventToDomainFixtures(toSharedAcpEnvelope(started(3), PROFILE), {
      ...context(),
      attemptId: '3'
    });
    expect(outcome).toMatchObject({ status: 'refused' });
  });
});
