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
//
// Feature 099 (T496f, FR-042, FR-046) — the layer tier is gone, so a save no
// longer picks a scope and the store is the thing written. Two of this file's
// claims had to find new ground:
//
//   * US7's removal fallback rested on a lower-precedence layer becoming
//     effective. Gate 13 still blocks on the same conjunction, so the arm that
//     survives is the other one: nothing references the id, so the removal
//     lands (FR-022, FR-022a).
//   * The `pipelineOverrides` capability is deleted with the tier it guarded.
//     An untrusted workspace activates no catalog at all now (FR-051), so gate
//     1 refuses the save outright — for every mutation kind alike, `reset`
//     included, since there is no per-mutation capability left to exempt one.

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

import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import type {
  PipelineCatalogMutation,
  PipelineDefinition
} from '../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import { handler as savePipelinesHandler } from '../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePipelinesCommand } from '../../src/ui/sidebar/messages';
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';

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

/** One `saveLayer` request, reduced to what these tests assert about it. */
interface WriteCall {
  readonly kind: string;
  readonly rows: readonly unknown[];
}

interface SaveOutcome {
  readonly ack: CommandAckMessage;
  readonly persisted: readonly unknown[];
  readonly writes: readonly WriteCall[];
  readonly store: FakeCatalogStore;
}

interface SaveOptions {
  /** Workflow → Pipeline references gate 13 consults (US7, FR-022a). */
  readonly workflows?: readonly { readonly workflowId: string; readonly pipelineId: string }[];
  /**
   * Overrides the revision the window echoes. A second window that read the
   * catalog before someone else wrote it sends the revision it saw, not the one
   * the host now holds (FR-030).
   */
  readonly expectedRevision?: string;
  /**
   * An untrusted workspace activates no catalog, so the window has no store to
   * write (FR-051). Gate 1 is the whole of that contract.
   */
  readonly noStore?: boolean;
  /**
   * Continues against a store an earlier save already wrote, so the revision the
   * gate compares is the one that write moved. A fresh store per save would
   * reset it and make every stale case vacuously current.
   */
  readonly store?: FakeCatalogStore;
}

/** Runs the real save handler against an in-memory catalog store. */
async function save(
  currentRows: readonly unknown[],
  mutation: PipelineCatalogMutation,
  rows: readonly unknown[],
  options: SaveOptions = {}
): Promise<SaveOutcome> {
  const acks: CommandAckMessage[] = [];
  const store = options.store ?? new FakeCatalogStore({
    pipelines: currentRows,
    // Gate 5 resolves every `phaseId` against the effective Phase catalog, so
    // the reload side's `PHASE_CATALOG` and the save side's stored Phase rows
    // have to describe the same Phases.
    phases: AUTHORED_PHASE_ROWS
  });
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
      catalogStore: options.noStore ? null : store,
      refreshCatalog: async () => undefined,
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'),
        revision: store.revisionOf('pipeline')
      }),
      readWorkflowPipelineRefs: () => options.workflows ?? [],
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      })
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
      expectedRevision: options.expectedRevision ?? store.revisionOf('pipeline'),
      mutation,
      pipelines: rows
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // Only this save's store requests: a continued store still holds the earlier
  // ones, and `writes` means "what this call reached the store with".
  const before = store.layerSaves.length;
  await savePipelinesHandler(ctx, command);
  return {
    ack: acks[0],
    persisted: store.rowsOf('pipeline'),
    writes: store.layerSaves.slice(before).map((request) => ({
      kind: request.kind,
      rows: request.definitions.map((entry) => entry.body)
    })),
    store
  };
}

/** Reloads a persisted catalog exactly as the host does on the next projection. */
function reload(rows: readonly unknown[]): PipelineDefinition {
  const catalog = resolvePipelineCatalog({
    rows,
    revision: 'rev-reload',
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
      rows: persisted,
      revision: 'rev-reload',
      phaseCatalog: PHASE_CATALOG
    });
    const runtime = catalog.effectivePipelineDefs.find(
      (candidate) => candidate.id === 'ordered-flow'
    );
    expect(runtime?.phases).toEqual([...AUTHORED_PHASES]);
  });

  // Feature 099 — the revision is the store's, not a hash of the rows, so a
  // pure reorder proves itself by moving it: the store saw a real write.
  it('treats a pure reorder as a real change to the catalog revision', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [
      authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS)
    ]);
    const original = created.store.revisionOf('pipeline');
    const storedVersion = (created.persisted[0] as { version: number }).version;

    const moved = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [authoredRow(REORDERED_PHASES, REORDERED_BINDINGS, storedVersion)],
      { store: created.store }
    );
    expect(moved.ack.status).toBe('accepted');
    expect(moved.store.revisionOf('pipeline')).not.toBe(original);
  });
});

// ── US7 (T052) — isolated removal and gate 13's conjunction (SC-006) ─────────
//
// A removal is an edit to exactly one catalog. The two things that can go wrong
// are the two things asserted here: writing more than the catalog named, and
// stranding a Workflow that still references the id. Gate 13 blocks only when
// BOTH hold — the id has no effective source left AND something references it —
// so each condition is exercised on its own.

const SCOPED_ROW = {
  id: 'scoped-flow',
  name: 'Scoped Flow',
  version: 1,
  phases: ['speckit-plan', 'done']
} as const;

const NEIGHBOUR_ROW = {
  id: 'neighbour-flow',
  name: 'Neighbour Flow',
  version: 1,
  phases: ['done']
} as const;

const REMOVE_SCOPED: PipelineCatalogMutation = { kind: 'remove', pipelineId: 'scoped-flow' };

