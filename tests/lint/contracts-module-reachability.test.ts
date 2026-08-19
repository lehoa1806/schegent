// A contract module nothing imports is dead code that looks like a contract.
//
// Two of them shipped that way, and both are now deleted. `webview-snapshots.ts`
// carried an `ActiveRunPayload` that was a stale twin of the live
// `InFlightRunProjection`, and `correlation.ts` carried a
// `CORRELATION_ID_LENGTH = 36` that disagreed with the live
// `CORRELATION_ID_MAX = 64` in `validators/shared.ts`. Both type-checked, both
// linted, both were re-exported from the barrel, and neither had a single
// consumer. Nothing in the suite could say so: `contracts:check` only regenerates
// schemas from the six files the generator names, `tsc` does not report an
// unreferenced module, and lint has no opinion about whether anything imports one.
//
// That is the trap this exists to close. A dead contract is worse than dead code,
// because the next person hardening a boundary finds it, believes it describes
// the rule in force, and writes the stricter thing it implies.
//
// Deadness is judged per module, by symbol. For every module under
// `src/contracts/` the exported identifiers are collected, and the module passes
// if *any* of them appears anywhere outside itself and the barrel. Per module
// rather than per symbol on purpose: the barrel renames some exports on the way
// out (`InvocationRequest as BackendInvocationRequest`), so a consumer using only
// the alias would make the original name look unreferenced while the module is
// plainly alive. One surviving symbol is enough to prove a module is reached.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACTS = resolve(REPO_ROOT, 'src', 'contracts');

/**
 * The barrel, excluded from the corpus. It is almost entirely `export *`, so
 * counting it as a consumer would make every module in the directory look
 * reached — which is precisely how both dead files survived.
 */
const BARREL = resolve(CONTRACTS, 'index.ts');

/**
 * `src/contracts/generated/` is excluded from both the module list and the
 * corpus. It is `contracts:generate` output derived from the generator inputs
 * below, so a symbol appearing only there is circular evidence: the module would
 * be justifying itself through a file written from it.
 */
const GENERATED = resolve(CONTRACTS, 'generated');

/**
 * This file, excluded from the corpus. It has to name the symbols it adjudicates
 * — an allowlist reason that cannot say `CORRELATION_ID_LENGTH` is not much of a
 * reason — and a token scan cannot tell a citation from a use. Counting the
 * adjudicator as evidence made `correlation.ts` read as reached on the first run
 * of this check, excused by the very entry recording that it was dead. The
 * exclusion outlives that entry: it is what lets the header above keep naming the
 * two deleted modules and their stale-twin constants without a future module
 * reusing one of those names reading as reached on the strength of a comment.
 */
const SELF = resolve(__dirname, 'contracts-module-reachability.test.ts');

/** Trees searched for consumers. */
const CORPUS_ROOTS: readonly string[] = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'tests'),
  resolve(REPO_ROOT, 'scripts'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
];

const CORPUS_EXTENSIONS = /\.(ts|mts|mjs|svelte)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.svelte-kit']);

/**
 * The `contracts:generate` inputs that live in this directory, per
 * `scripts/generate-contract-schemas.mjs`. Allowlisting one of these would be
 * incoherent: `contracts:check` regenerates the shipped schemas from them, so
 * they are load-bearing by definition and cannot be excused as unreached.
 */
const MUST_NOT_BE_ALLOWLISTED: readonly string[] = [
  'src/contracts/audit-events.ts',
  'src/contracts/backend-runner.ts',
  'src/contracts/queue-snapshot.ts',
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/state-schema.ts'
];

/**
 * Path to the reason it has no consumer. A map rather than a set so the reason is
 * a value the failure message can print; a comment would be invisible at exactly
 * the moment someone needs it.
 *
 * Shrinking is the expected direction of travel. A2 fails once an entry names a
 * file that is gone, so completing a deletion means removing its entry too, and
 * A3 fails once an entry's module acquires a consumer, so an entry cannot rot
 * into a stale excuse that the next genuinely dead module inherits.
 *
 * It is **empty**, and empty is the healthy state rather than a sign the
 * mechanism is unwired — A1 is what proves the scan still runs, and A4's positive
 * control is what proves it runs on real data. Its one entry excused
 * `correlation.ts` while that deletion awaited a go-ahead; the go-ahead came on
 * 2026-08-19 and A2 required the entry to go with the file.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * A live module whose symbols must be found. The positive control: an extractor
 * that silently matches nothing, or a corpus walk that collects no files, would
 * otherwise report every module as reached and pass vacuously.
 */
const CONTROL_MODULE = 'src/contracts/validators/shared.ts';

function walk(directory: string, predicate: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(full, predicate));
      continue;
    }
    if (entry.isFile() && predicate(full)) found.push(full);
  }
  return found;
}

