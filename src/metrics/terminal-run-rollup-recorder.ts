// Feature FR-R3-009 (T390, T391) — the single rollup append site.
//
// Deviation from T390/T391's wording, recorded here because it is the kind of
// deviation that matters: the tasks name `controller/workflow-controller.ts`,
// and the append is sited at `TerminalTransitionCoordinator.complete()` instead.
// The controller has several terminal paths (its own completion handler, the
// driver's `finally`, the fail-closed evidence path, cancel), and "exactly one
// record per terminal run" cannot be asserted across all of them. Both terminal
// callers funnel through `complete()`, which is also the crash-replay entry
// point, so an append placed there is reached exactly once per terminal
// transition *and* survives a crash between the transition and the append. The
// writer's own run-id idempotence is what makes replay safe.
//
// This module owns the projection from a `WorkflowRun` to rollup facts. It is
// separate from the coordinator so the coordinator takes no dependency on
// `metrics/`: it sees only `recordTerminalRun`.

import type { SanitizedLogger } from '../lib/logger';
import { computeRunPhaseStats, isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import type { MetricsRollupAppender } from './metrics-rollup-writer';
import type { RollupTerminalStatus } from './metrics-rollup';
import { readMetrics } from './metrics-service';

/**
 * Cost and invocation counts for one run, projected from the audit fold.
 *
 * Neither number lives on `WorkflowRun` — `PhaseResult` carries no cost field
 * and the run record counts no CLI invocations — so the source of truth is the
 * same fold the dashboard uses. Reading it here rather than accumulating a
 * parallel counter is deliberate: the rollup and the fold are unioned by run id,
 * and a run must produce identical figures through either path.
 */
export interface RunMetricsProjection {
  readonly costUsd: number | undefined;
  readonly backendInvocations: number;
}

export type RunMetricsProjector = (runId: string) => Promise<RunMetricsProjection>;

export interface TerminalRunRollupRecorderDeps {
  readonly writer: MetricsRollupAppender;
  readonly logger: SanitizedLogger;
  /** Injectable for tests; defaults to the audit fold over live plus archives. */
  readonly projectRunMetrics?: RunMetricsProjector;
  readonly workspaceRoot: string;
}

export interface TerminalRollupRecorder {
  recordTerminalRun(run: WorkflowRun): Promise<void>;
}

export class TerminalRunRollupRecorder implements TerminalRollupRecorder {
  private readonly project: RunMetricsProjector;

  constructor(private readonly deps: TerminalRunRollupRecorderDeps) {
    this.project =
      deps.projectRunMetrics ?? ((runId) => foldRunMetrics(deps.workspaceRoot, runId, deps.logger));
  }

  /**
   * Append this run's rollup record, best-effort (T391).
   *
   * Every failure mode resolves rather than throws. The caller is a terminal
   * transition: a run that finished has finished, and a summary that could not be
   * written must not turn that into a failure. The writer reports the failure to
   * evidence health and warns once per cause; this method's own `catch` exists
   * for the projection, which reads the audit corpus and can fail independently.
   */
  public async recordTerminalRun(run: WorkflowRun): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;

    let projection: RunMetricsProjection;
    try {
      projection = await this.project(run.id);
    } catch (err) {
      // Fall back to a record without cost or invocation counts rather than to
      // no record at all: run counts, durations, and phase counters are still
      // durable, and an absent `costUsd` is honestly reported as partial by
      // `CumulativeTotals.costUsdIsPartial`. Dropping the record instead would
      // lose the run from cumulative totals the moment its log evidence rotated.
      this.deps.logger.warn('metrics rollup: run cost projection failed; recording counters only', {
        runId: run.id,
        cause: (err as NodeJS.ErrnoException).code ?? 'io-error'
      });
      projection = { costUsd: undefined, backendInvocations: 0 };
    }

    const startedAtMs = run.startedAt;
    const endedAtMs = run.lastTransitionAt ?? run.startedAt;
    const stats = computeRunPhaseStats(run);

    await this.deps.writer.append({
      runId: run.id,
      terminalStatus: run.status as RollupTerminalStatus,
      startedAt: new Date(startedAtMs).toISOString(),
      // `lastTransitionAt`, not `Date.now()`: a crash-replayed transition must
      // record when the run actually ended, not when the host next started.
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      phasesTotal: stats.phasesTotal,
      phasesCompleted: stats.phasesCompleted,
      phasesSkipped: stats.phasesSkipped,
      backendInvocations: projection.backendInvocations,
      ...(projection.costUsd === undefined ? {} : { costUsd: projection.costUsd })
    });
  }
}

/**
 * Project one run's cost and invocation counts out of the audit fold.
 *
 * `includeArchives: true` on purpose: a run that spanned a rotation has some of
 * its `phase-end` entries in an archive, and reading only the live log would
 * understate its cost silently — the one failure mode this feature exists to
 * remove. The fold is offset-cached per process, so this is a tail scan after the
 * first call in a session.
 */
export async function foldRunMetrics(
  workspaceRoot: string,
  runId: string,
  logger?: SanitizedLogger
): Promise<RunMetricsProjection> {
  const { tasks } = await readMetrics(workspaceRoot, { includeArchives: true }, logger);
  const task = tasks.find((candidate) => candidate.runId === runId);
  return {
    costUsd: task?.totalCostUsd,
    backendInvocations: task?.totalBackendInvocations ?? 0
  };
}
