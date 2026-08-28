// An adapter module nothing in the shipped extension imports is dead code that
// looks like architecture.
//
// Three of them shipped that way and are now deleted. `src/host-services/`
// carried a nine-member `HostServices` facade — `types.ts`, `index.ts` and
// `vscode-host-services.ts`, 226 lines — covering configuration, storage,
// notifications, commands, trust, lifecycle and scheduling. `ARCHITECTURE.md`
// named the directory as the wrapper around host-owned behaviour, so someone
// hardening a host seam found the facade and reasonably concluded the seam
// existed. It did not: `src/activation/` resolved every one of those facilities
// directly, two members (`state.global`, `files.revealFileInOS`) had no caller at
// either end, and the facade's `scheduler` default was a no-op returning
// `{ registered: false }` while the real scheduler was `ScheduledStartCoordinator`
// with an unrelated interface. Two composition models were documented; one ran.
//
// Nothing in the suite could say so. `tsc` does not report an unreferenced
// module, lint has no opinion about who imports one, and the facade's own unit
// test was green — every assertion in it was about a mock reaching a mock.
//
// WHY TESTS ARE NOT CONSUMERS. That green test is the whole reason this gate
// excludes `tests/`. The facade's only consumer was its own unit test, so a
// reachability check that counted tests would have passed on the exact defect it
// exists to catch. `scripts/` is excluded on the same principle one step out: a
// module reached only by a build script is tooling, not shipped code.
//
// WHY REACHEDNESS IS A FIXED POINT AND NOT ONE PASS. Measured on the tree before
// the deletion, all three dead modules read as reached under a plain
// outside-consumer rule, because each named the others' symbols — the barrel
// re-exported the types and the implementation imported them. Three dead modules
// formed a cycle that certified itself. So the set is seeded from modules a
// production file *outside* the directory consumes, and grown inward from there.
//
// WHAT THIS GATE IS HONESTLY WORTH TODAY. `src/host-services/` now holds one
// module, `catalog-fs-adapter.ts`, and that module is also this gate's positive
// control. An empty offender set over a set of size one is close to guaranteed by
// construction, so B1's floors constrain very little and the control is not
// independent of the scanned set. The liveness evidence is the fixture tier
// below, which builds synthetic trees and asserts both directions of both rules.
// The value of the real-tree half is prospective: it fails the day someone lands
// the next facade, not today. Said plainly here rather than left for a reader to
// work out, because a one-module scan presented as a broad result is the same
// overclaim this gate was filed against.
//
// NOT A LINKER. The scanned list is short, named and deliberate. It is
// `src/host-services/` alone. `src/headless/` was the other candidate and is
// excluded on measurement: three of its five modules have no consumer in this
// repository *by design*, because `ARCHITECTURE.md` makes them VS Code-independent
// public adapters for callers outside it. Including it would mean three standing
// exemptions on the day the gate landed and a majority-exempted gate. The
// question this gate asks is the wrong question for that directory, and the
// honest response to a wrong question is not to allowlist the answer.
//
// FR-R3-139 (FR-007, FR-007a, FR-008, FR-008a, FR-009, FR-010, FR-011, FR-011a).

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The adapter/facade directories this gate adjudicates, relative to the tree
 * root. Widening the list is a deliberate edit, per the header.
 */
const SCANNED_DIRS: readonly string[] = ['src/host-services'];

/**
 * Trees searched for consumers: what the extension ships. `tests/` and
 * `scripts/` are absent on purpose — see the header. This file is inside
 * `tests/`, so it is excluded from the corpus automatically, which matters
 * because the header names `HostServices` and `createVSCodeHostServices` and a
 * token scan cannot tell a citation from a use.
 */
const CORPUS_DIRS: readonly string[] = ['src', 'webview-ui/src'];

const CORPUS_EXTENSIONS = /\.(ts|mts|mjs|svelte)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.svelte-kit']);

/**
 * A module known to be production-reached, and reached *directly*: B2 asserts it
 * is in the seed set rather than merely in the closure. The stronger claim on
 * purpose — an export extractor that silently matched nothing, or a corpus walk
 * that collected no files, would otherwise report every module as unreached and
 * fail loudly, but a closure bug that quietly reached everything would not.
 */
const CONTROL_MODULE = 'src/host-services/catalog-fs-adapter.ts';

