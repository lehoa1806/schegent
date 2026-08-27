import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTING_LAYERS, LEAF_LAYERS } from './architecture-layers';

/**
 * FR-R3-110 (FR-104) — the documented layering, enforced by something.
 *
 * WHY THIS DID NOT EXIST. The codebase enforces well over a hundred *named* invariants through
 * bespoke lint gates, and none of them owned the layering as a layering. The repo admits it has
 * no cycle checker. So `contracts` value-imported `MAX_QUEUES` from `queue`, `state` imported
 * from `controller` and `services`, `PhaseName` was owned by a UI projection module and consumed
 * by `monitor`, and `controller` and `services` value-imported each other. Each edge was
 * individually tolerable; together they are the class *a boundary that exists only in the
 * documentation*.
 *
 * THE RULE, and why it is only about VALUE imports. A type import is erased: it expresses a
 * shared shape and creates no runtime edge, no cycle, and no bundle cost. A value import is a
 * real dependency. Holding types to the layering would forbid the one thing layers legitimately
 * share and would produce a gate people route around with `as unknown as`.
 *
 * THE LAYERS, from the inside out. `contracts` and `lib` are leaves: they describe and they help,
 * and they may not reach for anything that acts. Everything else may reach inward. That is a
 * deliberately weak rule — it is not a full DAG — because a weak rule that is TRUE beats a strong
 * one that has to start life with a page of allowlisted exceptions.
 *
 * IT STARTS TRUE. `FR-R3-110` moved five constants into `contracts/` first
 * (`DEFAULT_QUEUE_ID`, `HISTORY_UNATTRIBUTED_QUEUE_ID`, `MAX_QUEUES`, `PhaseName`, the retry
 * bounds), so this gate lands green rather than landing red with an allowlist. A gate whose first
 * commit is its own exemption list has already lost.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(REPO_ROOT, 'src');

/**
 * Layers that must not VALUE-import anything that acts, and what each is for.
 *
 * Not a full dependency graph. These two are the ones whose inversion was actually observed, and
 * a rule that names what was broken is easier to defend than a rule that names everything.
 */
// FR-R3-128 (T1486) — the two lists moved to `architecture-layers.ts` so
// `import-graph-acyclic.test.ts` reads the same declaration instead of a copy.
// Nothing about them changed.

/**
 * Dated allowlist, each entry with the reason it has not been fixed.
 *
 * Expected to shrink. Every entry is a value import a leaf makes into an acting layer, and every
 * one is a constant or helper that belongs in the leaf.
 */
const ALLOWLIST: ReadonlyArray<{ readonly from: string; readonly into: string; readonly reason: string }> = [
  // FR-R3-128 (T1485) — EMPTY, and both entries were deleted rather than renewed.
  //
  //   * `src/lib/catalog-fs-adapter.ts` -> `src/host-services/catalog-fs-adapter.ts`. The
  //     entry itself said the file was in the wrong directory rather than making a
  //     wrong import, and it was right: an adapter FOR the catalog is catalog code.
  //   * `MODEL_ID_MAX_LEN` moved from `services/process-yaml/types.ts` into
  //     `contracts/pipeline-definitions.ts`, beside `PIPELINE_ID_MAX_LEN`. The entry
  //     said a bound is contract-shaped; it is. Moved, not copied.
  //
  // An exception list is a QUEUE, not a state. Keeping it empty is the point, and
  // the truthfulness assertion below is what makes an entry that outlives its
  // inversion fail rather than linger — which is how these two came to be deleted:
  // the gate reported them stale within seconds of the moves.
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Edge {
  readonly from: string;
  readonly line: number;
  readonly into: string;
}

/** Every VALUE import a leaf layer makes into an acting layer. */
function inversions(): readonly Edge[] {
  const found: Edge[] = [];
  for (const layer of LEAF_LAYERS) {
    const dir = join(SRC, layer.dir);
    for (const file of tsFiles(dir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // A VALUE import: `import {...} from` or `import x from`, but not `import type`.
        const match = /^\s*import\s+(?!type\s)([^;]*?)from\s+'((?:\.\.\/)+)([a-z-]+)\//.exec(line);
        if (match === null) return;
        // A line whose every binding is `type`-prefixed is also erased.
        const bindings = match[1] as string;
        if (/\{[^}]*\}/.test(bindings) && !/\{\s*[^}]*[^,{\s]/.test(bindings.replace(/type\s+\w+/g, ''))) {
          return;
        }
        const target = match[3] as string;
        if (!(ACTING_LAYERS as readonly string[]).includes(target)) return;
        found.push({ from: relative(REPO_ROOT, file), line: index + 1, into: target });
      });
    }
  }
  return found;
}

