// Doc-drift guard: every T-ID cited in CLAUDE.md or SECURITY.md must
// resolve to an anchor heading in docs/security/threat-model.md.
//
// Without this guard, a CLAUDE.md hard rule could cite a threat id
// (e.g. T19) that points nowhere, and a `SECURITY.md` claim of
// "T1–T20 in detail" could be false. The test reads both citation
// sources, extracts each `Tn` token where it is positioned as a
// threat-model reference, and asserts that an `### Tn — …` anchor
// exists in the catalog.
//
// Citation extraction is intentionally conservative — it matches
// `Tn` (case-sensitive, `n` is 1–99) only when it is **not** preceded
// by a digit followed by whitespace (e.g. "010 T10" is a feature-task
// id, not a threat id) and **not** inside a code span or link target.
// The accepted forms are:
//   - "threat-model.md) Tn" (CLAUDE.md hard-rule cross-reference)
//   - "(T1–T20)" / "(T1-T20)" range citations (SECURITY.md)
// Anything else stays out of the parity set and avoids a false
// positive against feature-task ids.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const THREAT_MODEL_PATH = path.join(REPO_ROOT, 'docs', 'security', 'threat-model.md');

interface CitationSource {
  label: string;
  filePath: string;
  required: boolean;
}

const CITATION_SOURCES: ReadonlyArray<CitationSource> = [
  // The repo SECURITY.md is the public disclosure policy and is the
  // primary external promise that the T-ID catalog exists.
  { label: 'repo/SECURITY.md', filePath: path.join(REPO_ROOT, 'SECURITY.md'), required: true },
  // FR-R4-F11 (FR-013) — the GitHub-facing copy is the policy the hosted Security tab may serve,
  // so a threat citation in it is held to the same catalog. It was never read before.
  {
    label: 'repo/.github/SECURITY.md',
    filePath: path.join(REPO_ROOT, '.github', 'SECURITY.md'),
    required: true
  },
  // The workspace-level CLAUDE.md hosts the "Never" hard rules and is
  // the single source of operating policy that references threat ids
  // by tag inside CLAUDE.md hard-rule prose. It is allowed to be
  // missing — only the workspace setup carries it.
  { label: 'workspace CLAUDE.md', filePath: path.join(WORKSPACE_ROOT, 'CLAUDE.md'), required: false }
];

/**
 * FR-R4-F11 (FR-012, FR-014) — the two security policies a reader can land on. Neither may state
 * a threat-identifier range: the catalog is the complete set, and a range is a second copy of its
 * size that goes stale the moment a threat is added.
 */
const POLICY_FILES: ReadonlyArray<string> = ['SECURITY.md', '.github/SECURITY.md'];

/**
 * Every `T<n>` joined to another by a dash, parenthesized or bare, with an optional letter suffix
 * (`T5a–T5b`). The search term is the identifier pair, never a value: `T10` after a digit and a
 * space is a feature-task id, and `T1525a` is a longer token, so neither matches.
 *
 * Why this exists beside `RANGE_CITATION_REGEX`: that expression only reads a parenthesized range,
 * so a bare "covers T1–T27 in" in `SECURITY.md` was never read at all (research R6).
 */
const STATED_RANGE_REGEX = /(?<![A-Za-z0-9])T\d{1,2}[a-z]?\s*[-–—]\s*T\d{1,2}[a-z]?(?![0-9])/g;

/** Pure: the ranges a policy states. One body for the live files and the synthetic probe. */
function statedRanges(content: string): string[] {
  return [...content.matchAll(STATED_RANGE_REGEX)].map((match) => match.at(0) ?? '');
}