/**
 * Path to the reason it has no production consumer. A map rather than a set so
 * the reason is a value the failure message can print.
 *
 * It is **empty**, and empty is the healthy state. C1 fails once an entry names a
 * file that is gone and C2 fails once an entry's module acquires a consumer, so
 * an entry cannot rot into a standing excuse that the next genuinely dead module
 * inherits by precedent. Both self-cleaning directions are exercised on fixture
 * trees in D, because over an empty map both assertions are trivially true.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>();

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

/**
 * Top-level exported identifiers, by declaration form and by re-export clause.
 * Lifted from `contracts-module-reachability.test.ts`, which this gate is a
 * sibling of; a module passes on any one surviving symbol, because a barrel that
 * renames an export on the way out would otherwise make the original name look
 * unreferenced while the module is plainly alive.
 */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const declaration =
    /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  // Destructuring with a default rather than indexing, and `exec` rather than
  // `split`, throughout: an index read costs a `noUncheckedIndexedAccess`
  // diagnostic against `compiler-strictness-ratchet`, and guarding that read
  // costs a `no-unnecessary-condition` against the lint baseline, because the
  // lint pass does not run with that flag. Both baselines refuse growth, so the
  // shape that reads nothing by index is the only one that owes neither.
  for (const [, declared = ''] of source.matchAll(declaration)) {
    if (declared) names.add(declared);
  }

  for (const [, body = ''] of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of body.split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      // `A as B` leaves as `B`; a bare `A` leaves as itself.
      const aliased = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
      const name = (aliased?.[1] ?? spec).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  return names;
}

interface Analysis {
  /** Scanned modules, repo-relative, sorted. */
  readonly modules: readonly string[];
  /** Reached directly by a production file outside the scanned directories. */
  readonly seed: ReadonlySet<string>;
  /** The least fixed point: `seed`, closed under consumption by a reached module. */
  readonly reached: ReadonlySet<string>;
  /** Scanned modules not in `reached`. Allowlist not yet applied. */
  readonly unreached: readonly string[];
  /** Production files searched for consumers. */
  readonly corpusCount: number;
  /** Distinct identifiers exported by the scanned modules. */
  readonly symbolCount: number;
}

/**
 * The whole rule, as a function of a tree root so the fixture tier can run it
 * over trees it builds. Pure with respect to the filesystem: it reads, never
 * writes.
 */
