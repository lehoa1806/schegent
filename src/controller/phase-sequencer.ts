/**
 * Feature 034 Item 047 (completion) — extracted next-phase decision logic.
 *
 * Pure module. No `vscode` import. No I/O. No state mutation. Given a
 * `WorkflowRun` + phase output + iteration cap, the sequencer returns a
 * typed decision union the controller acts on.
 *
 * Wraps `transition()` from ./phase with run-state awareness:
 *   - `phaseOverrides`         (skipped / disabled / removed pre-dispatch)
 *   - `phaseBreakpoints`       (consumed-by-fire after runner returns
 *                               outcome === 'paused-at-breakpoint')
 *   - delayed-retry cause      (rate_limit / transient_error)
 *   - verify-phase non-clean   (bugfix-verify-pre / bugfix-verify-post)
 *   - manual-pause-mid-run     (latest persisted run has manualPauseAt set)
 *
 * The controller still owns:
 *   - State persistence (`persistTransition`)
 *   - Audit emissions (`appendPhaseControlAudit`, `appendBreakpointAudit`)
 *   - Status bar updates
 *   - Queue mutations (`cascadedPause`, `pause`, `setQueuePausedState`, `finish`)
 *   - Aggressive-pause kill ordering (CLAUDE.md 033 FR-001)
 *   - Single `-c` append site (CLAUDE.md 032 FR-001)
 *   - `IsContinueGate` arm/consume (CLAUDE.md 032; see ./is-continue-gate)
 *
 * CLAUDE.md hard rules preserved:
 *   - The verify-phase pause keeps `currentPhase` unchanged so resume
 *     re-invokes the failing verify phase (026 FR-016).
 *   - The breakpoint-consumed phase is filtered out of `phaseBreakpoints`
 *     and stashed in `resumeTargetPhaseId` (028 T036).
 *   - The pause-cause pair invariant (017/028) — both `manualPauseAt` /
 *     `manualPauseCause` set together — is upheld by the caller writing
 *     both fields when acting on `pause-breakpoint` or `pause-manual`.
 *   - The retry-pair invariant (011) — both `pendingRetryAt` /
 *     `pendingRetryCause` set together — is upheld by `RetryHandler`.
 *     The sequencer only classifies the cause; it never writes the run.
 */

import type {
  PhaseOverride,
  PhaseResult,
  WorkflowRun
} from '../state/workflow-run';
import type { PhaseDef } from '../config/pipeline-config';
import { transition, type TransitionResult } from './phase';
import type { PhaseRunOutput } from './phase-runner';
import { toDelayedRetryCause } from './rate-limit-backoff';

/** Pre-dispatch decision: skip the current phase or invoke the runner. */
export type PrePhaseDecision =
  | {
      readonly kind: 'skip-phase';
      readonly override: PhaseOverride;
      readonly skippedResult: PhaseResult;
      readonly transition: TransitionResult;
    }
  | {
      readonly kind: 'invoke';
      readonly iteration: number;
      readonly activePhaseDef: PhaseDef | undefined;
    };

/** Post-dispatch decision: what the controller does with the runner's output. */
export type PostPhaseDecision =
  | {
      readonly kind: 'pause-breakpoint';
      readonly consumedPhaseId: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'pause-delayed-retry';
      readonly cause: 'rate_limit' | 'transient_error';
      // Feature 066 — pre-normalization cause string (e.g.,
      // `'out-of-credits'`). Threaded through to `backoffForCause` so
      // the past-timestamp guard can fire on hard-cap quotas.
      readonly originalCause: string | undefined;
      readonly resetsAtMs: number | null;
      readonly rateLimitMessage: string | null;
      readonly phaseResult: PhaseResult;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'pause-rate-limit';
      readonly cause: string;
      readonly phaseResult: PhaseResult;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'fail';
      readonly phaseResult: PhaseResult;
      readonly baseMessage: string;
      readonly decisionCause: string | undefined;
      readonly fatalCause: string | undefined;
      readonly capExhausted: boolean;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'pause-verify';
      readonly phaseResult: PhaseResult;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'pause-manual';
      readonly phaseResult: PhaseResult;
      readonly transition: TransitionResult;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'advance-or-loop';
      readonly phaseResult: PhaseResult;
      readonly transition: TransitionResult;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'break-unexpected';
      readonly phaseResult: PhaseResult;
      readonly transition: TransitionResult;
      readonly warnings: readonly string[];
    };

export interface PrePhaseInputs {
  readonly run: WorkflowRun;
  readonly iterationCap: number;
  readonly now: number;
}

