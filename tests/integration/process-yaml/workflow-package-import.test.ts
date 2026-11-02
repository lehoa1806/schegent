// Feature 086 T049/T050 / Feature 263 (FR-R5-F04) — the confirmed Workflow package
// write, as one ordered two-layer (`phase`, `workflow`) lifecycle publication.
//
// 085 established that a package writing two catalogs cannot be one atomic
// operation. Under FR-R5-F04 (`Pipeline` retired; composable Workflows in
// `included.workflows` and `included.phases`), a Workflow package writes up to
// TWO catalogs (`phase`, then `workflow`), and the three properties hold:
//
//   ordered      — Phases, then Workflows (FR-035). Checked BEHAVIORALLY: a layer
//                  resolves its references against what the publication is about
//                  to make live, so a Workflow published ahead of its Phases or
//                  child Workflows is a refusal naming the missing dependency.
//   independent  — each layer carries its own `expectedRevision` (FR-036), so a
//                  kind that moved under the operator is named, and named before
//                  anything is written.
//   irreversible — a failed publication leaves what landed written, with NO
//                  compensating delete (FR-038, FR-039). Nothing is undone, and
//                  re-running the same document undoes nothing either: every
//                  definition already written is found present at whatever state
//                  it reached and planned as a skip (FR-044).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/workflow-package-import' },
    name: 'workflow-package-import',
    index: 0
  })
}));

import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML, CMD_PUBLISH_PACKAGE } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  PublishPackageCommand
} from '../../../src/contracts/sidebar-ipc';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { publishDefinitionPackage } from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { FakeCatalogStore, NO_WRITES, tokenFor, writesOf } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';

/** The catalog each write targets, and the order the two occur in (FR-035, FR-R5-F04). */
type LayerKey = 'phases' | 'workflows';

const LAYER_ORDER: readonly LayerKey[] = ['phases', 'workflows'];

const KIND_OF: Readonly<Record<LayerKey, 'phase' | 'workflow'>> = {
  phases: 'phase',
  workflows: 'workflow'
};

const KEY_OF: Readonly<Record<CatalogKind, LayerKey>> = {
  phase: 'phases',
  pipeline: 'workflows',
  workflow: 'workflows'
};

/** Both writable catalogs, behind the one store a package write goes through. */
interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(
  seed: {
    readonly phases?: readonly unknown[];
    readonly workflows?: readonly unknown[];
  } = {}
): Installation {
  return {
    store: new FakeCatalogStore({
      phases: seed.phases ?? [],
      workflows: seed.workflows ?? []
    })
  };
}

function rowsOf(inst: Installation, key: LayerKey): readonly unknown[] {
  return inst.store.rowsOf(KIND_OF[key]);
}

/**
 * The read seams every handler in this file shares, wired to one store.
 */
function catalogDeps(store: FakeCatalogStore): Record<string, unknown> {
  const layer = (kind: 'phase' | 'workflow') => () => ({
    rows: store.rowsOf(kind),
    revision: store.revisionOf(kind),
    ids: new Set(store.idsOf(kind))
  });
  return {
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: layer('phase'),
    readWorkflowConfig: layer('workflow')
  };
}

/**
 * Someone else writes a catalog between the preview and the confirm.
 */
async function concurrentWrite(
  inst: Installation,
  key: LayerKey,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const kind = KIND_OF[key];
  const written = await inst.store.saveDraftLayer({
    kind,
    expectedRevision: inst.store.revisionOf(kind),
    definitions: rows.map((row) => ({
      id: (row.id ?? row.workflowId) as string,
      body: row
    }))
  });
  expect(written.outcome).toBe('saved');
  const published = await inst.store.publishLayer({
    kind,
    ids: rows.map((row) => (row.id ?? row.workflowId) as string),
    expectedRevision: inst.store.revisionOf(kind)
  });
  expect(published.outcome).toBe('published');
}

const CORRELATION = 'workflow-package-import-1';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One `included.*` entry at the indent the emitter writes it, for either kind. */
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

/** Two child Workflow nodes, one connection between them, one start. */
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
  '      nodeId: review',
  '      portId: spec',
  'startNodeIds:',
  '  - draft'
];

const INCLUDED_SPEC_AUTHORING = includedResource(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  [
    'outputs:',
    '  - portId: spec-document',
    '    label: Spec',
    '    type: markdown',
    '    required: false',
    'nodes:',
    '  - nodeId: step',
    '    kind: phase',
    '    phaseId: specify',
    'startNodeIds:',
    '  - step'
  ]
);

