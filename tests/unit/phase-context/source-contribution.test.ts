// FR-R6-F15 T012 — one untrusted contribution: bound, structured, attributed to the attempt it
// was accepted from, and refused whole on any fault (FR-004, FR-008, FR-017, NFR-001).
import { describe, expect, it } from 'vitest';

import type { SourceContribution } from '../../../src/contracts/phase-context/context-policy';
import { parseArtifactRef, parseSourceContribution } from '../../../src/services/phase-context/source-contribution';
import { artifactRef, contribution, digestOf, producer, textOfBytes, wideTextOfBytes } from '../../fixtures/phase-context/builders';

const ACCEPTED_FROM = producer();
const COLLECTIONS = ['outcomes', 'decisions', 'constraints', 'unresolvedIssues'] as const;

function parse(value: unknown): ReturnType<typeof parseSourceContribution> {
  return parseSourceContribution(value, ACCEPTED_FROM);
}

function refusal(detail: string): unknown {
  return { ok: false, failure: 'invalid-source', detail };
}

function artifacts(count: number): SourceContribution['artifacts'] {
  return Array.from({ length: count }, (_unused, index) => artifactRef({ artifactId: `artifact-${String(index)}` }));
}

describe('parseSourceContribution', () => {
  it('returns a valid contribution rebuilt field by field', () => {
    const input = contribution({ summary: 'Four steps, one open question.', artifacts: [artifactRef()], coverage: 'partial' });
    const parsed = parse(input);
    expect(parsed).toEqual({ ok: true, contribution: input });
    if (parsed.ok) expect(parsed.contribution).not.toBe(input);
  });

  it('accepts empty collections, no summary and no artifact', () => {
    const empty = contribution({ outcomes: [], decisions: [], constraints: [], unresolvedIssues: [], summary: null, artifacts: [] });
    expect(parse(empty).ok).toBe(true);
  });

  it('refuses a producer other than the attempt it was accepted from', () => {
    for (const other of [producer('plan', 'occ-1', 'att-2'), producer('plan', 'occ-2', 'att-1'), producer('notes', 'occ-1', 'att-1')]) {
      expect(parse(contribution({ producer: other }))).toEqual(refusal('producer-mismatch'));
    }
  });

  it('refuses a newer schema version as unsupported', () => {
    expect(parse({ ...contribution(), schemaVersion: 2, added: true })).toEqual({
      ok: false,
      failure: 'unsupported-version',
      detail: 'contribution-version'
    });
  });

  it.each<[string, unknown, string]>([
    ['text', 'contribution', 'contribution-shape'],
    ['null', null, 'contribution-shape'],
    ['schema version 0', { ...contribution(), schemaVersion: 0 }, 'contribution-version'],
    ['a missing schema version', { producer: producer() }, 'contribution-version'],
    ['an unknown key', { ...contribution(), transcript: 'x' }, 'contribution-shape'],
    ['a missing key', { schemaVersion: 1, producer: producer(), coverage: 'complete' }, 'contribution-shape'],
    ['a producer that is not an object', { ...contribution(), producer: 'plan' }, 'producer'],
    ['a producer with a bad node path', { ...contribution(), producer: producer('a b') }, 'producer'],
    ['an unknown coverage', { ...contribution(), coverage: 'full' }, 'coverage'],
    ['a summary that is a number', { ...contribution(), summary: 7 }, 'summary'],
    ['an empty summary', { ...contribution(), summary: '' }, 'summary'],
    ['artifacts that are not a list', { ...contribution(), artifacts: {} }, 'artifact-count'],
    ['an artifact that is not a reference', { ...contribution(), artifacts: ['file.txt'] }, 'artifact'],
    [
      'two artifacts with one identity',
      { ...contribution(), artifacts: [artifactRef(), artifactRef({ immutableVersion: 'v2' })] },
      'artifact-duplicate'
    ]
  ])('refuses %s', (_label, value, detail) => {
    expect(parse(value)).toEqual(refusal(detail));
  });

  describe.each(COLLECTIONS)('%s', (name) => {
    it('accepts 32 entries and refuses 33', () => {
      expect(parse(contribution({ [name]: Array.from({ length: 32 }, () => 'entry') })).ok).toBe(true);
      expect(parse(contribution({ [name]: Array.from({ length: 33 }, () => 'entry') }))).toEqual(refusal('entry-count'));
    });

    it('accepts an entry of exactly 2 KiB and refuses one byte more', () => {
      expect(parse(contribution({ [name]: [textOfBytes(2048)] })).ok).toBe(true);
      expect(parse(contribution({ [name]: [wideTextOfBytes(2048)] })).ok).toBe(true);
      expect(parse(contribution({ [name]: [textOfBytes(2049)] }))).toEqual(refusal('entry-text'));
      expect(parse(contribution({ [name]: [wideTextOfBytes(2049)] }))).toEqual(refusal('entry-text'));
    });

    it('refuses an empty entry, an entry that is not text and a list that is not a list', () => {
      expect(parse(contribution({ [name]: [''] }))).toEqual(refusal('entry-text'));
      expect(parse({ ...contribution(), [name]: [7] })).toEqual(refusal('entry-text'));
      expect(parse({ ...contribution(), [name]: 'entry' })).toEqual(refusal('entry-count'));
    });

    it('refuses a control character and ill-formed text', () => {
      expect(parse(contribution({ [name]: [`line${String.fromCharCode(0x0d)}next`] }))).toEqual(refusal('entry-text'));
      expect(parse(contribution({ [name]: [`line${String.fromCharCode(0x2028)}next`] }))).toEqual(refusal('entry-text'));
      expect(parse(contribution({ [name]: [`a${String.fromCharCode(0xd800)}`] }))).toEqual(refusal('entry-text'));
    });

    it('accepts a line feed and a tab inside an entry', () => {
      expect(parse(contribution({ [name]: ['first\n\tsecond'] })).ok).toBe(true);
    });
  });

  it('accepts a summary of exactly 8 KiB and refuses one byte more', () => {
    expect(parse(contribution({ summary: textOfBytes(8192) })).ok).toBe(true);
    expect(parse(contribution({ summary: textOfBytes(8193) }))).toEqual(refusal('summary'));
  });

  it('refuses a summary with a control character', () => {
    expect(parse(contribution({ summary: `a${String.fromCharCode(0x1b)}[0m` }))).toEqual(refusal('summary'));
  });

  it('accepts 64 artifacts and refuses 65', () => {
    expect(parse(contribution({ artifacts: artifacts(64) })).ok).toBe(true);
    expect(parse(contribution({ artifacts: artifacts(65) }))).toEqual(refusal('artifact-count'));
  });
});

describe('parseArtifactRef', () => {
  it('returns a valid reference', () => {
    const input = artifactRef({ kind: 'binary', byteSize: 0 });
    expect(parseArtifactRef(input)).toEqual(input);
  });

  it.each<[string, unknown]>([
    ['no digest', { artifactId: 'a', immutableVersion: 'v1', byteSize: 1, kind: 'text' }],
    ['no immutable version', { artifactId: 'a', digestHex: digestOf('a'), byteSize: 1, kind: 'text' }],
    ['a short digest', artifactRef({ digestHex: 'abc' })],
    ['an upper-case digest', artifactRef({ digestHex: digestOf('A') })],
    ['an empty immutable version', artifactRef({ immutableVersion: '' })],
    ['a path as its identity', artifactRef({ artifactId: 'out/report.md' })],
    ['a negative size', artifactRef({ byteSize: -1 })],
    ['a fractional size', artifactRef({ byteSize: 1.5 })],
    ['an unknown kind', { ...artifactRef(), kind: 'image' }],
    ['an unknown key', { ...artifactRef(), path: 'out/report.md' }],
    ['text', 'artifact-1']
  ])('refuses a reference with %s', (_label, value) => {
    expect(parseArtifactRef(value)).toBeNull();
  });
});
