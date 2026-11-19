// FR-R7-08 — Parity for `test:gates`, generator `--check` drift detection,
// and `verify:linux` placement in the single verification step list.
//
// WHAT THIS HOLDS:
//   1. `test:gates` uses explicit path arguments matching every non-unit,
//      non-integration include directory in `vitest.config.ts` (FR-003). Adding
//      a new governance test directory to `vitest.config.ts` without updating
//      `test:gates` fails here (verified by negative control).
//   2. `test:gates` resolves to the exact same lint, parity, and contract test
//      file set as `test:host` (SC-001).
//   3. `scripts/generate-verification-scripts.mjs --check` passes on the
//      committed `package.json` and fails if any generated aggregate is
//      hand-edited (SC-004).
//   4. `verify:linux` (GC-18) is declared in `scripts/verification-steps.json`
//      at tier `release`, included in `verify:release`, and its script reports
//      a clear message when no container runtime daemon answers (FR-006).
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

async function loadGenerator() {
  return import('../../scripts/generate-verification-scripts.mjs');
}

let generator: Awaited<ReturnType<typeof loadGenerator>>;

beforeAll(async () => {
  generator = await loadGenerator();
});

function loadManifestScripts(): Readonly<Record<string, string | undefined>> {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string | undefined>>;
  };
  return pkg.scripts;
}

/**
 * Extracts string-literal entries of `test.include` from `vitest.config.ts`
 * via the TypeScript AST rather than regexes.
 */
