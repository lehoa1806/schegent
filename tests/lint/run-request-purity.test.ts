// Feature 087 T033 — request validation is host-free and network-free.
//
// Two claims, both checked statically rather than by observing a run, because
// "validation needs no host and touches no network" is a property of what the
// code can reach, not of what one test happened to exercise:
//
//   1. Nothing under `src/services/run-request/` imports `vscode`, directly or
//      through its value-import closure. Validation runs before enqueue, but it
//      is also what a headless path would have to call to decide whether a
//      request is runnable; a host import makes that impossible and is the kind
//      of thing added innocently, to show a dialog from inside a validator.
//   2. Nothing in that closure reaches a network-capable module or a network
//      global. FR-019 says a URL input is checked for shape and scheme and is
//      never fetched — the unit test pins that with a `fetch` spy on one call
//      path, and this pins it for every call path, including the one someone
//      adds later to "just check the link resolves".
//
// Type-only imports are excluded from the closure because they are erased; they
// cannot reach the host or open a socket at run time.
//
// Modelled on `process-yaml-purity.test.ts`, including its T070 lesson: the
// directory IS the list. A hand-maintained roster of pure modules cannot notice
// an impure one it does not name, and the omission makes the lint quieter rather
// than louder — the worst failure mode a purity check has.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RUN_REQUEST_DIR = resolve(REPO_ROOT, 'src', 'services', 'run-request');

const RUN_REQUEST_MODULES: readonly string[] = readdirSync(RUN_REQUEST_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

/** The modules the plan's file layout names. Present in every later revision. */
const ANCHORS = [
  'local-input-validator',
  'output-reference-resolver',
  'output-target-validator',
  'run-request-validator',
  'workspace-containment'
] as const;

/** Modules that can open a socket, by any of their spellings. */
const NETWORK_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'ws',
  'socket.io',
  'socket.io-client',
  'grpc',
  '@grpc/grpc-js'
] as const;

/** Globals that reach the network without an import. */
const NETWORK_GLOBALS = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator.send'] as const;

interface Import {
  /** The module specifier as written. */
  readonly specifier: string;
  /** True when the import is erased at compile time. */
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
    // `import { type A, type B } from '…'` is erased too, even without the
    // leading keyword.
    const everyBindingTyped = bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '));
    found.push({ specifier: match[3]!, typeOnly: keyword || everyBindingTyped });
  }
  return found;
}

function sourceOf(name: string): string {
  return resolve(RUN_REQUEST_DIR, `${name}.ts`);
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file);
}

/** Every file reachable from the run-request modules through value imports. */
function valueImportClosure(): { readonly files: readonly string[]; readonly bare: ReadonlyMap<string, string> } {
  const visited = new Set<string>();
  const bare = new Map<string, string>();
  const pending = RUN_REQUEST_MODULES.map(sourceOf);

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
      const target = resolve(dirname(file), `${entry.specifier}.ts`);
      // A specifier this walk cannot resolve would silently shrink the closure,
      // so it fails the scan rather than being skipped.
      expect(existsSync(target), `${repoRelative(file)} imports unresolvable ${entry.specifier}`).toBe(true);
      pending.push(target);
    }
  }

  return { files: [...visited], bare };
}

/** `node:fs` and `fs` name the same module; compare on the bare name. */
function moduleName(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

describe('Feature 087 — request validation imports no host API (T033)', () => {
  it('scans every module in the directory, and found the ones the plan named', () => {
    // The guard on the discovery above. Without it, a directory rename would
    // empty the list and turn every assertion below trivially true.
    for (const anchor of ANCHORS) {
      expect(RUN_REQUEST_MODULES, `${anchor}.ts must be discovered`).toContain(anchor);
    }
    for (const name of RUN_REQUEST_MODULES) {
      expect(existsSync(sourceOf(name)), `${name}.ts must resolve`).toBe(true);
    }
  });

  it('imports no vscode from any run-request module', () => {
    const offenders: string[] = [];
    for (const name of RUN_REQUEST_MODULES) {
      for (const entry of importsOf(readFileSync(sourceOf(name), 'utf8'))) {
        if (moduleName(entry.specifier) === 'vscode') offenders.push(`${name}.ts -> ${entry.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no network global in any run-request module (FR-019)', () => {
    const offenders: string[] = [];
    for (const name of RUN_REQUEST_MODULES) {
      const text = readFileSync(sourceOf(name), 'utf8');
      for (const global of NETWORK_GLOBALS) {
        if (text.includes(global)) offenders.push(`${name}.ts -> ${global}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Feature 087 — validating a request needs no host and no network', () => {
  const closure = valueImportClosure();

  it('reaches every run-request module, so the walk is not vacuous', () => {
    const reached = closure.files.map(repoRelative);
    for (const name of RUN_REQUEST_MODULES) {
      expect(reached, `${name}.ts must be in the closure`).toContain(`src/services/run-request/${name}.ts`);
    }
  });

  it('reaches no host API, not even transitively', () => {
    const offenders = [...closure.bare]
      .filter(([specifier]) => moduleName(specifier) === 'vscode')
      .map(([specifier, file]) => `${file} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });

  it('reaches no network-capable module (FR-019)', () => {
    const denied = new Set<string>(NETWORK_MODULES);
    const offenders = [...closure.bare]
      .filter(([specifier]) => denied.has(moduleName(specifier)))
      .map(([specifier, file]) => `${file} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });
});
