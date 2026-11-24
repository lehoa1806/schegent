// FR-R3-128 (T1486, FR-005) & FR-R8-04 (`04-03`) — the whole first-party import
// graph has no static value cycles, including `.js`/`.jsx`/`.cjs`/`.mjs`
// specifiers backed by TypeScript sources, re-exports, and Svelte `<script>`
// blocks, while keeping type-only and dynamic lazy `import()` edges explicitly
// distinguished and counted.
//
// SCOPE, STATED:
//   * Nodes are non-test `.ts`, `.tsx`, `.cts`, `.mts`, and `.svelte` files
//     under `src/` and `webview-ui/src/`.
//   * Edges are relative static value `import`, `export ... from`, `import =
//     require(...)`, and literal `require(...)` specifiers parsed with the
//     TypeScript AST (`ts.createSourceFile`, extracting `<script>` blocks from
//     `.svelte` files).
//   * Emitted JS specifiers (`.js` -> `.ts`/`.tsx`, `.jsx` -> `.tsx`, `.cjs`
//     -> `.cts`, `.mjs` -> `.mts`) resolve to their backing TypeScript sources.
//   * Type-only edges (`import type`, `export type`, all-`type` named clauses)
//     are distinguished and excluded from the runtime cycle graph.
//   * Dynamic `import(...)` edges (such as lazy dashboard routes) are
//     distinguished and excluded from the static cycle graph.
//
// NON-VACUITY: asserts floors on nodes and value edges, publishes exact
// candidate graph counts, and proves detection of both an ordinary two-file
// cycle and a cycle crossing `.js` -> `.ts` resolution (plus Svelte scripts).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';

import { filesUnder } from './source-scan';
import { ACTING_LAYERS, LEAF_LAYERS } from './architecture-layers';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['src', 'webview-ui/src'] as const;

export interface ExtractedSpecifiers {
  readonly value: readonly string[];
  readonly typeOnly: readonly string[];
  readonly dynamicLazy: readonly string[];
}

const SVELTE_SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/** Extract script text(s) from `.svelte` files, or return TS/TSX source as-is. */
function scriptBlocksForFile(filePath: string, body: string): readonly string[] {
  if (!filePath.endsWith('.svelte')) return [body];
  const blocks: string[] = [];
  for (const match of body.matchAll(SVELTE_SCRIPT_BLOCK)) {
    const content = match.at(1);
    if (content !== undefined) blocks.push(content);
  }
  return blocks;
}

/**
 * Parse one file's relative specifiers via the TypeScript AST (`ts.createSourceFile`),
 * distinguishing static value edges, type-only edges, and dynamic lazy `import()` edges.
 */
export function extractModuleSpecifiers(body: string, filePath: string): ExtractedSpecifiers {
  const value: string[] = [];
  const typeOnly: string[] = [];
  const dynamicLazy: string[] = [];
  const scriptKind =
    filePath.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : filePath.endsWith('.svelte')
        ? ts.ScriptKind.TS
        : undefined;

  for (const block of scriptBlocksForFile(filePath, body)) {
    const sf = ts.createSourceFile(filePath, block, ts.ScriptTarget.Latest, false, scriptKind);

    const visit = (node: ts.Node): void => {
      if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference;
        if (ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) {
          const spec = ref.expression.text;
          if (spec.startsWith('.')) {
            if (node.isTypeOnly) typeOnly.push(spec);
            else value.push(spec);
          }
        }
        return;
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          const clause = node.importClause;
          if (clause === undefined) {
            value.push(spec);
          } else if (clause.isTypeOnly) {
            typeOnly.push(spec);
          } else {
            const isAllTypeNamed =
              clause.name === undefined &&
              clause.namedBindings !== undefined &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((el) => el.isTypeOnly);
            if (isAllTypeNamed) typeOnly.push(spec);
            else value.push(spec);
          }
        }
        return;
      }

      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          if (node.isTypeOnly) {
            typeOnly.push(spec);
          } else {
            const isAllTypeNamed =
              node.exportClause !== undefined &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.length > 0 &&
              node.exportClause.elements.every((el) => el.isTypeOnly);
            if (isAllTypeNamed) typeOnly.push(spec);
            else value.push(spec);
          }
        }
        return;
      }

      if (ts.isCallExpression(node)) {
        const firstArg = node.arguments.at(0);
        if (firstArg !== undefined && ts.isStringLiteralLike(firstArg) && firstArg.text.startsWith('.')) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            dynamicLazy.push(firstArg.text);
          } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
            value.push(firstArg.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);
  }

  return { value, typeOnly, dynamicLazy };
}

export interface ResolvedEdge {
  readonly target: string;
  readonly resolvedViaEmittedJs: boolean;
}

