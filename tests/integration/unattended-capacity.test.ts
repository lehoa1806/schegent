// FR-R4-F02 (spec 240, US1; contract U4 G13 to G15; FR-004; SC-002) — an unattended resume is
// admitted through the one capacity method, and never takes the live count past the cap.
//
// At `5d700407` the credits-restored sweep called `admitResume` for every Run with no capacity
// check at all, so once a reload had emptied the session registry the first eligible Run took a slot
// the cap did not have. Driven through that closure (measurements.md, US1, "Regression before the
// fix"): at capacity 1 the live count went 1 to 2, and at capacity 2 it went 2 to 3.
//
// A Run that already holds a session already has its slot (FR-014a: a paused Run keeps it), so it
// is admitted without counting twice. A Run with no session needs a free slot, and without one the
// wakeup is `capacity-refused`, stays due, and is re-admitted when capacity allows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  QUEUE_A,
  QUEUE_B,
  QUEUE_C,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type Harness
} from './concurrent-run-harness';
import {
  OPEN_CREDIT_PAUSE,
  creditPausedRun,
  elapsedBackoff,
  pausedRunWithoutSession
} from './unattended-harness';
import { UnattendedAdmission } from '../../src/services/unattended-admission';

let tmpRoot: string;
let h: Harness;

async function open(cap: number): Promise<void> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-unattended-capacity-'));
  await initGitRepo(tmpRoot);
  h = await makeHarness(tmpRoot, { concurrencyCap: cap, queues: [QUEUE_B, QUEUE_C] });
  await h.lock.tryAcquire();
}

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  await removeWorkspace(tmpRoot);
});

function admissionOver(): { admission: UnattendedAdmission; pollNow: ReturnType<typeof vi.fn> } {
  const pollNow = vi.fn();
  const admission = new UnattendedAdmission({
    lock: h.lock,
    store: h.store,
    admit: (queueId, wakeup) => h.controller.admitUnattended(queueId, wakeup),
    clock: () => Date.now(),
    pollIntervalMs: () => 30 * 60 * 1000,
    pollNow,
    logger: h.logger
  });
  return { admission, pollNow };
}

describe('capacity one, with a paused Run already holding the only slot (US1-5, SC-002)', () => {
  beforeEach(async () => open(1));

  it('admits the Run that holds the slot without counting it twice, and refuses a Run that has none', async () => {
    await creditPausedRun(h, QUEUE_A, 'A holds the slot');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_B, 'B has no session', template, { creditPause: OPEN_CREDIT_PAUSE });
    expect(h.controller.liveRunCount).toBe(1);
    const { admission } = admissionOver();

    const a = await admission.admit({ cause: 'credits-restored', queueId: QUEUE_A, evidenceAt: Date.now() });
    const b = await admission.admit({ cause: 'credits-restored', queueId: QUEUE_B, evidenceAt: Date.now() });

    expect(a).toBe('admitted');
    expect(b).toBe('capacity-refused');
    expect(h.controller.liveRunCount, 'the live count never passed the cap').toBe(1);
    expect(h.store.getRun(QUEUE_B)!.status, 'the refused Run was not resumed').toBe('paused');
  });

  it('creditsRestored never takes the live count past the cap, whichever order the queues come in', async () => {
    await creditPausedRun(h, QUEUE_A, 'A holds the slot');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_B, 'B has no session', template, { creditPause: OPEN_CREDIT_PAUSE });
    const { admission } = admissionOver();

    await admission.creditsRestored(Date.now());

    expect(h.controller.liveRunCount).toBeLessThanOrEqual(1);
    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)!.status).toBe('paused');
  });

  it('a refused wakeup is re-admitted once capacity allows, without waiting for any Run to finish', async () => {
    await creditPausedRun(h, QUEUE_A, 'A holds the slot');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_B, 'B has no session', template, { creditPause: OPEN_CREDIT_PAUSE });
    const { admission } = admissionOver();
    await admission.creditsRestored(Date.now());
    expect(h.store.getRun(QUEUE_B)!.status).toBe('paused');

    await h.store.setGlobalConcurrencyCap(2);
    await admission.retryDue();

    expect(h.store.getRun(QUEUE_B)!.status, 'B is admitted at the next retry, with A still running').toBe('running');
    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
    expect(h.controller.liveRunCount).toBeLessThanOrEqual(2);
  });

  it('a backoff wakeup is refused the same way and retried the same way', async () => {
    await creditPausedRun(h, QUEUE_A, 'A holds the slot');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_B, 'B backoff elapsed', template, elapsedBackoff(Date.now()));
    const { admission } = admissionOver();

    const refused = await admission.admit({ cause: 'backoff-elapsed', queueId: QUEUE_B, deadline: Date.now() });
    expect(refused).toBe('capacity-refused');

    await h.store.setGlobalConcurrencyCap(2);
    await admission.retryDue();
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
  });
});

describe('capacity two, with two paused Runs holding both slots (SC-002)', () => {
  beforeEach(async () => open(2));

  it('admits both holders, refuses a third queue, and never exceeds two', async () => {
    await creditPausedRun(h, QUEUE_A, 'A');
    await creditPausedRun(h, QUEUE_B, 'B');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_C, 'C has no session', template, { creditPause: OPEN_CREDIT_PAUSE });
    expect(h.controller.liveRunCount).toBe(2);
    const { admission } = admissionOver();

    await admission.creditsRestored(Date.now());

    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    expect(h.store.getRun(QUEUE_C)!.status).toBe('paused');
    expect(h.controller.liveRunCount).toBe(2);
  });

  it('a Run with no session is admitted when a slot is free, and the count rises by exactly one', async () => {
    await creditPausedRun(h, QUEUE_A, 'A');
    const template = h.store.getRun(QUEUE_A)!;
    await pausedRunWithoutSession(h, QUEUE_B, 'B has no session', template, { creditPause: OPEN_CREDIT_PAUSE });
    expect(h.controller.liveRunCount).toBe(1);
    const { admission } = admissionOver();

    const outcome = await admission.admit({ cause: 'credits-restored', queueId: QUEUE_B, evidenceAt: Date.now() });

    expect(outcome).toBe('admitted');
    expect(h.controller.liveRunCount).toBe(2);
  });
});