const INCLUDED_SPEC_REVIEW = includedResource(
  ['id: spec-review', 'name: Spec Review', 'version: 1'],
  [
    'inputs:',
    '  - portId: spec',
    '    label: Spec',
    '    type: text',
    '    required: false',
    'nodes:',
    '  - nodeId: step',
    '    kind: phase',
    '    phaseId: specify',
    'startNodeIds:',
    '  - step'
  ]
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

/**
 * Self-contained: every child Workflow the root's nodes name, and every Phase those
 * child Workflows name, is supplied by the same document. `specify`, `spec-authoring`,
 * and `spec-review` are free ids — the built-ins are all `speckit-` prefixed — so
 * nothing here resolves by accident.
 */
const SELF_CONTAINED = workflowDocument({
  workflows: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
  phases: [INCLUDED_SPECIFY]
});

/**
 * The root names a child Workflow the document does not supply and no layer holds, so
 * the root is `blocked` while its included child Workflow and Phase stay eligible.
 */
const BLOCKED_ROOT = workflowDocument({
  spec: [
    'nodes:',
    '  - nodeId: draft',
    '    kind: workflow',
    '    workflowId: spec-authoring',
    '  - nodeId: polish',
    '    kind: workflow',
    '    workflowId: no-such-workflow',
    'startNodeIds:',
    '  - draft'
  ],
  workflows: [INCLUDED_SPEC_AUTHORING],
  phases: [INCLUDED_SPECIFY]
});

/**
 * References only: the root names a child Workflow it does not carry. Nothing is written
 * to the Phase layer, which proves the write count follows what the document declares
 * rather than a fixed two.
 */
const REFERENCES_ONLY = workflowDocument({
  spec: [
    'nodes:',
    '  - nodeId: draft',
    '    kind: workflow',
    '    workflowId: spec-authoring',
    'startNodeIds:',
    '  - draft'
  ]
});

const HELD_PHASE = Object.freeze({
  id: 'held',
  name: 'Held',
  version: 4,
  instruction: 'Hold.'
});

const HELD_WORKFLOW = Object.freeze({
  workflowId: 'held-flow',
  name: 'Held Flow',
  version: 5,
  nodes: [{ nodeId: 'only', kind: 'phase', phaseId: 'held' }],
  connections: [],
  startNodeIds: ['only']
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit — the webview's translation, mirrored
// ---------------------------------------------------------------------------

/** Only `import` rows are written; `skip`, `blocked`, and `invalid` are not (FR-044). */
function imported<T>(plan: ImportPlan, kind: 'phase' | 'workflow'): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
    }
  }
  return definitions;
}

const importedPhases = (plan: ImportPlan) => imported<PhaseDefinition>(plan, 'phase');
const importedWorkflows = (plan: ImportPlan) => imported<WorkflowDefinition>(plan, 'workflow');

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

/**
 * The one command the confirmation sends, with a layer per kind the plan imports.
 */
function packageCommand(plan: ImportPlan): PublishPackageCommand {
  const phases = importedPhases(plan);
  const workflows = importedWorkflows(plan);
  const layers: PublishPackageCommand['payload']['layers'][number][] = [];

  if (phases.length > 0) {
    layers.push({
      kind: 'phase',
      expectedRevision: plan.computedAgainstRevision,
      definitions: phases.map((definition) => ({
        id: definition.phaseId,
        body: phaseRow(definition)
      }))
    });
  }

  if (workflows.length > 0) {
    const revision = plan.computedAgainstWorkflowRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'workflow',
      expectedRevision: revision!,
      definitions: workflows.map((definition) => ({
        id: definition.workflowId,
        body: workflowRow(definition)
      }))
    });
  }

  return { type: CMD_PUBLISH_PACKAGE, correlationId: CORRELATION, payload: { layers } };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  /** Layers pass 1 sent a draft write for, in the order the store saw them. */
  readonly drafted: readonly LayerKey[];
  /** Layers pass 2 sent a publication for, in the order the store saw them. */
  readonly published: readonly LayerKey[];
  readonly outcome: 'imported' | 'partial' | 'failed';
}

function outcomeOf(ack: CommandAckMessage): CommitRun['outcome'] {
  if (ack.status === 'accepted') return 'imported';
  return ack.reason === 'package-partial' ? 'partial' : 'failed';
}

