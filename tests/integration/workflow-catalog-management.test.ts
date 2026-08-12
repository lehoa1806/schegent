// Feature 083 (US1, T036) — a Workflow graph survives a full save-and-reload
// round trip.
//
// What makes this worth an integration test rather than two unit tests: the
// save side normalizes an authored row into a `WorkflowDefinition` and back out
// into settings shape, and the reload side parses that settings shape again. A
// graph is positional in two independent ways — node order and connection order
// — and neither side may sort, dedupe, or otherwise normalize either one
// (FR-049), while that authored order is deliberately *not* execution order
// (SC-013). A row carrying unrecognized authored keys makes the same trip, so
// FR-007's round-trip fidelity is exercised on the same path.
//
// Also pinned here: the stored row holds no run identifier, session value,
// transcript, or workspace path (FR-006), and a superseded revision is refused
// with the authoritative record and legal actions while both layers stay
// untouched (FR-028, SC-005).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../src/config/pipeline-config';
import type { CatalogConfigReader } from '../../src/config/pipeline-config-loader';
import { loadCatalog } from '../../src/config/pipeline-config-loader';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { resolveWorkflowCatalog, workflowLayerRevision } from '../../src/config/workflow-catalog';
import { deriveWorkflowPorts } from '../../src/config/workflow-derived-ports';
import type {
  WorkflowCatalogMutation,
  WorkflowDefinition
} from '../../src/contracts/workflow-definitions';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { handler as saveWorkflowsHandler } from '../../src/ui/sidebar/commands/cmd-save-workflows';
import { CMD_SAVE_WORKFLOWS } from '../../src/ui/sidebar/messages';
import type { CommandAckMessage, SaveWorkflowsCommand } from '../../src/ui/sidebar/messages';
import { findQueueRuntime, type WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { collectWorkflowDefinitionPipelineRefs } from '../../src/ui/sidebar/workflow-definition-pipeline-refs';
import { collectWorkflowPipelineRefs } from '../../src/ui/sidebar/workflow-pipeline-refs';

const WORKFLOW_ID = 'design-then-build';

/** The one operator-authored Phase; the rest of the sequences use built-ins. */
const AUTHORED_PHASE_ROWS: readonly unknown[] = [
  { id: 'done', name: 'Done', version: 1, instruction: 'Done.' }
];

// Built-in Pipelines declare no ports, so a connection between two of them could
// never resolve. These two carry two compatible `markdown -> text` pairs plus an
// unbound input and an unconsumed output, so the derived-port surface is
// non-empty on both sides.
const DESIGN_PIPELINE = {
  id: 'design-review',
  name: 'Design Review',
  version: 1,
  phases: ['speckit-specify', 'done'],
  inputs: [{ portId: 'goal', label: 'Goal', type: 'text' }],
  outputs: [
    { portId: 'notes', label: 'Notes', type: 'markdown' },
    { portId: 'summary', label: 'Summary', type: 'markdown' }
  ]
};
const BUILD_PIPELINE = {
  id: 'build-it',
  name: 'Build It',
  version: 1,
  phases: ['finalize', 'done'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text' },
    { portId: 'context', label: 'Context', type: 'text' }
  ],
  outputs: [{ portId: 'artifact', label: 'Artifact', type: 'markdown' }]
};

/**
 * Deliberately authored "backwards": `build` is listed before `design` even
 * though `design` is the only allowed start and feeds `build`. Any topological
 * sort on either side of the trip would quietly rewrite this into dependency
 * order — exactly the normalization FR-049 forbids.
 */
const AUTHORED_NODES = [
  { nodeId: 'build', pipelineId: 'build-it' },
  { nodeId: 'design', pipelineId: 'design-review' }
] as const;

/** Also non-alphabetical by source port, for the same reason. */
const AUTHORED_CONNECTIONS = [
  { from: { nodeId: 'design', portId: 'summary' }, to: { nodeId: 'build', portId: 'context' } },
  { from: { nodeId: 'design', portId: 'notes' }, to: { nodeId: 'build', portId: 'brief' } }
] as const;

/**
 * Keys outside the recognized set. They round-trip verbatim and are never
 * interpreted (FR-007). No recognized key appears here, so the re-emission order
 * in `persistedRow` is what keeps one from being shadowed.
 */
const UNRECOGNIZED_FIELDS = {
  authoredBy: 'operator-notes',
  layoutHints: { design: { x: 10, y: 20 }, build: { x: 10, y: 120 } }
} as const;

function authoredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...UNRECOGNIZED_FIELDS,
    id: WORKFLOW_ID,
    name: 'Design then Build',
    description: 'Review the design, then build it.',
    version: 1,
    nodes: AUTHORED_NODES.map((node) => ({ ...node })),
    connections: AUTHORED_CONNECTIONS.map((edge) => ({
      from: { ...edge.from },
      to: { ...edge.to }
    })),
    startNodeIds: ['design'],
    ...overrides
  };
}

const nodeOrder = (nodes: readonly { nodeId: string; pipelineId: string }[]): string[] =>
  nodes.map((node) => `${node.nodeId}:${node.pipelineId}`);

