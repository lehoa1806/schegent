/**
 * Grounds the anchors that the lint suite itself names.
 *
 * A forbidding lint reports the empty set on success, so it looks identical
 * whether it is enforcing a rule or enforcing nothing. Two ways it stops
 * enforcing without anyone noticing:
 *
 *   1. an allowlist entry names a file that no longer exists — the exemption
 *      outlives the thing it exempted, and a future file at that path is
 *      pre-excused;
 *   2. a forbidden IPC constant is renamed — every grep for the old name
 *      returns nothing, no offenders are found, and the lint passes forever.
 *
 * Neither is visible from inside the lint that has the defect, because in both
 * cases its own assertion is satisfied. This file is the outside view: it
 * checks the anchors of every lint at once rather than adding two assertions
 * to each of the twenty-odd lints that carry an allowlist. `destructive-
 * actions.lint.test.ts` already carries both guards by hand and is the model;
 * the point here is that the next lint written gets them without having to
 * remember.
 *
 * Comments are stripped before scanning. Every false positive in the first
 * pass over this suite was a deliberately-hypothetical constant or a prose
 * citation inside a comment — `no-duplicate-ipc-validators` explains itself
 * with `case CMD_XXX:`, and `queue-command-reachability` names a
 * `CMD_SPLIT_TASK` that exists precisely to say it does not exist.
 *
 * `specs/` and `docs/` are out of scope by construction: they live in the
 * workspace envelope above `repo/`, so a literal naming one is a citation of
 * planning material, not a claim about a path in this repository.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Suites whose job is to assert things about the tree, so their anchors are claims. */
const SCANNED_DIRS = ['tests/lint', 'tests/parity', 'tests/contract', 'tests/unit/build'] as const;

/** Trees a lint may make a path claim about. */
const CLAIMABLE_PREFIXES = ['src/', 'webview-ui/', 'tests/', 'scripts/'] as const;

const PATH_LITERAL = /['"`]((?:src|webview-ui|tests|scripts)\/[A-Za-z0-9._/-]+)['"`]/g;
const IPC_TOKEN = /['"`]((?:CMD|MSG)_[A-Z0-9_]+)['"`]/g;

/**
 * Paths a test names in order to assert they are *absent*. For these the
 * check is inverted, so each entry is verified to still be missing — an
 * exemption that quietly became wrong is the same defect one level up.
 */
const ABSENT_BY_ASSERTION: ReadonlyMap<string, string> = new Map([
  [
    'src/engine/index.ts',
    'release-qualification.test.ts asserts the withdrawn Rust engine is gone; its absence is the assertion'
  ]
]);

/**
 * Walker sanity. If comment-stripping or either regex degrades, both scans go
 * quiet and every check below passes vacuously — the exact failure this file
 * exists to catch. These two are in executable code, not comments, in
 * `no-inline-phase-log-ipc.test.ts`.
 */
const SENTINEL_PATH = 'webview-ui/src/lib/phase-log-ipc.ts';
const SENTINEL_TOKEN = 'CMD_READ_PHASE_LOG';

/** Line and block comments blanked, preserving length so offsets stay usable. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function scannedTestFiles(): readonly string[] {
  const found: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.test.ts')) found.push(path.join(dir, name));
    }
  }
  return found.sort();
}

const TEST_FILES = scannedTestFiles();

const CODE_BY_FILE = new Map<string, string>(
  TEST_FILES.map((rel) => [rel, stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))])
);

function literalsIn(code: string): readonly string[] {
  return [...new Set([...code.matchAll(PATH_LITERAL)].map((m) => m[1]!))];
}

function tokensIn(code: string): readonly string[] {
  return [...new Set([...code.matchAll(IPC_TOKEN)].map((m) => m[1]!))];
}

/** Every source file's text, concatenated once, so token lookups need no subprocess. */
function readSourceCorpus(): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (/\.(ts|svelte|mts|mjs)$/.test(entry.name)) chunks.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  walk(path.join(REPO_ROOT, 'webview-ui', 'src'));
  return chunks.join('\n');
}

const SOURCE_CORPUS = readSourceCorpus();

describe('the lint suite’s own anchors are grounded in the tree', () => {
  it('finds the test files, path literals, and IPC constants it claims to check', () => {
    expect(TEST_FILES.length, 'no lint/parity/contract test files were collected').toBeGreaterThan(
      0
    );

    const allLiterals = TEST_FILES.flatMap((rel) => literalsIn(CODE_BY_FILE.get(rel)!));
    const allTokens = TEST_FILES.flatMap((rel) => tokensIn(CODE_BY_FILE.get(rel)!));

    expect(
      allLiterals,
      'the path-literal scan went quiet; every check below would pass vacuously'
    ).toContain(SENTINEL_PATH);
    expect(
      allTokens,
      'the IPC-constant scan went quiet; every check below would pass vacuously'
    ).toContain(SENTINEL_TOKEN);
    expect(SOURCE_CORPUS.length, 'the source corpus is empty').toBeGreaterThan(0);
  });

  it('every path a lint names still exists', () => {
    const stale: string[] = [];
    for (const rel of TEST_FILES) {
      for (const literal of literalsIn(CODE_BY_FILE.get(rel)!)) {
        if (ABSENT_BY_ASSERTION.has(literal)) continue;
        if (!CLAIMABLE_PREFIXES.some((prefix) => literal.startsWith(prefix))) continue;
        if (fs.existsSync(path.resolve(REPO_ROOT, literal))) continue;
        stale.push(`${rel} -> ${literal}`);
      }
    }
    expect(
      stale,
      'these lints name a path that no longer exists; an allowlist entry for a deleted file ' +
        'pre-excuses whatever is written at that path next\n' +
        stale.join('\n')
    ).toEqual([]);
  });

  it('every IPC constant a lint forbids still occurs in the source tree', () => {
    const dead: string[] = [];
    for (const rel of TEST_FILES) {
      for (const token of tokensIn(CODE_BY_FILE.get(rel)!)) {
        if (new RegExp(`\\b${token}\\b`).test(SOURCE_CORPUS)) continue;
        dead.push(`${rel} -> ${token}`);
      }
    }
    expect(
      dead,
      'these lints forbid a constant that occurs nowhere in source, so they scan for a name ' +
        'nothing uses and can never find an offender\n' +
        dead.join('\n')
    ).toEqual([]);
  });

  it('every absence assertion is still absent, and still asserted', () => {
    for (const [literal, reason] of ABSENT_BY_ASSERTION) {
      expect(
        fs.existsSync(path.resolve(REPO_ROOT, literal)),
        `${literal} is exempt because: ${reason}. It now exists, so the exemption is wrong.`
      ).toBe(false);

      const named = TEST_FILES.some((rel) => CODE_BY_FILE.get(rel)!.includes(literal));
      expect(
        named,
        `${literal} is exempt because: ${reason}. No test names it any more, so the exemption is stale.`
      ).toBe(true);
    }
  });
});
