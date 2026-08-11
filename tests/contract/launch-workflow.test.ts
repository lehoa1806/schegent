// Feature 088 (T029, US1) — IPC contract tests for CMD_LAUNCH_WORKFLOW.
//
// Covers the ordered gate table in
// `specs/088-workflow-continuation/contracts/workflow-run-ipc.md`:
//   gate 0  envelope + ingress validator  dropped at the transport boundary
//   gate 0a trust, then primary instance  refused before anything is read
//   gate 1  Workflow resolves             `rejected-definition` / workflow-not-found
//   gate 2  graph valid, Pipelines resolve `rejected-definition` / workflow-invalid
//   gate 3  `startNodeId` is an allowed start (FR-011)  / node-not-startable
//   gate 3a the request names that node's Pipeline      / pipeline-mismatch
//   gate 4  workspace root resolves                     / no-workspace-root
//   gate 5  `validateRunRequest()` (FR-014)  `rejected-validation`, every field
//   gate 6  queue guards, then the enqueue   `rejected-queue`
//   —       the aggregate is written ONCE, already carrying its first attempt
//
// Gate 0 is asserted against `validateInboundMessage` **directly**, because a
// payload that fails there never reaches the router — which is exactly how
// bulk-0 ledger entry B0-P01 stayed invisible behind a correct handler and a
// correct emitter. Every later gate goes through a real `MessageRouter.dispatch`,
// so the ORDER is exercised and not just each gate in isolation; each ordering
// case below is asserted with **two** gates failing at once, since a case where
// only one gate can fail cannot tell which one answered.
//
// Two catalogs are in play here and the fixtures deliberately keep them
// separable, because the handler reads them for different jobs:
//
//   * the raw config layers → `resolveWorkflowCatalog(...)`, the **definitions**
//     layer, which answers gates 1-2;
//   * `getCatalog()`, the runtime `PipelineCatalog` the connected run freezes its
//     Pipeline snapshots from.
//
// A launch where the second has moved out from under the first is the
// `workflow-invalid` residual, and it has its own block below.

import { describe, expect, it, vi } from 'vitest';

// `null` is "no folder open" — gate 4. The root is specific to this suite
// because validation really does `lstat` the resolved output target, so sharing
// a root another suite might write into would make the overwrite gate flaky.
const WORKSPACE_ROOT = '/tmp/schegent-launch-workflow-contract';

