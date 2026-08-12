// Feature 092 (T073-T076, US3 / Slice A) — a connected run is bound to ONE
// queue, and every child it starts enqueues there.
//
// Decision D1 settled the shape this suite pins: a Workflow executes as N
// Tasks coordinated by one queue-bound aggregate. So the binding is a property
// of the aggregate (FR-041), it is fixed when the run opens, and it decides the
// queue of every child the run ever starts — the first one and each successor
// (FR-042). Node-to-node advance stays operator-triggered (FR-044): settling a
// child records a routing decision and nothing else moves until an operator
// submits a continuation.
//
// Nothing below the launcher is faked. The deps wire the real
// `GuardedRunService`, `QueueManager` and `WorkspaceStateStore` from
// `makeHarness()`, so "the child landed in queue X" is read from the store the
// host writes rather than from a spy on the call.
//
// The one stand-in is the child run itself, and it is deliberately NOT the
// fixture's `FakeChildRuns`: that probe reads `store.getQueue()` with no
// argument, so a child living in a non-default queue reads as settled — which
// is exactly the confusion this suite exists to catch. `MultiQueueChildRuns`
// below asks every queue instead.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../../src/contracts/run-request';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { resolveBoundQueueId } from '../../src/state/connected-workflow-run';
import type { ChildRunFacts } from '../../src/services/workflow-execution/connected-run-coordinator';
import { recordChildTerminal } from '../../src/services/workflow-execution/connected-run-coordinator';
import {
  continueWorkflow,
  launchWorkflow,
  type ContinueWorkflowResult,
  type LaunchWorkflowResult,
  type WorkflowLauncherDeps
} from '../../src/services/workflow-execution/workflow-launcher';
import type { SanitizedLogger } from '../../src/lib/logger';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';
import {
  NOW,
  RELEASE,
  SHIP_REQUEST,
  TRIAGE_REQUEST,
  VERDICT_OUTPUT,
  releaseCatalog
} from './workflow-execution/workflow-fixtures';

/**
 * A child-run stand-in that knows the workspace has more than one queue.
 *
 * Same rule as the single-queue probe it replaces — a queue item nothing holds
 * is not executing — asked across every persisted queue rather than the default
 * one. Getting this wrong makes a child in queue X read as already settled,
 * which would let the FR-044 gate pass while the child is still running.
 */
class MultiQueueChildRuns {
  private readonly terminal = new Map<string, ChildRunFacts>();

  constructor(private readonly harness: Harness) {}

  settle(queueItemId: string, facts: ChildRunFacts): void {
    this.terminal.set(queueItemId, facts);
  }

  readonly readChildFacts = (queueItemId: string): ChildRunFacts | null =>
    this.terminal.get(queueItemId) ?? null;

  readonly isChildSettled = (queueItemId: string): boolean =>
    this.terminal.has(queueItemId) ||
    !Object.values(this.harness.store.getQueueStates()).some((queue) =>
      queue.requests.some((row) => row.id === queueItemId)
    );
}

const catalog = releaseCatalog();

let harness: Harness;
let children: MultiQueueChildRuns;
let deps: WorkflowLauncherDeps;
/** The non-default queue the connected runs below bind to. */
let releaseQueueId: string;

beforeEach(async () => {
  harness = await makeHarness({ catalog });
  children = new MultiQueueChildRuns(harness);
  deps = {
    guardedRun: harness.service,
    getCatalog: () => catalog,
    defaultRunnerKind: 'claude',
    readPriorRunOutputs: () => null,
    logger: harness.logger as unknown as Pick<SanitizedLogger, 'warn' | 'sanitize'>,
    connectedRuns: harness.store,
    isChildSettled: children.isChildSettled
  };
  const created = await harness.queue.createQueue('Release');
  expect(created.ok).toBe(true);
  releaseQueueId = created.queueId as string;
});

afterEach(() => {
  harness.cleanup();
});

/** Open a connected run bound to `queueId`, starting at `n-triage`. */
async function launchBound(
  connectedRunId: string,
  queueId: string | undefined
): Promise<LaunchWorkflowResult> {
  return launchWorkflow(deps, {
    connectedRunId,
    workflow: RELEASE,
    catalog,
    startNodeId: 'n-triage',
    request: TRIAGE_REQUEST,
    workspaceRoot: harness.workspaceRoot,
    startedAt: NOW,
    defaultRunnerKind: 'claude',
    ...(queueId !== undefined ? { queueId } : {})
  });
}

