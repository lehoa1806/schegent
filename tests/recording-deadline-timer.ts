// FR-R4-F02 (spec 240, US2; contract U5 G16) — the retry coordinator's timer, as a recording double.
//
// Before feature 240 a delayed retry armed the credit watchdog's `pauseAndPoll`, so a controller
// test stubbed the watchdog and asserted the call. The coordinator now arms a timer of its own
// (`DeadlineTimer`), so those tests hand the controller this double instead and assert what it was
// asked to arm. It never fires by itself: a test that wants the deadline to elapse calls `fire`.
import type { DeadlineTimer } from '../src/services/retry-coordinator';

/** One `set` the coordinator made. */
export interface RecordedDeadline {
  readonly delayMs: number;
  /** True once the coordinator cleared it or it fired. */
  settled: boolean;
  /** Run the callback the coordinator registered, as the platform timer would. */
  fire(): void;
}

export class RecordingDeadlineTimer implements DeadlineTimer {
  /** Every `set`, in order, including those later cleared. */
  public readonly sets: RecordedDeadline[] = [];

  set(fn: () => void, delayMs: number): { clear(): void } {
    const recorded: RecordedDeadline = {
      delayMs,
      settled: false,
      fire: () => {
        recorded.settled = true;
        fn();
      }
    };
    this.sets.push(recorded);
    return {
      clear: () => {
        recorded.settled = true;
      }
    };
  }

  /** The deadlines that are armed right now. */
  armed(): RecordedDeadline[] {
    return this.sets.filter((entry) => !entry.settled);
  }
}
