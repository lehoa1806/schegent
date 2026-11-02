// Feature 086 T031/T033 / Feature 263 (FR-R5-F04) — Workflow package preflight,
// end to end through the sidebar command.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { DEFECT_FIELD_MAX } from '../../../src/services/process-yaml/phase-yaml-validator';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { FakeCatalogStore, NO_WRITES, writesOf } from '../../fixtures/fake-catalog-store';

type OpenResult =
  | { outcome: 'read'; bytes: Uint8Array }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; message: string };

const SEEDED_PHASE_REVISION = 'rev-phase-workflow-preflight';
const SEEDED_PIPELINE_REVISION = 'rev-pipeline-workflow-preflight';
const SEEDED_WORKFLOW_REVISION = 'rev-workflow-preflight';

interface Harness {
  readonly ctx: Parameters<typeof preflightHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly warnings: string[];
  readonly store: FakeCatalogStore;
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    text?: string;
    bytes?: Uint8Array;
    workflows?: readonly unknown[];
    phases?: readonly unknown[];
    sanitize?: (value: string) => string;
    open?: OpenResult;
    openThrows?: Error;
    withOpenAdapter?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const store = new FakeCatalogStore({
    revisions: {
      phase: SEEDED_PHASE_REVISION,
      pipeline: SEEDED_PIPELINE_REVISION,
      workflow: SEEDED_WORKFLOW_REVISION
    }
  });
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

  const openProcessYamlDocument = async (): Promise<OpenResult> => {
    if (opts.openThrows) throw opts.openThrows;
    return (
      opts.open ?? {
        outcome: 'read',
        bytes: opts.bytes ?? new Uint8Array(Buffer.from(opts.text ?? '', 'utf8'))
      }
    );
  };

  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: opts.phases ?? [],
        revision: store.revisionOf('phase')
      }),
      readPipelineConfig: () => ({
        rows: [],
        revision: store.revisionOf('pipeline')
      }),
      readWorkflowConfig: () => ({
        rows: opts.workflows ?? [],
        revision: store.revisionOf('workflow')
      }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
      updateConfig,
      executeCommand,
      ...(opts.withOpenAdapter === false ? {} : { openProcessYamlDocument }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: opts.sanitize ?? ((s: string) => s)
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'workflow-preflight-1'
  } as any;

  return {
    ctx,
    acks,
    warnings,
    store,
    updateConfig,
    executeCommand
  };
}

const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'workflow-preflight-1',
  payload: {}
});

function resultOf(h: Harness): PreflightProcessYamlResult {
  expect(h.acks).toHaveLength(1);
  return h.acks[0]!.result as PreflightProcessYamlResult;
}

async function preflight(opts: Parameters<typeof buildHarness>[0]): Promise<{
  readonly harness: Harness;
  readonly result: PreflightProcessYamlResult;
}> {
  const harness = buildHarness(opts);
  await preflightHandler(harness.ctx, COMMAND);
  return { harness, result: resultOf(harness) };
}

async function refusalOf(opts: Parameters<typeof buildHarness>[0]): Promise<{
  readonly code: string;
  readonly keys: readonly string[];
  readonly harness: Harness;
}> {
  const { harness, result } = await preflight(opts);
  expect(result.outcome).toBe('refused');
  if (result.outcome !== 'refused') throw new Error(`expected a refusal, got ${result.outcome}`);
  return { code: result.refusal.code, keys: Object.keys(result).sort(), harness };
}

const PHASE_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Phase',
  'metadata:',
  '  phaseId: ship-it-phase',
  '  name: Ship It Phase',
  '  version: 1',
  'spec:',
  '  instruction: Ship the thing.',
  ''
].join('\n');

const PIPELINE_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Pipeline',
  'metadata:',
  '  id: spec-authoring',
  '  name: Spec Authoring',
  '  version: 2',
  'spec:',
  '  phaseIds:',
  '    - ship-it-phase',
  ''
].join('\n');

