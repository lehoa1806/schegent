import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-099 (FR-007, FR-030) — no document claims, as a present-tense fact about
 * an enabled system, that this project does not run GitHub Actions.
 *
 * WHY THIS GATE EXISTS AT ALL
 *
 * The falsehood it guards against was not a typo. `S14` concluded from the tree
 * alone that Actions could not run, and that conclusion was written into
 * `RELEASE.md`, a workflow header, two closure records and a consolidation row —
 * where it was re-read as settled fact for a week while the remote ran 185
 * workflows, fourteen of them red, none of them read. The repair is therefore
 * worth defending: the same reasoning that produced the claim once will produce it
 * again, because the tree still looks like a repository with no CI.
 *
 * WHAT IS FORBIDDEN AND WHAT IS NOT
 *
 * Forbidden: the claim in the present tense, unqualified. Permitted: the same words
 * inside a dated historical statement that cites the terminal record — which is
 * most of their surviving occurrences, because the honest way to record a
 * falsification is to quote what was believed. So this gate does not ban a phrase;
 * it requires that every occurrence sit in a **paragraph** that also carries a date
 * or a citation. A paragraph is the unit because a claim and its qualifier wrap, and
 * a line-based rule would be defeated by reflowing the prose.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE = resolve(REPO_ROOT, '..');

/** The claims that were false, in the forms they were actually written in. */
const RETIRED_CLAIMS = [
  'does not run GitHub Actions',
  'DOES NOT RUN',
  'produces no runs',
  'structurally unreachable'
] as const;

/** What makes an occurrence historical rather than a live claim. */
const QUALIFIERS = [
  /\b20\d\d-\d\d-\d\d\b/,
  /actions-terminal-record/,
  /withdrawn-ci-controls/,
  /\bwas false\b/i,
  /\bsuperseded\b/i,
  /\bwithdrawn\b/i,
  /\bretired\b/i,
  /\bhistorical\b/i,
  /\bused to\b/i,
  /\bthis record had wrong\b/i,
  /\bwrong answer\b/i,
  /\bfalsif/i
] as const;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Both trees: the falsehood reached the envelope and the implementation repo alike. */
function scanned(): readonly string[] {
  const files = [
    ...markdownFiles(resolve(REPO_ROOT, 'docs')),
    ...markdownFiles(resolve(ENVELOPE, 'docs')),
    ...readdirSync(REPO_ROOT)
      .filter((f) => f.endsWith('.md'))
      .map((f) => resolve(REPO_ROOT, f)),
    ...readdirSync(ENVELOPE)
      .filter((f) => f.endsWith('.md'))
      .map((f) => resolve(ENVELOPE, f))
  ];
  return [...new Set(files)];
}

/**
 * The unit is a paragraph **plus an immediately-following block quote**, and only a
 * block quote.
 *
 * A paragraph alone is too narrow. This repository's convention for a falsified
 * observation is to leave it standing and annotate it adjacently — `FR-R3-067` calls
 * for corrections that state what is true now without rewriting what a review
 * observed then — and that annotation lands in a `>` block after the claim. A
 * paragraph-only rule would force the correction *inside* the original prose, which
 * is the rewriting the convention forbids.
 *
 * Only a block quote, though. Any following paragraph would be far too loose: two
 * unrelated paragraphs where the second happens to carry a date would discharge the
 * first, which is the fail-open shape this repository has removed from two other
 * gates. The non-vacuity case below pins that an ordinary adjacent paragraph does
 * NOT discharge a claim.
 */
function units(body: string): readonly string[] {
  const blocks = body.split(/\n\s*\n/);
  return blocks.map((block, i) => {
    // `.at()` rather than an index read: the array is typed as total, so `blocks[i + 1]` reads as
    // always-present while the last block genuinely has no neighbour.
    const next = blocks.at(i + 1);
    if (next === undefined || !next.trimStart().startsWith('>')) return block;
    return `${block}\n\n${next}`;
  });
}

describe('FR-R3-099 — the retired claims are historical, never present-tense', () => {
  const files = scanned();

  it('scanned a non-empty set of documents in BOTH trees', () => {
    // Without this floor a directory rename would empty the scan and make the
    // assertion below pass over nothing -- which is the vacuity defect this
    // repository measures rather than assumes.
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.startsWith(resolve(REPO_ROOT, 'docs')))).toBe(true);
    expect(files.some((f) => f.startsWith(resolve(ENVELOPE, 'docs')))).toBe(true);
  });

  it('every occurrence of a retired claim sits in a dated or citing paragraph', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const para of units(body)) {
        const claim = RETIRED_CLAIMS.find((c) => para.includes(c));
        if (claim === undefined) continue;
        if (QUALIFIERS.some((q) => q.test(para))) continue;
        offenders.push(`${relative(ENVELOPE, file)}: "${claim}"`);
      }
    }
    expect(
      offenders,
      'A retired claim appears without a date, a citation, or a word marking it historical. ' +
        'GitHub Actions ran 185 times before being retired by decision on 2026-08-26; a bare ' +
        'present-tense claim that they do not run is the falsehood FR-R3-099 repaired. ' +
        'Qualify the paragraph or cite docs/release/actions-terminal-record.md.'
    ).toEqual([]);
  });

  it('the records the repair depends on exist', () => {
    expect(existsSync(resolve(REPO_ROOT, 'docs/release/actions-terminal-record.md'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'docs/release/withdrawn-ci-controls.md'))).toBe(true);
  });

  it('NON-VACUITY: an unqualified present-tense claim is detected', () => {
    // The detector is run against a paragraph that carries the claim and nothing
    // that could excuse it, so a future loosening of QUALIFIERS shows up here.
    const para = 'Eight workflow files are checked in and this project does not run GitHub Actions.';
    expect(RETIRED_CLAIMS.some((c) => para.includes(c))).toBe(true);
    expect(QUALIFIERS.some((q) => q.test(para))).toBe(false);
  });

  it('NON-VACUITY: an adjacent block quote discharges a claim, an adjacent paragraph does not', () => {
    // The exact boundary of the widened unit, asserted in both directions -- because
    // "the next block excuses this one" is a fail-open shape, and the only thing
    // keeping it narrow is that it accepts a block quote and nothing else.
    const claim = 'This project does not run GitHub Actions.';
    const quoted = `${claim}\n\n> Superseded 2026-08-26: this was false.`;
    const merely_adjacent = `${claim}\n\nSuperseded 2026-08-26: this was false.`;

    const [first] = units(quoted);
    expect(QUALIFIERS.some((q) => q.test(first as string))).toBe(true);

    const [alsoFirst] = units(merely_adjacent);
    expect(
      QUALIFIERS.some((q) => q.test(alsoFirst as string)),
      'an ordinary adjacent paragraph must NOT discharge a claim, or any two blocks ' +
        'where the second carries a date would excuse the first'
    ).toBe(false);
  });
});
