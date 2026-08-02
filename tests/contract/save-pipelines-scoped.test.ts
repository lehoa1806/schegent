// Feature 082 (US1, T018) — IPC contract tests for the scoped, revisioned
// CMD_SAVE_PIPELINES envelope.
//
// Covers the ordered gate table in
// `specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md`:
//   gate 1  config-ops-unavailable   host dependencies missing
//   gate 2  invalid-payload          envelope shape (incl. the legacy `{ pipelines }` payload)
//   gate 3  stale-catalog            `{ currentRevision, current }` (FR-030)
//   gate 4  pipeline-validation      bounded, sanitized `PipelineFieldError[]`
//   gate 9  pipeline-mutation-mismatch
//   gate 10 pipeline-version-invalid `{ pipelineId }` (FR-010)
//   gate 12 trust-denied             `pipelineOverrides` capability, audited
//   gate 14 persistence-failed
// plus the accepted ack `{ scope, revision, mutation }` and scope targeting
// (FR-004, FR-020, FR-021).
//
// Gates 5–8, 11, and 13 are covered by their own task-scoped suites
// (T037 bindings, T051 removal, the 059 trust suite).
//
// Gate 2 is asserted against `validateInboundMessage` — the transport boundary
// — because the router never sees a payload that fails there. Every other gate
// is asserted through a real `MessageRouter.dispatch`, so the ordering between
// them is exercised, not just each gate in isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>()
  }
}));

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: (capability: string) => mocks.state.scopes.get(capability) ?? 'workspace-trust'
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/test-workspace', scheme: 'file' },
    name: 'test-workspace',
    index: 0
  })
}));

import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_SAVE_PIPELINES,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { pipelineLayerRevision } from '../../src/config/pipeline-catalog';
import type { PipelineCatalogMutation } from '../../src/contracts/pipeline-definitions';

const CUSTOM_ROW = {
  id: 'custom-flow',
  name: 'Custom Flow',
  version: 1,
  phases: ['speckit-specify', 'finalize', 'done']
};

interface Layers {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

interface Harness {
  router: MessageRouter;
  acks: CommandAckMessage[];
  updateConfigCalls: Array<{ key: string; value: unknown; scope: string | undefined }>;
  auditCalls: Array<Record<string, unknown>>;
  layers: Layers;
}

function buildRouter(
  opts: {
    layers?: Layers;
    omitConfigOps?: boolean;
    updateConfigThrows?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const updateConfigCalls: Harness['updateConfigCalls'] = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const layers: Layers = opts.layers ?? { user: [], workspace: [] };

  const configOps = opts.omitConfigOps
    ? {}
    : {
        updateConfig: async (
          key: 'phases' | 'pipelines' | 'models',
          value: unknown,
          scope?: string
        ) => {
          if (opts.updateConfigThrows) throw new Error('update failed');
          updateConfigCalls.push({ key, value, scope });
        },
        readPipelineConfig: () => ({ user: layers.user, workspace: layers.workspace }),
        // Feature 082 (T038) — gate 5 resolves every `phaseId` against the
        // effective Phase catalog, so the workspace-authored `done` these
        // fixtures use has to exist as a Phase.
        readPhaseConfig: () => ({
          user: [],
          workspace: [{ id: 'done', name: 'Done', version: 1, instruction: 'Done.' }]
        })
      };

  const deps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      // Marker-based sanitizer: any host->UI string that reaches an ack must
      // have passed through this exactly once (FR-031).
      sanitize: (value: string) => value.replaceAll('SECRET', '[redacted]')
    },
    audit: {
      append: async (entry: Record<string, unknown>) => {
        auditCalls.push(entry);
      }
    },
    ...configOps
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, updateConfigCalls, auditCalls, layers };
}

function savePayload(opts: {
  scope?: 'user' | 'workspace';
  expectedRevision?: string;
  mutation?: PipelineCatalogMutation;
  pipelines?: readonly unknown[];
}) {
  return {
    scope: opts.scope ?? 'workspace',
    expectedRevision: opts.expectedRevision ?? pipelineLayerRevision([]),
    mutation: opts.mutation ?? ({ kind: 'create', pipelineId: 'custom-flow' } as const),
    pipelines: opts.pipelines ?? [CUSTOM_ROW]
  };
}

