// Feature 088 (T047) — the manual gate, end to end.
//
// FR-040 is a negative requirement, and a negative requirement is only worth
// testing where it could plausibly fail. The interesting moment is not "one
// branch matched and was not taken" — it is a completed node that leaves **two**
// eligible branches: the graph has enough information to pick, the run has
// enough information to pick, and the whole point is that neither does. What
// SC-001 asks for is that the offer sits there until an operator submits one.
//
// The shared `RELEASE` fixture cannot show that on its own: its second
// connection out of `n-triage` is `isDefault: true`, which `selectNextNodes()`
// holds back once any explicit condition has matched (FR-027), so completing
// triage yields exactly one eligible branch. This suite therefore replaces that
// one connection with an explicit condition that also matches on completion —
// the smallest edit that produces the two-way offer, and the only difference
// from the fixture every other suite uses.
//
// "Then or later" is pinned by pumping the mechanisms that could conceivably
// act on their own: the clock advances, every due timer fires, the auto-drain
// coordinator runs, and the terminal event is routed a second time. None of
// them is a workflow scheduler — that is the claim, and the pump is what turns
// it from an absence of code into an observation.
//
// The second test is the other half of FR-039: what the operator submits is
// what runs. The incoming connection carries `reports/verdict.md` into
// `n-ship`'s `plan` port, so every submitted value below is deliberately
// *different* from what a prefill would have offered. The assertion is on the
// queue row's own `runPlan` — what the drain path will execute — and not on the
// launcher's return value, which could agree with the request while the row
// disagreed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineCatalog } from '../../../src/config/pipeline-config';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import type { RunRequest } from '../../../src/contracts/run-request';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';
import type { ConnectedRunCoordinatorDeps } from '../../../src/services/workflow-execution/connected-run-coordinator';
import type { WorkflowLauncherDeps } from '../../../src/services/workflow-execution/workflow-launcher';
import {
  CONNECTED_RUN_ID,
  FakeChildRuns,
  RELEASE,
  VERDICT_OUTPUT,
  continueAt,
  launchRelease,
  makeCoordinatorDeps,
  makeLauncherDeps,
  releaseCatalog,
  settleAndRoute,
  storedRun
} from './workflow-fixtures';

/** The `isDefault` connection of the shared fixture, by authored position. */
const DEFAULT_CONNECTION_INDEX = 1;

/**
 * `RELEASE` with both branches out of `n-triage` explicit.
 *
 * The replacement condition reads the completed node's own recorded output, so
 * it matches on exactly the terminal state connection 0 matches on and the two
 * become eligible together. Nothing else about the graph changes.
 */
function branchingRelease(): WorkflowDefinition {
  const connections = RELEASE.connections.map((connection, index) =>
    index === DEFAULT_CONNECTION_INDEX
      ? {
          from: connection.from,
          to: connection.to,
          condition: {
            left: { source: 'node-output' as const, nodeId: 'n-triage', field: 'verdict' },
            operator: 'exists' as const
          }
        }
      : connection
  );
  return { ...RELEASE, connections };
}

/** What the operator composes for `n-ship` — none of it derivable from a prefill. */
const OPERATOR_SHIP_REQUEST: RunRequest = {
  pipelineId: 'ship-flow',
  inputs: [{ portId: 'plan', type: 'text', value: 'ship the hotfix first, not the release' }],
  supplemental: [{ kind: 'text', text: 'the on-call thread says the verdict is stale' }],
  outputs: [{ portId: 'receipt', target: 'reports/operator-receipt.md' }],
  instructions: 'Keep the change set to the hotfix.'
};

/** The queue row a start produced, as the drain path will read it. */
function rowFor(harness: Harness, queueItemId: string): FeatureRequest {
  const row = harness.store.getQueue('default').requests.find((request) => request.id === queueItemId);
  if (row === undefined) throw new Error(`queue row ${queueItemId} is missing`);
  return row;
}

/** Which nodes the run has actually started, in the order it recorded them. */
function startedNodes(harness: Harness): readonly string[] {
  return Object.keys(storedRun(harness).nodes);
}

