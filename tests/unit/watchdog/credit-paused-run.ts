// FR-R4-F02 (spec 240, US6) — a Run paused for credits, for the watchdog tests.
//
// The watchdog polls only while some Run holds an open credit window, so a poll test needs one in
// the store. Built through `store.setRun` with the real invariants, so a fixture that the store
// would refuse cannot pass for a credit-paused Run.
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { CreditPause, WorkflowRun } from '../../../src/state/workflow-run';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';

export function creditPausedRunFixture(
  creditPause: CreditPause,
  overrides: Partial<WorkflowRun> = {}
): WorkflowRun {
  return {
    id: 'run-credit-1',
    featureId: 'feature-credit-1',
    featureDir: '',
    status: 'paused',
    currentPhase: 'compose',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 1,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause,
    ...overrides
  } as unknown as WorkflowRun;
}

/** Seed one credit-paused Run on `queueId`; the window defaults to open and started `now`. */
export async function seedCreditPausedRun(
  store: WorkspaceStateStore,
  creditPause: CreditPause = { pausedAt: Date.now(), windowStartedAt: Date.now(), stoppedAt: null },
  queueId: string = DEFAULT_QUEUE_ID,
  overrides: Partial<WorkflowRun> = {}
): Promise<WorkflowRun> {
  const run = creditPausedRunFixture(creditPause, overrides);
  await store.setRun(queueId, run, unfencedCommit('test-fixture'));
  return run;
}

/** Register one more queue, so a second Run can be seeded on it. */
export async function registerQueue(store: WorkspaceStateStore, queueId: string): Promise<void> {
  const registry = store.getQueueRegistry();
  const at = Date.now();
  await store.setQueueRegistry({
    entries: [
      ...registry.entries,
      {
        id: queueId,
        name: `Queue ${queueId.slice(0, 4)}`,
        position: registry.entries.length,
        schedule: null,
        createdAt: at,
        updatedAt: at
      }
    ],
    updatedAt: at
  });
}
