// BUG-001 (FR-013, T022) — foundational field validation tests for
// cmd-save-pipelines. These cover the pre-persist validation that runs
// BEFORE the trust gate and BEFORE anything reaches the store.
//
// Feature 099 (T496f, FR-042/FR-042a) — the write port is the versioned catalog
// store's `saveLayer`, not `updateConfig('pipelines', rows, scope)`, and there is
// one Phase catalog rather than three layers. Every "nothing was written" claim
// below is unchanged; it is now made against the store's recorded layer saves.
//
// Feature 082 (T025) migrated these to the scoped, revisioned envelope. The
// BUG-001 coverage is unchanged — every field rule still rejects before any
// write — but the rejection now carries the structured `pipeline-validation`
// reason with a bounded `PipelineFieldError[]` payload instead of the
// pre-082 `pipeline-validation:<id>:<field>:<code>` composite string, and
// the field/code vocabulary is the one `validatePipelineDefinition` emits.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    canonicalBasename: 'test-workspace' as string
  };
  return { state };
});

vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) =>
    mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: (capability: string) =>
    mocks.state.scopes.get(capability) ?? 'workspace-trust'
}));

vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: `/tmp/${mocks.state.canonicalBasename}`, scheme: 'file' },
    name: mocks.state.canonicalBasename,
    index: 0
  })
}));

import { handler as savePipelinesHandler } from '../../../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePipelinesCommand } from '../../../../../src/ui/sidebar/messages';
import { FakeCatalogStore } from '../../../../fixtures/fake-catalog-store';
import { SPECKIT_PHASE_DEFS } from '../../../../fixtures/speckit-catalog-fixture';
import type { CatalogLayerSaveRequest } from '../../../../../src/contracts/catalog-store';
import type {
  PipelineCatalogMutation,
  PipelineFieldError
} from '../../../../../src/contracts/pipeline-definitions';

function buildCtx(
  current: readonly unknown[] = [],
  // Feature 098 (T080) — this default used to be empty, because the Phases these
  // payloads name resolved out of the built-in layer. That layer is empty now, so
  // the default carries the rows instead; a caller that passes its own rows is
  // testing resolution and supplies what it means to. See the fixture header for
  // why the ids are the real Spec Kit ones.
  //
  // Feature 099 (T496f, FR-042) — one list, not `{ user, workspace }`.
  phaseRows: readonly unknown[] = SPECKIT_PHASE_DEFS
): {
  ctx: Parameters<typeof savePipelinesHandler>[0];
  acks: CommandAckMessage[];
  store: FakeCatalogStore;
  /** Every layer save the handler reached — the successor of the `updateConfig` recorder. */
  layerSaves: CatalogLayerSaveRequest[];
} {
  const acks: CommandAckMessage[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const audit = {
    append: vi.fn(async () => {})
  };
  const store = new FakeCatalogStore({ phases: phaseRows, pipelines: current });
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit: audit as any,
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'),
        revision: store.revisionOf('pipeline')
      }),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-validation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, store, layerSaves: store.layerSaves };
}

/**
 * What a store reports for the Pipeline catalog before anything is saved into it.
 *
 * Feature 099 (FR-044a) — a revision is the manifest's, not a hash over the rows,
 * so seeding the harness with rows does not move it. Every case below echoes this
 * one value where it used to echo `pipelineLayerRevision(current)`.
 */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('pipeline');

function makeCmd(
  pipelines: readonly unknown[],
  mutation: PipelineCatalogMutation = { kind: 'create', pipelineId: 'valid-id' }
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-validation-1',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation,
      pipelines
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** The bounded `{ errors, total }` payload gate 4 attaches to the rejection. */
function fieldErrors(ack: CommandAckMessage): readonly PipelineFieldError[] {
  return (ack.result as { errors: readonly PipelineFieldError[] }).errors;
}

function hasError(
  ack: CommandAckMessage,
  pipelineId: string,
  field: string,
  code: string
): boolean {
  return fieldErrors(ack).some(
    (error) => error.pipelineId === pipelineId && error.field === field && error.code === code
  );
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
});

