// Feature 088 (T027) — what a child's failure does to everything around it.
//
// Three requirements meet here, and the interesting thing about all three is
// that they are properties of a *shape* rather than of a code path:
//
//   * FR-050 — a failed child cannot alter a completed node's recorded outputs.
//   * FR-051 — the connected run stays readable and is not itself marked failed;
//     an independently valid allowed node stays startable.
//   * FR-052 — a `failed` status routes like any other terminal status.
//
// A unit test of the coordinator would pass on all three by construction, which
// is precisely why it would prove nothing: the aggregate holds no outputs and no
// status, so "unchanged" and "not failed" are true of an object that never had
// the field. What this suite pins is the property from the outside — the failure
// travels through the real store, the real queue, and the real guarded-run
// service, and the run afterwards behaves as a run with a failed child rather
// than as a failed run.
//
// FR-050 is made externally observable by connection 2 of the fixture graph,
// which leaves `n-ship` but reads `n-triage`'s output (see `workflow-fixtures.ts`).
// If `n-ship`'s failure had disturbed the completed node's facts, that operand
// would resolve unresolved and the branch would not be offered. The assertion is
// on the offer, so it fails if the facts move.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineCatalog } from '../../../src/config/pipeline-config';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';
import type { ConnectedRunCoordinatorDeps } from '../../../src/services/workflow-execution/connected-run-coordinator';
import type { WorkflowLauncherDeps } from '../../../src/services/workflow-execution/workflow-launcher';
import {
  CONNECTED_RUN_ID,
  FakeChildRuns,
  ROLLBACK_REQUEST,
  SHIP_REQUEST,
  VERDICT_OUTPUT,
  continueAt,
  launchRelease,
  makeCoordinatorDeps,
  makeLauncherDeps,
  releaseCatalog,
  settleAndRoute,
  storedRun
} from './workflow-fixtures';

/** The closed key set of the aggregate, copied rather than imported on purpose. */
const AGGREGATE_KEYS = [
  'connectedRunId',
  'decisions',
  'graph',
  'nodes',
  'pipelines',
  'revision',
  'startedAt',
  'workflowId'
];

