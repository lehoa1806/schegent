// Feature 254 (FR-R4-F07, N3, N5; contract V1 to V3; data-model §10; research R24, R25; FR-041, FR-042,
// SC-009) — a forgotten kind, or a forgotten Workflow-node field, fails a check by name.
//
// Hard rules 62 and 63 describe two failures that are silent. A new resource kind that has no reader on
// `ProcessCatalogPort` is read as an empty catalog (every reader is optional and every caller defaults, so
// `deps.readPipelineConfig?.() ?? { rows: [], revision: '' }` never complains). A new authored field on a
// Workflow node that is missing from `WORKFLOW_NODE_KEY_ORDER` is validated, stored, and then not exported:
// `emitMapping` is untyped against the node, so the field vanishes on the way out. Neither shows up in a
// test written for the thing that was added.
//
// This gate holds the checks that have no production caller, so none of them is exported from `src/`:
//
//   * `READER_OF_KIND`   — each kind's reader on the port, typed over the union: a kind added to
//                          `ProcessYamlResourceKind` with no entry here fails `typecheck:tests`, naming the key;
//   * `kindsWithoutReader` — the kinds whose reader is absent from a port;
//   * `missingNodeKeys`  — the authored node fields missing from an exported key order.
//
// Each check is shown to catch a SYNTHETIC omission, not only to pass on the real tree (SC-009): a kind
// removed from the port, a field removed from the order. A gate that has only ever seen the tree it passes
// on has not shown it can fail.
//
// The dispatch half (`DISPATCH_OF_KIND`, `undispatchedKinds`) lives in `src/headless/process-yaml-api.ts`
// because `importProcessDocument` uses it at runtime; its behavior is held by
// tests/unit/process-yaml/import-dispatch-coverage.test.ts, and what is held here is that its map covers the
// runtime list.
//
// This is a NEW lint file: `docs/development/lint-gate-census.md` carries its row (feature 254, G8).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTHORED_NODE_FIELDS } from '../../src/config/workflow-definition-validator';
import type { WorkflowNode } from '../../src/contracts/workflow-definitions';
import { DISPATCH_OF_KIND } from '../../src/headless/process-yaml-api';
import type { ProcessCatalogPort } from '../../src/services/process-yaml/service-ports';
import {
  PROCESS_YAML_RESOURCE_KINDS,
  type ProcessYamlResourceKind
} from '../../src/services/process-yaml/types';
import { WORKFLOW_NODE_KEY_ORDER } from '../../src/services/process-yaml/yaml-serializer';

const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The reader each kind has on `ProcessCatalogPort`. A kind without an entry is a compile error.
 *
 * The members are distinct on purpose: two kinds mapped to one reader would read each other's catalog.
 */
const READER_OF_KIND: { readonly [K in ProcessYamlResourceKind]: keyof ProcessCatalogPort } = {
  phase: 'readPhaseConfig',
  workflow: 'readWorkflowConfig',
  modelCatalog: 'readModelsConfig'
};

/** The kinds whose mapped reader is absent from `port`. */
function kindsWithoutReader(
  port: ProcessCatalogPort,
  map: { readonly [K in ProcessYamlResourceKind]: keyof ProcessCatalogPort } = READER_OF_KIND
): readonly ProcessYamlResourceKind[] {
  return PROCESS_YAML_RESOURCE_KINDS.filter((kind) => port[map[kind]] === undefined);
}

/** The authored fields that `order` does not list, in the authored set's order. */
function missingNodeKeys(order: readonly string[], authored: ReadonlySet<string>): readonly string[] {
  return [...authored].filter((field) => !order.includes(field));
}

/** A port that supplies every reader. */
function completePort(): ProcessCatalogPort {
  return {
    readPhaseConfig: () => ({ rows: [], revision: '' }) as never,
    readWorkflowConfig: () => ({ rows: [], revision: '' }) as never,
    readModelsConfig: () => ({})
  };
}

/** A port without the reader `reader`, built without mutating the complete one. */
function portWithout(reader: keyof ProcessCatalogPort): ProcessCatalogPort {
  const { [reader]: _removed, ...rest } = completePort();
  return rest;
}

/** The code of a TypeScript source, with block and line comments removed. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function productionCode(relativePath: string): string {
  return codeOf(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));
}

/** Type-level equality: `true` only when the two types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** `WORKFLOW_NODE_KEY_ORDER`'s members are the authored keys of a `WorkflowNode` (N5; a compile-time check). */
export type NodeKeyOrderMatchesNode = Assert<
  Equal<(typeof WORKFLOW_NODE_KEY_ORDER)[number], Exclude<keyof WorkflowNode, 'pipelineId'>>
