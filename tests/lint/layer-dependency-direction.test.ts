/**
 * FR-R7-07 (FR-006, FR-007, SC-001, SC-002, SC-005) — Layer-level value-import
 * direction gate, transitive `state/` isolation guard, and key-family cohesion
 * checks.
 *
 * Complements `dependency-direction.test.ts` (which governs `LEAF_LAYERS`:
 * `contracts`, `lib`) and `import-graph-acyclic.test.ts` (whole-tree file
 * acyclicity). All three gates read their shared layer declarations from
 * `tests/lint/architecture-layers.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_REVERSE_TYPE_EDGE_CEILINGS,
  LAYER_ALLOWED_VALUE_IMPORTS,
  LAYER_IMPORT_ALLOWLIST,
  STATE_FORBIDDEN_TRANSITIVE_LAYERS,
  STATE_MAX_FILE_LINES
} from './architecture-layers';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

/** Strip block and line comments while preserving newlines for textual constructor scans. */
function stripCommentsPreservingLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

export interface ParsedValueEdge {
  readonly line: number;
  readonly specifier: string;
}

/**
 * Extract every relative runtime VALUE import, value re-export, bare side-effect
 * import, and literal `import()` or `require()` using the TypeScript AST parser
 * (`ts.createSourceFile`), avoiding cross-statement regex bleed or comment/string
 * misparses.
 */
export function extractRelativeValueEdges(
  source: string,
  fileName = 'module.ts'
): readonly ParsedValueEdge[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const found: ParsedValueEdge[] = [];

  const pushEdge = (node: ts.Node, specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ line, specifier });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
        pushEdge(node, reference.expression.text);
      }
      return;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause === undefined) {
        // Bare side-effect import: `import '../layer/mod';`
        pushEdge(node, node.moduleSpecifier.text);
      } else if (!clause.isTypeOnly) {
        const isAllTypeNamed =
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((el) => el.isTypeOnly);
        if (!isAllTypeNamed) {
          pushEdge(node, node.moduleSpecifier.text);
        }
      }
      return;
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) {
        const isAllTypeNamed =
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((el) => el.isTypeOnly);
        if (!isAllTypeNamed) {
          pushEdge(node, node.moduleSpecifier.text);
        }
      }
      return;
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const firstArg = node.arguments.at(0);
      if (firstArg !== undefined && ts.isStringLiteralLike(firstArg)) {
        pushEdge(node, firstArg.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Extract every relative TYPE-ONLY import/re-export/inline `import('...').T` edge
 * using the TypeScript AST parser (`ts.createSourceFile`).
 */
export function extractRelativeTypeEdges(
  source: string,
  fileName = 'module.ts'
): readonly ParsedValueEdge[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const found: ParsedValueEdge[] = [];

  const pushEdge = (node: ts.Node, specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ line, specifier });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
        pushEdge(node, reference.expression.text);
      }
      return;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause !== undefined) {
        const hasTypeNamed =
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.some((el) => el.isTypeOnly);
        if (clause.isTypeOnly || hasTypeNamed) {
          pushEdge(node, node.moduleSpecifier.text);
        }
      }
      return;
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const hasTypeNamed =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some((el) => el.isTypeOnly);
      if (node.isTypeOnly || hasTypeNamed) {
        pushEdge(node, node.moduleSpecifier.text);
      }
      return;
    }

    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      pushEdge(node, node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return found;
}