describe('cmd-save-pipelines foundational validation (BUG-001, FR-013)', () => {
  it('rejects pipeline with invalid id pattern', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'UPPER-CASE', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'UPPER-CASE', 'pipelineId', 'invalid-pattern')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with empty id', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: '', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    // An empty id has no printable identity, so the validator reports it as '?'.
    expect(hasError(acks[0], '?', 'pipelineId', 'invalid-pattern')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with empty name', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'name', 'invalid-length')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with name exceeding 80 chars', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'a'.repeat(81), phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'name', 'invalid-length')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with empty phases array', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds', 'non-empty-required')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with non-array phases', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: 'not-an-array' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds', 'non-empty-required')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects pipeline with non-string phase entries', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [42, 'speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[0]', 'invalid-pattern')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects an authored row carrying an unknown field', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify'], surprise: true }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'surprise', 'unknown-field')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects two rows sharing one pipelineId in the same scope (FR-036)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'First', phases: ['speckit-specify'] },
      { id: 'valid-id', name: 'Second', phases: ['finalize'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'pipelineId', 'duplicate-in-scope')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('bounds the reported errors and reports the true total (FR-032)', async () => {
    const { ctx, acks } = buildCtx();
    // 12 rows x 2 field errors each = 24 errors, above the 20-entry cap.
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `row-${index}`,
      name: '',
      phases: []
    }));
    await savePipelinesHandler(ctx, makeCmd(rows));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(fieldErrors(acks[0])).toHaveLength(20);
    expect((acks[0].result as { total: number }).total).toBe(24);
  });

  it('accepts pipeline with all valid foundational fields', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-flow', name: 'Valid Flow', phases: ['speckit-specify', 'finalize'] }
    ], { kind: 'create', pipelineId: 'valid-flow' }));
    expect(acks[0].status).toBe('accepted');
    expect(layerSaves).toHaveLength(1);
    expect(layerSaves[0].kind).toBe('pipeline');
  });

  it('rejects the whole layer when any row in a multi-pipeline payload is invalid', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'good-flow', name: 'Good', phases: ['speckit-specify'] },
      { id: 'bad-flow', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'bad-flow', 'name', 'invalid-length')).toBe(true);
    // Transactional save (FR-020) — the valid sibling is not written either.
    expect(layerSaves).toEqual([]);
  });

  it('validation runs before trust gate (rejects invalid even when trust is denied)', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const { ctx, acks } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'INVALID', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    // Foundational validation must fire before trust gate.
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'INVALID', 'pipelineId', 'invalid-pattern')).toBe(true);
  });
});

// Feature 082 (US3, T037) — gates 5 and 6. Gate 5 resolves every `phaseId` and
// every binding against the *effective* Phase catalog rather than against the
// stored rows. Every case asserts the exact `field`/`code` pair the Builder
// renders next to its control (FR-017) and that nothing was written (FR-020,
// SC-003).
//
// Feature 099 (T496f, FR-042) — "effective" used to mean "resolved across three
// layers", and the two cases below turned on that. One catalog does not make the
// distinction vacuous: a gate reading the stored rows and a gate reading the
// resolution still disagree, because resolution can refuse a row the rows
// themselves plainly contain. That is what the second case now exercises.
const authoredPhase = (phaseId: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id: phaseId,
  name,
  version: 1,
  instruction: `${name}.`,
  ...overrides
});

