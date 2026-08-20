// Feature 083 (US1, T023) — IPC contract tests for the revisioned
// CMD_SAVE_WORKFLOWS envelope.
//
// Covers the ordered gate table in
// `specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md`:
//   gate 1  config-ops-unavailable      host dependencies missing
//   gate 2  invalid-payload             envelope shape
//   gate 3  stale-catalog               `{ currentRevision, current }` (FR-028)
//   gate 9  workflow-identity-immutable `{ workflowId }` (FR-005)
//   gate 11 workflow-mutation-mismatch  exactly one declared intent (FR-029)
//   gate 12 workflow-version-invalid    `{ workflowId }` (FR-001)
//   gate 15 persistence-failed
// plus the accepted ack `{ revision, mutation }` and catalog targeting.
//
// Feature 099 (T496f) — four things changed under this file, and each one has a
// successor here rather than a deletion:
//
//   - `scope` left the envelope with the layer tier (FR-042). Its required-key
//     case and its non-writable-target case collapse into one inverted case: an
//     envelope that still names a layer is refused at the boundary. The two-way
//     scope-targeting `it.each` becomes the claim that survives one catalog — a
//     Workflow save touches no catalog it was not addressed to.
//   - Gate 10 is gone (FR-039). It refused a mutation aimed at a row the built-in
//     layer owned; that layer held nothing for its whole life and no longer
//     exists. The safety property survives on its own terms — a mutation naming a
//     row the catalog does not hold is still refused, and still writes nothing —
//     under the generic mismatch reason.
//   - Gates 13 and 14 are gone: `workflowOverrides` asked whether one layer could
//     redefine what another declares (FR-046). What replaces the deny case is the
//     negative a reintroduced gate would break — the answer does not depend on
//     the trust resolver at all, and nothing is audited. The FR-027/FR-028
//     ordering rule those gates anchored keeps its point in the same place,
//     restated as the stronger fact that replaced it: no capability answer can
//     preempt a staleness report, because none is consulted.
//   - The write port is the catalog store, not `updateConfig(key, value, scope)`.
//     Every "never persists" assertion reads `store.layerSaves`, which the
//     handler reaches only past every gate ahead of it.
//
// Gates 4-8 are the accumulating validation pass and belong to T038 (US2).
//
// Gate 2 is asserted against `validateInboundMessage` — the transport boundary —
// because the router never sees a payload that fails there. Every other gate is
// asserted through a real `MessageRouter.dispatch`, so the ordering between them
// is exercised, not just each gate in isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    /** Every capability the save path asked about, in order (FR-046). */
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
  CMD_SAVE_WORKFLOWS,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { FakeCatalogStore, layerWrites } from '../fixtures/fake-catalog-store';
import { SPECKIT_PHASE_DEFS } from '../fixtures/speckit-catalog-fixture';
import {
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowCatalogMutation
} from '../../src/contracts/workflow-definitions';

// Two operator-authored Pipelines with a compatible port pair. Built-in
// Pipelines declare no ports, so a connection between them could never resolve;
// the graph under test needs a real `markdown -> text` edge.
const DESIGN_PIPELINE = {
  id: 'design-review',
  name: 'Design Review',
  version: 1,
  phases: ['speckit-specify', 'done'],
  outputs: [{ portId: 'notes', label: 'Notes', type: 'markdown' }]
};
const BUILD_PIPELINE = {
  id: 'build-it',
  name: 'Build It',
  version: 1,
  phases: ['finalize', 'done'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }]
};

const TWO_NODE_WORKFLOW = {
  id: 'design-then-build',
  name: 'Design then Build',
  version: 1,
  nodes: [
    { nodeId: 'design', pipelineId: 'design-review' },
    { nodeId: 'build', pipelineId: 'build-it' }
  ],
  connections: [
    {
      from: { nodeId: 'design', portId: 'notes' },
      to: { nodeId: 'build', portId: 'brief' }
    }
  ],
  startNodeIds: ['design']
};

// Feature 083 (US2, T038) — a richer port surface for the graph cases. Kept
// separate from the two Pipelines above rather than added to them: every gate
// test in this file is written against that exact pair, and widening it would
// change the fixtures under assertions that have nothing to do with US2.
const RICH_SOURCE_PIPELINE = {
  id: 'rich-source',
  name: 'Rich Source',
  version: 1,
  phases: ['speckit-specify', 'done'],
  inputs: [{ portId: 'goal', label: 'Goal', type: 'text' }],
  outputs: [
    { portId: 'notes', label: 'Notes', type: 'markdown' },
    { portId: 'summary', label: 'Summary', type: 'markdown' },
    { portId: 'files', label: 'Files', type: 'file-set' }
  ]
};
const RICH_TARGET_PIPELINE = {
  id: 'rich-target',
  name: 'Rich Target',
  version: 1,
  phases: ['finalize', 'done'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text' },
    { portId: 'context', label: 'Context', type: 'text' },
    { portId: 'folder', label: 'Folder', type: 'local-folder' }
  ],
  outputs: [{ portId: 'artifact', label: 'Artifact', type: 'markdown' }]
};
const GRAPH_PIPELINES = [
  DESIGN_PIPELINE,
  BUILD_PIPELINE,
  RICH_SOURCE_PIPELINE,
  RICH_TARGET_PIPELINE
];

// Feature 083 (US4, T045) — a `node-output` operand may only read a field from a
// structured output port, and none of the four Pipelines above declares one.
// Kept out of GRAPH_PIPELINES for the same reason RICH_* was kept out of the
// original pair: the US2 cases are written against exactly those four.
const SCORING_PIPELINE = {
  id: 'scoring',
  name: 'Scoring',
  version: 1,
  phases: ['speckit-specify', 'done'],
  inputs: [{ portId: 'goal', label: 'Goal', type: 'text' }],
  outputs: [
    { portId: 'findings', label: 'Findings', type: 'structured-data' },
    { portId: 'notes', label: 'Notes', type: 'markdown' }
  ]
};
const CONDITION_PIPELINES = [...GRAPH_PIPELINES, SCORING_PIPELINE];

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('workflow');

/**
 * A revision no seeded store ever reports, so a payload carrying it is provably
 * behind whatever the store holds. It replaces `workflowLayerRevision([])`, which
 * was a hash the test could compute because the revision was a function of the
 * layer; a store revision is the store's own now, opaque to both ends.
 */
const SUPERSEDED_REVISION = 'rev-workflow-superseded';

// Feature 098 (T080) — the fixture Pipelines name `speckit-specify` and
// `finalize`, which used to resolve out of the built-in Phase layer. That layer
// is empty now, so without these rows every gate below reports
// `workflow-validation` instead of the gate under test.
const PHASE_ROWS: readonly unknown[] = [
  { id: 'done', name: 'Done', version: 1, instruction: 'Done.' },
  ...SPECKIT_PHASE_DEFS
];

interface Harness {
  router: MessageRouter;
  acks: CommandAckMessage[];
  store: FakeCatalogStore;
  auditCalls: Array<Record<string, unknown>>;
}

