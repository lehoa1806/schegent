// Feature 088 — shared fixtures for the connected-run integration suites
// (T027, T028, T052).
//
// One Workflow, one catalog, one set of requests, three suites. They share a
// fixture because the properties being pinned are properties of the same graph
// seen from three angles — a child that fails, two starts that race, and a
// catalog that moves under a run already going.
//
// Nothing below the launcher is faked: the deps wire the real
// `GuardedRunService`, `QueueManager`, and `WorkspaceStateStore` from
// `makeHarness()`. The only stand-in is the child run itself, because a child is
// a CLI process this suite has no business spawning — and its two seams are
// exactly the two ports the production code declares (`ChildRunSettledProbe` and
// `ChildRunFactsReader`), so the stand-in answers the same questions the host
// will.

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { RunRequest } from '../../../src/contracts/run-request';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';
import {
  recordChildTerminal,
  type ChildRunFacts,
  type ChildTerminalResult,
  type ConnectedRunCoordinatorDeps
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import {
  continueWorkflow,
  launchWorkflow,
  type ContinueWorkflowResult,
  type LaunchWorkflowResult,
  type WorkflowLauncherDeps
} from '../../../src/services/workflow-execution/workflow-launcher';
import type { Harness } from '../enqueue-start-separation.helpers';

export const NOW = 1_700_000_000_000;

const COMPOSE: PhaseDef = {
  id: 'compose',
  name: 'Compose',
  version: 1,
  instruction: 'Compose the thing.',
  sourceScope: 'built-in'
};
const REVIEW: PhaseDef = {
  id: 'review',
  name: 'Review',
  version: 1,
  instruction: 'Review the thing.',
  sourceScope: 'built-in'
};
const DONE: PhaseDef = {
  id: 'done',
  name: 'Done',
  version: 1,
  instruction: '(no-op)',
  sourceScope: 'built-in'
};

export const TRIAGE_FLOW: PipelineDef = {
  id: 'triage-flow',
  name: 'Triage Flow',
  phases: ['compose'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: [{ portId: 'verdict', label: 'Verdict', type: 'markdown' }]
};

/** Two Phases, so a reorder in the catalog is visible in what the run executes. */
export const SHIP_FLOW: PipelineDef = {
  id: 'ship-flow',
  name: 'Ship Flow',
  phases: ['compose', 'review'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'plan', label: 'Plan', type: 'text', required: true }],
  outputs: [{ portId: 'receipt', label: 'Receipt', type: 'markdown' }]
};

export const ROLLBACK_FLOW: PipelineDef = {
  id: 'rollback-flow',
  name: 'Rollback Flow',
  phases: ['review'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'reason', label: 'Reason', type: 'text' }],
  outputs: []
};

export const NOTIFY_FLOW: PipelineDef = {
  id: 'notify-flow',
  name: 'Notify Flow',
  phases: ['review'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'note', label: 'Note', type: 'text' }],
  outputs: []
};

/**
 * Four nodes, four connections.
 *
 * Connection 2 is the interesting one: it leaves `n-ship` but reads `n-triage`'s
 * output. Nothing restricts a condition to its own source node, and a condition
 * that reaches across is the only way to observe from the outside whether a
 * sibling's failure disturbed a completed node's recorded outputs (FR-050).
 *
 * Connection 3 branches on a `failed` status, which is an ordinary member of the
 * same closed status set `completed` belongs to (FR-052).
 */
export const RELEASE: WorkflowDefinition = {
  workflowId: 'release',
  name: 'Release',
  version: 1,
  nodes: [
    { nodeId: 'n-triage', pipelineId: 'triage-flow', label: 'Triage' },
    { nodeId: 'n-ship', pipelineId: 'ship-flow', label: 'Ship' },
    { nodeId: 'n-rollback', pipelineId: 'rollback-flow', label: 'Rollback' },
    { nodeId: 'n-notify', pipelineId: 'notify-flow', label: 'Notify' }
  ],
  connections: [
    {
      from: { nodeId: 'n-triage', portId: 'verdict' },
      to: { nodeId: 'n-ship', portId: 'plan' },
      condition: {
        left: { source: 'node-status', nodeId: 'n-triage' },
        operator: 'equals',
        right: 'completed'
      }
    },
    {
      from: { nodeId: 'n-triage', portId: 'verdict' },
      to: { nodeId: 'n-rollback', portId: 'reason' },
      isDefault: true
    },
    {
      from: { nodeId: 'n-ship', portId: 'receipt' },
      to: { nodeId: 'n-notify', portId: 'note' },
      condition: {
        left: { source: 'node-output', nodeId: 'n-triage', field: 'verdict' },
        operator: 'exists'
      }
    },
    {
      from: { nodeId: 'n-ship', portId: 'receipt' },
      to: { nodeId: 'n-rollback', portId: 'reason' },
      condition: {
        left: { source: 'node-status', nodeId: 'n-ship' },
        operator: 'equals',
        right: 'failed'
      }
    }
  ],
  startNodeIds: ['n-triage']
};

export function releaseCatalog(pipelines: readonly PipelineDef[] = [
  TRIAGE_FLOW,
  SHIP_FLOW,
  ROLLBACK_FLOW,
  NOTIFY_FLOW
]): PipelineCatalog {
  return buildCatalog(
    [COMPOSE, REVIEW, DONE],
    pipelines,
    { claude: [], codex: [], agy: [] },
    'triage-flow'
  );
}