describe('cmd-save-pipelines cross-reference validation (082, gates 5-6)', () => {
  it('rejects a phaseId with no effective definition (FR-011)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify', 'ghost-phase'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[1]', 'unknown-phase')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('resolves a Phase the operator authored alongside the ones a document supplied', async () => {
    // Feature 098 (T080) — neither of these comes from the host; both are stored
    // rows. Feature 099 (T496f, FR-042) — they used to sit in different layers, to
    // show a Phase resolving from whichever layer supplied it. With one catalog the
    // surviving claim is that gate 5 resolves against the catalog rather than
    // against any fixed set of ids, which an operator-named id still demonstrates.
    const { ctx, acks, layerSaves } = buildCtx([], [
      ...SPECKIT_PHASE_DEFS,
      authoredPhase('operator-authored', 'Operator Authored')
    ]);
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify', 'operator-authored'] }
    ], { kind: 'create', pipelineId: 'valid-id' }));
    expect(acks[0].status).toBe('accepted');
    expect(layerSaves).toHaveLength(1);
  });

  it('refuses a Phase the catalog holds twice, because neither copy resolves (FR-011)', async () => {
    // Feature 099 (T496f, FR-042) — this was "resolves a multi-scope Phase to its
    // highest-precedence valid source": a workspace row shadowed a valid user row
    // and was itself invalid, so the Phase still resolved and the save was
    // accepted. Two rows under one id are a DUPLICATE now, not a shadow, and
    // `invalidateDuplicates` marks both invalid — so the successor answer is that
    // the Phase resolves to nothing and the Pipeline naming it is refused.
    //
    // The claim under test survives intact and is if anything sharper: a gate that
    // read the stored rows instead of the resolution would find `shared-phase`
    // present, twice, and accept. Only a gate reading the resolved catalog reports
    // `unknown-phase` here.
    const { ctx, acks, layerSaves } = buildCtx([], [
      ...SPECKIT_PHASE_DEFS,
      authoredPhase('shared-phase', 'First Copy'),
      authoredPhase('shared-phase', 'Second Copy', { version: 4 })
    ]);
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['shared-phase'] }
    ], { kind: 'create', pipelineId: 'valid-id' }));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[0]', 'unknown-phase')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects a binding that writes to an undeclared output port (FR-016)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify', 'finalize'],
        outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }],
        bindings: [{ kind: 'output', phaseIndex: 1, portId: 'missing-port', outputKey: 'out' }]
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'bindings[0].portId', 'binding-unknown-output-port')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects a Phase output consumed through a non-bridge input port type (FR-016)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify', 'finalize'],
        inputs: [{ portId: 'plan-doc', label: 'Plan', type: 'text' }],
        outputs: [{ portId: 'plan-doc', label: 'Plan', type: 'markdown' }],
        bindings: [
          { kind: 'output', phaseIndex: 0, portId: 'plan-doc', outputKey: 'plan' },
          {
            kind: 'input',
            phaseIndex: 1,
            inputKey: 'plan',
            source: { from: 'phase-output', phaseIndex: 0, portId: 'plan-doc' }
          }
        ]
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'bindings[1].src.portId', 'binding-type-mismatch')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects a Phase that consumes an output produced later in the sequence (FR-015)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify', 'finalize'],
        inputs: [{ portId: 'plan-doc', label: 'Plan', type: 'pipeline-output' }],
        outputs: [{ portId: 'plan-doc', label: 'Plan', type: 'markdown' }],
        bindings: [
          { kind: 'output', phaseIndex: 1, portId: 'plan-doc', outputKey: 'plan' },
          {
            kind: 'input',
            phaseIndex: 0,
            inputKey: 'plan',
            source: { from: 'phase-output', phaseIndex: 1, portId: 'plan-doc' }
          }
        ]
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(
      hasError(acks[0], 'valid-id', 'bindings[1].src.phaseIndex', 'binding-forward-reference')
    ).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects a binding whose Phase position is outside the sequence (FR-015)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify'],
        outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }],
        bindings: [{ kind: 'output', phaseIndex: 4, portId: 'report', outputKey: 'out' }]
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(
      hasError(acks[0], 'valid-id', 'bindings[0].phaseIndex', 'binding-phase-out-of-range')
    ).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects two ports declaring the same portId (FR-016)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify'],
        inputs: [
          { portId: 'brief', label: 'Brief', type: 'text' },
          { portId: 'brief', label: 'Second brief', type: 'text' }
        ]
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'inputs[1].portId', 'duplicate-port-id')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('rejects an unknown executionDefaults key (FR-018)', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify'],
        executionDefaults: { speed: 'fast' }
      }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(
      hasError(acks[0], 'valid-id', 'executionDefaults.speed', 'execution-defaults-unknown-field')
    ).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('runs gate 5 before the trust gate and writes nothing (FR-020, SC-003)', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['ghost-phase'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[0]', 'unknown-phase')).toBe(true);
    expect(layerSaves).toEqual([]);
  });

  it('accepts a Pipeline whose Phases and bindings all resolve', async () => {
    const { ctx, acks, layerSaves } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      {
        id: 'valid-id',
        name: 'Test',
        phases: ['speckit-specify', 'finalize'],
        inputs: [
          { portId: 'brief', label: 'Brief', type: 'text' },
          { portId: 'plan-doc', label: 'Plan', type: 'pipeline-output' }
        ],
        outputs: [{ portId: 'plan-doc', label: 'Plan', type: 'markdown' }],
        bindings: [
          {
            kind: 'input',
            phaseIndex: 0,
            inputKey: 'brief',
            source: { from: 'pipeline-input', portId: 'brief' }
          },
          { kind: 'output', phaseIndex: 0, portId: 'plan-doc', outputKey: 'plan' },
          {
            kind: 'input',
            phaseIndex: 1,
            inputKey: 'plan',
            source: { from: 'phase-output', phaseIndex: 0, portId: 'plan-doc' }
          }
        ]
      }
    ], { kind: 'create', pipelineId: 'valid-id' }));
    expect(acks[0].status).toBe('accepted');
    expect(layerSaves).toHaveLength(1);
  });
});