function buildRouter(
  opts: {
    /** The stored Workflow catalog this save runs against. */
    rows?: readonly unknown[];
    omitConfigOps?: boolean;
    /**
     * Feature 099 (T496f, FR-029) — the settings writer used to throw to drive
     * gate 15; the store names the fault instead and answers exactly one write.
     */
    storeRefuses?: boolean;
    /** Defaults to the two-Pipeline pair every gate test above is written against. */
    pipelines?: readonly unknown[];
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const store = new FakeCatalogStore({
    phases: PHASE_ROWS,
    pipelines: opts.pipelines ?? [DESIGN_PIPELINE, BUILD_PIPELINE],
    workflows: opts.rows ?? []
  });
  if (opts.storeRefuses) {
    store.nextLayerVerdict = { outcome: 'refused', reason: 'not-writable', id: null };
  }

  const configOps = opts.omitConfigOps
    ? {}
    : {
        catalogStore: store,
        refreshCatalog: async () => undefined,
        readWorkflowConfig: () => ({
          rows: store.rowsOf('workflow'),
          revision: store.revisionOf('workflow')
        }),
        // Gate 5 resolves every `pipelineId` against the resolved Pipeline
        // catalog, which is itself resolved against the Phase catalog — so both
        // of the other two kinds have to be seeded.
        readPipelineConfig: () => ({
          rows: store.rowsOf('pipeline'),
          revision: store.revisionOf('pipeline')
        }),
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
      // have passed through this exactly once.
      sanitize: (value: string) => value.replaceAll('SECRET', '[redacted]')
    },
    audit: {
      append: async (entry: Record<string, unknown>) => {
        auditCalls.push(entry);
      }
    },
    ...configOps
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, store, auditCalls };
}

function savePayload(opts: {
  expectedRevision?: string;
  mutation?: WorkflowCatalogMutation;
  workflows?: readonly unknown[];
}) {
  return {
    expectedRevision: opts.expectedRevision ?? SEEDED_REVISION,
    mutation: opts.mutation ?? ({ kind: 'create', workflowId: 'design-then-build' } as const),
    workflows: opts.workflows ?? [TWO_NODE_WORKFLOW]
  };
}

async function dispatch(harness: Harness, payload: unknown, correlationId = 'save-wf-1') {
  await harness.router.dispatch(
    { type: CMD_SAVE_WORKFLOWS, correlationId, payload } as unknown as SidebarCommand,
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
    type: CMD_SAVE_WORKFLOWS,
    correlationId: 'scoped-save',
    payload: savePayload({})
  };

  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['expectedRevision', 'mutation', 'workflows'])(
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

  it('rejects undeclared payload keys', () => {
    expect(
      validateInboundMessage({
        ...valid,
        payload: { ...valid.payload, pipelines: ['must not be echoed at envelope level'] }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  // Feature 099 (T496f, FR-042) — the successor of `rejects an envelope missing
  // scope` and `rejects a non-writable target scope`. Both said the same thing
  // about a field with no referent left: name a layer, and only a writable one.
  // With one catalog, a caller that still names a layer is a caller pinned to the
  // deleted tier, and it fails loudly at the boundary rather than having the
  // extra field dropped on the way to a handler that would ignore it.
  it('rejects an envelope that still carries a scope (FR-042)', () => {
    for (const scope of ['user', 'workspace', 'built-in']) {
      expect(
        validateInboundMessage({ ...valid, payload: { ...valid.payload, scope } })
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    }
  });

  it('rejects a non-array workflows layer', () => {
    expect(
      validateInboundMessage({ ...valid, payload: { ...valid.payload, workflows: {} } })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each([
    { kind: 'create' },
    { kind: 'edit' },
    { kind: 'remove' },
    { kind: 'duplicate', workflowId: 'copy' },
    { kind: 'promote', workflowId: 'design-then-build' },
    { kind: 'reset', workflowId: 'design-then-build' }
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
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 3 — stale catalog', () => {
  it('rejects a save whose expectedRevision no longer matches the catalog', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: SUPERSEDED_REVISION,
        mutation: { kind: 'edit', workflowId: 'design-then-build' },
        workflows: [{ ...TWO_NODE_WORKFLOW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: SEEDED_REVISION,
      current: {
        workflowId: 'design-then-build',
        name: 'Design then Build',
        version: 1,
        legalActions: expect.arrayContaining(['refresh'])
      }
    });
    // Feature 099 (T496f, FR-042) — the record used to name the layer it was read
    // from, so the operator knew which one to refresh. There is one, so it names
    // none: a `scope` here would be the deleted tier reaching the operator
    // through the repair advice.
    expect(harness.acks[0].result).not.toMatchObject({ current: { scope: expect.anything() } });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('reports a reset against a stale catalog without naming a workflow', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: SUPERSEDED_REVISION,
        mutation: { kind: 'reset' },
        workflows: []
      })
    );
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: SEEDED_REVISION,
      current: { legalActions: expect.arrayContaining(['refresh']) }
    });
  });

  // FR-027, FR-028 and an AGENTS.md hard rule: the revision gate precedes every
  // trust question, so an operator working from a superseded snapshot is told the
  // catalog moved rather than being told a capability is off.
  //
  // Feature 099 (T496f, FR-046) — the capability that made the ordering
  // observable is deleted, so the case is restated as the stronger fact that
  // replaced it: no capability answer can preempt the staleness report, because
  // the save consults none. Denying every one of them changes nothing.
  it('reports staleness with every capability denied, and audits nothing', async () => {
    for (const capability of [
      'workflowOverrides',
      'pipelineOverrides',
      'phases',
      'retryConditions'
    ]) {
      mocks.state.capabilities.set(capability, false);
      mocks.state.scopes.set(capability, 'user');
    }
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: SUPERSEDED_REVISION,
        mutation: { kind: 'edit', workflowId: 'design-then-build' },
        workflows: [{ ...TWO_NODE_WORKFLOW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.auditCalls).toEqual([]);
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 9 — workflow identity is immutable under an edit', () => {
  it('refuses an edit that renames the row id and names duplicate as the legal action', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'edit', workflowId: 'design-then-build' },
        workflows: [{ ...TWO_NODE_WORKFLOW, id: 'renamed-flow' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-identity-immutable');
    expect(harness.acks[0].result).toMatchObject({
      workflowId: 'design-then-build',
      legalActions: ['duplicate']
    });
    expect(harness.store.layerSaves).toEqual([]);
  });
});

// Feature 099 (T496f, FR-039) — the successor of `gate 10 — the built-in layer is
// never a save target`. That gate existed so a mutation aimed at a built-in row
// named its cause instead of falling through to a generic mismatch; the layer it
// guarded held nothing for its whole life and is deleted. What the gate protected
// is unchanged and still asserted here: a mutation naming a row the catalog does
// not hold is refused, and writes nothing. Only the reason literal moves.
describe('a mutation naming a row the catalog does not hold', () => {
  it('is refused as a mismatch and writes nothing', async () => {
    const harness = buildRouter({});
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'remove', workflowId: 'design-then-build' },
        workflows: []
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 11 — declared intent must match the observed diff (FR-029)', () => {
  it('rejects a create whose layer also edits an untouched row', async () => {
    const second = {
      id: 'second-flow',
      name: 'Second Flow',
      version: 1,
      nodes: [{ nodeId: 'only', pipelineId: 'build-it' }],
      connections: [],
      startNodeIds: ['only']
    };
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', workflowId: 'second-flow' },
        workflows: [{ ...TWO_NODE_WORKFLOW, name: 'Smuggled Rename' }, second]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('rejects a reset that does not empty the catalog', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'reset' },
        workflows: [TWO_NODE_WORKFLOW]
      })
    );
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('rejects a remove that also drops a second row', async () => {
    const second = {
      id: 'second-flow',
      name: 'Second Flow',
      version: 1,
      nodes: [{ nodeId: 'only', pipelineId: 'build-it' }],
      connections: [],
      startNodeIds: ['only']
    };
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW, second] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'remove', workflowId: 'second-flow' },
        workflows: []
      })
    );
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });
});

describe('gate 12 — host-owned versions', () => {
  it('rejects a row asserting a version the host never issued (FR-001)', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'edit', workflowId: 'design-then-build' },
        workflows: [{ ...TWO_NODE_WORKFLOW, name: 'Renamed', version: 7 }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-version-invalid');
    expect(harness.acks[0].result).toMatchObject({ workflowId: 'design-then-build' });
    expect(harness.store.layerSaves).toEqual([]);
  });
});

// Feature 099 (T496f, FR-046) — the successor of `gates 13 and 14 —
// workflowOverrides capability`. Those gates asked whether one layer could
// redefine what another declares; one catalog poses no such question, and the
// capability is deleted along with the tier. The deny case has no reachable form,
// so what stands in its place is the negative a reintroduced gate would break.
// The reset case keeps its claim exactly and loses only the setting that used to
// make it interesting; the `pipelineOverrides` case widens to every capability,
// which is what it was really about.
describe('no override capability is left to consult (FR-046)', () => {
  it('accepts a non-reset save with every capability denied, and audits nothing', async () => {
    for (const capability of [
      'workflowOverrides',
      'pipelineOverrides',
      'phases',
      'retryConditions'
    ]) {
      mocks.state.capabilities.set(capability, false);
      mocks.state.scopes.set(capability, 'user');
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
    expect(mocks.state.asked).not.toContain('workflowOverrides');
    expect(mocks.state.asked).not.toContain('pipelineOverrides');
  });

  // Feature 059 invariant I-2 read forward: an operator can always return to
  // defaults, and the defaults are the empty catalog.
  it('lets a reset through, writing the empty catalog', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(harness, savePayload({ mutation: { kind: 'reset' }, workflows: [] }));
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.auditCalls).toEqual([]);
    expect(layerWrites(harness.store)).toEqual([[]]);
    expect(harness.store.rowsOf('workflow')).toEqual([]);
  });
});

describe('gate 15 — persistence failure', () => {
  it('rejects with persistence-failed and leaves the catalog unchanged (FR-030)', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW], storeRefuses: true });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'edit', workflowId: 'design-then-build' },
        workflows: [{ ...TWO_NODE_WORKFLOW, name: 'Renamed' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('persistence-failed');
    // Feature 099 (T496f, FR-029) — the store names the fault rather than
    // throwing, and the refusal travels to the operator, so a read-only catalog
    // stays distinguishable from a gate rejection.
    expect(harness.acks[0].result).toMatchObject({ storeRefusal: 'not-writable' });
    expect(harness.store.rowsOf('workflow')).toEqual([TWO_NODE_WORKFLOW]);
    expect(harness.store.revisionOf('workflow')).toBe(SEEDED_REVISION);
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
        id: 'design-then-build',
        name: 'Design then Build',
        version: 1,
        nodes: TWO_NODE_WORKFLOW.nodes,
        connections: TWO_NODE_WORKFLOW.connections,
        startNodeIds: ['design']
      })
    ]);
    expect(harness.acks[0].result).toEqual({
      revision: harness.store.revisionOf('workflow'),
      mutation: 'create'
    });
  });

  // A successful catalog save is a configuration write, not run history, so it
  // emits no audit event (FR-047).
  it('emits no audit event on a successful save', async () => {
    const harness = buildRouter({});
    await dispatch(harness, savePayload({}));
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.auditCalls).toEqual([]);
  });

  // Feature 099 (T496f, FR-004) — the successor of 'writes only the %s layer and
  // leaves the %s layer byte-for-byte unchanged'. That case pinned the third
  // `updateConfig` argument, which `extension.ts` mapped onto a
  // `vscode.ConfigurationTarget`. There is one Workflow catalog and no target to
  // choose, so what remains of the isolation claim is the part that still has two
  // sides: a Workflow save is addressed to the Workflow catalog, and the Phase and
  // Pipeline catalogs come out of it untouched — rows AND revision, which is
  // strictly stronger than the byte comparison it replaces.
  it('touches no catalog it was not addressed to (FR-004)', async () => {
    const harness = buildRouter({});
    const phasesBefore = JSON.stringify(harness.store.rowsOf('phase'));
    const pipelinesBefore = JSON.stringify(harness.store.rowsOf('pipeline'));
    const phaseRevision = harness.store.revisionOf('phase');
    const pipelineRevision = harness.store.revisionOf('pipeline');

    await dispatch(harness, savePayload({}));

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves.map((request) => request.kind)).toEqual(['workflow']);
    expect(JSON.stringify(harness.store.rowsOf('phase'))).toBe(phasesBefore);
    expect(harness.store.revisionOf('phase')).toBe(phaseRevision);
    expect(JSON.stringify(harness.store.rowsOf('pipeline'))).toBe(pipelinesBefore);
    expect(harness.store.revisionOf('pipeline')).toBe(pipelineRevision);
  });
});

