import type { BackendRunner } from '../contracts/backend-runner';
import { policyRequestFields, type ProcessEnvironmentPolicy } from '../runner/spawn-env';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { SanitizedLogger } from '../lib/logger';
import { classifyCreditStatus, type CreditStatus } from '../parser/credit-status';
import { QueueMutationRejected } from '../state/workspace-state';
import type { WatchdogState, WorkflowRun } from '../state/workflow-run';
import type { Notifier } from '../ui/notifications';
import { CREDIT_WINDOW_STOPPED_NOTICE, creditWindowPatch, hasOpenCreditWindow } from './credit-window';

export interface WatchdogOptions {
  /**
   * FR-R3-049 (M-11) — REQUIRED, and required is the point.
   *
   * The poll used to forward none of the three policy fields. Because all three
   * are optional on the request, that omission compiled, read like the other two
   * internal invokers, and sent the automatic `/status` spawn the complete
   * ambient environment -- the credentials an operator's allowlist exists to
   * withhold, handed to the one subprocess nobody triggers.
   *
   * Making it required means THIS invoker cannot repeat that by forgetting -- and
   * only this one. A future invoker declares its own options type, which no
   * required field here reaches; what covers that case is
   * `tests/lint/invocations-forward-env-policy.test.ts`, which fails on any
   * production `.invoke(` that forwards no policy. The pair is the guarantee, not
   * this field alone.
   *
   * The requirement sits here rather than on `InvocationRequest` because 69 test
   * files construct request-shaped objects and one constructs this, and for this
   * invoker the guarantee is identical either way.
   */
  environmentPolicy: ProcessEnvironmentPolicy;
  pollIntervalMs: number;
  cliPath: string;
  cwd: string;
  timeoutMs: number;
}

/**
 * FR-R4-F02 (contract W3 G11) — told, not awaited: the poll never waits for the resume it
 * triggers. `evidenceAt` is when the positive poll returned, which is what decides whether a
 * credits wakeup that capacity refused is still fresh enough to act on.
 */
export type CreditsRestoredCallback = (evidenceAt: number) => void | Promise<void>;

/** Fixed, so a failing notification leaks neither a queue, a Run nor an error message. */
const CREDITS_RESTORED_FAILED_LINE = 'watchdog: the credits-restored notification failed';
const WINDOW_STAMP_REFUSED_LINE = 'watchdog: a credit window stamp was refused; the Run is left out of this poll';
const STALE_RECORD_CLEARED_LINE = 'watchdog: no credit window is open; the stale watchdog record was cleared';

/**
 * What the `/status` poll calls itself in the runner's logs.
 *
 * Feature 098 (FR-008) — the poll passed `phase: 'finalize'`, a built-in Phase
 * id standing in for something that is not a Phase: no Run owns this
 * invocation, no plan lists it, and no iteration counts it. The field reaches
 * exactly two runner log lines (`phase=… iteration=…`) and nothing that
 * dispatches, so borrowing an id only ever mislabelled them — and with the
 * catalog runtime-only, `finalize` is a name an operator may have given a real
 * Phase, which turns a vague line into a wrong one.
 *
 * Not a catalog id, and deliberately not shaped like one.
 */
export const CREDIT_POLL_PHASE_LABEL = '(credit-watchdog)';