const mocks = vi.hoisted(() => ({
  workspaceRoot: '/tmp/schegent-launch-workflow-contract' as string | null
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
import { CMD_LAUNCH_WORKFLOW } from '../../src/contracts/sidebar-ipc';
import type { LaunchWorkflowResult } from '../../src/contracts/sidebar-ipc/workflow-run';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../src/services/guarded-run-service';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../src/ui/sidebar/commands/constants';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

// Overrides are deliberately untyped: several cases assert that a key the wire
// type does not declare is refused, which a `Partial<>` could not express.
function runRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    pipelineId: 'ab-flow',
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [],
    outputs: [{ portId: 'report', target: 'out/report.md' }],
    ...overrides
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowId: 'ab-workflow',
    startNodeId: 'first',
    request: runRequest(),
    ...overrides
  };
}

function envelope(body: unknown): unknown {
  return { type: CMD_LAUNCH_WORKFLOW, correlationId: 'launch-wf-1', payload: body };
}

describe('gate 0 — envelope and ingress validation', () => {
  it('accepts a well-formed launch', () => {
    const valid = envelope(payload());
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it('rejects a missing payload', () => {
    expect(
      validateInboundMessage({ type: CMD_LAUNCH_WORKFLOW, correlationId: 'launch-wf-1' })
    ).toMatchObject({ ok: false, reason: 'missing-payload' });
  });

  it.each(['workflowId', 'startNodeId', 'request'])('rejects a payload missing %s', (key) => {
    const body = payload();
    delete body[key];
    expect(validateInboundMessage(envelope(body))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  // The connected run id is host-minted (FR-046a): one the webview could choose
  // would let it address a run it did not start.
  it('rejects an undeclared payload key', () => {
    expect(
      validateInboundMessage(envelope(payload({ connectedRunId: 'not-the-webviews-to-mint' })))
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each([[''], [null], [42], ['x'.repeat(65)]])('rejects a malformed workflowId %p', (value) => {
    expect(validateInboundMessage(envelope(payload({ workflowId: value })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  it.each([[''], [null], [42], ['x'.repeat(65)]])('rejects a malformed startNodeId %p', (value) => {
    expect(validateInboundMessage(envelope(payload({ startNodeId: value })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  it('rejects a request that is not shaped like a RunRequest', () => {
    const request = runRequest() as Record<string, unknown>;
    delete request.outputs;
    expect(validateInboundMessage(envelope(payload({ request })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  // What gate 0 is NOT: field-level validation. A request whose every value is
  // wrong is still structurally a request, and FR-014 wants every failing field
  // reported at gate 5 rather than the message dropped one layer earlier.
  it('lets an unknown port through to field validation', () => {
    expect(
      validateInboundMessage(
        envelope(
          payload({
            request: runRequest({ inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }] })
          })
        )
      )
    ).toMatchObject({ ok: true });
  });

  // Nor does it know the graph: a start node the Workflow does not allow is
  // gate 3's answer, and a Pipeline other than the node's is gate 3a's.
  it('lets a non-start node and a foreign Pipeline through to the handler', () => {
    expect(
      validateInboundMessage(
        envelope(
          payload({ startNodeId: 'second', request: runRequest({ pipelineId: 'solo-flow' }) })
        )
      )
    ).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Gates 0a-6, through a real router.
// ---------------------------------------------------------------------------

const PHASE_ROWS = [
  { id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.' },
  { id: 'beta', name: 'Beta', version: 1, instruction: 'Beta prompt.' }
];

const PIPELINE_ROWS = [
  {
    id: 'ab-flow',
    name: 'A then B',
    version: 1,
    phases: ['alpha', 'beta'],
    inputs: [
      { portId: 'brief', label: 'Brief', type: 'text', required: true },
      { portId: 'notes', label: 'Notes', type: 'text' }
    ],
    outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
  },
  {
    id: 'solo-flow',
    name: 'Solo',
    version: 1,
    phases: ['alpha'],
    inputs: [],
    outputs: []
  }
];

// Two nodes over the same Pipeline (FR-003 allows it, and it is frozen once),
// so `second` is a node the graph contains but does not start at — gate 3's
// case, and a sharper one than an id the graph has never heard of.
const WORKFLOW_ROWS = [
  {
    id: 'ab-workflow',
    name: 'A then B, twice',
    version: 1,
    nodes: [
      { nodeId: 'first', pipelineId: 'ab-flow', label: 'First pass' },
      { nodeId: 'second', pipelineId: 'ab-flow' }
    ],
    connections: [
      { from: { nodeId: 'first', portId: 'report' }, to: { nodeId: 'second', portId: 'brief' } }
    ],
    startNodeIds: ['first']
  },
  // Resolves as a row, never as a definition: its node names a Pipeline no layer
  // holds, so the catalog excludes it from `effective` and gate 2 can tell it
  // apart from a Workflow that was never authored.
  {
    id: 'broken-workflow',
    name: 'Broken',
    version: 1,
    nodes: [{ nodeId: 'only', pipelineId: 'no-such-pipeline' }],
    connections: [],
    startNodeIds: ['only']
  }
];

const ALPHA: PhaseDef = {
  id: 'alpha',
  name: 'Alpha',
  version: 1,
  instruction: 'Alpha prompt.',
  sourceScope: 'workspace'
};
const BETA: PhaseDef = {
  id: 'beta',
  name: 'Beta',
  version: 1,
  instruction: 'Beta prompt.',
  sourceScope: 'workspace'
};

const AB_FLOW: PipelineDef = {
  id: 'ab-flow',
  name: 'A then B',
  phases: ['alpha', 'beta'],
  sourceScope: 'workspace',
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};
const SOLO_FLOW: PipelineDef = {
  id: 'solo-flow',
  name: 'Solo',
  phases: ['alpha'],
  sourceScope: 'workspace',
  inputs: [],
  outputs: []
};

function runtimeCatalog(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA], [AB_FLOW, SOLO_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

/** The runtime catalog after the Pipeline a node names was deleted. */
function catalogWithoutPipeline(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA], [SOLO_FLOW], { claude: [], codex: [], agy: [] }, 'solo-flow');
}

/** The runtime catalog after a Phase the Pipeline names was deleted. */
function catalogWithoutPhase(): PipelineCatalog {
  return buildCatalog([ALPHA], [AB_FLOW, SOLO_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

interface ConnectedRunWrite {
  readonly run: ConnectedWorkflowRun;
  readonly expectedRevision: number;
}

interface Harness {
  readonly router: MessageRouter;
  readonly acks: CommandAckMessage[];
  readonly scheduled: GuardedScheduleRequest[];
  readonly writes: ConnectedRunWrite[];
  readonly reads: { catalog: number; workflows: number };
  readonly warnings: string[];
}

function buildRouter(
  opts: {
    isTrusted?: boolean;
    isPrimary?: boolean;
    omitConnectedRuns?: boolean;
    omitCatalog?: boolean;
    omitGuardedRun?: boolean;
    catalog?: () => PipelineCatalog;
    idInUse?: boolean;
    scheduleResult?: GuardedScheduleResult;
    scheduleThrows?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const scheduled: GuardedScheduleRequest[] = [];
  const writes: ConnectedRunWrite[] = [];
  const reads = { catalog: 0, workflows: 0 };
  const warnings: string[] = [];
  const resolved = (opts.catalog ?? runtimeCatalog)();

  const connectedRuns = {
    get: () => null,
    compareAndSetConnectedRun: async (run: ConnectedWorkflowRun, expectedRevision: number) => {
      writes.push({ run, expectedRevision });
      return opts.idInUse
        ? ({ outcome: 'stale', current: null } as const)
        : ({ outcome: 'written', run } as const);
    },
    // Never consulted on this path — a launch has no prior attempt to read.
    readChildState: () => null
  };

  const guardedRun = {
    scheduleOrEnqueue: async (request: GuardedScheduleRequest): Promise<GuardedScheduleResult> => {
      scheduled.push(request);
      if (opts.scheduleThrows) throw new Error('enqueue exploded: SECRET');
      return opts.scheduleResult ?? { outcome: 'enqueued', queueItemId: 'queue-item-1' };
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
      // Marker-based sanitizer: any host->UI string that reaches an ack must
      // have passed through this exactly once.
      sanitize: (value: string) => value.replaceAll('SECRET', '[redacted]')
    },
    // Not `DEFAULT_BACKEND`, so a frozen Phase carrying it proves the host's
    // configured backend reached the snapshot rather than the fallback.
    defaultRunnerKind: 'codex',
    readPhaseConfig: () => ({ user: [], workspace: PHASE_ROWS }),
    readPipelineConfig: () => ({ user: [], workspace: PIPELINE_ROWS }),
    readWorkflowConfig: () => {
      reads.workflows += 1;
      return { user: [], workspace: WORKFLOW_ROWS };
    },
    ...(opts.omitConnectedRuns ? {} : { connectedRuns }),
    ...(opts.omitCatalog
      ? {}
      : {
          getCatalog: () => {
            reads.catalog += 1;
            return resolved;
          }
        }),
    ...(opts.omitGuardedRun ? {} : { guardedRun })
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, scheduled, writes, reads, warnings };
}

async function dispatch(harness: Harness, body: Record<string, unknown>): Promise<void> {
  await harness.router.dispatch(
    {
      type: CMD_LAUNCH_WORKFLOW,
      correlationId: 'launch-wf-1',
      payload: body
    } as unknown as SidebarCommand,
    async (msg) => {
      harness.acks.push(msg);
      return true;
    }
  );
}

/** The single ack a dispatch produced, with its `result` narrowed to the wire union. */
function only(harness: Harness): {
  readonly ack: CommandAckMessage;
  readonly result: LaunchWorkflowResult;
} {
  expect(harness.acks).toHaveLength(1);
  const ack = harness.acks[0] as CommandAckMessage;
  return { ack, result: (ack as { result?: unknown }).result as LaunchWorkflowResult };
}

function errorsOf(result: LaunchWorkflowResult): readonly { field: string; code: string }[] {
  expect(result.outcome).toBe('rejected-validation');
  return (result as Extract<LaunchWorkflowResult, { outcome: 'rejected-validation' }>).errors;
}

describe('gate 0a — trust and primary instance', () => {
  it('refuses an untrusted workspace', async () => {
    const harness = buildRouter({ isTrusted: false });

    await dispatch(harness, payload());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: UNTRUSTED_REJECT });
    expect(harness.reads.workflows).toBe(0);
    expect(harness.writes).toEqual([]);
  });

  it('refuses a secondary window', async () => {
    const harness = buildRouter({ isPrimary: false });

    await dispatch(harness, payload());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: SECONDARY_REJECT });
    expect(harness.reads.workflows).toBe(0);
    expect(harness.writes).toEqual([]);
  });

  // Ordering, with both gates failing: an untrusted workspace must not be able
  // to tell primary from secondary, or it has a probe.
  it('answers trust before primary when both fail', async () => {
    const harness = buildRouter({ isTrusted: false, isPrimary: false });

    await dispatch(harness, payload());

    expect(only(harness).ack.reason).toBe(UNTRUSTED_REJECT);
  });
});

describe('host wiring — before gate 1', () => {
  it.each([
    ['no connected-run store', { omitConnectedRuns: true }],
    ['no runtime catalog', { omitCatalog: true }]
  ])('refuses a host with %s', async (_label, opts) => {
    const harness = buildRouter(opts);

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    // A host that cannot persist a run says so rather than resolving a catalog,
    // validating a request, and enqueueing a child it can then not record.
    expect(harness.reads.workflows).toBe(0);
    expect(harness.scheduled).toEqual([]);
  });

  it('refuses when the host wired no queue at all', async () => {
    const harness = buildRouter({ omitGuardedRun: true });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    expect(harness.writes).toEqual([]);
  });
});

describe('gate 1 — the Workflow resolves in the effective catalog', () => {
  it('reports an unknown Workflow as workflow-not-found', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ workflowId: 'no-such-workflow' }));

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'workflow-not-found'
    });
    expect(harness.scheduled).toEqual([]);
  });

  // Ordering, with two gates failing: a Workflow that does not exist has no
  // start nodes to be wrong about.
  it('answers gate 1 before gate 3 when both fail', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ workflowId: 'no-such-workflow', startNodeId: 'ghost' }));

    expect(only(harness).result).toMatchObject({ reason: 'workflow-not-found' });
  });
});

describe('gate 2 — the graph is valid and every node Pipeline resolves', () => {
  it('reports an authored-but-unresolvable Workflow as workflow-invalid', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ workflowId: 'broken-workflow', startNodeId: 'only' }));

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'workflow-invalid'
    });
    expect(harness.scheduled).toEqual([]);
  });

  it('answers gate 2 before gate 3 when both fail', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload({ workflowId: 'broken-workflow', startNodeId: 'ghost' }));

    expect(only(harness).result).toMatchObject({ reason: 'workflow-invalid' });
  });
});

describe('gate 3 — the node is an allowed start (FR-011)', () => {
  // Both refusals are the same sentence about the named node: this Workflow does
  // not start there.
  it.each([['second'], ['ghost']])('refuses %s as node-not-startable', async (startNodeId) => {
    const harness = buildRouter();

    await dispatch(harness, payload({ startNodeId }));

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'node-not-startable'
    });
    expect(harness.scheduled).toEqual([]);
  });

  it('answers gate 3 before gate 3a when both fail', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({ startNodeId: 'second', request: runRequest({ pipelineId: 'solo-flow' }) })
    );

    expect(only(harness).result).toMatchObject({ reason: 'node-not-startable' });
  });
});

describe("gate 3a — the request names that node's Pipeline", () => {
  // Refused rather than retargeted: a start the operator did not compose is not
  // a correction. `solo-flow` is a real Pipeline, so this is a mis-addressed
  // request and not a missing definition.
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

  it('answers gate 3a before gate 4 when both fail', async () => {
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

describe('gate 4 — the workspace root resolves', () => {
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

  it('answers gate 4 before gate 5 when both fail', async () => {
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

describe('gate 5 — request validation (FR-014)', () => {
  // One response carries every failing field; the alternative is an operator
  // fixing a composed request one round trip at a time.
  it('reports every failing field in one response', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({
        request: runRequest({
          // `brief` is required and unsupplied; `no-such-port` is undeclared.
          inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }],
          // `nope` is undeclared; `report` is declared and left untargeted.
          outputs: [{ portId: 'nope', target: 'out/x.md' }]
        })
      })
    );

    expect(errorsOf(only(harness).result).map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([
        ['inputs.no-such-port', 'unknown-input-port'],
        ['inputs.brief', 'missing-required-input'],
        ['outputs.nope', 'unknown-output-port'],
        ['outputs.report', 'output-target-missing']
      ])
    );
    expect(harness.scheduled).toEqual([]);
  });

  // No refusal names a location: the resolved absolute path exists only long
  // enough to decide containment.
  it('names no absolute path in a refusal', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      payload({
        request: runRequest({ outputs: [{ portId: 'report', target: '../outside.md' }] })
      })
    );

    const { ack, result } = only(harness);
    expect(errorsOf(result)).toContainEqual(
      expect.objectContaining({ field: 'outputs.report', code: 'path-escapes-workspace' })
    );
    expect(JSON.stringify(ack)).not.toContain(WORKSPACE_ROOT);
  });

  // Ordering, with both gates failing: a paused queue answered first would send
  // the operator away to wait, and the typo would still be there on their return.
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
    { outcome: 'rejected-foreign-lock', reason: 'foreign-lock' },
    { outcome: 'rejected-horizon-exceeded', reason: 'horizon-exceeded' }
  ] as GuardedScheduleResult[])('reports %o as one refusal family', async (scheduleResult) => {
    const harness = buildRouter({ scheduleResult });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: scheduleResult.reason
    });
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
      LaunchWorkflowResult,
      { outcome: 'rejected-queue' }
    >;
    expect(result.detail).toHaveLength(120);
    expect(result.detail).not.toContain('SECRET');
  });
});

describe('the residual — the runtime catalog moved between the two reads', () => {
  // Gate 2 resolved every node's Pipeline against the effective catalog; the
  // freeze reads the runtime one a moment later. A launch refuses rather than
  // starting against a partially resolved graph.
  it.each([
    ['the node Pipeline was deleted', catalogWithoutPipeline],
    ['a Phase the node Pipeline names was deleted', catalogWithoutPhase]
  ])('refuses as workflow-invalid when %s', async (_label, catalog) => {
    const harness = buildRouter({ catalog });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'workflow-invalid'
    });
    expect(harness.scheduled).toEqual([]);
    expect(harness.writes).toEqual([]);
  });
});

