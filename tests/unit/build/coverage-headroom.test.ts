// Review gap GC-17 (2026-11-12) — the coverage headroom ratchet covers the host suite too.
//
// WHAT THIS PINS:
//   - the measurement, the floor parse and the lag rule the ratchet applies (FR-R3-044);
//   - both coverage runs are followed by it: the webview's `test:coverage` runs it with no target;
//     the host's `test:coverage` stays a bare primitive runner (FR-019's shape rule), so every chain
//     that runs it continues with `coverage:headroom`. The host floors had sat 10-13 points below
//     measured with nothing to say so, so coverage could drain that far with every run green.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/** Loaded dynamically, like every test that reaches into `scripts/`: a static import is TS7016. */
async function loadHeadroom() {
  return import('../../../scripts/check-coverage-headroom.mjs');
}

let headroom: Awaited<ReturnType<typeof loadHeadroom>>;

beforeAll(async () => {
  headroom = await loadHeadroom();
});

const ROOT = resolve(__dirname, '..', '..', '..');

function scriptsOf(packageFile: string): Map<string, string> {
  return new Map(Object.entries((JSON.parse(readFileSync(resolve(ROOT, packageFile), 'utf8')) as { scripts: Record<string, string> }).scripts));
}

function scriptOf(packageFile: string, name: string): string {
  return scriptsOf(packageFile).get(name) ?? '';
}

describe('GC-17 — the headroom rule', () => {
  it('measures statements, branches and functions from the raw report, lines as statements', () => {
    const report = {
      'a.ts': { s: { 0: 1, 1: 0, 2: 3, 3: 1 }, f: { 0: 1, 1: 0 }, b: { 0: [1, 0], 1: [2, 2] } }
    };

    expect(headroom.measuredPercentages(report)).toEqual({ statements: 75, branches: 75, functions: 50, lines: 75 });
  });

  it('reads the floors from a thresholds block, and reports none when there is no block', () => {
    const source = 'coverage: { thresholds: {\n statements: 84,\n branches: 79,\n functions: 85,\n lines: 84\n } }';

    expect(headroom.declaredFloors(source)).toEqual({ statements: 84, branches: 79, functions: 85, lines: 84 });
    expect(headroom.declaredFloors('coverage: {}')).toBeNull();
  });

  it('passes a floor that lags the intended one by at most the tolerance, and names one that lags further', () => {
    const measured = { statements: 89.6, branches: 88.1, functions: 91.6, lines: 89.6 };
    const atTolerance = { statements: 89 - headroom.HEADROOM - headroom.TOLERANCE, branches: 88 - headroom.HEADROOM, functions: 91 - headroom.HEADROOM, lines: 89 - headroom.HEADROOM };
    const lagging = { ...atTolerance, branches: 75 };

    expect(headroom.staleFloors(measured, atTolerance)).toEqual([]);
    const stale = headroom.staleFloors(measured, lagging);
    expect(stale).toHaveLength(1);
    expect(stale.at(0)).toMatch(/^branches: measured 88\.10%, floor 75, intended 83/);
  });
});

describe('GC-17 — both coverage runs end in the ratchet', () => {
  it('names a host and a webview target', () => {
    expect(Object.keys(headroom.COVERAGE_TARGETS).sort()).toEqual(['host', 'webview']);
  });

  it('coverage:headroom runs it with the host target', () => {
    expect(scriptOf('package.json', 'coverage:headroom')).toBe('node scripts/check-coverage-headroom.mjs host');
  });

  it('every chain that runs the host coverage continues with coverage:headroom', () => {
    const chains = ['ci', 'verify:release'];

    for (const chain of chains) {
      expect(scriptOf('package.json', chain), chain).toContain('npm run test:coverage && npm run coverage:headroom');
    }
    const runsCoverage = [...scriptsOf('package.json')]
      .filter(([, body]) => body.includes('npm run test:coverage'))
      .map(([name]) => name)
      .sort();
    expect(runsCoverage).toEqual([...chains].sort());
  });

  it('the webview test:coverage runs it with the default target', () => {
    expect(scriptOf('webview-ui/package.json', 'test:coverage')).toMatch(/&& node \.\.\/scripts\/check-coverage-headroom\.mjs$/);
  });

  it('the host config declares a floor for every metric', () => {
    const floors = headroom.declaredFloors(readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8'));

    expect(floors).not.toBeNull();
    expect(Object.keys(floors ?? {}).sort()).toEqual(['branches', 'functions', 'lines', 'statements']);
  });
});
