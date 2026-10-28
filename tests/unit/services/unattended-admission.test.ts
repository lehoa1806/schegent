// FR-R4-F02 (spec 240, US1; contract U2 G4, G5, G7, G8; data-model §5; FR-008, FR-011) — the
// unattended admission service: the one place an unattended wakeup becomes an admission.
//
// Everything is injected: the clock, the store, the primacy lock, the capacity-aware admit that the
// auto-drain coordinator provides, and the `pollNow` callback that asks the credit watchdog for a
// fresh poll. The service decides nothing about eligibility itself (that is the pure decision) and
// nothing about capacity (that is the coordinator's one method); it selects, hands over, and keeps
// the wakeups that capacity refused.
import { describe, expect, it, vi } from 'vitest';
import {
  UnattendedAdmission,
  type UnattendedAdmissionDeps,
  type UnattendedAdmitOutcome
} from '../../../src/services/unattended-admission';
import type { UnattendedWakeup } from '../../../src/services/unattended-eligibility';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const QUEUE_A = 'queue-aaaa-secret-name';
const QUEUE_B = 'queue-bbbb-secret-name';

function creditPausedRun(runId = 'run-a-secret-id'): WorkflowRun {
  return {
    id: runId,
    featureId: 'task-1',
    status: 'paused',
    manualPauseAt: null,
    manualPauseCause: null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: { pausedAt: NOW - 1_000, windowStartedAt: NOW - 500, stoppedAt: null }
  } as unknown as WorkflowRun;
}

function backoffRun(deadline: number): WorkflowRun {
  return {
    ...creditPausedRun('run-b-secret-id'),
    creditPause: null,
    pendingRetryAt: deadline,
    pendingRetryCause: 'rate_limit'
  } as unknown as WorkflowRun;
}

interface Rig {
  readonly admission: UnattendedAdmission;
  readonly runs: Map<string, WorkflowRun>;
  readonly admit: ReturnType<typeof vi.fn<UnattendedAdmissionDeps['admit']>>;
  readonly pollNow: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly getRunMap: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly primary: { value: boolean };
  readonly clock: { now: number };
}

function rig(outcome: UnattendedAdmitOutcome = 'admitted'): Rig {
  const runs = new Map<string, WorkflowRun>();
  const primary = { value: true };
  const clock = { now: NOW };
  const admit = vi.fn<UnattendedAdmissionDeps['admit']>(async () => outcome);
  const pollNow = vi.fn();
  const getRun = vi.fn((queueId: string) => runs.get(queueId) ?? null);
  const getRunMap = vi.fn(() => Object.fromEntries(runs));
  const info = vi.fn();
  const warn = vi.fn();
  const admission = new UnattendedAdmission({
    lock: { hasPrimacy: async () => primary.value },
    store: { getRun, getRunMap },
    admit,
    clock: () => clock.now,
    pollIntervalMs: () => POLL_INTERVAL_MS,
    pollNow,
    logger: { info, warn }
  });
  return { admission, runs, admit, pollNow, getRun, getRunMap, info, warn, primary, clock };
}

const credits = (queueId: string, evidenceAt = NOW): UnattendedWakeup => ({
  cause: 'credits-restored',
  queueId,
  evidenceAt
});
const backoff = (queueId: string, deadline = NOW - 1): UnattendedWakeup => ({
  cause: 'backoff-elapsed',
  queueId,
  deadline
});

describe('admit: primacy, eligibility, then the capacity-aware admission (G4)', () => {
  it('without primacy, it returns not-primary and calls neither the coordinator nor the store', async () => {
    const r = rig();
    r.runs.set(QUEUE_A, creditPausedRun());
    r.primary.value = false;

    const outcome = await r.admission.admit(credits(QUEUE_A));

    expect(outcome).toBe('not-primary');
    expect(r.admit).not.toHaveBeenCalled();
    expect(r.getRun).not.toHaveBeenCalled();
    expect(r.getRunMap).not.toHaveBeenCalled();
  });

  it('checks primacy at call time, not at construction', async () => {
    const r = rig();
    r.runs.set(QUEUE_A, creditPausedRun());
    expect(await r.admission.admit(credits(QUEUE_A))).toBe('admitted');
    r.primary.value = false;
    expect(await r.admission.admit(credits(QUEUE_A))).toBe('not-primary');
  });

  it('an ineligible Run is returned ineligible and never reaches the coordinator', async () => {
    const r = rig();
    r.runs.set(QUEUE_A, { ...creditPausedRun(), status: 'failed' } as WorkflowRun);

    expect(await r.admission.admit(credits(QUEUE_A))).toBe('ineligible');
    expect(await r.admission.admit(credits('no-such-queue'))).toBe('ineligible');
    expect(r.admit).not.toHaveBeenCalled();
  });

  it('an eligible Run is handed to the coordinator with its wakeup, and its outcome is returned', async () => {
    const r = rig('admitted');
    r.runs.set(QUEUE_A, creditPausedRun());
    const wakeup = credits(QUEUE_A);

    expect(await r.admission.admit(wakeup)).toBe('admitted');
    expect(r.admit).toHaveBeenCalledWith(QUEUE_A, wakeup);
  });

  it.each(['lease-declined', 'ineligible'] as const)('passes a %s outcome through', async (outcome) => {
    const r = rig(outcome);
    r.runs.set(QUEUE_A, creditPausedRun());
    expect(await r.admission.admit(credits(QUEUE_A))).toBe(outcome);
  });
});