const RANGE_CITATION_REGEX = /\(T(\d{1,2})[-–—]T(\d{1,2})\)/g;
// `threat-model.md) T19` / `threat-model.md). T19` — the citation follows a
// link to the threat-model document. The intervening characters can include
// `).` (close-paren plus period before the threat id) or `) ` (close-paren
// plus space).
const HARD_RULE_CITATION_REGEX = /threat-model\.md\)[.\s]+T(\d{1,2})\b/g;

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function extractCitedIds(label: string, content: string): Set<number> {
  const ids = new Set<number>();
  for (const match of content.matchAll(RANGE_CITATION_REGEX)) {
    const lo = Number.parseInt(match[1], 10);
    const hi = Number.parseInt(match[2], 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi - lo > 100) {
      throw new Error(`${label}: malformed T-range citation: ${match[0]}`);
    }
    for (let n = lo; n <= hi; n++) ids.add(n);
  }
  for (const match of content.matchAll(HARD_RULE_CITATION_REGEX)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids;
}

function extractAnchoredIds(threatModel: string): Set<number> {
  const ids = new Set<number>();
  // `### Tn — Title` — em-dash, en-dash, or ASCII hyphen accepted.
  const headingRegex = /^### T(\d{1,2})\s*[-–—]/gm;
  for (const match of threatModel.matchAll(headingRegex)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids;
}

describe('Threat-id anchor parity', () => {
  it('every T-id cited in SECURITY.md / CLAUDE.md resolves to a threat-model.md anchor', () => {
    const threatModel = fs.readFileSync(THREAT_MODEL_PATH, 'utf8');
    const anchored = extractAnchoredIds(threatModel);

    const cited = new Set<number>();
    for (const src of CITATION_SOURCES) {
      const content = readIfPresent(src.filePath);
      if (content === null) {
        if (src.required) {
          throw new Error(`Required citation source missing: ${src.label} (${src.filePath})`);
        }
        continue;
      }
      for (const id of extractCitedIds(src.label, content)) cited.add(id);
    }

    const missing: number[] = [];
    for (const id of cited) {
      if (!anchored.has(id)) missing.push(id);
    }
    missing.sort((a, b) => a - b);
    expect(missing, `cited but not anchored in threat-model.md: T${missing.join(', T')}`).toEqual([]);
  });

  it('threat-model.md exposes an anchored heading for each of the T1–T20 rows the catalog table lists', () => {
    const threatModel = fs.readFileSync(THREAT_MODEL_PATH, 'utf8');
    const anchored = extractAnchoredIds(threatModel);
    const missing: number[] = [];
    for (let n = 1; n <= 20; n++) {
      if (!anchored.has(n)) missing.push(n);
    }
    expect(missing, `range T1-T20 missing anchors: T${missing.join(', T')}`).toEqual([]);
  });

  it('threat-model.md catalog table references each anchored id', () => {
    const threatModel = fs.readFileSync(THREAT_MODEL_PATH, 'utf8');
    const catalogIdx = threatModel.indexOf('## Threat catalog');
    expect(catalogIdx, 'expected a `## Threat catalog` heading in threat-model.md').toBeGreaterThanOrEqual(0);
    const anchorsIdx = threatModel.indexOf('## Threat anchors', catalogIdx);
    expect(anchorsIdx, 'expected a `## Threat anchors` heading after the catalog').toBeGreaterThan(catalogIdx);
    const catalogBlock = threatModel.slice(catalogIdx, anchorsIdx);
    const missing: number[] = [];
    for (let n = 1; n <= 20; n++) {
      if (!catalogBlock.includes(`[T${n}]`)) missing.push(n);
    }
    expect(missing, `catalog table missing rows for: T${missing.join(', T')}`).toEqual([]);
  });

  it('neither security policy states a threat-identifier range (FR-R4-F11)', () => {
    // The catalog is the complete set. A range in either policy is a second statement of its
    // size, and the two policies disagreed (T1–T27 and T1–T25) while neither gate read it.
    const found: string[] = [];
    for (const file of POLICY_FILES) {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const range of statedRanges(content)) found.push(`${file}: ${range}`);
    }
    expect(found, `a policy states a threat range; link the catalog instead: ${found.join('; ')}`).toEqual(
      []
    );
  });

  it('NON-VACUITY: statedRanges reports a range in any form and skips a feature-task id', () => {
    // The same function the live case calls, over a synthetic corpus. Every positive form the
    // policies could take must match once; the two shapes that merely look like a range must not.
    expect(statedRanges('covers (T1–T25).')).toHaveLength(1);
    expect(statedRanges('covers T1–T27 in')).toHaveLength(1);
    expect(statedRanges('T1-T20')).toHaveLength(1);
    expect(statedRanges('T5a–T5b')).toHaveLength(1);
    expect(statedRanges('feature 010 T10')).toEqual([]);
    expect(statedRanges('T1525a')).toEqual([]);
  });
});