async function dispatch(harness: Harness, payload: unknown, correlationId = 'save-1') {
  await harness.router.dispatch(
    { type: CMD_SAVE_PIPELINES, correlationId, payload } as unknown as SidebarCommand,
    async (msg) => {
      harness.acks.push(msg);
      return true;
    }
  );
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
});

describe('gate 2 — envelope validation at the transport boundary', () => {
  const valid = {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'scoped-save',
    payload: savePayload({ scope: 'user' })
  };

  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['scope', 'expectedRevision', 'mutation', 'pipelines'])(
    'rejects an envelope missing %s',
    (key) => {
      const payload = { ...valid.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...valid, payload })).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('rejects the pre-082 unscoped { pipelines } payload', () => {
    expect(
      validateInboundMessage({ ...valid, payload: { pipelines: [CUSTOM_ROW] } })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('rejects undeclared payload keys', () => {
    expect(
      validateInboundMessage({
        ...valid,
        payload: { ...valid.payload, phases: ['must not be echoed at envelope level'] }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('rejects a non-writable target scope', () => {
    expect(
      validateInboundMessage({
        ...valid,
        payload: { ...valid.payload, scope: 'built-in' }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each([
    { kind: 'create' },
    { kind: 'edit' },
    { kind: 'remove' },
    { kind: 'duplicate', pipelineId: 'copy' },
    { kind: 'promote', pipelineId: 'custom-flow' }
  ])('rejects a malformed mutation %o', (mutation) => {
    expect(
      validateInboundMessage({ ...valid, payload: { ...valid.payload, mutation } })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });
});

describe('gate 1 — host configuration operations unavailable', () => {
  it('rejects with config-ops-unavailable and never persists', async () => {
    const harness = buildRouter({ omitConfigOps: true });
    await dispatch(harness, savePayload({}));
    expect(harness.acks).toHaveLength(1);
    expect(harness.acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'config-ops-unavailable'
    });
    expect(harness.updateConfigCalls).toEqual([]);
  });
});

describe('gate 3 — stale catalog', () => {
  it('rejects a save whose expectedRevision no longer matches the layer', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([]),
        mutation: { kind: 'edit', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: pipelineLayerRevision([CUSTOM_ROW]),
      current: {
        scope: 'workspace',
        pipelineId: 'custom-flow',
        name: 'Custom Flow',
        version: 1,
        legalActions: expect.arrayContaining(['refresh'])
      }
    });
    expect(harness.updateConfigCalls).toEqual([]);
  });

  it('reports a reset against a stale layer without naming a pipeline', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([]),
        mutation: { kind: 'reset' },
        pipelines: []
      })
    );
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: pipelineLayerRevision([CUSTOM_ROW]),
      current: { scope: 'workspace', legalActions: expect.arrayContaining(['refresh']) }
    });
  });
});

describe('gate 4 — complete-layer validation', () => {
  it('rejects an invalid row with a per-field error and never persists (FR-020, FR-021)', async () => {
    const harness = buildRouter({});
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, phases: [] }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('pipeline-validation');
    expect(harness.acks[0].result).toMatchObject({
      errors: [expect.objectContaining({ pipelineId: 'custom-flow', field: 'phaseIds' })],
      total: expect.any(Number)
    });
    expect(harness.updateConfigCalls).toEqual([]);
  });

  it('rejects a non-positive version at the field layer', async () => {
    const harness = buildRouter({});
    await dispatch(
      harness,
      savePayload({ pipelines: [{ ...CUSTOM_ROW, version: 0 }] })
    );
    expect(harness.acks[0].reason).toBe('pipeline-validation');
    expect(harness.acks[0].result).toMatchObject({
      errors: [
        expect.objectContaining({
          pipelineId: 'custom-flow',
          field: 'version',
          code: 'positive-integer-required'
        })
      ]
    });
  });

  it('rejects a duplicate pipelineId within one scope', async () => {
    const harness = buildRouter({});
    await dispatch(
      harness,
      savePayload({ pipelines: [CUSTOM_ROW, { ...CUSTOM_ROW, name: 'Twin' }] })
    );
    expect(harness.acks[0].reason).toBe('pipeline-validation');
    expect(harness.acks[0].result).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ pipelineId: 'custom-flow', code: 'duplicate-in-scope' })
      ])
    });
  });

  it('bounds the reported errors to 20 while reporting the true total (FR-032)', async () => {
    const harness = buildRouter({});
    const rows = Array.from({ length: 25 }, (_unused, index) => ({
      id: `bad flow ${index}`, // space violates the id pattern
      name: '',
      version: 1,
      phases: []
    }));
    await dispatch(harness, savePayload({ pipelines: rows }));
    expect(harness.acks[0].reason).toBe('pipeline-validation');
    const result = harness.acks[0].result as {
      errors: Array<{ pipelineId: string; field: string; code: string; message: string }>;
      total: number;
    };
    expect(result.errors.length).toBeLessThanOrEqual(20);
    expect(result.total).toBeGreaterThan(result.errors.length);
    for (const error of result.errors) {
      expect(error.pipelineId.length).toBeLessThanOrEqual(64);
      expect(error.field.length).toBeLessThanOrEqual(32);
      expect(error.code.length).toBeLessThanOrEqual(64);
      expect(error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('sanitizes every string it echoes back exactly once (FR-031)', async () => {
    const harness = buildRouter({});
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, 'SECRET-field': 'x' }]
      })
    );
    expect(harness.acks[0].reason).toBe('pipeline-validation');
    const serialized = JSON.stringify(harness.acks[0].result);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).toContain('[redacted]');
  });
});

