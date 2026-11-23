// FR-R7-15 (W14 / FR-014, SC-011) — host lint input-set contract.
//
// `scripts/lint.mjs` walks `src/`, `tests/`, `scripts/`, and root-level files
// rather than filtering by `git ls-files`, so newly authored untracked source
// files are linted before commit. Disposable scratch copies belong in
// `repo/scratch/`, `repo/.tmp/`, or the workspace `scratch/`, and generated
// artifact directories (`coverage/`, `.vscode-test/`, `.release/`,
// `tests/visual/.artifacts/`, `tests/soak/.artifacts/`) are ignored by
// `hostConfig` in `scripts/lint-config.mjs`.
//
// Every test below drives the real `ESLint` Node API configured identically to
// `scripts/lint.mjs` (`overrideConfigFile: true`, `overrideConfig: hostConfig`).
// Temp files are written only inside `repo/scratch/` or `repo/.tmp/` and always
// removed in `try/finally` via `removeTempRoot()`, so parallel lint gates
// scanning `src/`, `tests/`, and `scripts/` never observe transient files.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { removeTempRoot } from '../../temp-root-cleanup';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Valid JS/TS carrying a deterministic error-severity lint finding (`no-debugger`). */
const JS_VIOLATION = 'export function lintInputProbe() {\n  debugger;\n  return 1;\n}\n';

/** Valid TS carrying both syntactic (`no-debugger`) and type-aware (`no-floating-promises`) findings. */
const TS_VIOLATION =
  'export async function lintInputProbe(): Promise<number> {\n  Promise.resolve(1);\n  debugger;\n  return 1;\n}\n';

const DOCUMENTED_IGNORED_PATHS = [
  'scratch/webview.visual.spec.ts',
  'scratch/probe.mjs',
  '.tmp/webview.visual.spec.ts',
  '.tmp/probe.mjs',
  'coverage/lcov-report/sorter.js',
  '.vscode-test/user-data/probe.js',
  '.release/probe.mjs',
  'tests/visual/.artifacts/probe.ts',
  'tests/soak/.artifacts/probe.ts'
] as const;

let hostConfig: ESLint.Options['overrideConfig'];

function createHostEslint(cwd: string): ESLint {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: hostConfig,
    errorOnUnmatchedPattern: false,
    warnIgnored: false
  });
}

