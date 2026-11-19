// Feature 265 BUG-001 (FR-011) & Feature 020 BUG-004 (T091, FR-008) — single-Phase
// Task detection and non-executing Phase tile derivation for `RunDetailTier.svelte`.

import type { PhaseTile, QueueItem, QueueItemStatus, WorkflowSnapshot } from './snapshot-types';

const SINGLE_PHASE_TILE_STATE: Record<QueueItemStatus, PhaseTile['state']> = {
  pending: 'not-started',
  'in-flight': 'active',
  paused: 'active',
  completed: 'completed',
  failed: 'completed',
  canceled: 'completed'
};

/**
 * True when `taskId` is either:
 *   1. a Workflow leaf `phase` attempt in `snapshot.connectedRuns` (265 FR-011), or
 *   2. a standalone single-Phase Task whose `currentPipelineId` is listed in
 *      `snapshot.availablePhases` and absent from `snapshot.availablePipelines`
 *      (020 BUG-004 FR-008).
 */
export function isSinglePhaseTask(
  snapshot: WorkflowSnapshot,
  task: QueueItem | null,
  taskId: string
): boolean {
  const runs = snapshot.connectedRuns ?? [];
  const isLeafMember = runs.some((run) =>
    (run.invocations ?? []).some((frame) =>
      frame.attempts.some((attempt) => attempt.nodeKind === 'phase' && attempt.queueItemId === taskId)
    )
  );
  if (isLeafMember) return true;

  const isWorkflowAttempt = runs.some((run) =>
    (run.invocations ?? []).some((frame) =>
      frame.attempts.some((attempt) => attempt.queueItemId === taskId)
    )
  );
  if (isWorkflowAttempt) return false;

  const targetId = task?.currentPipelineId ?? null;
  if (targetId === null) return false;
  if (snapshot.availablePipelines.some((p) => p.id === targetId)) return false;
  return snapshot.availablePhases.some((p) => p.id === targetId);
}

export function deriveRunDetailPhases(args: {
  readonly snapshot: WorkflowSnapshot;
  readonly task: QueueItem | null;
  readonly taskId: string;
  readonly isExecuting: boolean;
  readonly runtimePhases: readonly PhaseTile[];
}): readonly PhaseTile[] {
  const { snapshot, task, taskId, isExecuting, runtimePhases } = args;
  const singlePhase = task?.currentPipelineId ?? null;
  if (
    isExecuting ||
    task === null ||
    singlePhase === null ||
    !isSinglePhaseTask(snapshot, task, taskId)
  ) {
    return runtimePhases;
  }
  return [
    {
      name: singlePhase,
      order: 1,
      state: SINGLE_PHASE_TILE_STATE[task.status],
      iteration: 1,
      lastResult: task.status === 'failed' ? 'failed' : null,
      elapsedMs: 0,
      subProgress: null
    }
  ];
}