function effectiveScoped(rows: readonly unknown[]) {
  const catalog = resolvePipelineCatalog({
    rows,
    revision: 'rev-reload',
    phaseCatalog: PHASE_CATALOG
  });
  return catalog.effective.find((entry) => entry.pipelineId === 'scoped-flow');
}

describe('Pipeline catalog management — isolated removal and gate 13 (US7, T052, SC-006)', () => {
  it('writes only the catalog it named and leaves the sibling catalogs untouched', async () => {
    const removal = await save([SCOPED_ROW, NEIGHBOUR_ROW], REMOVE_SCOPED, [NEIGHBOUR_ROW]);

    expect(removal.ack.status).toBe('accepted');
    expect(removal.writes).toEqual([{ kind: 'pipeline', rows: [NEIGHBOUR_ROW] }]);
    // The Phase catalog the same store holds is neither written nor moved.
    expect(removal.store.rowsOf('phase')).toEqual(AUTHORED_PHASE_ROWS);
    expect(removal.store.revisionOf('phase')).toBe('rev-phase-0');
  });

  // Feature 099 — the permitting arm used to be "a lower-precedence source
  // remains effective". One catalog leaves the other arm of the same
  // conjunction: the id goes away entirely, and nothing referenced it.
  it('lets the removal land when no Workflow references the id', async () => {
    expect(effectiveScoped([SCOPED_ROW])?.name).toBe('Scoped Flow');

    const removal = await save([SCOPED_ROW, NEIGHBOUR_ROW], REMOVE_SCOPED, [NEIGHBOUR_ROW], {
      workflows: [{ workflowId: 'wf-1', pipelineId: 'some-other-flow' }]
    });

    expect(removal.ack.status).toBe('accepted');
    expect(removal.persisted).toEqual([NEIGHBOUR_ROW]);
    expect(effectiveScoped(removal.persisted)).toBeUndefined();
  });

  it('blocks the removal and writes nothing when no source would remain', async () => {
    const removal = await save([SCOPED_ROW], REMOVE_SCOPED, [], {
      workflows: [{ workflowId: 'wf-1', pipelineId: 'scoped-flow' }]
    });

    expect(removal.ack).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { pipelineIds: ['scoped-flow'], dependentWorkflowIds: ['wf-1'], total: 1 }
    });
    expect(removal.writes).toEqual([]);
    expect(removal.persisted).toEqual([SCOPED_ROW]);
    expect(effectiveScoped(removal.persisted)?.name).toBe('Scoped Flow');
  });
});

// T057 (FR-029, FR-030, SC-008) — two windows edit the same catalog. The second
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
    const staleRevision = 'rev-pipeline-0';
    const currentRevision = created.store.revisionOf('pipeline');
    expect(staleRevision).not.toBe(currentRevision);

    const outcome = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [{ ...(created.persisted[0] as Record<string, unknown>), name: 'Renamed By Window B' }],
      { expectedRevision: staleRevision, store: created.store }
    );

    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('stale-catalog');
    const rejection = outcome.ack.result as {
      currentRevision: string;
      current: { pipelineId: string; name: string; version: number; legalActions: string[] };
    };
    expect(rejection.currentRevision).toBe(currentRevision);
    // Feature 099 — the record used to name the layer it came from. One catalog:
    // the identifier is the whole address, and no `scope` is reported at all.
    expect(rejection.current).not.toHaveProperty('scope');
    expect(rejection.current.pipelineId).toBe('ordered-flow');
    // The authoritative record as the host holds it — not what window B sent.
    expect(rejection.current.name).toBe('Ordered Flow');
    expect(rejection.current.version).toBe(1);
    expect(rejection.current.legalActions).toEqual(['refresh', 'reapply']);
  });

  it('changes no state on a stale save — the catalog is never written', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    const outcome = await save(
      created.persisted,
      { kind: 'remove', pipelineId: 'ordered-flow' },
      [],
      { expectedRevision: 'rev-pipeline-0', store: created.store }
    );
    expect(outcome.ack.reason).toBe('stale-catalog');
    expect(outcome.writes).toEqual([]);
    expect(outcome.persisted).toEqual(created.persisted);
  });

  // Feature 099 (FR-046, FR-051) — the `pipelineOverrides` capability is deleted
  // with the tier it guarded. An untrusted workspace activates no catalog, so
  // the same window is refused at gate 1 instead, still before any write.
  it('rejects a window with no activated catalog before any write (FR-029, FR-051)', async () => {
    const outcome = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW], {
      noStore: true
    });
    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('config-ops-unavailable');
    expect(outcome.writes).toEqual([]);
    expect(outcome.persisted).toEqual([]);
  });

  // Feature 059's I-2 exempted `reset` from the capability ceiling: returning to
  // defaults could never redefine anything. With no capability left, gate 1 is
  // unconditional and every mutation kind is refused alike — there is nowhere to
  // write a reset either.
  it('refuses a reset the same way when no catalog is activated (feature 059 I-2)', async () => {
    const outcome = await save([ROW], { kind: 'reset' }, [], { noStore: true });
    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('config-ops-unavailable');
    expect(outcome.writes).toEqual([]);
    expect(outcome.persisted).toEqual([ROW]);
  });

  it('applies gate 1 before the revision gate, so a storeless stale save reports the missing store', async () => {
    const created = await save([], { kind: 'create', pipelineId: 'ordered-flow' }, [ROW]);
    const outcome = await save(
      created.persisted,
      { kind: 'edit', pipelineId: 'ordered-flow' },
      [{ ...(created.persisted[0] as Record<string, unknown>), name: 'Renamed' }],
      { expectedRevision: 'rev-pipeline-0', noStore: true, store: created.store }
    );
    expect(outcome.ack.reason).toBe('config-ops-unavailable');
    expect(outcome.writes).toEqual([]);
  });
});