describe('gate 9 — declared intent must match the observed diff', () => {
  it('rejects a create whose layer also edits an untouched row', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([CUSTOM_ROW]),
        mutation: { kind: 'create', pipelineId: 'second-flow' },
        pipelines: [
          { ...CUSTOM_ROW, name: 'Smuggled Rename' },
          { id: 'second-flow', name: 'Second Flow', version: 1, phases: ['finalize', 'done'] }
        ]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('pipeline-mutation-mismatch');
    expect(harness.updateConfigCalls).toEqual([]);
  });

  it('rejects a reset that does not empty the layer', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([CUSTOM_ROW]),
        mutation: { kind: 'reset' },
        pipelines: [CUSTOM_ROW]
      })
    );
    expect(harness.acks[0].reason).toBe('pipeline-mutation-mismatch');
    expect(harness.updateConfigCalls).toEqual([]);
  });
});

describe('gate 10 — host-owned versions', () => {
  it('rejects a row asserting a version the host never issued (FR-010)', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([CUSTOM_ROW]),
        mutation: { kind: 'edit', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, name: 'Renamed', version: 7 }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('pipeline-version-invalid');
    expect(harness.acks[0].result).toMatchObject({ pipelineId: 'custom-flow' });
    expect(harness.updateConfigCalls).toEqual([]);
  });
});

describe('gate 12 — pipelineOverrides capability', () => {
  it('denies a non-reset save when the capability is off and audits the denial', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'user');
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('rejected');
    // `denyAndAudit` is the shared 059 helper; its pinned reason code is
    // `trust-denied`, and the capability travels on the error payload.
    expect(harness.acks[0].reason).toBe('trust-denied');
    expect(harness.acks[0].result).toMatchObject({
      kind: 'trust-denied',
      capability: 'pipelineOverrides',
      resolvedScope: 'user'
    });
    expect(harness.updateConfigCalls).toEqual([]);
    expect(harness.auditCalls).toHaveLength(1);
    expect(harness.auditCalls[0]).toMatchObject({ eventType: 'trust.capability-denied' });
  });

  it('lets a reset through even when the capability is off', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const harness = buildRouter({ layers: { user: [], workspace: [CUSTOM_ROW] } });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: pipelineLayerRevision([CUSTOM_ROW]),
        mutation: { kind: 'reset' },
        pipelines: []
      })
    );
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.auditCalls).toEqual([]);
    expect(harness.updateConfigCalls).toEqual([
      { key: 'pipelines', value: [], scope: 'workspace' }
    ]);
  });
});