export interface PostPhaseInputs {
  readonly run: WorkflowRun;
  readonly output: PhaseRunOutput;
  readonly iteration: number;
  readonly iterationCap: number;
  readonly activePhaseDef: PhaseDef | undefined;
  /**
   * `manualPauseAt` as persisted AFTER the runner returned, for **this** Run.
   * Lets the sequencer detect a manual pause that landed mid-run (the operator
   * toggled it while the CLI was executing). `null` when no pause is recorded
   * or the snapshot could not be read, in which case the check is skipped.
   *
   * Feature 093 (T040) — was `latestRun: WorkflowRun | null`, carrying an
   * `id !== run.id` guard here because the caller read the single ambient Run
   * slot and could hand over a *different* Run's snapshot. `RunDriver`
   * now resolves the snapshot by the Run's own identity, so the guard had
   * nothing left to catch. Narrowing the parameter to the one field the
   * sequencer reads is what removes the comparison rather than merely deleting
   * it: a foreign Run's pause timestamp is no longer something this signature
   * can express.
   */
  readonly latestManualPauseAt: number | null;
  readonly now: number;
  /**
   * Workspace default for `PhaseDef.forceContinueOnRetryCap`, resolved by the
   * caller per phase invocation rather than held here, so a mid-run settings
   * change takes effect on the next phase instead of the next window.
   */
  readonly forceContinueOnRetryCapDefault?: boolean;
}

export interface OptionalTerminalFailureInputs {
  readonly run: WorkflowRun;
  readonly phaseResult: PhaseResult;
  readonly phaseDef: PhaseDef;
  readonly iterationCap: number;
}

/**
 * Verify-phase ids that pause on a non-clean outcome instead of advancing.
 * Feature 026 FR-016: the bugfix verify phases keep `currentPhase`
 * unchanged so the next resume re-invokes the failing verify phase.
 */
const VERIFY_PHASE_IDS: ReadonlySet<string> = new Set([
  'bugfix-verify-pre',
  'bugfix-verify-post'
]);

export class PhaseSequencer {
  public isVerificationPhase(phaseId: string): boolean {
    return VERIFY_PHASE_IDS.has(phaseId);
  }

  public decideAfterOptionalTerminalFailure(
    inputs: OptionalTerminalFailureInputs
  ): Extract<TransitionResult, { kind: 'advance' }> {
    if (inputs.phaseDef.isRequired !== false) {
      throw new Error('optional terminal continuation requires isRequired === false');
    }
    if (inputs.phaseResult.result !== 'failed' && inputs.phaseResult.result !== 'timeout') {
      throw new Error('optional terminal continuation requires failed or timeout result');
    }
    const decision = transition({
      phase: inputs.phaseResult.phase,
      outcome: inputs.phaseResult.result,
      iteration: inputs.phaseResult.iteration,
      iterationCap: inputs.iterationCap,
      pipeline: inputs.run.pipeline,
      phaseDef: inputs.phaseDef
    });
    if (decision.kind !== 'advance') {
      throw new Error('optional terminal continuation did not advance');
    }
    return decision;
  }

  /**
   * Pre-dispatch decision: consult `phaseOverrides` for the current phase.
   * Returns `'skip-phase'` with a synthetic skipped `PhaseResult` plus the
   * pre-computed `transition()` if an override exists; otherwise `'invoke'`
   * with the resolved iteration + active phase def.
   */
  decideBeforePhase(inputs: PrePhaseInputs): PrePhaseDecision {
    const { run, iterationCap, now } = inputs;
    const phaseOverride = run.phaseOverrides.find(
      (override) => override.phaseId === run.currentPhase
    );
    if (phaseOverride) {
      const skippedResult: PhaseResult = {
        phase: run.currentPhase,
        iteration: run.currentIteration === 0 ? 1 : run.currentIteration,
        startedAt: now,
        endedAt: now,
        result: 'skipped',
        terminationReason: 'cancel',
        exitCode: null,
        stdoutSummary: '',
        stderrSummary: '',
        auditEntryId: null
      };
      const decision = transition({
        phase: run.currentPhase,
        outcome: 'skipped',
        iteration: skippedResult.iteration,
        iterationCap,
        pipeline: run.pipeline
      });
      return {
        kind: 'skip-phase',
        override: phaseOverride,
        skippedResult,
        transition: decision
      };
    }
    const iteration = run.currentIteration === 0 ? 1 : run.currentIteration;
    const activePhaseDef =
      run.pipeline?.phases.find((p) => p.id === run.currentPhase) ?? undefined;
    return { kind: 'invoke', iteration, activePhaseDef };
  }

