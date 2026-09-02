import { isOperableRunStatus } from '../state/workflow-run';
import type { WorkflowRun } from '../state/workflow-run';

/**
 * FR-R3-151 — the one authoritative rule set every `PhaseControlService`
 * mutation consults before writing anything (spec.md FR-001, FR-008).
 *
 * This module is a pure classifier: it reads the `WorkflowRun` it is handed
 * and returns an eligibility verdict, never touching `store`, `auditor`,
 * `queue`, or any other effectful dependency, and never retargeting
 * `run.pipeline` (spec.md FR-019; AGENTS.md rule 8). Operation-specific
 * transition writers stay in `PhaseControlService` — this file decides
 * whether they may run, not what they write.
 */

/** The closed set of operations this classifier decides for. */
export type PhaseControlOperation =
  | 'pause'
  | 'resume'
  | 'restart'
  | 'skip'
  | 'disable'
  | 'enable'
  | 'delete'
  | 'set-breakpoint'
  | 'clear-breakpoint';

/**
 * Closed rejection-reason vocabulary (spec.md FR-008, FR-018; Assumptions —
 * "a closed, enumerable set of refusal reasons"). Existing literals are the
 * exact strings `PhaseControlService` already returned before this feature;
 * they are reused verbatim here so no caller's existing reason-matching
 * (tests, ACK projection) breaks. The five new literals close the confirmed
 * defects: a terminal Restart, a wrong-Phase Skip, an already-started
 * Disable, and an Enable that is not both future and disabled.
 */
export type PhaseControlRejectionReason =
  // Existing, reused verbatim.
  | 'no-run-in-flight'
  | 'run-already-paused'
  | 'run-not-paused'
  | 'phase-id-not-in-pipeline-snapshot'
  | 'run-not-in-flight'
  | 'phase-unknown'
  | 'phase-in-flight'
  | 'phase-completed'
  | 'phase-overridden'
  | 'breakpoint-already-set'
  | 'breakpoint-not-set'
  // New (data-model.md "New: Phase Control Decision").
  | 'run-terminal'
  | 'phase-not-active'
  | 'phase-already-started'
  | 'phase-not-future'
  | 'no-disabled-override';

export interface PhaseControlDecisionInput {
  readonly operation: PhaseControlOperation;
  /**
   * The Run this operation targets, or `null` when none exists on the
   * queue (or, for breakpoint operations, when the caller has already
   * determined the named `runId` does not match the queue's current Run —
   * callers collapse that mismatch to `null` before calling in, so this
   * function sees one "no eligible Run" case rather than two).
   */
  readonly run: WorkflowRun | null;
  /** The Phase id the operator or IPC message named as the target. */
  readonly targetPhaseId: string;
}

export type PhaseControlDecisionResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: PhaseControlRejectionReason };

const ELIGIBLE: PhaseControlDecisionResult = { eligible: true };

function reject(reason: PhaseControlRejectionReason): PhaseControlDecisionResult {
  return { eligible: false, reason };
}

/**
 * Feature 098 (T029, US3, FR-028) — a Run's phases are the ones in its own
 * snapshot, and a Run without one has none. There is deliberately no
 * `BUILT_IN_PHASES` fallback: a snapshot-less Run would otherwise have every
 * membership question answered by a code-resident catalog it was never going
 * to execute, so a breakpoint or removal could land on a Phase the Run
 * cannot run. `false` is the answer that stays correct even if a code-
 * resident catalog is ever non-empty again.
 *
 * Exported (moved here from `PhaseControlService` by this feature) so
 * `removeTaskPhase`'s own unknown-phase-id check reuses this exact answer
 * instead of a second copy of the same one-line predicate.
 */
export function phaseExists(run: WorkflowRun, phaseId: string): boolean {
  return (run.pipeline?.phases ?? []).some((phase) => phase.id === phaseId);
}

/**
 * A Run is mid-retry-countdown when it is `paused` with a pending retry
 * timer armed. Exported so `PhaseControlService#pauseActivePhase` — which
 * needs this same fact after the eligibility check passes, to decide
 * whether to cancel the pending timer and how to stamp the audit event —
 * reads the identical predicate this classifier's 'pause' branch decides
 * eligibility with, rather than a second copy that could drift from it.
 */
export function isRunInRetryCountdown(run: WorkflowRun): boolean {
  return run.status === 'paused' && run.pendingRetryAt !== null;
}

/**
 * A Phase "has not yet started" (FR-005) when it is not the Run's current
 * Phase, has no entry in `phasesCompleted` (never reached), and carries no
 * `removed` override (already deleted from the visible progression is not a
 * valid future target either). Matches the fallback branch of
 * `PhaseControlService#describePhaseState`.
 */
