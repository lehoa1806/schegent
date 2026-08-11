// Feature 088 (T052) — the freeze, from the outside.
//
// A connected run consults the effective catalog exactly once, at launch, and
// from then on executes what it froze (FR-003, FR-004, FR-005, SC-003). Three
// separate edits are made to the catalog *after* the run starts, each one a way
// the freeze could plausibly leak:
//
//   1. the Workflow definition is edited in place — nodes reordered, an unreached
//      node removed, a connection dropped. If the snapshot aliased the catalog's
//      object rather than deep-copying it, the run's own graph would change under
//      it with no write and no revision bump.
//   2. a referenced Pipeline's Phase list is reordered. If the start path
//      re-resolved the Pipeline by id, the child would execute the new order —
//      a substitution the operator never approved, and invisible in the run
//      record because the id did not change.
//   3. a referenced Pipeline is deleted outright. If any gate on the start path
//      still required catalog membership, the node would become unstartable and
//      the run would be stranded mid-graph.
//
// The edits are made to the very catalog object the harness's `GuardedRunService`
// reads through its `catalogProvider`, so "the catalog moved" here means the
// effective catalog moved — not that a stub was swapped for another stub.
//
// The third case is the one with teeth: it is what
// `GuardedRunService.validatePipelineId` had to stop requiring, because a
// composed row carries the definition it will execute and the drain path never
// re-resolves it. Everything above the queue was already snapshot-driven; that
// gate was the last catalog read on the path.
//
// No substitution and no fallback: every assertion below is on what the run
// *executes*, not on what it reports.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineCatalog, PipelineDef } from '../../../src/config/pipeline-config';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowNode
} from '../../../src/contracts/workflow-definitions';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';
import type { ConnectedRunCoordinatorDeps } from '../../../src/services/workflow-execution/connected-run-coordinator';
import type { WorkflowLauncherDeps } from '../../../src/services/workflow-execution/workflow-launcher';
import {
  FakeChildRuns,
  RELEASE,
  ROLLBACK_REQUEST,
  SHIP_FLOW,
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

/** A mutable, structurally identical copy — the catalog's copy, not the fixture's. */
function editableRelease(): WorkflowDefinition {
  return JSON.parse(JSON.stringify(RELEASE)) as WorkflowDefinition;
}

/**
 * The catalog the harness's `GuardedRunService` reads, with its index held
 * separately so the suite can edit the **effective** catalog after the run has
 * started. Editing it is the point: a swapped stub would only prove the run
 * ignores a stub, whereas these tests need the object the service actually
 * consults to no longer describe what the run is executing.
 */
function movableCatalog(): {
  readonly catalog: PipelineCatalog;
  readonly index: Map<string, PipelineDef>;
} {
  const base = releaseCatalog();
  const index = new Map(base.pipelinesById);
  return { catalog: { ...base, pipelinesById: index }, index };
}

/** The queue row a start produced, as the drain path will read it. */
function rowFor(harness: Harness, queueItemId: string): FeatureRequest {
  const row = harness.store.getQueue().requests.find((request) => request.id === queueItemId);
  if (row === undefined) throw new Error(`queue row ${queueItemId} is missing`);
  return row;
}

describe('a connected run whose catalog moves under it', () => {
  let harness: Harness;
  let catalog: PipelineCatalog;
  let index: Map<string, PipelineDef>;
  let children: FakeChildRuns;
  let launcher: WorkflowLauncherDeps;
  let coordinator: ConnectedRunCoordinatorDeps;
  let workflow: WorkflowDefinition;

  beforeEach(async () => {
    ({ catalog, index } = movableCatalog());
    harness = await makeHarness({ catalog });
    children = new FakeChildRuns(harness);
    launcher = makeLauncherDeps(harness, catalog, children);
    coordinator = makeCoordinatorDeps(harness, children);
    workflow = editableRelease();
  });

  afterEach(() => {
    harness.cleanup();
  });

  /**
   * Launch against the catalog as it stands, complete the first node, then move
   * the catalog under the running connected run: reorder `ship-flow`'s Phases,
   * delete `rollback-flow`, and edit the Workflow definition in place.
   */
  async function launchThenMoveCatalog(): Promise<void> {
    const launched = await launchRelease(launcher, harness, catalog, workflow);
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') throw new Error('unreachable');

    const routed = await settleAndRoute(coordinator, harness, children, {
      queueItemId: launched.queueItemId,
      nodeId: 'n-triage',
      attemptIndex: 0,
      facts: VERDICT_OUTPUT
    });
    expect(routed.outcome).toBe('recorded');

    // (2) and (3): a referenced Pipeline's Phase order changes, and another
    // referenced Pipeline is removed from the catalog entirely.
    index.set('ship-flow', { ...SHIP_FLOW, phases: ['review', 'compose'] });
    index.delete('rollback-flow');

    // (1): the definition the run was launched from is edited in place.
    const nodes = workflow.nodes as WorkflowNode[];
    nodes.reverse();
    nodes.splice(
      nodes.findIndex((node) => node.nodeId === 'n-notify'),
      1
    );
    (workflow.connections as WorkflowConnection[]).splice(2, 1);
  }

  it('keeps its own graph when the catalog definition is edited (FR-003)', async () => {
    await launchThenMoveCatalog();

    const graph = storedRun(harness).graph;
    expect(graph.nodes.map((node) => node.nodeId)).toEqual([
      'n-triage',
      'n-ship',
      'n-rollback',
      'n-notify'
    ]);
    expect(graph.connections).toHaveLength(4);
    expect(graph.connections[2]?.to.nodeId).toBe('n-notify');
    expect(graph.startNodeIds).toEqual(['n-triage']);

    // And the source really did move, so the assertion above is a difference
    // rather than a coincidence.
    expect(workflow.nodes.map((node) => node.nodeId)).toEqual([
      'n-rollback',
      'n-ship',
      'n-triage'
    ]);
    expect(workflow.connections).toHaveLength(3);

    // Deep-copied and deep-frozen, so the run's graph cannot be edited in place
    // either — by the catalog or by anything holding a reference to it.
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(() => (graph.nodes as WorkflowNode[]).push({ nodeId: 'x', pipelineId: 'y' })).toThrow(
      TypeError
    );
    expect(() => {
      (graph.nodes[0] as { nodeId: string }).nodeId = 'renamed';
    }).toThrow(TypeError);
  });

  it('executes the Phase order it froze, not the reordered one (FR-004)', async () => {
    await launchThenMoveCatalog();

    const started = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST);
    expect(started.outcome).toBe('started');
    if (started.outcome !== 'started') throw new Error('unreachable');

    // What the drain path will execute: the row's own plan, never a re-resolution.
    const plan = rowFor(harness, started.queueItemId).runPlan;
    expect(plan).toBeDefined();
    expect(plan!.pipeline.id).toBe('ship-flow');
    expect(plan!.pipeline.phases.map((phase) => phase.id)).toEqual(['compose', 'review']);

    // The effective catalog holds the other order.
    expect(catalog.pipelinesById.get('ship-flow')!.phases).toEqual(['review', 'compose']);
  });

  it('starts a node whose Pipeline the catalog no longer holds (FR-005, SC-003)', async () => {
    await launchThenMoveCatalog();

    const started = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST);
    expect(started.outcome).toBe('started');
    if (started.outcome !== 'started') throw new Error('unreachable');

    const plan = rowFor(harness, started.queueItemId).runPlan;
    expect(plan).toBeDefined();
    expect(plan!.pipeline.id).toBe('rollback-flow');
    expect(plan!.pipeline.phases.map((phase) => phase.id)).toEqual(['review']);
    expect(storedRun(harness).nodes['n-rollback']!.attempts).toHaveLength(1);
    expect(catalog.pipelinesById.has('rollback-flow')).toBe(false);
  });

  it('offers a removed node and refuses one the frozen graph never had (FR-003)', async () => {
    await launchThenMoveCatalog();

    // `n-notify` is gone from the catalog definition, but the run froze it, so it
    // is still part of this run's graph and still addressable.
    expect(storedRun(harness).graph.nodes.some((node) => node.nodeId === 'n-notify')).toBe(true);
    expect(storedRun(harness).pipelines['notify-flow']).toBeDefined();

    // A node the frozen graph never held is refused on the run's own authority —
    // not on the catalog's, which is where a fallback would have looked.
    const absent = await continueAt(launcher, harness, 'n-audit', ROLLBACK_REQUEST);
    expect(absent.outcome).toBe('rejected-state');
    if (absent.outcome !== 'rejected-state') throw new Error('unreachable');
    expect(absent.reason).toBe('node-not-eligible');
  });
});