export class CreditWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * FR-R4-F02 (contract W3 G11) — the poll in flight, if any. A second request joins it instead of
   * being dropped: a fire that landed while a poll was still in flight used to be discarded by an
   * `if (this.polling) return`, and the wakeup it carried was lost.
   */
  private inFlight: Promise<void> | null = null;
  private pollIntervalMs: number;

  constructor(
    /**
     * FR-R3-056 — a THUNK, not a runner.
     *
     * The watchdog is long-lived and the credit poll happens minutes to hours
     * after activation. Holding a runner constructed at activation meant
     * constructing it at activation, which is where an uncontained-backend
     * refusal crashed the whole extension: an operator saw a dead Schegent with no
     * explanation, which is far worse than a refused run.
     *
     * Deferring also removes a cached posture. A runner built under the old
     * setting would keep polling after an operator changed it — the same shape as
     * caching a setting on a long-lived object, which the hard rules forbid.
     */
    private readonly runner: () => BackendRunner,
    private readonly store: WorkspaceStateStore,
    private readonly statusBar: SchegentStatusBar,
    private readonly logger: SanitizedLogger,
    private readonly options: WatchdogOptions,
    private readonly onCreditsRestored: CreditsRestoredCallback,
    /** FR-R4-F02 (W6 G20) — told once per Run whose window stops. Absent, no notice is raised. */
    private readonly notifier: Pick<Notifier, 'warn'> | null = null
  ) {
    this.pollIntervalMs = options.pollIntervalMs;
  }

  public getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /**
   * Update the poll interval at runtime. Called by the extension on
   * `vscode.workspace.onDidChangeConfiguration` for
   * `schegent.watchdog.pollIntervalMinutes`. Logs the change so it appears
   * in the audit pipeline (FR-044, SC-020).
   */
  public setPollInterval(nextMs: number, source = 'config-change'): void {
    if (!Number.isFinite(nextMs) || nextMs <= 0) {
      this.logger.warn(`watchdog: ignoring invalid pollIntervalMs (${nextMs})`);
      return;
    }
    if (nextMs === this.pollIntervalMs) return;
    const previous = this.pollIntervalMs;
    this.pollIntervalMs = nextMs;
    this.logger.info(
      `watchdog: pollIntervalMs ${previous} → ${nextMs} (source=${source})`
    );
    if (this.timer) {
      this.scheduleNext(nextMs);
    }
  }

  /**
   * Pause the run and arm the next credit poll, `pollIntervalMs` from now.
   *
   * FR-R4-F02 (contract W3 G11) — this used to take a duration override and a one-shot
   * `skipStatusCheck` for the delayed-retry path. Both are gone: a delayed retry runs on the retry
   * coordinator's own timer and never reaches the watchdog, so every poll here is a credit poll and
   * every credit poll runs `/status`.
   */
  public async pauseAndPoll(cause: string): Promise<void> {
    const now = Date.now();
    const delay = this.pollIntervalMs;
    const nextPollAt = now + delay;
    await this.store.setWatchdog({
      paused: true,
      pausedSince: now,
      nextPollAt,
      pollIntervalMs: this.pollIntervalMs,
      lastStatusOk: null,
      lastPollOutcome: null,
      cause
    });
    this.statusBar.updateWindow({ kind: 'paused', nextPollAt });
    this.logger.info(
      `watchdog: pausing run (${cause}); delayMs=${delay} (pollIntervalMs=${this.pollIntervalMs})`
    );
    this.scheduleNext(delay);
  }

  /**
   * Feature 011 — cancel the in-memory `setTimeout` handle without touching
   * the persisted `nextPollAt`. Callers (e.g. `retryPhaseNow()`) are
   * responsible for clearing the persisted timestamp via
   * `WorkflowRun.pendingRetryAt = null` and/or `setWatchdog({...})`.
   */
  public cancelPendingTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Re-arm the poll a reload interrupted, from the persisted record (contract W3 G9).
   *
   * The record is only meaningful while some Run holds an open credit window, so that is re-read
   * from the Runs. A `paused: true` record with none is what a delayed retry used to leave here
   * (research R3): it is cleared, with one metadata-only line, and nothing is polled. A window is
   * never started or reset here; it began at the Run's first poll and the Run still carries it.
   */
  public async reattachOnActivation(): Promise<void> {
    const state = this.store.getWatchdog();
    if (!state.paused) return;
    if (!Object.values(this.store.getRunMap()).some(hasOpenCreditWindow)) {
      await this.endPolling(state);
      this.logger.info(STALE_RECORD_CLEARED_LINE, { reasonCode: 'watchdog-stale-record-cleared' });
      return;
    }
    if (!state.nextPollAt) return;
    const delay = Math.max(0, state.nextPollAt - Date.now());
    this.statusBar.updateWindow({ kind: 'paused', nextPollAt: state.nextPollAt });
    this.scheduleNext(delay);
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollNow();
    }, delayMs);
    this.timer.unref?.();
  }

  /**
   * FR-R4-F02 (contract W3 G10) — poll now, or join the poll in flight. The one entry the admission
   * service uses to ask for a fresh poll when a credits wakeup has gone stale, and the one the timer
   * fires. Resolves when that poll completes, whoever started it, and never rejects.
   */
  public pollNow(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const poll = this.poll().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = poll;
    return poll;
  }

  /**
   * One poll (contract W3 G5 to G8). Before `/status` runs, every credit-paused Run's window is
   * moved forward: started where it has not started, stopped where it has run its length. With no
   * open window left there is nothing to ask the account about, so no `/status` runs and nothing is
   * armed. Otherwise the answer is classified from positive evidence only (W1, W2), and the next
   * poll is armed only while a window remains open, so polling ends at most one interval after the
   * last window does.
   */
  private async poll(): Promise<void> {
    try {
      if ((await this.advanceWindows(Date.now())) === 0) {
        await this.endPolling(this.store.getWatchdog());
        return;
      }
      this.logger.info('watchdog: polling /status');
      const status = await this.checkStatus();
      const evidenceAt = Date.now();
      const state = this.store.getWatchdog();
      if (status === 'recovered') {
        await this.store.setWatchdog({
          ...state,
          paused: false,
          pausedSince: null,
          nextPollAt: null,
          lastStatusOk: true,
          lastPollOutcome: null,
          cause: null
        });
        this.logger.info('watchdog: credits restored — resuming');
        this.statusBar.updateWindow(null);
        this.notifyCreditsRestored(evidenceAt);
        return;
      }
      const nextPollAt = Date.now() + this.pollIntervalMs;
      await this.store.setWatchdog({
        ...state,
        paused: true,
        nextPollAt,
        lastStatusOk: false,
        lastPollOutcome: status
      });
      this.statusBar.updateWindow({ kind: 'paused', nextPollAt });
      this.scheduleNext(this.pollIntervalMs);
    } catch (err) {
      this.logger.error(`watchdog poll failed: ${(err as Error).message}`);
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  /** Invoke `/status` and classify the outcome; a poll that throws is `unreachable`, never fatal. */
  private async checkStatus(): Promise<CreditStatus> {
    try {
      const raw = await this.runner().invoke({
        phase: CREDIT_POLL_PHASE_LABEL,
        iteration: 0,
        prompt: '/status',
        timeoutMs: this.options.timeoutMs,
        cliPath: this.options.cliPath,
        cwd: this.options.cwd,
        // The same helper the other two internal invokers use, so identical
        // policies produce identical environments at every call site.
        ...policyRequestFields(this.options.environmentPolicy)
      });
      return classifyCreditStatus({
        exitCode: raw.exitCode,
        killed: raw.killed,
        timedOut: raw.timedOut,
        stdout: raw.stdoutBuffer
      });
    } catch {
      return classifyCreditStatus({ thrown: true });
    }
  }

  /**
   * Move every open credit window forward and return how many are still open (contract W3 G5, G6).
   * Each stamp is one `updateRun` link for one Run, so a stamp refused for a Run that was resumed,
   * replaced or lost its claim leaves that Run out of this poll with one metadata-only line and
   * costs no other Run anything. A Run whose window this call stops raises one notice (W6 G20).
   */
  private async advanceWindows(now: number): Promise<number> {
    let open = 0;
    for (const [queueId, run] of Object.entries(this.store.getRunMap())) {
      if (!hasOpenCreditWindow(run)) continue;
      // Nothing to stamp (the window has started and has not ended): count it, write nothing.
      if (Object.keys(creditWindowPatch(run, now)).length === 0) {
        open += 1;
        continue;
      }
      const after = await this.stampWindow(queueId, run, now);
      if (after === null) continue;
      if (hasOpenCreditWindow(after)) {
        open += 1;
      } else {
        this.noticeWindowStopped();
      }
    }
    return open;
  }

  private async stampWindow(queueId: string, run: WorkflowRun, now: number): Promise<WorkflowRun | null> {
    try {
      return await this.store.updateRun(
        queueId,
        {
          runId: run.id,
          allowedStatuses: ['paused'],
          label: 'credit-window',
          patch: (current) => creditWindowPatch(current, now)
        },
        this.store.runCommitClaim(queueId)
      );
    } catch (error) {
      this.logger.warn(WINDOW_STAMP_REFUSED_LINE, {
        reasonCode: error instanceof QueueMutationRejected ? error.reason : 'update-failed'
      });
      return null;
    }
  }

  private noticeWindowStopped(): void {
    void Promise.resolve(this.notifier?.warn(CREDIT_WINDOW_STOPPED_NOTICE)).catch(() => undefined);
  }

  /** No window is open: the record says nothing is being polled, and no next poll is armed. */
  private async endPolling(state: WatchdogState): Promise<void> {
    this.cancelPendingTimer();
    await this.store.setWatchdog({
      ...state,
      paused: false,
      pausedSince: null,
      nextPollAt: null,
      lastPollOutcome: null,
      cause: null
    });
    this.statusBar.updateWindow(null);
  }

  /** Told, never awaited, and never able to throw out of the poll (contract W3 G11). */
  private notifyCreditsRestored(evidenceAt: number): void {
    try {
      void Promise.resolve(this.onCreditsRestored(evidenceAt)).catch(() => {
        this.logger.warn(CREDITS_RESTORED_FAILED_LINE);
      });
    } catch {
      this.logger.warn(CREDITS_RESTORED_FAILED_LINE);
    }
  }
}
