// BUG-001 (FR-013, T022) — foundational field validation tests for
// cmd-save-pipelines. These cover the pre-persist validation that runs
// BEFORE the trust gate and BEFORE updateConfig.
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
import { pipelineLayerRevision } from '../../../../../src/config/pipeline-catalog';
import { SPECKIT_PHASE_DEFS } from '../../../../fixtures/speckit-catalog-fixture';
import type {
  PipelineCatalogMutation,
  PipelineFieldError
} from '../../../../../src/contracts/pipeline-definitions';

interface PhaseLayers {
  readonly user: readonly unknown[];
  readonly workspace: readonly unknown[];
}

function buildCtx(
  current: readonly unknown[] = [],
  // Feature 098 (T080) — the default workspace layer used to be empty, because the
  // Phases these payloads name resolved out of the built-in layer. That layer is
  // empty now, so the default carries the rows instead; a caller that passes its
  // own layers is testing resolution and supplies what it means to. See the fixture
  // header for why the ids are the real Spec Kit ones.
  phaseLayers: PhaseLayers = { user: [], workspace: SPECKIT_PHASE_DEFS }
): {
  ctx: Parameters<typeof savePipelinesHandler>[0];
  acks: CommandAckMessage[];
  updateConfigCalls: Array<{ key: string; value: unknown }>;
} {
  const acks: CommandAckMessage[] = [];
  const updateConfigCalls: Array<{ key: string; value: unknown }> = [];
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
  const updateConfig = vi.fn(async (key: string, value: unknown) => {
    updateConfigCalls.push({ key, value });
  });
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit: audit as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateConfig: updateConfig as any,
      readPipelineConfig: () => ({ user: [], workspace: current }),
      readPhaseConfig: () => phaseLayers
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-validation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, updateConfigCalls };
}

function makeCmd(
  pipelines: readonly unknown[],
  mutation: PipelineCatalogMutation = { kind: 'create', pipelineId: 'valid-id' },
  current: readonly unknown[] = []
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-validation-1',
    payload: {
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision(current),
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
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'UPPER-CASE', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'UPPER-CASE', 'pipelineId', 'invalid-pattern')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty id', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: '', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    // An empty id has no printable identity, so the validator reports it as '?'.
    expect(hasError(acks[0], '?', 'pipelineId', 'invalid-pattern')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty name', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'name', 'invalid-length')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with name exceeding 80 chars', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'a'.repeat(81), phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'name', 'invalid-length')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty phases array', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds', 'non-empty-required')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with non-array phases', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: 'not-an-array' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds', 'non-empty-required')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with non-string phase entries', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [42, 'speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[0]', 'invalid-pattern')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects an authored row carrying an unknown field', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify'], surprise: true }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'surprise', 'unknown-field')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects two rows sharing one pipelineId in the same scope (FR-036)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'First', phases: ['speckit-specify'] },
      { id: 'valid-id', name: 'Second', phases: ['finalize'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'pipelineId', 'duplicate-in-scope')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
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
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-flow', name: 'Valid Flow', phases: ['speckit-specify', 'finalize'] }
    ], { kind: 'create', pipelineId: 'valid-flow' }));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('pipelines');
  });

  it('rejects the whole layer when any row in a multi-pipeline payload is invalid', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'good-flow', name: 'Good', phases: ['speckit-specify'] },
      { id: 'bad-flow', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'bad-flow', 'name', 'invalid-length')).toBe(true);
    // Transactional save (FR-020) — the valid sibling is not written either.
    expect(updateConfigCalls).toEqual([]);
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
// every binding against the *effective* Phase catalog, so a Phase authored in a
// lower-precedence scope still counts as resolvable (Edge Case 1). Every case
// asserts the exact `field`/`code` pair the Builder renders next to its control
// (FR-017) and that nothing was written (FR-020, SC-003).
const authoredPhase = (phaseId: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id: phaseId,
  name,
  version: 1,
  instruction: `${name}.`,
  ...overrides
});

describe('cmd-save-pipelines cross-reference validation (082, gates 5-6)', () => {
  it('rejects a phaseId with no effective definition (FR-011)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify', 'ghost-phase'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[1]', 'unknown-phase')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('resolves a Phase supplied only by a configured layer (Edge Case 1)', async () => {
    // Feature 098 (T080) — `speckit-specify` moves to the user layer rather than
    // joining `workspace-only`: the case is that a Phase resolves from whichever
    // configured layer supplies it, and keeping the two rows in different scopes
    // is what still makes that visible now that neither comes from the host.
    const { ctx, acks, updateConfigCalls } = buildCtx([], {
      user: SPECKIT_PHASE_DEFS,
      workspace: [authoredPhase('workspace-only', 'Workspace Only')]
    });
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['speckit-specify', 'workspace-only'] }
    ], { kind: 'create', pipelineId: 'valid-id' }));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
  });

  it('resolves a multi-scope Phase to its highest-precedence valid source (Edge Case 1)', async () => {
    // The workspace row shadows the user row but is itself invalid, so the
    // Phase still resolves — from `user`. Gate 5 must read the resolved
    // catalog, not the raw layers.
    const { ctx, acks, updateConfigCalls } = buildCtx([], {
      user: [authoredPhase('shared-phase', 'User Copy')],
      workspace: [authoredPhase('shared-phase', 'Workspace Copy', { instruction: '   ' })]
    });
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['shared-phase'] }
    ], { kind: 'create', pipelineId: 'valid-id' }));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
  });

  it('rejects a binding that writes to an undeclared output port (FR-016)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects a Phase output consumed through a non-bridge input port type (FR-016)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects a Phase that consumes an output produced later in the sequence (FR-015)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects a binding whose Phase position is outside the sequence (FR-015)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects two ports declaring the same portId (FR-016)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects an unknown executionDefaults key (FR-018)', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toEqual([]);
  });

  it('runs gate 5 before the trust gate and writes nothing (FR-020, SC-003)', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: ['ghost-phase'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation');
    expect(hasError(acks[0], 'valid-id', 'phaseIds[0]', 'unknown-phase')).toBe(true);
    expect(updateConfigCalls).toEqual([]);
  });

  it('accepts a Pipeline whose Phases and bindings all resolve', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
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
    expect(updateConfigCalls).toHaveLength(1);
  });
});