describe('FR-012 — a refused launch leaves no connected-run state behind', () => {
  it.each([
    ['gate 1', { workflowId: 'no-such-workflow' }, false],
    ['gate 2', { workflowId: 'broken-workflow', startNodeId: 'only' }, false],
    ['gate 3', { startNodeId: 'second' }, false],
    ['gate 3a', { request: runRequest({ pipelineId: 'solo-flow' }) }, false],
    ['gate 4', {}, true],
    ['gate 5', { request: runRequest({ inputs: [], outputs: [] }) }, false]
  ] as [string, Record<string, unknown>, boolean][])(
    'writes nothing when %s refuses',
    async (_label, overrides, noRoot) => {
      const harness = buildRouter();
      if (noRoot) mocks.workspaceRoot = null;
      try {
        await dispatch(harness, payload(overrides));
      } finally {
        mocks.workspaceRoot = WORKSPACE_ROOT;
      }

      expect(only(harness).ack.status).toBe('rejected');
      expect(harness.writes).toEqual([]);
    }
  );

  // The gate that could most plausibly have written first: the aggregate is
  // built in memory before validation, because gate 5 validates against the
  // Pipeline the run would freeze — and it is still discarded here.
  it('writes nothing when the queue refuses, after the aggregate was built', async () => {
    const harness = buildRouter({
      scheduleResult: { outcome: 'rejected-paused', reason: 'queue-paused' }
    });

    await dispatch(harness, payload());

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.writes).toEqual([]);
  });
});

