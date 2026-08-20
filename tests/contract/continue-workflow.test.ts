// Feature 088 (T030, US3) — IPC contract tests for CMD_CONTINUE_WORKFLOW.
//
// Covers the ordered gate table in
// `specs/088-workflow-continuation/contracts/workflow-run-ipc.md`:
//   gate 0  envelope + ingress validator   dropped at the transport boundary
//   gate 0a trust, then primary instance
//   gate 1  the run resolves               `rejected-run` / run-not-found
//   gate 2  `expectedRevision` matches     `rejected-stale`, WITH the authoritative projection
//   gate 3  no child is non-terminal       `rejected-state` / child-not-terminal
//   gate 4  the node is eligible now       `rejected-state` / node-not-eligible
//   gate 4a the request names that node's Pipeline   `rejected-definition`
//   gate 4b workspace root
//   gate 5  `validateRunRequest()` against the FROZEN Pipeline
//   gate 6  queue guards, then the enqueue
//   gate 7  append the attempt and increment
//
// Two properties of this table are the reason the file exists, and each is
// asserted with **two** gates failing at once — a case where only one gate can
// fail cannot tell which one answered:
//
//   * **Revision before state.** After a stale command the operator refreshes;
//     after a state refusal they wait. Reporting the wrong one sends them down
//     the wrong path, so gate 2 precedes gates 3 and 4.
//   * **Validation against the frozen Pipeline.** A continuation reads no
//     catalog at all (FR-003, FR-004): the graph, the Pipeline, and the Phases
//     all come from what the run froze at launch. The fixtures below give the
//     runtime catalog a *different* contract for the same Pipeline id, so a
//     request that is valid against the frozen snapshot and invalid against the
//     catalog — and the reverse — says unambiguously which one was consulted.
//     The harness also counts every catalog and config read and asserts zero.
//
// Gate 0 is asserted against `validateInboundMessage` directly, because a payload
// that fails there never reaches the router; everything from gate 0a on goes
// through a real `MessageRouter.dispatch`, so the ORDER is exercised.

import { describe, expect, it, vi } from 'vitest';

const WORKSPACE_ROOT = '/tmp/schegent-continue-workflow-contract';

