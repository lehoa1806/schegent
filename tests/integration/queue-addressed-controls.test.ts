// Feature 093 (T075-T078, US4) — every lifecycle control acts on the queue it
// names, and on no other.
//
// **What this file is for.** US4 calls mis-addressing "the most likely and most
// damaging failure of concurrent execution", and the reason is that it is
// *silent*: the control reports success, the Run the operator was looking at
// keeps going, and an unrelated Run stops. Nothing in a single-Run window can
// distinguish a correctly addressed control from an ambient one, because with
// one Run every answer is the same answer. So every test here constructs two
// Runs and asserts the negative half — the bystander is untouched — alongside
// the positive one. A test that only checked the named queue would pass just as
// happily against the ambient implementation this phase replaced.
//
// **Why the controller, not the drain.** Drain step 4b still refuses a second
// start until T081 deletes it, so entering through `drainAll()` would leave one
// Run and no claim. These tests enter at `controller.admitNew()` (the T049a
// admission seam), exactly as `concurrent-run-execution.test.ts` does. The cap
// is set high enough to be irrelevant: a refusal here must mean "the control
// was mis-addressed", never "the cap was full".
//
// **Cancel goes through the production command.** T075 calls `runCancel` rather
// than `controller.cancelActive(queueId)` directly, because the addressing it
// has to prove starts one layer above the controller: the webview sends
// `{ taskId }`, the host turns that into a queue via `queueIdForTask`, and only
// then does a queue reach the controller. Calling the controller directly would
// assert that the last link of that chain is addressed while skipping the two
// links where a wrong queue would actually come from.
//
// **Determinism.** As in the rest of the 093 integration suite: every CLI
// invocation parks at a gate and `step(runId)` releases exactly one of that
// Run's parked invocations, so an interleaving is a sequence of statements
// rather than a hope about scheduling. `drainUntil` is a bounded microtask pump
// that fails by naming what it waited for; there are no sleeps.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  QUEUE_A,
  QUEUE_B,
  QUEUE_C,
  drainUntil,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type AdmittedRun,
  type Harness
} from './concurrent-run-harness';
import { runCancel } from '../../src/commands/cancel';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { findQueue } from '../../src/queue/queue-registry';
import { isTerminalRunStatus, type WorkflowRun } from '../../src/state/workflow-run';
import type { Notifier } from '../../src/ui/notifications';

let tmpRoot: string;
let h: Harness;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-addressed-controls-'));
  await initGitRepo(tmpRoot);
  // QUEUE_C exists in the registry and never receives a Task: it is the "queue
  // with no active Run" every T078 refusal names.
  h = await makeHarness(tmpRoot, { concurrencyCap: 5, queues: [QUEUE_B, QUEUE_C] });
});

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  // `quiesce()` awaits the admissions this file made, but a control may schedule
  // a drive it did not admit — `retryPhaseNow` resumes via `setImmediate`, and
  // that promise is nobody's to await. Wait for the records instead: every Run
  // terminal or paused, and no driver still turning. Deleting the workspace
  // under a live Run races its audit append and surfaces as an `ENOTEMPTY` from
  // a directory the Run refilled between the walk and the rmdir.
  await drainUntil(
    () =>
      !h.controller.running &&
      h.runKeys().every((queueId) => {
        const status = h.store.getRun(queueId)!.status;
        return isTerminalRunStatus(status) || status === 'paused';
      }),
    () => `every Run to come to rest (running=${h.controller.running}, runs=${describeRuns()})`
  );
  await removeWorkspace(tmpRoot);
});

const describeRuns = (): string =>
  h
    .runKeys()
    .map((queueId) => `${queueId.slice(0, 4)}:${h.store.getRun(queueId)?.status}`)
    .join(', ');

const notifier = (): Notifier =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Notifier;

/** Both queues admitted and both parked in their first phase. */
async function bothExecuting(): Promise<{ a: AdmittedRun; b: AdmittedRun }> {
  const a = await h.admit(QUEUE_A, 'work on queue A');
  const b = await h.admit(QUEUE_B, 'work on queue B');
  await h.atGate(a.runId);
  await h.atGate(b.runId);
  expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
  expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
  return { a, b };
}

/**
 * Admit a Run and bring it to rest at `paused`.
 *
 * Callers use this **one queue at a time**: the settle condition includes the
 * window-wide `!controller.running`, because the driver writes the `paused`
 * record from inside `drive()` and a status-only wait can return while that
 * driver is still turning. With a sibling mid-drive the same condition would
 * never hold, so the sequencing is part of the contract, not an accident.
 */
async function admitAndPark(queueId: string, description: string): Promise<AdmittedRun> {
  const admitted = await h.admit(queueId, description);
  await h.atGate(admitted.runId);
  const paused = await h.controller.pauseActivePhase(queueId);
  expect(paused.ok).toBe(true);
  h.step(admitted.runId);
  await drainUntil(
    () => h.store.getRun(queueId)?.status === 'paused' && !h.controller.running,
    () =>
      `run on queue ${queueId} to park as paused ` +
      `(status=${h.store.getRun(queueId)?.status}, running=${h.controller.running})`
  );
  return admitted;
}

