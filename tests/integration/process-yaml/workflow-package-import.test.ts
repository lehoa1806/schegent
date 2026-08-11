// Feature 086 T049/T050 — the confirmed Workflow package write, across all three
// host commands.
//
// 085 established that a package writing two catalogs cannot be one atomic
// operation. A Workflow package writes THREE, so the same three properties hold
// with one more layer to be wrong about:
//
//   ordered      — Phases, then Pipelines, then the Workflow (FR-045). Checked
//                  BEHAVIORALLY, not merely by the sequence of `updateConfig`
//                  calls: each layer resolves its references against the
//                  effective catalog below it, so moving a write earlier turns an
//                  accepted save into a rejection naming the missing dependency.
//                  A spy-order assertion alone would pass on an implementation
//                  that happened to call them in order for no reason.
//   independent  — each write carries its own `expectedRevision` and its own
//                  single `import-package` intent (FR-046, FR-050), so a layer
//                  that moved under the operator stops that layer's write and
//                  says so.
//   irreversible — a failed write leaves the prefix that landed written, with NO
//                  compensating delete (FR-051). Re-running the same document is
//                  the recovery (FR-052), self-healing at whatever depth it
//                  stopped because the landed rows then plan `skip` and resolve
//                  the references above them.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored here rather than imported — the webview is a separate program —
// exactly as `pipeline-package-import.test.ts` mirrors the two-layer one. What
// this file asserts is that the three HOST commands compose over the shape the
// contract specifies.

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

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { BUILT_IN_WORKFLOWS } from '../../../src/config/workflow-config';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as savePhasesHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { handler as savePipelinesHandler } from '../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { handler as saveWorkflowsHandler } from '../../../src/ui/sidebar/commands/cmd-save-workflows';
import {
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_WORKFLOWS
} from '../../../src/ui/sidebar/messages';
import type {
  SavePhasesCommand,
  SavePipelinesCommand,
  SaveWorkflowsCommand
} from '../../../src/ui/sidebar/messages';

/** The one scope a package targets; a write never splits across scopes (FR-047). */
type Scope = 'user' | 'workspace';

/** The configuration key each layer write targets, in dependency order (FR-045). */
type LayerKey = 'phases' | 'pipelines' | 'workflows';

const LAYER_ORDER: readonly LayerKey[] = ['phases', 'pipelines', 'workflows'];

interface Layers {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

/** All three writable catalogs, mutated in place by an accepted write. */
interface Installation {
  readonly phases: Layers;
  readonly pipelines: Layers;
  readonly workflows: Layers;
}

function installation(
  seed: {
    readonly phases?: Partial<Layers>;
    readonly pipelines?: Partial<Layers>;
    readonly workflows?: Partial<Layers>;
  } = {}
): Installation {
  return {
    phases: { user: seed.phases?.user ?? [], workspace: seed.phases?.workspace ?? [] },
    pipelines: { user: seed.pipelines?.user ?? [], workspace: seed.pipelines?.workspace ?? [] },
    workflows: { user: seed.workflows?.user ?? [], workspace: seed.workflows?.workspace ?? [] }
  };
}

/** The rows of all three layers as the operator's preview saw them, for the proposal. */
interface Held {
  readonly phases: readonly unknown[];
  readonly pipelines: readonly unknown[];
  readonly workflows: readonly unknown[];
}

function held(inst: Installation, scope: Scope): Held {
  return {
    phases: inst.phases[scope],
    pipelines: inst.pipelines[scope],
    workflows: inst.workflows[scope]
  };
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
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['speckit-specify']
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
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
      readWorkflowConfig: () => inst.workflows,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * One attempted layer write. Appending the added rows is what makes the positional
 * shape check pass: deleting them from the proposal reproduces the layer the
 * operator's preview described, in order.
 */
interface Attempt {
  readonly key: LayerKey;
  readonly command: SavePhasesCommand | SavePipelinesCommand | SaveWorkflowsCommand;
}

function attemptsFor(plan: ImportPlan, scope: Scope, layers: Held): readonly Attempt[] {
  const attempts: Attempt[] = [];
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);
  const workflows = importedWorkflows(plan);

  // FR-045 — the Phase attempt is built and run first, unconditionally.
  if (phases.length > 0) {
    attempts.push({
      key: 'phases',
      command: {
        type: CMD_SAVE_PHASES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: plan.computedAgainstRevision[scope],
          mutation: {
            kind: 'import-package',
            phaseIds: phases.map((definition) => definition.phaseId)
          },
          phases: [...layers.phases, ...phases.map(phaseRow)]
        }
      }
    });
  }