function analyze(root: string, scanned: readonly string[], corpusDirs: readonly string[]): Analysis {
  const scannedAbs = scanned.map((dir) => resolve(root, dir));
  // Separator-aware, not a bare prefix test: `src/host-services-legacy/` starts
  // with `src/host-services` and is a different directory. A bare `startsWith`
  // would quietly drop every file in it from the corpus, so a module here could
  // read as unreached while a real consumer sat next door.
  const inScanned = (path: string): boolean =>
    scannedAbs.some((dir) => path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`));

  const modulePaths = scannedAbs
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    .flatMap((dir) => walk(dir, (path) => path.endsWith('.ts')))
    .sort();

  const rel = (path: string): string => relative(root, path).split('\\').join('/');
  const moduleExports = new Map<string, Set<string>>();
  for (const path of modulePaths) {
    moduleExports.set(rel(path), exportedNames(readFileSync(path, 'utf8')));
  }

  const ofInterest = new Set<string>();
  for (const names of moduleExports.values()) for (const name of names) ofInterest.add(name);

  const corpus = corpusDirs
    .map((dir) => resolve(root, dir))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    .flatMap((dir) => walk(dir, (path) => CORPUS_EXTENSIONS.test(path)))
    .filter((path) => !inScanned(path));

  // Identifier -> whether some production file outside the scanned directories
  // mentions it. One pass over the corpus, so the per-module question is a lookup.
  const mentionedOutside = new Set<string>();
  for (const file of corpus) {
    for (const token of readFileSync(file, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (ofInterest.has(token[0])) mentionedOutside.add(token[0]);
    }
  }

  // Identifier -> the scanned modules that mention it, for the closure. A module
  // never counts as mentioning its own exports.
  const mentionedBy = new Map<string, Set<string>>();
  for (const path of modulePaths) {
    const id = rel(path);
    const own = moduleExports.get(id) ?? new Set<string>();
    for (const token of readFileSync(path, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = token[0];
      if (!ofInterest.has(name) || own.has(name)) continue;
      let holders = mentionedBy.get(name);
      if (holders === undefined) mentionedBy.set(name, (holders = new Set()));
      holders.add(id);
    }
  }

  const seed = new Set<string>();
  for (const [id, names] of moduleExports) {
    for (const name of names) {
      if (mentionedOutside.has(name)) {
        seed.add(id);
        break;
      }
    }
  }

  // Least fixed point. Terminates: every round either adds a module or stops, and
  // the module set is finite and small. This is a closure over the scanned
  // directories only, not general link analysis.
  const reached = new Set(seed);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, names] of moduleExports) {
      if (reached.has(id)) continue;
      for (const name of names) {
        const holders = mentionedBy.get(name);
        if (holders === undefined) continue;
        let byReached = false;
        for (const holder of holders) if (reached.has(holder)) byReached = true;
        if (byReached) {
          reached.add(id);
          changed = true;
          break;
        }
      }
    }
  }

  return {
    modules: [...moduleExports.keys()],
    seed,
    reached,
    unreached: [...moduleExports.keys()].filter((id) => !reached.has(id)),
    corpusCount: corpus.length,
    symbolCount: ofInterest.size
  };
}

const live = analyze(REPO_ROOT, SCANNED_DIRS, CORPUS_DIRS);

describe('A: every adapter module has a consumer in the shipped extension', () => {
  it('A1: no adapter module outside the allowlist is unreached', () => {
    const offenders = live.unreached.filter((path) => !ALLOWLIST.has(path));
    expect(
      offenders,
      'Nothing in src/ or webview-ui/src/ references any symbol these modules export, so ' +
        'nothing an installed extension runs can reach them. A test importing one does not ' +
        'count and is the reason this gate exists. Delete each, wire it into the ' +
        'composition root, or add it to ALLOWLIST with a recorded reason:\n' +
        offenders.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });
});

describe('B: the gate proves it scanned', () => {
  it('B1: it collected modules, symbols and a corpus', () => {
    // Every assertion in A compares a set against empty, and an empty scan
    // satisfies all of them. 831 corpus files measured on 2026-08-29; the floor
    // is set well below that so ordinary growth and pruning never touch it.
    expect(live.modules.length, 'no module was found under the scanned directories').toBeGreaterThan(
      0
    );
    expect(live.symbolCount, 'the export extractor matched nothing').toBeGreaterThan(0);
    expect(live.corpusCount, 'the production corpus walk collected nothing').toBeGreaterThan(400);
  });

  it('B2: the positive control is reached, and reached directly', () => {
    expect(live.modules).toContain(CONTROL_MODULE);
    expect(
      live.seed.has(CONTROL_MODULE),
      `${CONTROL_MODULE} is imported by src/activation/catalog-store-wiring.ts. If it is not in ` +
        'the seed set, the export extractor or the corpus walk is broken, and every verdict ' +
        'above is unsound.'
    ).toBe(true);
  });
});

describe('C: the allowlist cleans itself', () => {
  it('C1: every entry still exists on disk', () => {
    const gone = [...ALLOWLIST.keys()].filter((path) => !existsSync(resolve(REPO_ROOT, path)));
    expect(
      gone,
      'These allowlist entries name files that are gone. An exemption that outlives its ' +
        'subject pre-excuses whatever is written at that path next:\n' +
        gone.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('C2: no entry names a module that now has a consumer', () => {
    const stale = [...ALLOWLIST.keys()].filter((path) => live.reached.has(path));
    expect(
      stale,
      'These modules are reached now. Remove their allowlist entries:\n' +
        stale.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });
});

/**
 * D: the rules, exercised on trees this tier builds.
 *
 * Fixtures rather than a physical restore of the deleted files, because the
 * shapes under test no longer exist in this tree — that is the point of the
 * feature — and because a temporary tree lets both directions of both rules be
 * asserted, which a restore cannot do. Nothing is written outside `os.tmpdir()`.
 */
describe('D: the rules bite, measured on synthetic trees', () => {
  const SRC = 'src';
  const ADAPTERS = 'adapters';
  const TESTS = 'tests';
  const ADAPTER_DIR = [SRC, ADAPTERS].join('/');
  const id = (name: string): string => [ADAPTER_DIR, name].join('/');

  interface Plan {
    /** File name under the adapter directory -> its source. */
    readonly adapters: Readonly<Record<string, string>>;
    /** File name under `src/` -> its source. Production corpus. */
    readonly production?: Readonly<Record<string, string>>;
    /** File name under `tests/` -> its source. Outside the corpus by design. */
    readonly probes?: Readonly<Record<string, string>>;
    /**
     * File name under a directory whose name *extends* the adapter directory's
     * — `src/adapters-legacy/`. Production corpus, and the trap D-h pins.
     */
    readonly neighbours?: Readonly<Record<string, string>>;
  }

  function plant(plan: Plan): Analysis {
    const root = mkdtempSync(join(tmpdir(), 'adapter-reach-'));
    mkdirSync(join(root, SRC, ADAPTERS), { recursive: true });
    for (const [name, source] of Object.entries(plan.adapters)) {
      writeFileSync(join(root, SRC, ADAPTERS, name), source);
    }
    for (const [name, source] of Object.entries(plan.production ?? {})) {
      writeFileSync(join(root, SRC, name), source);
    }
    if (plan.probes !== undefined) {
      mkdirSync(join(root, TESTS), { recursive: true });
      for (const [name, source] of Object.entries(plan.probes)) {
        writeFileSync(join(root, TESTS, name), source);
      }
    }
    if (plan.neighbours !== undefined) {
      const neighbour = join(root, SRC, `${ADAPTERS}-legacy`);
      mkdirSync(neighbour, { recursive: true });
      for (const [name, source] of Object.entries(plan.neighbours)) {
        writeFileSync(join(neighbour, name), source);
      }
    }
    return analyze(root, [ADAPTER_DIR], [SRC]);
  }

  it('D-a: a cycle of dead modules does not certify itself', () => {
    // The facade's exact shape: a barrel, a types module and an implementation,
    // each naming the others' symbols, none consumed from outside. Under a plain
    // outside-consumer rule all three read as reached. This is FR-008.
    const analysis = plant({
      adapters: {
        'index.ts': 'export { makeFacade } from "./impl";\nexport type { FacadePorts } from "./types";\n',
        'types.ts': 'export interface FacadePorts { readonly notify: () => void }\n',
        'impl.ts':
          'import type { FacadePorts } from "./types";\nexport function makeFacade(): FacadePorts { return { notify: () => undefined }; }\n'
      }
    });
    expect([...analysis.unreached].sort()).toEqual([id('impl.ts'), id('index.ts'), id('types.ts')]);
  });

  it('D-b: a module consumed only from tests/ is unreached', () => {
    // The defect verbatim. `tests/` is outside CORPUS_DIRS, so the probe below
    // is invisible to the scan however loudly it imports.
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' },
      probes: { 'facade.test.ts': 'import { createFacade } from "../src/adapters/facade";\ncreateFacade();\n' }
    });
    expect(analysis.unreached).toEqual([id('facade.ts')]);
  });

  it('D-c: a module consumed from production is reached, and in the seed', () => {
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' },
      production: {
        'wiring.ts': 'import { createFacade } from "./adapters/facade";\nexport const wired = createFacade();\n'
      }
    });
    expect(analysis.unreached).toEqual([]);
    expect(analysis.seed.has(id('facade.ts'))).toBe(true);
  });

  it('D-d: a module consumed only by a reached sibling is reached, but not seeded', () => {
    // The closure's positive direction, and the reason the rule is a fixed point
    // rather than one pass: `deep.ts` is two hops from production.
    const analysis = plant({
      adapters: {
        'facade.ts':
          'import { helper } from "./deep";\nexport function createFacade(): number { return helper(); }\n',
        'deep.ts': 'export function helper(): number { return 1; }\n'
      },
      production: {
        'wiring.ts': 'import { createFacade } from "./adapters/facade";\nexport const wired = createFacade();\n'
      }
    });
    expect(analysis.unreached).toEqual([]);
    expect(analysis.seed.has(id('facade.ts'))).toBe(true);
    expect(
      analysis.seed.has(id('deep.ts')),
      'deep.ts has no production consumer of its own; it is reached through facade.ts'
    ).toBe(false);
    expect(analysis.reached.has(id('deep.ts'))).toBe(true);
  });

  it('D-e: an allowlisted dead module is not an offender', () => {
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' }
    });
    const allowlist = new Map([[id('facade.ts'), 'awaiting the go-ahead to delete']]);
    expect(analysis.unreached.filter((path) => !allowlist.has(path))).toEqual([]);
  });

  it('D-f: an allowlist entry naming a module that is gone is caught', () => {
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' }
    });
    const allowlist = new Map([[id('deleted-facade.ts'), 'a reason that outlived its subject']]);
    // C1's rule, over a tree where the entry's file was never planted.
    expect([...allowlist.keys()].filter((path) => !analysis.modules.includes(path))).toEqual([
      id('deleted-facade.ts')
    ]);
  });

  it('D-h: a neighbour directory whose name extends the scanned one still counts', () => {
    // Regression pin. The scanned set was excluded from the corpus by a bare
    // `startsWith`, which also swallowed `src/adapters-legacy/`. A module would
    // then read as unreached while its only consumer sat next door — the gate
    // reporting a false offender, which is the failure direction that gets a
    // gate deleted rather than fixed.
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' },
      neighbours: {
        'consumer.ts':
          'import { createFacade } from "../adapters/facade";\nexport const used = createFacade();\n'
      }
    });
    expect(analysis.unreached).toEqual([]);
    expect(analysis.seed.has(id('facade.ts'))).toBe(true);
  });

  it('D-g: an allowlist entry whose module became reached is caught', () => {
    const analysis = plant({
      adapters: { 'facade.ts': 'export function createFacade(): number { return 1; }\n' },
      production: {
        'wiring.ts': 'import { createFacade } from "./adapters/facade";\nexport const wired = createFacade();\n'
      }
    });
    const allowlist = new Map([[id('facade.ts'), 'a reason that outlived its subject']]);
    // C2's rule. The other self-cleaning direction: the file is still there, but
    // the excuse is no longer true.
    expect([...allowlist.keys()].filter((path) => analysis.reached.has(path))).toEqual([
      id('facade.ts')
    ]);
  });
});