function includedResource(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

const INCLUDED_SPEC_AUTHORING = includedResource(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  [
    'outputs:',
    '  - portId: spec-document',
    '    label: Spec',
    '    type: markdown',
    'nodes:',
    '  - nodeId: specify-node',
    '    kind: phase',
    '    phaseId: specify',
    'bindings:',
    '  - kind: output',
    '    nodeId: specify-node',
    '    portId: spec-document',
    '    outputKey: spec-document',
    'startNodeIds:',
    '  - specify-node'
  ]
);

const INCLUDED_SPEC_REVIEW = includedResource(
  ['id: spec-review', 'name: Spec Review', 'version: 1'],
  [
    'inputs:',
    '  - portId: spec',
    '    label: Spec',
    '    type: text',
    '    required: true',
    'nodes:',
    '  - nodeId: specify-node',
    '    kind: phase',
    '    phaseId: specify',
    'bindings:',
    '  - kind: input',
    '    nodeId: specify-node',
    '    inputKey: spec',
    '    source:',
    '      from: workflow-input',
    '      portId: spec',
    'startNodeIds:',
    '  - specify-node'
  ]
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

function workflowDocument(body: {
  readonly metadata?: readonly string[];
  readonly spec?: readonly string[];
  readonly workflows?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
}): string {
  const lines = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    ...(body.metadata ?? ['id: ship-it-flow', 'name: Ship It Flow', 'version: 3']).map(
      (line) => `  ${line}`
    ),
    'spec:',
    ...(body.spec ?? DEFAULT_SPEC).map((line) => `  ${line}`)
  ];
  if (body.workflows !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.workflows !== undefined) lines.push('  workflows:', ...body.workflows.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

const DEFAULT_SPEC = [
  'nodes:',
  '  - nodeId: draft',
  '    kind: workflow',
  '    workflowId: spec-authoring',
  '  - nodeId: review',
  '    kind: workflow',
  '    workflowId: spec-review',
  'connections:',
  '  - from:',
  '      nodeId: draft',
  '      portId: spec-document',
  '    to:',
  '      kind: node',
  '      nodeId: review',
  '      portId: spec',
  'bindings:',
  '  - kind: input',
  '    nodeId: review',
  '    inputKey: spec',
  '    source:',
  '      from: node-output',
  '      nodeId: draft',
  '      portId: spec-document',
  'startNodeIds:',
  '  - draft'
];

const PACKAGE_DOCUMENT = workflowDocument({
  metadata: [
    'id: ship-it-flow',
    'name: Ship It Flow',
    'version: 3',
    'description: Draft, then review.'
  ],
  workflows: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
  phases: [INCLUDED_SPECIFY]
});

describe('Feature 086 / 263 — the host dispatches on the declared kind', () => {
  it('carries no resource kind on the request', () => {
    expect(Object.keys(COMMAND.payload)).toEqual([]);
  });

  it('routes Workflow and Phase documents to their paths and refuses retired kind: Pipeline with unsupported-kind', async () => {
    const workflow = await preflight({ text: PACKAGE_DOCUMENT });
    expect(workflow.result.outcome).toBe('planned');
    if (workflow.result.outcome !== 'planned') return;
    expect(workflow.result.plan.rows.map((row) => row.resourceKind)).toEqual([
      'workflow',
      'workflow',
      'workflow',
      'phase'
    ]);

    const pipeline = await preflight({ text: PIPELINE_DOCUMENT });
    expect(pipeline.result.outcome).toBe('refused');
    if (pipeline.result.outcome === 'refused') {
      expect(pipeline.result.refusal.code).toBe('unsupported-kind');
    }

    const phase = await preflight({ text: PHASE_DOCUMENT });
    expect(phase.result.outcome).toBe('planned');
    if (phase.result.outcome !== 'planned') return;
    expect(phase.result.plan.rows.map((row) => row.resourceKind)).toEqual(['phase']);
  });

  it('writes nothing while planning a Workflow package (SC-008)', async () => {
    const { harness } = await preflight({ text: PACKAGE_DOCUMENT });

    expect(writesOf(harness.store)).toEqual(NO_WRITES);
    expect(harness.updateConfig).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });
});

describe('Feature 086 / 263 — an import row carries what the write will store', () => {
  it('carries the root Workflow definition verbatim', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;
    expect(root.definition).toEqual({
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 3,
      description: 'Draft, then review.',
      nodes: [
        { nodeId: 'draft', kind: 'workflow', workflowId: 'spec-authoring' },
        { nodeId: 'review', kind: 'workflow', workflowId: 'spec-review' }
      ],
      connections: [
        {
          from: { nodeId: 'draft', portId: 'spec-document' },
          to: { kind: 'node', nodeId: 'review', portId: 'spec' }
        }
      ],
      bindings: [
        {
          kind: 'input',
          nodeId: 'review',
          inputKey: 'spec',
          source: { from: 'node-output', nodeId: 'draft', portId: 'spec-document' }
        }
      ],
      startNodeIds: ['draft']
    });
  });

  it('sanitizes the rendered name and leaves the carried definition untouched', async () => {
    const { result } = await preflight({
      text: PACKAGE_DOCUMENT,
      sanitize: (value) => value.replaceAll('Ship', '[redacted]')
    });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;
    expect(root.name).toBe('[redacted] It Flow');
    expect(root.definition.name).toBe('Ship It Flow');
    expect(root.definition.workflowId).toBe('ship-it-flow');
  });

  it('reports one revision per catalog this plan can write (phase and workflow only)', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const revisions = [
      result.plan.computedAgainstRevision,
      result.plan.computedAgainstWorkflowRevision
    ];
    expect(revisions).toEqual([SEEDED_PHASE_REVISION, SEEDED_WORKFLOW_REVISION]);
    expect('computedAgainstPipelineRevision' in result.plan).toBe(false);
  });

  it('counts one bucket per outcome, summing to the row count (FR-028)', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const { counts, rows } = result.plan;
    expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
    expect(counts).toEqual({ import: 4, skip: 0, blocked: 0, invalid: 0 });
  });

  it('bounds a Workflow defect field to the width the Workflow family already uses', async () => {
    const withBadOperand = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    kind: workflow',
        '    workflowId: spec-authoring',
        '  - nodeId: review',
        '    kind: workflow',
        '    workflowId: spec-review',
        'connections:',
        '  - from:',
        '      nodeId: draft',
        '      portId: spec-document',
        '    to:',
        '      kind: node',
        '      nodeId: review',
        '      portId: spec',
        '    condition:',
        '      left:',
        '        source: guesswork',
        '        nodeId: draft',
        '      operator: equals',
        '      right: done',
        'startNodeIds:',
        '  - draft'
      ],
      workflows: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
      phases: [INCLUDED_SPECIFY]
    });

    const { result } = await preflight({ text: withBadOperand });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('invalid');
    if (root?.outcome !== 'invalid') return;
    expect(root.defects.map((defect) => defect.field)).toContain(
      'connections[0].condition.left.source'
    );
    for (const defect of root.defects) {
      expect(defect.field.length).toBeLessThanOrEqual(DEFECT_FIELD_MAX);
    }
  });
});