  if (pipelines.length > 0) {
    // FR-050 — each layer carries ITS OWN revision. One revision could not gate
    // three independently mutable layers, and reading the live one at confirm
    // time would defeat the point of computing the plan against a snapshot.
    const revisions = plan.computedAgainstPipelineRevision;
    expect(revisions).toBeDefined();
    attempts.push({
      key: 'pipelines',
      command: {
        type: CMD_SAVE_PIPELINES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: revisions![scope],
          mutation: {
            kind: 'import-package',
            pipelineIds: pipelines.map((definition) => definition.pipelineId)
          },
          pipelines: [...layers.pipelines, ...pipelines.map(pipelineRow)]
        }
      }
    });
  }

  if (workflows.length > 0) {
    const revisions = plan.computedAgainstWorkflowRevision;
    expect(revisions).toBeDefined();
    attempts.push({
      key: 'workflows',
      command: {
        type: CMD_SAVE_WORKFLOWS,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: revisions![scope],
          mutation: {
            kind: 'import-package',
            workflowIds: workflows.map((definition) => definition.workflowId)
          },
          workflows: [...layers.workflows, ...workflows.map(workflowRow)]
        }
      }
    });
  }

  return attempts;
}

interface LayerResult {
  readonly key: LayerKey;
  readonly ack: CommandAckMessage;
}

interface CommitRun {
  /** Configuration keys actually written, in the order `updateConfig` saw them. */
  readonly writes: readonly LayerKey[];
  readonly results: readonly LayerResult[];
  readonly outcome: 'imported' | 'partial' | 'failed';
}

/**
 * The webview's outcome rule, mirrored (FR-042a as widened by FR-051): the import
 * is never reported as wholly succeeded or wholly failed when it was neither.
 */
function outcomeOf(results: readonly LayerResult[]): CommitRun['outcome'] {
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  scope: Scope,
  layers: Held,
  opts: { readonly failOn?: LayerKey } = {}
): Promise<CommitRun> {
  const writes: LayerKey[] = [];
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
      readWorkflowConfig: () => inst.workflows,
      readConfig: () => undefined,
      updateConfig: async (key: string, value: unknown, target: Scope) => {
        expect(LAYER_ORDER).toContain(key as LayerKey);
        writes.push(key as LayerKey);
        if (opts.failOn === key) throw new Error('EACCES: settings.json is read-only');
        const layer = inst[key as LayerKey];
        layer[target] = value as readonly unknown[];
      },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const results: LayerResult[] = [];
  for (const attempt of attemptsFor(plan, scope, layers)) {
    if (attempt.key === 'phases') {
      await savePhasesHandler(ctx, attempt.command as SavePhasesCommand);
    } else if (attempt.key === 'pipelines') {
      await savePipelinesHandler(ctx, attempt.command as SavePipelinesCommand);
    } else {
      await saveWorkflowsHandler(ctx, attempt.command as SaveWorkflowsCommand);
    }
    const ack = acks[acks.length - 1];
    expect(ack).toBeDefined();
    results.push({ key: attempt.key, ack: ack! });
    // A rejected write stops the sequence. The ordering exists so a layer never
    // lands without the one it depends on; carrying on past a failed write would
    // be exactly that.
    if (ack!.status !== 'accepted') break;
  }

  return { writes, results, outcome: outcomeOf(results) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function effectivePhaseIds(inst: Installation): readonly string[] {
  return resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: inst.phases.user,
    workspace: inst.phases.workspace
  }).effective.map((definition) => definition.phaseId);
}

function pipelineContext(inst: Installation) {
  return resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: inst.pipelines.user,
    workspace: inst.pipelines.workspace,
    phaseCatalog: resolvePhaseCatalog({
      builtIn: BUILT_IN_PHASES,
      user: inst.phases.user,
      workspace: inst.phases.workspace
    }).effective
  });
}

