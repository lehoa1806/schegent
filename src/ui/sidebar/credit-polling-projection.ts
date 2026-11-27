// FR-R4-F02 (spec 240, US6; contract W6 G17; data-model §10) — what the surface says about a
// credit-paused Run's polling, projected from the Run's persisted credit pause and the watchdog
// record's last outcome. Fixed vocabulary only: no status text and no account text reach the wire.
import { CREDIT_POLL_WINDOW_MS } from '../../contracts/retry-bounds';
import { creditPauseOf, type WatchdogState, type WorkflowRun } from '../../state/workflow-run';
import type { CreditPollingProjection } from './snapshot';

/**
 * `null` when the Run is not paused for credits. `stopped` once the 24-hour window ended (the
 * operator's Resume is the only way on), `unreachable` while the window is open and the last poll
 * could not reach `/status`, and `polling` otherwise. `windowEndsAt` is null until the first poll
 * has started the window.
 */
export function projectCreditPolling(
  run: WorkflowRun,
  lastPollOutcome: WatchdogState['lastPollOutcome']
): CreditPollingProjection | null {
  const pause = creditPauseOf(run);
  if (pause === null) return null;
  const windowEndsAt = pause.windowStartedAt === null ? null : pause.windowStartedAt + CREDIT_POLL_WINDOW_MS;
  if (pause.stoppedAt !== null) return { state: 'stopped', windowEndsAt };
  return { state: lastPollOutcome === 'unreachable' ? 'unreachable' : 'polling', windowEndsAt };
}
