// Feature 082 (US1, T018) — IPC contract tests for the revisioned
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
//   gate 14 persistence-failed
// plus the accepted ack `{ revision, mutation }` (FR-020, FR-021).
//
// Gates 5–8 and 13 are covered by their own task-scoped suites
// (T037 bindings, T051 removal, the 059 trust suite).
//
// Gate 2 is asserted against `validateInboundMessage` — the transport boundary
// — because the router never sees a payload that fails there. Every other gate
// is asserted through a real `MessageRouter.dispatch`, so the ordering between
// them is exercised, not just each gate in isolation.
//
// Feature 099 (T496f) — three things changed under this file, and each one has a
// successor here rather than a deletion:
//
//   - `scope` left the envelope with the layer tier (FR-042). Its required-key
//     case is inverted: an envelope still carrying it is refused. Its
//     scope-targeting case ('writes only the %s layer') becomes the claim that
//     survives one catalog — a Pipeline save touches no catalog it was not
//     addressed to.
//   - Gate 12 is gone: `pipelineOverrides` asked whether one layer could redefine
//     what another declares (FR-046). What replaces the deny case is the negative
//     a reintroduced gate would break — the answer does not depend on the trust
//     resolver at all, and nothing is audited.
//   - The write port is the catalog store, not `updateConfig(key, value, scope)`.
//     Every "never persists" assertion reads `store.layerSaves`, which the
//     handler reaches only past every gate ahead of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    asked: [] as string[]
  }
}));

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => {
    mocks.state.asked.push(capability);
    return mocks.state.capabilities.get(capability) ?? true;
  },
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
import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { SPECKIT_PHASE_DEFS } from '../fixtures/speckit-catalog-fixture';
import { FakeCatalogStore, layerWrites } from '../fixtures/fake-catalog-store';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { collectWorkflowDefinitionPipelineRefs } from '../../src/ui/sidebar/workflow-definition-pipeline-refs';
import type { PipelineCatalogMutation } from '../../src/contracts/pipeline-definitions';

const CUSTOM_ROW = {
  id: 'custom-flow',
  name: 'Custom Flow',
  version: 1,
  phases: ['speckit-specify', 'finalize', 'done']
};

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('pipeline');

interface Harness {
  router: MessageRouter;
  acks: CommandAckMessage[];
  store: FakeCatalogStore;
  auditCalls: Array<Record<string, unknown>>;
}

// Feature 098 (T080) — `CUSTOM_ROW` names `speckit-specify` and `finalize`, which
// used to resolve out of the built-in Phase layer. That layer is empty now, so a
// Pipeline naming them fails gate 5 unless the catalog carries them: every gate
// below would report `pipeline-validation` instead of the gate under test. The
// rows come from the fixture; see its header for why the ids are the real Spec
// Kit ones.
const PHASE_ROWS = [
  { id: 'done', name: 'Done', version: 1, instruction: 'Done.' },
  ...SPECKIT_PHASE_DEFS
];

/**
 * Feature 083 (T052) — the definition-side half of gate 13's reference list,
 * assembled the way `extension.ts` assembles it: resolve the stored Workflow
 * rows against the resolved Pipeline catalog, then collect over **every stored
 * record**. Going through real resolution is the point — a hand-authored
 * reference literal could not tell an invalid record apart from an effective
 * one, which is precisely what FR-041 turns on.
 */
function workflowRefs(workflows: readonly unknown[], pipelineRows: readonly unknown[]) {
  const pipelineCatalog = resolvePipelineCatalog({
    rows: pipelineRows,
    revision: SEEDED_REVISION,
    phaseCatalog: resolvePhaseCatalog({ rows: PHASE_ROWS, revision: SEEDED_REVISION }).effective
  });
  return collectWorkflowDefinitionPipelineRefs(
    resolveWorkflowCatalog({
      rows: workflows,
      revision: SEEDED_REVISION,
      pipelineCatalog
    }).records
  );
}

/** A Workflow definition row whose single node names `custom-flow`. */
const workflowRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: 1,
  nodes: [{ nodeId: 'a', pipelineId: CUSTOM_ROW.id }],
  connections: [],
  startNodeIds: ['a'],
  ...overrides
});

