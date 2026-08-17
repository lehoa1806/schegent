import type { PipelineDefinition, QueueItem } from './snapshot-types';

export interface TaskPhaseProgress {
  readonly completed: number;
  readonly total: number;
}

export type TaskTimingLabel =
  | { readonly kind: 'elapsed'; readonly value: number }
  | { readonly kind: 'waiting'; readonly value: number };

type ProgressTask = Pick<QueueItem, 'status' | 'currentPhase'>;
type TimingTask = Pick<QueueItem, 'startedAt' | 'completedAt' | 'enqueuedAt'>;

/**
 * Reads only `task` and `pipeline` — never `inFlightRun` — so a row for a
 * Task that is not the queue's executing Task cannot borrow live timing or
 * iteration data that belongs to a different Task (FR-005, SC-002).
 */
export function deriveTaskPhaseProgress(
  task: ProgressTask,
  pipeline: PipelineDefinition | undefined
): TaskPhaseProgress {
  if (pipeline === undefined) return { completed: 0, total: 0 };
  const total = pipeline.phases.length;
  if (task.status === 'completed') return { completed: total, total };
  const index = task.currentPhase === null ? -1 : pipeline.phases.indexOf(task.currentPhase);
  return { completed: index === -1 ? 0 : index, total };
}

export function deriveTaskTiming(task: TimingTask, nowMs: number): TaskTimingLabel {
  if (task.startedAt !== null) {
    const endMs = task.completedAt !== null ? Date.parse(task.completedAt) : nowMs;
    return { kind: 'elapsed', value: endMs - Date.parse(task.startedAt) };
  }
  return { kind: 'waiting', value: nowMs - Date.parse(task.enqueuedAt) };
}