// A duplicate is the only mutation naming two ids: the row it copies and the
// row it creates. Carrying a source pair must not become a way to smuggle an
// edit to another row through a create-shaped gate.
describe('duplicate mutation', () => {
  const duplicateOf = (overrides: Record<string, unknown> = {}) => ({
    ...TWO_NODE_WORKFLOW,
    id: 'design-then-build-copy',
    name: 'Design then Build (Copy)',
    version: 1,
    ...overrides
  });

  it('accepts a source-paired duplicate and persists both rows at independent versions', async () => {
    const source = { ...TWO_NODE_WORKFLOW, version: 7 };
    const harness = buildRouter({ rows: [source] });
    await dispatch(
      harness,
      savePayload({
        mutation: {
          kind: 'duplicate',
          sourceWorkflowId: 'design-then-build',
          workflowId: 'design-then-build-copy'
        },
        workflows: [source, duplicateOf()]
      })
    );
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.acks[0].result).toMatchObject({ mutation: 'duplicate' });
    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted.map((row) => row.id)).toEqual([
      'design-then-build',
      'design-then-build-copy'
    ]);
    expect(persisted[0]).toMatchObject({ version: 7 });
    expect(persisted[1]).toMatchObject({ version: 1 });
  });

  it('rejects a duplicate that also edits another row in the same catalog', async () => {
    const other = {
      id: 'other-flow',
      name: 'Other',
      version: 2,
      nodes: [{ nodeId: 'only', pipelineId: 'build-it' }],
      connections: [],
      startNodeIds: ['only']
    };
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW, other] });
    await dispatch(
      harness,
      savePayload({
        mutation: {
          kind: 'duplicate',
          sourceWorkflowId: 'design-then-build',
          workflowId: 'design-then-build-copy'
        },
        workflows: [TWO_NODE_WORKFLOW, { ...other, name: 'Renamed' }, duplicateOf()]
      })
    );
    expect(harness.acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'workflow-mutation-mismatch'
    });
    expect(harness.store.layerSaves).toHaveLength(0);
  });

  it('rejects a duplicate envelope missing sourceWorkflowId at the transport boundary', () => {
    const mutation = {
      kind: 'duplicate',
      workflowId: 'design-then-build-copy'
    } as Record<string, unknown>;
    expect(
      validateInboundMessage({
        type: CMD_SAVE_WORKFLOWS,
        correlationId: 'dup-1',
        payload: { ...savePayload({}), mutation }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  // Feature 099 (T496f, FR-043) — the successor of the `sourceScope` half of the
  // missing-key `it.each`. A duplicate named the layer it copied FROM as well as
  // the one it wrote to, because a copy could cross the tier. With one catalog the
  // source pair is `(sourceWorkflowId, workflowId)` and nothing else, so an
  // envelope still naming a source layer is refused rather than silently ignored.
  it('rejects a duplicate envelope that still carries sourceScope (FR-043)', () => {
    for (const sourceScope of ['user', 'workspace', 'built-in']) {
      expect(
        validateInboundMessage({
          type: CMD_SAVE_WORKFLOWS,
          correlationId: 'dup-2',
          payload: {
            ...savePayload({}),
            mutation: {
              kind: 'duplicate',
              sourceScope,
              sourceWorkflowId: 'design-then-build',
              workflowId: 'design-then-build-copy'
            }
          }
        })
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    }
  });
});

// Feature 083 (US2, T038) — gates 4-8, the accumulating validation pass.
//
// SC-002 names nine invalid graph shapes that MUST be refused. Each is
// submitted through the real save path rather than handed to the validator
// directly, because the property under test is not "the validator returns an
// error" but "no editor-side filtering can admit this save" (FR-008): the
// rejection has to carry the shape's own code, and the layer has to stay
// unwritten.
//
// Every fixture below is well-formed apart from the one defect it names, so a
// case that also trips a second rule would be testing the wrong thing.
describe('gates 4-8 — the nine invalid graph shapes (SC-002)', () => {
  interface GraphCase {
    readonly nodes: readonly unknown[];
    readonly connections: readonly unknown[];
    readonly startNodeIds: readonly string[];
  }

  function graphWorkflow(graph: GraphCase): Record<string, unknown> {
    return {
      id: 'graph-under-test',
      name: 'Graph Under Test',
      version: 1,
      nodes: graph.nodes,
      connections: graph.connections,
      startNodeIds: graph.startNodeIds
    };
  }

  async function submit(graph: GraphCase): Promise<{
    harness: Harness;
    ack: CommandAckMessage;
    errors: { workflowId: string; field: string; code: string; message: string }[];
  }> {
    const harness = buildRouter({ pipelines: GRAPH_PIPELINES });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', workflowId: 'graph-under-test' },
        workflows: [graphWorkflow(graph)]
      })
    );
    const ack = harness.acks[0];
    const result = ack.result as
      | { errors?: { workflowId: string; field: string; code: string; message: string }[] }
      | undefined;
    return { harness, ack, errors: result?.errors ?? [] };
  }

  /** The rejection reason and the no-write invariant, asserted for every case. */
  function expectRefused(
    outcome: Awaited<ReturnType<typeof submit>>,
    code: string
  ): { field: string; message: string } {
    expect(outcome.ack).toMatchObject({ status: 'rejected', reason: 'workflow-validation' });
    expect(outcome.harness.store.layerSaves).toEqual([]);
    const match = outcome.errors.find((error) => error.code === code);
    expect(
      match,
      `expected a '${code}' defect, got: ${outcome.errors.map((e) => `${e.field}=${e.code}`).join(', ')}`
    ).toBeDefined();
    return { field: match!.field, message: match!.message };
  }

  const SRC = { nodeId: 'src', pipelineId: 'rich-source' };
  const TGT = { nodeId: 'tgt', pipelineId: 'rich-target' };
  const NOTES_TO_BRIEF = {
    from: { nodeId: 'src', portId: 'notes' },
    to: { nodeId: 'tgt', portId: 'brief' }
  };

  it('the fixture graph itself saves clean, so each case below isolates one defect', async () => {
    const harness = buildRouter({ pipelines: GRAPH_PIPELINES });
    await dispatch(
      harness,
      savePayload({
        mutation: { kind: 'create', workflowId: 'graph-under-test' },
        workflows: [
          graphWorkflow({ nodes: [SRC, TGT], connections: [NOTES_TO_BRIEF], startNodeIds: ['src'] })
        ]
      })
    );
    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
    expect(harness.store.layerSaves).toHaveLength(1);
  });

  it('1. refuses a duplicate nodeId (FR-009)', async () => {
    const outcome = await submit({
      nodes: [SRC, { nodeId: 'src', pipelineId: 'rich-target' }],
      connections: [],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'duplicate-node-id');
    // Anchored on the second occurrence: the first one is what the rest of the
    // graph resolved against.
    expect(defect.field).toBe('nodes[1].nodeId');
  });

  it('2. refuses a connection naming a node the Workflow does not declare (FR-010)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [
        NOTES_TO_BRIEF,
        { from: { nodeId: 'ghost', portId: 'notes' }, to: { nodeId: 'tgt', portId: 'context' } }
      ],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'unresolved-endpoint');
    expect(defect.field).toBe('connections[1].from');
    expect(defect.message).toContain('ghost');
  });

  it('2b. refuses a connection naming a port the Pipeline does not declare (FR-010)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [{ from: { nodeId: 'src', portId: 'nope' }, to: { nodeId: 'tgt', portId: 'brief' } }],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'unresolved-endpoint');
    expect(defect.field).toBe('connections[0].from');
    expect(defect.message).toContain('nope');
  });

  it('3. refuses two connections binding one input port (FR-010a)', async () => {
    const outcome = await submit({
      // Two nodes on the same Pipeline is legal; both feed `tgt.brief`, which is not.
      nodes: [SRC, { nodeId: 'src2', pipelineId: 'rich-source' }, TGT],
      connections: [
        NOTES_TO_BRIEF,
        { from: { nodeId: 'src2', portId: 'summary' }, to: { nodeId: 'tgt', portId: 'brief' } }
      ],
      startNodeIds: ['src', 'src2']
    });
    const defect = expectRefused(outcome, 'duplicate-input-binding');
    expect(defect.message).toContain('tgt.brief');
  });

  it('4. refuses an incompatible port pair and names both types (FR-011)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      // `markdown` accepts `text` and `source`; `local-folder` is neither.
      connections: [{ from: { nodeId: 'src', portId: 'notes' }, to: { nodeId: 'tgt', portId: 'folder' } }],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'incompatible-port-types');
    expect(defect.message).toContain('markdown');
    expect(defect.message).toContain('local-folder');
  });

  it('5. refuses two default branches on one source node (FR-012)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [
        { ...NOTES_TO_BRIEF, isDefault: true },
        {
          from: { nodeId: 'src', portId: 'summary' },
          to: { nodeId: 'tgt', portId: 'context' },
          isDefault: true
        }
      ],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'multiple-default-branches');
    expect(defect.field).toBe('connections[1].isDefault');
    expect(defect.message).toContain('src');
  });

  it('6. refuses a directed cycle and names every member (FR-013)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [
        NOTES_TO_BRIEF,
        { from: { nodeId: 'tgt', portId: 'artifact' }, to: { nodeId: 'src', portId: 'goal' } }
      ],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'graph-cycle');
    // Naming only the entry node would leave the operator guessing which edge to cut.
    expect(defect.message).toContain('src');
    expect(defect.message).toContain('tgt');
  });

  it('6b. reports that condition checks did not run for a cyclic graph', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [
        NOTES_TO_BRIEF,
        { from: { nodeId: 'tgt', portId: 'artifact' }, to: { nodeId: 'src', portId: 'goal' } }
      ],
      startNodeIds: ['src']
    });
    expectRefused(outcome, 'graph-cycle');
    expect(outcome.ack.result).toMatchObject({ ancestryChecksSuppressed: true });
  });

  it('7. refuses a node no allowed start can reach (FR-014)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT, { nodeId: 'lonely', pipelineId: 'rich-target' }],
      connections: [NOTES_TO_BRIEF],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'unreachable-node');
    expect(defect.field).toBe('nodes[2].nodeId');
    expect(defect.message).toContain('lonely');
  });

  it('8. refuses an empty allowed-start set (FR-015)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [NOTES_TO_BRIEF],
      startNodeIds: []
    });
    expect(expectRefused(outcome, 'invalid-start-set').field).toBe('startNodeIds');
  });

  it('8b. refuses an allowed start naming no declared node (FR-015)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      connections: [NOTES_TO_BRIEF],
      startNodeIds: ['ghost']
    });
    const defect = expectRefused(outcome, 'invalid-start-set');
    expect(defect.field).toBe('startNodeIds[0]');
    expect(defect.message).toContain('ghost');
  });

  it('9. refuses a collection source feeding a single-valued target with no selection rule (FR-018)', async () => {
    const outcome = await submit({
      nodes: [SRC, TGT],
      // `file-set` is accepted by `local-folder`, so this is a selection defect,
      // not a compatibility one.
      connections: [{ from: { nodeId: 'src', portId: 'files' }, to: { nodeId: 'tgt', portId: 'folder' } }],
      startNodeIds: ['src']
    });
    const defect = expectRefused(outcome, 'selection-rule-required');
    expect(defect.field).toBe('connections[0].selection');
  });
});