/** The phase `offset` positions after this Run's current one. */
function laterPhaseOf(run: WorkflowRun, offset = 1): string {
  const phases = run.pipeline!.phases;
  const index = phases.findIndex((phase) => phase.id === run.currentPhase);
  const later = phases[index + offset];
  if (!later) throw new Error(`pipeline has no phase ${offset} beyond ${run.currentPhase}`);
  return later.id;
}

const queueEntry = (queueId: string) => findQueue(h.store.getQueueRegistry(), queueId)!;

const invocationCount = (runId: string): number =>
  h.invocations.filter((entry) => entry.runId === runId).length;

/** The phases this queue's Run has breakpoints armed on, in stored order. */
const breakpointsOn = (queueId: string): string[] =>
  h.store.getRun(queueId)!.phaseBreakpoints.map((entry) => entry.phaseId);

describe('Feature 093 US4 — lifecycle controls address one queue s Run', () => {
  it('T075: cancelling one queue s Run leaves the other executing', async () => {
    const { a, b } = await bothExecuting();
    const bInvocationsAtCancel = invocationCount(b.runId);

    const result = await runCancel({
      controller: h.controller,
      store: h.store,
      queue: h.queue,
      audit: new AuditLogWriter({ workspaceRoot: tmpRoot }, h.logger),
      notifier: notifier(),
      logger: h.logger,
      taskId: a.feature.id
    });
    expect(result).toEqual({ ok: true });

    // The abort is observed at the driver's phase-loop head, so A's parked
    // invocation has to be released before the loop can come round and see it.
    h.step(a.runId);
    await drainUntil(
      () => h.store.getRun(QUEUE_A)?.status === 'canceled',
      () => `queue A s Run to reach canceled (runs=${describeRuns()})`
    );

    // The bystander: still running, and still able to advance. "Still running"
    // alone would also hold one microtask after a mis-addressed cancel, so the
    // test makes B do more work before it believes it.
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    h.step(b.runId);
    await drainUntil(
      () => invocationCount(b.runId) > bInvocationsAtCancel,
      () => `queue B s Run to dispatch its next phase (invocations=${invocationCount(b.runId)})`
    );
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    expect(h.queue.findById(b.feature.id)!.status).toBe('in-flight');

    // Only the named Task was finalized.
    expect(h.queue.findById(a.feature.id)!.status).toBe('canceled');
  });

  it('T076: pausing one Run pauses only that one, and only its queue', async () => {
    const { a, b } = await bothExecuting();
    const bInvocationsAtPause = invocationCount(b.runId);

    const paused = await h.controller.pauseActivePhase(QUEUE_A);
    expect(paused).toEqual({ ok: true });

    // The pause cause lands on the named Run only.
    expect(h.store.getRun(QUEUE_A)!.manualPauseAt).not.toBeNull();
    expect(h.store.getRun(QUEUE_A)!.manualPauseCause).toBe('operator-paused');
    expect(h.store.getRun(QUEUE_B)!.manualPauseAt).toBeNull();
    expect(h.store.getRun(QUEUE_B)!.manualPauseCause).toBeNull();

    // ...and the cascade stops the named queue only. This is the "only its queue
    // stops advancing" half of the scenario, read off the registry rather than
    // inferred from what happened to run next.
    expect(queueEntry(QUEUE_A).state).toBe('manually-paused');
    expect(queueEntry(QUEUE_A).pauseSource).toBe('cascade');
    expect(queueEntry(QUEUE_B).state).toBe('active');
    expect(queueEntry(QUEUE_B).pauseSource).toBeNull();

    h.step(a.runId);
    await drainUntil(
      () => h.store.getRun(QUEUE_A)?.status === 'paused',
      () => `queue A s Run to park as paused (runs=${describeRuns()})`
    );

    // B never stopped: it is still running and still advancing.
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    h.step(b.runId);
    await drainUntil(
      () => invocationCount(b.runId) > bInvocationsAtPause,
      () => `queue B s Run to dispatch its next phase (invocations=${invocationCount(b.runId)})`
    );
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
  });

  it('T077: a breakpoint is armed on the named queue s Run and no other', async () => {
    const { a, b } = await bothExecuting();
    const runA = h.store.getRun(QUEUE_A)!;
    const target = laterPhaseOf(runA);

    expect(await h.controller.setPhaseBreakpoint(a.runId, target, QUEUE_A)).toEqual({ ok: true });
    expect(breakpointsOn(QUEUE_A)).toEqual([target]);
    expect(breakpointsOn(QUEUE_B)).toEqual([]);

    // A run id addressed at the wrong queue is refused rather than applied to
    // whatever Run that queue happens to hold — the mis-addressing this phase
    // exists to prevent, in its most direct form.
    expect(await h.controller.setPhaseBreakpoint(a.runId, laterPhaseOf(runA, 2), QUEUE_B)).toEqual({
      ok: false,
      reason: 'run-not-in-flight'
    });
    expect(breakpointsOn(QUEUE_B)).toEqual([]);

    // Clearing addresses one queue on the same terms.
    expect(await h.controller.clearPhaseBreakpoint(a.runId, target, QUEUE_B)).toEqual({
      ok: false,
      reason: 'run-not-in-flight'
    });
    expect(breakpointsOn(QUEUE_A)).toEqual([target]);
    expect(await h.controller.clearPhaseBreakpoint(a.runId, target, QUEUE_A)).toEqual({ ok: true });
    expect(breakpointsOn(QUEUE_A)).toEqual([]);
    expect(breakpointsOn(QUEUE_B)).toEqual([]);

    expect(b.runId).not.toBe(a.runId);
  });

  it('T077: retrying now clears the named queue s armed retry and no other', async () => {
    // Both Runs have to be off their drivers for a manual retry to be legal, and
    // both have to carry an armed retry for "only one was cleared" to mean
    // anything. Parked one queue at a time — see `admitAndPark`.
    const a = await admitAndPark(QUEUE_A, 'work on queue A');
    const b = await admitAndPark(QUEUE_B, 'work on queue B');

    const armedAt = 1_700_000_500_000;
    for (const queueId of [QUEUE_A, QUEUE_B]) {
      const run = h.store.getRun(queueId)!;
      // Both halves of the pair, always: a one-sided retry state is a persisted
      // contradiction the loader is entitled to reject.
      await h.store.setRun(queueId, {
        ...run,
        delayedRetryCount: 2,
        pendingRetryAt: armedAt,
        pendingRetryCause: 'transient_error'
      });
    }

    expect(await h.controller.retryPhaseNow(QUEUE_A)).toEqual({ ok: true });

    // The named queue's countdown is consumed...
    const afterA = h.store.getRun(QUEUE_A)!;
    expect(afterA.pendingRetryAt).toBeNull();
    expect(afterA.pendingRetryCause).toBeNull();
    expect(afterA.delayedRetryCount).toBe(0);

    // ...and the sibling's is still counting, untouched in every field.
    const afterB = h.store.getRun(QUEUE_B)!;
    expect(afterB.pendingRetryAt).toBe(armedAt);
    expect(afterB.pendingRetryCause).toBe('transient_error');
    expect(afterB.delayedRetryCount).toBe(2);

    // The retry resumes the named Run only. B stays parked at `paused` while A
    // returns to the CLI gate.
    await h.atGate(a.runId);
    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)!.status).toBe('paused');
    expect(invocationCount(b.runId)).toBe(1);
  });

  it('T078: a control naming a queue with no active Run is refused, and no Run moves', async () => {
    const { a, b } = await bothExecuting();
    const before = { a: h.store.getRun(QUEUE_A)!, b: h.store.getRun(QUEUE_B)! };
    const invocationsBefore = h.invocations.length;
    const phaseId = laterPhaseOf(before.a);

    expect(h.store.getRun(QUEUE_C)).toBeNull();

    // Every control on FR-023's list, aimed at the empty queue. Each refuses
    // with its own reason — `retryPhaseNow` keeps the `no-active-run` vocabulary
    // it answered with before queues existed, and the breakpoint pair speaks of
    // the run id it was handed. What matters is that none of them is generic and
    // none of them silently retargets.
    expect(await h.controller.pauseActivePhase(QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.resumeActivePhase(undefined, QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.restartActivePhase(QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.skipPhase(phaseId, QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.disablePhase(phaseId, QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.enablePhase(phaseId, QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-run-in-flight'
    });
    expect(await h.controller.setPhaseBreakpoint(a.runId, phaseId, QUEUE_C)).toEqual({
      ok: false,
      reason: 'run-not-in-flight'
    });
    expect(await h.controller.clearPhaseBreakpoint(a.runId, phaseId, QUEUE_C)).toEqual({
      ok: false,
      reason: 'run-not-in-flight'
    });
    expect(await h.controller.retryPhaseNow(QUEUE_C)).toEqual({
      ok: false,
      reason: 'no-active-run'
    });

    // No Run record was invented for the empty queue, and neither executing Run
    // moved by so much as a field.
    expect(h.store.getRun(QUEUE_C)).toBeNull();
    expect(h.runKeys()).toEqual([QUEUE_A, QUEUE_B].sort());
    expect(h.store.getRun(QUEUE_A)).toEqual(before.a);
    expect(h.store.getRun(QUEUE_B)).toEqual(before.b);
    expect(h.invocations.length).toBe(invocationsBefore);

    // Both are still live: nine refusals did not take a Run down with them.
    h.step(a.runId);
    h.step(b.runId);
    await drainUntil(
      () => invocationCount(a.runId) > 1 && invocationCount(b.runId) > 1,
      () =>
        `both Runs to dispatch a further phase ` +
        `(a=${invocationCount(a.runId)}, b=${invocationCount(b.runId)})`
    );
    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
  });
});
