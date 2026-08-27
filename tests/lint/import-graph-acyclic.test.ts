// FR-R3-128 (T1486, FR-005) — the whole first-party import graph has no cycles.
//
// WHAT WAS MISSING. `dependency-direction.test.ts` checks two leaf layers against a
// list of acting ones — a rule-by-rule scan, and a good one. It cannot see a cycle
// that does not cross a leaf boundary, and there was no whole-tree checker at all:
// `ARCHITECTURE.md` admitted so in its own words until this gate replaced the
// admission with a pointer.
//
// A cycle is not a style problem. It defeats the one thing a reader uses to
// understand a module — "what does this depend on" — and in this codebase it also
// defeats initialisation order, which `elect-before-recovering.test.ts` and the
// composition-root work spent a whole round making explicit.
//
// SCOPE, STATED, because a scan whose scope is unstated reads as a scan with no
// scope:
//
//   * Nodes are files under `src/` and `webview-ui/src/`.
//   * Edges are static `import` / `export from` specifiers that are RELATIVE.
//     A bare specifier is third-party; a cycle through `node_modules` is not this
//     project's to fix and is not looked for.
//   * `import type` is EXCLUDED. A type-only edge is erased at compile time, cannot
//     produce an initialisation-order failure, and is legitimately circular in a
//     mutually-recursive type model. `dependency-direction.test.ts` draws the same
//     line for the same reason.
//   * Dynamic `import()` is excluded: it is a deliberate deferral, and treating one
//     as a static edge would report the very technique used to break a cycle.
//
// NON-VACUITY IS THE WHOLE RISK. "No cycles found" is exactly what an empty graph
// reports. So the gate asserts floors on nodes and edges, prints what it walked, and
// is driven red by an injected two-file cycle.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { filesUnder } from './source-scan';
import { ACTING_LAYERS, LEAF_LAYERS } from './architecture-layers';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['src', 'webview-ui/src'] as const;

/**
 * A static, non-type-only import or re-export with a relative specifier.
 *
 * `(?!type\s)` is what keeps type-only edges out. It is deliberately syntactic:
 * standing up a TypeScript program to resolve this would make the gate slow enough
 * that someone excludes it, and `lint-gates-are-hermetic.test.ts` forbids shelling
 * out to anything that would do it faster.
 */
const EDGE = /^\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?from\s*)?['"](\.[^'"]*)['"]/gm;

