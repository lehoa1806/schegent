import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_DIGEST_ALG,
  digestOf,
  isAuditCutRecord,
  verifyChain,
  type AuditCutRecord
} from '../../../src/audit/audit-chain';

/**
 * FR-R3-112 (FR-124, FR-125, FR-126, FR-126a) — tampering with the audit log is evident.
 *
 * THE THREAT, previously disclosed as `T3` and nothing more: the CLI runs with the OS user's
 * authority and `.schegent/audit.log` is an ordinary 0600 file in the workspace. So every record
 * this round added was operational telemetry rather than evidence, against the one actor the log
 * exists to describe.
 *
 * WHAT THIS ESTABLISHES, precisely. Editing one entry breaks its successor's link and the verifier
 * names the FIRST break. That makes tampering **evident**, not impossible — the chain head is on the
 * same disk, so an attacker who can edit the log can recompute every later digest. What they cannot
 * do is edit one entry and leave the rest alone.
 *
 * THE TWO CASES THAT WOULD HAVE KILLED IT. A verifier that cried wolf on a routine retention prune,
 * or on every pre-existing log, would be turned off in a week. Both are handled and both are tested
 * here in BOTH directions — the excuse must not become a hole.
 */

/** Build a well-formed chain of `n` entries, returning the lines as they would sit on disk. */
function chain(n: number, seed = AUDIT_CHAIN_GENESIS): string[] {
  const lines: string[] = [];
  let prev = seed;
  for (let i = 0; i < n; i++) {
    const line = JSON.stringify({
      id: `entry-${i}`,
      eventType: 'phase-end',
      prevDigest: prev,
      digestAlg: AUDIT_DIGEST_ALG
    });
    lines.push(line);
    prev = digestOf(line);
  }
  return lines;
}

const lastDigest = (lines: readonly string[]): string => digestOf(lines[lines.length - 1] as string);

describe('FR-R3-112 — the chain verifies an untouched log', () => {
  it('an intact chain verifies, and counts what it covered', () => {
    const verdict = verifyChain(chain(5));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.entries).toBe(5);
    expect(verdict.cuts).toBe(0);
    expect(verdict.unchainedPrefix).toBe(0);
  });

  it('an empty log verifies — nothing to verify is not a failure', () => {
    expect(verifyChain([]).ok).toBe(true);
    expect(verifyChain(['', '  ', '']).ok).toBe(true);
  });

  it('the digest is over the BYTES on disk, not a re-serialization', () => {
    // A verifier reads lines from a file. Hashing a re-serialized object would couple the chain to
    // both sides producing identical JSON — key order, number formatting, unicode escapes — and
    // its failure mode would be a break reported on an untouched file.
    const line = JSON.stringify({ b: 2, a: 1 });
    const reordered = JSON.stringify({ a: 1, b: 2 });
    expect(line).not.toBe(reordered);
    expect(digestOf(line)).not.toBe(digestOf(reordered));
  });
});

describe('FR-R3-112 — editing one entry is named', () => {
  it('names the entry whose link broke, not every entry after it', () => {
    // First, not all: a broken link makes every later link unverifiable, so reporting them all
    // would bury the one that matters under noise that follows from it.
    const lines = chain(6);
    lines[2] = JSON.stringify({ ...JSON.parse(lines[2] as string), eventType: 'tampered' });
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // Entry 3 (1-based) still links correctly to entry 2's OLD digest... which changed. So the
    // break surfaces at entry 4.
    expect(verdict.atEntry).toBe(4);
    expect(verdict.reason).toBe('broken-link');
  });

  it('detects an entry deleted outright, with no cut record', () => {
    const lines = chain(5);
    lines.splice(2, 1);
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('broken-link');
    expect(verdict.detail).toContain('removed without a cut record');
  });

  it('detects a re-ordered pair', () => {
    const lines = chain(5);
    [lines[1], lines[2]] = [lines[2] as string, lines[1] as string];
    expect(verifyChain(lines).ok).toBe(false);
  });

  it('reports a truncated final line as MALFORMED, not as tampering', () => {
    // A truncated last line is the expected shape of a power-loss casualty, and the durability
    // decision discloses exactly that. It has a different remedy from tampering, so it gets a
    // different verdict.
    const lines = chain(3);
    lines.push('{"id":"half-writ');
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('malformed');
    expect(verdict.detail).toContain('truncated');
  });
});

