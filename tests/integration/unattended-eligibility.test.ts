// FR-R4-F02 (spec 240, US1; contract U1 to U4; FR-001 to FR-003; SC-001) — credits come back, and
// only the Run that became eligible resumes.
//
// Queue A holds a Run paused for credits. Queue B holds a Run in each of the eight states SC-001
// names. The credits-restored path fires. A is admitted; B is untouched, byte for byte, and the
// failed sibling's retry count is still five. The controller, the store, the queue manager, the
// lease manager and the audit writer are real (`concurrent-run-harness.ts`); the one stubbed seam
// is the CLI invocation, which parks at a gate.
//
// At `5d700407` the credits-restored sweep resumed every key of the Run map with no pending delayed
// retry. Driven through that closure (measurements.md, US1, "Regression before the fix"), B was
// admitted in all eight states, and the failed one restarted with its count reset from five to zero.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  QUEUE_A,
  QUEUE_B,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type Harness
} from './concurrent-run-harness';
import {
  FAILED_SIBLING_RETRY_COUNT,
  SIBLING_STATES,
  creditPausedRun,
  siblingInState
} from './unattended-harness';
import { UnattendedAdmission } from '../../src/services/unattended-admission';

let tmpRoot: string;
let h: Harness;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-unattended-eligibility-'));
  await initGitRepo(tmpRoot);
  h = await makeHarness(tmpRoot, { concurrencyCap: 5, queues: [QUEUE_B] });
  // The admission service acts only in the window that holds primacy.
  await h.lock.tryAcquire();
});

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  await removeWorkspace(tmpRoot);
});

function admissionOver(harness: Harness): { admission: UnattendedAdmission; pollNow: ReturnType<typeof vi.fn> } {
  const pollNow = vi.fn();
  const admission = new UnattendedAdmission({
    lock: harness.lock,
    store: harness.store,
    admit: (queueId, wakeup) => harness.controller.admitUnattended(queueId, wakeup),
    clock: () => Date.now(),
    pollIntervalMs: () => 30 * 60 * 1000,
    pollNow,
    logger: harness.logger
  });
  return { admission, pollNow };
}

const persisted = (queueId: string): string => JSON.stringify(h.store.getRun(queueId));

describe('credits come back with a sibling queue in each ineligible state (US1-1 to US1-3, SC-001)', () => {
  it('control: the credit-paused Run is the one that resumes, with nothing else in the workspace', async () => {
    const a = await creditPausedRun(h, QUEUE_A, 'queue A');
    const { admission } = admissionOver(h);

    await admission.creditsRestored(Date.now());

    const run = h.store.getRun(QUEUE_A)!;
    expect(run.id).toBe(a.runId);
    expect(run.status).toBe('running');
    expect(run.creditPause ?? null).toBeNull();
  });

  for (const state of SIBLING_STATES) {
    it(`B ${state}: A is admitted, B is unchanged byte for byte`, async () => {
      const a = await creditPausedRun(h, QUEUE_A, 'queue A');
      await siblingInState(h, QUEUE_B, state);
      const bBefore = persisted(QUEUE_B);
      const { admission } = admissionOver(h);

      await admission.creditsRestored(Date.now());

      expect(h.store.getRun(QUEUE_A)!.id).toBe(a.runId);
      expect(h.store.getRun(QUEUE_A)!.status, 'A was admitted').toBe('running');
      expect(persisted(QUEUE_B), `B (${state}) was left exactly as it was`).toBe(bBefore);
    });
  }

  it('the failed sibling keeps its retry count of five', async () => {
    await creditPausedRun(h, QUEUE_A, 'queue A');
    await siblingInState(h, QUEUE_B, 'failed');
    const { admission } = admissionOver(h);

    await admission.creditsRestored(Date.now());

    const b = h.store.getRun(QUEUE_B)!;
    expect(b.status).toBe('failed');
    expect(b.delayedRetryCount).toBe(FAILED_SIBLING_RETRY_COUNT);
  });

  it('a future backoff is not admitted early by a credits event or by a sibling deadline (US1-3)', async () => {
    await creditPausedRun(h, QUEUE_A, 'queue A');
    await siblingInState(h, QUEUE_B, 'future backoff');
    const bBefore = persisted(QUEUE_B);
    const { admission } = admissionOver(h);

    await admission.creditsRestored(Date.now());
    const outcome = await admission.admit({ cause: 'backoff-elapsed', queueId: QUEUE_B, deadline: Date.now() });

    expect(outcome).toBe('ineligible');
    expect(persisted(QUEUE_B)).toBe(bBefore);
  });

  it('a window without primacy resumes nothing and writes nothing (the two-windows edge case)', async () => {
    await creditPausedRun(h, QUEUE_A, 'queue A');
    const before = persisted(QUEUE_A);
    await h.lock.release();
    const { admission } = admissionOver(h);

    const outcome = await admission.admit({ cause: 'credits-restored', queueId: QUEUE_A, evidenceAt: Date.now() });
    await admission.creditsRestored(Date.now());

    expect(outcome).toBe('not-primary');
    expect(persisted(QUEUE_A)).toBe(before);
  });
});