function readVitestIncludes(configSource: string): readonly string[] {
  const sf = ts.createSourceFile('vitest.config.ts', configSource, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'include' &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      // Distinguish `test.include` from `coverage.include` by checking the
      // enclosing property assignment name.
      const parentObj = node.parent;
      const grandParent = parentObj.parent;
      if (
        ts.isObjectLiteralExpression(parentObj) &&
        ts.isPropertyAssignment(grandParent) &&
        ts.isIdentifier(grandParent.name) &&
        grandParent.name.text === 'test'
      ) {
        for (const el of node.initializer.elements) {
          if (ts.isStringLiteral(el)) found.push(el.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** Extracts explicit positional path arguments from a `vitest run ...` script body. */
function explicitPathsFromVitestCommand(body: string): readonly string[] {
  const tokens = body.trim().split(/\s+/);
  const vitestIdx = tokens.indexOf('vitest');
  if (vitestIdx === -1 || tokens[vitestIdx + 1] !== 'run') return [];
  return tokens.slice(vitestIdx + 2).filter((token) => !token.startsWith('-'));
}

/** Top-level directory prefix of a vitest include pattern such as `tests/lint/**\/*.test.ts`. */
function includeDirectory(pattern: string): string {
  const parts = pattern.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : pattern;
}

/** Non-unit, non-integration directories from `vitest.config.ts` that belong in `test:gates`. */
const NON_GATE_HOST_DIRS = new Set(['tests/unit', 'tests/integration']);

function uncoveredGateDirectories(
  vitestIncludes: readonly string[],
  gatePaths: readonly string[]
): readonly string[] {
  const expectedDirs = vitestIncludes
    .map(includeDirectory)
    .filter((dir) => !NON_GATE_HOST_DIRS.has(dir));
  const gateSet = new Set(gatePaths);
  return expectedDirs.filter((dir) => !gateSet.has(dir));
}

describe('FR-R7-08 — test:gates parity and single verification step list', () => {
  it('lists every non-unit, non-integration vitest include directory in test:gates', () => {
    const scripts = loadManifestScripts();
    const gatesCmd = scripts['test:gates'];
    expect(gatesCmd, 'package.json must declare test:gates').toBeDefined();

    const gatePaths = explicitPathsFromVitestCommand(gatesCmd ?? '');
    expect(gatePaths).toEqual(['tests/lint', 'tests/parity', 'tests/contract']);

    const vitestSource = readFileSync(resolve(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    const includes = readVitestIncludes(vitestSource);
    expect(includes.length, 'vacuity control: vitest.config.ts must declare test.include').toBeGreaterThanOrEqual(5);

    expect(
      uncoveredGateDirectories(includes, gatePaths),
      'A new gate directory was added to vitest.config.ts without adding it to test:gates'
    ).toEqual([]);

    for (const dir of gatePaths) {
      expect(
        NON_GATE_HOST_DIRS.has(dir),
        `test:gates must not include non-gate suite directory ${dir}`
      ).toBe(false);
    }
  });

  it('NON-VACUITY: adding a new gate include directory to vitest.config.ts fails parity', () => {
    const syntheticDir = ['tests', 'governance'].join('/');
    const syntheticIncludes = [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/parity/**/*.test.ts',
      'tests/lint/**/*.test.ts',
      'tests/contract/**/*.test.ts',
      `${syntheticDir}/**/*.test.ts`
    ];
    expect(
      uncoveredGateDirectories(syntheticIncludes, ['tests/lint', 'tests/parity', 'tests/contract'])
    ).toEqual([syntheticDir]);
  });

  it('SC-001: test:gates resolves the exact same lint, parity, and contract test files as test:host', () => {
    const scripts = loadManifestScripts();
    const gatePaths = explicitPathsFromVitestCommand(scripts['test:gates'] ?? '');

    const vitestSource = readFileSync(resolve(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    const hostGovernanceDirs = readVitestIncludes(vitestSource)
      .map(includeDirectory)
      .filter((dir) => !NON_GATE_HOST_DIRS.has(dir));

    const collectTests = (dirs: readonly string[]): readonly string[] =>
      dirs
        .flatMap((dir) =>
          filesUnder(resolve(REPO_ROOT, dir), { extensions: ['.ts'] })
            .filter((abs) => abs.endsWith('.test.ts'))
            .map((abs) => relative(REPO_ROOT, abs).split(sep).join('/'))
        )
        .sort();

    const fromTestGates = collectTests(gatePaths);
    const fromTestHostGovernance = collectTests(hostGovernanceDirs);

    expect(fromTestGates.length, 'vacuity control: governance suites must be non-empty').toBeGreaterThan(200);
    expect(fromTestGates).toEqual(fromTestHostGovernance);
  });

  it('SC-004: committed package.json matches scripts/verification-steps.json and hand-edits fail --check', () => {
    const spec = generator.loadStepList();
    const scripts = loadManifestScripts();

    const clean = generator.checkManifestParity(spec, scripts);
    expect(clean.errors).toEqual([]);
    expect(clean.drifted).toEqual([]);
    expect(clean.ok).toBe(true);

    // Negative control: hand-editing every generated aggregate must be rejected.
    for (const agg of generator.GENERATED_AGGREGATES) {
      const tampered = {
        ...scripts,
        [agg]: `${scripts[agg] ?? ''} && echo hand-edited`
      };
      const result = generator.checkManifestParity(spec, tampered);
      expect(result.ok, `hand-editing "${agg}" must fail --check`).toBe(false);
      expect(result.drifted.map((d) => d.name)).toContain(agg);
    }
  });

  it('FR-006: verify:linux (GC-18) is placed in the release tier and fails clearly without a container runtime', () => {
    const spec = generator.loadStepList();
    const linuxStep = spec.steps.find((step) => step.name === 'verify:linux');
    expect(linuxStep, 'verification-steps.json must declare verify:linux').toBeDefined();
    expect(linuxStep?.firstTier).toBe('release');

    const scripts = loadManifestScripts();
    expect(scripts['verify:release']).toContain('npm run verify:linux');

    const linuxScript = readFileSync(resolve(REPO_ROOT, 'scripts/linux-leg.sh'), 'utf8');
    expect(linuxScript).toContain('docker info');
    expect(linuxScript).toContain('no Docker daemon answered');
  });

  it('hardening: generator rejects unsafe script names, out-of-tier steps, and preserves unrelated escapes', () => {
    const spec = generator.loadStepList();
    const scripts = loadManifestScripts();

    // 1. Unsafe shell metacharacters in a step name must be refused.
    const unsafeSpec = {
      ...spec,
      steps: [
        ...spec.steps,
        {
          name: 'bad;echo',
          command: 'echo hi',
          firstTier: 'release' as const,
          requiresWebviewBuild: false,
          category: 'test'
        }
      ]
    };
    expect(
      generator.validateStepList(unsafeSpec, scripts).some((e) => e.includes('unsafe script name'))
    ).toBe(true);

    // 2. Placing a release-tier step inside verify:edit must fail firstTier validation.
    const editAgg = spec.aggregates['verify:edit'];
    if (editAgg && editAgg.kind === 'tier') {
      const invertedSpec = {
        ...spec,
        aggregates: {
          ...spec.aggregates,
          'verify:edit': {
            ...editAgg,
            extraSteps: [...editAgg.extraSteps, 'test:e2e']
          }
        }
      };
      expect(
        generator
          .validateStepList(invertedSpec, scripts)
          .some((e) => e.includes('firstTier is "release"'))
      ).toBe(true);
    }

    // 3. applyGeneratedScripts must preserve unrelated unicode escapes and treat `$&`/`$$` literally.
    const samplePkg = [
      '{',
      '  "description": "keeps \\u2014 untouched",',
      '  "scripts": {',
      '    "verify:edit": "old"',
      '  }',
      '}',
      ''
    ].join('\n');
    const updated = generator.applyGeneratedScripts(samplePkg, {
      'verify:edit': 'echo $& $$ $1'
    });
    expect(updated).toContain('keeps \\u2014 untouched');
    expect(JSON.parse(updated).scripts['verify:edit']).toBe('echo $& $$ $1');
  });
});