function buildRouter(
  opts: {
    rows?: readonly unknown[];
    omitConfigOps?: boolean;
    /**
     * Feature 099 (T496f, FR-029) — the settings writer used to throw to drive
     * gate 14; the store names the fault instead and answers exactly one write.
     */
    storeRefuses?: boolean;
    /**
     * Feature 083 (T052) — stored Workflow rows. Resolved and collected here
     * exactly as `extension.ts` does, so gate 13 sees the same reference list
     * production does rather than hand-authored literals; that is what makes the
     * invalid case below meaningful.
     */
    workflows?: readonly unknown[];
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const store = new FakeCatalogStore({
    phases: PHASE_ROWS,
    pipelines: opts.rows ?? []
  });
  if (opts.storeRefuses) {
    store.nextLayerVerdict = { outcome: 'refused', reason: 'not-writable', id: null };
  }

  const configOps = opts.omitConfigOps
    ? {}
    : {
        catalogStore: store,
        refreshCatalog: async () => undefined,
        readPipelineConfig: () => ({
          rows: store.rowsOf('pipeline'),
          revision: store.revisionOf('pipeline')
        }),
        // Feature 082 (T038) — gate 5 resolves every `phaseId` against the
        // effective Phase catalog, so the authored `done` these fixtures use has
        // to exist as a Phase.
        readPhaseConfig: () => ({
          rows: store.rowsOf('phase'),
          revision: store.revisionOf('phase')
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
    ...(opts.workflows
      ? {
          readWorkflowPipelineRefs: () =>
            workflowRefs(opts.workflows ?? [], store.rowsOf('pipeline'))
        }
      : {}),
    ...configOps
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, store, auditCalls };
}

function savePayload(opts: {
  expectedRevision?: string;
  mutation?: PipelineCatalogMutation;
  pipelines?: readonly unknown[];
}) {
  return {
    expectedRevision: opts.expectedRevision ?? SEEDED_REVISION,
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
  mocks.state.asked.length = 0;
});

describe('gate 2 — envelope validation at the transport boundary', () => {
  const valid = {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'revisioned-save',
    payload: savePayload({})
  };

  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['expectedRevision', 'mutation', 'pipelines'])(
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

  it('rejects the pre-082 unrevisioned { pipelines } payload', () => {
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

  // The successor of `rejects an envelope missing scope` and `rejects a
  // non-writable target scope` (FR-042). Both said the same thing about a field
  // that no longer has a referent: the caller must name a layer, and only a
  // writable one. With one catalog, a caller that still names a layer is a
  // caller pinned to the deleted tier, and it fails loudly at the boundary
  // rather than having its extra field dropped on the way to a handler that
  // would ignore it.
  it('rejects an envelope that still carries a scope (FR-042)', () => {
    for (const scope of ['user', 'workspace', 'built-in']) {
      expect(
        validateInboundMessage({ ...valid, payload: { ...valid.payload, scope } })
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    }
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

  // Feature 085 (FR-036) shipped an `import-package` arm in the handler and a
  // webview that emits it, but not in this gate — so the envelope was dropped at
  // the transport boundary and the package import never reached the code that
  // implements it. Every other test in the suite dispatches through the router
  // directly, which is exactly why the gap was invisible. These two cases pin the
  // arm from the outside: the set-naming kind is the only mutation carrying no
  // `pipelineId`, and a malformed set is refused here rather than left to an
  // algebra that would report it as a mutation mismatch.
  describe('import-package (085 FR-036)', () => {
    const packageEnvelope = (mutation: unknown) => ({
      ...valid,
      payload: { ...valid.payload, mutation }
    });

    it('accepts a package envelope naming its declared pipeline ids', () => {
      expect(
        validateInboundMessage(
          packageEnvelope({ kind: 'import-package', pipelineIds: ['custom-flow'] })
        )
      ).toMatchObject({ ok: true });
    });

    it.each([
      { kind: 'import-package' },
      { kind: 'import-package', pipelineIds: [] },
      { kind: 'import-package', pipelineIds: 'custom-flow' },
      { kind: 'import-package', pipelineIds: [''] },
      { kind: 'import-package', pipelineIds: ['x'.repeat(65)] },
      { kind: 'import-package', pipelineIds: [123] },
      { kind: 'import-package', pipelineIds: ['custom-flow'], pipelineId: 'custom-flow' }
    ])('rejects a malformed package mutation %o', (mutation) => {
      expect(validateInboundMessage(packageEnvelope(mutation))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });
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
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 3 — stale catalog', () => {
  it('rejects a save whose expectedRevision no longer matches the catalog', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: 'rev-pipeline-stale',
        mutation: { kind: 'edit', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: SEEDED_REVISION,
      current: {
        pipelineId: 'custom-flow',
        name: 'Custom Flow',
        version: 1,
        legalActions: expect.arrayContaining(['refresh'])
      }
    });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('reports a reset against a stale catalog without naming a pipeline', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: 'rev-pipeline-stale',
        mutation: { kind: 'reset' },
        pipelines: []
      })
    );
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: SEEDED_REVISION,
      current: { legalActions: expect.arrayContaining(['refresh']) }
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
    expect(harness.store.layerSaves).toEqual([]);
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

  it('rejects a duplicate pipelineId within the catalog', async () => {
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
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', pipelineId: 'second-flow' },
        pipelines: [
          { ...CUSTOM_ROW, name: 'Smuggled Rename' },
          { id: 'second-flow', name: 'Second Flow', version: 1, phases: ['finalize', 'done'] }
        ]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('pipeline-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('rejects a reset that does not empty the catalog', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({ mutation: { kind: 'reset' }, pipelines: [CUSTOM_ROW] })
    );
    expect(harness.acks[0].reason).toBe('pipeline-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 10 — host-owned versions', () => {
  it('rejects a row asserting a version the host never issued (FR-010)', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'edit', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, name: 'Renamed', version: 7 }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('pipeline-version-invalid');
    expect(harness.acks[0].result).toMatchObject({ pipelineId: 'custom-flow' });
    expect(harness.store.layerSaves).toEqual([]);
  });
});

// Feature 099 (T496f, FR-046) — the successor of `gate 12 — pipelineOverrides
// capability`. That gate asked whether one layer could redefine what another
// declares; one catalog poses no such question, and the capability is deleted.
// The deny case ('denies a non-reset save when the capability is off and audits
// the denial') has no reachable form, so what stands in its place is the
// negative a reintroduced gate would break — plus the reset case, which keeps
// its claim exactly and loses only the setting that used to make it interesting.
describe('no override capability is left to consult (FR-046)', () => {
  it('accepts a non-reset save with every capability denied, and audits nothing', async () => {
    for (const capability of ['pipelineOverrides', 'workflowOverrides', 'phases', 'retryConditions']) {
      mocks.state.capabilities.set(capability, false);
    }
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.auditCalls).toEqual([]);
    expect(harness.store.layerSaves).toHaveLength(1);
  });

  it('never asks the trust resolver about an override capability', async () => {
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('accepted');
    expect(mocks.state.asked).not.toContain('pipelineOverrides');
    expect(mocks.state.asked).not.toContain('workflowOverrides');
  });

  it('lets a reset through, writing the empty catalog', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW] });
    await dispatch(
      harness,
      savePayload({ mutation: { kind: 'reset' }, pipelines: [] })
    );
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.auditCalls).toEqual([]);
    expect(layerWrites(harness.store)).toEqual([[]]);
    expect(harness.store.rowsOf('pipeline')).toEqual([]);
  });
});

describe('gate 14 — persistence failure', () => {
  it('rejects with persistence-failed and leaves the catalog unchanged (FR-021)', async () => {
    const harness = buildRouter({ rows: [CUSTOM_ROW], storeRefuses: true });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'edit', pipelineId: 'custom-flow' },
        pipelines: [{ ...CUSTOM_ROW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('persistence-failed');
    // The store names the fault rather than throwing (FR-029), and the refusal
    // travels to the operator so a read-only catalog is distinguishable from a
    // gate rejection.
    expect(harness.acks[0].result).toMatchObject({ storeRefusal: 'not-writable' });
    expect(harness.store.rowsOf('pipeline')).toEqual([CUSTOM_ROW]);
    expect(harness.store.revisionOf('pipeline')).toBe(SEEDED_REVISION);
  });
});

describe('accepted ack and catalog targeting', () => {
  it('acknowledges with { revision, mutation } and the host-assigned version', async () => {
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('accepted');
    const persisted = layerWrites(harness.store);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual([
      expect.objectContaining({
        id: 'custom-flow',
        name: 'Custom Flow',
        version: 1,
        phases: ['speckit-specify', 'finalize', 'done']
      })
    ]);
    expect(harness.acks[0].result).toEqual({
      revision: harness.store.revisionOf('pipeline'),
      mutation: 'create'
    });
  });

  // Feature 099 (T496f, FR-004) — the successor of 'writes only the %s layer and
  // leaves the %s layer byte-for-byte unchanged'. That case pinned the third
  // `updateConfig` argument, which `extension.ts` mapped onto a
  // `vscode.ConfigurationTarget`. There is one Pipeline catalog and no target to
  // choose, so what remains of the isolation claim is the part that still has
  // two sides: a Pipeline save is addressed to the Pipeline catalog, and the
  // Phase and Workflow catalogs come out of it untouched — rows AND revision,
  // which is strictly stronger than the byte comparison it replaces.
  it('touches no catalog it was not addressed to (FR-004)', async () => {
    const harness = buildRouter({});
    const phasesBefore = JSON.stringify(harness.store.rowsOf('phase'));
    const phaseRevision = harness.store.revisionOf('phase');
    const workflowRevision = harness.store.revisionOf('workflow');

    await dispatch(harness, savePayload({}));

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves.map((request) => request.kind)).toEqual(['pipeline']);
    expect(JSON.stringify(harness.store.rowsOf('phase'))).toBe(phasesBefore);
    expect(harness.store.revisionOf('phase')).toBe(phaseRevision);
    expect(harness.store.rowsOf('workflow')).toEqual([]);
    expect(harness.store.revisionOf('workflow')).toBe(workflowRevision);
  });
});

// Feature 082 (US4, T046) — the `duplicate` mutation.
//
// A duplicate is the only mutation that names two ids: the row it copies and the
// row it creates. The source id exists so the host can tell "copy the thing I am
// looking at" apart from "create something new", and because a rename is
// deliberately not an edit (FR-007) — the operator has to express it here.
//
// The declared intent still has to match the observed diff: carrying a source
// id must not become a way to smuggle an edit to another row through a
// create-shaped gate.
//
// Feature 099 (T496f, FR-043) — the mutation carried a `sourceScope` alongside
// the source id, because the same identifier could exist in several layers and
// the copy had to say which one it came from. One catalog: the id names it.
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
      mutation: opts.mutation ?? {
        kind: 'duplicate',
        sourcePipelineId: 'source-flow',
        pipelineId: 'source-flow-copy'
      },
      pipelines: opts.pipelines ?? [...layer, duplicateOf()]
    });
  }

  it('accepts a source-paired duplicate and persists both rows', async () => {
    const harness = buildRouter({ rows: [SOURCE_ROW] });

    await dispatch(harness, duplicatePayload());

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.acks[0].result).toMatchObject({ mutation: 'duplicate' });
    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted.map((row) => row.id)).toEqual(['source-flow', 'source-flow-copy']);
  });

  // FR-006 — the copy is a new Pipeline, so its history starts over. Inheriting
  // the source's version would make a first edit look like the eighth.
  it('assigns the duplicate an independent version starting at 1', async () => {
    const harness = buildRouter({ rows: [SOURCE_ROW] });

    await dispatch(harness, duplicatePayload());

    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted[1]).toMatchObject({ id: 'source-flow-copy', version: 1 });
    expect(persisted[0]).toMatchObject({ id: 'source-flow', version: 7 });
  });

  it('copies every other authored property from the source', async () => {
    const harness = buildRouter({ rows: [SOURCE_ROW] });

    await dispatch(harness, duplicatePayload());

    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted[1]).toMatchObject({
      description: 'Original',
      phases: ['speckit-specify', 'done'],
      recommendedNext: ['ship-it']
    });
  });

  // The successor of 'accepts a duplicate whose source is a built-in in another
  // scope'. There is no other scope and no built-in layer, but the property that
  // case stood for is unchanged and now the only way to state it: the source id
  // need not name a row the catalog holds. The copy is the payload's business;
  // the source pair is what the operator declared, not a lookup the gate makes.
  it('accepts a duplicate whose source id the catalog does not hold', async () => {
    const harness = buildRouter({ rows: [] });
    const copy = {
      id: 'new-feature-copy', name: 'Copy of a departed source', version: 1,
      phases: ['speckit-specify', 'done']
    };

    await dispatch(harness, savePayload({
      mutation: {
        kind: 'duplicate',
        sourcePipelineId: 'speckit-new-feature',
        pipelineId: 'new-feature-copy'
      },
      pipelines: [copy]
    }));

    expect(harness.acks[0].status).toBe('accepted');
    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted).toEqual([expect.objectContaining({ id: 'new-feature-copy', version: 1 })]);
  });

  it('rejects a duplicate that also edits another row in the same catalog', async () => {
    const other = { id: 'other-flow', name: 'Other', version: 2, phases: ['done'] };
    const harness = buildRouter({ rows: [SOURCE_ROW, other] });

    await dispatch(harness, duplicatePayload({
      layer: [SOURCE_ROW, other],
      pipelines: [SOURCE_ROW, { ...other, name: 'Renamed' }, duplicateOf()]
    }));

    expect(harness.acks[0]).toMatchObject({
      status: 'rejected', reason: 'pipeline-mutation-mismatch'
    });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('rejects a duplicate whose target id already exists', async () => {
    const taken = { id: 'source-flow-copy', name: 'Taken', version: 1, phases: ['done'] };
    const harness = buildRouter({ rows: [SOURCE_ROW, taken] });

    await dispatch(harness, duplicatePayload({
      layer: [SOURCE_ROW, taken],
      pipelines: [SOURCE_ROW, taken, duplicateOf()]
    }));

    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('rejects a duplicate envelope missing sourcePipelineId at the transport boundary', () => {
    const mutation = {
      kind: 'duplicate', pipelineId: 'source-flow-copy'
    } as Record<string, unknown>;
    expect(validateInboundMessage({
      type: CMD_SAVE_PIPELINES,
      correlationId: 'dup-1',
      payload: { ...duplicatePayload(), mutation }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  // The successor of `rejects a duplicate envelope missing sourceScope`: the
  // field is gone, so the boundary claim inverts the same way the envelope's
  // `scope` did.
  it('rejects a duplicate envelope that still carries sourceScope (FR-043)', () => {
    const mutation = {
      kind: 'duplicate', sourceScope: 'workspace',
      sourcePipelineId: 'source-flow', pipelineId: 'source-flow-copy'
    };
    expect(validateInboundMessage({
      type: CMD_SAVE_PIPELINES,
      correlationId: 'dup-2',
      payload: { ...duplicatePayload(), mutation }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });
});

// Feature 083 (US6, T052) — gate 13's second consumer sense.
//
// 082 shipped gate 13 knowing one kind of consuming Workflow: a queued run
// request that pins a Pipeline. FR-041 adds a second: a stored Workflow
// *definition* whose node names one. The gate's decision logic is unchanged —
// it still blocks when the removal leaves the id with no effective source AND
// something still references it. Only the reference list grew.
//
// The case that matters is the one the *effective* Workflow catalog would drop:
// an invalid record's reference goes live the moment its defects are fixed.
// Removing the Pipeline under it would strand a definition an operator restores
// with one edit, so it must block (FR-041, FR-031, SC-011).
//
// Feature 099 (T496f, FR-040) — the shadowed case is gone with the precedence
// that produced it. Its successor is the duplicate-id case below: a second row
// claiming an id is invalidated rather than shadowed, and the reference it holds
// blocks for exactly the reason a shadowed one did. The reported ids lose their
// scope prefix (FR-043) — an identifier names the record now.
describe('gate 13 — stored Workflow definitions block a Pipeline removal (083 FR-041)', () => {
  const removal = () =>
    savePayload({
      mutation: { kind: 'remove', pipelineId: CUSTOM_ROW.id },
      pipelines: []
    });

  it('blocks a removal referenced only by an effective stored definition', async () => {
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [workflowRow('release')]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: {
        pipelineIds: [CUSTOM_ROW.id],
        dependentWorkflowIds: [],
        dependentWorkflowDefinitionIds: ['release'],
        total: 1
      }
    });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('blocks a removal referenced only by an invalidated duplicate record (FR-041)', async () => {
    // `release` is declared twice. Duplicate ids invalidate, so the second record
    // is retained at `invalid` and is the ONLY one naming `custom-flow` — nothing
    // but its reference can block here.
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [
        workflowRow('release', { nodes: [{ nodeId: 'a', pipelineId: 'speckit-new-feature' }] }),
        workflowRow('release')
      ]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { dependentWorkflowDefinitionIds: ['release'], total: 1 }
    });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('blocks a removal referenced only by an invalid record (FR-041, FR-031)', async () => {
    // Invalid for a reason that has nothing to do with the node: no name. The
    // node's `pipelineId` is still well formed, so the reference survives the
    // best-effort parse and still blocks.
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [workflowRow('release', { name: '' })]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { dependentWorkflowDefinitionIds: ['release'], total: 1 }
    });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('names every referencing Workflow', async () => {
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [workflowRow('release'), workflowRow('audit')]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0].result).toMatchObject({
      dependentWorkflowDefinitionIds: ['audit', 'release'],
      total: 2
    });
  });

  it('reports a Workflow once even when two of its nodes name the same Pipeline', async () => {
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [
        workflowRow('release', {
          nodes: [
            { nodeId: 'a', pipelineId: CUSTOM_ROW.id },
            { nodeId: 'b', pipelineId: CUSTOM_ROW.id }
          ],
          connections: [{ fromNodeId: 'a', toNodeId: 'b' }]
        })
      ]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0].result).toMatchObject({
      dependentWorkflowDefinitionIds: ['release'],
      total: 1
    });
  });

  it('permits the removal when no stored definition names the Pipeline', async () => {
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [
        workflowRow('release', { nodes: [{ nodeId: 'a', pipelineId: 'speckit-new-feature' }] })
      ]
    });

    await dispatch(harness, removal());

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves).toHaveLength(1);
  });

  // FR-022's "either condition alone permits the removal" is unchanged by
  // FR-041: a definition reference blocks only when the id is left with no
  // effective source, exactly as a run-request reference does.
  //
  // Feature 099 (T496f) — the rescuing source used to be the same id in the
  // lower-precedence layer. It is a second row claiming the id in the one
  // catalog now, and the gate's question is unchanged: after this save, does the
  // id still resolve?
  it('permits the removal when a second row claiming the id stays effective', async () => {
    const twin = { ...CUSTOM_ROW, name: 'Fallback' };
    const harness = buildRouter({
      rows: [CUSTOM_ROW, twin],
      workflows: [workflowRow('release')]
    });

    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'remove', pipelineId: CUSTOM_ROW.id },
        pipelines: [CUSTOM_ROW]
      })
    );

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves).toHaveLength(1);
  });

  it('keeps the two consumer senses in separate lists', async () => {
    const harness = buildRouter({
      rows: [CUSTOM_ROW],
      workflows: [workflowRow('release')]
    });
    // A queued run request alongside the stored definition, injected at the
    // same seam `extension.ts` concatenates into.
    const deps = (harness.router as unknown as { deps: Record<string, unknown> }).deps;
    const definitionRefs = deps.readWorkflowPipelineRefs as () => readonly unknown[];
    deps.readWorkflowPipelineRefs = () => [
      { workflowId: 'queued-1', pipelineId: CUSTOM_ROW.id, kind: 'run-request' },
      ...definitionRefs()
    ];

    await dispatch(harness, removal());

    expect(harness.acks[0].result).toMatchObject({
      dependentWorkflowIds: ['queued-1'],
      dependentWorkflowDefinitionIds: ['release'],
      total: 2
    });
  });
});
