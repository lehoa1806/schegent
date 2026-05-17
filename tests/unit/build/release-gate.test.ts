// US6 / T048 / FR-033: the documented full pre-merge gate (`npm run ci`)
// must include `test:integration` so that a future regression that strips
// Electron from the chain trips this test before it ships. `ci:fast` is
// the inner-loop iteration gate and must NOT include the integration
// tests (those are slow and require Electron).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_PATH = resolve(__dirname, '../../../package.json');

interface PkgScripts {
  readonly [k: string]: string;
}

function readScripts(): PkgScripts {
  const raw = readFileSync(PKG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { scripts?: PkgScripts };
  if (!parsed.scripts) throw new Error('package.json has no "scripts" object');
  return parsed.scripts;
}

describe('release-gate scripts (US6 / T048 / FR-033)', () => {
  it('exposes a `ci` script', () => {
    const scripts = readScripts();
    expect(scripts.ci).toBeTypeOf('string');
    expect(scripts.ci.length).toBeGreaterThan(0);
  });

  it('exposes a `ci:fast` script', () => {
    const scripts = readScripts();
    expect(scripts['ci:fast']).toBeTypeOf('string');
    expect(scripts['ci:fast'].length).toBeGreaterThan(0);
  });

  it('the `ci` chain invokes `test:integration` (Electron host smoke)', () => {
    const scripts = readScripts();
    // The literal substring must appear — we deliberately do not parse the
    // chain because npm-script chains are stable enough that the substring
    // assertion catches the regression we care about: someone removing
    // Electron from the canonical pre-merge gate.
    expect(scripts.ci).toContain('npm run test:integration');
  });

  it('the `ci:fast` chain does NOT invoke `test:integration`', () => {
    const scripts = readScripts();
    // ci:fast is the inner-loop iteration gate. Pulling Electron into it
    // would defeat its purpose — and pulling Electron *out of* `ci`
    // would defeat the release gate. The two assertions together pin
    // both edges.
    expect(scripts['ci:fast']).not.toContain('test:integration');
  });

  it('the `ci` chain runs typecheck, lint, test, and build before integration', () => {
    const scripts = readScripts();
    const ci = scripts.ci;
    // Sanity check: the documented chain is typecheck → typecheck:webview →
    // lint → test → build → test:integration. We only assert presence and
    // ordering of the load-bearing steps, not exact whitespace.
    const idxTypecheck = ci.indexOf('npm run typecheck');
    const idxLint = ci.indexOf('npm run lint');
    const idxTest = ci.indexOf('npm run test');
    const idxBuild = ci.indexOf('npm run build');
    const idxIntegration = ci.indexOf('npm run test:integration');
    expect(idxTypecheck).toBeGreaterThanOrEqual(0);
    expect(idxLint).toBeGreaterThan(idxTypecheck);
    expect(idxTest).toBeGreaterThan(idxLint);
    expect(idxBuild).toBeGreaterThan(idxTest);
    expect(idxIntegration).toBeGreaterThan(idxBuild);
  });
});
