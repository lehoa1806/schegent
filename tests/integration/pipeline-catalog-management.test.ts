// Feature 082 (US2, T036) — the persisted Phase sequence survives a full
// save-and-reload round trip.
//
// The Phase sequence is positional: a `phaseId` may repeat inside one Pipeline,
// so order is the only thing that distinguishes position 0 from position 2
// (research R3). This exercises the real handler and the real catalog resolver
// end to end — save through `cmd-save-pipelines`, reload the rows the host
// actually wrote through `resolvePipelineCatalog` — and asserts that neither
// side sorts, dedupes, or otherwise normalizes the order, and that a reorder's
// remapped binding `phaseIndex` values are persisted exactly as submitted.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { capabilities: new Map<string, boolean>() }
}));

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/test-workspace', scheme: 'file' },
    name: 'test-workspace',
    index: 0
  })
}));

import { pipelineLayerRevision, resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import type {
  PipelineCatalogMutation,
  PipelineDefinition
} from '../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import { handler as savePipelinesHandler } from '../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePipelinesCommand } from '../../src/ui/sidebar/messages';

const PHASE_CATALOG: readonly PhaseDefinition[] = [
  { phaseId: 'speckit-specify', name: 'Specify', version: 1, instruction: 'Specify.' },
  { phaseId: 'speckit-plan', name: 'Plan', version: 1, instruction: 'Plan.' },
  { phaseId: 'done', name: 'Done', version: 1, instruction: 'Done.' }
];

/** The same Phases in authored settings form, for the save side's Phase layer. */
const AUTHORED_PHASE_ROWS: readonly unknown[] = PHASE_CATALOG.map((phase) => ({
  id: phase.phaseId,
  name: phase.name,
  version: phase.version,
  instruction: `${phase.name}.`
}));

// Deliberately not alphabetical, and `speckit-specify` appears twice: any
// sort or dedupe anywhere on the path shows up as a changed sequence.
const AUTHORED_PHASES = ['speckit-specify', 'speckit-plan', 'speckit-specify', 'done'] as const;

// The same rows after moving position 3 to position 1, with every binding
// `phaseIndex` remapped by the same permutation (US2). The host must persist
// this verbatim; it never re-derives the order or the indices.
const REORDERED_PHASES = ['speckit-specify', 'done', 'speckit-plan', 'speckit-specify'] as const;

const AUTHORED_BINDINGS = [
  { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
  { kind: 'output', phaseIndex: 1, portId: 'plan-doc', outputKey: 'plan' },
  { kind: 'input', phaseIndex: 2, inputKey: 'plan', source: { from: 'phase-output', phaseIndex: 1, portId: 'plan-doc' } }
] as const;

const REORDERED_BINDINGS = [
  { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
  { kind: 'output', phaseIndex: 2, portId: 'plan-doc', outputKey: 'plan' },
  { kind: 'input', phaseIndex: 3, inputKey: 'plan', source: { from: 'phase-output', phaseIndex: 2, portId: 'plan-doc' } }
] as const;

function authoredRow(
  phases: readonly string[],
  bindings: readonly unknown[],
  version = 1
): Record<string, unknown> {
  return {
    id: 'ordered-flow',
    name: 'Ordered Flow',
    version,
    phases: [...phases],
    inputs: [
      { portId: 'brief', label: 'Brief', type: 'text' },
      { portId: 'plan-doc', label: 'Plan document', type: 'pipeline-output' }
    ],
    outputs: [{ portId: 'plan-doc', label: 'Plan document', type: 'markdown' }],
    bindings: [...bindings]
  };
}

interface WriteCall {
  readonly key: string;
  readonly value: unknown;
  readonly scope: string | undefined;
}

interface SaveOutcome {
  readonly ack: CommandAckMessage;
  readonly persisted: readonly unknown[];
  readonly writes: readonly WriteCall[];
}

interface SaveOptions {
  /** The lower-precedence layer, left in place so removals can fall back to it. */
  readonly user?: readonly unknown[];
  /** Workflow → Pipeline references gate 13 consults (US7, FR-022a). */
  readonly workflows?: readonly { readonly workflowId: string; readonly pipelineId: string }[];
  /**
   * Overrides the revision the window echoes. A second window that read the
   * layer before someone else wrote it sends the revision it saw, not the one
   * the host now holds (FR-030).
   */
  readonly expectedRevision?: string;
}

/** Runs the real save handler against an in-memory `workspace` layer. */
async function save(
  currentLayer: readonly unknown[],
  mutation: PipelineCatalogMutation,
  rows: readonly unknown[],
  options: SaveOptions = {}
): Promise<SaveOutcome> {
  const acks: CommandAckMessage[] = [];
  const writes: WriteCall[] = [];
  let persisted: readonly unknown[] = currentLayer;
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (value: string) => value
      },
      audit: { append: vi.fn() },
      updateConfig: vi.fn(async (key: string, value: unknown, scope?: string) => {
        writes.push({ key, value, scope });
        persisted = value as readonly unknown[];
      }),
      readPipelineConfig: () => ({ user: options.user ?? [], workspace: currentLayer }),
      readWorkflowPipelineRefs: () => options.workflows ?? [],
      // Gate 5 resolves every `phaseId` against the effective Phase catalog, so
      // the reload side's `PHASE_CATALOG` and the save side's Phase layers have
      // to describe the same Phases.
      readPhaseConfig: () => ({ user: [], workspace: AUTHORED_PHASE_ROWS })
    },
    postAck: async (message: CommandAckMessage) => {
      acks.push(message);
      return true;
    },
    correlationId: 'test-correlation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const command: SavePipelinesCommand = {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-correlation-1',
    payload: {
      scope: 'workspace',
      expectedRevision: options.expectedRevision ?? pipelineLayerRevision(currentLayer),
      mutation,
      pipelines: rows
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  await savePipelinesHandler(ctx, command);
  return { ack: acks[0], persisted, writes };
}

/** Reloads a persisted layer exactly as the host does on the next projection. */
function reload(workspace: readonly unknown[]): PipelineDefinition {
  const catalog = resolvePipelineCatalog({
    builtIn: [],
    user: [],
    workspace,
    phaseCatalog: PHASE_CATALOG
  });
  const definition = catalog.effective.find(
    (candidate) => candidate.pipelineId === 'ordered-flow'
  );
  expect(definition, 'the saved Pipeline must resolve as effective on reload').toBeDefined();
  return definition as PipelineDefinition;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
});

