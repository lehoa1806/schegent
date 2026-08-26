import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R3-100 (FR-017, FR-013) — the attested gate's coverage statement is derived, and
 * the fold did not make the build count worse.
 *
 * Two properties, both of which item 100 states as constraints rather than
 * aspirations:
 *
 *   1. `RELEASE.md` §2a must state what `npm run gate` actually reaches, and a drift
 *      in either direction must fail. Before this item the release binding named
 *      `npm run ci`, which omitted five checks including the secret scan, while the
 *      document described the gate as the project's verification.
 *   2. Folding those five in must not increase how many times the webview is built.
 *      The chain already built it five times (FR-R3-042's history) and item 100 §3.1
 *      says explicitly: do not make that worse.
 *
 * The parity decision is a pure function over the document text and the script map,
 * so both directions of drift are exercised here without editing a file.
 */
async function loadParity() {
  return import('../../../scripts/check-gate-coverage-parity.mjs');
}

let parity: Awaited<ReturnType<typeof loadParity>>;
const ROOT = resolve(__dirname, '../../..');
const scripts = (): Record<string, string> =>
  (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }).scripts;

beforeAll(async () => {
  parity = await loadParity();
});

describe('FR-R3-100 — the gate coverage statement is derived from the chain', () => {
  it('the real document and the real chain agree', () => {
    const verdict = parity.decideParity(readFileSync(resolve(ROOT, 'RELEASE.md'), 'utf8'), scripts());
    expect(
      verdict.ok,
      `RELEASE.md §2a has drifted: ${verdict.ok ? '' : verdict.message}`
    ).toBe(true);
    if (verdict.ok) {
      expect(verdict.checks, 'a coverage statement listing nothing proves nothing').toBeGreaterThan(15);
    }
  });

  it('the derived closure reaches the five checks `ci` used to omit', () => {
    // The substance of the item. Each of these ran only in `verify:all` / `ci:fast`,
    // which nothing attested, so a release could be produced past any of them.
    const derived = new Set(parity.derivedChecks(scripts()));
    for (const check of [
      'security:secrets',
      'security:actions',
      'license:check',
      'docs:check',
      'contracts:check'
    ]) {
      expect(derived.has(check), `${check} must be inside the attested chain`).toBe(true);
    }
  });

  it('the derived closure reaches the host suite UNDER coverage, so the declared floors gate', () => {
    const derived = new Set(parity.derivedChecks(scripts()));
    expect(derived.has('test:coverage')).toBe(true);
    // `test:host` is the same tests without instrumentation; if the chain reverted to
    // it, the floors in vitest.config.ts would be enforced by nothing again.
    expect(
      derived.has('test:host'),
      'the attested chain runs `test:host`, so the declared coverage floors are enforced ' +
        'by no command — the exact defect FR-R3-100 (FR-016) closed'
    ).toBe(false);
  });

  it('NON-VACUITY: a stale document and a fabricated claim are both refused', () => {
    const all = scripts();
    const good = parity.renderBlock(all);
    const doc = `intro\n\n${good}\n\noutro`;
    expect(parity.decideParity(doc, all).ok).toBe(true);

    // A check silently dropped from the chain: the document now over-claims.
    const shrunk = { ...all, gate: 'npm run ci' };
    const overClaim = parity.decideParity(doc, shrunk);
    expect(overClaim.ok, 'a document claiming checks the chain no longer runs must be refused').toBe(
      false
    );
    if (!overClaim.ok) expect(overClaim.reason).toBe('drifted');

    // A document that lost the block entirely.
    const missing = parity.decideParity('no block here', all);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('block-missing');
  });

  it('the webview is built no more times than before the fold (FR-013)', () => {
    const all = scripts();
    // Count the SITES in the closure that build the webview, which is what determines
    // how many times a full run pays for it. The five folded checks add none.
    const builders = parity
      .reachableScripts(all, 'gate')
      .filter((name: string) => (all[name] ?? '').includes('build:webview'));
    // `build:webview` itself, plus test:visual, a11y, build, and test:integration's
    // `build` -- the five FR-R3-042 recorded. The assertion is an upper bound: a sixth
    // is a regression this item promised not to introduce.
    expect(
      builders.length,
      `the closure now builds the webview from ${builders.length} sites (${builders.join(', ')}). ` +
        'FR-R3-100 §5 forbids making the five-build history worse.'
    ).toBeLessThanOrEqual(5);
  });
});