describe('FR-R3-110 — leaf layers do not value-import layers that act', () => {
  it('scanned both leaf layers, and found imports in them', () => {
    // The floor: an empty scan would make every assertion below pass over nothing.
    for (const layer of LEAF_LAYERS) {
      const files = tsFiles(join(SRC, layer.dir));
      expect(files.length, `src/${layer.dir} must contain sources`).toBeGreaterThan(2);
    }
  });

  it('every inversion is on the dated allowlist, with a reason', () => {
    const allowed = new Set(ALLOWLIST.map((entry) => `${entry.from}->${entry.into}`));
    const offenders = inversions()
      .filter((edge) => !allowed.has(`${edge.from}->${edge.into}`))
      .map((edge) => `${edge.from}:${edge.line} -> src/${edge.into}/`);
    expect(
      offenders,
      'A leaf layer (contracts, lib) VALUE-imports a layer that acts. A module needing a shape ' +
        'should import it as a type; a module needing a constant should find it in contracts. ' +
        'Moving the constant is usually the fix — FR-R3-110 moved five that way so this gate ' +
        'could start true.'
    ).toEqual([]);
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.from} is allowlisted without a real reason`).toBeGreaterThan(80);
      expect(entry.reason, `${entry.from}'s reason must carry a date`).toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  it('the allowlist is truthful: every entry is a real, current inversion', () => {
    // An escape hatch nobody checks becomes the way to exempt anything, and a stale entry is a
    // hole nothing needs. Both directions are the point of an allowlist that shrinks.
    const actual = new Set(inversions().map((edge) => `${edge.from}->${edge.into}`));
    const stale = ALLOWLIST.filter((entry) => !actual.has(`${entry.from}->${entry.into}`)).map(
      (entry) => `${entry.from} -> ${entry.into}`
    );
    expect(stale, 'an allowlist entry no longer corresponds to a real import; remove it').toEqual([]);
  });

  it('the five constants FR-R3-110 moved are reachable from contracts', () => {
    // The gate starts true BECAUSE these moved. Asserted so a later revert shows up here rather
    // than as a mysterious allowlist growth.
    const contracts = tsFiles(join(SRC, 'contracts')).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const name of [
      'DEFAULT_QUEUE_ID',
      'HISTORY_UNATTRIBUTED_QUEUE_ID',
      'MAX_QUEUES',
      'PhaseName',
      'RATE_LIMIT_BACKOFF_MS'
    ]) {
      expect(contracts, `${name} must be declared in src/contracts/`).toContain(name);
    }
  });

  it('NON-VACUITY: a backwards value import is detected, and a type import is not', () => {
    const detector = /^\s*import\s+(?!type\s)([^;]*?)from\s+'((?:\.\.\/)+)([a-z-]+)\//;
    expect(detector.test("import { thing } from '../state/workspace-state';")).toBe(true);
    expect(detector.test("import type { Thing } from '../state/workspace-state';")).toBe(false);
    // ...and the acting-layer list is what decides, so a leaf importing another leaf is fine.
    const inner = detector.exec("import { helper } from '../lib/errors';");
    expect(inner).not.toBeNull();
    expect((ACTING_LAYERS as readonly string[]).includes((inner as RegExpExecArray)[3] as string)).toBe(
      false
    );
  });
});
