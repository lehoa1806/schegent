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
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
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
 * import, and dynamic relative `import('...')` call using the TypeScript AST parser
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
      node.expression.kind === ts.SyntaxKind.ImportKeyword
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
 * Resolve a repo-relative `src/<layer>/...` (or synthetic `fixture/<layer>/...`) path to
 * its top-level layer directory name. Top-level files directly under `src/` (such as
 * `src/extension.ts`) resolve to `'root'` so governed layers cannot silently import them.
 */
export function layerOfSourcePath(relPath: string, allowBareDir = false): string | null {
  const normalized = relPath.split('\\').join('/');
  const nested = /^(?:src|fixture)\/([a-z0-9-]+)\//.exec(normalized);
  const nestedLayer = nested?.at(1);
  if (nestedLayer !== undefined) return nestedLayer;
  if (/^(?:src|fixture)\/[^/]+\.tsx?$/.test(normalized)) return 'root';
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
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
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
  for (const abs of filesUnder(SRC_ROOT, { extensions: ['.ts'] })) {
    if (/\.d\.ts$/.test(abs)) continue;
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
    const allowedExceptions = new Set(
      LAYER_IMPORT_ALLOWLIST.map((e) => `${e.from}|${e.fromLayer}->${e.intoLayer}`)
    );
    const violations = findLayerViolations(sources, LAYER_ALLOWED_VALUE_IMPORTS);
    const offenders = violations
      .filter((v) => !allowedExceptions.has(`${v.from}|${v.fromLayer}->${v.intoLayer}`))
      .map((v) => `${v.from}:${v.line} (${v.fromLayer} -> ${v.intoLayer}: ${v.target})`);

    expect(
      offenders,
      'A governed layer made a disallowed VALUE import. Relocate pure data/helpers to contracts/ or lib/, ' +
        'or invert the dependency through a port owned by the lower layer.'
    ).toEqual([]);

    for (const entry of LAYER_IMPORT_ALLOWLIST) {
      expect(entry.filing, `${entry.from} allowlist entry must name a successor filing`).toMatch(
        /^FR-(?:R\d+-)?\d+/
      );
      expect(entry.reason.length, `${entry.from} allowlist entry needs a real explanation`).toBeGreaterThan(20);
    }

    // Truthfulness: reject any stale allowlist entry that no longer corresponds to a real edge.
    const liveViolationKeys = new Set(
      violations.map((v) => `${v.from}|${v.fromLayer}->${v.intoLayer}`)
    );
    const stale = LAYER_IMPORT_ALLOWLIST.filter(
      (e) => !liveViolationKeys.has(`${e.from}|${e.fromLayer}->${e.intoLayer}`)
    ).map((e) => `${e.from} (${e.fromLayer} -> ${e.intoLayer})`);
    expect(stale, 'remove stale LAYER_IMPORT_ALLOWLIST entries').toEqual([]);
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
});