/** Which pass of which layer the store should refuse, for the partial cases. */
interface FailPoint {
  readonly key: LayerKey;
  readonly pass: 'draft' | 'publish';
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  opts: { readonly failOn?: FailPoint; readonly command?: PublishPackageCommand } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      catalogLifecycle: fakeCatalogLifecycle(inst.store),
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;

  if (opts.failOn !== undefined) {
    const kind = KIND_OF[opts.failOn.key];
    const refusal = { outcome: 'refused' as const, reason: 'not-writable' as const, id: null };
    if (opts.failOn.pass === 'draft') inst.store.draftLayerVerdicts.set(kind, refusal);
    else inst.store.publishLayerVerdicts.set(kind, refusal);
  }

  const draftsBefore = inst.store.draftLayerSaves.length;
  const publishesBefore = inst.store.publishLayers.length;

  await publishDefinitionPackage(ctx, opts.command ?? packageCommand(plan));

  expect(acks).toHaveLength(1);
  const ack = acks[0]!;

  const layersOf = <T extends { readonly kind: CatalogKind }>(
    requests: readonly T[],
    from: number
  ): readonly LayerKey[] => requests.slice(from).map((request) => KEY_OF[request.kind]);

  return {
    ack,
    drafted: layersOf(inst.store.draftLayerSaves, draftsBefore),
    published: layersOf(inst.store.publishLayers, publishesBefore),
    outcome: outcomeOf(ack)
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function phaseContext(inst: Installation) {
  return resolvePhaseCatalog({
    rows: inst.store.rowsOf('phase'),
    revision: inst.store.revisionOf('phase')
  });
}

function effectivePhaseIds(inst: Installation): readonly string[] {
  return phaseContext(inst).effective.map((definition) => definition.phaseId);
}

function effectiveWorkflowIds(inst: Installation): readonly string[] {
  const phase = phaseContext(inst);
  return resolveWorkflowCatalog({
    rows: inst.store.rowsOf('workflow'),
    revision: inst.store.revisionOf('workflow'),
    phaseCatalog: { effective: phase.effective, records: phase.records }
  }).effective.map((definition) => definition.workflowId);
}

function snapshot(inst: Installation): string {
  return JSON.stringify({
    phases: inst.store.rowsOf('phase'),
    workflows: inst.store.rowsOf('workflow')
  });
}

beforeEach(() => capabilities.clear());

describe('Feature 086 T049 / Feature 263 — the ordered two-layer write', () => {
  it('publishes the two catalogs in dependency order (FR-035, SC-013)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan);

    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual(['phases', 'workflows']);
    expect(run.outcome).toBe('imported');
    expect(run.ack.result).toEqual({
      published: [
        { kind: 'phase', ids: ['specify'], total: 1 },
        { kind: 'workflow', ids: ['spec-authoring', 'spec-review', 'ship-it-flow'], total: 3 }
      ]
    });
    expect(effectiveWorkflowIds(inst)).toEqual(
      expect.arrayContaining(['ship-it-flow', 'spec-authoring', 'spec-review'])
    );
  });

  it('publishes in rank order even when the request lists the Workflow layer first (FR-035)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const reversed: PublishPackageCommand = {
      ...sent,
      payload: { layers: [...sent.payload.layers].reverse() }
    };
    expect(reversed.payload.layers.map((layer) => layer.kind)).toEqual(['workflow', 'phase']);

    const run = await commitPackage(inst, plan, { command: reversed });

    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual(['phases', 'workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('validates the root and child Workflows against the candidates arriving with them (FR-017)', async () => {
    const inst = installation();
    expect(effectiveWorkflowIds(inst)).not.toContain('spec-authoring');
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectiveWorkflowIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review', 'ship-it-flow'])
    );
  });

  it('refuses the root Workflow when its child Workflows are omitted from the request (FR-017)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const rootOnly: PublishPackageCommand = {
      ...sent,
      payload: {
        layers: sent.payload.layers.map((layer) =>
          layer.kind === 'workflow'
            ? {
                ...layer,
                definitions: layer.definitions.filter((def) => def.id === 'ship-it-flow')
              }
            : layer
        )
      }
    };

    const run = await commitPackage(inst, plan, { command: rootOnly });

    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'validation-failed' });
    const detail = run.ack.result as {
      readonly kind: string | null;
      readonly defects: readonly { readonly kind: string; readonly code: string }[];
    };
    expect(detail.kind).toBeNull();
    expect(detail.defects.map((defect) => defect.code)).toContain('unknown-workflow');
    expect(detail.defects.every((defect) => defect.kind === 'workflow')).toBe(true);
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
  });

  it('leaves the Workflow layer unpublished when the Phase publication is refused (FR-035)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'phases', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual(['phases']);
    expect(run.ack.result).toMatchObject({
      published: [],
      draftedOnly: ['phase', 'workflow'],
      failedKind: 'phase',
      cause: 'not-writable'
    });
    expect(effectivePhaseIds(inst)).toEqual([]);
    expect(effectiveWorkflowIds(inst)).toEqual([]);
    expect(inst.store.stateOf('workflow', 'ship-it-flow')).toBe('draft');
  });

  it('writes only the `import` rows, leaving `skip` untouched (FR-044)', async () => {
    const MINE = Object.freeze({
      id: 'specify',
      name: 'My Specify',
      version: 41,
      instruction: 'Mine, not the document.'
    });
    const inst = installation({ phases: [HELD_PHASE, MINE] });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 3, skip: 1, blocked: 0, invalid: 0 });

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    expect(inst.store.rowsOf('phase')).toEqual([HELD_PHASE, MINE]);
    expect(run.drafted).toEqual(['workflows']);
    expect(run.published).toEqual(['workflows']);
    expect(inst.store.rowsOf('workflow')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflowId: 'ship-it-flow', name: 'Ship It Flow', version: 3 })
      ])
    );
  });

  it('writes the eligible child Workflow and Phase rows even though the root Workflow is blocked', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 2, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan);

    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual(['phases', 'workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectiveWorkflowIds(inst)).toEqual(['spec-authoring']);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      reason: { code: 'dependency-absent' }
    });
  });

  it('publishes only the catalogs the document declared, never a fixed two', async () => {
    const seed = installation();
    const seedPlan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({
      phases: importedPhases(seedPlan).map(phaseRow),
      workflows: importedWorkflows(seedPlan)
        .filter((wf) => wf.workflowId !== 'ship-it-flow')
        .map(workflowRow)
    });
    const beforePhases = inst.store.revisionOf('phase');

    const plan = await planFor(inst, REFERENCES_ONLY);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 0, invalid: 0 });
    expect(plan.computedAgainstWorkflowRevision).toBeDefined();

    const run = await commitPackage(inst, plan);

    expect(run.drafted).toEqual(['workflows']);
    expect(run.published).toEqual(['workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
    expect(inst.store.revisionOf('phase')).toBe(beforePhases);
  });

  it('carries one expected revision per writable target (FR-036)', async () => {
    const inst = installation({
      phases: [HELD_PHASE],
      workflows: [HELD_WORKFLOW]
    });
    const plan = await planFor(inst, SELF_CONTAINED);

    for (const revision of [plan.computedAgainstRevision, plan.computedAgainstWorkflowRevision]) {
      expect(typeof revision).toBe('string');
      expect(revision as string).not.toBe('');
    }
    expect(plan).not.toHaveProperty('computedAgainstPipelineRevision');

    const layers = packageCommand(plan).payload.layers;
    expect(layers.map((layer) => KEY_OF[layer.kind])).toEqual(LAYER_ORDER);
    expect(new Set(layers.map((layer) => layer.expectedRevision)).size).toBe(2);

    expect(layers.map((layer) => layer.definitions.map((definition) => definition.id))).toEqual([
      ['specify'],
      ['ship-it-flow', 'spec-authoring', 'spec-review']
    ]);
  });

  it('names no destination, in the plan or in any request built from it (FR-047)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    expect(plan).not.toHaveProperty('scope');
    const command = packageCommand(plan);
    expect(command.payload).not.toHaveProperty('scope');
    expect(command.payload.layers).toHaveLength(2);
    for (const layer of command.payload.layers) {
      expect(layer).not.toHaveProperty('scope');
    }

    const run = await commitPackage(inst, plan, { command });

    expect(run.outcome).toBe('imported');
    expect(inst.store.rowsOf('workflow')).toHaveLength(3);
  });

  it('appends to each catalog and rewrites nothing that was there', async () => {
    const inst = installation({
      phases: [HELD_PHASE],
      workflows: [HELD_WORKFLOW]
    });
    const before = JSON.parse(snapshot(inst)) as Record<LayerKey, readonly unknown[]>;

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan);
    expect(run.outcome).toBe('imported');

    for (const key of LAYER_ORDER) {
      expect(rowsOf(inst, key).slice(0, before[key].length)).toEqual(before[key]);
    }
    expect(rowsOf(inst, 'phases')).toHaveLength(before.phases.length + 1);
    expect(rowsOf(inst, 'workflows')).toHaveLength(before.workflows.length + 3);
  });

  it('refuses the whole package when the Phase catalog changed since preflight (FR-036)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    await concurrentWrite(inst, 'phases', [
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ]);
    const before = snapshot(inst);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.ack.result).toEqual({ kind: 'phase' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    expect(snapshot(inst)).toBe(before);
  });

  it('refuses the whole package when only the Workflow catalog changed (FR-036)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    await concurrentWrite(inst, 'workflows', [HELD_WORKFLOW as Record<string, unknown>]);
    const before = snapshot(inst);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.ack.result).toEqual({ kind: 'workflow' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    expect(snapshot(inst)).toBe(before);
    expect(inst.store.rowsOf('workflow')).toEqual([HELD_WORKFLOW]);
  });

  it('reports staleness rather than the denied capability (FR-036)', async () => {
    capabilities.set('phases', false);
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await concurrentWrite(inst, 'phases', [HELD_PHASE as Record<string, unknown>]);
    const drafts = inst.store.draftLayerSaves.length;
    const publishes = inst.store.publishLayers.length;

    const run = await commitPackage(inst, plan);

    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    expect(inst.store.draftLayerSaves).toHaveLength(drafts);
    expect(inst.store.publishLayers).toHaveLength(publishes);
  });
});

