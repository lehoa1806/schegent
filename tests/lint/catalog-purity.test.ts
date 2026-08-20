// Feature 099 (FR-R3-015) T496a — the store is pure (FR-057, FR-058, FR-061).
//
// Modelled on `tests/lint/process-yaml-purity.test.ts`, and one notch stricter.
// The exchange path is allowed to reach Node built-ins transitively; `src/catalog/`
// is allowed **no bare specifier at all** — no `vscode`, no Node built-in, no
// third-party package — in the directory or anywhere in its value-import closure.
//
// That is not tidiness. Three properties fall out of it, and each would otherwise
// be a discipline someone has to remember:
//
//   1. **No workspace root can leak** (FR-061). The core is addressed by segments
//      and never holds a path, because it has no `node:path` and no `vscode` to get
//      one from. A record or a log line cannot carry a root the code cannot obtain.
//   2. **No destructive call lives here.** `unlink` and `rename` need `node:fs`,
//      which this directory cannot import, so the containment oracle has exactly one
//      place to guard: the adapter.
//   3. **The store is testable without a disk**, which is what lets the version
//      algebra, the integrity findings, and the retention exemptions be asserted
//      against stub ports rather than against a temp directory.
//
// The fourth claim is about the layer collapse. `src/catalog/` is new code written
// after the `built-in`/`user`/`workspace` tier was deleted (FR-041, FR-042, FR-043),
// and it must never acquire one: a scope literal appearing here would be the first
// step of the tier growing back inside the store that replaced it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CATALOG_DIR = resolve(REPO_ROOT, 'src', 'catalog');

/**
 * The directory IS the list.
 *
 * A hand-maintained list of pure modules cannot notice an impure one it does not
 * name — the omission makes the lint quieter rather than louder, which is the worst
 * failure mode a purity check can have. `ANCHORS` is the vacuity guard.
 */
const CATALOG_MODULES: readonly string[] = readdirSync(CATALOG_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

/** Modules whose absence would mean the directory moved or the scan broke. */
const ANCHORS = [
  'atomic-write',
  'canonical-json',
  'catalog-integrity',
  'catalog-manifest',
  'catalog-paths',
  'catalog-retention',
  'catalog-store',
  // Feature 101 (T011) — the changed-field summary. Anchored rather than left to
  // directory discovery because it is the first module here written for a UI
  // surface, and the pull toward reading a workspace path or a clock to answer
  // "what changed" is exactly what this lint exists to refuse.
  'changed-fields',
  'index',
  'ports',
  'version-record'
] as const;

/** The deleted tier, in every spelling a literal could take. */
const SCOPE_LITERALS = ['built-in', 'user', 'workspace', 'builtin', 'user-scope'] as const;

/** Reaching the host or the process without an import. */
const IMPURE_GLOBALS = [
  'process.',
  'require(',
  '__dirname',
  '__filename',
  'globalThis.',
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'Date.now',
  'Math.random'
] as const;

interface Import {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+'([^']+)'/g;

function importsOf(text: string): readonly Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const keyword = Boolean(match[1]);
    const bindings = (match[2] ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .map((binding) => binding.trim())
      .filter(Boolean);
    // `import { type A, type B } from '…'` is erased too, even without the leading
    // keyword.
    const everyBindingTyped =
      bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '));
    found.push({ specifier: match[3]!, typeOnly: keyword || everyBindingTyped });
  }
  return found;
}

function sourceOf(name: string): string {
  return resolve(CATALOG_DIR, `${name}.ts`);
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file);
}

/**
 * Source with comment lines removed.
 *
 * Every rule below is named and explained in the prose of the module it governs, so
 * a scan over raw text would report each file for documenting its own constraint.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/** Every file reachable from the store through value imports. */
