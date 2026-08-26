import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

describe('browser visual regression gate', () => {
  it('pins a first-class visual script into both local CI entry points', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      readonly scripts: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    expect(pkg.devDependencies['@playwright/test']).toBe('^1.62.1');
    expect(pkg.scripts['test:visual']).toContain('playwright.config.ts');
    expect(pkg.scripts['ci:fast']).toContain('npm run test:visual');
    expect(pkg.scripts['ci']).toContain('npm run test:visual');
  });

  // FR-R3-099 — three workflow files carried this until the Actions retirement
  // deleted all eight. The renderer invariant survives with a local subject: the
  // visual suite must be reached by the attested chain, and it must be the canonical
  // Chromium that runs it. The browser install that CI did per job is now the
  // developer's own `check-playwright-browser.mjs` preflight, which `test:visual`
  // runs first and which refuses rather than silently rendering in something else.
  // See docs/release/withdrawn-ci-controls.md.
  it('the attested chain reaches the visual suite, behind the canonical-renderer preflight', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['gate'], 'the attested chain must exist').toBeTruthy();
    expect(pkg.scripts['gate']).toContain('npm run ci');
    expect(pkg.scripts['ci']).toContain('npm run test:visual');
    expect(pkg.scripts['test:visual']).toContain('check-playwright-browser.mjs');
    expect(pkg.scripts['test:visual']).toContain('playwright.config.ts');
  });

  it('keeps the visual browser fixture on a fail-closed loopback network boundary', () => {
    const source = readFileSync(
      resolve(ROOT, 'tests/visual/webview.visual.spec.ts'),
      'utf8'
    );
    expect(source).toContain("requestUrl.origin === 'http://127.0.0.1:4173'");
    expect(source).toContain('await route.abort()');
  });
});