// Feature 083 (US2, T040) — the two shapes the nine SC-002 cases leave open.
//
// A self-edge is a cycle of one. It gets its own case because the two graph
// algorithms reach it by different routes — Kahn never drops a self-looping
// node's in-degree to zero, and Tarjan carries an explicit `selfLooped` set —
// and neither route is exercised by the two-node cycle above.
//
// The selection rule is the other half of SC-002 case 9: refusing an
// unselected collection edge is only correct if a selected one is accepted.
// A refusal with no legal repair would be a dead end, not a gate.
describe('gates 4-8 — self-edges and the selection-rule repair (T040)', () => {
  function submitGraph(
    nodes: readonly unknown[],
    connections: readonly unknown[],
    startNodeIds: readonly string[]
  ): { harness: Harness; dispatched: Promise<void> } {
    const harness = buildRouter({ pipelines: GRAPH_PIPELINES });
    return {
      harness,
      dispatched: dispatch(
        harness,
        savePayload({
          mutation: { kind: 'create', workflowId: 'graph-under-test' },
          workflows: [
            {
              id: 'graph-under-test',
              name: 'Graph Under Test',
              version: 1,
              nodes,
              connections,
              startNodeIds
            }
          ]
        })
      )
    };
  }

  it('refuses a self-edge as a cycle of one naming that node (FR-013)', async () => {
    // `markdown -> text` is a compatible pair, so nothing but the self-reference
    // is wrong with this edge.
    const { harness, dispatched } = submitGraph(
      [{ nodeId: 'loop', pipelineId: 'rich-source' }],
      [{ from: { nodeId: 'loop', portId: 'notes' }, to: { nodeId: 'loop', portId: 'goal' } }],
      ['loop']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'rejected', reason: 'workflow-validation' });
    expect(harness.store.layerSaves).toEqual([]);
    const errors = (harness.acks[0].result as { errors?: { code: string; message: string }[] })
      .errors!;
    const cycle = errors.find((error) => error.code === 'graph-cycle');
    expect(cycle).toBeDefined();
    expect(cycle!.message).toContain('loop');
  });

  it('refuses a self-edge even when the node is an allowed start', async () => {
    // A start node is reachable by definition, so the reachability pass cannot
    // catch this — the cycle pass has to.
    const { harness, dispatched } = submitGraph(
      [
        { nodeId: 'loop', pipelineId: 'rich-source' },
        { nodeId: 'tgt', pipelineId: 'rich-target' }
      ],
      [
        { from: { nodeId: 'loop', portId: 'notes' }, to: { nodeId: 'loop', portId: 'goal' } },
        { from: { nodeId: 'loop', portId: 'summary' }, to: { nodeId: 'tgt', portId: 'brief' } }
      ],
      ['loop']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'rejected', reason: 'workflow-validation' });
    const errors = (harness.acks[0].result as { errors?: { code: string }[] }).errors!;
    expect(errors.some((error) => error.code === 'graph-cycle')).toBe(true);
    expect(errors.some((error) => error.code === 'unreachable-node')).toBe(false);
  });

  it.each(['first', 'last', 'exactlyOne'] as const)(
    'accepts the same collection edge once a %s selection rule is declared (FR-018)',
    async (selection) => {
      const { harness, dispatched } = submitGraph(
        [
          { nodeId: 'src', pipelineId: 'rich-source' },
          { nodeId: 'tgt', pipelineId: 'rich-target' }
        ],
        [
          {
            from: { nodeId: 'src', portId: 'files' },
            to: { nodeId: 'tgt', portId: 'folder' },
            selection
          }
        ],
        ['src']
      );
      await dispatched;

      expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
      expect(harness.store.layerSaves).toHaveLength(1);
      // The rule reaches configuration verbatim; it is a run-time contract, and
      // the save path is not entitled to normalize it away.
      const written = layerWrites(harness.store)[0] as unknown as {
        connections: { selection?: string }[];
      }[];
      expect(written[0].connections[0].selection).toBe(selection);
    }
  );

  it('rejects a selection rule that is not one of the three supported values', async () => {
    const { harness, dispatched } = submitGraph(
      [
        { nodeId: 'src', pipelineId: 'rich-source' },
        { nodeId: 'tgt', pipelineId: 'rich-target' }
      ],
      [
        {
          from: { nodeId: 'src', portId: 'files' },
          to: { nodeId: 'tgt', portId: 'folder' },
          selection: 'random'
        }
      ],
      ['src']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'rejected', reason: 'workflow-validation' });
    expect(harness.store.layerSaves).toEqual([]);
  });

  it('does not require a selection rule for a single-valued source (FR-018)', async () => {
    // The rule is scoped to collection sources. Demanding one everywhere would
    // make every ordinary edge unauthorable.
    const { harness, dispatched } = submitGraph(
      [
        { nodeId: 'src', pipelineId: 'rich-source' },
        { nodeId: 'tgt', pipelineId: 'rich-target' }
      ],
      [{ from: { nodeId: 'src', portId: 'notes' }, to: { nodeId: 'tgt', portId: 'brief' } }],
      ['src']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });
});