/**
 * Start one more node, the way the handler does.
 *
 * No `queueId` argument, deliberately: the binding was fixed at launch, so the
 * only thing a continuation may do is honour it. A parameter here would be a
 * second place the queue is decided, and a run could change queues mid-graph.
 */
async function continueBound(
  connectedRunId: string,
  nodeId: string,
  request: RunRequest
): Promise<ContinueWorkflowResult> {
  const run = harness.store.getConnectedRun(connectedRunId);
  if (run === null) throw new Error('the connected run was not stored');
  return continueWorkflow(deps, {
    run,
    expectedRevision: run.revision,
    nodeId,
    request,
    workspaceRoot: harness.workspaceRoot,
    startedAt: NOW,
    isNodeStartable: () => true
  });
}

/** Settle a child and record the routing decision its terminal state produces. */
async function settleAndRoute(
  connectedRunId: string,
  input: {
    readonly queueItemId: string;
    readonly nodeId: string;
    readonly attemptIndex: number;
    readonly facts: ChildRunFacts;
  }
): Promise<void> {
  children.settle(input.queueItemId, input.facts);
  const run = harness.store.getConnectedRun(connectedRunId);
  if (run === null) throw new Error('the connected run was not stored');
  const routed = await recordChildTerminal(
    {
      connectedRuns: harness.store,
      readChildFacts: children.readChildFacts,
      logger: harness.logger as unknown as Pick<SanitizedLogger, 'warn'>
    },
    { run, nodeId: input.nodeId, attemptIndex: input.attemptIndex, decidedAt: NOW }
  );
  expect(routed.outcome).toBe('recorded');
}

/** The ids of every Task the named queue holds, in position order. */
function taskIdsIn(queueId: string): readonly string[] {
  return harness.store.getRequestsForQueue(queueId).map((row) => row.id);
}

function startedOrThrow(result: LaunchWorkflowResult | ContinueWorkflowResult): string {
  if (result.outcome !== 'started') {
    throw new Error(`expected a started run, got ${result.outcome}`);
  }
  return result.queueItemId;
}

describe('T073 (FR-042, SC-006, US3 scenario 1) — every child enqueues into the bound queue', () => {
  it('routes the first child into the bound queue and into no other', async () => {
    const launched = await launchBound('cr-bound', releaseQueueId);
    const childId = startedOrThrow(launched);

    expect(taskIdsIn(releaseQueueId)).toContain(childId);
    expect(taskIdsIn(DEFAULT_QUEUE_ID)).not.toContain(childId);
    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toHaveLength(0);
  });

  it('records the binding on the aggregate, where it is fixed for the run', async () => {
    await launchBound('cr-bound', releaseQueueId);

    const stored = harness.store.getConnectedRun('cr-bound');
    expect(stored).not.toBeNull();
    expect(resolveBoundQueueId(stored!)).toBe(releaseQueueId);
  });

  it('binds an unbound launch to the default queue rather than to nothing', async () => {
    const launched = await launchBound('cr-default', undefined);
    const childId = startedOrThrow(launched);

    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toContain(childId);
    expect(taskIdsIn(releaseQueueId)).toHaveLength(0);
    expect(resolveBoundQueueId(harness.store.getConnectedRun('cr-default')!)).toBe(
      DEFAULT_QUEUE_ID
    );
  });

  it('keeps two runs bound to different queues apart', async () => {
    const boundChild = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    const defaultChild = startedOrThrow(await launchBound('cr-default', undefined));

    expect(taskIdsIn(releaseQueueId)).toEqual([boundChild]);
    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toEqual([defaultChild]);
  });
});

