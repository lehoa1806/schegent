// FR-R4-F02 (spec 240, US1) — the shared fixtures of the unattended-resume integration tests.
//
// `concurrent-run-harness.ts` builds the real controller, store, queue manager, lease manager,
// lock and audit writer, and stubs the one seam a test must own: the CLI invocation, which parks at
// a gate. This file adds the two things the unattended-resume tests need on top of it: a Run that
// is paused for credits (a real pause, then the credit-pause record in the place of the operator's
// pause), and a sibling Run in each of the states SC-001 names.
//
// A Run is brought to each state through the controller and the store's own write path, so the
// persisted record is a shape the product can produce, not a hand-built one.
import type { AdmittedRun, Harness } from './concurrent-run-harness';
import { drainUntil, fatalOutput } from './concurrent-run-harness';
import { unfencedCommit } from '../../src/state/ownership-claim';
import type { ManualPauseCause, RunPatch, WorkflowRun } from '../../src/state/workflow-run';

/** The eight ineligible sibling states of SC-001. */
export const SIBLING_STATES = [
  'failed',
  'running',
  'operator-paused',
  'queue-paused mid-run',
  'breakpoint-paused',
  'verify-paused',
  'spend-paused',
  'future backoff'
] as const;
export type SiblingState = (typeof SIBLING_STATES)[number];

/** The retry count the failed sibling carries; the test asserts it is still this afterwards. */
export const FAILED_SIBLING_RETRY_COUNT = 5;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Admit a Run, park it at the CLI gate, pause it through the real control, and let its driver
 * return. The Run is then paused and keeps its session, its lease and its slot (FR-014a).
 */
export async function admitAndPause(
  h: Harness,
  queueId: string,
  description: string
): Promise<AdmittedRun> {
  const admitted = await h.admit(queueId, description);
  await h.atGate(admitted.runId);
  const paused = await h.controller.pauseActivePhase(queueId);
  if (!paused.ok) throw new Error(`pause refused: ${paused.reason}`);
  h.step(admitted.runId);
  await drainUntil(
    () => h.store.getRun(queueId)?.status === 'paused' && !h.controller.running,
    () => `run on queue ${queueId} to park as paused (status=${h.store.getRun(queueId)?.status})`
  );
  return admitted;
}

async function patchRun(
  h: Harness,
  queueId: string,
  runId: string,
  allowedStatuses: readonly ('running' | 'paused' | 'failed')[],
  patch: RunPatch
): Promise<void> {
  await h.store.updateRun(
    queueId,
    { runId, allowedStatuses, label: 'resume', patch: () => patch },
    h.store.runCommitClaim(queueId)
  );
}

/**
 * A Run paused for credits: paused, no retry pair, no manual pair, and an open credit pause. It
 * is made the way production makes it, by a pause, and then the operator's pause fields are given
 * back and the credit pause is written in their place.
 */
export async function creditPausedRun(
  h: Harness,
  queueId: string,
  description: string
): Promise<AdmittedRun> {
  const admitted = await admitAndPause(h, queueId, description);
  await patchRun(h, queueId, admitted.runId, ['paused'], {
    manualPauseAt: null,
    manualPauseCause: null,
    creditPause: { pausedAt: Date.now(), windowStartedAt: null, stoppedAt: null }
  });
  return admitted;
}

function manualPause(cause: ManualPauseCause): RunPatch {
  return {
    manualPauseAt: Date.now(),
    manualPauseCause: cause,
    ...(cause === 'breakpoint-paused' ? { resumeTargetPhaseId: 'speckit-plan' } : {})
  };
}

/** Bring the Run on `queueId` to one of SC-001's sibling states and return it. */
export async function siblingInState(
  h: Harness,
  queueId: string,
  state: SiblingState
): Promise<AdmittedRun> {
  if (state === 'running') return h.admit(queueId, 'sibling, running');

  if (state === 'failed') {
    const admitted = await h.admit(queueId, 'sibling, failed');
    h.script(() => fatalOutput());
    await h.runToTerminal(queueId, admitted.runId);
    await patchRun(h, queueId, admitted.runId, ['failed'], {
      delayedRetryCount: FAILED_SIBLING_RETRY_COUNT
    });
    return admitted;
  }

  const admitted = await admitAndPause(h, queueId, `sibling, ${state}`);
  const patches: Record<Exclude<SiblingState, 'running' | 'failed'>, RunPatch> = {
    'operator-paused': {},
    'queue-paused mid-run': manualPause('queue-paused-mid-run'),
    'breakpoint-paused': manualPause('breakpoint-paused'),
    'verify-paused': manualPause('verify-paused'),
    'spend-paused': manualPause('spend-bound-reached'),
    'future backoff': {
      manualPauseAt: null,
      manualPauseCause: null,
      pendingRetryAt: Date.now() + HOUR_MS,
      pendingRetryCause: 'rate_limit',
      delayedRetryCount: 1
    }
  };
  await patchRun(h, queueId, admitted.runId, ['paused'], patches[state]);
  return admitted;
}

/**
 * A paused Run on `queueId` that holds NO session, as a Run does after a reload: its record is
 * persisted and its Task row exists, but nothing in this window is driving or holding a slot for
 * it. Built from `template`, a Run this window really admitted, so the frozen plan and the other
 * fields are ones the product wrote; only the identity and the pause shape are replaced.
 */
export async function pausedRunWithoutSession(
  h: Harness,
  queueId: string,
  description: string,
  template: WorkflowRun,
  patch: RunPatch
): Promise<{ runId: string; taskId: string }> {
  const task = await h.queue.enqueue(description, { queueId });
  const runId = `run-${queueId.slice(0, 8)}-persisted`;
  const { writtenAtFence: _fence, ...base } = template;
  const run = {
    ...base,
    id: runId,
    featureId: task.id,
    status: 'paused',
    manualPauseAt: null,
    manualPauseCause: null,
    resumeTargetPhaseId: null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    delayedRetryCount: 0,
    creditPause: null,
    ...patch
  } as WorkflowRun;
  await h.store.setRun(queueId, run, unfencedCommit('test-fixture'));
  await h.queue.markInFlight(task.id, runId);
  return { runId, taskId: task.id };
}

/** The credit pause a Run carries when credits have not come back, with an open window. */
export const OPEN_CREDIT_PAUSE = Object.freeze({
  pausedAt: 1_700_000_000_000,
  windowStartedAt: 1_700_000_001_000,
  stoppedAt: null
});

/** A backoff that has already elapsed: the shape a delayed retry has when its deadline fires. */
export function elapsedBackoff(now: number): RunPatch {
  return { pendingRetryAt: now - 1_000, pendingRetryCause: 'rate_limit', delayedRetryCount: 1 };
}