describe('FR-R3-112 — a legitimate prune verifies; a silent removal does not', () => {
  const cut = (from: string, to: string, count: number): string =>
    JSON.stringify({
      kind: 'audit-cut',
      cutAtMs: 1_700_000_000_000,
      removedFrom: from,
      removedTo: to,
      removedCount: count
    } satisfies AuditCutRecord);

  it('a pruned range verifies when a cut record covers it', () => {
    // The legitimate operation that most resembles tampering. Entries disappear; the cut record is
    // what makes that distinguishable from an edit.
    const removed = chain(4);
    const survivors = chain(3, lastDigest(removed));
    const lines = [cut(AUDIT_CHAIN_GENESIS, lastDigest(removed), removed.length), ...survivors];
    const verdict = verifyChain(lines);
    expect(verdict.ok, 'a pruned log must verify, or the verifier gets turned off').toBe(true);
    if (!verdict.ok) return;
    expect(verdict.cuts).toBe(1);
    expect(verdict.entries).toBe(3);
  });

  it('the SAME removal without a cut record is a break', () => {
    // Both directions, because an excuse that cannot fail is a hole.
    const removed = chain(4);
    const survivors = chain(3, lastDigest(removed));
    expect(verifyChain(survivors).ok, 'survivors alone must not verify').toBe(false);
    expect(removed.length).toBe(4);
  });

  it('a cut record that does not join up is a break', () => {
    // A forged or stale cut record must not paper over a discontinuity it does not describe.
    const survivors = chain(3, 'some-other-digest');
    const lines = [cut(AUDIT_CHAIN_GENESIS, 'a-digest-that-is-not-the-successors', 4), ...survivors];
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('broken-link');
  });

  it('verifies across a rotation boundary, which is just concatenation in order', () => {
    // The chain crosses files: a rotated file's first entry links to the previous file's last.
    const older = chain(3);
    const newer = chain(3, lastDigest(older));
    expect(verifyChain([...older, ...newer]).ok).toBe(true);
    // ...and in the WRONG order it does not, which is why the read order lives in the script that
    // knows the rotation naming rather than being assumed here.
    expect(verifyChain([...newer, ...older]).ok).toBe(false);
  });

  it('the cut-record predicate refuses a near-miss shape', () => {
    expect(isAuditCutRecord({ kind: 'audit-cut', cutAtMs: 1, removedFrom: 'a', removedTo: 'b', removedCount: 1 })).toBe(true);
    expect(isAuditCutRecord({ kind: 'audit-cut', cutAtMs: 1, removedFrom: 'a', removedTo: 'b' })).toBe(false);
    expect(isAuditCutRecord({ kind: 'something-else' })).toBe(false);
    expect(isAuditCutRecord(null)).toBe(false);
  });
});

describe('FR-R3-112 — a pre-chain log is not a tampered log', () => {
  const legacy = (id: string): string => JSON.stringify({ id, eventType: 'phase-end' });

  it('a leading run of unchained entries is excused, and COUNTED', () => {
    // Every workspace that ran a phase before this feature has a log full of unchained entries.
    // Reporting them as tampering would make the verifier's first run on every existing
    // installation claim the log was altered.
    const lines = [legacy('old-1'), legacy('old-2'), ...chain(2)];
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.unchainedPrefix, 'the uncovered count must be reported, not hidden').toBe(2);
    expect(verdict.entries).toBe(2);
  });

  it('an entirely pre-chain log verifies, with everything reported as uncovered', () => {
    const verdict = verifyChain([legacy('a'), legacy('b'), legacy('c')]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.unchainedPrefix).toBe(3);
    expect(verdict.entries).toBe(0);
  });

  it('an unchained entry AFTER a chained one is a break, not legacy data', () => {
    // The fail-open this excuse could have become. Removing a link is exactly what an unchained
    // entry mid-file looks like, so the excuse is a PREFIX and nothing else.
    const lines = [...chain(2), legacy('injected')];
    const verdict = verifyChain(lines);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('malformed');
    expect(verdict.detail).toContain('leading prefix');
  });
});