describe('Feature 086 T031 — a refused Workflow document produces no plan (FR-027)', () => {
  it('refuses a cycle in the authored graph', async () => {
    const cyclic = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    kind: workflow',
        '    workflowId: spec-authoring',
        '  - nodeId: review',
        '    kind: workflow',
        '    workflowId: spec-review',
        'connections:',
        '  - from:',
        '      nodeId: draft',
        '      portId: spec-document',
        '    to:',
        '      kind: node',
        '      nodeId: review',
        '      portId: spec',
        '  - from:',
        '      nodeId: review',
        '      portId: verdict',
        '    to:',
        '      kind: node',
        '      nodeId: draft',
        '      portId: notes',
        'startNodeIds:',
        '  - draft'
      ],
      workflows: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
      phases: [INCLUDED_SPECIFY]
    });

    const { code, keys, harness } = await refusalOf({ text: cyclic });

    expect(code).toBe('graph-cycle');
    expect(keys).toEqual(['outcome', 'refusal']);
    expect(harness.acks[0]!.status).toBe('rejected');
    expect(harness.acks[0]!.reason).toBe('refused');
    expect(writesOf(harness.store)).toEqual(NO_WRITES);
    expect(harness.updateConfig).not.toHaveBeenCalled();
  });

  it('refuses a document declaring one id twice, rather than letting one win', async () => {
    for (const text of [
      workflowDocument({ workflows: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_AUTHORING] }),
      workflowDocument({ phases: [INCLUDED_SPECIFY, INCLUDED_SPECIFY] })
    ]) {
      const { code, keys } = await refusalOf({ text });
      expect(code).toBe('duplicate-id');
      expect(keys).toEqual(['outcome', 'refusal']);
    }
  });

  it('decides too-large before the scanner is entered, so no oversized text is walked', async () => {
    const oversized = new Uint8Array(PHASE_YAML_MAX_BYTES + 1).fill(0x20);
    oversized.set(Buffer.from('apiVersion: schegent/v1\nkind: Workflow\n', 'utf8'));

    const { code, keys, harness } = await refusalOf({ bytes: oversized });
    expect(code).toBe('too-large');
    expect(keys).toEqual(['outcome', 'refusal']);
    expect(writesOf(harness.store)).toEqual(NO_WRITES);
  });
});

describe('Feature 086 T071 — a read failure reports generically (FR-057)', () => {
  const ADAPTER_DETAIL =
    'EACCES: permission denied, open /Users/someone/private/ship-it.schegent.yaml';
  const GENERIC = 'Could not read the document.';

  function failureOf(result: PreflightProcessYamlResult): string {
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error(`expected a failure, got ${result.outcome}`);
    expect(Object.keys(result).sort()).toEqual(['message', 'outcome']);
    return result.message;
  }

  it('discards the message the adapter reported', async () => {
    const { result, harness } = await preflight({
      open: { outcome: 'failed', message: ADAPTER_DETAIL }
    });

    expect(failureOf(result)).toBe(GENERIC);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('EACCES');
    expect(serialized).not.toContain('someone');
    expect(serialized).not.toMatch(/[/\\]/);
    expect(writesOf(harness.store)).toEqual(NO_WRITES);
  });

  it('builds every failure message from a literal, so none can interpolate a cause', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'src/ui/sidebar/commands/cmd-preflight-process-yaml.ts'),
      'utf8'
    );
    const sites = [...source.matchAll(/outcome: 'failed'/g)].length;
    const literals = [
      ...source.matchAll(/outcome: 'failed',\s*message: '[^'`$\\]+'/g)
    ].length;
    expect(sites).toBeGreaterThanOrEqual(2);
    expect(literals).toBe(sites);
  });
});