export function findContractsReverseTypeEdges(
  sources: ReadonlyMap<string, string>,
  upperLayers: ReadonlySet<string>
): readonly LayerViolation[] {
  const knownFiles = new Set(sources.keys());
  const edges: LayerViolation[] = [];
  for (const [fromRel, body] of sources) {
    if (layerOfSourcePath(fromRel) !== 'contracts') continue;
    for (const edge of extractRelativeTypeEdges(body, fromRel)) {
      const targetRel = resolveRelativeTarget(fromRel, edge.specifier, knownFiles);
      const intoLayer =
        targetRel !== null
          ? layerOfSourcePath(targetRel)
          : layerOfSourcePath(
              relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, fromRel)), edge.specifier)),
              true
            );
      if (intoLayer === null || !upperLayers.has(intoLayer)) continue;
      edges.push({
        from: fromRel,
        fromLayer: 'contracts',
        intoLayer,
        line: edge.line,
        target: targetRel ?? edge.specifier
      });
    }
  }
  return edges;
}

/**
 * Resolve a repo-relative `src/<layer>/...` (or synthetic `fixture/<layer>/...`) path to
 * its top-level layer directory name. Top-level files directly under `src/` (such as
 * `src/extension.ts`) resolve to `'root'` so governed layers cannot silently import them.
 */
export function layerOfSourcePath(relPath: string, allowBareDir = false): string | null {
  const normalized = relPath.split('\\').join('/');
  const nested = /^(?:src|fixture)\/([a-z0-9-]+)\//.exec(normalized);
  const nestedLayer = nested?.at(1);
  if (nestedLayer !== undefined) return nestedLayer;
  if (/^(?:src|fixture)\/[^/]+\.(?:tsx?|[cm]ts)$/.test(normalized)) return 'root';
  if (allowBareDir) {
    const bare = /^(?:src|fixture)\/([a-z0-9-]+)$/.exec(normalized);
    const bareLayer = bare?.at(1);
    if (bareLayer !== undefined) return bareLayer;
  }
  return null;
}

function resolveRelativeTarget(
  fromRelPath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>
): string | null {
  const fromAbs = resolve(REPO_ROOT, fromRelPath);
  const base = resolve(dirname(fromAbs), specifier);
  const extension = extname(base);
  const stem = extension.length > 0 ? base.slice(0, -extension.length) : base;
  const emittedTargets: Readonly<Record<string, readonly string[]>> = {
    '.js': [`${stem}.ts`, `${stem}.tsx`],
    '.jsx': [`${stem}.tsx`],
    '.cjs': [`${stem}.cts`],
    '.mjs': [`${stem}.mts`]
  };
  const candidates = [
    ...(emittedTargets[extension] ?? []),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx')
  ];
  for (const candidate of candidates) {
    const rel = relative(REPO_ROOT, candidate).split('\\').join('/');
    if (knownFiles.has(rel)) return rel;
  }
  return null;
}

export interface LayerViolation {
  readonly from: string;
  readonly fromLayer: string;
  readonly intoLayer: string;
  readonly line: number;
  readonly target: string;
}

export function findLayerViolations(
  sources: ReadonlyMap<string, string>,
  allowedByLayer: Readonly<Record<string, readonly string[]>>
): readonly LayerViolation[] {
  const knownFiles = new Set(sources.keys());
  const violations: LayerViolation[] = [];
  for (const [fromRel, body] of sources) {
    const fromLayer = layerOfSourcePath(fromRel);
    if (fromLayer === null) continue;
    const allowed: readonly string[] | undefined = allowedByLayer[fromLayer];
    if (allowed === undefined) continue;
    const allowedSet = new Set(allowed);
    for (const edge of extractRelativeValueEdges(body, fromRel)) {
      const targetRel = resolveRelativeTarget(fromRel, edge.specifier, knownFiles);
      const intoLayer =
        targetRel !== null
          ? layerOfSourcePath(targetRel)
          : layerOfSourcePath(
              relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, fromRel)), edge.specifier)),
              true
            );
      if (intoLayer === null) continue;
      if (!allowedSet.has(intoLayer)) {
        violations.push({
          from: fromRel,
          fromLayer,
          intoLayer,
          line: edge.line,
          target: targetRel ?? edge.specifier
        });
      }
    }
  }
  return violations;
}

