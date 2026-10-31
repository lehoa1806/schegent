// Feature 254 (FR-R4-F07, S-T2, N1; contract S1, S2; data-model §1; FR-001, FR-002) — the scanner's
// two linear trims accept exactly what the two backtracking regexes accepted.
//
// `readPlain` stripped trailing spaces with `/ +$/` and `readBlockLiteral` normalized its header with
// `/ +#.*$/` then `/ +$/`. Both are quadratic on a run of spaces, so they became index loops
// (`stripTrailingSpaces`, `isBareBlockHeader`). The loops are only acceptable if the accepted language
// is byte for byte the same (FR-002), including the regex quirk that `.` does not match `\r`, U+2028 or
// U+2029, so a header comment holding one is NOT stripped and the line is refused.
//
// Two things are checked here:
//
//   * S-T2, a differential. The old regexes are kept VERBATIM below as the oracle, and every string of
//     a seeded corpus (plus a fixed list of the shapes data-model §1 names) must get the same answer
//     from the helper and from the oracle. A trailing tab, U+00A0, U+2028 or U+2029 stays: `trimEnd()`
//     would have removed it, which is exactly the mutant (M3) the corpus exists to kill.
//   * N1, a source check. No regular expression literal in the scanner holds a quantified space that
//     is not anchored at the start of the pattern. The check carries a control: it must flag the
//     oracle patterns, so a check that matched nothing cannot pass.
//
// `stripTrailingSpaces` and `isBareBlockHeader` are exported only for this differential (TA6).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  isBareBlockHeader,
  stripTrailingSpaces
} from '../../../src/services/process-yaml/yaml-scanner';

const SCANNER_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'services',
  'process-yaml',
  'yaml-scanner.ts'
);

// ---------------------------------------------------------------------------
// The oracle: the two trims as they were at c744874f, verbatim
// ---------------------------------------------------------------------------