function isPhaseFuture(run: WorkflowRun, phaseId: string): boolean {
  if (run.currentPhase === phaseId) return false;
  if (run.phasesCompleted.some((entry) => entry.phase === phaseId)) return false;
  if (run.phaseOverrides.some((override) => override.phaseId === phaseId && override.action === 'removed')) {
    return false;
  }
  return true;
}

export function decidePhaseControl(input: PhaseControlDecisionInput): PhaseControlDecisionResult {
  const { operation, run, targetPhaseId } = input;

  switch (operation) {
    case 'pause': {
      if (!run) return reject('no-run-in-flight');
      if (run.status !== 'running' && !isRunInRetryCountdown(run)) return reject('no-run-in-flight');
      if (run.manualPauseAt !== null) return reject('run-already-paused');
      return ELIGIBLE;
    }

    case 'resume': {
      if (!run) return reject('no-run-in-flight');
      if (run.manualPauseAt === null && run.pendingRetryAt === null) return reject('run-not-paused');
      return ELIGIBLE;
    }

    case 'restart': {
      if (!run) return reject('no-run-in-flight');
      // `isOperableRunStatus` is the codebase's own answer to "can the
      // operator still act on this Run" — 'failed' is deliberately operable
      // (skip/retry exist largely for failed Runs); only 'completed' and
      // 'canceled' are terminal in both senses (workflow-run.ts). Restart on
      // either of those is the confirmed defect FR-002 closes.
      if (!isOperableRunStatus(run.status)) return reject('run-terminal');
      if (targetPhaseId !== run.currentPhase) return reject('phase-not-active');
      return ELIGIBLE;
    }

    case 'skip': {
      if (!run) return reject('no-run-in-flight');
      if (!phaseExists(run, targetPhaseId)) return reject('phase-id-not-in-pipeline-snapshot');
      // A canceled Run keeps its `currentPhase` unchanged (unlike a
      // completed Run, whose `currentPhase` moves to a sentinel that already
      // fails the check below), so without this it stays Skip-eligible on
      // its own terminal outcome — the same "wrong-state" defect class FR-002
      // closed for Restart. `isOperableRunStatus` is deliberately not
      // narrowed to `run.status === 'running'`: `PhaseControlService`'s
      // post-override branches treat 'paused' and 'failed' Runs as
      // legitimate skip-to-recover starting points, so only the genuinely
      // terminal statuses ('completed', 'canceled') are rejected here.
      if (!isOperableRunStatus(run.status)) return reject('run-terminal');
      if (targetPhaseId !== run.currentPhase) return reject('phase-not-active');
      return ELIGIBLE;
    }

    case 'disable': {
      if (!run) return reject('no-run-in-flight');
      if (!phaseExists(run, targetPhaseId)) return reject('phase-id-not-in-pipeline-snapshot');
      if (!isPhaseFuture(run, targetPhaseId)) return reject('phase-already-started');
      return ELIGIBLE;
    }

    case 'enable': {
      if (!run) return reject('no-run-in-flight');
      if (!phaseExists(run, targetPhaseId)) return reject('phase-id-not-in-pipeline-snapshot');
      const override = run.phaseOverrides.find((entry) => entry.phaseId === targetPhaseId);
      if (!override || override.action !== 'disabled') return reject('no-disabled-override');
      if (!isPhaseFuture(run, targetPhaseId)) return reject('phase-not-future');
      return ELIGIBLE;
    }

    case 'delete': {
      // Delete stays permissive by design (Feature 022 FR-008–FR-013): any
      // visible completed, active, skipped, failed, disabled, or future
      // Phase is a legitimate target. `PhaseControlService#removeTaskPhase`
      // keeps its own task-id/phase-id/already-removed checks after this
      // call returns eligible — this branch exists so Delete is still
      // routed through the one shared decision point (census guard,
      // contracts/phase-control-decision.md invariant 4), not to add a new
      // restriction.
      return ELIGIBLE;
    }

    case 'set-breakpoint': {
      if (!run) return reject('run-not-in-flight');
      if (!phaseExists(run, targetPhaseId)) return reject('phase-unknown');
      if (run.currentPhase === targetPhaseId) return reject('phase-in-flight');
      if (run.phasesCompleted.some((entry) => entry.phase === targetPhaseId)) return reject('phase-completed');
      if (run.phaseOverrides.some((entry) => entry.phaseId === targetPhaseId)) return reject('phase-overridden');
      if (run.phaseBreakpoints.some((entry) => entry.phaseId === targetPhaseId)) {
        return reject('breakpoint-already-set');
      }
      return ELIGIBLE;
    }

    case 'clear-breakpoint': {
      if (!run) return reject('run-not-in-flight');
      if (!run.phaseBreakpoints.some((entry) => entry.phaseId === targetPhaseId)) {
        return reject('breakpoint-not-set');
      }
      return ELIGIBLE;
    }
  }
}
