// Feature 254 (FR-R4-F07, T006/T007, contract Q-T3, Q6; FR-011, US2 AS3) — an
// ordinary export is byte-identical before and after the sequence-item quoting
// change.
//
// Feature 254 makes `emitScalarItem` double-quote a sequence item the scanner
// would read as a key (`ollama:llama3`). That is the one change to the writer, and
// FR-011 says it must reach nothing else: every export that holds no such item,
// and every mapping VALUE such as `model: ollama:llama3`, keeps its exact bytes.
// "Keeps its bytes" is a claim about bytes, so this file pins a SHA-256 of each.
//
// The digests in `EXPECTED_DIGESTS` were taken ONCE, from output, before any
// `src/` edit of this feature (tasks T006, T007). They are never set from output
// again: a later mismatch is a defect in the change, not a number to refresh.
//
// Two groups, eight exports in all:
//
//   * the four documents in `repo/examples/*.yaml`, each read through the
//     production parser and mapper into the catalog rows it declares, then
//     exported through `selectProcessExportDocument` — the pure core every export
//     path calls (`export-service.ts`);
//   * four catalogs built inline, one of which holds the mapping value
//     `model: ollama:llama3` on a Phase. None holds a sequence item that
//     `looksKeyed` would match, which `examples/` is checked for as well.
//
// The export path under test is the production one. Nothing here re-implements a
// serializer, so a change that moves a byte moves a digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { modelsConfigFromGroups } from '../../../src/config/model-catalog';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { ExportProcessYamlRequest } from '../../../src/contracts/sidebar-ipc/process-yaml';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { selectProcessExportDocument } from '../../../src/services/process-yaml/export-service';
import { parseModelCatalogDocument } from '../../../src/services/process-yaml/model-catalog-yaml-mapper';
import { phaseDefinitionFromDocument } from '../../../src/services/process-yaml/phase-yaml-mapper';
import { parsePipelinePackage } from '../../../src/services/process-yaml/pipeline-document';
import type { ExchangeDeps } from '../../../src/services/process-yaml/service-ports';
import type { YamlMappingNode } from '../../../src/services/process-yaml/types';
import { parseWorkflowPackage } from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

/**
 * SHA-256 hex of each export's bytes, taken at `c744874f` before any edit of
 * feature 254. Never refreshed from output after T007.
 */
const EXPECTED_DIGESTS: Readonly<Record<string, string>> = {
  'example: speckit-bugfix.pipeline.yaml':
    'b7a34e1bc39e776aaad44b24c739fac8e522517a351d34ce6ca5cb517df0aa77',
  'example: speckit-new-feature.pipeline.yaml':
    '951fc98fb77fd9dc177d21ed09113d99c2690332d33738bb81f1bb6040323ebb',
  'example: example-two-node.workflow.yaml':
    '7c7113707dee9aa1472cb0fe4fe78f1eb3fe7976fe3321bf220717fed630a7e4',
  'example: model-catalog.yaml':
    'f727213b8b19d7013373b07e0d37d935a162ca290ab2e00fd85f1a556d4cbb01',
  'inline: Phase with a mapping value model: ollama:llama3':
    '8d56f8d1831f6de47374dc256296368f58e7261e95cf3e116b95c42a40c3cfc5',
  'inline: Pipeline with executionDefaults':
    '5d393ba21cb55534ba7986d10a6bdd2c74ae5b259edc403b0aee566f6f47b1cf',
  'inline: Workflow with one connection':
    'ba1fb094beb7c189017bfaa695e92ed1e678360818c068f17f7571003faed418',
  'inline: Model Catalog':
    'a9bc446a214bcdbb7a75d0090bf9086a97fe95aeb08816f6f21653773e439d34'
};

/** What a case needs to export: the rows each catalog holds and the request. */
interface ExportCase {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  readonly models?: Readonly<Record<string, readonly string[]>>;
  readonly request: ExportProcessYamlRequest;
}

function depsOf(exportCase: ExportCase): ExchangeDeps {
  return {
    readPhaseConfig: () => ({ rows: exportCase.phases ?? [], revision: FIXTURE_REVISION }),
    readPipelineConfig: () => ({ rows: exportCase.pipelines ?? [], revision: FIXTURE_REVISION }),
    readWorkflowConfig: () => ({ rows: exportCase.workflows ?? [], revision: FIXTURE_REVISION }),
    readModelsConfig: () => ({ ...(exportCase.models ?? {}) }),
    logger: { sanitize: (value: string) => value, warn: () => undefined }
  };
}