describe('T074 (FR-044, US3 scenario 2) — advance is operator-triggered, and stays in the queue', () => {
  it('does not advance the graph when a child settles', async () => {
    const childId = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await settleAndRoute('cr-bound', {
      queueItemId: childId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });

    // The decision is recorded; nothing was started because of it.
    const run = harness.store.getConnectedRun('cr-bound')!;
    expect(run.decisions).toHaveLength(1);
    expect(Object.values(run.nodes).flatMap((node) => node.attempts)).toHaveLength(1);
    expect(taskIdsIn(releaseQueueId)).toEqual([childId]);
    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toHaveLength(0);
  });

  it('arms no timer that would traverse the graph on its own', async () => {
    const childId = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await settleAndRoute('cr-bound', {
      queueItemId: childId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });

    // No live timer at all: the only timers this harness arms are scheduled
    // starts, and this run asked for none. Firing every due timer therefore
    // must not produce a successor.
    expect(harness.fakeTimer.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    harness.fakeTimer.fireDue(harness.clock.now() + 60 * 60 * 1000);
    expect(taskIdsIn(releaseQueueId)).toEqual([childId]);
  });

  it('lands the operator-triggered successor in the same bound queue', async () => {
    const childId = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await settleAndRoute('cr-bound', {
      queueItemId: childId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });

    const successorId = startedOrThrow(await continueBound('cr-bound', 'n-ship', SHIP_REQUEST));

    expect(taskIdsIn(releaseQueueId)).toEqual([childId, successorId]);
    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toHaveLength(0);
    // And the binding did not move underneath the run.
    expect(resolveBoundQueueId(harness.store.getConnectedRun('cr-bound')!)).toBe(releaseQueueId);
  });
});

describe('T075 (FR-043, US3 scenario 3) — pausing the bound queue stops the run advancing', () => {
  it('refuses the successor while the bound queue is paused', async () => {
    const childId = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await settleAndRoute('cr-bound', {
      queueItemId: childId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });

    const paused = await harness.queue.setQueuePausedState(true, releaseQueueId, 'operator');
    expect(paused.ok).toBe(true);

    const refused = await continueBound('cr-bound', 'n-ship', SHIP_REQUEST);
    expect(refused.outcome).toBe('rejected-queue');
    expect(taskIdsIn(releaseQueueId)).toEqual([childId]);
  });

  it('leaves a run bound to another queue unaffected', async () => {
    const boundChild = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await harness.queue.setQueuePausedState(true, releaseQueueId, 'operator');

    // A different connected run, bound to the default queue, still starts.
    const otherChild = startedOrThrow(await launchBound('cr-default', undefined));

    expect(taskIdsIn(DEFAULT_QUEUE_ID)).toEqual([otherChild]);
    expect(taskIdsIn(releaseQueueId)).toEqual([boundChild]);
    expect(harness.store.getQueue(DEFAULT_QUEUE_ID).paused).toBe(false);
    expect(harness.store.getQueue(releaseQueueId).paused).toBe(true);
  });

  it('lets the run advance again once the bound queue resumes', async () => {
    const childId = startedOrThrow(await launchBound('cr-bound', releaseQueueId));
    await settleAndRoute('cr-bound', {
      queueItemId: childId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });
    await harness.queue.setQueuePausedState(true, releaseQueueId, 'operator');
    expect((await continueBound('cr-bound', 'n-ship', SHIP_REQUEST)).outcome).toBe(
      'rejected-queue'
    );

    await harness.queue.setQueuePausedState(false, releaseQueueId);
    const successorId = startedOrThrow(await continueBound('cr-bound', 'n-ship', SHIP_REQUEST));
    expect(taskIdsIn(releaseQueueId)).toEqual([childId, successorId]);
  });
});

describe('T076 (US3 scenario 4) — a draining queue advances one connected run at a time', () => {
  it('holds the second run behind the first, per queue rather than per workspace', async () => {
    const firstChild = startedOrThrow(await launchBound('cr-one', releaseQueueId));
    const secondChild = startedOrThrow(await launchBound('cr-two', releaseQueueId));
    expect(taskIdsIn(releaseQueueId)).toEqual([firstChild, secondChild]);

    // The first run's child takes the queue's single execution slot.
    await harness.queue.markInFlight(firstChild, 'run-1');

    // The second run's child is next in line and stays there: the queue that
    // would dispatch it has no capacity, so at most one connected run's child
    // is advancing inside this queue at any moment.
    expect(harness.queue.peekNextPending(releaseQueueId)?.id).toBe(secondChild);
    expect(harness.queue.hasQueueCapacity(releaseQueueId)).toBe(false);

    // The constraint is the queue's, not the workspace's: another queue is
    // still free to advance its own run.
    expect(harness.queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(true);
    expect(harness.queue.hasWorkspaceCapacity()).toBe(true);
  });

  it('lets the second run advance once the first run releases the slot', async () => {
    const firstChild = startedOrThrow(await launchBound('cr-one', releaseQueueId));
    const secondChild = startedOrThrow(await launchBound('cr-two', releaseQueueId));

    await harness.queue.markInFlight(firstChild, 'run-1');
    await harness.queue.finish(firstChild, 'completed');

    expect(harness.queue.hasQueueCapacity(releaseQueueId)).toBe(true);
    expect(harness.queue.peekNextPending(releaseQueueId)?.id).toBe(secondChild);
  });
});
