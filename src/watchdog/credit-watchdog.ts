import type { BackendRunner } from '../contracts/backend-runner';
import { policyRequestFields, type ProcessEnvironmentPolicy } from '../runner/spawn-env';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { SanitizedLogger } from '../lib/logger';
import { detectStatusOk } from '../parser/credit-error-detector';

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

export type ResumeCallback = () => Promise<void>;

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
  private polling = false;
  private pollIntervalMs: number;
  /**
   * Feature 011 — when set, the next scheduled poll() callback bypasses
   * `/status` and resumes directly. Used by the delayed-retry path where
   * the failure was not a rate-limit and a credit check is not needed.
   * Cleared as soon as the poll() reads it (one-shot).
   */
  private skipNextStatusCheck = false;

  constructor(
    private readonly runner: BackendRunner,
    private readonly store: WorkspaceStateStore,
    private readonly statusBar: SchegentStatusBar,
    private readonly logger: SanitizedLogger,
    private readonly options: WatchdogOptions,
    private readonly onResume: ResumeCallback
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
   * Pause the run and arm the next poll.
   *
   * Feature 011 — accepts an `options` bag:
   *   - `durationOverrideMs`: schedule next poll at `now + durationOverrideMs`
   *     instead of `pollIntervalMs`. Only the next delay uses the override;
   *     subsequent polls fall back to `pollIntervalMs`.
   *   - `skipStatusCheck`: when true, the next poll() callback bypasses
   *     `/status` and resumes directly. One-shot; cleared on read.
   */
  public async pauseAndPoll(
    cause: string,
    options?: { durationOverrideMs?: number; skipStatusCheck?: boolean }
  ): Promise<void> {
    const now = Date.now();
    const delay = options?.durationOverrideMs ?? this.pollIntervalMs;
    const nextPollAt = now + delay;
    await this.store.setWatchdog({
      paused: true,
      pausedSince: now,
      nextPollAt,
      pollIntervalMs: this.pollIntervalMs,
      lastStatusOk: null,
      cause
    });
    this.statusBar.updateWindow({ kind: 'paused', nextPollAt });
    this.logger.info(
      `watchdog: pausing run (${cause}); delayMs=${delay} (pollIntervalMs=${this.pollIntervalMs})`
    );
    if (options?.skipStatusCheck) {
      this.skipNextStatusCheck = true;
    }
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
    this.skipNextStatusCheck = false;
  }

  public async reattachOnActivation(): Promise<void> {
    const state = this.store.getWatchdog();
    if (!state.paused || !state.nextPollAt) return;
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
      void this.poll();
    }, delayMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Feature 011 — one-shot bypass set by the delayed-retry path. The
      // backoff already elapsed; resume directly without /status.
      if (this.skipNextStatusCheck) {
        this.skipNextStatusCheck = false;
        const state = this.store.getWatchdog();
        await this.store.setWatchdog({
          ...state,
          paused: false,
          pausedSince: null,
          nextPollAt: null,
          lastStatusOk: state.lastStatusOk,
          cause: null
        });
        this.logger.info('watchdog: delayed-retry backoff elapsed — resuming without /status');
        // Feature 093 (T050) — the window-level pause outranks the per-Run
        // aggregate, so it has to be given back or the bar stays `paused` while
        // Runs execute. Before the split, the next driver update overwrote it.
        this.statusBar.updateWindow(null);
        await this.onResume();
        return;
      }
      this.logger.info('watchdog: polling /status');
      const raw = await this.runner.invoke({
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
      const ok = raw.exitCode === 0 && detectStatusOk(raw.stdoutBuffer);
      const state = this.store.getWatchdog();
      if (ok) {
        await this.store.setWatchdog({
          ...state,
          paused: false,
          pausedSince: null,
          nextPollAt: null,
          lastStatusOk: true,
          cause: null
        });
        this.logger.info('watchdog: credits restored — resuming');
        this.statusBar.updateWindow(null);
        await this.onResume();
      } else {
        const nextPollAt = Date.now() + this.pollIntervalMs;
        await this.store.setWatchdog({
          ...state,
          paused: true,
          nextPollAt,
          lastStatusOk: false
        });
        this.statusBar.updateWindow({ kind: 'paused', nextPollAt });
        this.scheduleNext(this.pollIntervalMs);
      }
    } catch (err) {
      this.logger.error(`watchdog poll failed: ${(err as Error).message}`);
      this.scheduleNext(this.pollIntervalMs);
    } finally {
      this.polling = false;
    }
  }
}
