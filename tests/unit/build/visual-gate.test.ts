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
    expect(pkg.devDependencies['@playwright/test']).toBe('^1.60.0');
    expect(pkg.scripts['test:visual']).toContain('playwright.config.ts');
    expect(pkg.scripts['ci:fast']).toContain('npm run test:visual');
    expect(pkg.scripts['ci']).toContain('npm run test:visual');
  });

  it('runs the canonical Chromium renderer in every repository workflow', () => {
    for (const workflow of [
      '.github/workflows/pr.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/full-gate.yml'
    ]) {
      const source = readFileSync(resolve(ROOT, workflow), 'utf8');
      expect(source).toContain('npx playwright install --with-deps chromium');
      expect(source).toContain('npm run test:visual');
      expect(source).toContain('tests/visual/.artifacts/**');
    }
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
