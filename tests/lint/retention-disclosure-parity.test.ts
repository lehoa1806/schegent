// FR-R3-085 — the operator-facing retention disclosure and the constants that
// enforce it are one fact, checked from both ends.
//
// THE CLASS. Three times in this round, operator-facing text asserted a property
// nothing checked: `R-14`, `D2`, `F-08`. Each fix was an edit, and the text
// drifted again. `FR-R3-067` established the remedy — derive the text and gate
// the derivation — and this applies it to retention.
//
// The document is RENDERED from `retentionDisclosure()`, which reads the
// constants. This asserts the rendered table in the document is byte-identical
// to what the code produces now. Change a constant without regenerating and this
// goes red with both versions in the failure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderRetentionDisclosure,
  retentionDisclosure
} from '../../src/services/retention-disclosure';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOC = 'docs/operations/evidence-retention-disclosure.md';
const document = readFileSync(resolve(REPO_ROOT, DOC), 'utf8');

describe('FR-R3-085 — the retention disclosure derives from the retention constants', () => {
  it('the disclosure describes every artifact class, so an empty table cannot pass', () => {
    const entries = retentionDisclosure();
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry.bound.length, `${entry.artifact} needs a bound`).toBeGreaterThan(10);
      expect(entry.source, `${entry.artifact} must name the constant it came from`).toMatch(/\.ts|settings/);
    }
  });

  it('the document contains exactly the table the code renders', () => {
    const rendered = renderRetentionDisclosure();
    expect(
      document.includes(rendered),
      `${DOC} has drifted from the constants. Regenerate it — the numbers in that document are ` +
        `not written, they are read from the code, and a hand-edited bound is the defect this ` +
        `gate exists for.\n\nExpected to find:\n${rendered}`
    ).toBe(true);
  });

  it('the unredacted artifact is disclosed as unredacted, in the document', () => {
    // The single most important line for an operator, and the one a "tidy-up"
    // edit is most likely to soften. The raw transcript is deliberately
    // unredacted; a disclosure that omits that is worse than no disclosure.
    const raw = retentionDisclosure().find((entry) => entry.artifact.includes('Raw session'));
    expect(raw?.redacted).toBe(false);
    expect(document).toContain('deliberately unredacted');
    expect(document).toContain('**not redacted**');
  });

  it('the document does not claim tamper-proofing or encryption at rest', () => {
    // FR-R3-085 §5: "Do not claim tamper-proofing for on-disk evidence." The
    // decline of encryption is likewise recorded with its reason, not omitted.
    expect(document).toContain('not tamper-proof');
    expect(document).toContain('no key store');
    expect(document).not.toMatch(/tamper-proof(?!\.|,| )/);
  });

  it('the default capture posture is stated as unchanged', () => {
    expect(document).toContain('errors-only');
  });

  it('NON-VACUITY: perturbing a constant makes the rendered table differ from the document', () => {
    // In memory: the rendered table is compared against a mutated copy of
    // itself, standing in for a constant that moved. If the comparison were
    // vacuous — a substring check that always passes — this would not fail.
    const rendered = renderRetentionDisclosure();
    const perturbed = rendered.replace(/30 days/, '31 days');
    expect(perturbed).not.toBe(rendered);
    expect(document.includes(perturbed)).toBe(false);
  });
});