function effectivePipelineIds(inst: Installation): readonly string[] {
  return pipelineContext(inst).effective.map((definition) => definition.pipelineId);
}

function effectiveWorkflowIds(inst: Installation): readonly string[] {
  return resolveWorkflowCatalog({
    builtIn: BUILT_IN_WORKFLOWS,
    user: inst.workflows.user,
    workspace: inst.workflows.workspace,
    pipelineCatalog: pipelineContext(inst)
  }).effective.map((definition) => definition.workflowId);
}

function snapshot(inst: Installation, scope: Scope): string {
  return JSON.stringify({
    phases: inst.phases[scope],
    pipelines: inst.pipelines[scope],
    workflows: inst.workflows[scope]
  });
}

beforeEach(() => capabilities.clear());

describe('Feature 086 T049 — the ordered three-layer write', () => {
  it('writes the three layers in dependency order (FR-045, SC-013)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'));

    expect(run.writes).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'accepted'],
      ['workflows', 'accepted']
    ]);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('accepts the Workflow only because its Pipelines already landed (FR-045)', async () => {
    // The behavioral half of the ordering rule, and the reason it is a
    // correctness rule rather than a preference: the Workflow save resolves each
    // node against the EFFECTIVE Pipeline catalog, so the identical command sent
    // before the Pipeline write is a rejection naming the missing node Pipeline.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const workflows = importedWorkflows(plan);
    expect(effectivePipelineIds(inst)).not.toContain('spec-authoring');

    const early = await commitPackage(installation(), plan, 'user', {
      phases: [],
      pipelines: [],
      workflows: []
    }, { failOn: 'phases' });
    expect(early.outcome).toBe('failed');
    expect(early.writes).toEqual(['phases']);

    // The Workflow write alone, against an installation where nothing below it
    // landed. Sent through the real handler, not the ordered driver.
    const acks: CommandAckMessage[] = [];
    const bare = installation();
    const ctx = {
      deps: {
        readPhaseConfig: () => bare.phases,
        readPipelineConfig: () => bare.pipelines,
        readWorkflowConfig: () => bare.workflows,
        readConfig: () => undefined,
        updateConfig: async () => {
          throw new Error('a rejected save must not reach a write');
        },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await saveWorkflowsHandler(ctx, {
      type: CMD_SAVE_WORKFLOWS,
      correlationId: CORRELATION,
      payload: {
        scope: 'user',
        expectedRevision: plan.computedAgainstWorkflowRevision!.user,
        mutation: { kind: 'import-package', workflowIds: ['ship-it-flow'] },
        workflows: workflows.map(workflowRow)
      }
    } as SaveWorkflowsCommand);

    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('workflow-validation');
    const detail = acks[0]!.result as { readonly errors: readonly { readonly code: string }[] };
    expect(detail.errors.map((error) => error.code)).toContain('unknown-pipeline');

    // In order, the same rows are accepted.
    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'));
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review'])
    );
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
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
    const inst = installation({ phases: { workspace: [HELD_PHASE, MINE] } });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 3, skip: 1, blocked: 0, invalid: 0 });

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(run.outcome).toBe('imported');
    // The Phase layer is its prior contents in order, and nothing was appended:
    // the document's only Phase was the one already held.
    expect(inst.phases.workspace).toEqual([HELD_PHASE, MINE]);
    expect(run.writes).toEqual(['pipelines', 'workflows']);
    // The declared version survives the write it arrived on (FR-003a).
    expect(inst.workflows.workspace).toEqual([
      expect.objectContaining({ id: 'ship-it-flow', name: 'Ship It Flow', version: 3 })
    ]);
  });

  it('writes the eligible rows even though the Workflow is blocked', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 2, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    // A blocked row is not a failed write — it was never eligible, so there is no
    // Workflow attempt at all and nothing partial about the outcome.
    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toContain('spec-authoring');
    expect(inst.workflows.workspace).toEqual([]);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      reason: { code: 'dependency-absent' }
    });
  });

  it('writes only the layers the document declared, never a fixed three', async () => {
    // A references-only Workflow claims no Pipeline and no Phase write, because
    // offering either would offer a write with nothing in it. Its one node's
    // Pipeline is seeded so the root is eligible rather than blocked.
    const seed = installation();
    const seedPlan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({
      phases: { workspace: importedPhases(seedPlan).map(phaseRow) },
      pipelines: { workspace: importedPipelines(seedPlan).map(pipelineRow) }
    });

    const plan = await planFor(inst, REFERENCES_ONLY);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 0, invalid: 0 });
    expect(plan.computedAgainstPipelineRevision).toBeUndefined();
    expect(plan.computedAgainstWorkflowRevision).toBeDefined();

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(run.writes).toEqual(['workflows']);
    expect(run.outcome).toBe('imported');
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('carries one expected revision per writable target (FR-050)', async () => {
    const inst = installation({
      phases: { workspace: [HELD_PHASE] },
      pipelines: { workspace: [HELD_PIPELINE] },
      workflows: { workspace: [HELD_WORKFLOW] }
    });
    const plan = await planFor(inst, SELF_CONTAINED);

    // One revision map per layer, each naming both writable scopes — the operator
    // has not chosen a scope yet at plan time, so a plan that pre-picked one would
    // force the choice before the preview is seen.
    for (const revisions of [
      plan.computedAgainstRevision,
      plan.computedAgainstPipelineRevision,
      plan.computedAgainstWorkflowRevision
    ]) {
      expect(Object.keys(revisions ?? {}).sort()).toEqual(['user', 'workspace']);
    }

    // Three distinct revisions: each is a digest of a different layer's rows, so
    // one shared value could not gate three independently mutable layers.
    const attempts = attemptsFor(plan, 'workspace', held(inst, 'workspace'));
    const revisions = attempts.map((attempt) => attempt.command.payload.expectedRevision);
    expect(attempts.map((attempt) => attempt.key)).toEqual(LAYER_ORDER);
    expect(new Set(revisions).size).toBe(3);
    // Exactly one declared mutation intent per write, each an `import-package`
    // naming that layer's target set and nothing else (FR-046).
    expect(attempts.map((attempt) => attempt.command.payload.mutation)).toEqual([
      { kind: 'import-package', phaseIds: ['specify'] },
      { kind: 'import-package', pipelineIds: ['spec-authoring', 'spec-review'] },
      { kind: 'import-package', workflowIds: ['ship-it-flow'] }
    ]);
  });

  it('lets the operator choose the target scope after seeing the plan (FR-047)', async () => {
    // The plan is computed once, against both scopes, and the same plan commits to
    // either. The scope is not in the document and not in the preflight request.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const untouched = snapshot(inst, 'workspace');

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'));

    expect(run.outcome).toBe('imported');
    expect(snapshot(inst, 'workspace')).toBe(untouched);
    expect(inst.workflows.user).toHaveLength(1);
    expect(inst.workflows.workspace).toEqual([]);
  });

  it('appends to each layer and rewrites nothing that was there', async () => {
    const inst = installation({
      phases: { workspace: [HELD_PHASE] },
      pipelines: { workspace: [HELD_PIPELINE] },
      workflows: { workspace: [HELD_WORKFLOW] }
    });
    const before = JSON.parse(snapshot(inst, 'workspace')) as Record<
      LayerKey,
      readonly unknown[]
    >;

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));
    expect(run.outcome).toBe('imported');

    // Each layer is its prior contents, in order, followed by the imported rows.
    // Positional, because a row that moved is a row some other reader's index now
    // points past.
    for (const key of LAYER_ORDER) {
      expect(inst[key].workspace.slice(0, before[key].length)).toEqual(before[key]);
    }
    expect(inst.phases.workspace).toHaveLength(before.phases.length + 1);
    expect(inst.pipelines.workspace).toHaveLength(before.pipelines.length + 2);
    expect(inst.workflows.workspace).toHaveLength(before.workflows.length + 1);
  });

  it('refuses the whole sequence when the Phase layer changed since preflight (FR-048)', async () => {
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'workspace');

    // Someone else writes the Phase layer between the preview and the confirm.
    inst.phases.workspace = [
      HELD_PHASE,
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ];
    const before = snapshot(inst, 'workspace');

    const run = await commitPackage(inst, plan, 'workspace', layers);

    expect(run.results.map((result) => result.ack.status)).toEqual(['rejected']);
    expect(run.results[0]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('failed');
    expect(run.writes).toEqual([]);
    expect(snapshot(inst, 'workspace')).toBe(before);
  });

  it('refuses the Workflow layer alone when only it changed since preflight (FR-048)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'user');

    // The three layers have independent revisions, so a concurrent Workflow write
    // must stop the Workflow half without pretending the two below it are stale.
    inst.workflows.user = [HELD_WORKFLOW];

    const run = await commitPackage(inst, plan, 'user', layers);

    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'accepted'],
      ['workflows', 'rejected']
    ]);
    expect(run.results[2]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('partial');
    expect(effectivePipelineIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review'])
    );
    expect(inst.workflows.user).toEqual([HELD_WORKFLOW]);
  });

  it('reports staleness rather than the denied capability (FR-049)', async () => {
    // Both gates would fire. The operator is told the one that is actionable: the
    // preview no longer describes the catalog, so re-running the preflight is the
    // next step whether or not the capability is ever granted.
    capabilities.set('workflowOverrides', false);
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'user');
    inst.workflows.user = [HELD_WORKFLOW];

    const run = await commitPackage(inst, plan, 'user', layers);

    expect(run.results[2]?.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.writes).toEqual(['phases', 'pipelines']);
  });
});