describe('Pipeline catalog management — Phase sequence order round-trip (US2, T036)', () => {
  it('persists the authored Phase order verbatim and reloads it unchanged', async () => {
    const { ack, persisted } = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [
      authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS)
    ]);

    expect(ack.status).toBe('accepted');
    expect((persisted[0] as { phases: readonly string[] }).phases).toEqual([...AUTHORED_PHASES]);
    expect(reload(persisted).phaseIds).toEqual([...AUTHORED_PHASES]);
  });

  it('round-trips a reorder together with its remapped binding indices', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [
      authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS)
    ]);
    const storedVersion = (created.persisted[0] as { version: number }).version;

    const reordered = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [authoredRow(REORDERED_PHASES, REORDERED_BINDINGS, storedVersion)]
    );

    expect(reordered.ack.status).toBe('accepted');
    const definition = reload(reordered.persisted);
    expect(definition.phaseIds).toEqual([...REORDERED_PHASES]);
    expect(definition.bindings).toEqual([...REORDERED_BINDINGS]);
  });

  it('carries the reloaded order through to the runtime Pipeline projection', async () => {
    const { persisted } = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [
      authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS)
    ]);

    const catalog = resolvePipelineCatalog({
      builtIn: [],
      user: [],
      workspace: persisted,
      phaseCatalog: PHASE_CATALOG
    });
    const runtime = catalog.effectivePipelineDefs.find(
      (candidate) => candidate.id === 'ordered-flow'
    );
    expect(runtime?.phases).toEqual([...AUTHORED_PHASES]);
  });

  it('treats a pure reorder as a real change to the layer revision', async () => {
    const original = pipelineLayerRevision([authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS)]);
    const moved = pipelineLayerRevision([authoredRow(REORDERED_PHASES, REORDERED_BINDINGS)]);
    expect(moved).not.toBe(original);
  });
});

// ── US7 (T052) — scope-isolated removal and fallback resolution (SC-006) ──────
//
// A removal is an edit to exactly one layer. The two things that can go wrong
// are the two things asserted here: writing more than the selected scope, and
// losing the `pipelineId` entirely when a lower-precedence source still defines
// it. The same pair is what makes the removal safe to permit at all — gate 13
// blocks only when neither a remaining source nor an unreferenced id applies.

const WORKSPACE_SCOPED_ROW = {
  id: 'scoped-flow',
  name: 'Workspace Scoped Flow',
  version: 1,
  phases: ['speckit-plan', 'done']
} as const;

const USER_SCOPED_ROW = {
  id: 'scoped-flow',
  name: 'User Scoped Flow',
  version: 1,
  phases: ['done']
} as const;

const REMOVE_SCOPED: PipelineCatalogMutation = { kind: 'remove', pipelineId: 'scoped-flow' };

function resolveScoped(user: readonly unknown[], workspace: readonly unknown[]) {
  return resolvePipelineCatalog({ builtIn: [], user, workspace, phaseCatalog: PHASE_CATALOG });
}

function effectiveScoped(user: readonly unknown[], workspace: readonly unknown[]) {
  const catalog = resolveScoped(user, workspace);
  return {
    definition: catalog.effective.find((entry) => entry.pipelineId === 'scoped-flow'),
    scope: catalog.records.find(
      (record) => record.pipelineId === 'scoped-flow' && record.status === 'effective'
    )?.scope
  };
}