function valueImportClosure(): {
  readonly files: readonly string[];
  readonly bare: ReadonlyMap<string, string>;
} {
  const visited = new Set<string>();
  const bare = new Map<string, string>();
  const pending = CATALOG_MODULES.map(sourceOf);

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const entry of importsOf(readFileSync(file, 'utf8'))) {
      if (entry.typeOnly) continue;
      if (!entry.specifier.startsWith('.')) {
        if (!bare.has(entry.specifier)) bare.set(entry.specifier, repoRelative(file));
        continue;
      }
      const direct = resolve(dirname(file), `${entry.specifier}.ts`);
      const asIndex = resolve(dirname(file), entry.specifier, 'index.ts');
      const target = existsSync(direct) ? direct : asIndex;
      // A specifier this walk cannot resolve would silently shrink the closure, so
      // it fails the scan rather than being skipped.
      expect(
        existsSync(target),
        `${repoRelative(file)} imports unresolvable ${entry.specifier}`
      ).toBe(true);
      pending.push(target);
    }
  }

  return { files: [...visited], bare };
}

describe('Feature 099 — the catalog store imports nothing impure', () => {
  it('scans every module in the directory, and found the ones the plan named', () => {
    for (const anchor of ANCHORS) {
      expect(CATALOG_MODULES, `${anchor}.ts must be discovered`).toContain(anchor);
    }
    expect(CATALOG_MODULES.length).toBeGreaterThanOrEqual(ANCHORS.length);
    for (const name of CATALOG_MODULES) {
      expect(existsSync(sourceOf(name)), `${name}.ts must resolve`).toBe(true);
    }
  });

  it('imports no bare specifier from any store module (FR-057)', () => {
    // Stricter than the exchange path's rule and deliberately so: there is no
    // allowlist here, because every impure thing the store needs already arrives as
    // a port. A new bare import is a port that was not declared.
    const offenders: string[] = [];
    for (const name of CATALOG_MODULES) {
      for (const entry of importsOf(readFileSync(sourceOf(name), 'utf8'))) {
        if (!entry.specifier.startsWith('.')) offenders.push(`${name}.ts -> ${entry.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports vscode nowhere, by any spelling', () => {
    const offenders: string[] = [];
    for (const name of CATALOG_MODULES) {
      for (const entry of importsOf(readFileSync(sourceOf(name), 'utf8'))) {
        const bare = entry.specifier.replace(/^node:/, '');
        if (bare === 'vscode') offenders.push(`${name}.ts -> ${entry.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches no host, process, or network global without an import', () => {
    // `Date.now` and `Math.random` are on this list with the rest: both are impure,
    // both have ports (`Clock`, and the adapter's temp token), and both are exactly
    // what a future edit reaches for when a port feels like too much ceremony.
    const offenders: string[] = [];
    for (const name of CATALOG_MODULES) {
      const code = codeOf(sourceOf(name));
      for (const global of IMPURE_GLOBALS) {
        if (code.includes(global)) offenders.push(`${name}.ts -> ${global}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no deleted scope literal (FR-041, FR-042, FR-043)', () => {
    // Exact quoted literals: `'no-workspace'` is a writability refusal and is not a
    // scope, so the match is on the whole string rather than on the word inside it.
    const offenders: string[] = [];
    for (const name of CATALOG_MODULES) {
      const code = codeOf(sourceOf(name));
      for (const literal of SCOPE_LITERALS) {
        for (const quoted of [`'${literal}'`, `"${literal}"`, `\`${literal}\``]) {
          if (code.includes(quoted)) offenders.push(`${name}.ts -> ${quoted}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Feature 099 — nothing the store reaches is impure either', () => {
  const closure = valueImportClosure();

  it('reaches every store module, so the walk is not vacuous', () => {
    const reached = closure.files.map(repoRelative);
    for (const name of CATALOG_MODULES) {
      expect(reached, `${name}.ts must be in the closure`).toContain(`src/catalog/${name}.ts`);
    }
    // The closure is wider than the directory: the contracts the store types
    // against are value imports too.
    expect(closure.files.length).toBeGreaterThan(CATALOG_MODULES.length);
  });

  it('reaches no bare specifier anywhere in the closure (FR-058)', () => {
    const offenders = [...closure.bare].map(([specifier, file]) => `${file} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });

  it('reaches no deleted scope literal anywhere in the closure', () => {
    const offenders: string[] = [];
    for (const file of closure.files) {
      const code = codeOf(file);
      for (const literal of SCOPE_LITERALS) {
        for (const quoted of [`'${literal}'`, `"${literal}"`]) {
          if (code.includes(quoted)) offenders.push(`${repoRelative(file)} -> ${quoted}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