const edgeOrder = (
  connections: readonly {
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
  }[]
): string[] =>
  connections.map(
    (edge) => `${edge.from.nodeId}.${edge.from.portId}->${edge.to.nodeId}.${edge.to.portId}`
  );

const AUTHORED_NODE_ORDER = nodeOrder(AUTHORED_NODES);
const AUTHORED_EDGE_ORDER = edgeOrder(AUTHORED_CONNECTIONS);

interface WriteCall {
  readonly key: string;
  readonly value: unknown;
  readonly scope: string | undefined;
}

interface SaveOutcome {
  readonly ack: CommandAckMessage;
  readonly persisted: readonly unknown[];
  readonly writes: readonly WriteCall[];
  /** The lower-precedence layer, so a rejection can be shown to leave it alone. */
  readonly userLayer: readonly unknown[];
  /**
   * The dependency object the handler actually ran against, so a caller can ask
   * what it did *not* touch. Used by the US6 block to show that no seam capable
   * of starting work was reached (FR-038).
   */
  readonly deps: Record<string, unknown>;
}

interface SaveOptions {
  readonly user?: readonly unknown[];
  /**
   * Overrides the revision the window echoes. A second window that read the
   * layer before someone else wrote it sends the revision it saw, not the one
   * the host now holds (FR-028).
   */
  readonly expectedRevision?: string;
  /**
   * Extra dependencies merged into the handler's `deps`. The US6 block supplies
   * spies for the run-, queue-, and phase-control seams the router can carry so
   * their call counts are observable; no other caller passes any, so the base
   * dependency set is unchanged for every test above.
   */
  readonly extraDeps?: Record<string, unknown>;
}

/** Runs the real save handler against an in-memory `workspace` layer. */
async function save(
  currentLayer: readonly unknown[],
  mutation: WorkflowCatalogMutation,
  rows: readonly unknown[],
  options: SaveOptions = {}
): Promise<SaveOutcome> {
  const acks: CommandAckMessage[] = [];
  const writes: WriteCall[] = [];
  const userLayer = options.user ?? [];
  let persisted: readonly unknown[] = currentLayer;
  const deps: Record<string, unknown> = {
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
    readWorkflowConfig: () => ({ user: userLayer, workspace: currentLayer }),
    // Gates 5-7 resolve every `pipelineId` against the EFFECTIVE Pipeline
    // catalog, which is itself resolved against the effective Phase catalog,
    // so both fixture layers have to be supplied — and they have to describe
    // the same catalog `reload()` builds below.
    readPipelineConfig: () => ({ user: [], workspace: [DESIGN_PIPELINE, BUILD_PIPELINE] }),
    readPhaseConfig: () => ({ user: [], workspace: AUTHORED_PHASE_ROWS }),
    ...(options.extraDeps ?? {})
  };
  const ctx = {
    deps,
    postAck: async (message: CommandAckMessage) => {
      acks.push(message);
      return true;
    },
    correlationId: 'test-correlation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const command: SaveWorkflowsCommand = {
    type: CMD_SAVE_WORKFLOWS,
    correlationId: 'test-correlation-1',
    payload: {
      scope: 'workspace',
      expectedRevision: options.expectedRevision ?? workflowLayerRevision(currentLayer),
      mutation,
      workflows: rows
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  await saveWorkflowsHandler(ctx, command);
  return { ack: acks[0], persisted, writes, userLayer, deps };
}

/** The same effective Pipeline catalog the save side resolves, for the reload. */
const PIPELINE_CATALOG = resolvePipelineCatalog({
  builtIn: BUILT_IN_PIPELINES,
  user: [],
  workspace: [DESIGN_PIPELINE, BUILD_PIPELINE],
  phaseCatalog: resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: [],
    workspace: AUTHORED_PHASE_ROWS
  }).effective
});

/** Reloads a persisted layer exactly as the host does on the next projection. */
function reload(workspace: readonly unknown[]): WorkflowDefinition {
  const catalog = resolveWorkflowCatalog({
    builtIn: [],
    user: [],
    workspace,
    pipelineCatalog: PIPELINE_CATALOG
  });
  const definition = catalog.effective.find((candidate) => candidate.workflowId === WORKFLOW_ID);
  expect(definition, 'the saved Workflow must resolve as effective on reload').toBeDefined();
  return definition as WorkflowDefinition;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
});

