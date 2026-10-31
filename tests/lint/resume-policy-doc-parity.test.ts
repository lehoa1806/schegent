// FR-R4-F06 (FR-018; L7; contract P, P10) -- the resume policy is stated once in code and the
// two documents that describe it carry marked copies of it, checked against it.
//
// WHY THIS EXISTS. `RESUME_ON` in `src/contracts/spawn-identity.ts` is the single statement of
// which liveness verdicts permit a resume. `docs/operations/backends.md` ("Resume after a
// restart") and the threat model's T26 each say the same thing in prose, and "aligned" between
// two pages and a constant is a parity claim, which this repository checks. A page that said
// `orphaned-group` resumes, or left `unanswerable` out, would tell an operator the opposite of
// what the product does.
//
// BOTH LISTS. The set of verdicts that permit a resume (`RESUME_ON`), and the set of all
// verdicts (the members of `LivenessVerdict`). The second is what catches a verdict added to the
// type that no page mentions. The members are read from the source module's TEXT, because a
// union type has no runtime value to import.
//
// WHAT IT DOES NOT CHECK. The prose around the lists. It checks that the lists agree with the
// code, not that every sentence beside them is true.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RESUME_ON } from '../../src/contracts/spawn-identity';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_PATH = 'src/contracts/spawn-identity.ts';
const DOCUMENTS = ['docs/operations/backends.md', 'docs/security/threat-model.md'] as const;
const RESUME_ON_MARKER = 'resume-on';
const VERDICTS_MARKER = 'liveness-verdicts';

/** The members of `LivenessVerdict`, read from the declaration's text. */
function livenessVerdictMembers(): readonly string[] {
  const source = readFileSync(resolve(REPO_ROOT, SOURCE_PATH), 'utf8');
  const declaration = /export type LivenessVerdict\s*=\s*([^;]+);/.exec(source);
  if (declaration?.[1] === undefined) throw new Error(`LivenessVerdict is not declared in ${SOURCE_PATH}`);
  return [...declaration[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
}

/**
 * The backticked verdicts between `<!-- name:start -->` and `<!-- name:end -->`, or `null` when
 * either marker is missing. A missing marker is a failure, never an empty list.
 */
function markedList(body: string, name: string): readonly string[] | null {
  const open = `<!-- ${name}:start -->`;
  const close = `<!-- ${name}:end -->`;
  const from = body.indexOf(open);
  const to = body.indexOf(close);
  if (from === -1 || to === -1 || to < from) return null;
  return [...body.slice(from + open.length, to).matchAll(/`([a-z-]+)`/g)].map((match) => match[1]!);
}

/** `null` when the list matches, otherwise what differs. */
function differenceFrom(list: readonly string[] | null, expected: readonly string[]): string | null {
  if (list === null) return 'the marked block is missing';
  const have = [...list].sort();
  const want = [...expected].sort();
  return JSON.stringify(have) === JSON.stringify(want)
    ? null
    : `the list holds ${JSON.stringify(have)} but the code holds ${JSON.stringify(want)}`;
}

describe('the resume policy documents agree with RESUME_ON and LivenessVerdict (L7)', () => {
  const members = livenessVerdictMembers();

  it('reads the members from the source, and orphaned-group is one of them and is not in RESUME_ON', () => {
    // A control for the reader itself: an empty read would make every comparison below vacuous.
    expect(members.length).toBeGreaterThanOrEqual(5);
    expect(members).toContain('orphaned-group');
    expect([...RESUME_ON]).not.toContain('orphaned-group');
    for (const verdict of RESUME_ON) expect(members).toContain(verdict);
  });

  describe.each(DOCUMENTS)('%s', (document) => {
    const body = readFileSync(resolve(REPO_ROOT, document), 'utf8');

    it('carries a marked list of the verdicts that permit a resume, equal to RESUME_ON', () => {
      expect(differenceFrom(markedList(body, RESUME_ON_MARKER), RESUME_ON)).toBeNull();
    });

    it('carries a marked list of every verdict, equal to the LivenessVerdict members', () => {
      expect(differenceFrom(markedList(body, VERDICTS_MARKER), members)).toBeNull();
    });
  });

  describe('the check itself (seeded cases that must fail)', () => {
    it('fails a resume list that is missing a verdict', () => {
      const seeded = '<!-- resume-on:start -->\n`dead`, `unrecorded`\n<!-- resume-on:end -->';
      expect(differenceFrom(markedList(seeded, RESUME_ON_MARKER), RESUME_ON)).not.toBeNull();
    });

    it('fails a resume list that permits orphaned-group', () => {
      const seeded =
        '<!-- resume-on:start -->\n`dead`, `unrecorded`, `unanswerable`, `orphaned-group`\n<!-- resume-on:end -->';
      expect(differenceFrom(markedList(seeded, RESUME_ON_MARKER), RESUME_ON)).not.toBeNull();
    });

    it('fails a verdict list that is missing one of the members', () => {
      const seeded = `<!-- liveness-verdicts:start -->\n${members
        .slice(1)
        .map((member) => `\`${member}\``)
        .join(', ')}\n<!-- liveness-verdicts:end -->`;
      expect(differenceFrom(markedList(seeded, VERDICTS_MARKER), members)).not.toBeNull();
    });

    it('fails a document with no marker at all', () => {
      expect(markedList('no markers here', RESUME_ON_MARKER)).toBeNull();
      expect(differenceFrom(markedList('no markers here', RESUME_ON_MARKER), RESUME_ON)).not.toBeNull();
    });

    it('fails a block whose end marker comes before its start', () => {
      const seeded = '<!-- resume-on:end -->`dead`<!-- resume-on:start -->';
      expect(markedList(seeded, RESUME_ON_MARKER)).toBeNull();
    });
  });
});