/** Top-level exported identifiers, by declaration form and by re-export clause. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const declaration =
    /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) names.add(match[1]);

  // `export { A, B as C }` and `export type { A as B } from '…'` — the name that
  // leaves the module is the alias when one is present.
  for (const clause of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of clause[1].split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      const alias = spec.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  return names;
}

const modules = walk(
  CONTRACTS,
  (path) => path.endsWith('.ts') && path !== BARREL && !path.startsWith(GENERATED)
);

const moduleExports = new Map<string, Set<string>>();
for (const path of modules) moduleExports.set(path, exportedNames(readFileSync(path, 'utf8')));

/** Every identifier any contracts module exports — the only tokens worth tracking. */
const OF_INTEREST = new Set<string>();
for (const names of moduleExports.values()) for (const name of names) OF_INTEREST.add(name);

/**
 * Identifier -> the files it appears in, restricted to `OF_INTEREST`. One pass
 * over the corpus, so the per-module question is a set lookup rather than a
 * re-scan.
 */
const appearsIn = new Map<string, Set<string>>();
const corpus = CORPUS_ROOTS.filter((root) => existsSync(root) && statSync(root).isDirectory()).flatMap(
  (root) => walk(root, (path) => CORPUS_EXTENSIONS.test(path) && !path.startsWith(GENERATED))
);
for (const file of corpus) {
  if (file === BARREL || file === SELF) continue;
  for (const token of readFileSync(file, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = token[0];
    if (!OF_INTEREST.has(name)) continue;
    let files = appearsIn.get(name);
    if (files === undefined) appearsIn.set(name, (files = new Set()));
    files.add(file);
  }
}

const rel = (path: string): string => relative(REPO_ROOT, path).split('\\').join('/');

/** A module is reached when one exported symbol appears in some other file. */
function isReached(path: string): boolean {
  for (const name of moduleExports.get(path) ?? []) {
    for (const file of appearsIn.get(name) ?? []) if (file !== path) return true;
  }
  return false;
}

const unreached = modules.filter((path) => !isReached(path)).map(rel);

describe('every contract module has a consumer outside itself and the barrel', () => {
  it('A1: no contract module outside the allowlist is unreached', () => {
    const offenders = unreached.filter((path) => !ALLOWLIST.has(path));
    expect(
      offenders,
      `Nothing outside these modules and src/contracts/index.ts references any symbol ` +
        `they export, so the barrel re-export is their only consumer. Delete each one, ` +
        `wire it in, or add it to ALLOWLIST with a recorded reason:\n` +
        offenders.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A2: every allowlist entry still exists on disk', () => {
    const missing = [...ALLOWLIST.keys()].filter((path) => !existsSync(resolve(REPO_ROOT, path)));
    expect(
      missing,
      `These allowlist entries name files that no longer exist. The deletion they ` +
        `excused has happened; remove the entries:\n` + missing.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A3: every allowlist entry is still unreached', () => {
    // The insidious direction: a module acquired a consumer while its entry
    // stayed, so the entry excuses nothing and the next dead module inherits it.
    const nowReached = [...ALLOWLIST.keys()].filter((path) => !unreached.includes(path));
    expect(
      nowReached,
      `These modules now have consumers, so their allowlist entries excuse nothing. ` +
        `Remove them from ALLOWLIST:\n` +
        nowReached.map((path) => `  - ${path} (${ALLOWLIST.get(path)})`).join('\n')
    ).toEqual([]);
  });

  it('A4: the scan collected modules, exports, and a corpus', () => {
    // Each half fails a different way of passing vacuously: no modules, no
    // extracted symbols, or no corpus files all make every module look reached.
    expect(modules.length).toBeGreaterThan(0);
    expect(OF_INTEREST.size).toBeGreaterThan(0);
    expect(corpus.length).toBeGreaterThan(0);

    const control = resolve(REPO_ROOT, CONTROL_MODULE);
    expect(
      moduleExports.get(control)?.size ?? 0,
      `${CONTROL_MODULE} exports nothing according to the extractor, which means the ` +
        `extractor stopped recognising a declaration form.`
    ).toBeGreaterThan(0);
    expect(
      isReached(control),
      `${CONTROL_MODULE} is consumed by runtime-validators.ts. If it reads as ` +
        `unreached, the corpus walk or the token scan is broken.`
    ).toBe(true);
  });

  it('A5: no contracts:generate input is allowlisted', () => {
    const excused = MUST_NOT_BE_ALLOWLISTED.filter((path) => ALLOWLIST.has(path));
    expect(
      excused,
      `contracts:check regenerates the shipped schemas from these, so they are ` +
        `load-bearing and cannot be excused as unreached:\n` +
        excused.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A6: every contracts:generate input actually exists', () => {
    // Guards the list above against the same rot it is meant to prevent: a
    // renamed generator input would silently stop being protected.
    const missing = MUST_NOT_BE_ALLOWLISTED.filter(
      (path) => !existsSync(resolve(REPO_ROOT, path))
    );
    expect(missing, `Update MUST_NOT_BE_ALLOWLISTED:\n${missing.join('\n')}`).toEqual([]);
  });
});