const mocks = vi.hoisted(() => ({
  workspaceRoot: '/tmp/schegent-continue-workflow-contract' as string | null
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () =>
    mocks.workspaceRoot === null
      ? undefined
      : { uri: { fsPath: mocks.workspaceRoot, scheme: 'file' }, name: 'ws', index: 0 }
}));

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import { CMD_CONTINUE_WORKFLOW } from '../../src/contracts/sidebar-ipc';
import type {
  ConnectedRunProjection,
  ContinueWorkflowResult
} from '../../src/contracts/sidebar-ipc/workflow-run';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { createConnectedRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../src/services/guarded-run-service';
import {
  appendAttempt,
  appendDecision,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import type { ConnectedChildState } from '../../src/ui/sidebar/connected-run-projector';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../src/ui/sidebar/commands/constants';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

// ---------------------------------------------------------------------------
// The run under test.
//
//   first  ──report→brief──▶  second  ──report→seed──▶  third
//   (ab-flow)                 (ab-flow)                 (solo-flow)
//
// One attempt on `first`, terminal, and one recorded decision offering
// connection 0. So: `first` is restartable (FR-016), `second` is `available`,
// and `third` is `unvisited` — nothing has decided it yet, because `second` has
// never run. That gives every gate-4 case a natural fixture and no contrivance.
// ---------------------------------------------------------------------------

const GRAPH: WorkflowDefinition = {
  workflowId: 'ab-workflow',
  name: 'A then B',
  version: 1,
  nodes: [
    { nodeId: 'first', pipelineId: 'ab-flow', label: 'First pass' },
    { nodeId: 'second', pipelineId: 'ab-flow', label: 'Second pass' },
    { nodeId: 'third', pipelineId: 'solo-flow' }
  ],
  connections: [
    { from: { nodeId: 'first', portId: 'report' }, to: { nodeId: 'second', portId: 'brief' } },
    { from: { nodeId: 'second', portId: 'report' }, to: { nodeId: 'third', portId: 'seed' } }
  ],
  startNodeIds: ['first']
};

const ALPHA: PhaseDef = {
  id: 'alpha',
  name: 'Alpha',
  version: 1,
  instruction: 'Alpha prompt.',
};
const BETA: PhaseDef = {
  id: 'beta',
  name: 'Beta',
  version: 1,
  instruction: 'Beta prompt.',
};

/** What the run froze at launch: `brief` in, `report` out. */
const AB_FLOW: PipelineDef = {
  id: 'ab-flow',
  name: 'A then B',
  phases: ['alpha', 'beta'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

/**
 * The same Pipeline id, re-authored since the launch: every port renamed, and a
 * Phase dropped. Nothing in a continuation may see it — which is what makes it
 * a usable probe.
 */
const AB_FLOW_DRIFTED: PipelineDef = {
  id: 'ab-flow',
  name: 'A then B (edited)',
  phases: ['alpha'],
  inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
  outputs: [{ portId: 'summary', label: 'Summary', type: 'markdown' }]
};

const SOLO_FLOW: PipelineDef = {
  id: 'solo-flow',
  name: 'Solo',
  phases: ['alpha'],
  inputs: [{ portId: 'seed', label: 'Seed', type: 'text', required: true }],
  outputs: []
};

/** The catalog as it stood at launch — the source of the frozen snapshot. */
function launchCatalog(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA], [AB_FLOW, SOLO_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

/** The catalog as it stands now. Deliberately incompatible with the frozen one. */
function driftedCatalog(): PipelineCatalog {
  return buildCatalog([ALPHA], [AB_FLOW_DRIFTED, SOLO_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

const RUN_ID = 'run-0001';
const STARTED_AT = 1_700_000_000_000;

/** Revision 3: opened (1), one attempt on `first` (2), one decision (3). */
function storedRun(): ConnectedWorkflowRun {
  const snapshot = createConnectedRunSnapshot({
    connectedRunId: RUN_ID,
    workflow: GRAPH,
    catalog: launchCatalog(),
    startedAt: STARTED_AT,
    defaultRunnerKind: 'codex'
  });
  if (snapshot.outcome !== 'created') {
    throw new Error(`fixture could not open a run: ${snapshot.reason}`);
  }
  const withAttempt = appendAttempt(snapshot.run, 'first', {
    queueItemId: 'child-1',
    startedAt: STARTED_AT
  });
  return appendDecision(withAttempt, {
    nodeId: 'first',
    attemptIndex: 0,
    decidedAt: STARTED_AT + 1_000,
    operands: [],
    connections: [{ index: 0, matched: true, isDefault: false }],
    defaultApplied: false,
    eligible: [0]
  });
}

const CURRENT_REVISION = 3;

// Overrides are deliberately untyped: several cases assert that a key the wire
// type does not declare is refused, which a `Partial<>` could not express.
function runRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    pipelineId: 'ab-flow',
    inputs: [{ portId: 'brief', type: 'text', value: 'carry on' }],
    supplemental: [],
    outputs: [{ portId: 'report', target: 'out/second.md' }],
    ...overrides
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectedRunId: RUN_ID,
    expectedRevision: CURRENT_REVISION,
    nodeId: 'second',
    request: runRequest(),
    ...overrides
  };
}

function envelope(body: unknown): unknown {
  return { type: CMD_CONTINUE_WORKFLOW, correlationId: 'continue-wf-1', payload: body };
}

describe('gate 0 — envelope and ingress validation', () => {
  it('accepts a well-formed continuation', () => {
    const valid = envelope(payload());
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it('rejects a missing payload', () => {
    expect(
      validateInboundMessage({ type: CMD_CONTINUE_WORKFLOW, correlationId: 'continue-wf-1' })
    ).toMatchObject({ ok: false, reason: 'missing-payload' });
  });

  it.each(['connectedRunId', 'expectedRevision', 'nodeId', 'request'])(
    'rejects a payload missing %s',
    (key) => {
      const body = payload();
      delete body[key];
      expect(validateInboundMessage(envelope(body))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('rejects an undeclared payload key', () => {
    expect(validateInboundMessage(envelope(payload({ force: true })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  // `expectedRevision` is bounded below and not above: a value the store has
  // moved past is gate 2's answer, not a transport defect.
  it.each([[-1], [1.5], ['3'], [null], [Number.NaN]])(
    'rejects a malformed expectedRevision %p',
    (value) => {
      expect(validateInboundMessage(envelope(payload({ expectedRevision: value })))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('admits revision 0 and a revision the store has long passed', () => {
    for (const expectedRevision of [0, 9_999]) {
      expect(validateInboundMessage(envelope(payload({ expectedRevision })))).toMatchObject({
        ok: true
      });
    }
  });

  it.each([[''], [null], ['x'.repeat(129)]])(
    'rejects a malformed connectedRunId %p',
    (value) => {
      expect(validateInboundMessage(envelope(payload({ connectedRunId: value })))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it.each([[''], [42], ['x'.repeat(65)]])('rejects a malformed nodeId %p', (value) => {
    expect(validateInboundMessage(envelope(payload({ nodeId: value })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  // What gate 0 is NOT: it knows nothing about the stored run, so an unknown run,
  // an ineligible node, and a foreign Pipeline all belong to later gates.
  it('lets an unknown run, an ineligible node, and a foreign Pipeline through', () => {
    expect(
      validateInboundMessage(
        envelope(
          payload({
            connectedRunId: 'no-such-run',
            nodeId: 'third',
            request: runRequest({ pipelineId: 'solo-flow' })
          })
        )
      )
    ).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Gates 0a-7, through a real router.
// ---------------------------------------------------------------------------

interface ConnectedRunWrite {
  readonly run: ConnectedWorkflowRun;
  readonly expectedRevision: number;
}

interface Harness {
  readonly router: MessageRouter;
  readonly acks: CommandAckMessage[];
  readonly scheduled: GuardedScheduleRequest[];
  readonly writes: ConnectedRunWrite[];
  /** Every read of a catalog or of a raw config layer. A continuation makes none. */
  readonly reads: { catalog: number; phases: number; pipelines: number; workflows: number };
  readonly warnings: string[];
  /** The store, so a test can assert what the second dispatch would resolve. */
  readonly store: { current: ConnectedWorkflowRun | null };
}

function buildRouter(
  opts: {
    isTrusted?: boolean;
    isPrimary?: boolean;
    omitConnectedRuns?: boolean;
    omitGuardedRun?: boolean;
    run?: ConnectedWorkflowRun | null;
    /** What the host reads back for each child queue item. */
    childState?: ConnectedChildState | null;
    /** Persist each write, so a second dispatch sees the new revision (FR-047). */
    persist?: boolean;
    writeStale?: boolean;
    scheduleResult?: GuardedScheduleResult;
    scheduleThrows?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const scheduled: GuardedScheduleRequest[] = [];
  const writes: ConnectedRunWrite[] = [];
  const reads = { catalog: 0, phases: 0, pipelines: 0, workflows: 0 };
  const warnings: string[] = [];
  const store = { current: opts.run === undefined ? storedRun() : opts.run };

  const connectedRuns = {
    get: (connectedRunId: string) =>
      store.current !== null && store.current.connectedRunId === connectedRunId
        ? store.current
        : null,
    compareAndSetConnectedRun: async (run: ConnectedWorkflowRun, expectedRevision: number) => {
      writes.push({ run, expectedRevision });
      if (opts.writeStale) return { outcome: 'stale', current: store.current } as const;
      if (opts.persist) store.current = run;
      return { outcome: 'written', run } as const;
    },
    readChildState: () => (opts.childState === undefined ? 'completed' : opts.childState)
  };

  const guardedRun = {
    scheduleOrEnqueue: async (request: GuardedScheduleRequest): Promise<GuardedScheduleResult> => {
      scheduled.push(request);
      if (opts.scheduleThrows) throw new Error('enqueue exploded: SECRET');
      return opts.scheduleResult ?? { outcome: 'enqueued', queueItemId: 'child-2' };
    }
  };

  const deps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    isPrimary: () => opts.isPrimary ?? true,
    isTrusted: () => opts.isTrusted ?? true,
    notifyWarning: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: (message: string) => {
        warnings.push(message);
      },
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (value: string) => value.replaceAll('SECRET', '[redacted]')
    },
    // Every source of catalog truth is wired and counted. None may be consulted.
    defaultRunnerKind: 'claude',
    getCatalog: () => {
      reads.catalog += 1;
      return driftedCatalog();
    },
    readPhaseConfig: () => {
      reads.phases += 1;
      return { user: [], workspace: [] };
    },
    readPipelineConfig: () => {
      reads.pipelines += 1;
      return { user: [], workspace: [] };
    },
    readWorkflowConfig: () => {
      reads.workflows += 1;
      return { user: [], workspace: [] };
    },
    ...(opts.omitConnectedRuns ? {} : { connectedRuns }),
    ...(opts.omitGuardedRun ? {} : { guardedRun })
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, scheduled, writes, reads, warnings, store };
}

async function dispatch(
  harness: Harness,
  body: Record<string, unknown>,
  correlationId = 'continue-wf-1'
): Promise<void> {
  await harness.router.dispatch(
    {
      type: CMD_CONTINUE_WORKFLOW,
      correlationId,
      payload: body
    } as unknown as SidebarCommand,
    async (msg) => {
      harness.acks.push(msg);
      return true;
    }
  );
}

function only(harness: Harness): {
  readonly ack: CommandAckMessage;
  readonly result: ContinueWorkflowResult;
} {
  expect(harness.acks).toHaveLength(1);
  const ack = harness.acks[0] as CommandAckMessage;
  return { ack, result: (ack as { result?: unknown }).result as ContinueWorkflowResult };
}

function projectionOf(result: ContinueWorkflowResult): ConnectedRunProjection {
  expect(['rejected-stale', 'rejected-state']).toContain(result.outcome);
  return (result as { projection: ConnectedRunProjection }).projection;
}

function errorsOf(result: ContinueWorkflowResult): readonly { field: string; code: string }[] {
  expect(result.outcome).toBe('rejected-validation');
  return (result as Extract<ContinueWorkflowResult, { outcome: 'rejected-validation' }>).errors;
}

/** Every catalog and config reader, which a continuation must never touch. */
function expectNoCatalogReads(harness: Harness): void {
  expect(harness.reads).toEqual({ catalog: 0, phases: 0, pipelines: 0, workflows: 0 });
}

describe('gate 0a — trust and primary instance', () => {
  it('refuses an untrusted workspace before reading the run', async () => {
    const harness = buildRouter({ isTrusted: false });

    await dispatch(harness, payload());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: UNTRUSTED_REJECT });
    expect(harness.writes).toEqual([]);
  });

  it('refuses a secondary window', async () => {
    const harness = buildRouter({ isPrimary: false });

    await dispatch(harness, payload());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: SECONDARY_REJECT });
    expect(harness.writes).toEqual([]);
  });

  it('answers trust before primary when both fail', async () => {
    const harness = buildRouter({ isTrusted: false, isPrimary: false });

    await dispatch(harness, payload());

    expect(only(harness).ack.reason).toBe(UNTRUSTED_REJECT);
  });
});

describe('host wiring — before gate 1', () => {
  it('refuses a host with no connected-run store', async () => {
    const harness = buildRouter({ omitConnectedRuns: true });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    expect(harness.scheduled).toEqual([]);
  });
});

describe('gate 1 — the run resolves', () => {
  it.each([
    ['an id no run holds', { connectedRunId: 'no-such-run' }],
    ['a run that is gone', {}]
  ])('reports %s as run-not-found', async (label, overrides) => {
    const harness = buildRouter(label === 'a run that is gone' ? { run: null } : {});

    await dispatch(harness, payload(overrides));

    expect(only(harness).result).toEqual({ outcome: 'rejected-run', reason: 'run-not-found' });
    expect(harness.scheduled).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  // Ordering, with two gates failing: a run that does not exist has no revision
  // to be stale against.
  it('answers gate 1 before gate 2 when both fail', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ connectedRunId: 'no-such-run', expectedRevision: 0 }));

    expect(only(harness).result).toMatchObject({ outcome: 'rejected-run' });
  });

  // `rejected-run` carries no projection: there is nothing left to project, and a
  // projection of a run the operator cannot act on would be worse than none.
  it('carries no projection on the run-not-found arm', async () => {
    const harness = buildRouter({ run: null });

    await dispatch(harness, payload());

    expect(Object.keys(only(harness).result)).toEqual(['outcome', 'reason']);
  });
});

describe('gate 2 — the revision matches (FR-046)', () => {
  it.each([[0], [2], [4], [9_999]])(
    'refuses expectedRevision %i as stale',
    async (expectedRevision) => {
      const harness = buildRouter();

      await dispatch(harness, payload({ expectedRevision }));

      const { result } = only(harness);
      expect(result.outcome).toBe('rejected-stale');
      expect(harness.scheduled).toEqual([]);
      expect(harness.writes).toEqual([]);
    }
  );

  // FR-045 — the refusal carries the AUTHORITATIVE record, so a view rendered
  // from a superseded snapshot corrects itself from the answer it just received.
  it('reports the authoritative projection, not the caller‘s view of it', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ expectedRevision: 1 }));

    const projection = projectionOf(only(harness).result);
    expect(projection.revision).toBe(CURRENT_REVISION);
    expect(projection.connectedRunId).toBe(RUN_ID);
    expect(projection.workflowId).toBe('ab-workflow');
    expect(projection.nodes.map((node) => [node.nodeId, node.state, node.actions])).toEqual([
      ['first', 'completed', ['restart']],
      ['second', 'available', ['start']],
      ['third', 'unvisited', []]
    ]);
  });

  it('reports hydrating while a referenced child run has not loaded', async () => {
    const harness = buildRouter({ childState: null });

    await dispatch(harness, payload({ expectedRevision: 1 }));

    expect(projectionOf(only(harness).result).hydrating).toBe(true);
  });

  // Ordering, with both gates failing — the reason the gate table puts 2 first.
  // After a stale command the operator refreshes; after a state refusal they wait.
  it('answers gate 2 before gate 3 when both fail', async () => {
    const harness = buildRouter({ childState: 'in-flight' });

    await dispatch(harness, payload({ expectedRevision: 1 }));

    expect(only(harness).result.outcome).toBe('rejected-stale');
  });

  it('answers gate 2 before gate 4 when both fail', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ expectedRevision: 1, nodeId: 'third' }));

    expect(only(harness).result.outcome).toBe('rejected-stale');
  });

  it('answers gate 2 before gate 5 when both fail', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({ expectedRevision: 1, request: runRequest({ inputs: [], outputs: [] }) })
    );

    expect(only(harness).result.outcome).toBe('rejected-stale');
  });
});

describe('gate 3 — no child is non-terminal (FR-044)', () => {
  it('refuses while a child run is still going', async () => {
    const harness = buildRouter({ childState: 'in-flight' });

    await dispatch(harness, payload());

    const { result } = only(harness);
    expect(result).toMatchObject({ outcome: 'rejected-state', reason: 'child-not-terminal' });
    expect(harness.scheduled).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  // The projection agrees with the refusal: while a child is non-terminal the
  // host would refuse every start, so nothing is offered anywhere (FR-057).
  it('offers no action anywhere while a child is non-terminal', async () => {
    const harness = buildRouter({ childState: 'in-flight' });

    await dispatch(harness, payload());

    const projection = projectionOf(only(harness).result);
    expect(projection.nodes.flatMap((node) => node.actions)).toEqual([]);
    expect(projection.revision).toBe(CURRENT_REVISION);
  });

  // A queue item nothing holds is not executing: reading "unknown" as "still
  // going" would leave a connected run permanently unstartable.
  it('treats an unresolvable child as settled rather than as blocking', async () => {
    const harness = buildRouter({ childState: null });

    await dispatch(harness, payload());

    expect(only(harness).result.outcome).toBe('started');
  });

  it.each(['completed', 'failed', 'canceled'] as ConnectedChildState[])(
    'admits a continuation once the child is %s',
    async (childState) => {
      const harness = buildRouter({ childState });

      await dispatch(harness, payload());

      expect(only(harness).result.outcome).toBe('started');
    }
  );

  it('answers gate 3 before gate 4 when both fail', async () => {
    const harness = buildRouter({ childState: 'in-flight' });

    await dispatch(harness, payload({ nodeId: 'third' }));

    expect(only(harness).result).toMatchObject({ reason: 'child-not-terminal' });
  });
});

describe('gate 4 — the node is eligible now (FR-016)', () => {
  it.each([
    ['a node no decision has reached', 'third'],
    ['a node the frozen graph does not contain', 'ghost']
  ])('refuses %s as node-not-eligible', async (_label, nodeId) => {
    const harness = buildRouter();

    await dispatch(harness, payload({ nodeId, request: runRequest({ pipelineId: 'solo-flow' }) }));

    const { result } = only(harness);
    expect(result).toMatchObject({ outcome: 'rejected-state', reason: 'node-not-eligible' });
    expect(harness.writes).toEqual([]);
  });

  // FR-016's second half: a node whose most recent attempt is terminal accepts
  // another start. It is the same question to the fold, and the same gate.
  it('admits a re-start of a node whose latest attempt is terminal', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ nodeId: 'first' }));

    expect(only(harness).result.outcome).toBe('started');
    expect((harness.writes[0] as ConnectedRunWrite).run.nodes.first?.attempts).toHaveLength(2);
  });

  it('answers gate 4 before gate 4a when both fail', async () => {
    const harness = buildRouter();

    // `third` is ineligible AND the request names a Pipeline that is not its.
    await dispatch(harness, payload({ nodeId: 'third' }));

    expect(only(harness).result).toMatchObject({ reason: 'node-not-eligible' });
  });
});

describe("gate 4a — the request names that node's Pipeline", () => {
  it('refuses a request addressed at another Pipeline', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ request: runRequest({ pipelineId: 'solo-flow' }) }));

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'pipeline-mismatch'
    });
    expect(harness.scheduled).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('answers gate 4a before gate 4b when both fail', async () => {
    const harness = buildRouter();
    mocks.workspaceRoot = null;
    try {
      await dispatch(harness, payload({ request: runRequest({ pipelineId: 'solo-flow' }) }));
    } finally {
      mocks.workspaceRoot = WORKSPACE_ROOT;
    }

    expect(only(harness).result).toMatchObject({ reason: 'pipeline-mismatch' });
  });
});

describe('gate 4b — the workspace root resolves', () => {
  it('refuses once rather than per path-bearing field', async () => {
    const harness = buildRouter();
    mocks.workspaceRoot = null;
    try {
      await dispatch(harness, payload());
    } finally {
      mocks.workspaceRoot = WORKSPACE_ROOT;
    }

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'no-workspace-root'
    });
  });

  it('answers gate 4b before gate 5 when both fail', async () => {
    const harness = buildRouter();
    mocks.workspaceRoot = null;
    try {
      await dispatch(harness, payload({ request: runRequest({ inputs: [], outputs: [] }) }));
    } finally {
      mocks.workspaceRoot = WORKSPACE_ROOT;
    }

    expect(only(harness).result).toMatchObject({ reason: 'no-workspace-root' });
  });
});

describe('gate 5 — validation against the FROZEN Pipeline (FR-003, FR-004)', () => {
  // The whole point of the file. The catalog the host holds now renamed every
  // port of `ab-flow`; the run froze the old contract at launch. A request the
  // frozen contract accepts must succeed.
  it('accepts the ports the run froze, which the current catalog no longer has', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(only(harness).result.outcome).toBe('started');
    expectNoCatalogReads(harness);
  });

  // And the reverse, which is the half that a validator reading the live catalog
  // would pass: the current contract's ports are unknown to this run.
  it('refuses the ports the current catalog declares', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({
        request: runRequest({
          inputs: [{ portId: 'topic', type: 'text', value: 'drifted' }],
          outputs: [{ portId: 'summary', target: 'out/summary.md' }]
        })
      })
    );

    expect(errorsOf(only(harness).result).map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([
        ['inputs.topic', 'unknown-input-port'],
        ['inputs.brief', 'missing-required-input'],
        ['outputs.summary', 'unknown-output-port'],
        ['outputs.report', 'output-target-missing']
      ])
    );
    expectNoCatalogReads(harness);
  });

  it('reports every failing field in one response', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({
        request: runRequest({
          inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }],
          outputs: [{ portId: 'nope', target: 'out/x.md' }]
        })
      })
    );

    const fields = errorsOf(only(harness).result).map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(['inputs.no-such-port', 'inputs.brief', 'outputs.nope', 'outputs.report'])
    );
    expect(harness.scheduled).toEqual([]);
  });

  it('names no absolute path in a refusal', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({ request: runRequest({ outputs: [{ portId: 'report', target: '../outside.md' }] }) })
    );

    const { ack, result } = only(harness);
    expect(errorsOf(result)).toContainEqual(
      expect.objectContaining({ field: 'outputs.report', code: 'path-escapes-workspace' })
    );
    expect(JSON.stringify(ack)).not.toContain(WORKSPACE_ROOT);
  });

  it('answers gate 5 before gate 6 when both would refuse', async () => {
    const harness = buildRouter({
      scheduleResult: { outcome: 'rejected-paused', reason: 'queue-paused' }
    });

    await dispatch(harness, payload({ request: runRequest({ inputs: [], outputs: [] }) }));

    expect(only(harness).result.outcome).toBe('rejected-validation');
    expect(harness.scheduled).toEqual([]);
  });
});

