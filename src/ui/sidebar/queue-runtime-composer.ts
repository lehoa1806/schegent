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
// The ownership rule is a lookup, not an inference. Feature 093 (T051) made it
// a direct one: the Run record is keyed by queue, so the key *is* the
// attribution and there is nothing left to resolve. The scan it replaces —
// "which queue holds a row whose id matches `run.featureId`" — existed only
// because the record had no key to ask; with N Runs it would also have to be run
// N times per queue. A queue that owns no Run publishes the empty projection
// FR-053 requires: never a sibling queue's Run, and never a fabricated stand-in.

import type { FeatureRequest } from '../../queue/feature-request';
import type { WorkflowRun } from '../../state/workflow-run';
import type { RunOutputRecord } from '../../contracts/run-results';
// Feature 103 — by path, not through the contracts barrel; see the note on the
// same import in `snapshot.ts`.
import type { CatalogVersionRef } from '../../contracts/catalog-version';
import type { RunOriginRef } from '../../contracts/run-origin';
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
  RunLivenessProjection,
  RunProgressProjection,
  WorkflowStatus
} from './snapshot';

/**
 * Feature 093 (T051) — every run-scoped reading for one queue's Run, computed
 * by the projector and handed in whole.
 *
 * One bundle per queue replaces the eight flat fields this context carried while
 * a window had one Run. They travel together because they are one Run's
 * readings: splitting them back out would let a caller pass queue A's phases
 * beside queue B's elapsed time, which is exactly the interleaving the per-queue
 * projection exists to stop.
 */
export interface QueueRunProjection {
  readonly run: WorkflowRun;
  readonly status: WorkflowStatus;
  readonly phases: readonly PhaseTile[];
  readonly activePipeline: ActivePipelineSummary | null;
  readonly liveActivity: LiveActivity;
  /**
   * FR-R3-008 (T379) — the persisted liveness stamp, and progress against the
   * frozen total. Handed in like every other reading above rather than derived
   * here: `run-planned-total.ts` owns the plan arithmetic, and a second
   * computation at this seam is precisely how a numerator and a denominator come
   * to disagree. `null` on either means unknown.
   */
  readonly liveness: RunLivenessProjection | null;
  readonly progress: RunProgressProjection | null;
  readonly elapsedMs: number | null;
  readonly delayedRetry: DelayedRetryState;
  readonly outputs: readonly RunOutputRecord[];
  readonly activeFeature: ActiveFeatureSummary | null;
  /**
   * Feature 103 (T031, FR-003) — the two provenance readings, handed in like
   * every other one above and for the same reason: this module recomputes
   * nothing. `origin` in particular needs the connected-run map, which belongs
   * to the host, not to a composer that only knows about queues.
   *
   * Both optional. Absent means not recorded and not knowable respectively, and
   * the surface states either plainly rather than filling it in.
   */
  readonly catalogVersion?: CatalogVersionRef;
  readonly origin?: RunOriginRef;
}

export interface QueueRuntimeComposerContext {
  /** The registry read the queue projector already performed, in position order. */
  readonly summaries: readonly QueueSummary[];
  /** The Run this queue owns and its readings, or `null` when it owns none. */
  readonly runOf: (queueId: string) => QueueRunProjection | null;
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

function projectInFlightRun(projection: QueueRunProjection): InFlightRunProjection {
  return Object.freeze({
    runId: projection.run.id,
    status: projection.status,
    feature: projection.activeFeature,
    pipeline: projection.activePipeline,
    elapsedMs: projection.elapsedMs,
    liveActivity: projection.liveActivity,
    liveness: projection.liveness,
    progress: projection.progress,
    delayedRetry: projection.delayedRetry,
    resumeTargetPhaseId: projection.run.resumeTargetPhaseId ?? null,
    outputs: Object.freeze(projection.outputs.slice()),
    // Feature 103 (T031, FR-003) — spread rather than assigned, so an unknown
    // provenance is an absent key on the wire and never `undefined` as a value.
    // The webview distinguishes the two: absent renders as a stated absence.
    ...(projection.catalogVersion !== undefined
      ? { catalogVersion: projection.catalogVersion }
      : {}),
    ...(projection.origin !== undefined ? { origin: projection.origin } : {})
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
  return Object.freeze(
    ctx.summaries.map((summary) => {
      const requests = ctx.requestsOf(summary.id);
      const pendingCount = requests.filter((request) => request.status === 'pending').length;
      const lifecycle = ctx.lifecycleOf(summary.id);
      const tasks = Object.freeze((ctx.rowsOf?.(summary.id) ?? []).slice());
      const projection = ctx.runOf(summary.id);
      if (projection === null) return emptyRuntime(summary, lifecycle, pendingCount, tasks);
      const run = projection.run;
      return Object.freeze({
        queueId: summary.id,
        name: summary.name,
        position: summary.position,
        lifecycle,
        inFlightRun: projectInFlightRun(projection),
        phases: Object.freeze(projection.phases.map((phase) => Object.freeze(phase))),
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
