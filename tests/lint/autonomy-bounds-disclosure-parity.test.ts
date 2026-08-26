// FR-R3-112 (FR-123) — the autonomy-bounds disclosure and the constants that enforce it
// are one fact, checked from both ends.
//
// THE CLASS, for the fourth time this round. Operator-facing text that asserts a
// property nothing checks: `R-14`, `D2`, `F-08`, and the envelope architecture document.
// `FR-R3-067` established the remedy — derive the text, gate the derivation — and
// `retention-disclosure-parity` applied it to retention. This applies it to the bounds.
//
// WHY THE DENOMINATION TABLE IS GATED SEPARATELY. The bounds table could be correct while
// the denomination table said the dollar bound applied to `codex`, and an operator acting
// on that would set a bound that never fires. Two claims, two checks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autonomyBounds,
  backendDenominations,
  renderAutonomyBounds,
  renderBackendDenominations
} from '../../src/services/autonomy-bounds-disclosure';
import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOC = 'docs/operations/autonomy-bounds-disclosure.md';
const document = readFileSync(resolve(REPO_ROOT, DOC), 'utf8');

describe('FR-R3-112 — the autonomy-bounds disclosure derives from the bounds', () => {
  it('discloses every bound class, so an empty table cannot pass', () => {
    const entries = autonomyBounds();
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      expect(entry.bound.length, `${entry.risk} needs a bound`).toBeGreaterThan(5);
      expect(entry.source, `${entry.risk} must name where its number came from`).toMatch(
        /schegent\.|\.ts/
      );
      expect(entry.onCrossing.length, `${entry.risk} must say what crossing does`).toBeGreaterThan(5);
    }
  });

  it('the document contains exactly the bounds table the code renders', () => {
    const rendered = renderAutonomyBounds();
    expect(
      document.includes(rendered),
      `${DOC} has drifted from the constants. Regenerate it — the numbers in that document ` +
        `are read from the code, and a hand-edited bound is the defect this gate exists ` +
        `for.\n\nExpected to find:\n${rendered}`
    ).toBe(true);
  });

  it('the document contains exactly the denomination table the code renders', () => {
    const rendered = renderBackendDenominations();
    expect(document.includes(rendered), `${DOC} denomination table has drifted.\n\n${rendered}`).toBe(
      true
    );
  });

  it('covers every backend the product can run', () => {
    // A denomination table missing a backend is a backend whose spend is unbounded and
    // whose operator has no way to learn that. Derived from the closed kind union, so a
    // fourth backend lands here rather than being forgotten.
    const disclosed = new Set(backendDenominations().map((entry) => entry.backend));
    const missing = SUPPORTED_BACKENDS.filter((kind) => !disclosed.has(kind));
    expect(missing, `backends with no disclosed spend denomination: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('states the spend bound is a pause and not a terminal transition', () => {
    // The one claim in this document that a reader will act on under stress.
    const spendRows = autonomyBounds().filter((entry) => entry.risk.startsWith('Spend'));
    expect(spendRows.length).toBe(2);
    for (const row of spendRows) {
      expect(row.onCrossing).toContain('pause');
      expect(row.onCrossing).toContain('never');
    }
  });

  it('says the spend bound ships unset rather than leaving it to be assumed', () => {
    expect(document).toMatch(/ships unset|no bound by default/);
  });
});