>;

/** The runtime kind list is exactly the union (N3; a compile-time check). */
export type KindListMatchesUnion = Assert<
  Equal<(typeof PROCESS_YAML_RESOURCE_KINDS)[number], ProcessYamlResourceKind>
>;

// ---------------------------------------------------------------------------
// N3: every kind has a reader, and a write dispatch
// ---------------------------------------------------------------------------

describe('FR-R4-F07 N3 — every resource kind has a reader (FR-041, SC-009)', () => {
  it('maps every kind to a distinct reader of the port', () => {
    const readers = PROCESS_YAML_RESOURCE_KINDS.map((kind) => READER_OF_KIND[kind]);
    expect(new Set(readers).size).toBe(PROCESS_YAML_RESOURCE_KINDS.length);
    expect(Object.keys(READER_OF_KIND).sort()).toEqual([...PROCESS_YAML_RESOURCE_KINDS].sort());
  });

  it('finds no kind without a reader in a complete port', () => {
    expect(kindsWithoutReader(completePort())).toEqual([]);
  });

  it.each(PROCESS_YAML_RESOURCE_KINDS.map((kind) => [kind] as const))(
    'names only %s when its reader is removed from a complete port (synthetic omission)',
    (omitted) => {
      expect(kindsWithoutReader(portWithout(READER_OF_KIND[omitted]))).toEqual([omitted]);
    }
  );

  it('names every kind for an empty port', () => {
    expect([...kindsWithoutReader({})].sort()).toEqual([...PROCESS_YAML_RESOURCE_KINDS].sort());
  });

  it('control: a reader name the production wiring is known to supply is found by the scan', () => {
    const wiring = productionCode('src/activation/catalog-loading.ts');
    expect(wiring).toMatch(/\breadPhaseConfig\s*:/);
    // And a name that is not there is not: the scan can say no.
    expect(wiring).not.toMatch(/\breadNoSuchKindConfig\s*:/);
  });

  it('supplies every mapped reader in the production wiring', () => {
    const wiring = [
      productionCode('src/activation/catalog-loading.ts'),
      productionCode('src/activation/sidebar-router-wiring.ts')
    ].join('\n');
    const unsupplied = PROCESS_YAML_RESOURCE_KINDS.filter(
      (kind) => !new RegExp(`\\b${READER_OF_KIND[kind]}\\s*:`).test(wiring)
    );
    expect(unsupplied).toEqual([]);
  });
});

describe('FR-R4-F07 N3 — every resource kind has a write dispatch (FR-041)', () => {
  it('covers every kind of the runtime list, and nothing else', () => {
    expect(Object.keys(DISPATCH_OF_KIND).sort()).toEqual([...PROCESS_YAML_RESOURCE_KINDS].sort());
  });
});

// ---------------------------------------------------------------------------
// N5: every authored Workflow-node field is exported
// ---------------------------------------------------------------------------

describe('FR-R4-F07 N5 — every authored Workflow-node field is in the exported key order (FR-042, SC-009)', () => {
  it('finds no authored node field missing from the real order', () => {
    expect(missingNodeKeys(WORKFLOW_NODE_KEY_ORDER, AUTHORED_NODE_FIELDS)).toEqual([]);
  });

  it('lists the authored node fields, so an empty verdict is not an empty set compared to itself', () => {
    expect([...AUTHORED_NODE_FIELDS].sort()).toEqual([
      'control',
      'kind',
      'label',
      'nodeId',
      'phaseId',
      'workflowId'
    ]);
  });

  it('names label when label is removed from the order (synthetic omission)', () => {
    const order = WORKFLOW_NODE_KEY_ORDER.filter((key) => key !== 'label');

    expect(missingNodeKeys(order, AUTHORED_NODE_FIELDS)).toEqual(['label']);
  });

  it.each([...AUTHORED_NODE_FIELDS].map((field) => [field] as const))(
    'names only %s when it is the one field removed from the order (synthetic omission)',
    (omitted) => {
      const order = WORKFLOW_NODE_KEY_ORDER.filter((key) => key !== omitted);

      expect(missingNodeKeys(order, AUTHORED_NODE_FIELDS)).toEqual([omitted]);
    }
  );

  it('names every field for an empty order', () => {
    expect([...missingNodeKeys([], AUTHORED_NODE_FIELDS)].sort()).toEqual([
      'control',
      'kind',
      'label',
      'nodeId',
      'phaseId',
      'workflowId'
    ]);
  });
});
