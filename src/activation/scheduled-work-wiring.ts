// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Constructs the three clock-driven collaborators and arms none of them. `reArm()`
// is the producers' call, behind the trust gate and behind the election; the queue
// write lives in `promoteScheduledQueue`, which only a fired schedule reaches, and
// no schedule is armed in an untrusted window.

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { ProcessEnvironmentPolicy } from '../runner/spawn-env';
import { CreditWatchdog } from '../watchdog/credit-watchdog';
import type { GuardedRunService } from '../services/guarded-run-service';
import { QueueScheduleWatchdog } from '../controller/schedule-watchdog';
import { ScheduledStartCoordinator } from '../services/scheduled-start-coordinator';
import { UnattendedAdmission } from '../services/unattended-admission';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { BackendRunnerRegistry } from '../runner/backend-runner-registry';
import type { CatalogSession } from './catalog-loading';
import { resolveCliPath } from '../config/cli-path-accessor';

/**
 * FR-R3-119 — the things that act on a clock: scheduled starts, the credit
 * watchdog, and the queue-schedule watchdog.
 *
 * The fifth extraction out of `wireStage2()`. 168 lines for eighteen bindings in
 * and **two** out — the best remaining ratio, and the point at which the region
 * boundaries stop being obvious and start being about what shares a reason to
 * exist. These three do: each wakes up on its own schedule and decides whether
 * this window may act, and none of them needs the UI.
 *
 * `lockResult` is NOT a dependency here, which is worth noting because the first
 * draft made it one: the only thing this region did with the primacy result was
 * decide whether to call `reArm()`, and that call stayed in the composition root
 * (see the note beside it). Construction needs no verdict.
 */
export interface ScheduledWorkWiringDeps {
  readonly workspaceRoot: string;
  readonly cliPath: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly controller: SchegentWorkflowController;
  readonly auditWriter: AuditLogWriter;
  readonly notifier: Notifier;
  readonly statusBar: SchegentStatusBar;
  readonly lock: WorkspaceLockManager;
  readonly guardedRunService: GuardedRunService;
  readonly runnerRegistry: BackendRunnerRegistry;
  readonly catalogSession: CatalogSession;
  readonly backendKind: BackendRunnerKind;
  readonly pollIntervalMinutes: number;
  readonly processEnvironmentPolicy: ProcessEnvironmentPolicy;
}

export interface ScheduledWorkWiring {
  readonly watchdog: CreditWatchdog;
  readonly queueScheduleWatchdog: QueueScheduleWatchdog;
  readonly scheduledStartCoordinator: ScheduledStartCoordinator;
}