describe('a connected run whose child fails', () => {
  let harness: Harness;
  let catalog: PipelineCatalog;
  let children: FakeChildRuns;
  let launcher: WorkflowLauncherDeps;
  let coordinator: ConnectedRunCoordinatorDeps;

  beforeEach(async () => {
    catalog = releaseCatalog();
    harness = await makeHarness({ catalog });
    children = new FakeChildRuns(harness);
    launcher = makeLauncherDeps(harness, catalog, children);
    coordinator = makeCoordinatorDeps(harness, children);
  });

  afterEach(() => {
    harness.cleanup();
  });

  /**
   * Launch, complete the first node, and start the second — the state every
   * assertion below is made against.
   */
  async function runToShipStarted(): Promise<{ triage: string; ship: string }> {
    const launched = await launchRelease(launcher, harness, catalog);
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') throw new Error('unreachable');

    const routed = await settleAndRoute(coordinator, harness, children, {
      queueItemId: launched.queueItemId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });
    expect(routed.outcome).toBe('recorded');
    if (routed.outcome !== 'recorded') throw new Error('unreachable');
    // Connection 0 matched on `completed`, so the default (connection 1) was
    // held back and never evaluated.
    expect(routed.decision.eligible).toEqual([0]);
    expect(routed.decision.defaultApplied).toBe(false);

    const continued = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST);
    expect(continued.outcome).toBe('started');
    if (continued.outcome !== 'started') throw new Error('unreachable');

    return { triage: launched.queueItemId, ship: continued.queueItemId };
  }

  it('routes the failure and leaves the completed node byte-identical (FR-050, FR-052)', async () => {
    const ids = await runToShipStarted();

    const before = JSON.stringify(storedRun(harness).nodes['n-triage']);
    const decisionsBefore = JSON.stringify(storedRun(harness).decisions[0]);

    const routed = await settleAndRoute(coordinator, harness, children, {
      queueItemId: ids.ship,
      nodeId: 'n-ship',
      attemptIndex: 0,
      facts: { status: 'failed', outputs: [] }
    });

    // FR-052: `failed` is an ordinary member of the terminal status set, so
    // connection 3's `node-status n-ship equals 'failed'` matched. Nothing in
    // the selector distinguishes a success branch from a failure branch.
    expect(routed.outcome).toBe('recorded');
    if (routed.outcome !== 'recorded') throw new Error('unreachable');
    expect(routed.decision.nodeId).toBe('n-ship');
    expect(routed.decision.eligible).toEqual([2, 3]);
    expect(routed.decision.defaultApplied).toBe(false);
    expect(routed.decision.connections).toEqual([
      { index: 2, matched: true, isDefault: false },
      { index: 3, matched: true, isDefault: false }
    ]);

    // FR-050, seen from outside: connection 2 reads `n-triage.verdict`, and it
    // matched *after* the sibling failed. The completed node's recorded output
    // is still resolvable and still the same reference.
    expect(routed.decision.operands).toEqual([
      {
        source: 'node-output',
        nodeId: 'n-triage',
        field: 'verdict',
        resolved: true,
        compared: 'reports/verdict.md'
      },
      { source: 'node-status', nodeId: 'n-ship', resolved: true, compared: 'failed' }
    ]);

    // FR-050, seen from inside: the completed node's record did not move a byte.
    expect(JSON.stringify(storedRun(harness).nodes['n-triage'])).toBe(before);
    expect(storedRun(harness).nodes['n-triage'].attempts).toHaveLength(1);

    // FR-030: decisions are append-only. The first is untouched, the second is
    // appended after it.
    const after = storedRun(harness);
    expect(after.decisions).toHaveLength(2);
    expect(JSON.stringify(after.decisions[0])).toBe(decisionsBefore);
    expect(after.decisions[1]?.nodeId).toBe('n-ship');

    // SC-010: the attempt record still carries a queue reference and a time and
    // nothing else — no status, no outputs, no path.
    expect(Object.keys(after.nodes['n-triage']!.attempts[0]!).sort()).toEqual([
      'queueItemId',
      'startedAt'
    ]);
    expect(after.nodes['n-triage']!.attempts[0]!.queueItemId).toBe(ids.triage);
  });

  it('stays readable, unfailed, and startable at an allowed node (FR-051)', async () => {
    const ids = await runToShipStarted();

    await settleAndRoute(coordinator, harness, children, {
      queueItemId: ids.ship,
      nodeId: 'n-ship',
      attemptIndex: 0,
      facts: { status: 'failed', outputs: [] }
    });

    // Readable, and with no field a failure could have been written into: the
    // aggregate's key set is closed and holds no status or lifecycle member.
    const after = harness.store.getConnectedRun(CONNECTED_RUN_ID);
    expect(after).not.toBeNull();
    expect(Object.keys(after!).sort()).toEqual(AGGREGATE_KEYS);
    expect(after!.connectedRunId).toBe(CONNECTED_RUN_ID);
    expect(after!.workflowId).toBe('release');

    // Startable: connection 3 offered `n-rollback`, and it starts like any other
    // node — a real enqueue through the real guarded-run service.
    const queuedBefore = harness.store.getQueue('default').requests.length;
    const rollback = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST);
    expect(rollback.outcome).toBe('started');
    if (rollback.outcome !== 'started') throw new Error('unreachable');
    expect(harness.store.getQueue('default').requests).toHaveLength(queuedBefore + 1);
    expect(storedRun(harness).nodes['n-rollback']!.attempts).toHaveLength(1);
    expect(storedRun(harness).nodes['n-rollback']!.attempts[0]!.queueItemId).toBe(
      rollback.queueItemId
    );

    // And the failed node is still recorded as one attempt, not retried or
    // rewritten by the start of a sibling.
    expect(storedRun(harness).nodes['n-ship']!.attempts).toHaveLength(1);
  });

  it('re-offers the same branches when the same terminal event is replayed (FR-030)', async () => {
    const ids = await runToShipStarted();

    const first = await settleAndRoute(coordinator, harness, children, {
      queueItemId: ids.ship,
      nodeId: 'n-ship',
      attemptIndex: 0,
      facts: { status: 'failed', outputs: [] }
    });
    const second = await settleAndRoute(coordinator, harness, children, {
      queueItemId: ids.ship,
      nodeId: 'n-ship',
      attemptIndex: 0,
      facts: { status: 'failed', outputs: [] }
    });

    expect(first.outcome).toBe('recorded');
    expect(second.outcome).toBe('recorded');
    if (first.outcome !== 'recorded' || second.outcome !== 'recorded') {
      throw new Error('unreachable');
    }
    // A replayed event appends rather than rewrites, and computes the same
    // answer from the same facts. The trail records that it was evaluated twice.
    expect(second.decision.eligible).toEqual(first.decision.eligible);
    expect(storedRun(harness).decisions).toHaveLength(3);
    expect(JSON.stringify(storedRun(harness).decisions[1])).toBe(JSON.stringify(first.decision));
  });

  it('refuses to route an attempt that never finished (SC-011)', async () => {
    const launched = await launchRelease(launcher, harness, catalog);
    expect(launched.outcome).toBe('started');

    // Not settled: the probe reports the queue still holds the row.
    const routed = await settleAndRoute(coordinator, harness, children, {
      queueItemId: 'not-an-attempt-of-this-run',
      nodeId: 'n-triage',
      attemptIndex: 1,
      facts: { status: 'failed', outputs: [] }
    });

    expect(routed).toEqual({ outcome: 'ignored', reason: 'unknown-attempt' });
    expect(storedRun(harness).decisions).toHaveLength(0);
  });
});