/** Resolve a relative specifier (including `.js`/`.jsx`/`.cjs`/`.mjs` -> TS) against known graph nodes. */
export function resolveRelativeNode(
  fromRelPath: string,
  specifier: string,
  nodes: ReadonlySet<string>
): ResolvedEdge | null {
  const fromAbs = resolve(REPO_ROOT, fromRelPath);
  const base = resolve(dirname(fromAbs), specifier);
  const ext = extname(base);
  const stem = ext.length > 0 ? base.slice(0, -ext.length) : base;

  const emittedTargets = new Map<string, readonly string[]>([
    ['.js', [`${stem}.ts`, `${stem}.tsx`]],
    ['.jsx', [`${stem}.tsx`]],
    ['.cjs', [`${stem}.cts`]],
    ['.mjs', [`${stem}.mts`]]
  ]);

  for (const candidate of emittedTargets.get(ext) ?? []) {
    const rel = relative(REPO_ROOT, candidate).split('\\').join('/');
    if (nodes.has(rel)) return { target: rel, resolvedViaEmittedJs: true };
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.cts`,
    `${base}.mts`,
    `${base}.svelte`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
    resolve(base, 'index.cts'),
    resolve(base, 'index.mts')
  ]) {
    const rel = relative(REPO_ROOT, candidate).split('\\').join('/');
    if (nodes.has(rel)) return { target: rel, resolvedViaEmittedJs: false };
  }
  return null;
}

export interface Graph {
  readonly nodes: readonly string[];
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly edgeCount: number;
  readonly typeOnlyEdgeCount: number;
  readonly dynamicLazyEdgeCount: number;
  readonly emittedJsResolvedCount: number;
}

export function buildGraphFromSources(sources: ReadonlyMap<string, string>): Graph {
  const nodes = [...sources.keys()].sort();
  const nodeSet = new Set(nodes);
  const edges = new Map<string, readonly string[]>();
  let edgeCount = 0;
  let typeOnlyEdgeCount = 0;
  let dynamicLazyEdgeCount = 0;
  let emittedJsResolvedCount = 0;

  for (const rel of nodes) {
    const body = sources.get(rel) ?? '';
    const extracted = extractModuleSpecifiers(body, rel);

    const outValue = new Set<string>();
    const outEmitted = new Set<string>();
    for (const spec of extracted.value) {
      const resolved = resolveRelativeNode(rel, spec, nodeSet);
      if (resolved !== null && resolved.target !== rel) {
        outValue.add(resolved.target);
        if (resolved.resolvedViaEmittedJs) outEmitted.add(resolved.target);
      }
    }
    const uniqueValue = [...outValue];
    edges.set(rel, uniqueValue);
    edgeCount += uniqueValue.length;
    emittedJsResolvedCount += outEmitted.size;

    const outType = new Set<string>();
    for (const spec of extracted.typeOnly) {
      const resolved = resolveRelativeNode(rel, spec, nodeSet);
      if (resolved !== null && resolved.target !== rel) outType.add(resolved.target);
    }
    typeOnlyEdgeCount += outType.size;

    const outDynamic = new Set<string>();
    for (const spec of extracted.dynamicLazy) {
      const resolved = resolveRelativeNode(rel, spec, nodeSet);
      if (resolved !== null && resolved.target !== rel) outDynamic.add(resolved.target);
    }
    dynamicLazyEdgeCount += outDynamic.size;
  }

  return {
    nodes,
    edges,
    edgeCount,
    typeOnlyEdgeCount,
    dynamicLazyEdgeCount,
    emittedJsResolvedCount
  };
}

function buildGraph(): Graph {
  const sources = new Map<string, string>();
  for (const root of ROOTS) {
    for (const abs of filesUnder(resolve(REPO_ROOT, root), {
      extensions: ['.ts', '.tsx', '.cts', '.mts', '.svelte']
    })) {
      if (
        /\.d\.[cm]?ts$/.test(abs) ||
        /(^|[\\/])__tests__[\\/]/.test(abs) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(abs)
      ) {
        continue;
      }
      const rel = relative(REPO_ROOT, abs).split('\\').join('/');
      sources.set(rel, readFileSync(abs, 'utf8'));
    }
  }
  return buildGraphFromSources(sources);
}

/**
 * Every cycle, as a path (iterative DFS with explicit stack).
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

describe('the first-party import graph is acyclic (FR-R3-128, FR-R8-04 04-03)', () => {
  const graph = buildGraph();

  it('walked the full host + webview graph and distinguished value, type-only, lazy, and .js->.ts edges', () => {
    expect(graph.nodes.length, 'expected substantial host + webview module count').toBeGreaterThan(1_000);
    expect(graph.edgeCount, 'expected substantial static value edge count').toBeGreaterThan(2_500);
    expect(graph.typeOnlyEdgeCount, 'type-only edges must be recognized and counted').toBeGreaterThan(100);
    expect(graph.dynamicLazyEdgeCount, 'lazy dynamic import() edges (routes) must be recognized').toBeGreaterThanOrEqual(5);
    expect(graph.emittedJsResolvedCount, 'emitted .js -> .ts relative imports (e.g. snapshot-merge.ts) must resolve').toBeGreaterThanOrEqual(1);
    console.log(
      `[FR-R8-04 04-03] import graph: ${graph.nodes.length} module(s), ${graph.edgeCount} static value edge(s), ` +
        `${graph.typeOnlyEdgeCount} type-only edge(s), ${graph.dynamicLazyEdgeCount} dynamic lazy edge(s), ` +
        `${graph.emittedJsResolvedCount} emitted-.js->.ts value edge(s)`
    );
  });

  it('has no static value cycles across src/ and webview-ui/src/', () => {
    const cycles = findCycles(graph.edges).map((cycle) => cycle.join(' -> '));
    expect(
      cycles,
      'These first-party modules import each other in a static value cycle. Break it by moving the shared ' +
        'symbol to a leaf (`contracts/` or `lib/`), making one edge `import type`, or deferring with dynamic `import()`.'
    ).toEqual([]);
  });

  it('detects both an ordinary two-file cycle and a cycle crossing .js -> .ts and Svelte script resolution', () => {
    // 1. Ordinary two-file TS cycle
    const twoFile = buildGraphFromSources(
      new Map([
        ['graph/a.ts', "import { b } from './b'; export const a = () => b();"],
        ['graph/b.ts', "import { a } from './a'; export const b = () => a();"]
      ])
    );
    const twoFileCycles = findCycles(twoFile.edges);
    expect(twoFileCycles.length).toBeGreaterThan(0);
    expect(twoFileCycles[0]!.join(' -> ')).toContain('graph/a.ts');
    expect(twoFileCycles[0]!.join(' -> ')).toContain('graph/b.ts');

    // 2. Cycle crossing `.js` -> `.ts` resolution and `export ... from` re-export
    const jsToTsCycle = buildGraphFromSources(
      new Map([
        ['graph/x.ts', "import { y } from './y.js'; export const x = y + 1;"],
        ['graph/y.ts', "export { x as y } from './x.js';"]
      ])
    );
    expect(jsToTsCycle.emittedJsResolvedCount).toBe(2);
    const jsCycles = findCycles(jsToTsCycle.edges);
    expect(jsCycles.length).toBeGreaterThan(0);
    expect(jsCycles[0]!.join(' -> ')).toContain('graph/x.ts');
    expect(jsCycles[0]!.join(' -> ')).toContain('graph/y.ts');

    // 3. Cycle crossing Svelte `<script lang="ts">` + `.js` -> `.ts` resolution
    const svelteCycle = buildGraphFromSources(
      new Map([
        ['graph/View.svelte', '<script lang="ts">\nimport { helper } from "./helper.js";\nvoid helper;\n</script>\n<div />'],
        ['graph/helper.ts', "import View from './View.svelte'; export const helper = View;"]
      ])
    );
    expect(svelteCycle.emittedJsResolvedCount).toBe(1);
    const svelteCycles = findCycles(svelteCycle.edges);
    expect(svelteCycles.length).toBeGreaterThan(0);
    expect(svelteCycles[0]!.join(' -> ')).toContain('graph/View.svelte');

    // 4. Acyclic diamond and self-edge exclusion
    const acyclic = buildGraphFromSources(
      new Map([
        ['graph/a.ts', "import { b } from './b.js'; import { c } from './c'; export const a = b + c;"],
        ['graph/b.ts', "import { c } from './c'; export const b = c;"],
        ['graph/c.ts', 'export const c = 1;']
      ])
    );
    expect(findCycles(acyclic.edges)).toEqual([]);
  });

  it('distinguishes type-only and dynamic lazy route imports from static value edges', () => {
    const mixed = buildGraphFromSources(
      new Map([
        [
          'graph/loader.ts',
          [
            "import type { LazyType } from './lazy.js';",
            "import { type InlineOnly } from './inline';",
            "export type { Reexported } from './lazy.js';",
            "import { z } from 'zod';",
            "export const loadLazy = () => import('./lazy.svelte');",
            'export type Keep = LazyType | InlineOnly | typeof z;'
          ].join('\n')
        ],
        [
          'graph/lazy.svelte',
          '<script lang="ts">\nimport type { Keep } from "./loader";\nimport { loadLazy } from "./loader";\nvoid loadLazy;\nexport type T = Keep;\n</script>'
        ],
        ['graph/lazy.ts', "import type { Keep } from './loader'; export type LazyType = Keep; export type Reexported = Keep;"],
        ['graph/inline.ts', 'export type InlineOnly = string;']
      ])
    );
    // Static value edge goes only lazy.svelte -> loader.ts; loader.ts -> lazy.svelte is dynamic lazy.
    expect(mixed.edgeCount).toBe(1);
    expect(mixed.typeOnlyEdgeCount).toBeGreaterThanOrEqual(4);
    expect(mixed.dynamicLazyEdgeCount).toBe(1);
    expect(findCycles(mixed.edges)).toEqual([]);
  });

  it('reuses the layer declaration rather than restating it', () => {
    expect(LEAF_LAYERS.map((layer) => layer.dir)).toEqual(['contracts', 'lib']);
    expect(ACTING_LAYERS.length).toBeGreaterThan(10);
  });
});
