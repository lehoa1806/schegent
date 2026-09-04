import type { QueueItem } from './snapshot-types';

// FR-R3-158 (T022, research.md D5) — `deriveTaskPhaseProgress` and its
// `TaskPhaseProgress` shape were deleted from this file. The row's settled-phase
// figure arrives on the snapshot as `QueueItem.phaseProgress`, already paired
// with the total it belongs to, and the surface renders it without arithmetic
// (FR-004, FR-011).
//
// Deleted rather than reduced to a pass-through, deliberately. The old rule read
// the length of a pipeline the surface looked up for itself and subtracted no
// phase overrides, so a plan with disabled phases produced a count larger than
// its own total. A wrapper would have left that lookup — and its import — in
// place, which is a working template for the defect's return. With the function
// gone, SC-007 is structural: there is no code here that could count phases.
//
// The timing derivation below stays. It reads only the row's own Task, which is
// the same non-borrowing rule (FR-005), and it involves no phase identity.

export type TaskTimingLabel =
  | { readonly kind: 'elapsed'; readonly value: number }
  | { readonly kind: 'waiting'; readonly value: number };

type TimingTask = Pick<QueueItem, 'startedAt' | 'completedAt' | 'enqueuedAt'>;

/**
 * Reads only `task` — never `inFlightRun` — so a row for a Task that is not the
 * queue's executing Task cannot borrow live timing that belongs to a different
 * Task (FR-005, SC-002).
 */
export function deriveTaskTiming(task: TimingTask, nowMs: number): TaskTimingLabel {
  if (task.startedAt !== null) {
    const endMs = task.completedAt !== null ? Date.parse(task.completedAt) : nowMs;
    return { kind: 'elapsed', value: endMs - Date.parse(task.startedAt) };
  }
  return { kind: 'waiting', value: nowMs - Date.parse(task.enqueuedAt) };
}