describe('gate 6 — queue guards, then the enqueue', () => {
  it.each([
    { outcome: 'rejected-paused', reason: 'queue-paused' },
    { outcome: 'rejected-foreign-lock', reason: 'foreign-lock' }
  ] as GuardedScheduleResult[])('reports %o as one refusal family', async (scheduleResult) => {
    const harness = buildRouter({ scheduleResult });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: scheduleResult.reason
    });
    expect(harness.writes).toEqual([]);
  });

  it('refuses when the host wired no queue', async () => {
    const harness = buildRouter({ omitGuardedRun: true });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    expect(harness.writes).toEqual([]);
  });

  it('turns an unexpected enqueue failure into a refusal, not an unhandled rejection', async () => {
    const harness = buildRouter({ scheduleThrows: true });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'enqueue-failed'
    });
    expect(harness.warnings.join('\n')).toContain('[redacted]');
    expect(harness.warnings.join('\n')).not.toContain('SECRET');
  });

  it('sanitizes and bounds a guard reason before it reaches the composer', async () => {
    const harness = buildRouter({
      scheduleResult: { outcome: 'rejected-paused', reason: `SECRET ${'y'.repeat(300)}` }
    });

    await dispatch(harness, payload());

    const result = only(harness).result as Extract<
      ContinueWorkflowResult,
      { outcome: 'rejected-queue' }
    >;
    expect(result.detail).toHaveLength(120);
    expect(result.detail).not.toContain('SECRET');
  });
});