function writeFileEnsuringDir(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

beforeAll(async () => {
  // Computed specifier: `scripts/lint-config.mjs` has no declaration file and
  // `tsconfig.tests.json` does not enable `allowJs`.
  const specifier = pathToFileURL(resolve(REPO_ROOT, 'scripts', 'lint-config.mjs')).href;
  const mod = (await import(specifier)) as { hostConfig: ESLint.Options['overrideConfig'] };
  hostConfig = mod.hostConfig;
});

describe('FR-R7-15 W14 — host lint input-set contract', () => {
  it(
    'checks untracked source files in checked trees and does not ignore them',
    async () => {
      const hostEslint = createHostEslint(REPO_ROOT);

      for (const relPath of [
        'tests/visual/__untracked-copy-probe.ts',
        'src/__untracked-probe.ts',
        'scripts/__untracked-probe.mjs',
        'src/scratch/probe.ts',
        'src/.tmp/probe.ts',
        'src/.release/probe.ts',
        'src/.artifacts/probe.ts',
        'tests/unit/.artifacts/probe.ts',
        'scripts/scratch/probe.mjs'
      ]) {
        expect(
          await hostEslint.isPathIgnored(relPath),
          `${relPath} is inside a checked source tree and must not be ignored`
        ).toBe(false);
      }

      // Probe type-aware linting for `tests/**/*.ts` through `lintText` at a real
      // project path so parallel gates scanning `tests/` never see a defective file.
      const tsResults = await hostEslint.lintText(TS_VIOLATION, {
        filePath: resolve(REPO_ROOT, 'tests', 'unit', 'scripts', 'lint-input-set.test.ts')
      });
      const tsRuleIds = tsResults.flatMap((result) =>
        result.messages.map((message) => message.ruleId)
      );
      expect(tsRuleIds).toContain('no-debugger');
      expect(tsRuleIds).toContain('@typescript-eslint/no-floating-promises');

      // Probe directory-walk `lintFiles` on real untracked files in an isolated tree
      // rooted under `repo/.tmp/` using the identical `hostConfig`.
      const tmpRoot = resolve(REPO_ROOT, '.tmp');
      const tmpExisted = existsSync(tmpRoot);
      const isolatedRoot = resolve(tmpRoot, `lint-input-set-checked-${randomUUID()}`);
      try {
        writeFileEnsuringDir(join(isolatedRoot, 'scripts', 'untracked-probe.mjs'), JS_VIOLATION);
        writeFileEnsuringDir(join(isolatedRoot, 'scripts', 'untracked-probe.ts'), JS_VIOLATION);

        const isolatedEslint = createHostEslint(isolatedRoot);
        const results = await isolatedEslint.lintFiles(['scripts']);
        expect(results).toHaveLength(2);
        for (const result of results) {
          const debuggerFindings = result.messages.filter(
            (message) => message.ruleId === 'no-debugger'
          );
          expect(debuggerFindings.length).toBeGreaterThan(0);
          expect(debuggerFindings.at(0)?.severity).toBe(2);
        }
      } finally {
        await removeTempRoot(isolatedRoot);
        if (!tmpExisted) {
          try {
            rmdirSync(tmpRoot);
          } catch {
            // Another test or process created a sibling entry inside .tmp/.
          }
        }
      }
    },
    30_000
  );

  it('ignores disposable scratch copies inside repo/scratch/ and repo/.tmp/', async () => {
    const hostEslint = createHostEslint(REPO_ROOT);
    const runId = randomUUID();

    const scratchRoot = resolve(REPO_ROOT, 'scratch');
    const scratchExisted = existsSync(scratchRoot);
    const scratchProbeDir = resolve(scratchRoot, `.lint-input-set-${runId}`);

    const tmpRoot = resolve(REPO_ROOT, '.tmp');
    const tmpExisted = existsSync(tmpRoot);
    const tmpProbeDir = resolve(tmpRoot, `lint-input-set-${runId}`);

    try {
      const files = [
        join(scratchProbeDir, 'disposable-copy.ts'),
        join(scratchProbeDir, 'disposable-copy.mjs'),
        join(tmpProbeDir, 'disposable-copy.ts'),
        join(tmpProbeDir, 'disposable-copy.mjs')
      ];
      for (const file of files) {
        writeFileEnsuringDir(file, JS_VIOLATION);
      }

      for (const file of files) {
        const relPath = relative(REPO_ROOT, file).replaceAll('\\', '/');
        expect(
          await hostEslint.isPathIgnored(relPath),
          `${relPath} must be ignored by hostConfig CARRIED_IGNORES`
        ).toBe(true);
      }

      const dirWalkResults = await hostEslint.lintFiles(['scratch', '.tmp']);
      expect(dirWalkResults).toEqual([]);

      const directResults = await hostEslint.lintFiles([
        relative(REPO_ROOT, scratchProbeDir).replaceAll('\\', '/'),
        relative(REPO_ROOT, tmpProbeDir).replaceAll('\\', '/')
      ]);
      expect(directResults).toEqual([]);
    } finally {
      await removeTempRoot(scratchProbeDir);
      await removeTempRoot(tmpProbeDir);
      if (!scratchExisted) {
        try {
          rmdirSync(scratchRoot);
        } catch {
          // Another process or developer created a sibling entry inside scratch/.
        }
      }
      if (!tmpExisted) {
        try {
          rmdirSync(tmpRoot);
        } catch {
          // Another test or process created a sibling entry inside .tmp/.
        }
      }
    }
  });

  it('ignores all documented scratch and generated artifact directories', async () => {
    const hostEslint = createHostEslint(REPO_ROOT);
    for (const relPath of DOCUMENTED_IGNORED_PATHS) {
      expect(
        await hostEslint.isPathIgnored(relPath),
        `${relPath} must be ignored by hostConfig CARRIED_IGNORES`
      ).toBe(true);
    }

    const tmpRoot = resolve(REPO_ROOT, '.tmp');
    const tmpExisted = existsSync(tmpRoot);
    const isolatedRoot = resolve(tmpRoot, `lint-input-set-ignores-${randomUUID()}`);
    try {
      for (const relPath of DOCUMENTED_IGNORED_PATHS) {
        writeFileEnsuringDir(join(isolatedRoot, relPath), JS_VIOLATION);
      }

      const isolatedEslint = createHostEslint(isolatedRoot);
      const results = await isolatedEslint.lintFiles([
        'scratch',
        '.tmp',
        'coverage',
        '.vscode-test',
        '.release',
        'tests/visual/.artifacts',
        'tests/soak/.artifacts'
      ]);
      expect(results).toEqual([]);
    } finally {
      await removeTempRoot(isolatedRoot);
      if (!tmpExisted) {
        try {
          rmdirSync(tmpRoot);
        } catch {
          // Another test or process created a sibling entry inside .tmp/.
        }
      }
    }
  });
});