describe('Workflow catalog management — graph round trip (US1, T036)', () => {
  it('reloads node ids, connection endpoints, and allowed starts unchanged', async () => {
    const { ack, persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      authoredRow()
    ]);

    expect(ack.status).toBe('accepted');
    const definition = reload(persisted);
    expect(nodeOrder(definition.nodes)).toEqual(AUTHORED_NODE_ORDER);
    expect(edgeOrder(definition.connections)).toEqual(AUTHORED_EDGE_ORDER);
    expect(definition.startNodeIds).toEqual(['design']);
  });

  it('preserves authored node and connection order on both sides of the trip (FR-049)', async () => {
    const { persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      authoredRow()
    ]);

    // The written row is already in authored order — the save side does not sort.
    const stored = persisted[0] as {
      nodes: readonly { nodeId: string; pipelineId: string }[];
      connections: readonly {
        from: { nodeId: string; portId: string };
        to: { nodeId: string; portId: string };
      }[];
    };
    expect(nodeOrder(stored.nodes)).toEqual(AUTHORED_NODE_ORDER);
    expect(edgeOrder(stored.connections)).toEqual(AUTHORED_EDGE_ORDER);
    // Guards on the fixture itself, so the two assertions above stay load-bearing:
    // the authored node order is the reverse of dependency order (`design` feeds
    // `build`), and the authored connection order is not sorted by source port.
    // Either normalization would show up as a changed order.
    expect(AUTHORED_NODE_ORDER[0]).toBe('build:build-it');
    expect(AUTHORED_EDGE_ORDER).not.toEqual([...AUTHORED_EDGE_ORDER].sort());
  });

  it('treats authored order as carrying no execution semantics (SC-013)', async () => {
    const forward = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [authoredRow()]);
    const reversed = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      authoredRow({
        nodes: [...AUTHORED_NODES].reverse().map((node) => ({ ...node })),
        connections: [...AUTHORED_CONNECTIONS].reverse().map((edge) => ({
          from: { ...edge.from },
          to: { ...edge.to }
        }))
      })
    ]);

    expect(forward.ack.status).toBe('accepted');
    expect(reversed.ack.status).toBe('accepted');

    const forwardDefinition = reload(forward.persisted);
    const reversedDefinition = reload(reversed.persisted);
    // The two rows really are ordered differently...
    expect(nodeOrder(reversedDefinition.nodes)).not.toEqual(nodeOrder(forwardDefinition.nodes));
    expect(edgeOrder(reversedDefinition.connections)).not.toEqual(
      edgeOrder(forwardDefinition.connections)
    );

    // ...and the derived contract is identical either way: order is presentation.
    const portKeys = (definition: WorkflowDefinition) => {
      const derived = deriveWorkflowPorts(definition, PIPELINE_CATALOG.effective);
      const key = (port: { nodeId: string; portId: string }): string =>
        `${port.nodeId}.${port.portId}`;
      return {
        inputs: derived.inputs.map(key).sort(),
        outputs: derived.outputs.map(key).sort()
      };
    };
    const forwardPorts = portKeys(forwardDefinition);
    expect(forwardPorts.inputs.length).toBeGreaterThan(0);
    expect(forwardPorts.outputs.length).toBeGreaterThan(0);
    expect(portKeys(reversedDefinition)).toEqual(forwardPorts);
    expect(reversedDefinition.startNodeIds).toEqual(forwardDefinition.startNodeIds);
  });

  it('round-trips unrecognized authored fields without letting one shadow a recognized field (FR-007)', async () => {
    const { persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      authoredRow()
    ]);

    const stored = persisted[0] as Record<string, unknown>;
    expect(stored.authoredBy).toBe(UNRECOGNIZED_FIELDS.authoredBy);
    expect(stored.layoutHints).toEqual(UNRECOGNIZED_FIELDS.layoutHints);
    // Recognized fields are re-emitted after the unrecognized bag, so an
    // authored `nodes` key smuggled in there could never win.
    expect(stored.id).toBe(WORKFLOW_ID);
    expect(nodeOrder(reload(persisted).nodes)).toEqual(AUTHORED_NODE_ORDER);
  });

  it('stores no run identifier, session value, transcript, or workspace path (FR-006)', async () => {
    const { persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      authoredRow()
    ]);

    const serialized = JSON.stringify(persisted);
    const forbidden = ['runId', 'sessionId', 'transcript', 'workspaceRoot', '/tmp/', '/Users/'];
    for (const marker of forbidden) {
      expect(serialized, `the stored Workflow must not carry ${marker}`).not.toContain(marker);
    }
    // The recognized key set is closed: identity, presentation, and graph only.
    expect(Object.keys(persisted[0] as object).sort()).toEqual([
      'authoredBy',
      'connections',
      'description',
      'id',
      'layoutHints',
      'name',
      'nodes',
      'startNodeIds',
      'version'
    ]);
  });

  it('rejects a superseded revision as stale-catalog and leaves both layers untouched (FR-028, SC-005)', async () => {
    const created = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [authoredRow()]);
    expect(created.ack.status).toBe('accepted');

    const otherLayer = [
      {
        id: 'unrelated',
        name: 'Unrelated',
        version: 1,
        nodes: [],
        connections: [],
        startNodeIds: []
      }
    ];
    // A second window echoes the revision it read before the create landed.
    const stale = await save(
      created.persisted,
      { kind: 'edit', workflowId: WORKFLOW_ID },
      [authoredRow({ name: 'Renamed by the stale window' })],
      { user: otherLayer, expectedRevision: workflowLayerRevision([]) }
    );

    expect(stale.ack.status).toBe('rejected');
    expect(stale.ack.reason).toBe('stale-catalog');
    const result = stale.ack.result as {
      currentRevision: string;
      current: {
        scope: string;
        workflowId: string;
        name: string;
        version: number;
        legalActions: readonly string[];
      };
    };
    expect(result.currentRevision).toBe(workflowLayerRevision(created.persisted));
    expect(result.current).toEqual({
      scope: 'workspace',
      workflowId: WORKFLOW_ID,
      name: 'Design then Build',
      version: 1,
      legalActions: ['refresh', 'reapply']
    });

    // No write of any kind: neither the targeted layer nor the other one moved.
    expect(stale.writes).toEqual([]);
    expect(stale.persisted).toEqual(created.persisted);
    expect(stale.userLayer).toEqual(otherLayer);
    expect(reload(stale.persisted).name).toBe('Design then Build');
  });
});