export function wireScheduledWork(deps: ScheduledWorkWiringDeps): ScheduledWorkWiring {
  const {
    workspaceRoot,
    cliPath,
    logger,
    store,
    queue,
    controller,
    auditWriter,
    notifier,
    statusBar,
    lock,
    guardedRunService,
    runnerRegistry,
    catalogSession,
    backendKind,
    pollIntervalMinutes,
    processEnvironmentPolicy
  } = deps;

// Feature 065 (T009, T011) — the scheduled-start coordinator owns the
// single in-process `setTimeout` driving `idle-pending → running`
// transitions. `reArm()` runs once at activation (after the v7 lift)
// to re-arm any persisted future schedule or, if the target moment has
// already elapsed while the host was offline, fire the FR-012 transition
// immediately. `onFire` clears the persisted schedule fields and invokes
// the existing auto-drain path so promotion goes through the normal
// lock-acquire route.
// FR-R3-002 (T282/T285) — the one promotion path a scheduled start takes,
// addressed by queue. Both the coordinator's `onFire` and the watchdog's
// recovery sweep call this, so there is exactly one place that clears a
// queue's schedule fields and exactly one that asks the drain gate to
// promote it. The watchdog does not become a second idle-pending gate;
// `AutoDrainCoordinator.drainIfIdle(queueId)` stays the only enforcement
// site and this hop is how the watchdog *asks* it.
const promoteScheduledQueue = async (queueId: string): Promise<void> => {
  await store.updateQueue(
    (queueState) => ({
      queue: {
        ...queueState,
        queueLifecycle: 'active-empty',
        scheduledStartAt: null,
        scheduledStartSource: null,
        updatedAt: Date.now()
      },
      result: undefined
    }),
    queueId,
    store.runCommitClaim(queueId)
  );
  await controller.drainQueuedWork(queueId);
};

const scheduledStartCoordinator = new ScheduledStartCoordinator({
  store,
  auditWriter,
  logger,
  onFire: promoteScheduledQueue,
  // Feature 065 (T049b) — surface the transient FR-017a / SC-009 hint
  // on the status bar when a scheduled start fires. 4000 ms is the
  // mid-point of the 3000..5000 ms window mandated by FR-017a.
  onFiredObserver: () => {
    statusBar.showTransient('schegent: scheduled start fired', 4000);
  },
  // Feature 065 (T053 / FR-014) — at fire time, probe whether the
  // workspace lock is held by a competing process. When true, the
  // coordinator emits `scheduled-start-superseded { lock-unavailable }`
  // and leaves the armed deadline persisted; `QueueScheduleWatchdog` below
  // retries it once this window is primary. The operator is NOT prompted.
  isForeignLockHeld: () => lock.isForeignLockHeld(),
  // FR-R3-070 — the authoritative fire-time predicate beside the probe; a
  // window whose fence lapsed after election must not promote a schedule.
  hasPrimacy: () => lock.hasPrimacy(),
  // Feature 098 (T058 / FR-031a) — a schedule that comes due with nothing
  // imported meets the refusal a manual launch meets, and the operator is
  // told in the same words. Read through `catalogSession.catalog` rather than
  // captured, so a catalog imported into after the coordinator was built is
  // the one the gate sees.
  emptyCatalogGate: {
    isCatalogEmpty: () => catalogSession.catalog.pipelinesById.size === 0,
    onRefused: (refusal) => void notifier.warn(refusal.message) // advisory
  }
});
// FR-R3-119 — the `reArm()` recovery landmark deliberately STAYS in
// `wireStage2`, and is not moved here with the construction that produces the
// coordinator.
//
// `tests/lint/elect-before-recovering.test.ts` asserts that every recovery
// landmark is preceded by the election and gated on `lockResult.acquired`,
// reasoning about their order in the composition root. Moving a landmark out of
// that file does not make it safe; it makes it unwatched. So this module builds
// the coordinator and returns it, and the caller decides when to act on a
// primacy result — the same split `openWorkspaceSession` makes with `lockResult`.

// Feature 065 (T036/T037) — late-wire the pause/resume cancel + audit
// hooks so QueueManager.setQueuePausedState can clear an outstanding
// schedule and emit the lifecycle audit trail without taking a
// construction-time dependency on the coordinator.
queue.setScheduledStartCancelHook({
  cancel: (queueId, reason) => scheduledStartCoordinator.cancel(queueId, reason)
});
queue.setLifecycleAuditHook({
  append: (entry) =>
    auditWriter.append({
      runId: entry.runId,
      phase: entry.phase,
      iteration: entry.iteration,
      eventType: entry.eventType,
      outcome: entry.outcome,
      payload: entry.payload
    } as never)
});

// FR-R4-F02 (contract U2) — every unattended resume goes through this one service: primacy, the pure
// eligibility decision, then the auto-drain coordinator's capacity-aware admission. `watchdog` is read
// lazily (it is constructed just below and these closures run long after).
const admission = new UnattendedAdmission({
  lock,
  store,
  admit: (queueId, wakeup) => controller.admitUnattended(queueId, wakeup),
  clock: () => Date.now(),
  pollIntervalMs: () => watchdog.getPollIntervalMs(),
  // A stale credits wakeup (older than one poll interval) is dropped and asks for a fresh poll,
  // which joins the poll in flight if there is one (contract W3 G10, U2 G7).
  pollNow: () => void watchdog.pollNow(),
  logger
});
// A drain sweep ending is the moment a slot may have freed: retry the wakeups capacity refused.
controller.onDrainSweepEnd(() => admission.retryDue());
// FR-R4-F02 (TA5) — an elapsed delayed-retry deadline is a `backoff-elapsed` wakeup from the retry
// coordinator's own timer, admitted like every other: the credit watchdog is no longer in this path.
controller.setBackoffElapsedHandler((wakeup) => admission.admit(wakeup));

const watchdog = new CreditWatchdog(
  // FR-R3-056 — deferred: constructing here refused at ACTIVATION, killing the
  // extension before it could say why.
  () => runnerRegistry.getOrCreate(),
  store,
  statusBar,
  logger,
  {
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    cliPath: resolveCliPath(backendKind, workspaceRoot, cliPath),
    cwd: workspaceRoot,
    timeoutMs: 60 * 1000,
    environmentPolicy: processEnvironmentPolicy
  },
  async (evidenceAt) => {
    // FR-R4-F02 (contract U2 G5) — credits are back: admit each queue whose Run is eligible for a
    // credits wakeup and leave every other Run exactly as it was. Delayed retries no longer wake this
    // callback (they run on the retry coordinator's own timer), so it serves one arm.
    //
    // FR-R3-070 — the sweep runs long after activation, so primacy is re-checked at fire time with
    // the authoritative predicate rather than trusted from the activation-era election result; one
    // check here keeps a non-primary window to one log line, and `admit` asks again per queue.
    if (!(await lock.hasPrimacy())) {
      logger.warn('watchdog resume sweep skipped: window is not primary');
      return;
    }
    await admission.creditsRestored(evidenceAt);
  },
  // FR-R4-F02 (W6 G20) — one notice per Run whose 24-hour credit window stops.
  notifier
);

// BUG-006 — late-inject the guarded-run service so the retry handler can
// convert a retry-cap-exhausted rate-limit pause into a system-armed
// scheduled restore (FR-026). `GuardedRunService` is constructed earlier
// in this activate path (search for `new GuardedRunService`).
controller.setGuardedRunService(guardedRunService);

const queueScheduleWatchdog = new QueueScheduleWatchdog({
  getQueueStates: () => store.getQueueStates(),
  hasArmedTimer: (queueId) => scheduledStartCoordinator.hasActiveTimer(queueId),
  promote: promoteScheduledQueue,
  isPrimary: () => lock.hasPrimacy(),
  // Feature 098 (FR-031a) — the same gate the coordinator's `emptyCatalogGate`
  // reads, for the same reason. `refuseOnEmptyCatalog` leaves the queue
  // `idle-pending` with its deadline persisted and its timer dropped, which is
  // precisely what this sweep recovers; without the gate here the watchdog
  // would undo that refusal on its next tick. Read through `catalogSession.catalog`
  // rather than captured, so an import lifts the hold.
  isCatalogEmpty: () => catalogSession.catalog.pipelinesById.size === 0,
  logger,
  audit: auditWriter
});
queueScheduleWatchdog.start();

controller.setRateLimitHandler(async (cause) => {
  notifier.info(`Schegent: paused (${cause}). Watchdog will poll every ${pollIntervalMinutes} min.`);
  await watchdog.pauseAndPoll(cause);
});
  return { watchdog, queueScheduleWatchdog, scheduledStartCoordinator };
}