  /**
   * Post-dispatch decision: classify the runner's output into a typed
   * next-action. The controller acts on the decision (persistence, audit,
   * queue, lock retain). The sequencer never mutates run state.
   */
  decideAfterPhase(inputs: PostPhaseInputs): PostPhaseDecision {
    const {
      run,
      output,
      iteration,
      iterationCap,
      activePhaseDef,
      latestManualPauseAt,
      now,
      forceContinueOnRetryCapDefault
    } = inputs;

    if (output.outcome === 'paused-at-breakpoint') {
      return {
        kind: 'pause-breakpoint',
        consumedPhaseId: run.currentPhase,
        warnings: output.warnings
      };
    }

    const phaseResult: PhaseResult = {
      phase: run.currentPhase,
      iteration,
      startedAt: now,
      endedAt: now,
      result: output.outcome,
      terminationReason: output.terminationReason,
      exitCode: output.exitCode,
      stdoutSummary: output.stdoutSummary,
      stderrSummary: output.stderrSummary,
      auditEntryId: output.auditEntryId
    };

    const auditMetrics =
      output.result.kind !== 'malformed' ? output.result.auditEntry?.metrics : undefined;
    const decision = transition({
      phase: run.currentPhase,
      outcome: output.outcome,
      iteration,
      iterationCap,
      pipeline: run.pipeline,
      phaseDef: activePhaseDef ?? undefined,
      ...(auditMetrics ? { metrics: auditMetrics } : {}),
      ...(forceContinueOnRetryCapDefault !== undefined
        ? { forceContinueOnRetryCapDefault }
        : {})
    });
    const warnings = [...output.warnings, ...decision.warnings];

    if (decision.kind === 'halt' && decision.status === 'paused') {
      const retryCause = toDelayedRetryCause(decision.cause);
      if (retryCause !== null) {
        const resetsAtMs =
          output.result.kind === 'rate_limited' ? output.result.resetsAtMs ?? null : null;
        const rateLimitMessage =
          output.result.kind === 'rate_limited'
            ? output.result.rateLimitMessage ?? null
            : null;
        const originalCause =
          output.result.kind === 'rate_limited' ? output.result.cause : decision.cause;
        return {
          kind: 'pause-delayed-retry',
          cause: retryCause,
          originalCause,
          resetsAtMs,
          rateLimitMessage,
          phaseResult,
          warnings
        };
      }
      const cause =
        output.result.kind === 'rate_limited' ? output.result.cause : 'rate-limit';
      return { kind: 'pause-rate-limit', cause, phaseResult, warnings };
    }

    if (decision.kind === 'halt' && decision.status === 'failed') {
      const fatalCause =
        output.result.kind === 'malformed' ? output.result.fatalCause : undefined;
      const baseMessage =
        decision.cause === 'cap_exhausted'
          ? 'cap_exhausted'
          : fatalCause ?? (output.warnings.join('; ').slice(0, 240) || 'phase failed');
      return {
        kind: 'fail',
        phaseResult,
        baseMessage,
        decisionCause: decision.cause,
        fatalCause,
        capExhausted: decision.cause === 'cap_exhausted',
        warnings
      };
    }

    if (VERIFY_PHASE_IDS.has(run.currentPhase) && output.outcome !== 'clean') {
      return { kind: 'pause-verify', phaseResult, warnings };
    }

    if (decision.kind !== 'advance' && decision.kind !== 'loop') {
      return { kind: 'break-unexpected', phaseResult, transition: decision, warnings };
    }

    if (latestManualPauseAt !== null) {
      return { kind: 'pause-manual', phaseResult, transition: decision, warnings };
    }

    return { kind: 'advance-or-loop', phaseResult, transition: decision, warnings };
  }
}

/**
 * Filter the consumed override out of the run's override list when the
 * action is `'skipped'`. `'disabled'` and `'removed'` overrides survive
 * to subsequent dispatches (the operator's intent persists until the
 * phase is re-enabled). Pure helper kept here so the controller's skip
 * branch shrinks to a single call.
 */
export function nextOverridesAfterSkip(
  run: WorkflowRun,
  consumed: PhaseOverride
): PhaseOverride[] {
  if (consumed.action !== 'skipped') return run.phaseOverrides;
  return run.phaseOverrides.filter(
    (override) => override.phaseId !== consumed.phaseId
  );
}