export function buildValueImportGraph(
  sources: ReadonlyMap<string, string>
): ReadonlyMap<string, readonly string[]> {
  const knownFiles = new Set(sources.keys());
  const graph = new Map<string, readonly string[]>();
  for (const [fromRel, body] of sources) {
    const targets: string[] = [];
    for (const edge of extractRelativeValueEdges(body, fromRel)) {
      const targetRel = resolveRelativeTarget(fromRel, edge.specifier, knownFiles);
      if (targetRel !== null && targetRel !== fromRel) {
        targets.push(targetRel);
      }
    }
    graph.set(fromRel, [...new Set(targets)]);
  }
  return graph;
}

export function findTransitiveLayerReach(
  graph: ReadonlyMap<string, readonly string[]>,
  startNode: string,
  forbiddenLayers: ReadonlySet<string>
): readonly string[] {
  const visited = new Set<string>([startNode]);
  const parent = new Map<string, string>();
  const queue: string[] = [startNode];
  const breaches: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      const layer = layerOfSourcePath(next);
      if (layer !== null && forbiddenLayers.has(layer)) {
        const chain: string[] = [next];
        let cursor: string | undefined = current;
        while (cursor !== undefined) {
          chain.unshift(cursor);
          cursor = parent.get(cursor);
        }
        breaches.push(chain.join(' -> '));
      } else {
        queue.push(next);
      }
    }
  }
  return breaches;
}

function loadSourceTree(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const abs of filesUnder(SRC_ROOT, { extensions: ['.ts', '.tsx', '.cts', '.mts'] })) {
    if (/\.d\.[cm]?ts$/.test(abs)) continue;
    const rel = relative(REPO_ROOT, abs).split('\\').join('/');
    map.set(rel, readFileSync(abs, 'utf8'));
  }
  return map;
}

