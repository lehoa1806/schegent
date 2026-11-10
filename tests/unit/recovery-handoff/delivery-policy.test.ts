/**
 * FR-R6-F08 (FR-009, research R7, Clarification 4) — the redelivery policy, table-driven.
 *
 * Each refusal in order, the automatic new attempt after a refused-before-send intent under
 * `safe` certainty, the guard under `uncertain` and `unknown`, and the one new attempt an
 * accepted, unused `continue-new-attempt` decision permits.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateRedelivery,
  type RedeliveryDecision,
  type RedeliveryInput,
  type RedeliveryPriorIntent,
  type RedeliveryRequest
} from '../../../src/services/recovery-handoff/delivery-policy';

const REQUEST: RedeliveryRequest = {
  targetAttemptId: 'att-3',
  transport: 'acp',
  connectionId: 'conn-1',
  backendId: 'backend-1',
  profileId: 'profile-1',
  profileVersion: '1'
};

function prior(overrides: Partial<RedeliveryPriorIntent> = {}): RedeliveryPriorIntent {
  return {
    targetAttemptId: 'att-2',
    transport: 'acp',
    connectionId: 'conn-1',
    backendId: 'backend-1',
    profileId: 'profile-1',
    profileVersion: '1',
    outcome: 'uncertain',
    outcomeReason: 'restart-before-ack',
    ...overrides
  };
}

function decision(overrides: Partial<RedeliveryDecision> = {}): RedeliveryDecision {
  return {
    decisionId: 'dec-1',
    revisionNo: 2,
    decision: 'continue-new-attempt',
    outcome: 'accepted',
    consumedByIntentId: null,
    ...overrides
  };
}

function input(overrides: Partial<RedeliveryInput> = {}): RedeliveryInput {
  return {
    handoff: { state: 'ready', currentRevision: 2, sourceAttemptId: 'att-1' },
    revisionNo: 2,
    certainty: 'safe',
    priorIntents: [],
    decisions: [],
    request: REQUEST,
    ...overrides
  };
}

const REFUSED_NOT_SENT = prior({ outcome: 'refused', outcomeReason: 'not-sent' });

describe('evaluateRedelivery refusal order (R7)', () => {
  const rows: readonly (readonly [string, RedeliveryInput, string])[] = [
    [
      'a consumed handoff before every later refusal',
      input({
        handoff: { state: 'consumed', currentRevision: 2, sourceAttemptId: 'att-1' },
        revisionNo: 1,
        priorIntents: [prior({ outcome: 'pending', outcomeReason: null })]
      }),
      'handoff-closed'
    ],
    [
      'a superseded handoff',
      input({ handoff: { state: 'superseded', currentRevision: 2, sourceAttemptId: 'att-1' } }),
      'handoff-closed'
    ],
    [
      'an unsupported handoff before a stale revision',
      input({ handoff: { state: 'unsupported', currentRevision: 2, sourceAttemptId: 'att-1' }, revisionNo: 1 }),
      'unsupported-version'
    ],
    [
      'a stale revision before an intent in flight',
      input({ revisionNo: 1, priorIntents: [prior({ outcome: 'pending', outcomeReason: null })] }),
      'stale-revision'
    ],
    [
      'a handoff with no issued revision',
      input({ handoff: { state: 'preparing', currentRevision: null, sourceAttemptId: 'att-1' } }),
      'stale-revision'
    ],
    [
      'an intent in flight before a reused attempt',
      input({ priorIntents: [prior({ targetAttemptId: 'att-3', outcome: 'pending', outcomeReason: null })] }),
      'delivery-in-flight'
    ],
    [
      'a target used by an earlier intent',
      input({ priorIntents: [REFUSED_NOT_SENT], request: { ...REQUEST, targetAttemptId: 'att-2' } }),
      'attempt-reused'
    ],
    [
      'the source attempt as the target',
      input({ request: { ...REQUEST, targetAttemptId: 'att-1' } }),
      'attempt-reused'
    ],
    [
      'a direct backend before a new connection',
      input({ priorIntents: [prior()], request: { ...REQUEST, transport: 'direct', connectionId: 'conn-2' } }),
      'direct-backend-refused'
    ],
    [
      'a new connection before another profile',
      input({ priorIntents: [prior()], request: { ...REQUEST, connectionId: 'conn-2', profileId: 'profile-2' } }),
      'new-connection-refused'
    ],
    [
      'another profile',
      input({ priorIntents: [prior()], request: { ...REQUEST, profileId: 'profile-2' } }),
      'profile-changed-refused'
    ],
    [
      'another profile version',
      input({ priorIntents: [prior()], request: { ...REQUEST, profileVersion: '2' } }),
      'profile-changed-refused'
    ],
    ['the same connection and profile', input({ priorIntents: [prior()] }), 'decision-required']
  ];

  it.each(rows)('refuses %s', (_label, row, code) => {
    expect(evaluateRedelivery(row)).toEqual({ ok: false, code });
  });
});

describe('evaluateRedelivery automatic attempts', () => {
  it('permits a first delivery under any certainty, with no decision and no forced fresh session', () => {
    for (const certainty of ['safe', 'uncertain', 'unknown'] as const) {
      expect(evaluateRedelivery(input({ certainty }))).toEqual({ ok: true, decisionId: null, forceFresh: false });
    }
  });

  it('permits a new attempt after a refused-before-send intent under safe certainty', () => {
    const row = input({ priorIntents: [REFUSED_NOT_SENT], request: { ...REQUEST, connectionId: 'conn-2' } });
    expect(evaluateRedelivery(row)).toEqual({ ok: true, decisionId: null, forceFresh: false });
  });

  it('needs a decision after a refused-before-send intent when certainty is not safe', () => {
    for (const certainty of ['uncertain', 'unknown'] as const) {
      expect(evaluateRedelivery(input({ certainty, priorIntents: [REFUSED_NOT_SENT] }))).toEqual({
        ok: false,
        code: 'decision-required'
      });
    }
  });

  it('needs a decision after an acknowledged intent, even under safe certainty', () => {
    const acknowledged = prior({ outcome: 'acknowledged', outcomeReason: null });
    expect(evaluateRedelivery(input({ priorIntents: [acknowledged] }))).toEqual({
      ok: false,
      code: 'decision-required'
    });
  });

  it('needs a decision when any earlier intent was sent', () => {
    const row = input({ priorIntents: [REFUSED_NOT_SENT, prior({ targetAttemptId: 'att-4' })] });
    expect(evaluateRedelivery(row)).toEqual({ ok: false, code: 'decision-required' });
  });
});

describe('evaluateRedelivery guard under uncertain and unknown certainty', () => {
  const changes: readonly (readonly [string, Partial<RedeliveryRequest>, string])[] = [
    ['a new connection', { connectionId: 'conn-2' }, 'new-connection-refused'],
    ['a missing connection', { connectionId: null }, 'new-connection-refused'],
    ['another profile', { profileId: 'profile-2' }, 'profile-changed-refused'],
    ['a direct backend', { transport: 'direct' }, 'direct-backend-refused']
  ];

  for (const certainty of ['uncertain', 'unknown'] as const) {
    it.each(changes)(`refuses ${certainty}: %s without a decision`, (_label, change, code) => {
      const row = input({ certainty, priorIntents: [prior()], request: { ...REQUEST, ...change } });
      expect(evaluateRedelivery(row)).toEqual({ ok: false, code });
    });
  }

  it('never permits a direct backend, even with an accepted, unused decision', () => {
    for (const certainty of ['safe', 'uncertain', 'unknown'] as const) {
      const row = input({
        certainty,
        priorIntents: [prior()],
        decisions: [decision()],
        request: { ...REQUEST, transport: 'direct' }
      });
      expect(evaluateRedelivery(row)).toEqual({ ok: false, code: 'direct-backend-refused' });
    }
  });
});

describe('evaluateRedelivery with an operator decision', () => {
  it('permits one new attempt with a forced fresh session on an accepted, unused decision', () => {
    const row = input({
      certainty: 'unknown',
      priorIntents: [prior()],
      decisions: [decision()],
      request: { ...REQUEST, connectionId: 'conn-2', profileId: 'profile-2' }
    });
    expect(evaluateRedelivery(row)).toEqual({ ok: true, decisionId: 'dec-1', forceFresh: true });
  });

  it('permits no second attempt once the decision is consumed', () => {
    const used = decision({ consumedByIntentId: 'int-1' });
    const row = input({ certainty: 'uncertain', priorIntents: [prior()], decisions: [used] });
    expect(evaluateRedelivery(row)).toEqual({ ok: false, code: 'decision-required' });
  });

  const unusable: readonly (readonly [string, RedeliveryDecision])[] = [
    ['an earlier revision', decision({ revisionNo: 1 })],
    ['an abandon decision', decision({ decision: 'abandon' })],
    ['a refused-stale outcome', decision({ outcome: 'refused-stale' })],
    ['a refused-closed outcome', decision({ outcome: 'refused-closed' })]
  ];

  it.each(unusable)('ignores a decision on %s', (_label, row) => {
    const evaluated = evaluateRedelivery(input({ certainty: 'uncertain', priorIntents: [prior()], decisions: [row] }));
    expect(evaluated).toEqual({ ok: false, code: 'decision-required' });
  });

  it('uses the unused decision when an older one is consumed', () => {
    const decisions = [decision({ consumedByIntentId: 'int-1' }), decision({ decisionId: 'dec-2' })];
    const row = input({ certainty: 'uncertain', priorIntents: [prior()], decisions });
    expect(evaluateRedelivery(row)).toEqual({ ok: true, decisionId: 'dec-2', forceFresh: true });
  });
});
