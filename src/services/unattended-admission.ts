// FR-R4-F02 (spec 240, US1; contract U2; data-model §5; FR-001 to FR-004, FR-008, FR-011) — the one
// place an unattended wakeup becomes an admission.
//
// Three producers wake a Run with nobody at the keyboard: the credit watchdog when credits come
// back, the retry coordinator when a backoff deadline elapses, and the activation handshake for a
// deadline that elapsed while the host was down. Each used to reach `controller.admitResume` its own
// way, with its own idea of which Runs it was for and none of them asking for a slot. They all arrive
// here now, and this service does four things and no more:
//
//   1. checks that this window holds primacy, at call time (a second window must not act);
//   2. selects with the pure eligibility decision (`unattended-eligibility.ts`);
//   3. hands the eligible wakeup to the auto-drain coordinator's capacity-aware admission, never to
//      `admitResume` directly, so the one ceiling decides whether a slot is free;
//   4. keeps the wakeups capacity refused, one per queue, and retries them when a sweep ends.
//
// WHAT IT DOES NOT DO. It never waits for a Run to finish (admission resolves at admission), it
// decides nothing about eligibility or capacity itself, and it writes nothing: the only write is the
// resume's own patch, inside the controller's lease, which rechecks eligibility once more.
//
// The due queue is in memory. A reload rebuilds it from the persisted credit-pause record and
// `pendingRetryAt`, so nothing here needs a version or a migration.
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { decideUnattendedEligibility, type UnattendedWakeup } from './unattended-eligibility';

/** What the auto-drain coordinator's capacity-aware admission answers. */
export type UnattendedAdmitOutcome =
  | 'admitted'
  | 'capacity-refused'
  | 'lease-declined'
  | 'ineligible';

/** What this service answers: the coordinator's outcomes, and a window that is not primary. */
export type UnattendedAdmissionOutcome = UnattendedAdmitOutcome | 'not-primary';

export interface UnattendedAdmissionDeps {
  /** Primacy, asked at call time. */
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  /** Reads only; the resume's own patch is the one write. */
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'getRunMap'>;
  /** `AutoDrainCoordinator.admitUnattended`: capacity, the lease, and the in-lease recheck. */
  readonly admit: (queueId: string, wakeup: UnattendedWakeup) => Promise<UnattendedAdmitOutcome>;
  readonly clock: () => number;
  /** The credit poll interval, read at the time it is needed: a stale credits wakeup is older. */
  readonly pollIntervalMs: () => number;
  /** Ask the credit watchdog for a fresh poll (a stale credits wakeup must not be acted on). */
  readonly pollNow: () => void;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}

/** The fixed line: no queue name, Run id, path or status text rides on it. */
const NOT_ADMITTED_LINE = 'unattended resume: not admitted';

export class UnattendedAdmission {
  /** At most one wakeup per queue; a newer one replaces the older (data-model §5). */
  private readonly due = new Map<string, UnattendedWakeup>();

  constructor(private readonly deps: UnattendedAdmissionDeps) {}

  /**
   * Admit one wakeup if this window is primary and its Run is eligible, through the coordinator.
   * Every outcome other than `admitted` logs one metadata-only line (G8).
   */
  public async admit(wakeup: UnattendedWakeup): Promise<UnattendedAdmissionOutcome> {
    if (!(await this.deps.lock.hasPrimacy())) {
      return this.notAdmitted(wakeup, 'not-primary', 'not-primary');
    }
    const decision = decideUnattendedEligibility(
      this.deps.store.getRun(wakeup.queueId),
      wakeup,
      this.deps.clock()
    );
    if (!decision.eligible) {
      this.due.delete(wakeup.queueId);
      return this.notAdmitted(wakeup, 'ineligible', decision.reason);
    }
    const outcome = await this.deps.admit(wakeup.queueId, wakeup);
    if (outcome === 'admitted') {
      this.due.delete(wakeup.queueId);
      return outcome;
    }
    if (outcome === 'capacity-refused') this.due.set(wakeup.queueId, wakeup);
    else this.due.delete(wakeup.queueId);
    return this.notAdmitted(wakeup, outcome, outcome);
  }

  /**
   * Credits are back: admit each queue whose Run is eligible for a credits wakeup, and skip every
   * other without a write. Replaces the sweep that resumed every key of the Run map.
   */
  public async creditsRestored(evidenceAt: number): Promise<void> {
    for (const [queueId, run] of Object.entries(this.deps.store.getRunMap())) {
      const wakeup: UnattendedWakeup = { cause: 'credits-restored', queueId, evidenceAt };
      if (!decideUnattendedEligibility(run, wakeup, this.deps.clock()).eligible) continue;
      await this.admit(wakeup);
    }
  }

  /**
   * Re-admit every due wakeup; called when a drain sweep ends. A credits wakeup older than one poll
   * interval is dropped, and a fresh poll is requested once for all of them: the evidence that
   * credits were back has gone stale, and acting on it would resume on a guess. A backoff wakeup
   * never goes stale, because its deadline has passed whatever the time.
   */
  public async retryDue(): Promise<void> {
    let stale = false;
    for (const wakeup of [...this.due.values()]) {
      if (this.due.get(wakeup.queueId) !== wakeup) continue;
      if (
        wakeup.cause === 'credits-restored' &&
        this.deps.clock() - wakeup.evidenceAt > this.deps.pollIntervalMs()
      ) {
        this.due.delete(wakeup.queueId);
        stale = true;
        continue;
      }
      await this.admit(wakeup);
    }
    if (stale) this.deps.pollNow();
  }

  /**
   * Drop the due wakeup of `queueId`, or of every queue when none is named: the same two forms
   * `RetryCoordinator.cancelPendingTimer` has, because a control that cancels a queue's countdown
   * must not leave a wakeup behind that resumes it.
   */
  public cancelPendingTimer(queueId?: string): void {
    if (queueId === undefined) this.due.clear();
    else this.due.delete(queueId);
  }

  private notAdmitted(
    wakeup: UnattendedWakeup,
    outcome: UnattendedAdmissionOutcome,
    reason: string
  ): UnattendedAdmissionOutcome {
    this.deps.logger.info(NOT_ADMITTED_LINE, {
      reasonCode: `unattended-${outcome}`,
      reason,
      cause: wakeup.cause
    });
    return outcome;
  }
}