describe('Feature 086 T050 / Feature 263 — a partial write stays partial', () => {
  it('leaves the Phase layer drafted when the Workflow draft fails (FR-037, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'workflows', pass: 'draft' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual([]);
    expect(run.ack.result).toEqual({
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'workflow',
      cause: 'not-writable'
    });
    expect(inst.store.stateOf('phase', 'specify')).toBe('draft');
    expect(effectivePhaseIds(inst)).toEqual([]);
    expect(inst.store.idsOf('workflow')).toEqual([]);
  });

  it('leaves the Phases live when the Workflow publication fails (FR-038, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'workflows', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'workflows']);
    expect(run.published).toEqual(['phases', 'workflows']);
    expect(run.ack.result).toEqual({
      published: [{ kind: 'phase', total: 1 }],
      draftedOnly: ['workflow'],
      failedKind: 'workflow',
      cause: 'not-writable'
    });
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectiveWorkflowIds(inst)).toEqual([]);
    expect(inst.store.stateOf('workflow', 'ship-it-flow')).toBe('draft');
  });

  it('identifies which catalogs landed, for either shape (FR-037)', async () => {
    const landed = (run: CommitRun) =>
      (run.ack.result as { readonly published: readonly { readonly kind: string }[] }).published.map(
        (layer) => layer.kind
      );
    const waiting = (run: CommitRun) =>
      (run.ack.result as { readonly draftedOnly: readonly string[] }).draftedOnly;

    const inPassOne = installation();
    const inPassTwo = installation();
    const [atDraft, atPublish] = [
      await commitPackage(inPassOne, await planFor(inPassOne, SELF_CONTAINED), {
        failOn: { key: 'workflows', pass: 'draft' }
      }),
      await commitPackage(inPassTwo, await planFor(inPassTwo, SELF_CONTAINED), {
        failOn: { key: 'workflows', pass: 'publish' }
      })
    ];

    expect(atDraft.outcome).toBe('partial');
    expect(landed(atDraft)).toEqual([]);
    expect(waiting(atDraft)).toEqual(['phase']);
    expect(atPublish.outcome).toBe('partial');
    expect(landed(atPublish)).toEqual(['phase']);
    expect(waiting(atPublish)).toEqual(['workflow']);
  });

  it('performs zero compensating deletions on either partial path (FR-038)', async () => {
    for (const failOn of [
      { key: 'workflows', pass: 'draft' },
      { key: 'workflows', pass: 'publish' }
    ] as const satisfies readonly FailPoint[]) {
      const inst = installation({
        phases: [HELD_PHASE],
        workflows: [HELD_WORKFLOW]
      });
      const plan = await planFor(inst, SELF_CONTAINED);

      const run = await commitPackage(inst, plan, { failOn });

      expect(run.outcome).toBe('partial');
      expect(new Set(run.drafted).size).toBe(run.drafted.length);
      expect(new Set(run.published).size).toBe(run.published.length);
      expect(inst.store.rowsOf('phase')[0]).toEqual(HELD_PHASE);
      expect(inst.store.rowsOf('workflow')[0]).toEqual(HELD_WORKFLOW);
      expect(inst.store.idsOf('phase')).toContain('specify');
    }
  });

  it('needs no cleanup after a pass-1 failure, and the drafted Phase unblocks the rest (FR-039)', async () => {
    const inst = installation();
    const first = await commitPackage(inst, await planFor(inst, SELF_CONTAINED), {
      failOn: { key: 'workflows', pass: 'draft' }
    });
    expect(first.outcome).toBe('partial');

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 0, skip: 1, blocked: 3, invalid: 0 });
    expect(plan.rows.filter((row) => row.outcome === 'skip')).toEqual([
      expect.objectContaining({ resourceKind: 'phase', resourceId: 'specify' })
    ]);
    expect(
      plan.rows
        .filter((row) => row.outcome === 'blocked')
        .map((row) => [row.resourceId, row.outcome === 'blocked' ? row.reason.code : null])
    ).toEqual([
      ['ship-it-flow', 'dependency-blocked'],
      ['spec-authoring', 'dependency-absent'],
      ['spec-review', 'dependency-absent']
    ]);

    const stalled = await commitPackage(inst, plan);
    expect(stalled.outcome).toBe('imported');
    expect(stalled.ack.result).toEqual({ published: [] });
    expect(stalled.drafted).toEqual([]);
    expect(stalled.published).toEqual([]);
    expect(effectivePhaseIds(inst)).toEqual([]);

    const lifecycle = fakeCatalogLifecycle(inst.store);
    const published = await lifecycle.publish({
      kind: 'phase',
      id: 'specify',
      expectedDraftVersion: tokenFor(inst.store, 'phase', 'specify')
    });
    expect(published.outcome).toBe('published');

    const replan = await planFor(inst, SELF_CONTAINED);
    expect(replan.counts).toEqual({ import: 3, skip: 1, blocked: 0, invalid: 0 });
    const second = await commitPackage(inst, replan);
    expect(second.outcome).toBe('imported');
    expect(second.published).toEqual(['workflows']);
    expect(inst.store.rowsOf('phase')).toHaveLength(1);
    expect(effectiveWorkflowIds(inst)).toEqual(
      expect.arrayContaining(['ship-it-flow', 'spec-authoring', 'spec-review'])
    );
  });

  it('needs no cleanup after a pass-2 failure, and re-running writes nothing twice (FR-039)', async () => {
    const inst = installation();
    const first = await commitPackage(inst, await planFor(inst, SELF_CONTAINED), {
      failOn: { key: 'workflows', pass: 'publish' }
    });
    expect(first.outcome).toBe('partial');

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 0, skip: 4, blocked: 0, invalid: 0 });

    const second = await commitPackage(inst, plan);

    expect(second.outcome).toBe('imported');
    expect(second.ack.result).toEqual({ published: [] });
    expect(second.drafted).toEqual([]);
    expect(second.published).toEqual([]);
    expect(inst.store.rowsOf('phase')).toHaveLength(1);
    expect(inst.store.rowsOf('workflow')).toHaveLength(0);

    const lifecycle = fakeCatalogLifecycle(inst.store);
    for (const id of ['spec-authoring', 'spec-review', 'ship-it-flow']) {
      const published = await lifecycle.publish({
        kind: 'workflow',
        id,
        expectedDraftVersion: tokenFor(inst.store, 'workflow', id)
      });
      expect(published.outcome).toBe('published');
    }
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('re-running a fully imported document writes nothing at all (FR-039)', async () => {
    const inst = installation();
    expect((await commitPackage(inst, await planFor(inst, SELF_CONTAINED))).outcome).toBe(
      'imported'
    );
    const settled = snapshot(inst);
    const writesBefore = writesOf(inst.store);

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 0, skip: 4, blocked: 0, invalid: 0 });

    const again = await commitPackage(inst, plan);

    expect(again.drafted).toEqual([]);
    expect(again.published).toEqual([]);
    expect(again.outcome).toBe('imported');
    expect(again.ack.result).toEqual({ published: [] });
    expect(snapshot(inst)).toBe(settled);
    expect(writesOf(inst.store)).toEqual(writesBefore);
  });
});
