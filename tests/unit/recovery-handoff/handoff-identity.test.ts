// FR-R6-F08 T006 — the deterministic identities of a handoff (research R2, R3, R7, R8).
//
// WHAT THIS PINS:
//   - identical inputs give the identical 64-hex id, so a retried write lands on one row;
//   - any changed field changes the id;
//   - the tagged JSON encoding keeps separators from colliding;
//   - each id kind is tagged, so equal inputs to two kinds never give one id;
//   - every id is a valid F05 opaque id.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_OPAQUE_ID_PATTERN } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  cutoffKeyFor,
  decisionIdFor,
  handoffIdFor,
  intentIdFor,
  ownerDigestFor
} from '../../../src/services/recovery-handoff/handoff-identity';

const HEX_64 = /^[0-9a-f]{64}$/;

const LINEAGE = Object.freeze({
  workspaceId: 'ws-1',
  rootExecutionId: 'root-1',
  invocationId: 'inv-1',
  sourceAttemptId: 'att-1'
});

const CUTOFF = Object.freeze({ executionRevision: 'exec-7', usageRevision: 3, factCutoffMs: 1_800_000_000_000 });

function sha(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

describe('FR-R6-F08 T006 — handoff identities', () => {
  it('gives the identical 64-hex id for identical inputs', () => {
    const ids = [
      handoffIdFor(LINEAGE),
      cutoffKeyFor(CUTOFF),
      intentIdFor('h'.repeat(64), 'att-2'),
      decisionIdFor('h'.repeat(64), 'req-1'),
      ownerDigestFor({ agentId: 'claude', accountScope: 'acct-1' })
    ];
    for (const id of ids) {
      expect(id).toMatch(HEX_64);
    }
    expect(handoffIdFor({ ...LINEAGE })).toBe(ids.at(0));
    expect(cutoffKeyFor({ ...CUTOFF })).toBe(ids.at(1));
    expect(intentIdFor('h'.repeat(64), 'att-2')).toBe(ids.at(2));
    expect(decisionIdFor('h'.repeat(64), 'req-1')).toBe(ids.at(3));
    expect(ownerDigestFor({ agentId: 'claude', accountScope: 'acct-1' })).toBe(ids.at(4));
  });

  it('is the SHA-256 of the tagged JSON array named by the research', () => {
    expect(handoffIdFor(LINEAGE)).toBe(sha(['hof1', 'ws-1', 'root-1', 'inv-1', 'att-1']));
    expect(cutoffKeyFor(CUTOFF)).toBe(sha(['cut1', 'exec-7', 3, 1_800_000_000_000]));
    expect(intentIdFor('h1', 'att-2')).toBe(sha(['int1', 'h1', 'att-2']));
    expect(decisionIdFor('h1', 'req-1')).toBe(sha(['dec1', 'h1', 'req-1']));
    expect(ownerDigestFor({ agentId: 'a', accountScope: 'b' })).toBe(sha(['own1', 'a', 'b']));
  });

  it('changes the id when any field changes', () => {
    const base = handoffIdFor(LINEAGE);
    for (const key of Object.keys(LINEAGE) as (keyof typeof LINEAGE)[]) {
      expect(handoffIdFor({ ...LINEAGE, [key]: `${LINEAGE[key]}x` }), key).not.toBe(base);
    }
    const cutoff = cutoffKeyFor(CUTOFF);
    expect(cutoffKeyFor({ ...CUTOFF, executionRevision: 'exec-8' })).not.toBe(cutoff);
    expect(cutoffKeyFor({ ...CUTOFF, usageRevision: 4 })).not.toBe(cutoff);
    expect(cutoffKeyFor({ ...CUTOFF, factCutoffMs: CUTOFF.factCutoffMs + 1 })).not.toBe(cutoff);
    expect(intentIdFor('h1', 'att-3')).not.toBe(intentIdFor('h1', 'att-2'));
    expect(decisionIdFor('h1', 'req-2')).not.toBe(decisionIdFor('h1', 'req-1'));
    expect(ownerDigestFor({ agentId: 'a', accountScope: 'c' })).not.toBe(ownerDigestFor({ agentId: 'a', accountScope: 'b' }));
  });

  it('keeps separator characters from colliding', () => {
    expect(intentIdFor('a:b', 'c')).not.toBe(intentIdFor('a', 'b:c'));
    expect(decisionIdFor('a","b', 'c')).not.toBe(decisionIdFor('a', 'b","c'));
    expect(ownerDigestFor({ agentId: 'a|b', accountScope: 'c' })).not.toBe(
      ownerDigestFor({ agentId: 'a', accountScope: 'b|c' })
    );
    expect(cutoffKeyFor({ ...CUTOFF, executionRevision: '3' })).not.toBe(
      cutoffKeyFor({ ...CUTOFF, executionRevision: 3 as unknown as string })
    );
  });

  it('tags each kind, so equal inputs to two kinds never give one id', () => {
    expect(intentIdFor('h1', 'x')).not.toBe(decisionIdFor('h1', 'x'));
    expect(ownerDigestFor({ agentId: 'h1', accountScope: 'x' })).not.toBe(intentIdFor('h1', 'x'));
  });

  it('gives ids that are valid F05 opaque ids', () => {
    for (const id of [
      handoffIdFor(LINEAGE),
      cutoffKeyFor(CUTOFF),
      intentIdFor('h1', 'att-2'),
      decisionIdFor('h1', 'req-1'),
      ownerDigestFor({ agentId: 'a', accountScope: 'b' })
    ]) {
      expect(LIFECYCLE_OPAQUE_ID_PATTERN.test(id)).toBe(true);
    }
  });
});
