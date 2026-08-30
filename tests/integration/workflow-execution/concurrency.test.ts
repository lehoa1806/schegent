// Feature 088 (T028) — one child at a time, and one child per submission.
//
// Two independent guarantees, deliberately in one suite because they are the two
// halves of the same question — "how many children can this run have?":
//
//   * FR-044/SC-012 — while any child is non-terminal, no other node starts.
//   * FR-047/SC-008 — a duplicate submission produces exactly one child; the
//     second is refused as stale.
//
// What idempotency is, and what it is not. There is no dedup key, no request id,
// and no time window: the compare-and-set *is* the mechanism. A submission
// carries the `expectedRevision` the operator's view was rendered from, and the
// handler re-reads the stored run per command — so the second of two identical
// submissions arrives with a revision the store has already moved past and fails
// gate 2. `continueAt()` in the fixture models exactly that split (stored run
// re-read; `expectedRevision` from the payload), which is why these tests submit
// a captured revision rather than the current one.
//
// The bound is therefore on *submissions*, not on truly simultaneous in-process
// calls: two callers holding the same in-memory run and racing into
// `continueWorkflow()` would both pass gate 2, and the second would then be
// stopped by the store's own compare-and-set at gate 7 — which is a lost attempt
// reference for a child that did enqueue, not a second child. Stating that here
// rather than asserting it, because the host has one handler per command and the
// race is not reachable through the IPC surface.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineCatalog } from '../../../src/config/pipeline-config';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';
import {
  recordChildTerminal,
  type ConnectedRunCoordinatorDeps
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import type { WorkflowLauncherDeps } from '../../../src/services/workflow-execution/workflow-launcher';
import {
  FakeChildRuns,
  NOW,
  ROLLBACK_REQUEST,
  SHIP_REQUEST,
  TRIAGE_REQUEST,
  VERDICT_OUTPUT,
  continueAt,
  launchRelease,
  makeCoordinatorDeps,
  makeLauncherDeps,
  releaseCatalog,
  settleAndRoute,
  storedRun
} from './workflow-fixtures';

describe('a connected run under repeat and overlapping starts', () => {
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

  /** Launch and settle the first node, leaving `n-ship` offered and nothing running. */
  async function launchAndCompleteTriage(): Promise<void> {
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
  }

  it('refuses a second start while a child is still running (FR-044)', async () => {
    const launched = await launchRelease(launcher, harness, catalog);
    expect(launched.outcome).toBe('started');

    const before = storedRun(harness);
    const queuedBefore = harness.store.getQueue('default').requests.length;

    // The first child has not settled. `isNodeStartable` is injected as
    // accepting, so nothing but gate 3 can be refusing this.
    const refused = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST);

    expect(refused.outcome).toBe('rejected-state');
    if (refused.outcome !== 'rejected-state') throw new Error('unreachable');
    expect(refused.reason).toBe('child-not-terminal');
    // The refusal carries the authoritative record, so a stale view corrects
    // itself from the answer rather than from a second read (FR-045).
    expect(refused.run.revision).toBe(before.revision);

    // Nothing was written and nothing was queued.
    const after = storedRun(harness);
    expect(after.revision).toBe(before.revision);
    expect(after.nodes['n-ship']).toBeUndefined();
    expect(harness.store.getQueue('default').requests).toHaveLength(queuedBefore);
  });

  it('produces exactly one child from two identical rapid submissions (FR-047, SC-008)', async () => {
    await launchAndCompleteTriage();

    // The revision the operator's view was rendered from. Both submissions carry
    // it, which is what makes them identical.
    const submitted = storedRun(harness).revision;
    const queuedBefore = harness.store.getQueue('default').requests.length;

    const first = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST, submitted);
    const second = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST, submitted);

    expect(first.outcome).toBe('started');
    if (first.outcome !== 'started') throw new Error('unreachable');
    expect(second.outcome).toBe('rejected-stale');
    if (second.outcome !== 'rejected-stale') throw new Error('unreachable');

    // SC-007: the refusal names the authoritative state, which has moved past
    // the submitted revision by exactly the first submission's one write.
    expect(second.current?.revision).toBe(submitted + 1);

    // SC-008: exactly one child, and exactly one attempt referencing it.
    expect(harness.store.getQueue('default').requests).toHaveLength(queuedBefore + 1);
    const after = storedRun(harness);
    expect(after.nodes['n-ship']!.attempts).toHaveLength(1);
    expect(after.nodes['n-ship']!.attempts[0]!.queueItemId).toBe(first.queueItemId);
  });

  it('reports staleness ahead of any state it would also have failed (FR-046)', async () => {
    await launchAndCompleteTriage();

    const submitted = storedRun(harness).revision;
    const started = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST, submitted);
    expect(started.outcome).toBe('started');

    // This submission is doubly refusable: its revision is stale *and* a child
    // is now non-terminal. Gate 2 precedes gate 3 so the operator is told to
    // refresh rather than to wait — the same revision-before-everything ordering
    // the save-command family holds.
    const refused = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST, submitted);

    expect(refused.outcome).toBe('rejected-stale');
    if (refused.outcome !== 'rejected-stale') throw new Error('unreachable');
    expect(refused.current?.revision).toBe(submitted + 1);
    expect(storedRun(harness).nodes['n-rollback']).toBeUndefined();
  });

  it('lets the next node start once the child settles (FR-044)', async () => {
    await launchAndCompleteTriage();

    const first = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST);
    expect(first.outcome).toBe('started');
    if (first.outcome !== 'started') throw new Error('unreachable');

    // Blocked while it runs...
    const blocked = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST);
    expect(blocked.outcome).toBe('rejected-state');

    // ...and admitted once it does not.
    await settleAndRoute(coordinator, harness, children, {
      queueItemId: first.queueItemId,
      nodeId: 'n-ship',
      attemptIndex: 0,
      facts: { status: 'failed', outputs: [] }
    });
    const admitted = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST);
    expect(admitted.outcome).toBe('started');
    expect(storedRun(harness).nodes['n-rollback']!.attempts).toHaveLength(1);
  });

  /**
   * Lifecycle round-check of 2026-08-30 (T1613) — the window between the queue
   * finish and the routing record.
   *
   * WHY THERE IS A WINDOW AT ALL. `run-driver.ts` awaits
   * `terminalTransitions.complete()` — which finishes the queue row, so
   * `readChildState` reads the child as terminal — and only then awaits
   * `onRunTerminal`, which is where `run-safety-wiring.ts` records the routing
   * decision. Two filesystem awaits sit between them (the raw-transcript
   * finalize and the session-retention sweep), so this is not a microtask gap.
   * For its whole width the projection already offers this node a `restart` and
   * gate 3 already reads the child as settled, so an operator can submit inside
   * it.
   *
   * WHAT COULD GO WRONG, AND DOES NOT. `recordChildTerminal`'s own docblock says
   * a stale compare-and-set is for *"the caller to re-read and call again"*, and
   * the one production caller does neither — it calls once and drops the result.
   * That is safe only because the caller re-reads `getConnectedRuns()` AFTER
   * those awaits and nothing between that read and the compare-and-set is
   * asynchronous. This test is what makes that reasoning executable: put a real
   * write in the window and require the decision to land anyway.
   *
   * AND ON REAL FACTS. The restart appends attempt 1, which has no terminal
   * facts. A record that routed on absent status would resolve the `n-triage`
   * operand unresolved, take no explicit branch, and fall to `isDefault` — so it
   * would offer `n-rollback` and set `defaultApplied`. The branch assertion
   * below discriminates that outcome from the right one, which is why it is here
   * and not just `outcome: 'recorded'`.
   *
   * The graph is this suite's `RELEASE`, whose first connection is conditional
   * (`n-triage` completed -> `n-ship`) and whose second is the default to
   * `n-rollback`. A matched condition means the default is never reached, so the
   * correct answer is the single branch below — not the two-way offer
   * `manual-continuation.test.ts` asserts, which is a different graph.
   */
  it('records the finished attempt when a restart lands in the routing window (T1613)', async () => {
    const launched = await launchRelease(launcher, harness, catalog);
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') throw new Error('unreachable');

    // The child reaches a terminal state. In the host the queue row is finished
    // by now; the routing record has not run.
    children.settle(launched.queueItemId, VERDICT_OUTPUT);

    // The operator restarts the node inside the window. Gate 3 admits it — the
    // child really has settled — so this is not a race the launcher refuses.
    const restarted = await continueAt(launcher, harness, 'n-triage', TRIAGE_REQUEST);
    expect(restarted.outcome, 'gate 3 must admit a restart once the child is terminal').toBe(
      'started'
    );
    const moved = storedRun(harness);
    expect(moved.nodes['n-triage']!.attempts).toHaveLength(2);

    // Now the routing record catches up, reading the run as the host does.
    const routed = await recordChildTerminal(coordinator, {
      run: moved,
      nodeId: 'n-triage',
      attemptIndex: 0,
      decidedAt: NOW
    });

    expect(
      routed.outcome,
      'the routing decision was dropped as stale. The operator write in the window moved the ' +
        'revision, so the record only survives while the caller re-reads and nothing awaits ' +
        'between that read and the compare-and-set — see this case`s docblock.'
    ).toBe('recorded');
    if (routed.outcome !== 'recorded') throw new Error('unreachable');

    // Routed on attempt 0's facts, not on the empty attempt 1.
    expect(routed.decision.attemptIndex).toBe(0);
    const offered = routed.decision.eligible.map(
      (index) => moved.graph.connections[index]!.to.nodeId
    );
    expect(
      offered,
      'expected the branch attempt 0`s `completed` status matches. `n-rollback` here would mean ' +
        'the record routed on absent facts and fell through to the default connection'
    ).toEqual(['n-ship']);
    expect(routed.decision.defaultApplied).toBe(false);
  });

  it('counts an unresolvable child as settled rather than as running (FR-044)', async () => {
    await launchAndCompleteTriage();

    const first = await continueAt(launcher, harness, 'n-ship', SHIP_REQUEST);
    expect(first.outcome).toBe('started');
    if (first.outcome !== 'started') throw new Error('unreachable');

    // The queue item is gone and no terminal facts were recorded for it — the
    // shape a crash or an external removal leaves behind. Reading that as "still
    // running" would leave the connected run permanently unstartable, so the
    // probe answers settled.
    expect(await harness.queue.remove(first.queueItemId)).toBe(true);

    const admitted = await continueAt(launcher, harness, 'n-rollback', ROLLBACK_REQUEST);
    expect(admitted.outcome).toBe('started');
  });
});
