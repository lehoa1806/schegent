// Feature 093 (T069-T071a, US3) — the concurrency cap as a real ceiling.
//
// 092's `schegent.queue.globalConcurrencyCap` bounded *slot accounting*: it
// counted persisted in-flight Task rows, which is a workspace-wide number a
// second window's Runs land in too, and it could not bound execution because a
// window executed one Run at a time no matter what the setting said. FR-014 asks
// for the other reading — the cap bounds Runs "concurrently executing, not
// merely the number of accounted slots" — and RS-1 names the oracle:
// `sessions.size` at every start decision. This file is where that claim is
// tested, and it is deliberately separate from `concurrent-run-execution.test.ts`
// (whose cap is set high enough to be irrelevant) so that a failure here means
// "the cap did not bound execution" and a failure there means "Runs cannot
// execute at once". Neither file can absorb the other's failure.
//
// **Why every Run here is paused.** The cap gate lives at the drain's step 4, so
// these tests must enter through the drain — `controller.drainQueuedWork()`, the
// production entry point, on the coordinator the controller itself wires. But
// drain step 4b still refuses a second start while any driver is executing, and
// T081 does not delete it until Phase 6. Against a window with a *running* Run,
// every one of these drains would be refused at 4b and the cap assertions would
// pass vacuously.
//
// A **paused** Run resolves that, and not by accident: RS-3 and FR-014a say a
// paused Run keeps its session, its execution lease, and its cap slot, while its
// driver is idle. So a window holding N paused Runs has `running === false` —
// 4b opens — and `liveRunCount === N` — the cap gate is the one that decides.
// The configuration that makes these tests non-vacuous is the exact
// configuration FR-014a describes, which is why T071a is a test here rather than
// a caveat somewhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  QUEUE_A,
  QUEUE_B,
  QUEUE_C,
  QUEUE_D,
  drainUntil,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type AdmittedRun,
  type Harness
} from './concurrent-run-harness';
import { isTerminalRunStatus } from '../../src/state/workflow-run';

let tmpRoot: string;
let h: Harness;

/** The cap under test. Two is the smallest number that can be exceeded by one. */
const CAP = 2;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-concurrency-cap-'));
  await initGitRepo(tmpRoot);
  h = await makeHarness(tmpRoot, {
    concurrencyCap: CAP,
    queues: [QUEUE_B, QUEUE_C, QUEUE_D]
  });
});

afterEach(async () => {
  // Three populations, and the third is why this is not just `quiesce()`.
  // `quiesce()` settles the Runs these tests admitted; `drainedRunsSettled()`
  // settles the Runs a drain had already started. But a terminal transition
  // drains for itself, so opening the gate here starts a cascade — every Run
  // that ends frees a slot a waiting queue immediately takes — and a Run started
  // *after* `drainedRunsSettled()` resolved is in neither population. Deleting
  // the workspace under one of those races its audit append and surfaces as an
  // `ENOTEMPTY` on a directory the Run refilled between the walk and the rmdir.
  //
  // The condition below is the end of the cascade rather than a moment inside
  // it, and it has two terminations because the cascade does: nothing left to
  // start, or nothing able to start. Several tests here deliberately end with
  // the window at its cap on paused Runs and a pending Task that can never be
  // admitted — waiting for that Task to clear would hang. A paused Run is idle
  // and writes nothing, so it is safe to delete the workspace under one.
  await h.quiesce();
  await h.controller.drainedRunsSettled();

  // `controller.running` alone is not enough, and the gap is a resume: the
  // resume path persists `running` and schedules the drive, so between the two
  // the record says the Run is going and no driver is yet turning. A wait that
  // read only the driver would call that quiet and delete the workspace out from
  // under a Run about to start writing. Reading the records closes it — a Run is
  // at rest only when it is terminal or paused.
  const atRest = (status: string): boolean => isTerminalRunStatus(status) || status === 'paused';
  const nothingCanStart = (): boolean =>
    !h.queue.hasExecutionCapacity(h.controller.liveRunCount) ||
    [QUEUE_A, QUEUE_B, QUEUE_C, QUEUE_D].every((q) => h.queue.peekNextPending(q) === null);
  await drainUntil(
    () =>
      !h.controller.running &&
      h.runKeys().every((q) => atRest(h.store.getRun(q)!.status)) &&
      nothingCanStart(),
    () =>
      `the drain cascade to end (running=${h.controller.running}, ` +
      `live=${h.controller.liveRunCount}, ` +
      `runs=${h.runKeys().map((q) => `${q.slice(0, 4)}:${h.store.getRun(q)?.status}`).join(', ')})`
  );
  await removeWorkspace(tmpRoot);
});

/**
 * A Run that is live but not executing: admitted, parked in its first phase,
 * then paused and stepped so the driver observes the pause and returns.
 *
 * On return the window holds one more session (RS-3 keeps it — the Run is
 * `paused`, not terminal) and one fewer executing driver.
 */
