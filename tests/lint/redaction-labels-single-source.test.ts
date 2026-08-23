// FR-R3-048 (H-07, SC-008, T009) — drift guard for the private-key armor set.
//
// `AGENTS.md` names `src/lib/logger.ts` as the redaction set's home and forbids
// forking it. The whole-string pattern and the line-oriented framing detector
// both need to know which armor labels open a private-key block, and writing
// that list twice is how a pattern and a detector drift until one quietly stops
// covering a label. So: exactly one definition, and every consumer derives from
// it.
//
// This guard fails if a second definition appears anywhere under `src/`, if the
// derivations stop deriving, or if the set stops covering a spelling real
// tooling emits. It reports how many derivations it checked so a vacuous pass
// (a rename that makes every regex match nothing) is visible.
//
// See specs/133-complete-key-redaction/contracts/key-block-redaction.md.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PRIVATE_KEY_ARMOR_LABELS, SanitizedLogger } from '../../src/lib/logger';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const HOME = path.join(SRC_ROOT, 'lib/logger.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('redaction-labels-single-source (FR-020, FR-021, SC-008)', () => {
  it('defines the armor-label set in exactly one place', () => {
    const duplicates: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file === HOME) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      // Either a second list of the labels, or a hand-rolled armor alternation:
      // both are the fork this guard exists to prevent.
      if (/\bOPENSSH\b[\s\S]{0,120}\bENCRYPTED\b/.test(src)) {
        duplicates.push(path.relative(REPO_ROOT, file));
        continue;
      }
      if (/-----BEGIN[^\n]{0,40}PRIVATE KEY/.test(src)) {
        duplicates.push(path.relative(REPO_ROOT, file));
        continue;
      }
      // Third rule, added by this feature's own security review: a
      // RE-DECLARATION of the exported name outside its home. The two rules
      // above catch a copied full list and a hand-rolled armor regex, but a
      // drifting copy does not start life complete -- it starts as
      // `const PRIVATE_KEY_ARMOR_LABELS = ['RSA']` and grows. Seeding exactly
      // that in another module passed both rules above, so the guard was
      // vacuous for the shape it exists to catch.
      if (/\b(?:const|let|var|function|class)\s+PRIVATE_KEY_ARMOR_LABELS\b/.test(src)) {
        duplicates.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(
      duplicates,
      'the private-key armor set has one home (src/lib/logger.ts); these files define or match it themselves'
    ).toEqual([]);
  });

  it('derives every consumer from the exported set', () => {
    const src = stripComments(fs.readFileSync(HOME, 'utf8'));
    const derivations = src.match(/\$\{ARMOR_LABEL_ALTERNATION\}/g) ?? [];
    // Complete block (x2: BEGIN and END), unterminated block, BEGIN detector,
    // END detector. Every one of them interpolates the single alternation.
    expect(
      derivations.length,
      'each private-key regex must interpolate ARMOR_LABEL_ALTERNATION rather than spell the labels again'
    ).toBe(5);
    expect(
      /const ARMOR_LABEL_ALTERNATION =\s*\n?\s*`\(\?:\(\?:\$\{PRIVATE_KEY_ARMOR_LABELS\.join\('\|'\)\}\) \)\?PRIVATE KEY/.test(
        src
      ),
      'ARMOR_LABEL_ALTERNATION must be built from PRIVATE_KEY_ARMOR_LABELS, with the label optional for PKCS#8'
    ).toBe(true);
  });

  it('covers every label in the set, plus the unlabeled PKCS#8 form', () => {
    const logger = new SanitizedLogger([]);
    // Not a vacuous pass: the loop count is asserted, so a set that shrank to
    // nothing would fail here rather than pass silently.
    expect(PRIVATE_KEY_ARMOR_LABELS.length).toBeGreaterThanOrEqual(6);
    const spellings = [
      ...PRIVATE_KEY_ARMOR_LABELS.map((label) => `${label} PRIVATE KEY`),
      'PGP PRIVATE KEY BLOCK',
      'PRIVATE KEY'
    ];
    for (const spelling of spellings) {
      const block = `-----BEGIN ${spelling}-----\nfiller\n-----END ${spelling}-----`;
      // Booleans only: a redaction guard must not print what it was protecting.
      expect(logger.sanitize(block).includes('filler')).toBe(false);
    }
    expect(spellings.length).toBe(PRIVATE_KEY_ARMOR_LABELS.length + 2);
  });

  it('still never matches a public key', () => {
    const logger = new SanitizedLogger([]);
    const block = '-----BEGIN PUBLIC KEY-----\nshareable\n-----END PUBLIC KEY-----';
    expect(logger.sanitize(block)).toBe(block);
  });
});