const oracleStrip = (text: string): string => text.replace(/ +$/, '');
const oracleIsBareBlockHeader = (valueText: string): boolean =>
  valueText.replace(/ +#.*$/, '').replace(/ +$/, '') === '|-';

// ---------------------------------------------------------------------------
// The corpus (escapes stay escapes: standing rule 17)
// ---------------------------------------------------------------------------

/** Characters the corpus puts at the start, middle and end of a value. */
const AWKWARD = ['\t', '\u00A0', '\u2028', '\u2029', '\r'] as const;

/** A small fixed-seed generator, so a failure names a reproducible input. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [' ', ' ', ' ', '#', 'a', 'x', '|', '-', ...AWKWARD] as const;

function seededStrings(count: number): string[] {
  const next = mulberry32(0x254f07);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(next() * 40);
    let value = '';
    for (let c = 0; c < length; c++) {
      value += ALPHABET[Math.floor(next() * ALPHABET.length)] as string;
    }
    out.push(value);
  }
  return out;
}

/** Runs of 0 to 64 spaces in every position around the fixed anchors of data-model §1. */
function spaceRuns(): string[] {
  const out: string[] = [];
  const anchors = ['', 'a', '|-', 'a b', '|-#x', '|- #a', '#'] as const;
  for (let run = 0; run <= 64; run++) {
    const spaces = ' '.repeat(run);
    for (const anchor of anchors) {
      out.push(`${spaces}${anchor}`, `${anchor}${spaces}`, `${anchor}${spaces}${anchor}`);
      out.push(`${anchor}${spaces}#`, `${anchor}${spaces}#c`, `${anchor}${spaces}#c${spaces}`);
    }
  }
  return out;
}

/** `\t`, U+00A0, U+2028, U+2029 and `\r` at the start, middle and end, with and without spaces. */
function awkwardPlacements(): string[] {
  const out: string[] = [];
  for (const awkward of AWKWARD) {
    for (const base of ['|-', '|- ', '|-  #c', 'a', 'a  ', '  ']) {
      out.push(`${awkward}${base}`, `${base}${awkward}`, `${base}${awkward}${base}`);
      out.push(`${base} #${awkward}`, `${base}  #c${awkward}d`, `${base}${awkward} #c`);
    }
  }
  return out;
}

/** The four header shapes data-model §1 lists by name. */
const NAMED = ['|-#x', '|-  ', '|- #a #b', '|- #a  #b'] as const;

const CORPUS: readonly string[] = [
  ...NAMED,
  ...spaceRuns(),
  ...awkwardPlacements(),
  ...seededStrings(4000)
];

// ---------------------------------------------------------------------------
// S-T2: the differential
// ---------------------------------------------------------------------------

describe('FR-R4-F07 S-T2 — the linear trims equal the old regexes', () => {
  it('has a corpus that exercises the shapes it names', () => {
    expect(CORPUS.length).toBeGreaterThan(5000);
    // Each awkward character must actually appear, or the differential cannot see `trimEnd()`.
    for (const awkward of AWKWARD) {
      expect(CORPUS.some((value) => value.endsWith(awkward))).toBe(true);
      expect(CORPUS.some((value) => value.startsWith(awkward))).toBe(true);
    }
    // And the corpus must contain values the oracle accepts as a bare header, or the header
    // differential would compare "false" with "false" forever.
    expect(CORPUS.filter(oracleIsBareBlockHeader).length).toBeGreaterThan(100);
  });

  it('stripTrailingSpaces equals /\\ +$/ replacement over the corpus', () => {
    for (const value of CORPUS) {
      expect(stripTrailingSpaces(value), JSON.stringify(value)).toBe(oracleStrip(value));
    }
  });

  it('isBareBlockHeader equals the old header pair over the corpus', () => {
    for (const value of CORPUS) {
      expect(isBareBlockHeader(value), JSON.stringify(value)).toBe(oracleIsBareBlockHeader(value));
    }
  });

  it('removes trailing U+0020 only: a trailing tab, no-break space or line separator stays', () => {
    for (const awkward of AWKWARD) {
      expect(stripTrailingSpaces(`a${awkward}`)).toBe(`a${awkward}`);
      expect(stripTrailingSpaces(`a${awkward}  `)).toBe(`a${awkward}`);
    }
  });

  it('keeps the regex quirk: a header comment holding \\r, U+2028 or U+2029 is not stripped', () => {
    expect(isBareBlockHeader('|- #c')).toBe(true);
    expect(isBareBlockHeader('|-  ')).toBe(true);
    expect(isBareBlockHeader('|-#x')).toBe(false);
    for (const awkward of ['\r', '\u2028', '\u2029']) {
      expect(isBareBlockHeader(`|- #c${awkward}d`)).toBe(false);
      expect(isBareBlockHeader(`|- #c${awkward}d`)).toBe(oracleIsBareBlockHeader(`|- #c${awkward}d`));
    }
    // A tab or a no-break space is matched by `.`, so a comment holding one is still a comment.
    expect(isBareBlockHeader('|- #c\td')).toBe(true);
    expect(isBareBlockHeader('|- #c\u00A0d')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N1: no quantified space that can backtrack
// ---------------------------------------------------------------------------

/**
 * Whether a regular expression literal (`/body/flags`) quantifies a space (` +` or ` *`) anywhere
 * but at the very start of an anchored pattern (`/^ +/`). A pattern anchored at the start tries one
 * position, so it is linear; every other quantified space can be retried from each start position of
 * a run, which is the quadratic shape.
 */
function hasUnanchoredSpaceQuantifier(literal: string): boolean {
  const body = literal.slice(1, literal.lastIndexOf('/'));
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] !== ' ' || (body[i + 1] !== '+' && body[i + 1] !== '*')) continue;
    const anchoredAtStart = i === 1 && body[0] === '^';
    if (!anchoredAtStart) return true;
  }
  return false;
}

function regexLiteralsOf(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('FR-R4-F07 N1 — the scanner holds no backtracking space quantifier', () => {
  it('flags the old patterns (control)', () => {
    expect(hasUnanchoredSpaceQuantifier('/ +$/')).toBe(true);
    expect(hasUnanchoredSpaceQuantifier('/ +#.*$/')).toBe(true);
    expect(hasUnanchoredSpaceQuantifier('/a *b/')).toBe(true);
  });

  it('does not flag an anchored leading strip or a character class', () => {
    expect(hasUnanchoredSpaceQuantifier('/^ +/')).toBe(false);
    expect(hasUnanchoredSpaceQuantifier('/^[ \\t]*/')).toBe(false);
    expect(hasUnanchoredSpaceQuantifier('/^[0-9a-fA-F]{4}$/')).toBe(false);
  });

  it('finds the scanner\'s regex literals, so the check below reads something', () => {
    const literals = regexLiteralsOf(SCANNER_PATH);
    // The leading strip and the escape-digit test are in the file before the change and stay after
    // it (the key pattern moves to `scalar-style.ts` in the next story, so it is not named here).
    expect(literals).toContain('/^ +/');
    expect(literals).toContain('/^[0-9a-fA-F]{4}$/');
  });

  it('holds no regular expression with an unanchored quantified space', () => {
    const offenders = regexLiteralsOf(SCANNER_PATH).filter(hasUnanchoredSpaceQuantifier);
    expect(offenders).toEqual([]);
  });
});
