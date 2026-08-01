import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

describe('deterministic backend evaluation gate', () => {
  it('has a dedicated local command in both canonical CI chains', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:evals']).toContain('vitest.evals.config.ts');
    expect(pkg.scripts['ci:fast']).toContain('npm run test:evals');
    expect(pkg.scripts['ci']).toContain('npm run test:evals');
  });

  it.each(['.github/workflows/pr.yml', '.github/workflows/ci.yml', '.github/workflows/full-gate.yml'])(
    '%s runs the backend evaluation corpus',
    (workflow) => {
      expect(readFileSync(resolve(ROOT, workflow), 'utf8')).toContain('npm run test:evals');
    }
  );
});
