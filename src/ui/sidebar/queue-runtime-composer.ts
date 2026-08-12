// Feature 092 (T092, T093, T095, US4) — compose one `QueueRuntime` per queue.
// Contract: specs/092-multi-queue-concurrency/contracts/snapshot-v4-and-drill-down.md
// Shape: specs/092-multi-queue-concurrency/data-model.md §1.4
//
// Its own module rather than more lines in `snapshot-composer.ts` because it
// answers one question the composer does not: *which queue owns the Run*. Every
// run-scoped reading the composer already computes is handed in; nothing is
// recomputed here, so there is no second place a phase list or a retry count
// could be derived differently.
//
// The ownership rule is a lookup, not an inference: the Run names a Task
// (`run.featureId`), and exactly one queue holds that Task's row. A queue that
// does not hold it publishes the empty projection FR-053 requires — never the
// owning queue's Run, and never a fabricated stand-in.

import type { FeatureRequest } from '../../queue/feature-request';
import type { WorkflowRun } from '../../state/workflow-run';
import type { RunOutputRecord } from '../../contracts/run-results';
import type {
  ActiveFeatureSummary,
  ActivePipelineSummary,
  DelayedRetryState,
  InFlightRunProjection,
  LiveActivity,
  PhaseTile,
  QueueItem,
  QueueLifecycle,
  QueueRuntime,
  QueueSummary,
  WorkflowStatus
} from './snapshot';

export interface QueueRuntimeComposerContext {
  /** The registry read the queue projector already performed, in position order. */
  readonly summaries: readonly QueueSummary[];
  readonly run: WorkflowRun | null;
  readonly status: WorkflowStatus;
  readonly phases: readonly PhaseTile[];
  readonly activePipeline: ActivePipelineSummary | null;
  readonly liveActivity: LiveActivity;
  readonly elapsedMs: number | null;
  readonly delayedRetry: DelayedRetryState;
  readonly outputs: readonly RunOutputRecord[];
  readonly activeFeature: ActiveFeatureSummary | null;
  readonly lifecycleOf: (queueId: string) => QueueLifecycle;
  readonly requestsOf: (queueId: string) => readonly FeatureRequest[];
  /**
   * Feature 092 (T108, FR-057) — the queue's rows already projected to the wire
   * shape, for the Queue Detail tier to list. Handed in for the same reason
   * every run-scoped reading above is: the projection belongs to the projector,
   * and a second mapping here could disagree with the one the default queue got.
   * Optional, and an absent one publishes no rows rather than a borrowed list.
   */
  readonly rowsOf?: (queueId: string) => readonly QueueItem[];
}

/**
 * The empty projection of FR-053, spelled once. A queue that owns no Run is not
 * a queue with a partially-filled Run — every run-scoped field is absent or
 * empty together, so no consumer can read one of them as live while the rest
 * say idle.
 */
function emptyRuntime(
  summary: QueueSummary,
  lifecycle: QueueLifecycle,
  pendingCount: number,
  tasks: readonly QueueItem[]
): QueueRuntime {
  return Object.freeze({
    queueId: summary.id,
    name: summary.name,
    position: summary.position,
    lifecycle,
    inFlightRun: null,
    phases: Object.freeze([]) as readonly PhaseTile[],
    phaseOverrides: Object.freeze([]) as QueueRuntime['phaseOverrides'],
    manualPause: null,
    phaseBreakpoints: Object.freeze([]) as QueueRuntime['phaseBreakpoints'],
    pendingCount,
    tasks
  });
}

function projectInFlightRun(ctx: QueueRuntimeComposerContext, run: WorkflowRun): InFlightRunProjection {
  return Object.freeze({
    runId: run.id,
    status: ctx.status,
    feature: ctx.activeFeature,
    pipeline: ctx.activePipeline,
    elapsedMs: ctx.elapsedMs,
    liveActivity: ctx.liveActivity,
    delayedRetry: ctx.delayedRetry,
    resumeTargetPhaseId: run.resumeTargetPhaseId ?? null,
    outputs: Object.freeze(ctx.outputs.slice())
  });
}

function projectManualPause(run: WorkflowRun): QueueRuntime['manualPause'] {
  // The pair moves together or not at all. A cause without a timestamp was
  // representable in v3 and meant nothing; here it is unrepresentable.
  if (run.manualPauseAt === null || run.manualPauseAt === undefined) return null;
  if (run.manualPauseCause === null || run.manualPauseCause === undefined) return null;
  return Object.freeze({
    at: new Date(run.manualPauseAt).toISOString(),
    cause: run.manualPauseCause
  });
}

function projectBreakpoints(run: WorkflowRun): QueueRuntime['phaseBreakpoints'] {
  return Object.freeze(
    [...(run.phaseBreakpoints ?? [])]
      .sort((a, b) => a.setAt - b.setAt)
      .map((breakpoint) =>
        Object.freeze({
          phaseId: breakpoint.phaseId,
          setAt: new Date(breakpoint.setAt).toISOString(),
          actor: breakpoint.actor
        })
      )
  );
}

export function composeQueueRuntimes(ctx: QueueRuntimeComposerContext): readonly QueueRuntime[] {
  const run = ctx.run;
  return Object.freeze(
    ctx.summaries.map((summary) => {
      const requests = ctx.requestsOf(summary.id);
      const pendingCount = requests.filter((request) => request.status === 'pending').length;
      const lifecycle = ctx.lifecycleOf(summary.id);
      const tasks = Object.freeze((ctx.rowsOf?.(summary.id) ?? []).slice());
      // Ownership by Task row, not by `inFlightId`: a Run whose Task has already
      // left the in-flight slot (completed, failed) still belongs to the queue
      // that ran it, and the operator is still looking at its result.
      const owns = run !== null && requests.some((request) => request.id === run.featureId);
      if (!owns) return emptyRuntime(summary, lifecycle, pendingCount, tasks);
      return Object.freeze({
        queueId: summary.id,
        name: summary.name,
        position: summary.position,
        lifecycle,
        inFlightRun: projectInFlightRun(ctx, run),
        phases: Object.freeze(ctx.phases.map((phase) => Object.freeze(phase))),
        phaseOverrides: Object.freeze(
          (run.phaseOverrides ?? []).map((override) =>
            Object.freeze({ phaseId: override.phaseId, action: override.action })
          )
        ),
        manualPause: projectManualPause(run),
        phaseBreakpoints: projectBreakpoints(run),
        pendingCount,
        tasks
      });
    })
  );
}
