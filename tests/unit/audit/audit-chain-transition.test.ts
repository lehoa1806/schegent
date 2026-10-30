import { describe, expect, it } from 'vitest';
import { AUDIT_CHAIN_GENESIS, digestOf, verifyChain } from '../../../src/audit/audit-chain';

/**
 * FR-R4-F03 (FR-001, FR-002, FR-003; contract T1, V1, V2) — the legacy transition rule, pure.
 *
 * The verifier must accept the two first links the shipped writers produce after a legacy prefix,
 * and nothing else: `genesis` (form A: the first chained row was written onto an empty log or by an
 * older release) and the digest of the last legacy row (form B: a writer constructed over a legacy
 * log seeds from its last line). This file pins each row of contract T1's table over hand-built
 * lines, so a failure names the rule rather than a writer behaviour. The same two forms are proven
 * with the real writer in `audit-chain-legacy-real-writer.test.ts`.
 */

const legacyRow = (n: number): string =>
  JSON.stringify({ id: `legacy-${n}`, eventType: 'phase-start', runId: 'r', payload: {} });

const chainedRow = (n: number, prevDigest: string): string =>
  JSON.stringify({
    id: `chained-${n}`,
    eventType: 'phase-start',
    runId: 'r',
    payload: {},
    prevDigest,
    digestAlg: 'sha256'
  });

/** `count` chained rows starting from `from`; `head` is the digest the next row would link to. */
function chainFrom(from: string, count: number): { lines: string[]; head: string } {
  const lines: string[] = [];
  let head = from;
  for (let n = 0; n < count; n += 1) {
    const line = chainedRow(n, head);
    lines.push(line);
    head = digestOf(line);
  }
  return { lines, head };
}

const cutRecord = (fields: Record<string, unknown>): string =>
  JSON.stringify({ kind: 'audit-cut', cutAtMs: 1_700_000_000_000, ...fields });

describe('the legacy transition (V1)', () => {
  it('accepts a legacy prefix followed by a row linked to genesis (form A)', () => {
    const legacy = [legacyRow(0), legacyRow(1), legacyRow(2)];
    const verdict = verifyChain([...legacy, ...chainFrom(AUDIT_CHAIN_GENESIS, 2).lines]);
    expect(verdict).toMatchObject({
      ok: true,
      entries: 2,
      unchainedPrefix: 3,
      prunedLegacy: 0,
      transition: 'genesis'
    });
  });

  it('accepts a legacy prefix followed by a row linked to the last legacy row (form B)', () => {
    const legacy = [legacyRow(0), legacyRow(1), legacyRow(2)];
    const chained = chainFrom(digestOf(legacy[2] as string), 3).lines;
    const verdict = verifyChain([...legacy, ...chained]);
    expect(verdict).toMatchObject({
      ok: true,
      entries: 3,
      unchainedPrefix: 3,
      prunedLegacy: 0,
      transition: 'legacy-tail'
    });
  });

  it('reports no transition when there is no chained row', () => {
    expect(verifyChain([legacyRow(0), legacyRow(1)])).toMatchObject({
      ok: true,
      entries: 0,
      unchainedPrefix: 2,
      transition: null
    });
  });

  it('refuses a first chained row linked to an earlier legacy row, not the last', () => {
    const legacy = [legacyRow(0), legacyRow(1), legacyRow(2)];
    const chained = chainFrom(digestOf(legacy[0] as string), 1).lines;
    expect(verifyChain([...legacy, ...chained])).toMatchObject({
      ok: false,
      reason: 'broken-link',
      atEntry: 4
    });
  });

  it('refuses a first chained row linked to a digest no legacy row produces', () => {
    const chained = chainFrom('f'.repeat(64), 1).lines;
    expect(verifyChain([legacyRow(0), ...chained])).toMatchObject({
      ok: false,
      reason: 'broken-link',
      atEntry: 2
    });
  });

  it('refuses a second genesis link after the chain began', () => {
    const first = chainFrom(AUDIT_CHAIN_GENESIS, 1).lines;
    expect(verifyChain([...first, chainedRow(9, AUDIT_CHAIN_GENESIS)])).toMatchObject({
      ok: false,
      reason: 'broken-link',
      atEntry: 2
    });
  });

  it('calls an unchained row after the transition malformed', () => {
    const legacy = [legacyRow(0)];
    const chained = chainFrom(digestOf(legacy[0] as string), 1).lines;
    expect(verifyChain([...legacy, ...chained, legacyRow(7)])).toMatchObject({
      ok: false,
      reason: 'malformed',
      atEntry: 3
    });
  });
});

describe('cut records that removed legacy rows (V2)', () => {
  it('accepts a legacy-only v2 cut, then a row linked to its legacy tail', () => {
    const tail = digestOf(legacyRow(5));
    const cut = cutRecord({
      removedFrom: AUDIT_CHAIN_GENESIS,
      removedTo: AUDIT_CHAIN_GENESIS,
      removedCount: 6,
      version: 2,
      removedChained: 0,
      removedLegacy: 6,
      legacyTail: tail
    });
    const verdict = verifyChain([cut, ...chainFrom(tail, 2).lines]);
    expect(verdict).toMatchObject({
      ok: true,
      entries: 2,
      cuts: 1,
      unchainedPrefix: 0,
      prunedLegacy: 6,
      transition: 'legacy-tail'
    });
  });

  it('still accepts a legacy-only v2 cut followed by a row linked to genesis (an older release)', () => {
    const cut = cutRecord({
      removedFrom: AUDIT_CHAIN_GENESIS,
      removedTo: AUDIT_CHAIN_GENESIS,
      removedCount: 2,
      version: 2,
      removedChained: 0,
      removedLegacy: 2,
      legacyTail: digestOf(legacyRow(1))
    });
    const verdict = verifyChain([cut, ...chainFrom(AUDIT_CHAIN_GENESIS, 1).lines]);
    expect(verdict).toMatchObject({ ok: true, prunedLegacy: 2, transition: 'genesis' });
  });

  it('accepts a mixed v2 cut whose removedFrom equals its legacy tail', () => {
    const tail = digestOf(legacyRow(1));
    const removed = chainFrom(tail, 2);
    const cut = cutRecord({
      removedFrom: tail,
      removedTo: removed.head,
      removedCount: 4,
      version: 2,
      removedChained: 2,
      removedLegacy: 2,
      legacyTail: tail
    });
    const verdict = verifyChain([cut, ...chainFrom(removed.head, 2).lines]);
    expect(verdict).toMatchObject({
      ok: true,
      entries: 2,
      cuts: 1,
      prunedLegacy: 2,
      transition: 'legacy-tail'
    });
  });

  it('refuses a v1 cut at a form-B boundary, naming the cut written before this release', () => {
    const tail = digestOf(legacyRow(1));
    const removed = chainFrom(tail, 2);
    const cut = cutRecord({ removedFrom: tail, removedTo: removed.head, removedCount: 4 });
    const verdict = verifyChain([cut, ...chainFrom(removed.head, 1).lines]);
    expect(verdict).toMatchObject({ ok: false, reason: 'broken-link', atEntry: 1 });
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toMatch(/written before this release/);
  });

  it('refuses a cut of a version this release does not know, at that line', () => {
    const cut = cutRecord({
      removedFrom: AUDIT_CHAIN_GENESIS,
      removedTo: AUDIT_CHAIN_GENESIS,
      removedCount: 1,
      version: 3
    });
    expect(verifyChain([cut, ...chainFrom(AUDIT_CHAIN_GENESIS, 1).lines])).toMatchObject({
      ok: false,
      reason: 'malformed',
      atEntry: 1
    });
  });
});