describe('Pipeline catalog management — scoped removal and fallback (US7, T052, SC-006)', () => {
  it('writes only the selected scope and leaves the lower-precedence layer untouched', async () => {
    const userLayer = [{ ...USER_SCOPED_ROW }];

    const removal = await save([WORKSPACE_SCOPED_ROW], REMOVE_SCOPED, [], {
      user: userLayer,
      workflows: [{ workflowId: 'wf-1', pipelineId: 'scoped-flow' }]
    });

    expect(removal.ack.status).toBe('accepted');
    expect(removal.writes).toEqual([{ key: 'pipelines', value: [], scope: 'workspace' }]);
    expect(userLayer).toEqual([USER_SCOPED_ROW]);
  });

  it('exposes the lower-precedence definition as effective after the removal', async () => {
    const before = effectiveScoped([USER_SCOPED_ROW], [WORKSPACE_SCOPED_ROW]);
    expect(before.definition?.name).toBe('Workspace Scoped Flow');
    expect(before.scope).toBe('workspace');

    const removal = await save([WORKSPACE_SCOPED_ROW], REMOVE_SCOPED, [], {
      user: [USER_SCOPED_ROW],
      workflows: [{ workflowId: 'wf-1', pipelineId: 'scoped-flow' }]
    });

    const after = effectiveScoped([USER_SCOPED_ROW], removal.persisted);
    expect(removal.ack.status).toBe('accepted');
    expect(after.definition?.name).toBe('User Scoped Flow');
    expect(after.definition?.phaseIds).toEqual(['done']);
    expect(after.scope).toBe('user');
  });

  it('blocks the removal and touches neither layer when no source would remain', async () => {
    const removal = await save([WORKSPACE_SCOPED_ROW], REMOVE_SCOPED, [], {
      workflows: [{ workflowId: 'wf-1', pipelineId: 'scoped-flow' }]
    });

    expect(removal.ack).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { pipelineIds: ['scoped-flow'], dependentWorkflowIds: ['wf-1'], total: 1 }
    });
    expect(removal.writes).toEqual([]);
    expect(removal.persisted).toEqual([WORKSPACE_SCOPED_ROW]);
    expect(effectiveScoped([], removal.persisted).definition?.name).toBe('Workspace Scoped Flow');
  });
});

// T057 (FR-029, FR-030, SC-008) — two windows edit the same layer. The second
// one must lose cleanly: rejected with what the host actually holds and what
// the operator may legally do next, and with the persisted layer untouched.
// The trust case is the same contract from the other direction — an untrusted
// window is refused before any write, not after a partial one.
describe('Pipeline catalog management — concurrent windows and trust (T057)', () => {
  const ROW = authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS);

  it('rejects a save against a superseded revision with the authoritative record and legal actions', async () => {
    // Window A creates the row; window B still holds the revision of the empty
    // layer it read before that.
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    expect(created.ack.status).toBe('accepted');
    const staleRevision = pipelineLayerRevision([]);
    const currentRevision = pipelineLayerRevision(created.persisted);
    expect(staleRevision).not.toBe(currentRevision);

    const outcome = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [{ ...(created.persisted[0] as Record<string, unknown>), name: 'Renamed By Window B' }],
      { expectedRevision: staleRevision }
    );

    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('stale-catalog');
    const rejection = outcome.ack.result as {
      currentRevision: string;
      current: { scope: string; pipelineId: string; name: string; version: number; legalActions: string[] };
    };
    expect(rejection.currentRevision).toBe(currentRevision);
    expect(rejection.current.scope).toBe('workspace');
    expect(rejection.current.pipelineId).toBe('ordered-flow');
    // The authoritative record as the host holds it — not what window B sent.
    expect(rejection.current.name).toBe('Ordered Flow');
    expect(rejection.current.version).toBe(1);
    expect(rejection.current.legalActions).toEqual(['refresh', 'reapply']);
  });

  it('changes no state on a stale save — the layer is never written', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    const outcome = await save(
      created.persisted,
      { kind: 'remove', pipelineId: 'ordered-flow' },
      [],
      { expectedRevision: pipelineLayerRevision([]) }
    );
    expect(outcome.ack.reason).toBe('stale-catalog');
    expect(outcome.writes).toEqual([]);
    expect(outcome.persisted).toEqual(created.persisted);
  });

  it('rejects an untrusted window before any write (FR-029)', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const outcome = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('trust-denied');
    expect((outcome.ack.result as { capability: string }).capability).toBe('pipelineOverrides');
    expect(outcome.writes).toEqual([]);
    expect(outcome.persisted).toEqual([]);
  });

  it('still lets an untrusted window return the layer to defaults (feature 059 I-2)', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    mocks.state.capabilities.set('pipelineOverrides', false);
    const outcome = await save(created.persisted, { kind: 'reset' }, []);
    expect(outcome.ack.status).toBe('accepted');
    expect(outcome.writes).toEqual([{ key: 'pipelines', value: [], scope: 'workspace' }]);
  });

  it('applies the revision gate before the trust gate, so a stale untrusted save reports the staleness', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    mocks.state.capabilities.set('pipelineOverrides', false);
    const outcome = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [{ ...(created.persisted[0] as Record<string, unknown>), name: 'Renamed' }],
      { expectedRevision: pipelineLayerRevision([]) }
    );
    expect(outcome.ack.reason).toBe('stale-catalog');
    expect(outcome.writes).toEqual([]);
  });
});