// Feature 083 (US2, T041) — defect accumulation, end to end.
//
// The contract tests assert each shape's own code in isolation. What this file
// adds is the property FR-019 actually names: a graph carrying several
// *independent* defects is refused once, listing all of them, rather than
// forcing the operator through one round trip per defect.
//
// The second half pins the pass's single ordering dependency (research R11) and
// pins it narrowly. A cycle suppresses the FR-023 ancestry check and nothing
// else, so the payload's `ancestryChecksSuppressed` flag has to mean exactly
// that — a broader reading would have the UI tell operators that condition
// checking was skipped while condition defects sit in the same list.
describe('Workflow catalog management — defect accumulation (US2, T041)', () => {
  /** Distinct defects, no two of which share a cause. */
  const MULTI_DEFECT_ROW = {
    id: WORKFLOW_ID,
    name: 'Design then Build',
    version: 1,
    nodes: [
      { nodeId: 'design', pipelineId: 'design-review' },
      { nodeId: 'build', pipelineId: 'build-it' },
      // 1. names a Pipeline the effective catalog does not hold
      { nodeId: 'ghostly', pipelineId: 'no-such-pipeline' },
      // 2. reachable from nothing
      { nodeId: 'orphan', pipelineId: 'build-it' }
    ],
    connections: [
      { from: { nodeId: 'design', portId: 'notes' }, to: { nodeId: 'build', portId: 'brief' } },
      // 3. names a port `design-review` does not declare
      { from: { nodeId: 'design', portId: 'absent' }, to: { nodeId: 'build', portId: 'context' } }
    ],
    startNodeIds: ['design']
  };

  function errorsOf(ack: CommandAckMessage): { field: string; code: string; message: string }[] {
    const result = ack.result as { errors?: { field: string; code: string; message: string }[] };
    return result.errors ?? [];
  }

  it('reports every independent defect in one rejection (FR-019)', async () => {
    const { ack, writes, persisted } = await save(
      [],
      { kind: 'create', workflowId: WORKFLOW_ID },
      [MULTI_DEFECT_ROW]
    );

    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('workflow-validation');
    const codes = errorsOf(ack).map((error) => error.code);
    expect(codes).toContain('unknown-pipeline');
    expect(codes).toContain('unreachable-node');
    expect(codes).toContain('unresolved-endpoint');
    // One pass, not one defect per round trip.
    expect(errorsOf(ack).length).toBeGreaterThanOrEqual(3);
    expect((ack.result as { total: number }).total).toBe(errorsOf(ack).length);
    expect(writes).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('anchors each accumulated defect on its own field so the builder can place them', async () => {
    const { ack } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      MULTI_DEFECT_ROW
    ]);

    const fields = errorsOf(ack).map((error) => error.field);
    // Distinct anchors: a single shared anchor would collapse the list into one
    // marker in the UI no matter how many defects the pass found.
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).toContain('nodes[2].pipelineId');
    expect(fields).toContain('nodes[3].nodeId');
    expect(fields).toContain('connections[1].from');
  });

  /** Cyclic, and carrying one ancestry defect plus one graph-independent one. */
  const CYCLIC_ROW = {
    id: WORKFLOW_ID,
    name: 'Design then Build',
    version: 1,
    nodes: [
      { nodeId: 'design', pipelineId: 'design-review' },
      { nodeId: 'build', pipelineId: 'build-it' }
    ],
    connections: [
      {
        from: { nodeId: 'design', portId: 'notes' },
        to: { nodeId: 'build', portId: 'brief' },
        // Reads a node that has not run when this branch is evaluated. Only
        // computable once the graph is acyclic.
        condition: {
          left: { source: 'node-status', nodeId: 'build' },
          operator: 'equals',
          right: 'succeeded'
        }
      },
      {
        // Closes the cycle.
        from: { nodeId: 'build', portId: 'artifact' },
        to: { nodeId: 'design', portId: 'goal' },
        // Graph-independent: `nowhere` is not a declared node, which is a table
        // lookup rather than an ancestry question. The operand is deliberately
        // well-formed — a bad *operator* would be caught by
        // `validateWorkflowDefinition` first, so the row would never reach graph
        // validation and there would be no cycle to suppress anything.
        condition: {
          left: { source: 'node-status', nodeId: 'nowhere' },
          operator: 'equals',
          right: 'succeeded'
        }
      }
    ],
    startNodeIds: ['design']
  };

  it('states the cycle suppression in the payload rather than leaving it implicit (R11)', async () => {
    const { ack } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [CYCLIC_ROW]);

    expect(ack.status).toBe('rejected');
    const codes = errorsOf(ack).map((error) => error.code);
    expect(codes).toContain('graph-cycle');
    expect(ack.result).toMatchObject({ ancestryChecksSuppressed: true });
    // The ancestry defect is genuinely absent — the flag is not decoration.
    expect(codes).not.toContain('condition-operand-not-ancestor');
  });

  it('suppresses ONLY the ancestry check, not condition validation as a whole', async () => {
    const { ack } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [CYCLIC_ROW]);

    // Resolving an operand against the node table does not depend on the graph,
    // so withholding it would cost the operator a round trip for no reason.
    expect(errorsOf(ack).map((error) => error.code)).toContain('condition-operand-unknown');
  });

  it('surfaces the withheld ancestry defect once the cycle is cut', async () => {
    const { ack } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      {
        ...CYCLIC_ROW,
        connections: [
          // Same forward edge and same forward-looking condition; the back edge
          // is gone and the second condition's operator is now legal.
          CYCLIC_ROW.connections[0],
          {
            from: { nodeId: 'design', portId: 'summary' },
            to: { nodeId: 'build', portId: 'context' }
          }
        ]
      }
    ]);

    expect(ack.status).toBe('rejected');
    const codes = errorsOf(ack).map((error) => error.code);
    expect(codes).toContain('condition-operand-not-ancestor');
    expect(codes).not.toContain('graph-cycle');
    // No cycle, so nothing was withheld and the flag must be absent.
    expect(ack.result).not.toHaveProperty('ancestryChecksSuppressed');
  });

  it('omits the flag entirely for an acyclic rejection', async () => {
    const { ack } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      MULTI_DEFECT_ROW
    ]);
    expect(ack.result).not.toHaveProperty('ancestryChecksSuppressed');
  });
});

