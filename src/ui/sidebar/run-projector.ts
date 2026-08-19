// Feature 048 — pure-function run/lock/delayed-retry projection extracted from
// `state-projector.ts`. These helpers are deterministic on their inputs;
// memoization can wrap them at the orchestrator level when callers care.
import type { WorkflowRun, WorkspaceLock } from '../../state/workflow-run';
import type { RunOutputRecord } from '../../contracts/run-results';
import { STALENESS_THRESHOLD_MS } from '../../state/lock';
import { countCompletedInPlan } from '../../services/run-planned-total';
import {
  IDLE_DELAYED_RETRY,
  type ActiveFeatureSummary,
  type DelayedRetryState,
  type RunLivenessProjection,
  type RunProgressProjection,
  type WorkflowStatus
} from './snapshot';

export function computeIsPrimary(
  ownerId: string,
  lock: WorkspaceLock | null,
  nowMs: number
): boolean {
  if (!lock) return true;
  if (nowMs - lock.heartbeatAt > STALENESS_THRESHOLD_MS) return true;
  return lock.ownerId === ownerId;
}

export function mapRunStatus(run: WorkflowRun): WorkflowStatus {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    default:
      return 'idle';
  }
}

export function buildActiveFeature(run: WorkflowRun): ActiveFeatureSummary {
  return {
    id: run.featureId,
    label: run.featureDir,
    startedAt: new Date(run.startedAt).toISOString()
  };
}

/**
 * Feature 011 — surface delayed-retry state on the snapshot. When no run
 * is active or there is no pending retry, returns the IDLE constant so
 * webview gating (`pendingRetryAt !== null`) reliably resolves to false.
 */
export function projectDelayedRetry(run: WorkflowRun | null): DelayedRetryState {
  if (!run) return IDLE_DELAYED_RETRY;
  const count = run.delayedRetryCount ?? 0;
  const pendingAt = run.pendingRetryAt ?? null;
  const cause = run.pendingRetryCause ?? null;
  if (pendingAt === null && cause === null && count === 0) return IDLE_DELAYED_RETRY;
  return Object.freeze({
    pendingRetryAt: pendingAt !== null ? new Date(pendingAt).toISOString() : null,
    pendingRetryCause: cause,
    delayedRetryCount: count
  });
}

/**
 * FR-R3-008 (T379) — publish the persisted liveness stamp, or `null`.
 *
 * `null` for a Run that carries no `liveness`, which is every Run written before
 * the feature and every Run whose phase has not spoken yet. The distinction
 * between those two and "silent for three hours" is exactly what the caller
 * needs, so absence is never filled in with a zero or with `startedAt`.
 */
export function projectRunLiveness(run: WorkflowRun | null): RunLivenessProjection | null {
  const liveness = run?.liveness;
  if (!liveness) return null;
  return Object.freeze({
    lastActivityAt: new Date(liveness.lastActivityAt).toISOString(),
    stdoutLines: liveness.stdoutLines,
    stderrLines: liveness.stderrLines
  });
}

/**
 * FR-R3-008 (T379) — divide the numerator by the Run's frozen denominator.
 *
 * The clamp is here, once, rather than in each renderer: the two sides are kept
 * consistent by `run-planned-total.ts` and by the override write, so a value
 * above 100 would be a bug rather than a display problem — but a UI that
 * rendered a 130%-wide bar would hide it, so it is bounded at the boundary and
 * the invariant is asserted by the unit tests instead.
 *
 * A plan with nothing left to run reports 100 rather than dividing by zero: a
 * Run whose every phase is overridden has, correctly, nothing outstanding.
 */
export function projectRunProgress(run: WorkflowRun | null): RunProgressProjection | null {
  if (!run) return null;
  const total = run.plannedTotal;
  if (!total) return null;
  const completed = countCompletedInPlan(run);
  const percent =
    total.phaseCount === 0
      ? 100
      : Math.min(100, Math.max(0, Math.round((completed / total.phaseCount) * 100)));
  return Object.freeze({
    phasesCompleted: completed,
    phaseCount: total.phaseCount,
    iterationCap: total.iterationCap,
    maxPhaseInvocations: total.maxPhaseInvocations,
    percent
  });
}

/** Ceilings for the two operator-authored strings a recorded output carries. */
const OUTPUT_NAME_MAX = 64;
const OUTPUT_REFERENCE_MAX = 512;

/**
 * Feature 087 (T064, FR-043) — the named outputs a completed Run recorded,
 * projected into the same snapshot Run details already reads for Phase
 * progression, logs, and evidence links.
 *
 * Returns a spread-shaped object rather than a value, so a Run that recorded
 * none contributes no key at all — the shape every other additive field on this
 * snapshot uses, because `{ runOutputs: undefined }` and absence serialize the
 * same but are not the same object.
 *
 * Both fields are operator-authored: the identifier comes from the Pipeline the
 * operator wrote, the reference from the target they typed. Both are therefore
 * sanitized and capped like every other catalog string that crosses to the
 * webview. There is nothing else to project — a record is a location, never
 * content (FR-040a) — and an unresolved output keeps no reference key (FR-042).
 */
export function projectRunOutputs(
  run: WorkflowRun | null,
  sanitize: (value: string) => string
): { runOutputs?: readonly RunOutputRecord[] } {
  const recorded = run?.runOutputs;
  if (recorded === undefined) return {};
  return {
    runOutputs: Object.freeze(recorded.map((output) => Object.freeze({
      name: sanitize(output.name).slice(0, OUTPUT_NAME_MAX),
      status: output.status,
      ...(output.reference !== undefined
        ? { reference: sanitize(output.reference).slice(0, OUTPUT_REFERENCE_MAX) }
        : {})
    })))
  };
}
