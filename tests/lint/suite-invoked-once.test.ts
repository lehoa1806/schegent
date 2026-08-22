// FR-R3-042 — a test directory is invoked once per chain.
//
// `tests/perf/**` was in the default vitest config's `include` AND invoked
// separately as `test:perf` in the `ci` chain, so every wall-clock budget was
// asserted twice per gate for one signal. Nobody noticed because both paths
// passed; duplication is only visible when you count.
//
// This is a chain-shape check, not a timing one. It reads the manifest's scripts
// and the config's include list, and fails when a directory is reachable twice
// from the same chain.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** Test directories that must be reachable at most once from any single chain. */
const SUITE_DIRS = ['tests/perf', 'tests/e2e', 'tests/integration'] as const;

function scripts(): Record<string, string> {
  return (JSON.parse(read('package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
}

/** The npm targets a chain expands to, following `npm run X` one level deep. */
function expand(chain: string, all: Record<string, string>, seen = new Set<string>()): string[] {
  const targets = [...(all[chain] ?? '').matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  const out: string[] = [];
  for (const t of targets) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t, ...expand(t, all, seen));
  }
  return out;
}

/**
 * The `include` globs a vitest config declares, parsed rather than
 * substring-matched.
 *
 * A whole-file search was the first version and it reported a false positive
 * immediately: `vitest.config.ts` now carries a comment explaining why
 * `tests/perf/**` is deliberately absent, and the comment names the directory it
 * excludes. A check that cannot tell a glob from a sentence about a glob is a
 * check that fires on its own documentation.
 */
function includeGlobs(configRelPath: string): string[] {
  const source = read(configRelPath);
  const block = /include:\s*\[([^\]]*)\]/.exec(source);
  if (block === null) return [];
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Which suite directories a single npm target actually runs. */
function dirsRunBy(target: string, all: Record<string, string>): string[] {
  const body = all[target] ?? '';
  if (!body.includes('vitest')) return [];

  // An explicit path argument narrows whatever the config declares.
  const pathArg = /vitest run\s+(tests\/[\w/-]+)/.exec(body);
  if (pathArg !== null) {
    return SUITE_DIRS.filter((dir) => pathArg[1].startsWith(dir));
  }

  const configMatch = /--config\s+(\S+)/.exec(body);
  const globs = includeGlobs(configMatch ? configMatch[1] : 'vitest.config.ts');
  return SUITE_DIRS.filter((dir) => globs.some((glob) => glob.startsWith(dir)));
}

describe('a suite directory is invoked once per chain', () => {
  for (const chain of ['ci', 'ci:fast']) {
    it(`${chain} reaches no suite directory twice`, () => {
      const all = scripts();
      expect(
        all[chain],
        `package.json declares no \`${chain}\` script. This check derives chains from the manifest; ` +
          `if one was renamed, rename it here too rather than losing the check.`
      ).toBeTruthy();

      const counts = new Map<string, string[]>();
      for (const target of expand(chain, all)) {
        for (const dir of dirsRunBy(target, all)) {
          counts.set(dir, [...(counts.get(dir) ?? []), target]);
        }
      }
      const doubled = [...counts.entries()]
        .filter(([, targets]) => targets.length > 1)
        .map(([dir, targets]) => `${dir} via ${targets.join(' and ')}`);
      expect(
        doubled,
        `\`${chain}\` runs a suite directory more than once: ${doubled.join('; ')}. One signal ` +
          `asserted twice is double the flake exposure and no extra information — which is what ` +
          `tests/perf did before FR-R3-042, silently, because both paths passed.`
      ).toEqual([]);
    });
  }
});