// Feature 083 (US4, T047) — deterministic branch ordering.
//
// Evaluation itself belongs to FR-R2-008; what this feature owes it is a stored
// definition from which the documented order is derivable without ambiguity.
// The rule (spec Assumptions): out of one node, ascending `priority`, then
// authored connection order for equal priorities, with the single optional
// default branch considered only after every conditional branch has failed.
//
// So the comparator below is the *specification's* rule expressed once, not
// shipped code — and that is the point. Applying it to the authored array and
// to the reloaded array must give the same answer, which is exactly the claim
// that the round trip preserves everything the rule reads: each connection's
// priority, its default marker, and its authored index.
//
// That the second default on a source node is refused is gate 7's
// `multiple-default-branches` case in tests/contract/save-workflows-scoped.test.ts;
// it is not repeated here.
describe('Workflow catalog management — deterministic branch ordering (US4, T047)', () => {
  const BRANCH_NODES = [
    { nodeId: 'design', pipelineId: 'design-review' },
    { nodeId: 'build', pipelineId: 'build-it' },
    { nodeId: 'audit', pipelineId: 'design-review' },
    { nodeId: 'archive', pipelineId: 'design-review' }
  ] as const;

  /**
   * Four branches out of `design`, authored in an order that agrees with none of
   * the three rule clauses at once:
   *   index 0  priority 20            — ties with index 2, authored first
   *   index 1  priority 10            — lowest priority, so first overall
   *   index 2  priority 20            — ties with index 0, authored later
   *   index 3  priority 1, default    — lowest priority of all, yet last
   * The default carries the *lowest* number deliberately: if defaults were
   * ordered by priority like any other branch it would sort first, so its
   * position at the end is evidence the default clause outranks priority.
   */
  const BRANCH_CONNECTIONS = [
    {
      from: { nodeId: 'design', portId: 'notes' },
      to: { nodeId: 'build', portId: 'brief' },
      priority: 20
    },
    {
      from: { nodeId: 'design', portId: 'summary' },
      to: { nodeId: 'build', portId: 'context' },
      priority: 10
    },
    {
      from: { nodeId: 'design', portId: 'notes' },
      to: { nodeId: 'audit', portId: 'goal' },
      priority: 20
    },
    {
      from: { nodeId: 'design', portId: 'summary' },
      to: { nodeId: 'archive', portId: 'goal' },
      priority: 1,
      isDefault: true
    }
  ] as const;

  const AUTHORED_BRANCH_ORDER = edgeOrder(BRANCH_CONNECTIONS);
  /** By the rule: 1 (p10), then 0 and 2 tied at p20 in authored order, then the default. */
  const EXPECTED_EVALUATION_ORDER = [1, 0, 2, 3];

  function branchingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: WORKFLOW_ID,
      name: 'Design then Branch',
      version: 1,
      nodes: BRANCH_NODES.map((node) => ({ ...node })),
      connections: BRANCH_CONNECTIONS.map((edge) => ({
        ...edge,
        from: { ...edge.from },
        to: { ...edge.to }
      })),
      startNodeIds: ['design'],
      ...overrides
    };
  }

  interface Branch {
    readonly priority?: number;
    readonly isDefault?: boolean;
  }

  /** The spec's rule, expressed once. Returns authored indices in evaluation order. */
  function evaluationOrder(connections: readonly Branch[]): number[] {
    return connections
      .map((connection, index) => ({ connection, index }))
      .sort((left, right) => {
        const leftDefault = left.connection.isDefault === true ? 1 : 0;
        const rightDefault = right.connection.isDefault === true ? 1 : 0;
        if (leftDefault !== rightDefault) return leftDefault - rightDefault;
        // Every branch in this fixture declares a priority. What a missing one
        // means is FR-R2-008's to define, and is deliberately not invented here.
        const leftPriority = left.connection.priority as number;
        const rightPriority = right.connection.priority as number;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return left.index - right.index;
      })
      .map((entry) => entry.index);
  }

  async function saveAndReload(): Promise<WorkflowDefinition> {
    const { ack, persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      branchingRow()
    ]);
    expect(ack.status).toBe('accepted');
    return reload(persisted);
  }

  it('keeps the authored connection order across the round trip', async () => {
    const definition = await saveAndReload();

    // Neither side may reorder into evaluation order. Storing the branches
    // pre-sorted would destroy the authored index the tie-break depends on.
    expect(edgeOrder(definition.connections)).toEqual(AUTHORED_BRANCH_ORDER);
  });

  it('preserves every branch priority and the default marker verbatim', async () => {
    const definition = await saveAndReload();

    expect(definition.connections.map((connection) => connection.priority)).toEqual([
      20, 10, 20, 1
    ]);
    expect(definition.connections.map((connection) => connection.isDefault === true)).toEqual([
      false,
      false,
      false,
      true
    ]);
  });

  it('derives the documented evaluation order from the reloaded definition', async () => {
    const definition = await saveAndReload();

    expect(evaluationOrder(definition.connections)).toEqual(EXPECTED_EVALUATION_ORDER);
  });

  it('derives the same order before and after the round trip', async () => {
    const definition = await saveAndReload();

    // The equality is the real assertion: persistence loses nothing the rule
    // reads. The literal above only pins what that shared answer is.
    expect(evaluationOrder(definition.connections)).toEqual(evaluationOrder(BRANCH_CONNECTIONS));
  });

  it('breaks the equal-priority tie by authored order, not by target or port name', async () => {
    const definition = await saveAndReload();
    const order = evaluationOrder(definition.connections);

    // Indices 0 and 2 both sit at priority 20. Sorting by anything the graph
    // also offers — target node id, source port id — would put `audit` before
    // `build`, so this pins the tie-break to authored position specifically.
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(2));
  });

  it('orders the default branch last despite carrying the lowest priority', async () => {
    const definition = await saveAndReload();

    expect(evaluationOrder(definition.connections).at(-1)).toBe(3);
  });

  it('does not invent a priority or a default marker for a branch that declares neither', async () => {
    // Materializing `priority: 0` or `isDefault: false` on save would silently
    // give an unmarked branch a position under any consumer applying the rule.
    const { ack, persisted } = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [
      branchingRow({
        connections: [
          { from: { nodeId: 'design', portId: 'notes' }, to: { nodeId: 'build', portId: 'brief' } },
          {
            from: { nodeId: 'design', portId: 'summary' },
            to: { nodeId: 'build', portId: 'context' }
          }
        ],
        nodes: [BRANCH_NODES[0], BRANCH_NODES[1]].map((node) => ({ ...node }))
      })
    ]);

    expect(ack.status).toBe('accepted');
    const stored = (persisted[0] as { connections: readonly Record<string, unknown>[] }).connections;
    for (const connection of stored) {
      expect(Object.keys(connection)).not.toContain('priority');
      expect(Object.keys(connection)).not.toContain('isDefault');
    }
    const definition = reload(persisted);
    expect(definition.connections.every((connection) => connection.priority === undefined)).toBe(
      true
    );
    expect(definition.connections.every((connection) => connection.isDefault === undefined)).toBe(
      true
    );
  });
});