/** Every request supplies each required input and targets each declared output. */
export const TRIAGE_REQUEST: RunRequest = {
  pipelineId: 'triage-flow',
  inputs: [{ portId: 'brief', type: 'text', value: 'assess the release' }],
  supplemental: [],
  outputs: [{ portId: 'verdict', target: 'reports/verdict.md' }]
};

export const SHIP_REQUEST: RunRequest = {
  pipelineId: 'ship-flow',
  inputs: [{ portId: 'plan', type: 'text', value: 'reports/verdict.md' }],
  supplemental: [],
  outputs: [{ portId: 'receipt', target: 'reports/receipt.md' }]
};

export const ROLLBACK_REQUEST: RunRequest = {
  pipelineId: 'rollback-flow',
  inputs: [],
  supplemental: [],
  outputs: []
};

export const NOTIFY_REQUEST: RunRequest = {
  pipelineId: 'notify-flow',
  inputs: [],
  supplemental: [],
  outputs: []
};

/** The reference a completed triage records for its declared output. */
export const VERDICT_OUTPUT: ChildRunFacts = {
  status: 'completed',
  outputs: [{ name: 'verdict', status: 'resolved', reference: 'reports/verdict.md' }]
};

/**
 * The child runs, as the host will see them.
 *
 * A queue item that exists and has not been settled here is a child that has not
 * finished; one the queue no longer holds answers settled, which is the rule
 * `ChildRunSettledProbe` documents — a queue item nothing holds is not executing.
 */
export class FakeChildRuns {
  private readonly terminal = new Map<string, ChildRunFacts>();

  constructor(private readonly harness: Harness) {}

  settle(queueItemId: string, facts: ChildRunFacts): void {
    this.terminal.set(queueItemId, facts);
  }

  readonly readChildFacts = (queueItemId: string): ChildRunFacts | null =>
    this.terminal.get(queueItemId) ?? null;

  readonly isChildSettled = (queueItemId: string): boolean =>
    this.terminal.has(queueItemId) ||
    !this.harness.store.getQueue('default').requests.some((row) => row.id === queueItemId);
}

export function makeLauncherDeps(
  harness: Harness,
  catalog: PipelineCatalog,
  children: FakeChildRuns
): WorkflowLauncherDeps {
  return {
    guardedRun: harness.service,
    getCatalog: () => catalog,
    defaultRunnerKind: 'claude',
    readPriorRunOutputs: () => null,
    logger: harness.logger as unknown as Pick<SanitizedLogger, 'warn' | 'sanitize'>,
    connectedRuns: harness.store,
    isChildSettled: children.isChildSettled
  };
}

export function makeCoordinatorDeps(
  harness: Harness,
  children: FakeChildRuns
): ConnectedRunCoordinatorDeps {
  return {
    connectedRuns: harness.store,
    readChildFacts: children.readChildFacts,
    logger: harness.logger as unknown as Pick<SanitizedLogger, 'warn'>
  };
}

export const CONNECTED_RUN_ID = 'connected-run-1';

export async function launchRelease(
  deps: WorkflowLauncherDeps,
  harness: Harness,
  catalog: PipelineCatalog,
  workflow: WorkflowDefinition = RELEASE
): Promise<LaunchWorkflowResult> {
  return launchWorkflow(deps, {
    connectedRunId: CONNECTED_RUN_ID,
    workflow,
    catalog,
    startNodeId: 'n-triage',
    request: TRIAGE_REQUEST,
    workspaceRoot: harness.workspaceRoot,
    startedAt: NOW,
    defaultRunnerKind: 'claude'
  });
}

/**
 * One continuation, submitted the way the handler will submit it: the stored run
 * is re-read here, while `expectedRevision` is whatever the payload carried. That
 * separation is the whole of FR-047 — a second identical payload arrives with a
 * revision the store has already moved past.
 */
export async function continueAt(
  deps: WorkflowLauncherDeps,
  harness: Harness,
  nodeId: string,
  request: RunRequest,
  expectedRevision?: number
): Promise<ContinueWorkflowResult> {
  const run = harness.store.getConnectedRun(CONNECTED_RUN_ID);
  if (run === null) throw new Error('the connected run was not stored');
  return continueWorkflow(deps, {
    run,
    expectedRevision: expectedRevision ?? run.revision,
    nodeId,
    request,
    workspaceRoot: harness.workspaceRoot,
    startedAt: NOW,
    // Gate 4's fold belongs to the projector (T038). Injected as accepting here
    // so the gates under test are the ones these suites are about.
    isNodeStartable: () => true
  });
}

/** Settle a child and record the routing decision its terminal state produces. */
export async function settleAndRoute(
  deps: ConnectedRunCoordinatorDeps,
  harness: Harness,
  children: FakeChildRuns,
  input: {
    readonly queueItemId: string;
    readonly nodeId: string;
    readonly attemptIndex: number;
    readonly facts: ChildRunFacts;
  }
): Promise<ChildTerminalResult> {
  children.settle(input.queueItemId, input.facts);
  const run = harness.store.getConnectedRun(CONNECTED_RUN_ID);
  if (run === null) throw new Error('the connected run was not stored');
  return recordChildTerminal(deps, {
    run,
    nodeId: input.nodeId,
    attemptIndex: input.attemptIndex,
    decidedAt: NOW
  });
}

/** The stored aggregate, for a test that wants to read it back out of the store. */
export function storedRun(harness: Harness): ConnectedWorkflowRun {
  const run = harness.store.getConnectedRun(CONNECTED_RUN_ID);
  if (run === null) throw new Error('the connected run was not stored');
  return run;
}