describe('FR-R7-07 — layer-level value-import direction gate', () => {
  const sources = loadSourceTree();
  const valueGraph = buildValueImportGraph(sources);

  it('scanned a real state/ layer with non-empty file and edge floors (anti-vacuity)', () => {
    const stateFiles = [...sources.keys()].filter((p) => p.startsWith('src/state/'));
    let stateValueEdges = 0;
    for (const file of stateFiles) {
      stateValueEdges += valueGraph.get(file)?.length ?? 0;
    }
    expect(stateFiles.length, 'expected substantial src/state/ module count').toBeGreaterThan(35);
    expect(stateValueEdges, 'expected substantial src/state/ static value edges').toBeGreaterThan(50);
  });

  it('SC-001: every governed layer value-imports only its allowed layers or a filing-attributed allowlist entry', () => {
    const exactAllowed = new Set(
      LAYER_IMPORT_ALLOWLIST.filter((e) => e.target !== undefined).map(
        (e) => `${e.from}|${e.fromLayer}->${e.intoLayer}:${e.target}`
      )
    );
    const layerAllowed = new Set(
      LAYER_IMPORT_ALLOWLIST.filter((e) => e.target === undefined).map(
        (e) => `${e.from}|${e.fromLayer}->${e.intoLayer}`
      )
    );
    const violations = findLayerViolations(sources, LAYER_ALLOWED_VALUE_IMPORTS);
    const offenders = violations
      .filter(
        (v) =>
          !exactAllowed.has(`${v.from}|${v.fromLayer}->${v.intoLayer}:${v.target}`) &&
          !layerAllowed.has(`${v.from}|${v.fromLayer}->${v.intoLayer}`)
      )
      .map((v) => `${v.from}:${v.line} (${v.fromLayer} -> ${v.intoLayer}: ${v.target})`);

    expect(
      offenders,
      'A governed layer made a disallowed VALUE import. Relocate pure data/helpers to contracts/ or lib/, ' +
        'or invert the dependency through a port owned by the lower layer.'
    ).toEqual([]);

    // FR-R7-07 & F-06: state/ and controller/ must remain zero-exception.
    expect(
      LAYER_IMPORT_ALLOWLIST.filter((e) => e.fromLayer === 'state'),
      'src/state/ must stay zero-exception'
    ).toEqual([]);
    expect(
      LAYER_IMPORT_ALLOWLIST.filter((e) => e.fromLayer === 'controller'),
      'src/controller/ must stay zero-exception'
    ).toEqual([]);

    // FR-R8-04 (04-03) & F-06: every reconciled reverse edge carries an owner, exact target, filing, and rationale.
    for (const entry of LAYER_IMPORT_ALLOWLIST) {
      expect(entry.owner.trim().length, `${entry.from} allowlist entry must name an owner`).toBeGreaterThan(2);
      expect(entry.filing, `${entry.from} allowlist entry must name a filing`).toMatch(
        /^(?:FR-(?:R\d+-)?\d+|principal-review-\d{4}-\d{2}-\d{2}(?:-r\d+)? F-\d+)$/
      );
      expect(entry.reason.length, `${entry.from} allowlist entry needs a real explanation`).toBeGreaterThan(20);
      expect(entry.target, `${entry.from} allowlist entry must pin an exact target`).toBeDefined();
    }

    // Truthfulness: reject any stale allowlist entry that no longer corresponds to a real edge.
    const liveExactKeys = new Set(
      violations.map((v) => `${v.from}|${v.fromLayer}->${v.intoLayer}:${v.target}`)
    );
    const liveLayerKeys = new Set(
      violations.map((v) => `${v.from}|${v.fromLayer}->${v.intoLayer}`)
    );
    const stale = LAYER_IMPORT_ALLOWLIST.filter((e) =>
      e.target !== undefined
        ? !liveExactKeys.has(`${e.from}|${e.fromLayer}->${e.intoLayer}:${e.target}`)
        : !liveLayerKeys.has(`${e.from}|${e.fromLayer}->${e.intoLayer}`)
    ).map((e) => `${e.from} (${e.fromLayer} -> ${e.intoLayer}${e.target !== undefined ? `: ${e.target}` : ''})`);
    expect(stale, 'remove stale LAYER_IMPORT_ALLOWLIST entries').toEqual([]);
  });

  it('FR-R8-04 (04-03) NON-VACUITY: a fixture introducing a new unowned services/ -> controller/ reverse edge fails the gate', () => {
    const synthetic = new Map<string, string>([
      [
        'fixture/services/new-orchestrator.ts',
        [
          "import { unownedControllerFn } from '../controller/workflow-controller';",
          "import type { AllowedControllerType } from '../controller/workflow-controller';",
          "import { allowedQueueFn } from '../queue/queue-manager';",
          'export type Keep = AllowedControllerType;',
          'export const run = () => [unownedControllerFn, allowedQueueFn];'
        ].join('\n')
      ],
      ['fixture/controller/workflow-controller.ts', 'export const unownedControllerFn = 1; export type AllowedControllerType = number;'],
      ['fixture/queue/queue-manager.ts', 'export const allowedQueueFn = 1;']
    ]);
    const found = findLayerViolations(synthetic, LAYER_ALLOWED_VALUE_IMPORTS);
    expect(found).toEqual([
      {
        from: 'fixture/services/new-orchestrator.ts',
        fromLayer: 'services',
        intoLayer: 'controller',
        line: 1,
        target: 'fixture/controller/workflow-controller.ts'
      }
    ]);
  });

  it('SC-005: no src/state/ module transitively value-imports queue/, parser/, services/, controller/, or ui/', () => {
    const forbidden = new Set<string>(STATE_FORBIDDEN_TRANSITIVE_LAYERS);
    const stateFiles = [...sources.keys()].filter((p) => p.startsWith('src/state/')).sort();
    const breaches: string[] = [];
    for (const file of stateFiles) {
      breaches.push(...findTransitiveLayerReach(valueGraph, file, forbidden));
    }
    expect(
      breaches,
      'Importing a src/state/ module transitively reaches a forbidden upper layer.'
    ).toEqual([]);
  });

  it('SC-002: no file in src/state/ exceeds the key-family size limit', () => {
    const stateFiles = [...sources.keys()].filter((p) => p.startsWith('src/state/')).sort();
    const oversized: string[] = [];
    for (const file of stateFiles) {
      const lineCount = (sources.get(file) ?? '').split('\n').length;
      if (lineCount > STATE_MAX_FILE_LINES) {
        oversized.push(`${file}: ${lineCount} lines (limit ${STATE_MAX_FILE_LINES})`);
      }
    }
    expect(oversized).toEqual([]);
  });

  it('FR-005: serialize chain, MementoWriteGate, and OwnershipRegistry are instantiated only in workspace-state.ts', () => {
    const familyFiles = [...sources.keys()]
      .filter((p) => /^src\/state\/workspace-state-.+\.ts$/.test(p))
      .sort();
    expect(familyFiles.length).toBeGreaterThanOrEqual(7);
    const violations: string[] = [];
    for (const file of familyFiles) {
      const clean = stripCommentsPreservingLines(sources.get(file) ?? '');
      if (clean.includes('new MementoWriteGate(')) {
        violations.push(`${file}: must not construct its own MementoWriteGate`);
      }
      if (clean.includes('new OwnershipRegistry(')) {
        violations.push(`${file}: must not construct its own OwnershipRegistry`);
      }
      if (/\bchains\s*=\s*new\s+Map/.test(clean)) {
        violations.push(`${file}: must not construct its own serialize chain map`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('NON-VACUITY (FR-006): injected disallowed value imports fail; type-only and allowed imports pass', () => {
    // Synthetic fixture paths use `fixture/` rather than `src/` so `lint-anchor-grounding.test.ts`
    // does not expect synthetic paths to exist on disk (same convention as `import-graph-acyclic.test.ts`).
    const synthetic = new Map<string, string>([
      [
        'fixture/state/bad.ts',
        [
          "import type { FileHandle } from 'node:fs/promises';",
          "import { bad } from '../controller/ctrl';",
          "import { type GoodType, badValue } from '../queue/q';",
          "export { leaked } from '../services/svc';",
          "import '../controller/init';",
          "import { activate } from '../extension';",
          "import { badBare } from '../parser';",
          "export async function lazy() { return import('../services/svc'); }",
          "import { createHash } from 'node:crypto';",
          "import type { AllowedType } from '../controller/ctrl';",
          "import { type OnlyTypeA, type OnlyTypeB } from '../ui/ui';",
          "export type { ReexportedType } from '../parser/p';",
          "import { okLeaf } from '../contracts/c';",
          "import { okLib } from '../lib/l';"
        ].join('\n')
      ],
      ['fixture/extension.ts', 'export const activate = () => {};'],
      ['fixture/controller/ctrl.ts', 'export const bad = 1; export type AllowedType = number;'],
      ['fixture/controller/init.ts', 'export const init = 1;'],
      ['fixture/queue/q.ts', 'export const badValue = 1; export type GoodType = number;'],
      ['fixture/services/svc.ts', 'export const leaked = 1;'],
      ['fixture/ui/ui.ts', 'export type OnlyTypeA = 1; export type OnlyTypeB = 2;'],
      ['fixture/parser/p.ts', 'export type ReexportedType = 1;'],
      ['fixture/contracts/c.ts', 'export const okLeaf = 1;'],
      ['fixture/lib/l.ts', 'export const okLib = 1;']
    ]);

    const found = findLayerViolations(synthetic, LAYER_ALLOWED_VALUE_IMPORTS);
    expect(found.map((v) => `${v.fromLayer}->${v.intoLayer}@L${v.line}`)).toEqual([
      'state->controller@L2',
      'state->queue@L3',
      'state->services@L4',
      'state->controller@L5',
      'state->root@L6',
      'state->parser@L7',
      'state->services@L8'
    ]);

    // Transitive non-vacuity: state -> lib -> controller must be caught by transitive reach.
    const transitiveSynthetic = new Map<string, string>([
      ['fixture/state/entry.ts', "import { bridge } from '../lib/bridge';"],
      ['fixture/lib/bridge.ts', "import { ctrl } from '../controller/ctrl'; export const bridge = ctrl;"],
      ['fixture/controller/ctrl.ts', 'export const ctrl = 1;']
    ]);
    const transitiveGraph = buildValueImportGraph(transitiveSynthetic);
    const breaches = findTransitiveLayerReach(
      transitiveGraph,
      'fixture/state/entry.ts',
      new Set<string>(STATE_FORBIDDEN_TRANSITIVE_LAYERS)
    );
    expect(breaches).toEqual([
      'fixture/state/entry.ts -> fixture/lib/bridge.ts -> fixture/controller/ctrl.ts'
    ]);
  });

  it('enforces layer boundaries for CommonJS and emitted JavaScript specifiers', () => {
    const sources = new Map([
      ['fixture/state/entry.ts', [
        "import blocked = require('../services/blocked.cjs');",
        "import type Ignored = require('../queue/types.js');",
        "import { bridge } from '../config/bridge.js';"
      ].join('\n')],
      ['fixture/config/bridge.ts', "export const bridge = require('../controller/runtime.js');"],
      ['fixture/services/blocked.cts', 'export const blocked = true;'],
      ['fixture/queue/types.ts', 'export interface Ignored {}'],
      ['fixture/controller/runtime.ts', 'export const runtime = true;']
    ]);

    expect(findLayerViolations(sources, LAYER_ALLOWED_VALUE_IMPORTS).map((edge) => edge.target))
      .toEqual(['fixture/services/blocked.cts', 'fixture/controller/runtime.ts']);
    expect(findTransitiveLayerReach(
      buildValueImportGraph(sources),
      'fixture/state/entry.ts',
      new Set(STATE_FORBIDDEN_TRANSITIVE_LAYERS)
    )).toEqual([
      'fixture/state/entry.ts -> fixture/services/blocked.cts',
      'fixture/state/entry.ts -> fixture/config/bridge.ts -> fixture/controller/runtime.ts'
    ]);
  });

  it('F-06: LAYER_ALLOWED_VALUE_IMPORTS defines a strict DAG across all governed layers', () => {
    const governed = new Set(Object.keys(LAYER_ALLOWED_VALUE_IMPORTS));
    expect(governed.size).toBeGreaterThanOrEqual(8);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];

    const dfs = (layer: string, stack: string[]): void => {
      visiting.add(layer);
      for (const target of LAYER_ALLOWED_VALUE_IMPORTS[layer] ?? []) {
        if (target === layer || !governed.has(target)) continue;
        if (visiting.has(target)) {
          cycles.push([...stack.slice(stack.indexOf(target)), target].join(' -> '));
        } else if (!visited.has(target)) {
          dfs(target, [...stack, target]);
        }
      }
      visiting.delete(layer);
      visited.add(layer);
    };

    for (const layer of governed) {
      if (!visited.has(layer)) dfs(layer, [layer]);
    }
    expect(cycles, 'governed layer policy must not admit layer-level cycles').toEqual([]);
  });

  it('F-06 NON-VACUITY: newly governed layers catch unowned reverse value edges', () => {
    const synthetic = new Map<string, string>([
      ['fixture/runner/bad.ts', "import { svc } from '../services/svc'; export const r = svc;"],
      ['fixture/queue/bad.ts', "import { svc } from '../services/svc'; export const q = svc;"],
      ['fixture/config/bad.ts', "import { svc } from '../services/svc'; export const c = svc;"],
      ['fixture/parser/bad.ts', "import { svc } from '../services/svc'; export const p = svc;"],
      ['fixture/metrics/bad.ts', "import { svc } from '../services/svc'; export const m = svc;"],
      ['fixture/controller/bad.ts', "import { view } from '../ui/view'; export const k = view;"],
      ['fixture/services/svc.ts', 'export const svc = 1;'],
      ['fixture/ui/view.ts', 'export const view = 1;']
    ]);

    const found = findLayerViolations(synthetic, LAYER_ALLOWED_VALUE_IMPORTS).map(
      (v) => `${v.fromLayer}->${v.intoLayer}`
    );
    expect(found).toEqual([
      'runner->services',
      'queue->services',
      'config->services',
      'parser->services',
      'metrics->services',
      'controller->ui'
    ]);
  });

  it('F-06: ratchets type-only reverse edges from contracts/ into upper layers (no growth)', () => {
    const contractFiles = [...sources.keys()].filter((p) => p.startsWith('src/contracts/'));
    expect(contractFiles.length, 'expected substantial src/contracts/ file count').toBeGreaterThan(50);

    const upperLayers = new Set(Object.keys(CONTRACTS_REVERSE_TYPE_EDGE_CEILINGS));
    const reverseEdges = findContractsReverseTypeEdges(sources, upperLayers);
    expect(
      reverseEdges.length,
      'anti-vacuity: expected live contracts/ reverse type edges to be observed'
    ).toBeGreaterThan(0);

    const byLayer = new Map<string, LayerViolation[]>();
    for (const layer of upperLayers) byLayer.set(layer, []);
    for (const edge of reverseEdges) {
      byLayer.get(edge.intoLayer)?.push(edge);
    }

    const overCeiling: string[] = [];
    let totalCeiling = 0;
    for (const [layer, ceiling] of Object.entries(CONTRACTS_REVERSE_TYPE_EDGE_CEILINGS)) {
      totalCeiling += ceiling;
      const actual = byLayer.get(layer) ?? [];
      if (actual.length > ceiling) {
        overCeiling.push(
          `contracts -> ${layer}: ${actual.length} > ceiling ${ceiling}\n  ` +
            actual.map((e) => `${e.from}:${e.line} -> ${e.target}`).join('\n  ')
        );
      }
    }

    expect(
      overCeiling,
      'src/contracts/ added a new type-only reverse import into an upper layer. ' +
        'Move the shared type into src/contracts/ instead of reaching upward.'
    ).toEqual([]);
    expect(reverseEdges.length).toBeLessThanOrEqual(totalCeiling);
  });

  it('F-06 NON-VACUITY: injected contracts/ type-only reverse edges are detected across all 5 upper layers', () => {
    const upperLayers = new Set(Object.keys(CONTRACTS_REVERSE_TYPE_EDGE_CEILINGS));
    const synthetic = new Map<string, string>([
      [
        'fixture/contracts/leak.ts',
        [
          "import type { Svc } from '../services/svc';",
          "import { type St } from '../state/st';",
          "export type { Ctrl } from '../controller/ctrl';",
          "import type { Run } from '../runner/run';",
          "export type Q = import('../queue/q').QueueItem;",
          "import type { LeafOk } from '../lib/ok';",
          'export type Keep = [Svc, St, Run, LeafOk];'
        ].join('\n')
      ],
      ['fixture/services/svc.ts', 'export interface Svc {}'],
      ['fixture/state/st.ts', 'export interface St {}'],
      ['fixture/controller/ctrl.ts', 'export interface Ctrl {}'],
      ['fixture/runner/run.ts', 'export interface Run {}'],
      ['fixture/queue/q.ts', 'export interface QueueItem {}'],
      ['fixture/lib/ok.ts', 'export interface LeafOk {}']
    ]);

    const found = findContractsReverseTypeEdges(synthetic, upperLayers).map(
      (e) => `${e.intoLayer}@L${e.line}`
    );
    expect(found).toEqual([
      'services@L1',
      'state@L2',
      'controller@L3',
      'runner@L4',
      'queue@L5'
    ]);
  });
});