describe('creditsRestored: one admit per eligible queue (G5)', () => {
  it('admits each eligible queue and skips the rest without a write', async () => {
    const r = rig();
    r.runs.set(QUEUE_A, creditPausedRun());
    r.runs.set(QUEUE_B, { ...creditPausedRun('run-b'), manualPauseAt: NOW, manualPauseCause: 'operator-paused' } as WorkflowRun);
    r.runs.set('failed-queue', { ...creditPausedRun('run-c'), status: 'failed' } as WorkflowRun);
    r.runs.set('backoff-queue', backoffRun(NOW + 60_000));

    await r.admission.creditsRestored(NOW);

    expect(r.admit).toHaveBeenCalledTimes(1);
    expect(r.admit).toHaveBeenCalledWith(QUEUE_A, { cause: 'credits-restored', queueId: QUEUE_A, evidenceAt: NOW });
  });

  it('is quiet about the queues it skips', async () => {
    const r = rig();
    r.runs.set('failed-queue', { ...creditPausedRun('run-c'), status: 'failed' } as WorkflowRun);
    r.runs.set('plain-paused', { ...creditPausedRun('run-d'), creditPause: null } as WorkflowRun);

    await r.admission.creditsRestored(NOW);

    expect(r.admit).not.toHaveBeenCalled();
    expect(r.info).not.toHaveBeenCalled();
    expect(r.warn).not.toHaveBeenCalled();
  });
});

describe('capacity-refused wakeups stay due and are retried (G7)', () => {
  it('a refused wakeup enters the due queue, and retryDue re-admits it once capacity allows', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    expect(await r.admission.admit(credits(QUEUE_A))).toBe('capacity-refused');
    expect(r.admit).toHaveBeenCalledTimes(1);

    r.admit.mockResolvedValue('admitted');
    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(2);
    // Served: a further retry has nothing left to admit.
    await r.admission.retryDue();
    expect(r.admit).toHaveBeenCalledTimes(2);
  });

  it('a wakeup still refused stays due for the next retry', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    await r.admission.admit(credits(QUEUE_A));

    await r.admission.retryDue();
    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(3);
  });

  it('a refused backoff-elapsed wakeup is re-admitted with no pollNow call', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_B, backoffRun(NOW - 1_000));
    await r.admission.admit(backoff(QUEUE_B));

    r.admit.mockResolvedValue('admitted');
    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(2);
    expect(r.pollNow).not.toHaveBeenCalled();
  });

  it('a refused credits-restored wakeup older than the poll interval is dropped and a fresh poll is requested once', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    await r.admission.admit(credits(QUEUE_A, NOW));
    r.clock.now = NOW + POLL_INTERVAL_MS + 1;

    r.admit.mockResolvedValue('admitted');
    await r.admission.retryDue();

    expect(r.admit, 'the stale evidence is not acted on').toHaveBeenCalledTimes(1);
    expect(r.pollNow).toHaveBeenCalledTimes(1);
    await r.admission.retryDue();
    expect(r.pollNow, 'and it is not asked for again').toHaveBeenCalledTimes(1);
  });

  it('a refused credits-restored wakeup exactly at the interval is still fresh', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    await r.admission.admit(credits(QUEUE_A, NOW));
    r.clock.now = NOW + POLL_INTERVAL_MS;

    r.admit.mockResolvedValue('admitted');
    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(2);
    expect(r.pollNow).not.toHaveBeenCalled();
  });

  it('several stale wakeups ask for one fresh poll, not one each', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    r.runs.set(QUEUE_B, creditPausedRun('run-b'));
    await r.admission.admit(credits(QUEUE_A, NOW));
    await r.admission.admit(credits(QUEUE_B, NOW));
    r.clock.now = NOW + POLL_INTERVAL_MS * 2;

    await r.admission.retryDue();

    expect(r.pollNow).toHaveBeenCalledTimes(1);
  });

  it('a newer wakeup for a queue replaces the older one', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    await r.admission.admit(credits(QUEUE_A, NOW));
    await r.admission.admit(credits(QUEUE_A, NOW + 5_000));
    r.admit.mockClear();
    r.admit.mockResolvedValue('admitted');

    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(1);
    expect(r.admit).toHaveBeenCalledWith(QUEUE_A, credits(QUEUE_A, NOW + 5_000));
  });

  it('a wakeup is dropped when its Run stops being eligible', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    await r.admission.admit(credits(QUEUE_A));
    r.runs.set(QUEUE_A, { ...creditPausedRun(), manualPauseAt: NOW, manualPauseCause: 'operator-paused' } as WorkflowRun);
    r.admit.mockClear();

    await r.admission.retryDue();
    await r.admission.retryDue();

    expect(r.admit).not.toHaveBeenCalled();
  });

  it('a wakeup is dropped on cancelPendingTimer(queueId), and a sibling keeps its own', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    r.runs.set(QUEUE_B, creditPausedRun('run-b'));
    await r.admission.admit(credits(QUEUE_A));
    await r.admission.admit(credits(QUEUE_B));
    r.admit.mockClear();
    r.admit.mockResolvedValue('admitted');

    r.admission.cancelPendingTimer(QUEUE_A);
    await r.admission.retryDue();

    expect(r.admit).toHaveBeenCalledTimes(1);
    expect(r.admit).toHaveBeenCalledWith(QUEUE_B, expect.objectContaining({ queueId: QUEUE_B }));
  });

  it('the window-wide cancel drops every due wakeup', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    r.runs.set(QUEUE_B, creditPausedRun('run-b'));
    await r.admission.admit(credits(QUEUE_A));
    await r.admission.admit(credits(QUEUE_B));
    r.admit.mockClear();

    r.admission.cancelPendingTimer();
    await r.admission.retryDue();

    expect(r.admit).not.toHaveBeenCalled();
  });
});