describe('Feature 086 T050 — a partial write stays partial', () => {
  // Both shapes from data-model.md §5.3. Three layers admit two partial states
  // where two admitted one, and each is a place an implementation could decide to
  // "tidy up" by deleting what landed. It must not: the landed rows are indexed by
  // other readers, the operator may already have edited them, and a delete is a
  // destructive write on a path where no operator confirmed one (FR-051).

  it('leaves the Phases written when the Pipeline write fails (FR-051, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'), {
      failOn: 'pipelines'
    });

    expect(run.outcome).toBe('partial');
    // Attempted through the Pipeline layer, and stopped there — the Workflow write
    // is never sent, because its nodes would not resolve against a Pipeline layer
    // that did not land.
    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'rejected']
    ]);
    // What landed, stays. The Phase layer holds the imported row.
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(inst.pipelines.user).toEqual([]);
    expect(inst.workflows.user).toEqual([]);
  });

  it('leaves the Phases and Pipelines written when the Workflow write fails (FR-051, SC-015)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'), {
      failOn: 'workflows'
    });

    expect(run.outcome).toBe('partial');
    expect(run.writes).toEqual(['phases', 'pipelines', 'workflows']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'accepted'],
      ['workflows', 'rejected']
    ]);
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(effectivePipelineIds(inst)).toEqual(
      expect.arrayContaining(['spec-authoring', 'spec-review'])
    );
    expect(inst.workflows.user).toEqual([]);
  });

  it('identifies which layers landed, for either shape', async () => {
    // The report is derivable from the per-layer results alone — the deepest layer
    // whose ack was accepted. `partial` without that is an operator who does not
    // know what is now in their catalog.
    const landed = (run: CommitRun): readonly LayerKey[] =>
      run.results.filter((result) => result.ack.status === 'accepted').map((result) => result.key);

    const stoppedAtPipelines = installation();
    const stoppedAtWorkflows = installation();
    const [atPipelines, atWorkflows] = [
      await commitPackage(
        stoppedAtPipelines,
        await planFor(stoppedAtPipelines, SELF_CONTAINED),
        'workspace',
        held(stoppedAtPipelines, 'workspace'),
        { failOn: 'pipelines' }
      ),
      await commitPackage(
        stoppedAtWorkflows,
        await planFor(stoppedAtWorkflows, SELF_CONTAINED),
        'workspace',
        held(stoppedAtWorkflows, 'workspace'),
        { failOn: 'workflows' }
      )
    ];

    expect(atPipelines.outcome).toBe('partial');
    expect(landed(atPipelines)).toEqual(['phases']);
    expect(atWorkflows.outcome).toBe('partial');
    expect(landed(atWorkflows)).toEqual(['phases', 'pipelines']);
  });

  it('performs zero compensating deletions on either partial path (FR-051)', async () => {
    // The write spy records every `updateConfig` the run makes. A compensating
    // delete would be a second write to a layer already written — so the check is
    // that no key appears twice, on top of the row-level check that nothing seeded
    // was removed.
    for (const failOn of ['pipelines', 'workflows'] as const) {
      const inst = installation({
        phases: { workspace: [HELD_PHASE] },
        pipelines: { workspace: [HELD_PIPELINE] },
        workflows: { workspace: [HELD_WORKFLOW] }
      });
      const plan = await planFor(inst, SELF_CONTAINED);

      const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'), {
        failOn
      });

      expect(run.outcome).toBe('partial');
      expect(new Set(run.writes).size).toBe(run.writes.length);
      // Every pre-existing row survives, in place, in all three layers.
      expect(inst.phases.workspace[0]).toEqual(HELD_PHASE);
      expect(inst.pipelines.workspace[0]).toEqual(HELD_PIPELINE);
      expect(inst.workflows.workspace[0]).toEqual(HELD_WORKFLOW);
      // And nothing that landed was taken back.
      expect(effectivePhaseIds(inst)).toContain('specify');
    }
  });

  it('re-running after a Pipeline-write failure skips the Phases and completes the rest (FR-052, SC-016)', async () => {
    const inst = installation();
    const first = await commitPackage(
      inst,
      await planFor(inst, SELF_CONTAINED),
      'user',
      held(inst, 'user'),
      { failOn: 'pipelines' }
    );
    expect(first.outcome).toBe('partial');

    // Nothing about the retry is special-cased: the same document, the same
    // preflight. The presence scan sees the landed Phase row and plans `skip` for
    // it, which is what makes the retry self-healing at whatever depth it stopped.
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 3, skip: 1, blocked: 0, invalid: 0 });
    const skipped = plan.rows.filter((row) => row.outcome === 'skip');
    expect(skipped).toEqual([
      expect.objectContaining({ resourceKind: 'phase', resourceId: 'specify' })
    ]);

    const second = await commitPackage(inst, plan, 'user', held(inst, 'user'));

    expect(second.outcome).toBe('imported');
    expect(second.writes).toEqual(['pipelines', 'workflows']);
    // The Phase row is the one the first run wrote, untouched and not duplicated.
    expect(inst.phases.user).toHaveLength(1);
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('re-running after a Workflow-write failure skips both lower layers (FR-052, SC-016)', async () => {
    const inst = installation();
    const first = await commitPackage(
      inst,
      await planFor(inst, SELF_CONTAINED),
      'workspace',
      held(inst, 'workspace'),
      { failOn: 'workflows' }
    );
    expect(first.outcome).toBe('partial');

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 1, skip: 3, blocked: 0, invalid: 0 });
    expect(plan.rows.filter((row) => row.outcome === 'import')).toEqual([
      expect.objectContaining({ resourceKind: 'workflow', resourceId: 'ship-it-flow' })
    ]);

    const second = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(second.outcome).toBe('imported');
    expect(second.writes).toEqual(['workflows']);
    expect(inst.phases.workspace).toHaveLength(1);
    expect(inst.pipelines.workspace).toHaveLength(2);
    expect(effectiveWorkflowIds(inst)).toContain('ship-it-flow');
  });

  it('re-running a fully imported document writes nothing at all (FR-052)', async () => {
    // The terminal case of the same property: once everything is present, the
    // presence scan classifies every resource `skip` and there is no write to make.
    // Re-running is idempotent, not merely non-destructive.
    const inst = installation();
    expect((await commitPackage(inst, await planFor(inst, SELF_CONTAINED), 'user', held(inst, 'user'))).outcome).toBe(
      'imported'
    );
    const settled = snapshot(inst, 'user');

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 0, skip: 4, blocked: 0, invalid: 0 });

    const again = await commitPackage(inst, plan, 'user', held(inst, 'user'));

    expect(again.writes).toEqual([]);
    expect(again.results).toEqual([]);
    // Vacuously `imported` — zero attempts, zero failures. Nothing to report as
    // partial, because nothing was attempted.
    expect(again.outcome).toBe('imported');
    expect(snapshot(inst, 'user')).toBe(settled);
  });
});