describe('started — the accepted arm', () => {
  it('accepts and returns the run identifiers', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const { ack, result } = only(harness);
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toBeUndefined();
    expect(result).toEqual({
      outcome: 'started',
      connectedRunId: expect.any(String),
      revision: 2,
      queueItemId: 'queue-item-1'
    });
  });

  // The aggregate reaches storage exactly once, already carrying its first
  // attempt, and the write is a compare-and-set against revision 0 — which is
  // also the id-collision check.
  it('writes the aggregate once, with its first attempt already appended', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(harness.writes).toHaveLength(1);
    const write = harness.writes[0] as ConnectedRunWrite;
    expect(write.expectedRevision).toBe(0);
    expect(write.run.revision).toBe(2);
    expect(write.run.workflowId).toBe('ab-workflow');
    expect(write.run.nodes.first?.attempts.map((a) => a.queueItemId)).toEqual(['queue-item-1']);
    expect(Object.keys(write.run.nodes)).toEqual(['first']);
    expect(write.run.decisions).toEqual([]);
  });

  // The connected run id is minted host-side and never carried on the wire.
  it('mints the connected run id host-side', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const result = only(harness).result as Extract<LaunchWorkflowResult, { outcome: 'started' }>;
    expect(result.connectedRunId).toHaveLength(36);
    expect((harness.writes[0] as ConnectedRunWrite).run.connectedRunId).toBe(result.connectedRunId);
  });

  // FR-003/FR-004: every node's Pipeline is frozen up front, once per distinct
  // Pipeline, with the host's configured backend pinned into each Phase.
  it('freezes the node Pipelines with the host backend', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const frozen = (harness.writes[0] as ConnectedRunWrite).run.pipelines;
    expect(Object.keys(frozen)).toEqual(['ab-flow']);
    expect(frozen['ab-flow']?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
    expect(frozen['ab-flow']?.phases.map((phase) => phase.runner)).toEqual(['codex', 'codex']);
  });

  it('freezes the graph the run started against', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    const graph = (harness.writes[0] as ConnectedRunWrite).run.graph;
    expect(graph.nodes.map((node) => node.nodeId)).toEqual(['first', 'second']);
    expect(Object.isFrozen(graph)).toBe(true);
  });

  it('submits exactly one child run, labelled with the node', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]).toMatchObject({
      via: 'webview',
      pipelineId: 'ab-flow',
      description: 'First pass'
    });
  });

  it('names no absolute path in the accepted ack', async () => {
    const harness = buildRouter();

    await dispatch(harness, payload());

    expect(JSON.stringify(only(harness).ack)).not.toContain(WORKSPACE_ROOT);
  });

  // A colliding id is a caller defect — the id is minted per launch — so it is
  // refused rather than merged into a live run. The child is already queued and
  // stays queued: rolling it back would be a destructive write on a failure path.
  it('refuses a colliding connected run id without rolling back the child', async () => {
    const harness = buildRouter({ idInUse: true });

    await dispatch(harness, payload());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'workflow-invalid'
    });
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.warnings.join('\n')).toContain('already in use');
  });
});

describe('the result union — four arms and no fifth', () => {
  it('answers every scenario with one of the contract arms', async () => {
    const outcomes: string[] = [];
    const scenarios: [Record<string, unknown>, Parameters<typeof buildRouter>[0]][] = [
      [{}, {}],
      [{ workflowId: 'no-such-workflow' }, {}],
      [{ request: runRequest({ inputs: [], outputs: [] }) }, {}],
      [{}, { scheduleResult: { outcome: 'rejected-paused', reason: 'queue-paused' } }]
    ];

    for (const [overrides, opts] of scenarios) {
      const harness = buildRouter(opts);
      await dispatch(harness, payload(overrides));
      outcomes.push(only(harness).result.outcome);
    }

    expect(outcomes).toEqual([
      'started',
      'rejected-definition',
      'rejected-validation',
      'rejected-queue'
    ]);
  });
});
