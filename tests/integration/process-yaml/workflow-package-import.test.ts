// Feature 086 T049/T050 — the confirmed Workflow package write, as one ordered
// lifecycle publication.
//
// 085 established that a package writing two catalogs cannot be one atomic
// operation. A Workflow package writes THREE, so the same three properties hold
// with one more layer to be wrong about:
//
//   ordered      — Phases, then Pipelines, then the Workflow (FR-035). Checked
//                  BEHAVIORALLY: a layer resolves its references against what the
//                  publication is about to make live, so a Workflow published
//                  ahead of its Pipelines is a refusal naming the missing node
//                  Pipeline. A call-order assertion alone would pass on an
//                  implementation that happened to call them in order for no
//                  reason.
//   independent  — each layer carries its own `expectedRevision` (FR-036), so a
//                  kind that moved under the operator is named, and named before
//                  anything is written.
//   irreversible — a failed publication leaves what landed written, with NO
//                  compensating delete (FR-038, FR-039). Nothing is undone, and
//                  re-running the same document undoes nothing either: every
//                  definition already written is found present at whatever state
//                  it reached and planned as a skip (FR-044).
//
// Feature 099 (T496f, FR-042) — "three layers" used to mean three configuration
// keys, each with a user and a workspace layer, and a package write picked one
// scope for all three. The scope tier is deleted: there is one catalog per kind,
// so `scope` leaves every payload and the rows a proposal appends to are simply
// the rows the store holds. Every claim below is about the ORDER, the
// INDEPENDENCE, and the IRREVERSIBILITY of the three writes, and none of the
// three was ever a property of the scope.
//
// Feature 100 (T514, FR-035/FR-036/FR-039) — the three `CMD_SAVE_*` commands are
// deleted, and with them the driver that sent three of them and stopped at the
// first rejection. There is ONE command, `CMD_PUBLISH_PACKAGE`, carrying a layer
// per kind, and the host runs two ordered passes over it: draft every layer, then
// publish every layer in rank order. Three claims move, and each moves to a
// stronger form:
//
//   * Ordering is no longer the caller's to get right — the host sorts by rank —
//     so the case that sent the layers in order now sends them REVERSED and
//     asserts they still land Phases-first.
//   * Validation runs ONCE over the whole document before pass 1 (FR-016), so
//     the behavioral ordering claim is restated as the FR-017 union: the Workflow
//     is accepted against Pipelines that are not live yet but arrive with it, and
//     the same Workflow sent WITHOUT them is refused for `unknown-pipeline`
//     having written nothing.
//   * Staleness is asked of every declared layer before any write (FR-036), so a
//     concurrent Workflow write no longer strands a written Phase layer: it
//     refuses the whole package, and the Phase layer is never written at all.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored here rather than imported — the webview is a separate program —
// exactly as `pipeline-package-import.test.ts` mirrors the two-layer one. What
// this file asserts is that the HOST composes over the shape the contract
// specifies.

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

import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
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
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { publishDefinitionPackage } from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { FakeCatalogStore, NO_WRITES, tokenFor, writesOf } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';

/** The catalog each write targets, and the order the three occur in (FR-045). */
type LayerKey = 'phases' | 'pipelines' | 'workflows';

const LAYER_ORDER: readonly LayerKey[] = ['phases', 'pipelines', 'workflows'];

const KIND_OF: Readonly<Record<LayerKey, CatalogKind>> = {
  phases: 'phase',
  pipelines: 'pipeline',
  workflows: 'workflow'
};

const KEY_OF: Readonly<Record<CatalogKind, LayerKey>> = {
  phase: 'phases',
  pipeline: 'pipelines',
  workflow: 'workflows'
};

/** All three writable catalogs, behind the one store a package write goes through. */
interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(
  seed: {
    readonly phases?: readonly unknown[];
    readonly pipelines?: readonly unknown[];
    readonly workflows?: readonly unknown[];
  } = {}
): Installation {
  return {
    store: new FakeCatalogStore({
      phases: seed.phases ?? [],
      pipelines: seed.pipelines ?? [],
      workflows: seed.workflows ?? []
    })
  };
}

function rowsOf(inst: Installation, key: LayerKey): readonly unknown[] {
  return inst.store.rowsOf(KIND_OF[key]);
}