/** The exported text, insisting the export resolved: a refusal has no bytes to pin. */
function exportedText(exportCase: ExportCase): string {
  const selection = selectProcessExportDocument(depsOf(exportCase), exportCase.request);
  if (selection.outcome !== 'resolved') {
    throw new Error(`the export did not resolve: ${selection.reason}`);
  }
  return selection.text;
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// The four shipped documents, read the way preflight reads them
// ---------------------------------------------------------------------------

function readExample(name: string): string {
  return readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');
}

/** The document's root, which the parser always yields as a mapping. */
function parsedRoot(name: string): YamlMappingNode {
  const parsed = parseDocumentText(readExample(name));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.refusal.code}: ${parsed.refusal.message}`);
  return parsed.node;
}

function pipelineExample(name: string): ExportCase {
  const root = parsedRoot(name);
  const result = parsePipelinePackage(root);
  if (!result.ok) throw new Error(`${name}: ${result.refusal.code}: ${result.refusal.message}`);
  const phases: PhaseDefinition[] = [];
  let pipeline: PipelineDefinition | null = null;
  for (const resource of result.resources) {
    if (!resource.ok) throw new Error(`${name}: invalid ${resource.resourceKind}`);
    if (resource.resourceKind === 'pipeline') pipeline = resource.definition;
    else phases.push(phaseDefinitionFromDocument(resource.document));
  }
  if (pipeline === null) throw new Error(`${name}: no root Pipeline`);
  return {
    phases,
    pipelines: [pipeline],
    request: {
      resourceKind: 'pipeline',
      resourceId: pipeline.pipelineId,
      inclusion: 'include-referenced'
    }
  };
}

function workflowExample(name: string): ExportCase {
  const root = parsedRoot(name);
  const result = parseWorkflowPackage(root);
  if (!result.ok) throw new Error(`${name}: ${result.refusal.code}: ${result.refusal.message}`);
  const phases: PhaseDefinition[] = [];
  const pipelines: PipelineDefinition[] = [];
  let workflow: WorkflowDefinition | null = null;
  for (const resource of result.resources) {
    if (!resource.ok) throw new Error(`${name}: invalid ${resource.resourceKind}`);
    if (resource.resourceKind === 'workflow') workflow = resource.definition;
    else if (resource.resourceKind === 'pipeline') pipelines.push(resource.definition);
    else phases.push(phaseDefinitionFromDocument(resource.document));
  }
  if (workflow === null) throw new Error(`${name}: no root Workflow`);
  return {
    phases,
    pipelines,
    workflows: [workflow],
    request: {
      resourceKind: 'workflow',
      resourceId: workflow.workflowId,
      inclusion: 'include-closure'
    }
  };
}

function modelCatalogExample(name: string): ExportCase {
  const root = parsedRoot(name);
  const result = parseModelCatalogDocument(root);
  if (!result.ok) throw new Error(`${name}: ${result.refusal.code}: ${result.refusal.message}`);
  return {
    models: modelsConfigFromGroups(result.document.groups),
    request: { resourceKind: 'modelCatalog' }
  };
}

// ---------------------------------------------------------------------------
// Four catalogs built inline
// ---------------------------------------------------------------------------

/**
 * A Phase whose `model` is a mapping VALUE shaped like a keyed item. FR-011: a
 * value in that position is untouched, so this export keeps its plain
 * `model: ollama:llama3` line.
 */
const COLON_MODEL_PHASE = {
  phaseId: 'colon-model',
  name: 'Colon model',
  version: 1,
  instruction: 'Summarize the change.',
  model: 'ollama:llama3',
  effort: 'high'
};

const DRAFT_PHASE = { phaseId: 'draft', name: 'Draft', version: 1, instruction: 'Write a draft.' };
const REVIEW_PHASE = { phaseId: 'review', name: 'Review', version: 1, instruction: 'Review it.' };

/** A Pipeline with authored `executionDefaults` (FR-024: carried and exported). */
const DEFAULTS_PIPELINE = {
  pipelineId: 'with-defaults',
  name: 'With defaults',
  description: 'Draft, then review.',
  version: 2,
  phaseIds: ['draft', 'review'],
  inputs: [],
  outputs: [],
  bindings: [],
  executionDefaults: { effort: 'high', timeoutSeconds: 900 }
};

/** The first leg declares the output port the connection leaves from. */
const FIRST_PIPELINE = {
  pipelineId: 'first-leg',
  name: 'First leg',
  version: 1,
  phaseIds: ['draft'],
  inputs: [],
  outputs: [{ portId: 'out', label: 'Out', type: 'markdown' }],
  bindings: [{ kind: 'output', phaseIndex: 0, portId: 'out', outputKey: 'draft' }]
};
/** The second leg declares the input port the connection arrives at. */
const SECOND_PIPELINE = {
  pipelineId: 'second-leg',
  name: 'Second leg',
  version: 1,
  phaseIds: ['review'],
  inputs: [{ portId: 'in', label: 'In', type: 'text', required: true }],
  outputs: [],
  bindings: [
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'draft',
      source: { from: 'pipeline-input', portId: 'in' }
    }
  ]
};

/** A Workflow of two nodes joined by one unconditional connection. */
const TWO_NODE_WORKFLOW = {
  workflowId: 'two-legs',
  name: 'Two legs',
  version: 1,
  startNodeIds: ['first'],
  nodes: [
    { nodeId: 'first', pipelineId: 'first-leg' },
    { nodeId: 'second', pipelineId: 'second-leg' }
  ],
  connections: [{ from: { nodeId: 'first', portId: 'out' }, to: { nodeId: 'second', portId: 'in' } }]
};

const INLINE_CASES: Readonly<Record<string, ExportCase>> = {
  'inline: Phase with a mapping value model: ollama:llama3': {
    phases: [COLON_MODEL_PHASE],
    request: { resourceKind: 'phase', resourceId: 'colon-model' }
  },
  'inline: Pipeline with executionDefaults': {
    phases: [DRAFT_PHASE, REVIEW_PHASE],
    pipelines: [DEFAULTS_PIPELINE],
    request: {
      resourceKind: 'pipeline',
      resourceId: 'with-defaults',
      inclusion: 'include-referenced'
    }
  },
  'inline: Workflow with one connection': {
    phases: [DRAFT_PHASE, REVIEW_PHASE],
    pipelines: [FIRST_PIPELINE, SECOND_PIPELINE],
    workflows: [TWO_NODE_WORKFLOW],
    request: {
      resourceKind: 'workflow',
      resourceId: 'two-legs',
      inclusion: 'include-closure'
    }
  },
  'inline: Model Catalog': {
    models: { claude: ['claude-sonnet-5-5'], ollama: ['llama3'] },
    request: { resourceKind: 'modelCatalog' }
  }
};

const EXAMPLE_CASES: Readonly<Record<string, () => ExportCase>> = {
  'example: speckit-bugfix.pipeline.yaml': () => pipelineExample('speckit-bugfix.pipeline.yaml'),
  'example: speckit-new-feature.pipeline.yaml': () =>
    pipelineExample('speckit-new-feature.pipeline.yaml'),
  'example: example-two-node.workflow.yaml': () => workflowExample('example-two-node.workflow.yaml'),
  'example: model-catalog.yaml': () => modelCatalogExample('model-catalog.yaml')
};

describe('Feature 254 — ordinary exports keep their bytes (Q-T3, Q6, FR-011)', () => {
  const cases: ReadonlyArray<readonly [string, () => ExportCase]> = [
    ...Object.entries(EXAMPLE_CASES),
    ...Object.entries(INLINE_CASES).map(([name, exportCase]) => [name, () => exportCase] as const)
  ];

  it('pins one digest per case, and every case has one', () => {
    expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(EXPECTED_DIGESTS).sort());
  });

  it.each(cases)('%s exports the bytes it exported at baseline', (name, build) => {
    const text = exportedText(build());
    expect(text.length).toBeGreaterThan(0);
    expect(digestOf(text)).toBe(EXPECTED_DIGESTS[name]);
  });

  // The premise of the whole file: none of these exports holds a plain sequence item
  // that the scanner would read as a key, the one shape feature 254 changes. If one
  // did, a changed digest would be the intended change and not a defect.
  const PLAIN_KEYED_ITEM = /^[ \t]*- [^"' \r\n]*:[^ \r\n]/m;

  it('finds a plain keyed-looking sequence item when one is planted (control)', () => {
    expect(PLAIN_KEYED_ITEM.test('models:\n  - ollama:llama3\n')).toBe(true);
    expect(PLAIN_KEYED_ITEM.test('models:\n  - "ollama:llama3"\n')).toBe(false);
    expect(PLAIN_KEYED_ITEM.test('inputs:\n  - portId: brief\n')).toBe(false);
    expect(PLAIN_KEYED_ITEM.test('connections:\n  - from:\n      nodeId: a\n')).toBe(false);
  });

  it.each(cases)('%s holds no plain keyed-looking sequence item', (_name, build) => {
    expect(PLAIN_KEYED_ITEM.test(exportedText(build()))).toBe(false);
  });

  it('keeps a mapping value shaped like a keyed item plain (FR-011)', () => {
    const text = exportedText(INLINE_CASES['inline: Phase with a mapping value model: ollama:llama3']!);
    expect(text).toContain('model: ollama:llama3');
    expect(text).not.toContain('model: "ollama:llama3"');
  });
});