describe('gate 7 — the attempt is appended and the revision increments', () => {
  it('accepts and returns the new revision', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const { ack, result } = only(harness);
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toBeUndefined();
    expect(result).toEqual({
      outcome: 'started',
      revision: CURRENT_REVISION + 1,
      queueItemId: 'child-2'
    });
  });

  it('writes once, compare-and-set against the revision it was given', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(harness.writes).toHaveLength(1);
    const write = harness.writes[0] as ConnectedRunWrite;
    expect(write.expectedRevision).toBe(CURRENT_REVISION);
    expect(write.run.revision).toBe(CURRENT_REVISION + 1);
    expect(write.run.nodes.second?.attempts).toEqual([
      { queueItemId: 'child-2', startedAt: expect.any(Number) }
    ]);
  });

  // Attempts and decisions only ever grow; a continuation rewrites nothing.
  it('leaves the frozen graph, the frozen Pipelines, and the decisions untouched', async () => {
    const harness = buildRouter();
    const before = harness.store.current as ConnectedWorkflowRun;

    await dispatch(harness, payload());

    const after = (harness.writes[0] as ConnectedRunWrite).run;
    expect(after.graph).toEqual(before.graph);
    expect(after.pipelines).toEqual(before.pipelines);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.nodes.first?.attempts).toEqual(before.nodes.first?.attempts);
  });

  it('submits exactly one child run, labelled with the node', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]).toMatchObject({
      via: 'webview',
      pipelineId: 'ab-flow',
      description: 'Second pass'
    });
  });

  // The frozen snapshot is what runs: two Phases on the host backend the LAUNCH
  // was configured with, not the one this host holds now, and not the single
  // Phase the current catalog's `ab-flow` has.
  it('runs the Phases the run froze, on the backend it froze them with', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const plan = (harness.scheduled[0] as unknown as {
      runPlan: { pipeline: { phases: readonly unknown[] } };
    }).runPlan;
    expect(plan.pipeline.phases.map((phase) => (phase as { id: string }).id)).toEqual([
      'alpha',
      'beta'
    ]);
    expect(plan.pipeline.phases.map((phase) => (phase as { runner?: string }).runner)).toEqual([
      'codex',
      'codex'
    ]);
  });

  // The enqueue happens first and is never rolled back: what a refused write
  // loses is the link to a child that is queued and visible, and undoing it
  // would be a destructive write on a failure path no operator confirmed.
  it('keeps the enqueued child when the attempt write is superseded', async () => {
    const harness = buildRouter({ writeStale: true });

    await dispatch(harness, payload());

    expect(only(harness).result.outcome).toBe('started');
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.warnings.join('\n')).toContain('the queue item is unaffected');
  });
});

