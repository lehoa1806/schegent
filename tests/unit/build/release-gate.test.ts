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

/**
 * Position of one step in a `&&`-joined npm-script chain, or -1 if absent.
 *
 * Ordering is asserted over the parsed step list rather than over substring
 * positions because `indexOf('npm run build')` also matches
 * `npm run build:webview`, and `indexOf('npm run test')` also matches
 * `npm run test:evals`. Feature 089 inserted `build:webview` ahead of `test` —
 * the bundle-size caps measure a built artifact, so the build has to precede
 * them — and the prefix match reported the chain as mis-ordered when it was not.
 */
function stepIndex(chain: string, script: string): number {
  return chain.split('&&').map((step) => step.trim()).indexOf(`npm run ${script}`);
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

  it('the `ci` chain invokes `package:smoke` after build and before integration', () => {
    const scripts = readScripts();
    expect(scripts['package:smoke']).toBeTypeOf('string');
    expect(scripts['package:smoke']).toContain('scripts/package-vsix-smoke.mjs');

    const ci = scripts.ci;
    const idxBuild = stepIndex(ci, 'build');
    const idxPackage = stepIndex(ci, 'package:smoke');
    const idxIntegration = stepIndex(ci, 'test:integration');
    expect(idxBuild).toBeGreaterThanOrEqual(0);
    expect(idxPackage).toBeGreaterThan(idxBuild);
    expect(idxIntegration).toBeGreaterThan(idxPackage);
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
    // The documented chain is typecheck → typecheck:webview → typecheck:tests →
    // lint → build:webview → test:host → test:webview:coverage → … → build →
    // package:smoke → test:integration. We assert presence and ordering of the
    // load-bearing steps, not exact whitespace.
    //
    // FR-R3-027 split the single `test` step into its two legs, because the
    // webview leg now runs under coverage thresholds and `verify:all` must not
    // run that suite twice. Both legs are asserted present, and both keep the
    // position `test` held: after `build:webview`, before `build`.
    const idxTypecheck = stepIndex(ci, 'typecheck');
    const idxTestTypecheck = stepIndex(ci, 'typecheck:tests');
    const idxLint = stepIndex(ci, 'lint');
    const idxBuildWebview = stepIndex(ci, 'build:webview');
    const idxHostSuite = stepIndex(ci, 'test:host');
    const idxWebviewSuite = stepIndex(ci, 'test:webview:coverage');
    const idxTestFirst = Math.min(idxHostSuite, idxWebviewSuite);
    const idxTestLast = Math.max(idxHostSuite, idxWebviewSuite);
    const idxBuild = stepIndex(ci, 'build');
    const idxPackage = stepIndex(ci, 'package:smoke');
    const idxIntegration = stepIndex(ci, 'test:integration');
    expect(idxTypecheck).toBeGreaterThanOrEqual(0);
    expect(idxTestTypecheck).toBeGreaterThan(idxTypecheck);
    expect(idxLint).toBeGreaterThan(idxTestTypecheck);
    // `build:webview` before `test`: `tests/unit/ui/sidebar/bundle-size.test.ts`
    // measures `dist/webview/*`, and its `it.runIf(existsSync(...))` guards make
    // a missing bundle a silent pass rather than a failure. Without this edge the
    // caps read a stale artifact locally and no artifact at all on a clean
    // checkout — which is how a 35% overrun of the dashboard JS cap went
    // unreported until feature 089's T048.
    expect(idxBuildWebview).toBeGreaterThan(idxLint);
    expect(idxHostSuite).toBeGreaterThanOrEqual(0);
    expect(idxWebviewSuite).toBeGreaterThanOrEqual(0);
    expect(idxTestFirst).toBeGreaterThan(idxBuildWebview);
    expect(idxBuild).toBeGreaterThan(idxTestLast);
    expect(idxPackage).toBeGreaterThan(idxBuild);
    expect(idxIntegration).toBeGreaterThan(idxPackage);
  });
});