async function admitAndPause(queueId: string, description: string): Promise<AdmittedRun> {
  const admitted = await h.admit(queueId, description);
  await h.atGate(admitted.runId);

  const paused = await h.controller.pauseActivePhase(queueId);
  expect(paused.ok).toBe(true);

  // The parked invocation is what the driver is suspended in; releasing it lets
  // the driver reach the point where it acts on the pause it was handed.
  h.step(admitted.runId);

  // Both halves matter, and the second is the one a naive wait misses: the
  // driver writes the `paused` record while it is still inside `drive()`, so
  // there is a window where the status says paused and the driver has not yet
  // returned. Every caller below is asserting on `controller.running`, which
  // reads the driver, so stopping at the record would make those assertions
  // depend on how many microtask rounds the pump happened to take. Waiting for
  // the driver to go idle too is the state the tests actually mean by "paused".
  // Every Run admitted before this one is already idle, so this reads the one
  // just paused.
  await drainUntil(
    () => h.store.getRun(queueId)?.status === 'paused' && !h.controller.running,
    () =>
      `run on queue ${queueId} to park as paused ` +
      `(status=${h.store.getRun(queueId)?.status}, running=${h.controller.running})`
  );
  return admitted;
}

/** Bring the window to `CAP` live-but-idle Runs, which is the cap's boundary. */
async function fillToCap(): Promise<{ a: AdmittedRun; b: AdmittedRun }> {
  const a = await admitAndPause(QUEUE_A, 'work on queue A');
  const b = await admitAndPause(QUEUE_B, 'work on queue B');

  // The precondition every test below rests on, asserted rather than assumed:
  // the window holds CAP Runs and is executing none of them, so drain step 4b
  // is open and step 4 is the gate that decides.
  expect(h.controller.liveRunCount).toBe(CAP);
  expect(h.controller.running).toBe(false);
  return { a, b };
}

describe('Feature 093 (T069, SC-003) — at most N Runs execute under a cap of N', () => {
  it('refuses the N+1th start while N Runs are live', async () => {
    await fillToCap();
    const waiting = await h.queue.enqueue('work on queue C', { queueId: QUEUE_C });

    const executionGate = vi.spyOn(h.queue, 'hasExecutionCapacity');
    const workspaceGate = vi.spyOn(h.queue, 'hasWorkspaceCapacity');
    await h.controller.drainQueuedWork(QUEUE_C);

    // The ceiling held: no third Run exists, and the window still holds exactly
    // the two it had.
    expect(h.store.getRun(QUEUE_C)).toBeNull();
    expect(h.controller.liveRunCount).toBe(CAP);
    expect(h.runKeys()).toEqual([QUEUE_A, QUEUE_B].sort());

    // And the *execution* reading is what refused it — the cap measured against
    // the Runs this window drives, per FR-014. The workspace reading was never
    // reached, so this is not a slot-accounting refusal wearing the cap's name.
    expect(executionGate).toHaveBeenCalledWith(CAP);
    expect(executionGate).toHaveLastReturnedWith(false);
    expect(workspaceGate).not.toHaveBeenCalled();

    // T073 — the refusal contract: nothing written, nothing signalled, the Task
    // left pending and eligible for the next sweep, and no lease claimed for a
    // queue that never started. There is no waiter list to inspect because there
    // is none to add to; the pending Task *is* the record of waiting.
    expect(h.queue.findById(waiting.id)?.status).toBe('pending');
    expect(h.queue.peekNextPending(QUEUE_C)?.id).toBe(waiting.id);
    expect(h.lease.heldQueueIds()).not.toContain(QUEUE_C);
    expect(h.invocations.some((inv) => inv.runId === 'unattributed')).toBe(false);
  });

  it('starts the same queue once the cap is raised, so the cap was the reason', async () => {
    await fillToCap();
    await h.queue.enqueue('work on queue C', { queueId: QUEUE_C });

    await h.controller.drainQueuedWork(QUEUE_C);
    expect(h.store.getRun(QUEUE_C)).toBeNull();

    // Same window, same queue, same drain call. The only thing that changed is
    // the setting, and the setting is read live rather than latched at startup.
    await h.store.setGlobalConcurrencyCap(CAP + 1);
    await h.controller.drainQueuedWork(QUEUE_C);

    await drainUntil(
      () => h.store.getRun(QUEUE_C) !== null,
      () => `queue C to start under a raised cap (liveRunCount=${h.controller.liveRunCount})`
    );
    expect(h.store.getRun(QUEUE_C)?.status).toBe('running');
    expect(h.controller.liveRunCount).toBe(CAP + 1);
  });
});