describe('a connected run whose completed node offers two branches', () => {
  let harness: Harness;
  let catalog: PipelineCatalog;
  let children: FakeChildRuns;
  let launcher: WorkflowLauncherDeps;
  let coordinator: ConnectedRunCoordinatorDeps;
  let workflow: WorkflowDefinition;
  let triageQueueItemId: string;

  beforeEach(async () => {
    catalog = releaseCatalog();
    harness = await makeHarness({ catalog });
    children = new FakeChildRuns(harness);
    launcher = makeLauncherDeps(harness, catalog, children);
    coordinator = makeCoordinatorDeps(harness, children);
    workflow = branchingRelease();
  });

  afterEach(() => {
    harness.cleanup();
  });

  /** Start the run, complete `n-triage`, and return what the routing decided. */
  async function completeTriage() {
    const launched = await launchRelease(launcher, harness, catalog, workflow);
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') throw new Error('unreachable');
    triageQueueItemId = launched.queueItemId;

    const routed = await settleAndRoute(coordinator, harness, children, {
      queueItemId: launched.queueItemId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });
    expect(routed.outcome).toBe('recorded');
    if (routed.outcome !== 'recorded') throw new Error('unreachable');
    return routed;
  }

  it('offers both branches and starts neither, then or later (FR-040, SC-001)', async () => {
    const routed = await completeTriage();

    // Both explicit conditions matched, so the offer is genuinely two-way and
    // the default was never reached.
    expect(routed.decision.eligible).toEqual([0, DEFAULT_CONNECTION_INDEX]);
    expect(routed.decision.defaultApplied).toBe(false);
    const offered = routed.decision.eligible.map(
      (index) => storedRun(harness).graph.connections[index]!.to.nodeId
    );
    expect(offered).toEqual(['n-ship', 'n-rollback']);

    // Then: the run recorded a decision and started nothing.
    expect(startedNodes(harness)).toEqual(['n-triage']);
    expect(harness.store.getQueue('default').requests.map((row) => row.id)).toEqual([triageQueueItemId]);

    // Later: pump every mechanism that acts without an operator.
    harness.clock.advance(6 * 60 * 60 * 1000);
    harness.fakeTimer.fireDue(harness.clock.now());
    await harness.autoDrain.drainIfIdle();
    const rerouted = await settleAndRoute(coordinator, harness, children, {
      queueItemId: triageQueueItemId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });
    expect(rerouted.outcome).toBe('recorded');

    // Still nothing. The second evaluation appended a second decision — the
    // trail grew, the run did not.
    expect(startedNodes(harness)).toEqual(['n-triage']);
    expect(harness.store.getQueue('default').requests.map((row) => row.id)).toEqual([triageQueueItemId]);
    expect(storedRun(harness).decisions).toHaveLength(2);
  });

  it('runs what the operator submitted, on the branch the operator chose (FR-039)', async () => {
    await completeTriage();

    const started = await continueAt(launcher, harness, 'n-ship', OPERATOR_SHIP_REQUEST);
    expect(started.outcome).toBe('started');
    if (started.outcome !== 'started') throw new Error('unreachable');

    // One branch was chosen; the other stayed an offer.
    expect(startedNodes(harness)).toEqual(['n-triage', 'n-ship']);
    expect(storedRun(harness).nodes['n-rollback']).toBeUndefined();

    // What the drain path will execute is the submission, not the connection's
    // carried value and not the Pipeline's declared default.
    const plan = rowFor(harness, started.queueItemId).runPlan;
    expect(plan).toBeDefined();
    expect(plan!.pipeline.id).toBe('ship-flow');
    expect(plan!.inputs).toEqual([
      { portId: 'plan', type: 'text', value: 'ship the hotfix first, not the release' }
    ]);
    expect(plan!.supplemental).toEqual([
      { kind: 'text', value: 'the on-call thread says the verdict is stale' }
    ]);
    expect(plan!.outputs).toEqual([
      {
        portId: 'receipt',
        type: 'markdown',
        target: 'reports/operator-receipt.md',
        overwriteConfirmed: false
      }
    ]);
    expect(plan!.instructions).toBe('Keep the change set to the hotfix.');

    // The carried value really was different, so the assertion above is a
    // difference rather than a coincidence.
    expect(VERDICT_OUTPUT.outputs[0]!.reference).toBe('reports/verdict.md');

    // And the run holds the association: the queue row is an ordinary row, and
    // the aggregate is the only thing that knows it belongs to `n-ship` (FR-067).
    expect(storedRun(harness).nodes['n-ship']!.attempts.map((a) => a.queueItemId)).toEqual([
      started.queueItemId
    ]);
    expect(storedRun(harness).connectedRunId).toBe(CONNECTED_RUN_ID);
  });
});