// Feature 083 (US4, T045) — bounded conditional routing (FR-020 - FR-024).
//
// The premise these cases defend is that a condition is *data*, not an
// expression: there is no parser, evaluator, template engine, or sandbox
// anywhere on the path, so FR-021 holds by construction rather than by a
// blocklist. Blocklists are the thing this design exists to avoid — they leak.
// The cases below therefore assert two separable properties: the closed
// operator set is fully authorable (a gate with no legal path through it is
// useless), and every expression-shaped condition is refused on shape before
// its content could matter.
describe('gates 4-8 — bounded conditional routing (T045)', () => {
  const SCORE = { nodeId: 'score', pipelineId: 'scoring' };
  const SINK = { nodeId: 'tgt', pipelineId: 'rich-target' };
  /** `rich-source` declares markdown and file-set outputs and no structured one. */
  const PLAIN = { nodeId: 'plain', pipelineId: 'rich-source' };

  /** The field the operand reads. Whether the Pipeline emits it is FR-R2-007's question. */
  const LEFT_OUTPUT = { source: 'node-output', nodeId: 'score', field: 'risk' } as const;

  function submitGraph(
    nodes: readonly unknown[],
    connections: readonly unknown[],
    startNodeIds: readonly string[]
  ): { harness: Harness; dispatched: Promise<void> } {
    const harness = buildRouter({ pipelines: CONDITION_PIPELINES });
    return {
      harness,
      dispatched: dispatch(
        harness,
        savePayload({
          mutation: { kind: 'create', workflowId: 'conditional' },
          workflows: [
            { id: 'conditional', name: 'Conditional', version: 1, nodes, connections, startNodeIds }
          ]
        })
      )
    };
  }

  /** The one-branch graph most cases below hang a condition on. */
  async function submitCondition(condition: unknown): Promise<Harness> {
    const { harness, dispatched } = submitGraph(
      [SCORE, SINK],
      [
        {
          from: { nodeId: 'score', portId: 'notes' },
          to: { nodeId: 'tgt', portId: 'brief' },
          condition
        }
      ],
      ['score']
    );
    await dispatched;
    return harness;
  }

  function errorsOf(harness: Harness): { field: string; code: string; message: string }[] {
    const result = harness.acks[0].result as {
      errors?: { field: string; code: string; message: string }[];
    };
    return result.errors ?? [];
  }

  function expectRefusedCondition(harness: Harness, code: string): { field: string } {
    expect(harness.acks[0]).toMatchObject({ status: 'rejected', reason: 'workflow-validation' });
    expect(harness.store.layerSaves).toEqual([]);
    const defect = errorsOf(harness).find((error) => error.code === code);
    expect(defect, `expected a ${code} defect, got ${JSON.stringify(errorsOf(harness))}`).toBeDefined();
    return defect!;
  }

  it('accepts the same branch with no condition, isolating every refusal below', async () => {
    const { harness, dispatched } = submitGraph(
      [SCORE, SINK],
      [{ from: { nodeId: 'score', portId: 'notes' }, to: { nodeId: 'tgt', portId: 'brief' } }],
      ['score']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  // --- FR-020: the closed operator set is authorable in full -----------------

  const OPERATOR_CASES: readonly { operator: string; right?: unknown }[] = [
    { operator: 'equals', right: 'high' },
    { operator: 'notEquals', right: 'low' },
    { operator: 'in', right: ['high', 'medium'] },
    { operator: 'exists' },
    { operator: 'greaterThan', right: 5 },
    { operator: 'greaterThanOrEqual', right: 5 },
    { operator: 'lessThan', right: 5 },
    { operator: 'lessThanOrEqual', right: 5 }
  ];

  it('covers every operator the contract declares', () => {
    // Adding a ninth operator to the contract without a case here fails this
    // assertion rather than silently shipping an unexercised comparison.
    expect(OPERATOR_CASES.map((entry) => entry.operator)).toEqual([
      ...WORKFLOW_CONDITION_OPERATORS
    ]);
  });

  it.each(OPERATOR_CASES)('accepts the $operator operator in a valid branch (FR-020)', async (spec) => {
    const harness = await submitCondition({ left: LEFT_OUTPUT, ...spec });

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
    expect(harness.store.layerSaves).toHaveLength(1);
  });

  it('writes the accepted condition to configuration verbatim', async () => {
    const condition = { left: LEFT_OUTPUT, operator: 'in', right: ['high', 'medium'] };
    const harness = await submitCondition(condition);

    const written = layerWrites(harness.store)[0] as unknown as {
      connections: { condition?: unknown }[];
    }[];
    // The save path is not entitled to normalize a run-time contract.
    expect(written[0].connections[0].condition).toEqual(condition);
  });

  it('rejects an operator outside the closed set (FR-020)', async () => {
    const harness = await submitCondition({
      left: LEFT_OUTPUT,
      operator: 'matchesRegex',
      right: '^high$'
    });

    expectRefusedCondition(harness, 'unsupported-condition');
  });

  // --- FR-021 / SC-004: expression-shaped conditions never reach a reader ----

  const EXPRESSION_FORMS: readonly { label: string; expression: string }[] = [
    { label: 'a JavaScript fragment', expression: "node.output.risk === 'high'" },
    { label: 'a shell command', expression: '$(cat /etc/passwd)' },
    { label: 'a template expression', expression: '{{ score.risk | upper }}' },
    { label: 'an Agent expression', expression: 'ask the agent whether the risk is high' }
  ];

  it.each(EXPRESSION_FORMS)('rejects $label as unsupported-condition (FR-021)', async ({ expression }) => {
    const harness = await submitCondition(expression);

    expectRefusedCondition(harness, 'unsupported-condition');
    // The authored text is never echoed back. Reflecting it would both hand an
    // operator-authored string to the webview and imply the host had looked
    // into it; neither is true, and neither should be.
    for (const error of errorsOf(harness)) {
      expect(error.message).not.toContain(expression);
    }
  });

  it('rejects a tautology, which is evidence no engine evaluated it (SC-004)', async () => {
    // `1 === 1` is true under every engine that could plausibly have run it.
    // Refusing it therefore rules out evaluation-then-rejection: the branch is
    // refused on shape, before the question of a value can arise.
    const harness = await submitCondition('1 === 1');

    expectRefusedCondition(harness, 'unsupported-condition');
  });

  it('rejects an extra authored field that could smuggle an expression in (FR-021)', async () => {
    const harness = await submitCondition({
      left: LEFT_OUTPUT,
      operator: 'equals',
      right: 'high',
      expr: "node.output.risk === 'high'"
    });

    const defect = expectRefusedCondition(harness, 'unsupported-condition');
    expect(defect.field).toBe('connections[0].condition.expr');
  });

  // --- FR-022: a left operand names structured output or node status --------

  it('rejects a left operand naming a node the Workflow does not declare (FR-022)', async () => {
    const harness = await submitCondition({
      left: { source: 'node-output', nodeId: 'ghost', field: 'risk' },
      operator: 'exists'
    });

    const defect = expectRefusedCondition(harness, 'condition-operand-unknown');
    expect(defect.field).toBe('connections[0].condition.left');
  });

  it('rejects a node-output operand on a Pipeline with no structured output port (FR-022)', async () => {
    // `plain` is a genuine ancestor of the branching node, so the only thing
    // wrong with this operand is the port surface it tries to read.
    const { harness, dispatched } = submitGraph(
      [PLAIN, SCORE, SINK],
      [
        { from: { nodeId: 'plain', portId: 'notes' }, to: { nodeId: 'score', portId: 'goal' } },
        {
          from: { nodeId: 'score', portId: 'notes' },
          to: { nodeId: 'tgt', portId: 'brief' },
          condition: {
            left: { source: 'node-output', nodeId: 'plain', field: 'risk' },
            operator: 'exists'
          }
        }
      ],
      ['plain']
    );
    await dispatched;

    const defect = expectRefusedCondition(harness, 'condition-operand-unknown');
    expect(defect.field).toBe('connections[1].condition.left');
    expect(errorsOf(harness).some((error) => error.code === 'condition-operand-not-ancestor')).toBe(
      false
    );
  });

  it('rejects an operand source that is neither node-output nor node-status (FR-022)', async () => {
    const harness = await submitCondition({
      left: { source: 'workspace-file', nodeId: 'score', field: 'risk' },
      operator: 'exists'
    });

    const defect = expectRefusedCondition(harness, 'condition-operand-unknown');
    expect(defect.field).toBe('connections[0].condition.left.source');
  });

  it('accepts a node-status operand, the other legal source (FR-022)', async () => {
    const harness = await submitCondition({
      left: { source: 'node-status', nodeId: 'score' },
      operator: 'equals',
      right: 'completed'
    });

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  it('rejects a node-status comparison against a value outside the terminal set (FR-022)', async () => {
    const harness = await submitCondition({
      left: { source: 'node-status', nodeId: 'score' },
      operator: 'equals',
      right: 'running'
    });

    expectRefusedCondition(harness, 'condition-right-invalid');
  });

  // --- FR-023: a left operand names a node that has already run -------------

  it('rejects a left operand naming a node that has not run yet (FR-023)', async () => {
    // `tgt` is the branch's own target: it cannot have produced a status at the
    // moment the branch out of `score` is evaluated.
    const harness = await submitCondition({
      left: { source: 'node-status', nodeId: 'tgt' },
      operator: 'equals',
      right: 'completed'
    });

    const defect = expectRefusedCondition(harness, 'condition-operand-not-ancestor');
    expect(defect.field).toBe('connections[0].condition.left');
  });

  it('accepts an operand naming an ancestor of the branching node (FR-023)', async () => {
    const { harness, dispatched } = submitGraph(
      [PLAIN, SCORE, SINK],
      [
        { from: { nodeId: 'plain', portId: 'notes' }, to: { nodeId: 'score', portId: 'goal' } },
        {
          from: { nodeId: 'score', portId: 'notes' },
          to: { nodeId: 'tgt', portId: 'brief' },
          condition: {
            left: { source: 'node-status', nodeId: 'plain' },
            operator: 'equals',
            right: 'completed'
          }
        }
      ],
      ['plain']
    );
    await dispatched;

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  // --- FR-024: the right operand is a literal, never a second reference -----

  it('rejects a right operand that references another field (FR-024)', async () => {
    // Allowing this would make the right side a second operand expression, and
    // the closed comparison set would stop being closed.
    const harness = await submitCondition({
      left: LEFT_OUTPUT,
      operator: 'equals',
      right: { source: 'node-output', nodeId: 'score', field: 'threshold' }
    });

    const defect = expectRefusedCondition(harness, 'condition-right-invalid');
    expect(defect.field).toBe('connections[0].condition.right');
  });

  it('accepts a literal right operand (FR-024)', async () => {
    const harness = await submitCondition({ left: LEFT_OUTPUT, operator: 'equals', right: 'high' });

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  it('accepts a non-empty literal list for the in operator (FR-024)', async () => {
    const harness = await submitCondition({
      left: LEFT_OUTPUT,
      operator: 'in',
      right: ['high', 'medium', 'low']
    });

    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  it('rejects an empty list for the in operator (FR-024)', async () => {
    // An empty membership test is always false, so the branch is unreachable by
    // construction. Refusing it at authoring time beats a run that never fires.
    const harness = await submitCondition({ left: LEFT_OUTPUT, operator: 'in', right: [] });

    expectRefusedCondition(harness, 'condition-right-invalid');
  });

  it('rejects a right operand supplied to the exists operator (FR-024)', async () => {
    const harness = await submitCondition({
      left: LEFT_OUTPUT,
      operator: 'exists',
      right: 'high'
    });

    expectRefusedCondition(harness, 'condition-right-invalid');
  });
});

// Feature 086 T048 (FR-046, FR-048, FR-049, FR-003a) — the third ordered write.
//
// This is the Workflow layer's half of the package-import contract. The envelope,
// the revision gate, and the gate order are the ones 083 already shipped; what is
// new is that one write may name a SET of ids and that each named row keeps the
// version its document declared instead of the version the host would assign.
describe('import-package — the Workflow layer write of a package import', () => {
  const IMPORTED_A = {
    id: 'imported-alpha',
    name: 'Imported Alpha',
    version: 3,
    nodes: [{ nodeId: 'design', pipelineId: 'design-review' }],
    connections: [],
    startNodeIds: ['design']
  };
  const IMPORTED_B = {
    id: 'imported-beta',
    name: 'Imported Beta',
    version: 7,
    nodes: [{ nodeId: 'build', pipelineId: 'build-it' }],
    connections: [],
    startNodeIds: ['build']
  };

  const packageMutation = (...workflowIds: readonly string[]) =>
    ({ kind: 'import-package', workflowIds } as unknown as WorkflowCatalogMutation);

  describe('gate 2 — the envelope carries a declared set', () => {
    const envelope = (mutation: unknown) => ({
      type: CMD_SAVE_WORKFLOWS,
      correlationId: 'import-package',
      payload: { ...savePayload({ workflows: [IMPORTED_A] }), mutation }
    });

    it('accepts a package envelope naming its declared workflow ids', () => {
      expect(
        validateInboundMessage(envelope({ kind: 'import-package', workflowIds: ['imported-alpha'] }))
      ).toMatchObject({ ok: true });
    });

    // The ingress gate is the only place a malformed set can be turned away
    // before dispatch. An empty set would reach an algebra that rejects it as a
    // mutation mismatch — a reason that describes the diff rather than the
    // envelope, which is the wrong answer for a transport-shaped defect.
    it.each([
      { kind: 'import-package' },
      { kind: 'import-package', workflowIds: [] },
      { kind: 'import-package', workflowIds: 'imported-alpha' },
      { kind: 'import-package', workflowIds: [''] },
      { kind: 'import-package', workflowIds: ['x'.repeat(65)] },
      { kind: 'import-package', workflowIds: [123] },
      { kind: 'import-package', workflowIds: ['imported-alpha'], workflowId: 'imported-alpha' }
    ])('rejects a malformed package mutation %o', (mutation) => {
      expect(validateInboundMessage(envelope(mutation))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });
  });

  it('appends the declared set and acknowledges the package intent (FR-046)', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha', 'imported-beta'),
        workflows: [TWO_NODE_WORKFLOW, IMPORTED_A, IMPORTED_B]
      })
    );
    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves).toHaveLength(1);
    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted.map((row) => row.id)).toEqual([
      'design-then-build',
      'imported-alpha',
      'imported-beta'
    ]);
    expect(harness.acks[0].result).toEqual({
      revision: harness.store.revisionOf('workflow'),
      mutation: 'import-package'
    });
  });

  // FR-003a. `withHostVersions` starts an id absent from the layer at 1, which is
  // right for a Workflow the operator just created and wrong for one being read
  // out of a document that already numbered it. The declared version is restored
  // for the named rows only — the carried-across row keeps the host's.
  it('keeps the version each named row declared, and only for those rows', async () => {
    const carried = { ...TWO_NODE_WORKFLOW, version: 4 };
    const harness = buildRouter({ rows: [carried] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha', 'imported-beta'),
        workflows: [carried, IMPORTED_A, IMPORTED_B]
      })
    );
    expect(harness.acks[0].status).toBe('accepted');
    const persisted = layerWrites(harness.store)[0] as readonly Record<string, unknown>[];
    expect(persisted.map((row) => [row.id, row.version])).toEqual([
      ['design-then-build', 4],
      ['imported-alpha', 3],
      ['imported-beta', 7]
    ]);
  });

  // Gate 12 refuses a version the host never issued. An imported identity is the
  // one exemption (FR-003a): it declares its own. The exemption is keyed on the
  // declared set, so a row the intent does not name is still checked.
  it('refuses a version echo from a row the package intent does not name', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha'),
        workflows: [{ ...TWO_NODE_WORKFLOW, version: 9 }, IMPORTED_A]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-version-invalid');
    expect(harness.acks[0].result).toMatchObject({ workflowId: 'design-then-build' });
    expect(harness.store.layerSaves).toEqual([]);
  });

  // FR-048. A set has no single authoritative row to report, so the record names
  // the revision only, and `reapply` is not offered: the plan's skip and blocked
  // decisions were computed against the revision just rejected.
  it('rejects a superseded revision as stale-catalog with the authoritative record', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: SUPERSEDED_REVISION,
        mutation: packageMutation('imported-alpha'),
        workflows: [TWO_NODE_WORKFLOW, IMPORTED_A]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.acks[0].result).toMatchObject({
      currentRevision: SEEDED_REVISION,
      current: { legalActions: ['refresh'] }
    });
    expect(harness.acks[0].result).not.toMatchObject({ current: { workflowId: expect.anything() } });
    // Feature 099 (T496f, FR-042) — the record used to name the scope alongside
    // the revision. One catalog leaves the revision as the whole of it.
    expect(harness.acks[0].result).not.toMatchObject({ current: { scope: expect.anything() } });
    expect(harness.store.layerSaves).toEqual([]);
  });

  // FR-049 and an AGENTS.md hard rule: the revision gate precedes every trust
  // question, so a stale package write reports the staleness.
  //
  // Feature 099 (T496f, FR-046) — restated the same way as its gate-3 twin: the
  // capability that made the ordering observable is deleted, and what replaced it
  // is stronger. No capability answer can preempt the report, because the package
  // arm consults none either.
  it('reports staleness with every capability denied, and audits no denial', async () => {
    for (const capability of [
      'workflowOverrides',
      'pipelineOverrides',
      'phases',
      'retryConditions'
    ]) {
      mocks.state.capabilities.set(capability, false);
      mocks.state.scopes.set(capability, 'user');
    }
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        expectedRevision: SUPERSEDED_REVISION,
        mutation: packageMutation('imported-alpha'),
        workflows: [TWO_NODE_WORKFLOW, IMPORTED_A]
      })
    );
    expect(harness.acks[0].reason).toBe('stale-catalog');
    expect(harness.auditCalls.filter((entry) => entry.eventType === 'trust.capability-denied'))
      .toEqual([]);
    expect(harness.store.layerSaves).toEqual([]);
  });

  // Feature 099 (T496f, FR-046) — the successor of `is not privileged past the
  // workflowOverrides capability`. That case asserted the package arm could not
  // route around a gate the ordinary arm was subject to; the gate is deleted, so
  // the reachable form of "no special treatment" is the inverse. The package arm
  // is not privileged past the LAST gate either: a store that refuses the write
  // reports `persistence-failed` here exactly as it does for a create, and the
  // catalog is left where it was.
  it('is not privileged past a store refusal, and asks no capability', async () => {
    for (const capability of ['workflowOverrides', 'pipelineOverrides']) {
      mocks.state.capabilities.set(capability, false);
    }
    const harness = buildRouter({ storeRefuses: true });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha'),
        workflows: [IMPORTED_A]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('persistence-failed');
    expect(harness.acks[0].result).toMatchObject({ storeRefusal: 'not-writable' });
    expect(harness.store.rowsOf('workflow')).toEqual([]);
    expect(harness.store.revisionOf('workflow')).toBe(SEEDED_REVISION);
    expect(mocks.state.asked).not.toContain('workflowOverrides');
    expect(mocks.state.asked).not.toContain('pipelineOverrides');
  });

  // Exactly one intent, and it is the whole story of the diff (FR-046). Anything
  // the set does not name is a second, undeclared mutation riding along.
  it.each([
    [
      'an addition the set does not name',
      [TWO_NODE_WORKFLOW, IMPORTED_A, { ...IMPORTED_B, id: 'stowaway' }]
    ],
    ['an edit to a carried row', [{ ...TWO_NODE_WORKFLOW, name: 'Renamed' }, IMPORTED_A]],
    ['a removal of a carried row', [IMPORTED_A]]
  ])('rejects a package write that also performs %s', async (_label, workflows) => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha'),
        workflows
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });

  // A reorder needs two carried rows to be observable at all: with one, every
  // position an imported row can take is a legal insertion. The shape gate deletes
  // the added rows and requires what is left to reproduce the current layer IN
  // ORDER, so a swap of the two survivors is refused even though the diff itself
  // is a pure addition. (Feature 099: "the current layer" is the current catalog.)
  it('rejects a package write that also reorders the carried rows', async () => {
    const other = {
      id: 'other-flow',
      name: 'Other',
      version: 1,
      nodes: [{ nodeId: 'only', pipelineId: 'build-it' }],
      connections: [],
      startNodeIds: ['only']
    };
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW, other] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha'),
        workflows: [other, TWO_NODE_WORKFLOW, IMPORTED_A]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.acks[0].reason).toBe('workflow-mutation-mismatch');
    expect(harness.store.layerSaves).toEqual([]);
  });

  // FR-030 read forward from the planner: an id the catalog already claims can
  // never arrive here as an import, so the gate refuses it rather than letting a
  // document overwrite authored work through the package arm.
  it('rejects a declared id the catalog already holds', async () => {
    const harness = buildRouter({ rows: [TWO_NODE_WORKFLOW] });
    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('design-then-build'),
        workflows: [TWO_NODE_WORKFLOW, { ...TWO_NODE_WORKFLOW, name: 'From the document' }]
      })
    );
    expect(harness.acks[0].status).toBe('rejected');
    expect(harness.store.layerSaves).toEqual([]);
  });

  // Feature 099 (T496f, FR-004) — the successor of 'writes only the chosen scope
  // and leaves the other layer byte-for-byte unchanged', for the package arm. The
  // isolation that still has two sides is between catalogs, not between layers of
  // one: a package import addressed to Workflows writes Workflows and nothing else.
  it('touches no catalog it was not addressed to (FR-004)', async () => {
    const harness = buildRouter({});
    const phasesBefore = JSON.stringify(harness.store.rowsOf('phase'));
    const pipelinesBefore = JSON.stringify(harness.store.rowsOf('pipeline'));
    const phaseRevision = harness.store.revisionOf('phase');
    const pipelineRevision = harness.store.revisionOf('pipeline');

    await dispatch(
      harness,
      savePayload({
        mutation: packageMutation('imported-alpha'),
        workflows: [IMPORTED_A]
      })
    );

    expect(harness.acks[0].status).toBe('accepted');
    expect(harness.store.layerSaves.map((request) => request.kind)).toEqual(['workflow']);
    expect(JSON.stringify(harness.store.rowsOf('phase'))).toBe(phasesBefore);
    expect(harness.store.revisionOf('phase')).toBe(phaseRevision);
    expect(JSON.stringify(harness.store.rowsOf('pipeline'))).toBe(pipelinesBefore);
    expect(harness.store.revisionOf('pipeline')).toBe(pipelineRevision);
  });
});
