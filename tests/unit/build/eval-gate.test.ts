import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-099 — the eval corpus is run by something, and after the Actions
 * retirement that something is the attested gate chain.
 *
 * This gate used to assert that three workflow files each contained `npm run
 * test:evals`. The invariant was never about the workflows: it was that the
 * deterministic backend evaluation corpus is actually executed rather than merely
 * present. `FR-R3-099` deleted all eight workflows by operator decision, so the
 * subject moves to the only thing that runs anything now — the command a release
 * is attested against.
 *
 * That is a narrower guarantee than three workflows across a three-OS matrix, and
 * saying so is the point: one machine, one platform, once. `docs/release/
 * withdrawn-ci-controls.md` records the trade.
 */
const ROOT = resolve(__dirname, '../../..');

const scripts = (): Record<string, string> =>
  (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }).scripts;

describe('deterministic backend evaluation gate', () => {
  it('has a dedicated local command', () => {
    expect(scripts()['test:evals']).toContain('vitest.evals.config.ts');
  });

  it.each(['ci', 'ci:fast'])('the %s chain runs the backend evaluation corpus', (chain) => {
    expect(scripts()[chain]).toContain('npm run test:evals');
  });

  it('the ATTESTED chain reaches the corpus, so a release cannot bypass it', () => {
    const s = scripts();
    // `gate` is what GATE_COMMAND names (FR-R3-100). It reaches the corpus through
    // `ci`, so the assertion follows the chain rather than restating its contents:
    // a future edit that dropped `ci` from `gate` would fail here.
    expect(s['gate'], 'the attested chain must exist').toBeTruthy();
    expect(s['gate']).toContain('npm run ci');
    expect(s['ci']).toContain('npm run test:evals');
  });
});
