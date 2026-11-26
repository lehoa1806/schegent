/**
 * FR-R6-F11 (FR-022, NFR-001; research R9) — sliced host work with a deadline and cancellation.
 *
 * A loop body runs over a list. Once a slice has used `sliceMs` of the injected monotonic clock,
 * the slicer records the slice's duration, checks the signal and the deadline, and yields to the
 * event loop. An aborted signal ends `cancelled` within one slice; the deadline ends `limited`
 * with `deadline-exceeded` (queries) or `export-time` (exports).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  reportCancelled,
  reportLimited,
  reportOk,
  type LimitReason,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';

/** Host work per slice before the slicer yields (research R9). */
export const DEFAULT_SLICE_MS = 8;

export interface WorkSlicerOptions {
  /** A monotonic clock in milliseconds. */
  readonly monotonicMs: () => number;
  /** The monotonic reading at which the work is out of time. */
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
  readonly sliceMs?: number;
  /** The limit reason the deadline ends with. */
  readonly deadlineLimit?: LimitReason;
  /** Yields to the event loop; `setImmediate` when absent. */
  readonly yieldNow?: () => Promise<void>;
}

export interface WorkSlicer {
  forEach<T>(items: readonly T[], visit: (item: T) => void): Promise<ReportResult<undefined>>;
  /** Every finished slice's duration, oldest first. */
  sliceDurations(): readonly number[];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Creates a slicer; its slice durations accumulate across every `forEach`. */
export function createWorkSlicer(options: WorkSlicerOptions): WorkSlicer {
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  const deadlineLimit = options.deadlineLimit ?? 'deadline-exceeded';
  const yieldNow = options.yieldNow ?? yieldToEventLoop;
  const durations: number[] = [];
  // Carry the active slice start across sequential `forEach` stages so back-to-back loops on one
  // slicer share the same event-loop budget instead of summing into a 2x stall between yields,
  // while updating (rather than double-pushing) the active slice entry and resetting after any
  // external async gap.
  let activeSliceStart: number | null = null;
  let activeSliceRecordedIndex: number | null = null;
  let activeSliceLastEnd: number | null = null;

  function recordSlice(elapsed: number): void {
    if (activeSliceRecordedIndex !== null) {
      durations[activeSliceRecordedIndex] = elapsed;
    } else {
      activeSliceRecordedIndex = durations.length;
      durations.push(elapsed);
    }
  }

  function interruption(): ReportResult<undefined> | undefined {
    if (options.signal?.aborted === true) {
      return reportCancelled();
    }
    return options.monotonicMs() >= options.deadlineAtMs ? reportLimited(deadlineLimit) : undefined;
  }

  async function forEach<T>(items: readonly T[], visit: (item: T) => void): Promise<ReportResult<undefined>> {
    const before = interruption();
    if (before !== undefined) {
      return before;
    }
    const callStart = options.monotonicMs();
    if (
      activeSliceStart === null ||
      (activeSliceLastEnd !== null && callStart - activeSliceLastEnd >= sliceMs)
    ) {
      activeSliceStart = callStart;
      activeSliceRecordedIndex = null;
    }
    let sliceStart = activeSliceStart;
    let pending = false;
    for (const item of items) {
      visit(item);
      pending = true;
      const elapsed = options.monotonicMs() - sliceStart;
      if (elapsed < sliceMs) {
        continue;
      }
      recordSlice(elapsed);
      activeSliceRecordedIndex = null;
      pending = false;
      const stop = interruption();
      if (stop !== undefined) {
        activeSliceStart = null;
        activeSliceLastEnd = null;
        return stop;
      }
      await yieldNow();
      sliceStart = options.monotonicMs();
      activeSliceStart = sliceStart;
      activeSliceLastEnd = null;
    }
    if (pending) {
      const endMs = options.monotonicMs();
      recordSlice(endMs - sliceStart);
      activeSliceLastEnd = endMs;
    }
    return interruption() ?? reportOk(undefined);
  }

  return { forEach, sliceDurations: () => [...durations] };
}