describe('gate 14 — persistence failure', () => {
  it('rejects with persistence-failed and leaves the prior scope unchanged (FR-021)', async () => {
    const harness = buildRouter({ updateConfigThrows: true });
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('persistence-failed');
    expect(harness.updateConfigCalls).toEqual([]);
    expect(harness.layers).toEqual({ user: [], workspace: [] });
  });
});

describe('accepted ack and scope targeting', () => {
  it('acknowledges with { scope, revision, mutation } and the host-assigned version', async () => {
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.updateConfigCalls).toHaveLength(1);
    const persisted = harness.updateConfigCalls[0].value as readonly unknown[];
    expect(persisted).toEqual([
      expect.objectContaining({
        id: 'custom-flow',
        name: 'Custom Flow',
        version: 1,
        phases: ['speckit-specify', 'finalize', 'done']
      })
    ]);
    expect(harness.acks[0].result).toEqual({
      scope: 'workspace',
      revision: pipelineLayerRevision(persisted),
      mutation: 'create'
    });
  });

  // `extension.ts` maps the third `updateConfig` argument onto a
  // `vscode.ConfigurationTarget`: 'user' -> Global, 'workspace' -> Workspace.
  // Asserting the argument here pins the handler half of that contract.
  it.each([
    ['user' as const, 'workspace' as const],
    ['workspace' as const, 'user' as const]
  ])(
    'writes only the %s layer and leaves the %s layer byte-for-byte unchanged (FR-004)',
    async (target, untouched) => {
      const other = [{ id: 'other-flow', name: 'Other', version: 1, phases: ['finalize', 'done'] }];
      const layers: Layers = target === 'user' ? { user: [], workspace: other } : { user: other, workspace: [] };
      const snapshot = JSON.stringify(layers[untouched]);
      const harness = buildRouter({ layers });
      await dispatch(harness, savePayload({ scope: target }));
      expect(harness.acks[0].status).toBe('accepted');
      expect(harness.updateConfigCalls).toHaveLength(1);
      expect(harness.updateConfigCalls[0].key).toBe('pipelines');
      expect(harness.updateConfigCalls[0].scope).toBe(target);
      expect(harness.acks[0].result).toMatchObject({ scope: target });
      expect(JSON.stringify(harness.layers[untouched])).toBe(snapshot);
    }
  );
});

