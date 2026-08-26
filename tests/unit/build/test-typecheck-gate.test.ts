import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Record<string, unknown>;
}

describe('complete test-source typecheck gate', () => {
  it('includes the entire tests tree without per-test exclusions', () => {
    for (const configPath of ['tsconfig.json', 'tsconfig.tests.json']) {
      const config = readJson(configPath);
      expect(config.include).toContain('tests/**/*');
      expect(config.exclude).toEqual(
        expect.not.arrayContaining([expect.stringMatching(/^tests\//)])
      );
    }
  });

  it('runs before lint in both local CI scripts', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    for (const scriptName of ['ci', 'ci:fast']) {
      const script = pkg.scripts[scriptName];
      expect(script.indexOf('npm run typecheck:tests')).toBeGreaterThanOrEqual(0);
      expect(script.indexOf('npm run lint')).toBeGreaterThan(
        script.indexOf('npm run typecheck:tests')
      );
    }
  });

  // FR-R3-099 — this assertion named three workflow files until the Actions
  // retirement deleted all eight. What it was protecting is that the complete
  // test-source typecheck is actually RUN, not merely configured, so its subject
  // moves to the command a release is attested against. Narrower coverage, stated:
  // one machine, one platform, once. See docs/release/withdrawn-ci-controls.md.
  it('the attested chain runs the complete test typecheck', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['gate'], 'the attested chain must exist').toBeTruthy();
    expect(pkg.scripts['gate']).toContain('npm run ci');
    expect(pkg.scripts['ci']).toContain('npm run typecheck:tests');
  });
});
