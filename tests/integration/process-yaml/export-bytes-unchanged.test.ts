// Feature 254 (FR-R4-F07, T006/T007, contract Q-T3, Q6; FR-011, US2 AS3) — an
// ordinary export is byte-identical before and after the sequence-item quoting
// change.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { modelsConfigFromGroups } from '../../../src/config/model-catalog';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { ExportProcessYamlRequest } from '../../../src/contracts/sidebar-ipc/process-yaml';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { selectProcessExportDocument } from '../../../src/services/process-yaml/export-service';
import { parseModelCatalogDocument } from '../../../src/services/process-yaml/model-catalog-yaml-mapper';
import { phaseDefinitionFromDocument } from '../../../src/services/process-yaml/phase-yaml-mapper';
import type { ExchangeDeps } from '../../../src/services/process-yaml/service-ports';
import type { YamlMappingNode } from '../../../src/services/process-yaml/types';
import { parseWorkflowPackage } from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

const EXPECTED_DIGESTS: Readonly<Record<string, string>> = {
  'example: example-two-node.workflow.yaml':
    '8a398f5b96dc30ef19165088357669f528186600c7cbc6794691a1b850ff177e',
  'example: model-catalog.yaml':
    'f727213b8b19d7013373b07e0d37d935a162ca290ab2e00fd85f1a556d4cbb01',
  'inline: Phase with a mapping value model: ollama:llama3':
    '8d56f8d1831f6de47374dc256296368f58e7261e95cf3e116b95c42a40c3cfc5',
  'inline: Model Catalog':
    'a9bc446a214bcdbb7a75d0090bf9086a97fe95aeb08816f6f21653773e439d34'
};

interface ExportCase {
  readonly phases?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  readonly models?: Readonly<Record<string, readonly string[]>>;
  readonly request: ExportProcessYamlRequest;
}

function depsOf(exportCase: ExportCase): ExchangeDeps {
  return {
    readPhaseConfig: () => ({ rows: exportCase.phases ?? [], revision: FIXTURE_REVISION }),
    readWorkflowConfig: () => ({ rows: exportCase.workflows ?? [], revision: FIXTURE_REVISION }),
    readModelsConfig: () => ({ ...(exportCase.models ?? {}) }),
    logger: { sanitize: (value: string) => value, warn: () => undefined }
  };
}

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

function readExample(name: string): string {
  return readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');
}

function parsedRoot(name: string): YamlMappingNode {
  const parsed = parseDocumentText(readExample(name));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.refusal.code}: ${parsed.refusal.message}`);
  return parsed.node;
}

function workflowExample(name: string): ExportCase {
  const root = parsedRoot(name);
  const result = parseWorkflowPackage(root);
  if (!result.ok) throw new Error(`${name}: ${result.refusal.code}: ${result.refusal.message}`);
  const phases: PhaseDefinition[] = [];
  const workflows: WorkflowDefinition[] = [];
  for (const resource of result.resources) {
    if (!resource.ok) throw new Error(`${name}: invalid ${resource.resourceKind}`);
    if (resource.resourceKind === 'workflow') workflows.push(resource.definition);
    else phases.push(phaseDefinitionFromDocument(resource.document));
  }
  const rootWorkflow = workflows.at(0);
  if (rootWorkflow === undefined) throw new Error(`${name}: no root Workflow`);
  return {
    phases,
    workflows,
    request: {
      resourceKind: 'workflow',
      resourceId: rootWorkflow.workflowId,
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

const COLON_MODEL_PHASE = {
  phaseId: 'colon-model',
  name: 'Colon model',
  version: 1,
  instruction: 'Summarize the change.',
  model: 'ollama:llama3',
  effort: 'high'
};

const INLINE_CASES: Readonly<Record<string, ExportCase>> = {
  'inline: Phase with a mapping value model: ollama:llama3': {
    phases: [COLON_MODEL_PHASE],
    request: { resourceKind: 'phase', resourceId: 'colon-model' }
  },
  'inline: Model Catalog': {
    models: { claude: ['claude-sonnet-5-5'], ollama: ['llama3'] },
    request: { resourceKind: 'modelCatalog' }
  }
};

const EXAMPLE_CASES: Readonly<Record<string, () => ExportCase>> = {
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
    const text = exportedText(
      INLINE_CASES['inline: Phase with a mapping value model: ollama:llama3']!
    );
    expect(text).toContain('model: ollama:llama3');
    expect(text).not.toContain('model: "ollama:llama3"');
  });
});