// Feature 082 (US4, T046) — the `duplicate` mutation.
//
// A duplicate is the only mutation that names two ids: the row it copies and the
// row it creates. The source pair exists so the host can tell "copy the built-in
// I cannot edit" apart from "create something new", and because a rename is
// deliberately not an edit (FR-007) — the operator has to express it here.
//
// The declared intent still has to match the observed diff: carrying a source
// pair must not become a way to smuggle an edit to another row through a
// create-shaped gate.
describe('duplicate mutation (US4, FR-006, FR-007)', () => {
  const SOURCE_ROW = {
    id: 'source-flow',
    name: 'Source Flow',
    version: 7,
    description: 'Original',
    phases: ['speckit-specify', 'done'],
    recommendedNext: ['ship-it']
  };
  const duplicateOf = (overrides: Record<string, unknown> = {}) => ({
    ...SOURCE_ROW,
    id: 'source-flow-copy',
    name: 'Source Flow (Copy)',
    version: 1,
    ...overrides
  });

  function duplicatePayload(opts: {
    layer?: readonly unknown[];
    pipelines?: readonly unknown[];
    mutation?: PipelineCatalogMutation;
  } = {}) {
    const layer = opts.layer ?? [SOURCE_ROW];
    return savePayload({
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision(layer),
      mutation: opts.mutation ?? {
        kind: 'duplicate',
        sourceScope: 'workspace',
        sourcePipelineId: 'source-flow',
        pipelineId: 'source-flow-copy'
      },
      pipelines: opts.pipelines ?? [...layer, duplicateOf()]
    });
  }

  it('accepts a source-paired duplicate and persists both rows', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [SOURCE_ROW] } });

    await dispatch(harness, duplicatePayload());

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.acks[0].result).toMatchObject({ scope: 'workspace', mutation: 'duplicate' });
    const persisted = harness.updateConfigCalls[0].value as readonly Record<string, unknown>[];
    expect(persisted.map((row) => row.id)).toEqual(['source-flow', 'source-flow-copy']);
  });

  // FR-006 — the copy is a new Pipeline, so its history starts over. Inheriting
  // the source's version would make a first edit look like the eighth.
  it('assigns the duplicate an independent version starting at 1', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [SOURCE_ROW] } });

    await dispatch(harness, duplicatePayload());

    const persisted = harness.updateConfigCalls[0].value as readonly Record<string, unknown>[];
    expect(persisted[1]).toMatchObject({ id: 'source-flow-copy', version: 1 });
    expect(persisted[0]).toMatchObject({ id: 'source-flow', version: 7 });
  });

  it('copies every other authored property from the source', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [SOURCE_ROW] } });

    await dispatch(harness, duplicatePayload());

    const persisted = harness.updateConfigCalls[0].value as readonly Record<string, unknown>[];
    expect(persisted[1]).toMatchObject({
      description: 'Original',
      phases: ['speckit-specify', 'done'],
      recommendedNext: ['ship-it']
    });
  });

  // A duplicate of a built-in names a source the writable layer does not hold.
  // The pair still has to survive gate 8, which only forbids *editing* one.
  it('accepts a duplicate whose source is a built-in in another scope', async () => {
    const harness = buildRouter({ layers: { user: [], workspace: [] } });
    const copy = {
      id: 'new-feature-copy', name: 'Copy of built-in', version: 1,
      phases: ['speckit-specify', 'done']
    };

    await dispatch(harness, savePayload({
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision([]),
      mutation: {
        kind: 'duplicate',
        sourceScope: 'built-in',
        sourcePipelineId: 'speckit-new-feature',
        pipelineId: 'new-feature-copy'
      },
      pipelines: [copy]
    }));

    expect(harness.acks[0].status).toBe('accepted');
    const persisted = harness.updateConfigCalls[0].value as readonly Record<string, unknown>[];
    expect(persisted).toEqual([expect.objectContaining({ id: 'new-feature-copy', version: 1 })]);
  });

  it('rejects a duplicate that also edits another row in the same layer', async () => {
    const other = { id: 'other-flow', name: 'Other', version: 2, phases: ['done'] };
    const harness = buildRouter({ layers: { user: [], workspace: [SOURCE_ROW, other] } });

    await dispatch(harness, duplicatePayload({
      layer: [SOURCE_ROW, other],
      pipelines: [SOURCE_ROW, { ...other, name: 'Renamed' }, duplicateOf()]
    }));

    expect(harness.acks[0]).toMatchObject({
      status: 'rejected', reason: 'pipeline-mutation-mismatch'
    });
    expect(harness.updateConfigCalls).toHaveLength(0);
  });

  it('rejects a duplicate whose target id already exists in the target scope', async () => {
    const taken = { id: 'source-flow-copy', name: 'Taken', version: 1, phases: ['done'] };
    const harness = buildRouter({ layers: { user: [], workspace: [SOURCE_ROW, taken] } });

    await dispatch(harness, duplicatePayload({
      layer: [SOURCE_ROW, taken],
      pipelines: [SOURCE_ROW, taken, duplicateOf()]
    }));

    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.updateConfigCalls).toHaveLength(0);
  });

  it.each(['sourceScope', 'sourcePipelineId'])(
    'rejects a duplicate envelope missing %s at the transport boundary',
    (key) => {
      const mutation = {
        kind: 'duplicate', sourceScope: 'workspace',
        sourcePipelineId: 'source-flow', pipelineId: 'source-flow-copy'
      } as Record<string, unknown>;
      delete mutation[key];
      expect(validateInboundMessage({
        type: CMD_SAVE_PIPELINES,
        correlationId: 'dup-1',
        payload: { ...duplicatePayload(), mutation }
      })).toMatchObject({ ok: false, reason: 'invalid-payload' });
    }
  );
});