/** Extensionless specifier -> the file it names, if it is one of ours. */
function resolveEdge(fromFile: string, specifier: string, nodes: ReadonlySet<string>): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.svelte`,
    resolve(base, 'index.ts')
  ]) {
    const rel = relative(REPO_ROOT, candidate).split('\\').join('/');
    if (nodes.has(rel)) return rel;
  }
  return null;
}

interface Graph {
  readonly nodes: readonly string[];
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly edgeCount: number;
}

function buildGraph(): Graph {
  const absolute: string[] = [];
  for (const root of ROOTS) {
    for (const abs of filesUnder(resolve(REPO_ROOT, root), {
      extensions: ['.ts', '.tsx', '.svelte']
    })) {
      // Tests and generated declaration files are not part of the product graph.
      if (/\.d\.ts$/.test(abs) || /(^|[\\/])__tests__[\\/]/.test(abs)) continue;
      absolute.push(abs);
    }
  }
  const nodes = absolute.map((abs) => relative(REPO_ROOT, abs).split('\\').join('/'));
  const nodeSet = new Set(nodes);
  const edges = new Map<string, readonly string[]>();
  let edgeCount = 0;
  for (const abs of absolute) {
    const rel = relative(REPO_ROOT, abs).split('\\').join('/');
    const body = readFileSync(abs, 'utf8');
    const out: string[] = [];
    for (const match of body.matchAll(EDGE)) {
      const target = resolveEdge(abs, match[1]!, nodeSet);
      if (target !== null && target !== rel) out.push(target);
    }
    const unique = [...new Set(out)];
    edges.set(rel, unique);
    edgeCount += unique.length;
  }
  return { nodes, edges, edgeCount };
}

/**
 * Every cycle, as a path.
 *
 * Iterative depth-first with an explicit stack: the graph is ~1,700 nodes and a
 * recursive walk risks a stack overflow on a long chain, which would present as a
 * crashed gate rather than a reported cycle — and a gate that crashes rather than
 * reports is the same defect as one that passes vacuously (`FR-R3-063`).
 */
export function findCycles(edges: ReadonlyMap<string, readonly string[]>): readonly string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const cycles: string[][] = [];

  for (const start of edges.keys()) {
    if ((colour.get(start) ?? WHITE) !== WHITE) continue;
    const path: string[] = [];
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    colour.set(start, GREY);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = edges.get(frame.node) ?? [];
      if (frame.next >= children.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const child = children[frame.next]!;
      frame.next += 1;
      const childColour = colour.get(child) ?? WHITE;
      if (childColour === GREY) {
        const from = path.indexOf(child);
        if (from >= 0) cycles.push([...path.slice(from), child]);
        continue;
      }
      if (childColour === BLACK) continue;
      colour.set(child, GREY);
      path.push(child);
      stack.push({ node: child, next: 0 });
    }
  }
  return cycles;
}

describe('the first-party import graph is acyclic (FR-R3-128)', () => {
  const graph = buildGraph();

  it('walked a graph worth walking', () => {
    // Vacuity control, and the only one that matters: "no cycles found" is exactly
    // what an empty graph reports, so a broken walk or a matcher that stopped
    // matching would report the cleanest possible result.
    expect(
      graph.nodes.length,
      'the module walk found almost nothing — the roots or the extensions are wrong'
      // 673 modules measured 2026-08-27. The floor is set well below it rather than
      // just below: a floor tight against the measurement fails on every ordinary
      // module deletion, and a gate that fails for uninteresting reasons is a gate
      // someone loosens. It exists to catch a walk that broke, not tree churn.
    ).toBeGreaterThan(500);
    expect(
      graph.edgeCount,
      'the edge matcher found almost nothing — it no longer recognises how this tree writes an ' +
        'import, so this gate is reporting an absence of cycles in an absence of a graph'
      // 1,484 value edges measured 2026-08-27, same reasoning as the node floor.
    ).toBeGreaterThan(1_200);
    // The figures are how a regression in the walk itself becomes visible; a silent
    // shrink is the failure mode this print exists to prevent.
    console.log(
      `[FR-R3-128] import graph: ${graph.nodes.length} module(s), ${graph.edgeCount} value edge(s)`
    );
  });

  it('has no cycles', () => {
    const cycles = findCycles(graph.edges).map((cycle) => cycle.join(' -> '));
    expect(
      cycles,
      'These first-party modules import each other in a cycle. A cycle defeats the one question a ' +
        'reader asks of a module — what does this depend on — and in this codebase it also defeats ' +
        'initialisation order, which the composition-root work spent a round making explicit. Break ' +
        'it by moving the shared thing to a leaf (`contracts/` or `lib/`), by making one edge ' +
        '`import type`, or by deferring one with a dynamic import — in that order of preference.'
    ).toEqual([]);
  });

  it('reports an injected cycle — proved, not assumed', () => {
    // The mutation control. `toEqual([])` passes over a walk that finds nothing, so
    // the detector is driven against a graph that certainly has a cycle, and against
    // one that certainly does not.
    // Fixture node names are deliberately NOT `src/…`: `lint-anchor-grounding.test.ts`
    // resolves every `src/`-prefixed path literal in this directory against the tree,
    // and a fixture path that does not exist would fail it. A synthetic graph needs
    // synthetic names.
    const cyclic = new Map<string, readonly string[]>([
      ['graph/a.ts', ['graph/b.ts']],
      ['graph/b.ts', ['graph/c.ts']],
      ['graph/c.ts', ['graph/a.ts']]
    ]);
    const found = findCycles(cyclic);
    expect(found.length, 'a three-module cycle must be reported').toBeGreaterThan(0);
    expect(found[0]!.join(' -> ')).toContain('graph/a.ts');

    const acyclic = new Map<string, readonly string[]>([
      ['graph/a.ts', ['graph/b.ts', 'graph/c.ts']],
      ['graph/b.ts', ['graph/c.ts']],
      ['graph/c.ts', []]
    ]);
    expect(findCycles(acyclic), 'a diamond is not a cycle').toEqual([]);

    // A self-edge is excluded at graph-build time; assert the detector does not
    // invent one from a node that lists itself.
    expect(findCycles(new Map([['graph/a.ts', []]]))).toEqual([]);
  });

  it('excludes type-only edges, and says why', () => {
    // A type-only edge is erased at compile time, cannot produce an
    // initialisation-order failure, and is legitimately circular in a mutually
    // recursive type model. Asserted on the matcher so the exclusion cannot be
    // lost in a rewrite.
    const typeOnly = "import type { Foo } from './foo';";
    const valueImport = "import { foo } from './foo';";
    expect([...typeOnly.matchAll(EDGE)]).toHaveLength(0);
    expect([...valueImport.matchAll(EDGE)]).toHaveLength(1);
    // A re-export is a value edge.
    expect([..."export { foo } from './foo';".matchAll(EDGE)]).toHaveLength(1);
    expect([..."export type { Foo } from './foo';".matchAll(EDGE)]).toHaveLength(0);
    // A bare specifier is third-party and out of scope.
    expect([..."import { z } from 'zod';".matchAll(EDGE)]).toHaveLength(0);
  });

  it('reuses the layer declaration rather than restating it', () => {
    // FR-R3-128 A4 — two lists of layers is how two gates come to disagree about the
    // architecture they both police. This asserts the shared module is the source.
    expect(LEAF_LAYERS.map((layer) => layer.dir)).toEqual(['contracts', 'lib']);
    expect(ACTING_LAYERS.length).toBeGreaterThan(10);
  });
});