describe('Feature 093 (T070, US3 scenario 2) — a terminal Run frees its slot', () => {
  it('a waiting queue starts with no operator action taken on it', async () => {
    const { b } = await fillToCap();
    const waiting = await h.queue.enqueue('work on queue C', { queueId: QUEUE_C });

    await h.controller.drainQueuedWork(QUEUE_C);
    expect(h.store.getRun(QUEUE_C)).toBeNull();

    // End one of the two — on queue B, never on queue C. Resuming B is operator
    // action on B; queue C is untouched from here to the assertion below, and
    // that is the whole claim of US3 scenario 2.
    const resumed = await h.controller.resumeActivePhase(undefined, QUEUE_B);
    expect(resumed.ok).toBe(true);
    const finishedB = await h.runToTerminal(QUEUE_B, b.runId);
    expect(isTerminalRunStatus(finishedB.status)).toBe(true);

    // No second `drainQueuedWork` from the test: B's terminal transition
    // disposes its session, which drops the count the cap reads, and drains. The
    // conjunction is deliberate — waiting only for C's record would admit a
    // moment where B's session had not yet gone, and the count is what the
    // freed slot means.
    await drainUntil(
      () => h.store.getRun(QUEUE_C)?.status === 'running' && h.controller.liveRunCount === CAP,
      () =>
        `queue C to start into the freed slot unprompted ` +
        `(C=${h.store.getRun(QUEUE_C)?.status ?? 'none'}, live=${h.controller.liveRunCount})`
    );
    expect(h.queue.findById(waiting.id)?.status).toBe('in-flight');
  });
});

describe('Feature 093 (T071, FR-017, RS-2) — lowering the cap terminates nothing', () => {
  it('leaves every executing Run alone and applies only to later starts', async () => {
    const { a, b } = await fillToCap();

    // Below the number of live Runs. RS-2: acquisition only — the cap is a gate
    // on starting, never a revocation of something already started.
    await h.store.setGlobalConcurrencyCap(1);

    expect(h.controller.liveRunCount).toBe(CAP);
    for (const [queueId, admitted] of [
      [QUEUE_A, a],
      [QUEUE_B, b]
    ] as const) {
      const run = h.store.getRun(queueId);
      expect(run?.id).toBe(admitted.runId);
      expect(isTerminalRunStatus(run!.status)).toBe(false);
    }

    // Over the new ceiling, so nothing new starts.
    await h.queue.enqueue('work on queue C', { queueId: QUEUE_C });
    await h.controller.drainQueuedWork(QUEUE_C);
    expect(h.store.getRun(QUEUE_C)).toBeNull();

    // The excess drains down naturally rather than being cut off: the live Runs
    // end on their own terms and the count falls to the new cap on its way past.
    await h.controller.resumeActivePhase(undefined, QUEUE_A);
    await h.runToTerminal(QUEUE_A, a.runId);

    // One down, one to go — and one live Run is still not below a cap of one, so
    // the lowered setting is still binding here rather than merely recorded.
    expect(h.store.getRun(QUEUE_C)).toBeNull();

    await h.controller.resumeActivePhase(undefined, QUEUE_B);
    await h.runToTerminal(QUEUE_B, b.runId);

    // Now the window is empty and C starts on its own, under the cap the
    // operator lowered rather than the one it started with.
    await drainUntil(
      () => h.store.getRun(QUEUE_C)?.status === 'running' && h.controller.liveRunCount === 1,
      () =>
        `queue C to start under the lowered cap ` +
        `(C=${h.store.getRun(QUEUE_C)?.status ?? 'none'}, live=${h.controller.liveRunCount})`
    );
  });
});

describe('Feature 093 (T071a, FR-014a) — a paused Run keeps its slot', () => {
  it('holds the slot while paused and never refuses the resume', async () => {
    await fillToCap();

    // Both Runs are paused, and both still count. Releasing a slot on pause
    // would look generous here and cost the operator later: the freed slot is
    // immediately claimable by another queue, and the resume that follows would
    // then be refused by a cap that refilled behind it. A slot held by visible
    // work is the better trade, and it keeps `sessions.size` the exact number
    // RS-1 measures with no second rule about which sessions count.
    expect(h.store.getRun(QUEUE_A)?.status).toBe('paused');
    expect(h.store.getRun(QUEUE_B)?.status).toBe('paused');
    expect(h.controller.liveRunCount).toBe(CAP);

    await h.queue.enqueue('work on queue C', { queueId: QUEUE_C });
    await h.controller.drainQueuedWork(QUEUE_C);
    expect(h.store.getRun(QUEUE_C)).toBeNull();

    // The resume consults no cap — it continues a Run that never gave its slot
    // up, so there is nothing to re-acquire and nothing that can refuse it.
    const resumed = await h.controller.resumeActivePhase(undefined, QUEUE_A);
    expect(resumed.ok).toBe(true);
    await drainUntil(
      () => h.store.getRun(QUEUE_A)?.status === 'running',
      () => `queue A to resume (status=${h.store.getRun(QUEUE_A)?.status})`
    );
    expect(h.controller.liveRunCount).toBe(CAP);
  });
});