describe('FR-047 — idempotency is the compare-and-set itself', () => {
  // Two submissions the operator really made — a double-click across a re-render,
  // or two windows on the same run — so each carries its own correlation id and
  // both reach the handler. Same `expectedRevision`: the first increments, the
  // second fails gate 2. No dedup key, no request id, no time window.
  it('starts the first of two submissions at the same revision and reports the second stale', async () => {
    const harness = buildRouter({ persist: true });
    const body = payload();

    await dispatch(harness, body, 'continue-wf-1');
    await dispatch(harness, body, 'continue-wf-2');

    expect(harness.acks).toHaveLength(2);
    const [first, second] = harness.acks as [CommandAckMessage, CommandAckMessage];
    expect((first as { result?: ContinueWorkflowResult }).result).toMatchObject({
      outcome: 'started',
      revision: CURRENT_REVISION + 1
    });
    const repeat = (second as { result?: ContinueWorkflowResult }).result as ContinueWorkflowResult;
    expect(repeat.outcome).toBe('rejected-stale');
    // And it corrects the caller: the run has moved, and the projection says so.
    expect(projectionOf(repeat).revision).toBe(CURRENT_REVISION + 1);

    // One submission, one child, one write — which is the whole claim.
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.writes).toHaveLength(1);
  });

  // Recorded so the test above is not misread as covering this: a *re-delivered*
  // command — same correlation id — never reaches the handler at all. The
  // router's mutation executor replays the captured ack, one layer above gate 1.
  // That layer answers transport retries; the compare-and-set answers concurrent
  // operators, and neither substitutes for the other.
  it('replays the ack for a re-delivered correlation id without re-running the gates', async () => {
    const harness = buildRouter({ persist: true });
    const body = payload();

    await dispatch(harness, body, 'continue-wf-1');
    await dispatch(harness, body, 'continue-wf-1');

    expect(harness.acks).toHaveLength(2);
    expect(harness.acks[0]).toEqual(harness.acks[1]);
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.writes).toHaveLength(1);
  });
});

describe('the whole command reads no catalog', () => {
  // The hard rule this command exists to hold: a continuation resolves everything
  // from the run's own frozen snapshot. Asserted across every arm, because a
  // single read on a single path is all it takes to retarget a run in flight.
  it.each([
    ['started', {}, {}],
    ['rejected-run', { connectedRunId: 'no-such-run' }, {}],
    ['rejected-stale', { expectedRevision: 1 }, {}],
    ['rejected-state', { nodeId: 'third' }, {}],
    ['rejected-definition', { request: runRequest({ pipelineId: 'solo-flow' }) }, {}],
    ['rejected-validation', { request: runRequest({ inputs: [], outputs: [] }) }, {}],
    [
      'rejected-queue',
      {},
      { scheduleResult: { outcome: 'rejected-paused', reason: 'queue-paused' } }
    ]
  ] as [string, Record<string, unknown>, Parameters<typeof buildRouter>[0]][])(
    'reads none on the %s arm',
    async (outcome, overrides, opts) => {
      const harness = buildRouter(opts);

      await dispatch(harness, payload(overrides));

      expect(only(harness).result.outcome).toBe(outcome);
      expectNoCatalogReads(harness);
    }
  );
});
