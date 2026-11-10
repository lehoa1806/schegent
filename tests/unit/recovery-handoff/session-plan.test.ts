/**
 * FR-R6-F08 (FR-010, research R8, US5) — the session plan, table-driven.
 *
 * Every fresh-session reason, and the one row that loads the prior session. A fresh plan
 * carries no session id.
 */

import { describe, expect, it } from 'vitest';
import {
  planSession,
  type PriorSession,
  type SessionParty,
  type SessionPlanInput
} from '../../../src/services/recovery-handoff/session-plan';

const TARGET: SessionParty = {
  ownerDigest: 'own-a',
  backendId: 'backend-1',
  profileId: 'profile-1',
  profileVersion: '1',
  capabilitiesDigest: 'caps-1'
};

const PRIOR: PriorSession = { ...TARGET, sessionId: 'sess-acp-1', source: 'acp' };

function input(overrides: Partial<SessionPlanInput> = {}): SessionPlanInput {
  return { prior: PRIOR, target: TARGET, capability: 'declared', forceFresh: false, ...overrides };
}

describe('planSession (R8)', () => {
  it('loads the prior session only when every condition holds', () => {
    expect(planSession(input())).toEqual({ plan: 'load-session', sessionId: 'sess-acp-1' });
  });

  const rows: readonly (readonly [string, SessionPlanInput])[] = [
    ['uncertain-prior', input({ forceFresh: true })],
    ['no-prior-session', input({ prior: null })],
    ['legacy-session', input({ prior: { ...PRIOR, source: 'legacy' } })],
    ['owner-mismatch', input({ prior: { ...PRIOR, ownerDigest: 'own-b' } })],
    ['profile-changed', input({ prior: { ...PRIOR, profileId: 'profile-2' } })],
    ['profile-changed', input({ prior: { ...PRIOR, profileVersion: '2' } })],
    ['backend-changed', input({ prior: { ...PRIOR, backendId: 'backend-2' } })],
    ['capabilities-changed', input({ prior: { ...PRIOR, capabilitiesDigest: 'caps-2' } })],
    ['capability-absent', input({ capability: 'absent' })],
    ['capability-unknown', input({ capability: 'unknown' })]
  ];

  it.each(rows)('plans a fresh session for %s, with no session id', (reason, row) => {
    const plan = planSession(row);
    expect(plan).toEqual({ plan: 'fresh-session', reason });
    expect('sessionId' in plan).toBe(false);
  });

  it('reports the first reason that applies: an uncertain prior before a legacy session', () => {
    const row = input({ forceFresh: true, prior: { ...PRIOR, source: 'legacy', ownerDigest: 'own-b' } });
    expect(planSession(row)).toEqual({ plan: 'fresh-session', reason: 'uncertain-prior' });
  });

  it('reports a legacy session before an owner mismatch, so a foreign id is never compared', () => {
    const row = input({ prior: { ...PRIOR, source: 'legacy', ownerDigest: 'own-b' } });
    expect(planSession(row)).toEqual({ plan: 'fresh-session', reason: 'legacy-session' });
  });

  it('reports an owner mismatch before a changed profile or backend', () => {
    const row = input({ prior: { ...PRIOR, ownerDigest: 'own-b', profileId: 'profile-2', backendId: 'backend-2' } });
    expect(planSession(row)).toEqual({ plan: 'fresh-session', reason: 'owner-mismatch' });
  });
});