/**
 * The read seams every handler in this file shares, wired to one store.
 *
 * Feature 100 (T512, T514, FR-043) — each layer carries `ids` as well as `rows`,
 * because the host's `storedLayer` does and the difference between the two is what
 * the import presence gate reads: `rows` is the active bodies, `ids` is every entry
 * at every state. A harness that supplied only `rows` would fall back to the row ids
 * and report an operator's unpublished draft as absent, which is the one thing
 * FR-044 forbids — and the partial-recovery cases below would then pass by importing
 * over a draft instead of skipping it.
 */
function catalogDeps(store: FakeCatalogStore): Record<string, unknown> {
  const layer = (kind: CatalogKind) => () => ({
    rows: store.rowsOf(kind),
    revision: store.revisionOf(kind),
    ids: new Set(store.idsOf(kind))
  });
  return {
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: layer('phase'),
    readPipelineConfig: layer('pipeline'),
    readWorkflowConfig: layer('workflow')
  };
}

/**
 * Someone else writes a catalog between the preview and the confirm.
 *
 * Feature 099 (T496f) — the cases that need this used to assign a layer array in
 * place. A revision is the store's now, not a hash of an array, so the way to make
 * a preview stale is to perform the write that moves it.
 */
async function concurrentWrite(
  inst: Installation,
  key: LayerKey,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const kind = KIND_OF[key];
  // Feature 100 (T514) — both passes, because the write has to be LIVE: a case that
  // seeds a competing row and then reads the effective catalog would otherwise be
  // reading a draft that nothing runs. Two revision moves rather than one, which is
  // irrelevant to every caller here — a stale gate is stale either way.
  const written = await inst.store.saveDraftLayer({
    kind,
    expectedRevision: inst.store.revisionOf(kind),
    definitions: rows.map((row) => ({ id: row.id as string, body: row }))
  });
  expect(written.outcome).toBe('saved');
  const published = await inst.store.publishLayer({
    kind,
    ids: rows.map((row) => row.id as string),
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
  readonly pipelines?: readonly (readonly string[])[];
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
  if (body.pipelines !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.pipelines !== undefined) lines.push('  pipelines:', ...body.pipelines.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

/** Two nodes, one connection between them, one start. */
const DEFAULT_SPEC = [
  'nodes:',
  '  - nodeId: draft',
  '    pipelineId: spec-authoring',
  '  - nodeId: review',
  '    pipelineId: spec-review',
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
    'phaseIds:',
    '  - specify',
    'outputs:',
    '  - portId: spec-document',
    '    label: Spec',
    '    type: markdown'
  ]
);

const INCLUDED_SPEC_REVIEW = includedResource(
  ['id: spec-review', 'name: Spec Review', 'version: 1'],
  [
    'phaseIds:',
    '  - specify',
    'inputs:',
    '  - portId: spec',
    '    label: Spec',
    '    type: text'
  ]
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

/**
 * Self-contained: every Pipeline the root's nodes name, and every Phase those
 * Pipelines name, is supplied by the same document. `specify`, `spec-authoring`,
 * and `spec-review` are free ids — the built-ins are all `speckit-` prefixed — so
 * nothing here resolves by accident.
 */
const SELF_CONTAINED = workflowDocument({
  pipelines: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
  phases: [INCLUDED_SPECIFY]
});

/**
 * The root names a Pipeline the document does not supply and no layer holds, so
 * the root is `blocked` while its included Pipeline and Phase stay eligible.
 */
const BLOCKED_ROOT = workflowDocument({
  spec: [
    'nodes:',
    '  - nodeId: draft',
    '    pipelineId: spec-authoring',
    '  - nodeId: polish',
    '    pipelineId: no-such-pipeline',
    'startNodeIds:',
    '  - draft'
  ],
  pipelines: [INCLUDED_SPEC_AUTHORING],
  phases: [INCLUDED_SPECIFY]
});

/**
 * References only: the root names Pipelines it does not carry. Nothing is written
 * below the Workflow layer, which is the shape that proves the write count follows
 * what the document declares rather than a fixed three.
 */
const REFERENCES_ONLY = workflowDocument({
  spec: [
    'nodes:',
    '  - nodeId: draft',
    '    pipelineId: spec-authoring',
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

const HELD_PIPELINE = Object.freeze({
  // Feature 098 (T080) — the held Pipeline used to name `speckit-specify`, which
  // resolved out of the built-in Phase layer. That layer is empty, so it names the
  // held Phase instead: every installation below that holds this Pipeline holds
  // that Phase in the same scope. The row has to stay valid, because the point of
  // "held" is that an import leaves it standing — an invalid row would be rejected
  // by the write gate and the case would report a validation failure instead.
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['held']
});

const HELD_WORKFLOW = Object.freeze({
  id: 'held-flow',
  name: 'Held Flow',
  version: 5,
  nodes: [{ nodeId: 'only', pipelineId: 'held-pipeline' }],
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
function imported<T>(plan: ImportPlan, kind: 'phase' | 'pipeline' | 'workflow'): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
    }
  }
  return definitions;
}

const importedPhases = (plan: ImportPlan) => imported<PhaseDefinition>(plan, 'phase');
const importedPipelines = (plan: ImportPlan) => imported<PipelineDefinition>(plan, 'pipeline');
const importedWorkflows = (plan: ImportPlan) => imported<WorkflowDefinition>(plan, 'workflow');

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * The row shape the webview emitter actually sends (feature 086 T054):
 * `saveWorkflowRowFromDefinition` spreads the definition and renames nothing,
 * because the Workflow catalog arrived after the `id` spelling was retired. The
 * handler still accepts legacy `id` — `allowLegacyId: true` — so a helper that
 * emitted it would pass while mirroring something no caller sends.
 */
function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

/**
 * The one command the confirmation sends, with a layer per kind the plan imports.
 *
 * Feature 100 (T514, FR-039b) — the `[...layers.phases, ...]` prefix is gone from
 * all three layers. A layer write MERGES now: an id the request does not name is
 * left exactly as it is, so echoing the held rows back would assert nothing except
 * that the caller can copy an array. Its absence is the stronger claim, and the
 * cases that seed a held row and read it back afterwards are what make it.
 *
 * The layers are built Phases-first because that reads naturally, not because the
 * order matters here — the host sorts them by rank (FR-035), which the ordering
 * case below asserts by sending them backwards.
 */
function packageCommand(plan: ImportPlan): PublishPackageCommand {
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);
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

  if (pipelines.length > 0) {
    // FR-036 — each catalog carries ITS OWN revision. One revision could not gate
    // three independently mutable catalogs, and reading the live one at confirm
    // time would defeat the point of computing the plan against a snapshot.
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'pipeline',
      expectedRevision: revision!,
      definitions: pipelines.map((definition) => ({
        id: definition.pipelineId,
        body: pipelineRow(definition)
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

/**
 * The outcome as the host reports it (FR-037).
 *
 * This used to be the webview's rule, mirrored: count the accepted acks across
 * three commands. There is one ack now and `partial` is one of its reasons, so the
 * rule the surface applies is a read rather than a derivation — an import cannot be
 * reported as wholly succeeded or wholly failed when it was neither, because no
 * caller is computing it.
 */
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
      queueRemover: { remove: vi.fn() },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;

  // Feature 099 (T496f, FR-029) — `failOn` made the settings writer throw. The
  // store never throws; it names the fault, and `not-writable` is the same fault by
  // its own name. Feature 100 (T514) — keyed by kind AND by pass, because the write
  // that must fail is no longer the n-th the store sees: every layer is drafted
  // before any is published, so "the Workflow write fails" has two distinct
  // meanings and the partial each produces is different.
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

  // The layers each pass reached, in order. A gate that answers ahead of the store
  // leaves no request behind on either port, which is what the `NO_WRITES` cases
  // assert; a request that was refused still recorded itself here, which is what
  // makes "the Workflow pass ran and was turned away" distinguishable from "the
  // Workflow pass never ran".
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

function pipelineContext(inst: Installation) {
  return resolvePipelineCatalog({
    rows: inst.store.rowsOf('pipeline'),
    revision: inst.store.revisionOf('pipeline'),
    phaseCatalog: phaseContext(inst).effective
  });
}

function effectivePipelineIds(inst: Installation): readonly string[] {
  return pipelineContext(inst).effective.map((definition) => definition.pipelineId);
}

function effectiveWorkflowIds(inst: Installation): readonly string[] {
  return resolveWorkflowCatalog({
    rows: inst.store.rowsOf('workflow'),
    revision: inst.store.revisionOf('workflow'),
    pipelineCatalog: pipelineContext(inst)
  }).effective.map((definition) => definition.workflowId);
}

function snapshot(inst: Installation): string {
  return JSON.stringify({
    phases: inst.store.rowsOf('phase'),
    pipelines: inst.store.rowsOf('pipeline'),
    workflows: inst.store.rowsOf('workflow')
  });
}

beforeEach(() => capabilities.clear());

describe('Feature 086 T049 — the ordered three-layer write', () => {
  it('publishes the three catalogs in dependency order (FR-035, SC-013)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan);

    expect(run.drafted).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.published).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.outcome).toBe('imported');
    expect(run.ack.result).toEqual({
      published: [
        { kind: 'phase', ids: ['specify'], total: 1 },
        { kind: 'pipeline', ids: ['spec-authoring', 'spec-review'], total: 2 },
        { kind: 'workflow', ids: ['ship-it-flow'], total: 1 }
      ]
    });
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('publishes in rank order even when the request lists the Workflow first (FR-035)', async () => {
    // Feature 100 (T514) — the ordering used to be the caller's to get right, so
    // this pair's first half asserted that the driver sent them in order. The host
    // sorts by rank, so the stronger claim is that the order the caller sends is
    // irrelevant: reversed on the wire, Phases still draft and publish first.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const reversed: PublishPackageCommand = {
      ...sent,
      payload: { layers: [...sent.payload.layers].reverse() }
    };
    expect(reversed.payload.layers.map((layer) => layer.kind)).toEqual([
      'workflow',
      'pipeline',
      'phase'
    ]);

    const run = await commitPackage(inst, plan, { command: reversed });

    expect(run.drafted).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.published).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('validates the Workflow against the Pipelines arriving with it (FR-017)', async () => {
    // The behavioral half of the ordering rule, and the reason it is a correctness
    // rule rather than a preference — restated onto the union (FR-017). The Workflow
    // resolves each node against the catalog the publication is ABOUT TO make live,
    // not the one that is live: nothing is in this store, and the Workflow is
    // accepted anyway because its two node Pipelines are in the same document.
    const inst = installation();
    expect(effectivePipelineIds(inst)).not.toContain('spec-authoring');
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review'])
    );
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('refuses the same Workflow when its Pipelines are not in the request (FR-017)', async () => {
    // The other half: the union is exactly the document, not a licence to bind
    // anything. Send the Workflow layer alone and the same nodes no longer resolve —
    // one validation pass over the whole request, ahead of pass 1, so the refusal
    // costs no write at all (FR-016, FR-019).
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const workflowOnly: PublishPackageCommand = {
      ...sent,
      payload: { layers: sent.payload.layers.filter((layer) => layer.kind === 'workflow') }
    };

    const run = await commitPackage(inst, plan, { command: workflowOnly });

    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'validation-failed' });
    const detail = run.ack.result as {
      readonly kind: string | null;
      readonly defects: readonly { readonly kind: string; readonly code: string }[];
    };
    expect(detail.kind).toBeNull();
    expect(detail.defects.map((defect) => defect.code)).toContain('unknown-pipeline');
    expect(detail.defects.every((defect) => defect.kind === 'workflow')).toBe(true);
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
  });

  it('leaves the Workflow unpublished when the Pipeline publication is refused (FR-035)', async () => {
    // Ordering with teeth on the publish pass: the Pipeline layer is drafted, its
    // publication is refused, and the Workflow above it is never published even
    // though its own draft landed. A run that published the Workflow anyway would
    // have made a live Workflow whose nodes name Pipelines nothing runs.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.published).toEqual(['phases', 'pipelines']);
    expect(run.ack.result).toMatchObject({
      published: [{ kind: 'phase', total: 1 }],
      draftedOnly: ['pipeline', 'workflow'],
      failedKind: 'pipeline',
      cause: 'not-writable'
    });
    expect(effectivePipelineIds(inst)).toEqual([]);
    expect(effectiveWorkflowIds(inst)).toEqual([]);
    // Drafted, though — nothing was rolled back and nothing was thrown away.
    expect(inst.store.stateOf('workflow', 'ship-it-flow')).toBe('draft');
  });

  it('writes only the `import` rows, leaving `skip` untouched (FR-044)', async () => {
    // `specify` is already held, at a different version and instruction. A skip is
    // not a write, and not an overwrite either — the held row is what an operator
    // would lose if import replaced rather than skipped.
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
    // The Phase catalog is its prior contents in order, and nothing was appended:
    // the document's only Phase was the one already held.
    expect(inst.store.rowsOf('phase')).toEqual([HELD_PHASE, MINE]);
    expect(run.drafted).toEqual(['pipelines', 'workflows']);
    expect(run.published).toEqual(['pipelines', 'workflows']);
    // The declared version survives the write it arrived on (FR-003a).
    //
    // Feature 100 (T514) — keyed `workflowId`, not `id`. The retired handler accepted
    // the legacy `id` spelling and normalized it; the store stores bodies and
    // transforms nothing, so what is stored is exactly what the emitter sent — and
    // `saveWorkflowRowFromDefinition` sends the canonical spelling, which is why the
    // resolver reads this row back as `ship-it-flow` below.
    expect(inst.store.rowsOf('workflow')).toEqual([
      expect.objectContaining({ workflowId: 'ship-it-flow', name: 'Ship It Flow', version: 3 })
    ]);
  });

  it('writes the eligible rows even though the Workflow is blocked', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 2, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan);

    // A blocked row is not a failed write — it was never eligible, so there is no
    // Workflow layer at all and nothing partial about the outcome.
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    expect(run.published).toEqual(['phases', 'pipelines']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toContain('spec-authoring');
    expect(inst.store.rowsOf('workflow')).toEqual([]);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      reason: { code: 'dependency-absent' }
    });
  });

  it('publishes only the catalogs the document declared, never a fixed three', async () => {
    // A references-only Workflow claims no Pipeline and no Phase write, because
    // offering either would offer a write with nothing in it. Its one node's
    // Pipeline is seeded so the root is eligible rather than blocked.
    const seed = installation();
    const seedPlan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({
      phases: importedPhases(seedPlan).map(phaseRow),
      pipelines: importedPipelines(seedPlan).map(pipelineRow)
    });
    const beforePhases = inst.store.revisionOf('phase');
    const beforePipelines = inst.store.revisionOf('pipeline');

    const plan = await planFor(inst, REFERENCES_ONLY);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 0, invalid: 0 });
    expect(plan.computedAgainstPipelineRevision).toBeUndefined();
    expect(plan.computedAgainstWorkflowRevision).toBeDefined();

    const run = await commitPackage(inst, plan);

    expect(run.drafted).toEqual(['workflows']);
    expect(run.published).toEqual(['workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
    // Feature 099 (T496f, FR-004) — an undeclared catalog is not written, and a
    // catalog that is not written does not move. The revision is the observable
    // form of that: a no-op save would advance it even with identical rows.
    expect(inst.store.revisionOf('phase')).toBe(beforePhases);
    expect(inst.store.revisionOf('pipeline')).toBe(beforePipelines);
  });

  it('carries one expected revision per writable target (FR-036)', async () => {
    const inst = installation({
      phases: [HELD_PHASE],
      pipelines: [HELD_PIPELINE],
      workflows: [HELD_WORKFLOW]
    });
    const plan = await planFor(inst, SELF_CONTAINED);

    // Feature 099 (T496f, FR-042) — each of these was a map keyed by the two
    // writable scopes, because the operator had not chosen one yet at plan time.
    // There is one destination per kind now, so each is the plain revision of that
    // kind's catalog: still one per kind, still read at plan time and not at
    // confirm time, which is the whole of what the map was carrying.
    for (const revision of [
      plan.computedAgainstRevision,
      plan.computedAgainstPipelineRevision,
      plan.computedAgainstWorkflowRevision
    ]) {
      expect(typeof revision).toBe('string');
      expect(revision as string).not.toBe('');
    }

    // Three distinct revisions: each names a different catalog, so one shared value
    // could not gate three independently mutable catalogs.
    const layers = packageCommand(plan).payload.layers;
    expect(layers.map((layer) => KEY_OF[layer.kind])).toEqual(LAYER_ORDER);
    expect(new Set(layers.map((layer) => layer.expectedRevision)).size).toBe(3);

    // Feature 100 (T514, FR-039a) — each layer used to carry an `import-package`
    // mutation intent naming its target set, so the write knew which ids it was
    // allowed to touch. The intent is gone because the layer IS the intent: its
    // `definitions` are exactly the ids to write, the store merges rather than
    // replaces, and pass 2 publishes exactly those ids. Same claim, one less thing
    // to keep in sync — a layer naming an id it does not carry is now unsayable.
    expect(layers.map((layer) => layer.definitions.map((definition) => definition.id))).toEqual([
      ['specify'],
      ['spec-authoring', 'spec-review'],
      ['ship-it-flow']
    ]);
  });

  it('names no destination, in the plan or in any request built from it (FR-047)', async () => {
    // Feature 099 (T496f, FR-042/FR-047) — the successor of 'lets the operator
    // choose the target scope after seeing the plan'. That case existed because the
    // plan was computed before the destination was known and had to stay
    // committable to either scope. There is one destination per kind now, so the
    // surviving claim is the stronger form of the same one: neither the plan nor
    // any request built from it names a destination at all, which is why no
    // operator choice has to be carried across the preview.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    expect(plan).not.toHaveProperty('scope');
    const command = packageCommand(plan);
    expect(command.payload).not.toHaveProperty('scope');
    expect(command.payload.layers).toHaveLength(3);
    for (const layer of command.payload.layers) {
      expect(layer).not.toHaveProperty('scope');
    }

    const run = await commitPackage(inst, plan, { command });

    expect(run.outcome).toBe('imported');
    expect(inst.store.rowsOf('workflow')).toHaveLength(1);
  });

  it('appends to each catalog and rewrites nothing that was there', async () => {
    const inst = installation({
      phases: [HELD_PHASE],
      pipelines: [HELD_PIPELINE],
      workflows: [HELD_WORKFLOW]
    });
    const before = JSON.parse(snapshot(inst)) as Record<LayerKey, readonly unknown[]>;

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan);
    expect(run.outcome).toBe('imported');

    // Each catalog is its prior contents, in order, followed by the imported rows.
    // Positional, because a row that moved is a row some other reader's index now
    // points past.
    for (const key of LAYER_ORDER) {
      expect(rowsOf(inst, key).slice(0, before[key].length)).toEqual(before[key]);
    }
    expect(rowsOf(inst, 'phases')).toHaveLength(before.phases.length + 1);
    expect(rowsOf(inst, 'pipelines')).toHaveLength(before.pipelines.length + 2);
    expect(rowsOf(inst, 'workflows')).toHaveLength(before.workflows.length + 1);
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
    // Feature 100 (T514) — this used to be a `partial`: three commands went out in
    // order, the two below landed, and the Workflow one was refused for its own
    // revision. One command means the staleness question is asked of EVERY declared
    // layer before any write, so a stale Workflow revision now costs nothing — the
    // Phase and Pipeline layers are not written and then stranded under a Workflow
    // that never arrives. Strictly better, and the per-layer claim is untouched: the
    // refusal names `workflow`, so the two lower revisions were each checked against
    // their own and passed.
    const inst = installation();
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
    // Both gates would fire. The operator is told the one that is actionable: the
    // preview no longer describes the catalog, so re-running the preflight is the
    // next step whether or not the capability is ever granted.
    //
    // Feature 099 (T496f, FR-046) — this case used to deny `workflowOverrides` and
    // make the Workflow catalog stale. That capability is gone with the tier it
    // guarded, so the pair is reassembled one catalog down on `phases`, the
    // capability that remains. The claim is unchanged and is about ORDER: staleness
    // is reported ahead of a capability answer, not instead of it.
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
    // Baselined rather than `NO_WRITES`: `concurrentWrite` above is a write of this
    // test's own, and the claim is that the refused publication added none.
    expect(inst.store.draftLayerSaves).toHaveLength(drafts);
    expect(inst.store.publishLayers).toHaveLength(publishes);
  });
});

describe('Feature 086 T050 — a partial write stays partial', () => {
  // Both shapes from data-model.md §5.3. Three catalogs admit two partial states
  // where two admitted one, and each is a place an implementation could decide to
  // "tidy up" by deleting what landed. It must not: the landed records are indexed
  // by other readers, the operator may already have edited them, and a delete is a
  // destructive write on a path where no operator confirmed one (FR-038).
  //
  // Feature 100 (T514) — two passes means the two shapes are no longer "the first
  // n writes landed". A failure in pass 1 leaves DRAFTS and nothing live; a failure
  // in pass 2 leaves live layers below and drafts above. Both are partial, both keep
  // everything they wrote, and the ack says which is which — `published` for what
  // went live, `draftedOnly` for what is written and waiting.

  it('leaves the Phase layer drafted when the Pipeline draft fails (FR-037, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'draft' } });

    expect(run.outcome).toBe('partial');
    // Pass 1 stopped at the Pipeline layer, so pass 2 never ran: nothing is live,
    // and the Workflow layer was never even drafted.
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    expect(run.published).toEqual([]);
    expect(run.ack.result).toEqual({
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'pipeline',
      cause: 'not-writable'
    });
    // What landed, stays — as a Draft, which is all pass 1 ever writes (FR-034).
    expect(inst.store.stateOf('phase', 'specify')).toBe('draft');
    expect(effectivePhaseIds(inst)).toEqual([]);
    expect(inst.store.idsOf('pipeline')).toEqual([]);
    expect(inst.store.idsOf('workflow')).toEqual([]);
  });

  it('leaves the Phases and Pipelines live when the Workflow publication fails (FR-038, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'workflows', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.published).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.ack.result).toEqual({
      published: [
        { kind: 'phase', total: 1 },
        { kind: 'pipeline', total: 2 }
      ],
      draftedOnly: ['workflow'],
      failedKind: 'workflow',
      cause: 'not-writable'
    });
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review'])
    );
    // Live nowhere, thrown away nowhere: the Workflow body is written and waiting.
    expect(effectiveWorkflowIds(inst)).toEqual([]);
    expect(inst.store.stateOf('workflow', 'ship-it-flow')).toBe('draft');
  });

  it('identifies which catalogs landed, for either shape (FR-037)', async () => {
    // `partial` without this is an operator who does not know what is now in their
    // catalog. It used to be derivable from the per-command acks — the deepest one
    // that was accepted — and the host reports it directly now, so the two shapes
    // are distinguishable from the ack alone rather than from counting.
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
        failOn: { key: 'pipelines', pass: 'draft' }
      }),
      await commitPackage(inPassTwo, await planFor(inPassTwo, SELF_CONTAINED), {
        failOn: { key: 'workflows', pass: 'publish' }
      })
    ];

    expect(atDraft.outcome).toBe('partial');
    expect(landed(atDraft)).toEqual([]);
    expect(waiting(atDraft)).toEqual(['phase']);
    expect(atPublish.outcome).toBe('partial');
    expect(landed(atPublish)).toEqual(['phase', 'pipeline']);
    expect(waiting(atPublish)).toEqual(['workflow']);
  });

  it('performs zero compensating deletions on either partial path (FR-038)', async () => {
    // The store records every request the run makes on both ports. A compensating
    // delete would be a second write to a kind already written — so the check is
    // that no kind appears twice on either port, on top of the row-level check that
    // nothing seeded was removed.
    for (const failOn of [
      { key: 'pipelines', pass: 'draft' },
      { key: 'workflows', pass: 'publish' }
    ] as const satisfies readonly FailPoint[]) {
      const inst = installation({
        phases: [HELD_PHASE],
        pipelines: [HELD_PIPELINE],
        workflows: [HELD_WORKFLOW]
      });
      const plan = await planFor(inst, SELF_CONTAINED);

      const run = await commitPackage(inst, plan, { failOn });

      expect(run.outcome).toBe('partial');
      expect(new Set(run.drafted).size).toBe(run.drafted.length);
      expect(new Set(run.published).size).toBe(run.published.length);
      // Every pre-existing row survives, in place and Active, in all three catalogs.
      expect(inst.store.rowsOf('phase')[0]).toEqual(HELD_PHASE);
      expect(inst.store.rowsOf('pipeline')[0]).toEqual(HELD_PIPELINE);
      expect(inst.store.rowsOf('workflow')[0]).toEqual(HELD_WORKFLOW);
      // And nothing this run wrote was taken back — every id it reached is still
      // there, whichever state it reached.
      expect(inst.store.idsOf('phase')).toContain('specify');
    }
  });

  it('needs no cleanup after a pass-1 failure, and the drafted Phase unblocks the rest (FR-039)', async () => {
    // The recovery FR-039 promises, on the shape where nothing went live.
    //
    // Under three whole-array writes the failed one had written NOTHING, so
    // re-running re-sent the layer and it landed. Under the lifecycle the failed
    // pass had already written the Phase body as a draft, so the re-run finds it
    // present (FR-044 — every state, including Draft) and plans it as a skip. A skip
    // is never published (FR-039a): importing a document must not publish an
    // operator's pre-existing unpublished draft as a side effect.
    //
    // Which leaves the Pipelines above it naming a Phase that is written but not
    // live — and the plan says so in the preview rather than at the write. Present
    // and satisfying are different questions (FR-043/FR-044): presence is every
    // state, so the Phase is a skip; a reference resolves against the ACTIVE catalog
    // and the candidates arriving with it (FR-017), so the three rows above are
    // `blocked` on `dependency-absent`. The operator sees exactly what is missing
    // BEFORE confirming, the confirmation writes nothing at all, and their own
    // deliberate publication of the drafted Phase is what completes the document.
    const inst = installation();
    const first = await commitPackage(inst, await planFor(inst, SELF_CONTAINED), {
      failOn: { key: 'pipelines', pass: 'draft' }
    });
    expect(first.outcome).toBe('partial');

    // Nothing about the retry is special-cased: the same document, the same
    // preflight. The presence scan sees the drafted Phase and plans `skip`.
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
      // Two different reasons, one cascade: the Pipelines name a Phase that is not
      // live, and the Workflow names Pipelines that are themselves blocked. The
      // operator reading the preview is told where the break actually is rather than
      // being handed three copies of the same complaint.
      ['ship-it-flow', 'dependency-blocked'],
      ['spec-authoring', 'dependency-absent'],
      ['spec-review', 'dependency-absent']
    ]);

    // A plan with no eligible row sends no layer, so the confirmation is vacuously
    // accepted and touches nothing. Nothing to undo, nothing half-written.
    const stalled = await commitPackage(inst, plan);
    expect(stalled.outcome).toBe('imported');
    expect(stalled.ack.result).toEqual({ published: [] });
    expect(stalled.drafted).toEqual([]);
    expect(stalled.published).toEqual([]);
    expect(effectivePhaseIds(inst)).toEqual([]);

    // Publish the draft the failed run left behind — the deliberate act FR-039a
    // reserves for the operator — and the identical document completes.
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
    expect(second.published).toEqual(['pipelines', 'workflows']);
    // The Phase record is the one the first run wrote, untouched and not duplicated.
    expect(inst.store.rowsOf('phase')).toHaveLength(1);
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('needs no cleanup after a pass-2 failure, and re-running writes nothing twice (FR-039)', async () => {
    // The other shape, and the one T514f names: the layers below went live, the
    // Workflow above is drafted. Everything the document describes is already
    // written, at one state or the other, so the re-run plans four skips and sends
    // no layer at all — and the drafted Workflow completes by publication, not by a
    // second import.
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
    expect(inst.store.rowsOf('pipeline')).toHaveLength(2);

    const lifecycle = fakeCatalogLifecycle(inst.store);
    const published = await lifecycle.publish({
      kind: 'workflow',
      id: 'ship-it-flow',
      expectedDraftVersion: tokenFor(inst.store, 'workflow', 'ship-it-flow')
    });
    expect(published.outcome).toBe('published');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('re-running a fully imported document writes nothing at all (FR-039)', async () => {
    // The terminal case of the same property: once everything is present, the
    // presence scan classifies every resource `skip` and there is no layer to send.
    // Re-running is idempotent, not merely non-destructive.
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
    // Vacuously `imported` — zero layers, zero failures. Nothing to report as
    // partial, because nothing was attempted.
    expect(again.outcome).toBe('imported');
    expect(again.ack.result).toEqual({ published: [] });
    expect(snapshot(inst)).toBe(settled);
    expect(writesOf(inst.store)).toEqual(writesBefore);
  });
});