// Feature 083 (US6, T053) — Pipeline independence, in both directions.
//
// FR-037 and FR-038 are prohibitions, and prohibitions are the requirements that
// decay silently: nothing in the save path implements either one today, so both
// hold by construction and no unit test would notice the day something starts
// implementing them. These assertions are the tripwire, placed at the two
// boundaries an operator actually reads — the runtime selection list the
// dashboard renders from, and the persisted run and queue state.
//
// They are not vacuous. The reference is registered through the same
// concatenated hook `extension.ts` installs (T051), so the Library projection
// really does report the consuming Workflow on the very record whose runtime
// entry is asserted byte-identical to a host that holds no Workflow at all.
describe('Workflow catalog management — Pipeline independence (US6, T053)', () => {
  /** Counts writes so "zero queue entries, zero runs" can be shown, not inferred. */
  class CountingMemento implements Memento {
    private readonly map = new Map<string, unknown>();
    public writes = 0;
    get<T>(key: string): T | undefined {
      return this.map.get(key) as T | undefined;
    }
    update(key: string, value: unknown): Thenable<void> {
      this.writes += 1;
      if (value === undefined) this.map.delete(key);
      else this.map.set(key, value);
      return Promise.resolve();
    }
  }

  /** The Pipeline and Phase layers every host in this block reads. */
  const CATALOG_READER: CatalogConfigReader = {
    getPhases: (scope) => (scope === 'workspace' ? AUTHORED_PHASE_ROWS : []),
    getPipelines: (scope) => (scope === 'workspace' ? [DESIGN_PIPELINE, BUILD_PIPELINE] : []),
    getModels: () => [],
    getDefaultPipelineId: () => undefined
  };

  const REFERENCED_PIPELINE_IDS = [DESIGN_PIPELINE.id, BUILD_PIPELINE.id] as const;

  interface Host {
    readonly store: WorkspaceStateStore;
    readonly queue: QueueManager;
    readonly memento: CountingMemento;
    readonly snapshot: () => WorkflowSnapshot;
  }

  const projectors: StateProjector[] = [];

  /**
   * The host as `extension.ts` assembles it for this question: one runtime
   * catalog behind `availablePipelines`, one resolved Pipeline catalog behind
   * the Library, and the single concatenated reference list (T051) feeding the
   * Library projection — the same list gate 13 blocks removals against.
   */
  async function host(workflowRows: readonly unknown[]): Promise<Host> {
    const memento = new CountingMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const runtime = loadCatalog(CATALOG_READER);
    const workflowCatalog = resolveWorkflowCatalog({
      builtIn: [],
      user: [],
      workspace: workflowRows,
      pipelineCatalog: PIPELINE_CATALOG
    });
    const projector = new StateProjector({
      store,
      ownerId: 'this-window',
      getCatalog: () => runtime.catalog,
      getPipelineCatalog: () => runtime.pipelineCatalog,
      getWorkflowCatalog: () => workflowCatalog,
      getWorkflowPipelineRefs: () => [
        ...collectWorkflowPipelineRefs(queue.list()),
        ...collectWorkflowDefinitionPipelineRefs(workflowCatalog.records)
      ]
    });
    projectors.push(projector);
    return { store, queue, memento, snapshot: () => projector.project() };
  }

  afterEach(() => {
    for (const projector of projectors.splice(0)) projector.dispose();
  });

  const pipelineIds = (snapshot: WorkflowSnapshot): string[] =>
    snapshot.availablePipelines.map((pipeline) => pipeline.id);

  const recordFor = (snapshot: WorkflowSnapshot, pipelineId: string) =>
    snapshot.pipelineCatalog?.records.find(
      (record) => record.pipelineId === pipelineId && record.scope === 'workspace'
    );

  // ── FR-037 / SC-006 — the reference changes nothing about the Pipeline ──────

  it('keeps every referenced Pipeline in availablePipelines (FR-037, SC-006)', async () => {
    const referencing = await host([authoredRow()]);

    const ids = pipelineIds(referencing.snapshot());
    for (const pipelineId of REFERENCED_PIPELINE_IDS) {
      expect(ids, `${pipelineId} must stay in the runtime selection list`).toContain(pipelineId);
    }
  });

  it('leaves the runtime selection list identical to a host with no Workflow at all', async () => {
    const referencing = await host([authoredRow()]);
    const bare = await host([]);

    // Deep equality, not just membership: an entry that survived but arrived
    // annotated, reordered, or stripped of ports would still be "present".
    expect(referencing.snapshot().availablePipelines).toEqual(bare.snapshot().availablePipelines);
    expect(referencing.snapshot().pipelineCatalog?.effective).toEqual(
      bare.snapshot().pipelineCatalog?.effective
    );
  });

  it('registers the reference on the Library record, so the equality above is not vacuous', async () => {
    const referencing = await host([authoredRow()]);
    const bare = await host([]);

    for (const pipelineId of REFERENCED_PIPELINE_IDS) {
      expect(recordFor(referencing.snapshot(), pipelineId)?.consumingWorkflowIds).toEqual([
        WORKFLOW_ID
      ]);
      // Without the Workflow the same record carries no consumer at all — the
      // two hosts really do differ, and they differ only in this field.
      expect(recordFor(bare.snapshot(), pipelineId)).not.toHaveProperty('consumingWorkflowIds');
    }
  });

  it('changes nothing else on the Library record it annotates', async () => {
    const referencing = await host([authoredRow()]);
    const bare = await host([]);

    for (const pipelineId of REFERENCED_PIPELINE_IDS) {
      const annotated = { ...(recordFor(referencing.snapshot(), pipelineId) as object) } as Record<
        string,
        unknown
      >;
      delete annotated.consumingWorkflowIds;
      expect(annotated).toEqual(recordFor(bare.snapshot(), pipelineId));
    }
  });

  it('keeps a referenced Pipeline independently runnable (SC-006)', async () => {
    const referencing = await host([authoredRow()]);

    const request = await referencing.queue.enqueue('Run the design review on its own', {
      pipelineId: DESIGN_PIPELINE.id
    });

    // Selectable: the id the request pins is one the runtime catalog resolves,
    // which is exactly the check the host applies before dispatching it.
    expect(request.pipelineId).toBe(DESIGN_PIPELINE.id);
    expect(request.status).toBe('pending');
    expect(pipelineIds(referencing.snapshot())).toContain(DESIGN_PIPELINE.id);
    // Running one node's Pipeline directly is not running the Workflow: the
    // request stands alone, with no Workflow identity attached to it.
    expect(referencing.queue.list()).toHaveLength(1);
    // Feature 092 — "no Run started" is now read per queue: no runtime owns one.
    expect(
      referencing.snapshot().queues.every((runtime) => runtime.inFlightRun === null)
    ).toBe(true);
  });

  // ── FR-038 / SC-007 — no Workflow operation starts work ────────────────────

  /** Every router seam a save could conceivably reach to start something. */
  function workStartingSeams() {
    return {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      queueOps: {
        retry: vi.fn(),
        moveUp: vi.fn(),
        moveDown: vi.fn(),
        clearCompleted: vi.fn(),
        clearFailed: vi.fn(),
        setQueuePausedState: vi.fn()
      },
      phaseOps: { skipPhase: vi.fn(), disablePhase: vi.fn(), enablePhase: vi.fn() }
    };
  }

  function expectNoSeamReached(deps: Record<string, unknown>): void {
    const spies: unknown[] = [deps.executeCommand];
    for (const group of ['queueRemover', 'queueOps', 'phaseOps']) {
      spies.push(...Object.values(deps[group] as Record<string, unknown>));
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  }

  /** A row that fails validation, so the "validate" operation is a real rejection. */
  const INVALID_ROW = authoredRow({
    nodes: [{ nodeId: 'design', pipelineId: 'no-such-pipeline' }],
    connections: [],
    startNodeIds: ['design']
  });

  // The proof that a Workflow operation starts nothing is exhaustive rather
  // than circumstantial, because the handler has exactly two ways to affect
  // anything outside itself and both are observed here:
  //
  //   * `updateConfig` — asserted to receive the `workflows` key and nothing
  //     else, so no other layer and no state key was written;
  //   * the router dependencies — every seam that can start, resume, retry, or
  //     re-order work, asserted uncalled.
  //
  // A run or a session can only come into being through one of those two, so
  // "zero runs, zero queue entries, zero sessions" follows from them. The
  // ambient host state is checked separately below as corroboration; on its own
  // it would prove little, since the handler holds no reference to that store.
  it('writes only the Workflow layer and reaches no work-starting seam, on create, edit, and validate (FR-038, SC-007)', async () => {
    const onCreate = workStartingSeams();
    const created = await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [authoredRow()], {
      extraDeps: onCreate
    });
    expect(created.ack.status).toBe('accepted');
    expect(created.writes.map((write) => write.key)).toEqual(['workflows']);
    expectNoSeamReached(created.deps);

    const onEdit = workStartingSeams();
    const edited = await save(
      created.persisted,
      { kind: 'edit', workflowId: WORKFLOW_ID },
      [authoredRow({ name: 'Design then Build, revised' })],
      { extraDeps: onEdit }
    );
    expect(edited.ack.status).toBe('accepted');
    expect(edited.writes.map((write) => write.key)).toEqual(['workflows']);
    expectNoSeamReached(edited.deps);

    // "Validating" has no command of its own — a save carries the graph through
    // the same validation pass and reports the defects, so a refused save *is*
    // the validate path, and it must be as inert as the two accepted ones. More
    // so, in fact: it may not even write the layer.
    const onValidate = workStartingSeams();
    const validated = await save(
      edited.persisted,
      { kind: 'edit', workflowId: WORKFLOW_ID },
      [INVALID_ROW],
      { extraDeps: onValidate }
    );
    expect(validated.ack.status).toBe('rejected');
    expect(validated.ack.reason).toBe('workflow-validation');
    expect(validated.writes).toEqual([]);
    expectNoSeamReached(validated.deps);
  });

  it('leaves run, queue, and session state exactly as it found them (SC-007)', async () => {
    const observer = await host([]);
    const baselineWrites = observer.memento.writes;

    await save([], { kind: 'create', workflowId: WORKFLOW_ID }, [authoredRow()]);
    await save([authoredRow()], { kind: 'edit', workflowId: WORKFLOW_ID }, [
      authoredRow({ name: 'Design then Build, revised' })
    ]);
    await save([authoredRow()], { kind: 'edit', workflowId: WORKFLOW_ID }, [INVALID_ROW]);

    expect(observer.store.getRun()).toBeNull();
    expect(observer.queue.list()).toEqual([]);
    const snapshot = observer.snapshot();
    // Feature 092 — the run singulars moved under the queue that owns the Run,
    // so an untouched default queue is the shape "nothing started" now takes.
    expect(findQueueRuntime(snapshot, DEFAULT_QUEUE_ID)?.inFlightRun ?? null).toBeNull();
    expect(snapshot.queue.inFlight).toBeNull();
    expect(snapshot.queue.pending).toEqual([]);
    // A CLI session id is only ever recorded on a run, and every memento key the
    // host owns — run, queue, lock, history — is behind this one counter. It has
    // not moved since `initialize()`, so nothing was minted or persisted.
    expect(observer.memento.writes).toBe(baselineWrites);
  });
});
