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
// with the authoritative record and legal actions while nothing at all is
// written (FR-028, SC-005).
//
// Feature 099 (T496f, FR-042/FR-042a) — the save port is the versioned catalog
// store, not `updateConfig(key, rows, scope)`, and there is one layer rather than
// three. Two harness facts follow. The write recorder is the store's `layerSaves`
// list, so "wrote nothing" is an empty list of layer saves. And the old
// "the lower-precedence layer stayed untouched" claim, which had no second layer
// left to make, is carried by the two catalogs of the OTHER kinds: a Workflow save
// that wrote a Phase or Pipeline record would fail exactly where the shadowed-layer
// assertion used to fail.
//
// Feature 100 (T514, FR-013, FR-016) — the round trip gains a step. A save writes
// a Draft and nothing more; a Draft becomes effective only when it is published,
// so every claim in this file about "what the host wrote" is now a claim about two
// writes, and `commit()` below is that pair.
//
// The consequence worth stating up front is where validation moved. A save never
// validates: an operator's half-finished graph is theirs to keep, and refusing to
// store it is what made the old surface lose work. The defects surface at the
// publication instead, which turns each rejection in this file from "nothing was
// written" into the sharper claim that the *Draft* was written and the *effective
// catalog* was not — the last good graph is still the one running.
//
// The write recorder follows the port: `writesOf(store)` counts all three write
// ports, and `lifecycleWrites` names each instruction's operation and kind, so
// "wrote only the catalog it named" is now readable off the write itself rather
// than inferred from the absence of a second layer save.

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
import { FIXTURE_REVISION, snapshotOf } from '../fixtures/catalog-snapshot-fixture';
import {
  FakeCatalogStore,
  NO_WRITES,
  tokenFor,
  writesOf
} from '../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../fixtures/fake-catalog-lifecycle';
import { SPECKIT_PHASE_DEFS } from '../fixtures/speckit-catalog-fixture';
import { NO_DRAFT } from '../../src/contracts/catalog-lifecycle';
import type { CatalogConfigReader } from '../../src/config/pipeline-config-loader';
import { loadCatalog } from '../../src/config/pipeline-config-loader';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { deriveWorkflowPorts } from '../../src/config/workflow-derived-ports';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_PUBLISH_DEFINITION,
  CMD_SAVE_DEFINITION_DRAFT,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { findQueueRuntime, type WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { collectWorkflowDefinitionPipelineRefs } from '../../src/ui/sidebar/workflow-definition-pipeline-refs';
import { collectWorkflowPipelineRefs } from '../../src/ui/sidebar/workflow-pipeline-refs';

const WORKFLOW_ID = 'design-then-build';

/**
 * The Phase rows the two Pipelines below reference.
 *
 * Feature 098 (T080) — `done` is the one this file authors; `speckit-specify` and
 * `finalize` used to resolve out of the built-in Phase layer, which is empty now.
 * Without them here the Pipelines quarantine as `unknown-phase` and every gate
 * below reports `pipeline-invalid` instead of the defect it is about. See the
 * fixture header for why the ids are the real Spec Kit ones.
 */
const AUTHORED_PHASE_ROWS: readonly unknown[] = [
  { id: 'done', name: 'Done', version: 1, instruction: 'Done.' },
  ...SPECKIT_PHASE_DEFS
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

/** The Pipeline rows every host in this file reads, store-side and reload-side. */
const AUTHORED_PIPELINE_ROWS: readonly unknown[] = [DESIGN_PIPELINE, BUILD_PIPELINE];

interface CommitOutcome {
  /**
   * The draft save's ack. Feature 100 (FR-013) — its own step, and it is the one
   * that must be `accepted` even when the graph is defective: an operator's
   * half-finished work is stored, and only its *publication* is judged.
   */
  readonly saved: CommandAckMessage;
  /**
   * The publication's ack, or the save's when the save itself was refused. This
   * is the ack every claim about a verdict reads, because the verdict moved here.
   */
  readonly ack: CommandAckMessage;
  readonly persisted: readonly unknown[];
  /**
   * The lifecycle operations the store actually applied, in order. Feature 100
   * (T514) — the successor of the `layerSaves` write recorder: a save and a
   * publication are two instructions now, so `['save-draft']` is the shape of
   * "the draft landed and the publication did not".
   */
  readonly ops: readonly string[];
  /**
   * The store the router ran against. Replaces `userLayer`, which named the
   * lower-precedence layer a rejection had to leave alone; one catalog has no
   * such layer, so what a rejection must leave alone is the Phase and Pipeline
   * catalogs this exposes.
   */
  readonly store: FakeCatalogStore;
  /**
   * The dependency object the router actually ran against, so a caller can ask
   * what it did *not* touch. Used by the US6 block to show that no seam capable
   * of starting work was reached (FR-038).
   */
  readonly deps: Record<string, unknown>;
}

interface CommitOptions {
  /**
   * Overrides the draft token the window echoes. Feature 100 (FR-012) —
   * staleness is per definition and per pointer now, not a catalog-wide revision:
   * a second window sends the draft version it read, and loses when a write has
   * moved that pointer since.
   */
  readonly expectedDraftVersion?: string;
  /**
   * Extra dependencies merged into the router's `deps`. The US6 block supplies
   * spies for the run-, queue-, and phase-control seams the router can carry so
   * their call counts are observable; no other caller passes any, so the base
   * dependency set is unchanged for every test above.
   */
  readonly extraDeps?: Record<string, unknown>;
}

let dispatched = 0;

/**
 * Dispatches one command, with a correlation id no other dispatch shares.
 *
 * The router caches every mutation ack by correlation id and replays it for an
 * hour, so a test that reused one would get the *first* dispatch's ack back
 * without the second ever reaching a handler. The whole-array save needed one
 * write per test and never noticed; a commit is two dispatches.
 */
async function dispatch(
  router: MessageRouter,
  type: string,
  payload: Record<string, unknown>
): Promise<CommandAckMessage> {
  dispatched += 1;
  const acks: CommandAckMessage[] = [];
  await router.dispatch(
    { type, correlationId: `${type}-${dispatched}`, payload } as unknown as SidebarCommand,
    async (message) => {
      acks.push(message);
      return true;
    }
  );
  const ack = acks[0];
  expect(ack, 'the router must ack every lifecycle command').toBeDefined();
  return ack;
}

/**
 * Authors one Workflow row and makes it effective — the two writes one save was.
 *
 * `currentRows` seeds the Workflow catalog as already-active rows, the same thing
 * the old `currentLayer` argument named. Everything the router needs arrives
 * through the store: the Workflow catalog the operation is about, and the
 * Pipeline and Phase catalogs the publish gate resolves every `pipelineId`
 * against. Seeding all three from one double is what lets a rejection be shown to
 * leave the other two byte-identical.
 */
async function commit(
  currentRows: readonly unknown[],
  row: Record<string, unknown>,
  options: CommitOptions = {}
): Promise<CommitOutcome> {
  const store = new FakeCatalogStore({
    phases: AUTHORED_PHASE_ROWS,
    pipelines: AUTHORED_PIPELINE_ROWS,
    workflows: currentRows
  });
  const deps: Record<string, unknown> = {
    executeCommand: vi.fn(),
    queueRemover: { remove: vi.fn() },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: new SanitizedLogger(),
    audit: { append: vi.fn().mockResolvedValue(undefined) },
    catalogStore: store,
    catalogLifecycle: fakeCatalogLifecycle(store),
    refreshCatalog: vi.fn(async () => undefined),
    ...(options.extraDeps ?? {})
  };
  const router = new MessageRouter(deps as unknown as RouterDeps);
  const id = String(row.id);
  const target = {
    kind: 'workflow',
    id,
    expectedDraftVersion: options.expectedDraftVersion ?? tokenFor(store, 'workflow', id)
  };

  const saved = await dispatch(router, CMD_SAVE_DEFINITION_DRAFT, { ...target, body: row });
  // A refused save has no draft to publish, so the second dispatch would only
  // report `no-draft` and hide what actually went wrong. The save's own ack is
  // the verdict in that case.
  const ack =
    saved.status === 'accepted'
      ? await dispatch(router, CMD_PUBLISH_DEFINITION, {
          ...target,
          expectedDraftVersion: tokenFor(store, 'workflow', id)
        })
      : saved;

  return {
    saved,
    ack,
    persisted: store.rowsOf('workflow'),
    ops: store.lifecycleWrites.map((write) => write.op),
    store,
    deps
  };
}

/** The same effective Pipeline catalog the save side resolves, for the reload. */
const PIPELINE_CATALOG = resolvePipelineCatalog({
  rows: AUTHORED_PIPELINE_ROWS,
  revision: FIXTURE_REVISION,
  phaseCatalog: resolvePhaseCatalog({
    rows: AUTHORED_PHASE_ROWS,
    revision: FIXTURE_REVISION
  }).effective
});

/** Reloads a persisted catalog exactly as the host does on the next projection. */
function reload(stored: readonly unknown[]): WorkflowDefinition {
  const catalog = resolveWorkflowCatalog({
    rows: stored,
    revision: FIXTURE_REVISION,
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
    const { ack, persisted } = await commit([], authoredRow());

    expect(ack.status).toBe('accepted');
    const definition = reload(persisted);
    expect(nodeOrder(definition.nodes)).toEqual(AUTHORED_NODE_ORDER);
    expect(edgeOrder(definition.connections)).toEqual(AUTHORED_EDGE_ORDER);
    expect(definition.startNodeIds).toEqual(['design']);
  });

  it('preserves authored node and connection order on both sides of the trip (FR-049)', async () => {
    const { persisted } = await commit([], authoredRow());

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
    const forward = await commit([], authoredRow());
    const reversed = await commit(
      [],
      authoredRow({
        nodes: [...AUTHORED_NODES].reverse().map((node) => ({ ...node })),
        connections: [...AUTHORED_CONNECTIONS].reverse().map((edge) => ({
          from: { ...edge.from },
          to: { ...edge.to }
        }))
      })
    );

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
    const { persisted } = await commit([], authoredRow());

    const stored = persisted[0] as Record<string, unknown>;
    expect(stored.authoredBy).toBe(UNRECOGNIZED_FIELDS.authoredBy);
    expect(stored.layoutHints).toEqual(UNRECOGNIZED_FIELDS.layoutHints);
    // Feature 100 (FR-007a) — a stronger reading of the same requirement. The
    // store keeps the authored body verbatim rather than re-emitting recognized
    // keys over an unrecognized bag, so there is no re-emission step in which an
    // authored `nodes` key smuggled into that bag could shadow the real one. What
    // is asserted is the body itself: byte-identical to what was authored, and
    // still resolving to the authored graph.
    expect(stored).toEqual(authoredRow());
    expect(stored.id).toBe(WORKFLOW_ID);
    expect(nodeOrder(reload(persisted).nodes)).toEqual(AUTHORED_NODE_ORDER);
  });

  it('stores no run identifier, session value, transcript, or workspace path (FR-006)', async () => {
    const { persisted } = await commit([], authoredRow());

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

  it('rejects a superseded draft token as stale-catalog and writes nothing at all (FR-028, SC-005)', async () => {
    const created = await commit([], authoredRow());
    expect(created.ack.status).toBe('accepted');

    // Feature 100 (FR-012) — staleness moved from a catalog-wide revision to the
    // definition's own draft pointer, and the two windows now disagree about a
    // *pointer* rather than about a manifest revision. `created.persisted` is
    // seeded as the active row, which is precisely the state after a publication:
    // there is no draft, so the token the host holds is `NO_DRAFT`. The second
    // window still holds `v1` — the draft version it was editing before the first
    // window published it away — and loses by echoing it.
    const stale = await commit(created.persisted, authoredRow({ name: 'Renamed by the stale window' }), {
      expectedDraftVersion: 'v1'
    });

    expect(stale.saved.status).toBe('rejected');
    expect(stale.saved.reason).toBe('stale-catalog');
    // An EXACT shape, and the reasons it is exact have accumulated. `scope` used
    // to be a member of `current` and named the layer the record came from; 099
    // deleted the tier. `currentRevision` was a sibling of `current` and named a
    // catalog-wide revision; 100 replaced it with the per-definition pointers
    // inside the record. A build that still emitted either — under any value —
    // fails here rather than passing with a vestigial field.
    expect(stale.ack.result).toEqual({
      current: {
        kind: 'workflow',
        id: WORKFLOW_ID,
        state: 'active',
        draftVersionId: null,
        activeVersionId: 'v1',
        expectedDraftVersion: NO_DRAFT
      },
      // The record says what may be done from here, so the window can offer it
      // rather than guess. `reapply` is gone with the whole-array save: there is
      // no array to re-send, and the successor of "try again" is a draft save
      // against the token this very record carries.
      legalActions: ['save-draft', 'deactivate', 'restore']
    });

    // No write of any kind. Neither pointer moved, so nothing reached the store's
    // write port, and the two catalogs the publish gate only READS are
    // byte-identical — the successor of "the other layer stayed untouched" now
    // that there is one layer.
    expect(writesOf(stale.store)).toEqual(NO_WRITES);
    expect(stale.persisted).toEqual(created.persisted);
    expect(stale.store.rowsOf('phase')).toEqual(AUTHORED_PHASE_ROWS);
    expect(stale.store.rowsOf('pipeline')).toEqual(AUTHORED_PIPELINE_ROWS);
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
// pins it narrowly: a cycle suppresses the FR-023 ancestry check and nothing
// else. Feature 100 (T514) — that used to be stated by an
// `ancestryChecksSuppressed` flag on the ack, and there is no flag to carry it
// now: the surface it belonged to is retired, and the `validation-failed` payload
// is kind-agnostic (`current`, `legalActions`, `defects`, `total`). So the claim
// is made where it was always strongest, on the defect list itself — the ancestry
// code is provably absent while the cycle and the graph-independent condition
// defect are both present, and it appears the moment the cycle is cut. Whether a
// surface should re-declare the flag is FR-R3-017's question.
//
// Where the refusal lands moved too, and it is the more interesting half. A save
// never validates (FR-013), so each row below is *stored* and only its
// publication is refused. That turns "nothing was written" into two sharper
// claims: `ops` is `['save-draft']`, so the publication really did refuse before
// its write; and the definition is left in `draft`, so the operator's defective
// work is still there to fix rather than discarded on their behalf.
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

  interface Defect {
    readonly kind: string;
    readonly id: string;
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }

  function defectsOf(ack: CommandAckMessage): readonly Defect[] {
    const result = ack.result as { defects?: readonly Defect[] };
    return result.defects ?? [];
  }

  const codesOf = (ack: CommandAckMessage): readonly string[] =>
    defectsOf(ack).map((defect) => defect.code);

  it('reports every independent defect in one rejection (FR-019)', async () => {
    const outcome = await commit([], MULTI_DEFECT_ROW);

    // Stored, then refused. The save is the accepted half deliberately: an
    // operator's defective graph is theirs to keep (FR-013).
    expect(outcome.saved.status).toBe('accepted');
    expect(outcome.ack.status).toBe('rejected');
    expect(outcome.ack.reason).toBe('validation-failed');
    const codes = codesOf(outcome.ack);
    expect(codes).toContain('unknown-pipeline');
    expect(codes).toContain('unreachable-node');
    expect(codes).toContain('unresolved-endpoint');
    // One pass, not one defect per round trip.
    expect(defectsOf(outcome.ack).length).toBeGreaterThanOrEqual(3);
    expect((outcome.ack.result as { total: number }).total).toBe(defectsOf(outcome.ack).length);
    // Every defect names the definition being published, so a package refusal can
    // say which of several bodies each one belongs to.
    for (const defect of defectsOf(outcome.ack)) {
      expect({ kind: defect.kind, id: defect.id }).toEqual({ kind: 'workflow', id: WORKFLOW_ID });
    }

    // The draft write landed and the publication's did not, which is what makes
    // "refused before writing" a claim about this operation rather than about the
    // catalog happening to be empty.
    expect(outcome.ops).toEqual(['save-draft']);
    expect(outcome.persisted).toEqual([]);
    // ...and the defective body is still there. FR-013's point: the operator has
    // something to come back and fix.
    expect(outcome.store.stateOf('workflow', WORKFLOW_ID)).toBe('draft');
    expect(outcome.store.draftRowsOf('workflow')).toEqual([MULTI_DEFECT_ROW]);
  });

  it('anchors each accumulated defect on its own field so the builder can place them', async () => {
    const { ack } = await commit([], MULTI_DEFECT_ROW);

    const fields = defectsOf(ack).map((defect) => defect.field);
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
          right: 'completed'
        }
      },
      {
        // Closes the cycle.
        from: { nodeId: 'build', portId: 'artifact' },
        to: { nodeId: 'design', portId: 'goal' },
        // Graph-independent: `nowhere` is not a declared node, which is a table
        // lookup rather than an ancestry question.
        condition: {
          left: { source: 'node-status', nodeId: 'nowhere' },
          operator: 'equals',
          right: 'completed'
        }
      }
    ],
    // Both right operands are a real terminal status. Feature 100 (T514) — this
    // used to read `succeeded`, which is not one, and the row therefore carried a
    // silent third defect (`condition-right-invalid`) that no assertion here named:
    // the claims were `toContain`, so an extra code was invisible. The exact sets
    // below are what make the R11 claim airtight, and they only isolate it if
    // every OTHER defect in the row is deliberate.
    startNodeIds: ['design']
  };

  it('suppresses ONLY the ancestry check when the graph is cyclic (R11)', async () => {
    const outcome = await commit([], CYCLIC_ROW);

    expect(outcome.ack.status).toBe('rejected');
    // An EXACT set, which is the whole of the R11 claim in one assertion. The
    // cycle is reported; the graph-INDEPENDENT condition defect is reported too,
    // because resolving an operand against the node table does not depend on the
    // graph and withholding it would cost the operator a round trip for no reason;
    // and `condition-operand-not-ancestor` — the one check a cycle really does
    // make uncomputable — is absent. A build that suppressed condition validation
    // as a whole, or that reported an ancestry verdict it could not compute, fails
    // here.
    expect([...new Set(codesOf(outcome.ack))].sort()).toEqual([
      'condition-operand-unknown',
      'graph-cycle'
    ]);
  });

  it('surfaces the withheld ancestry defect once the cycle is cut', async () => {
    const outcome = await commit([], {
      ...CYCLIC_ROW,
      connections: [
        // Same forward edge and same forward-looking condition; the back edge is
        // gone and the second condition's operand is now a declared node.
        CYCLIC_ROW.connections[0],
        {
          from: { nodeId: 'design', portId: 'summary' },
          to: { nodeId: 'build', portId: 'context' }
        }
      ]
    });

    expect(outcome.ack.status).toBe('rejected');
    // Exact again, and the mirror image: no cycle, so the ancestry check ran and
    // found the very defect the cyclic graph withheld.
    expect([...new Set(codesOf(outcome.ack))].sort()).toEqual(['condition-operand-not-ancestor']);
  });

  it('reports a validation refusal as a closed payload with no vestigial members', async () => {
    const outcome = await commit([], MULTI_DEFECT_ROW);

    // Feature 100 (T514) — the payload is kind-agnostic. `ancestryChecksSuppressed`
    // was a member of the retired workflow-validation ack and rode along on every
    // rejection, cyclic or not; `scope` and `currentRevision` are 099's. The closed
    // key set is what keeps any of them from quietly reappearing.
    expect(Object.keys(outcome.ack.result as object).sort()).toEqual([
      'current',
      'defects',
      'legalActions',
      'total'
    ]);
    // The record names the state the refusal left behind, so the window can offer
    // the operator the discard the draft it just stored makes available.
    expect(outcome.ack.result).toMatchObject({
      current: { kind: 'workflow', id: WORKFLOW_ID, state: 'draft' },
      legalActions: ['save-draft', 'publish', 'restore', 'discard-draft']
    });
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
    const { ack, persisted } = await commit([], branchingRow());
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
    const { ack, persisted } = await commit(
      [],
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
    );

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

  /**
   * The Phase and Pipeline definitions every host in this block reads.
   *
   * Feature 099 (T496f, FR-054) — these arrived through `getPhases(scope)` and
   * `getPipelines(scope)` on the configuration reader; both are deleted, and
   * definitions come from a store snapshot. What is left on the reader names what
   * a Pipeline may select and which Pipeline to open on — neither is a definition.
   */
  const CATALOG_SNAPSHOT = snapshotOf({
    phases: AUTHORED_PHASE_ROWS,
    pipelines: AUTHORED_PIPELINE_ROWS
  });

  const CATALOG_READER: CatalogConfigReader = {
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
    const runtime = loadCatalog(CATALOG_SNAPSHOT, CATALOG_READER);
    const workflowCatalog = resolveWorkflowCatalog({
      rows: workflowRows,
      revision: FIXTURE_REVISION,
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

  // Feature 099 (T496f, FR-042) — was `pipelineId === … && record.scope === 'workspace'`.
  // One catalog has one record per id, so the scope half selected nothing the id
  // half did not already select; keeping it would only assert the field exists.
  const recordFor = (snapshot: WorkflowSnapshot, pipelineId: string) =>
    snapshot.pipelineCatalog?.records.find((record) => record.pipelineId === pipelineId);

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
  //   * the catalog store — asserted to receive exactly the two writes the
  //     operation is, both of kind `workflow`, so no other catalog and no state
  //     key was written. Feature 099 (T496f, FR-042a): this was `updateConfig`,
  //     asserted to receive the `workflows` settings key and nothing else.
  //     Feature 100 (T514): same claim, and now readable off the instruction —
  //     each write names its op and its kind;
  //   * the router dependencies — every seam that can start, resume, retry, or
  //     re-order work, asserted uncalled.
  //
  // A run or a session can only come into being through one of those two, so
  // "zero runs, zero queue entries, zero sessions" follows from them. The
  // ambient host state is checked separately below as corroboration; on its own
  // it would prove little, since the handler holds no reference to that store.
  it('writes only the Workflow catalog and reaches no work-starting seam, on create, edit, and validate (FR-038, SC-007)', async () => {
    const onCreate = workStartingSeams();
    const created = await commit([], authoredRow(), { extraDeps: onCreate });
    expect(created.ack.status).toBe('accepted');
    expect(created.store.lifecycleWrites.map((write) => `${write.op}:${write.kind}`)).toEqual([
      'save-draft:workflow',
      'publish:workflow'
    ]);
    // The store holds all three catalogs, so "only the Workflow one" is checkable
    // directly rather than inferred from the absence of a second write.
    expect(created.store.rowsOf('phase')).toEqual(AUTHORED_PHASE_ROWS);
    expect(created.store.rowsOf('pipeline')).toEqual(AUTHORED_PIPELINE_ROWS);
    expectNoSeamReached(created.deps);

    const onEdit = workStartingSeams();
    const edited = await commit(created.persisted, authoredRow({ name: 'Design then Build, revised' }), {
      extraDeps: onEdit
    });
    expect(edited.ack.status).toBe('accepted');
    expect(edited.store.lifecycleWrites.map((write) => `${write.op}:${write.kind}`)).toEqual([
      'save-draft:workflow',
      'publish:workflow'
    ]);
    expect(edited.store.rowsOf('phase')).toEqual(AUTHORED_PHASE_ROWS);
    expect(edited.store.rowsOf('pipeline')).toEqual(AUTHORED_PIPELINE_ROWS);
    expectNoSeamReached(edited.deps);

    // "Validating" has no command of its own — a publication carries the graph
    // through the same validation pass and reports the defects, so a refused
    // publication *is* the validate path, and it must be as inert as the two
    // accepted ones. More so, in fact: it may not reach the store's write port at
    // all. Feature 100 (FR-016) — the draft write ahead of it is the operation's
    // own first half, and the *effective* catalog is what stayed put.
    const onValidate = workStartingSeams();
    const validated = await commit(edited.persisted, INVALID_ROW, { extraDeps: onValidate });
    expect(validated.saved.status).toBe('accepted');
    expect(validated.ack.status).toBe('rejected');
    expect(validated.ack.reason).toBe('validation-failed');
    expect(validated.ops).toEqual(['save-draft']);
    expect(validated.persisted).toEqual(edited.persisted);
    expect(validated.store.stateOf('workflow', WORKFLOW_ID)).toBe('active-with-draft');
    expectNoSeamReached(validated.deps);
  });

  it('leaves run, queue, and session state exactly as it found them (SC-007)', async () => {
    const observer = await host([]);
    const baselineWrites = observer.memento.writes;

    await commit([], authoredRow());
    await commit([authoredRow()], authoredRow({ name: 'Design then Build, revised' }));
    await commit([authoredRow()], INVALID_ROW);

    expect(observer.store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
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