describe('every outcome other than admitted logs one metadata-only line (G8)', () => {
  const outcomes: ReadonlyArray<readonly [string, UnattendedAdmitOutcome]> = [
    ['capacity-refused', 'capacity-refused'],
    ['lease-declined', 'lease-declined'],
    ['ineligible', 'ineligible']
  ];

  it.each(outcomes)('%s: one line, with a reason code, the outcome and the cause', async (_name, outcome) => {
    const r = rig(outcome);
    r.runs.set(QUEUE_A, creditPausedRun());

    await r.admission.admit(credits(QUEUE_A));

    const lines = [...r.info.mock.calls, ...r.warn.mock.calls];
    expect(lines).toHaveLength(1);
    const [, context] = lines[0] as [string, Record<string, unknown>];
    expect(context).toMatchObject({ reasonCode: expect.any(String), cause: 'credits-restored' });
    expect(Object.keys(context).sort()).toEqual(['cause', 'reason', 'reasonCode']);
  });

  it('an ineligible Run logs its ineligibility reason; a not-primary window logs the outcome', async () => {
    const r = rig();
    r.runs.set(QUEUE_A, { ...creditPausedRun(), status: 'failed' } as WorkflowRun);
    await r.admission.admit(credits(QUEUE_A));
    const [, ineligible] = [...r.info.mock.calls, ...r.warn.mock.calls][0] as [string, Record<string, unknown>];
    expect(ineligible.reason).toBe('not-paused');

    const second = rig();
    second.primary.value = false;
    await second.admission.admit(credits(QUEUE_A));
    const [, notPrimary] = [...second.info.mock.calls, ...second.warn.mock.calls][0] as [string, Record<string, unknown>];
    expect(notPrimary.reason).toBe('not-primary');
  });

  it('carries no queue name, Run id, path or status text', async () => {
    const r = rig('capacity-refused');
    r.runs.set(QUEUE_A, creditPausedRun());
    r.runs.set(QUEUE_B, { ...creditPausedRun(), status: 'failed' } as WorkflowRun);

    await r.admission.admit(credits(QUEUE_A));
    await r.admission.admit(credits(QUEUE_B));
    await r.admission.retryDue();

    const everything = JSON.stringify([...r.info.mock.calls, ...r.warn.mock.calls]);
    expect(everything).not.toContain('secret');
    expect(everything).not.toContain('queue-');
    expect(everything).not.toContain('run-');
    expect(everything).not.toMatch(/[\\/]/);
  });

  it('an admitted resume logs nothing', async () => {
    const r = rig('admitted');
    r.runs.set(QUEUE_A, creditPausedRun());

    await r.admission.admit(credits(QUEUE_A));

    expect(r.info).not.toHaveBeenCalled();
    expect(r.warn).not.toHaveBeenCalled();
  });
});
