import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-083 (T1149) — three documents must agree that these limits are permanent,
 * and a gate fails when any one of them stops saying so.
 *
 * WHY THIS NEEDS A GATE AT ALL
 *
 * A permanent limit is the easiest kind of statement to lose. It describes
 * something that is not going to change, so nobody revisits it; and it lives in
 * three places at once, because an operator, an architect and a maintainer each
 * arrive from a different direction. The failure is not that someone argues with
 * it — it is that one copy gets rewritten during an unrelated edit and now two
 * documents disagree about whether the product is going to close a hole.
 *
 * `FR-R3-063` established that a documented invariant with no mechanical guard is
 * a defect rather than a convention. This is that rule applied to the one class of
 * statement whose whole value is that it stays put.
 *
 * WHAT IS BOUND, AND WHAT IS SEPARATE
 *
 * Three documents state the SAME limit — the native-binding decision — from three
 * angles: the record itself (the authority), `docs/operations/backends.md` (the
 * operator's view of the Job Object escape), and the migration ledger (the
 * mechanism's view of `openat`/`renameat`).
 *
 * `workspace-ownership-fencing.md` is checked as its OWN assertion, not as a fourth
 * copy. Its limit is a different one — the mount's exclusive-create atomicity —
 * and `FR-R3-083` §5 requires the `FR-R3-040` disclosure be strengthened to
 * *permanent* without being duplicated into a second authority. So it must say
 * `permanent` and must cite the record; it must not restate the record's reasoning.
 *
 * HERMETIC (FR-R3-033, T1118a): file sets are read with `readFileSync`, never by
 * spawning a binary this project does not declare.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

const RECORD = 'docs/architecture/native-binding-decision.md';
const OPERATIONS = 'docs/operations/backends.md';
const LEDGER = 'tests/lint/safe-open-migration.test.ts';
const FENCING_ADR = 'docs/architecture/workspace-ownership-fencing.md';

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, ...relPath.split('/')), 'utf8');
}

/**
 * What each bound document must still be saying.
 *
 * Deliberately a SHAPE and not a sentence. Pinning exact prose would make every
 * copy-edit a gate failure, which is how a gate gets turned off; pinning the two
 * things that carry the meaning — that the limit is permanent, and where it was
 * decided — is what actually has to survive.
 */
const BOUND_DOCUMENTS: readonly { readonly path: string; readonly what: string }[] = [
  { path: RECORD, what: 'the decision itself' },
  { path: OPERATIONS, what: "the operator's view of the Job Object escape" },
  { path: LEDGER, what: "the mechanism's view of the openat/renameat residuals" }
];

describe('permanent-limit agreement (FR-R3-083)', () => {
  it.each(BOUND_DOCUMENTS)('$path states the limit is permanent ($what)', ({ path }) => {
    const body = read(path);
    // If this fails: the document stopped saying the limit is permanent. Restore
    // the statement, or — if the decision genuinely changed — change the record
    // first and bring all three with it. Do not delete the sentence to pass.
    expect(body).toMatch(/PERMANENT|Permanent limit|permanent, not current|permanently/);
  });

  it.each(BOUND_DOCUMENTS.filter((d) => d.path !== RECORD))(
    '$path cites the decision record rather than re-arguing it',
    ({ path }) => {
      // One authority. A document that restates the reasoning becomes a second one,
      // and the two drift the moment either is edited.
      expect(read(path)).toContain('native-binding-decision.md');
    }
  );

  it('keeps the fencing ADR as its own assertion, not a fourth copy', () => {
    // FR-029. The mount limit and the native-binding limit are DIFFERENT limits.
    // This ADR must say its own is permanent and must point at the record for the
    // dependency question — without duplicating the record's argument, which is
    // what would make it a rival authority.
    const adr = read(FENCING_ADR);
    expect(adr).toMatch(/permanent, not current|permanently/);
    expect(adr).toContain('native-binding-decision.md');
    // The rejected branch's costing belongs to the record alone. If this fails, the
    // ADR has started making the record's argument instead of citing it.
    expect(adr).not.toContain('prebuild matrix');
  });

  it('fails loudly if the record itself stops taking a decision', () => {
    // Everything above rests on the record being a decision rather than a
    // discussion. A record that softened to "under consideration" would leave three
    // documents asserting permanence on nothing.
    const record = read(RECORD);
    expect(record).toContain('DECIDED');
    expect(record).toMatch(/rejected/);
    // And it must still name what would reverse it, or "permanent" becomes
    // "forever", which is a claim this project does not make.
    expect(record).toMatch(/reverse|reopen/i);
  });
});
