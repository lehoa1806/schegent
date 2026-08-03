// Feature 084 T050 (FR-051) and T065 — the exchange path is pure.
//
// Two claims, both checked statically rather than by observing a run, because
// "no network access is required" is a property of what the code can reach, not
// of what one test happened to exercise:
//
//   1. The modules under `src/services/process-yaml/` import nothing but each
//      other and the repo's own contracts — no third-party package, no Node
//      built-in, no host API. That is the lint for "never add a general YAML
//      parser to the exchange path": a dependency on `yaml`, `js-yaml`, or
//      anything else would fail here before it could widen the accepted
//      language.
//   2. Nothing in the transitive **value**-import closure of those modules
//      reaches a network-capable module or `vscode`. Type-only imports are
//      excluded because they are erased; they cannot make a request or touch the
//      host at run time.
//
// The closure is 20-odd files rather than 8: `phase-yaml-validator` takes
// `SUPPORTED_BACKENDS` as a value from the runner factory, which pulls the
// runner CLIs in behind it. That reach is pre-existing and non-network — it
// brings `child_process`, `fs/promises`, and `zlib` — and the denylist below is
// what keeps it from ever bringing a socket. The set of reached built-ins is
// deliberately not pinned exactly, so unrelated runner work does not fail this
// file; the two claims above are what it exists to defend.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXCHANGE_DIR = resolve(REPO_ROOT, 'src', 'services', 'process-yaml');

const EXCHANGE_MODULES = [
  'import-planner',
  'phase-yaml-mapper',
  'phase-yaml-validator',
  'scalar-style',
  'types',
  'yaml-parser',
  'yaml-scanner',
  'yaml-serializer'
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
  return resolve(EXCHANGE_DIR, `${name}.ts`);
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file);
}

/** Every file reachable from the exchange modules through value imports. */
function valueImportClosure(): { readonly files: readonly string[]; readonly bare: ReadonlyMap<string, string> } {
  const visited = new Set<string>();
  const bare = new Map<string, string>();
  const pending = EXCHANGE_MODULES.map(sourceOf);

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

describe('Feature 084 — the Phase exchange path depends on nothing but itself', () => {
  it('imports no package and no built-in from any exchange module (FR-051, FR-003)', () => {
    const offenders: string[] = [];
    for (const name of EXCHANGE_MODULES) {
      for (const entry of importsOf(readFileSync(sourceOf(name), 'utf8'))) {
        if (!entry.specifier.startsWith('.')) offenders.push(`${name}.ts -> ${entry.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no network global in any exchange module (FR-051)', () => {
    const offenders: string[] = [];
    for (const name of EXCHANGE_MODULES) {
      const text = readFileSync(sourceOf(name), 'utf8');
      for (const global of NETWORK_GLOBALS) {
        if (text.includes(global)) offenders.push(`${name}.ts -> ${global}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports no vscode from any exchange module (T065)', () => {
    const offenders: string[] = [];
    for (const name of EXCHANGE_MODULES) {
      for (const entry of importsOf(readFileSync(sourceOf(name), 'utf8'))) {
        if (moduleName(entry.specifier) === 'vscode') offenders.push(`${name}.ts -> ${entry.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Feature 084 — reading, parsing, and validating a document needs no network', () => {
  const closure = valueImportClosure();

  it('reaches every exchange module, so the walk is not vacuous', () => {
    const reached = closure.files.map(repoRelative);
    for (const name of EXCHANGE_MODULES) {
      expect(reached, `${name}.ts must be in the closure`).toContain(`src/services/process-yaml/${name}.ts`);
    }
  });

  it('reaches no network-capable module (FR-051, T050)', () => {
    const denied = new Set<string>(NETWORK_MODULES);
    const offenders = [...closure.bare]
      .filter(([specifier]) => denied.has(moduleName(specifier)))
      .map(([specifier, file]) => `${file} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });

  it('reaches no host API, not even transitively (T065)', () => {
    const offenders = [...closure.bare]
      .filter(([specifier]) => moduleName(specifier) === 'vscode')
      .map(([specifier, file]) => `${file} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });
});
