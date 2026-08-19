import { validate as parseRetryCondition, evaluate as evalRetryCondition } from '../lib/retry-condition';

/**
 * Prefix on the system-log line emitted when a phase is forced past its
 * retry cap. Tagged rather than plain so the one case where the pipeline
 * advanced WITHOUT its condition being satisfied is greppable, and reads
 * differently from the ordinary `retryCondition missing metric(s)` noise.
 *
 * Bracketed-lowercase to match the existing `[constitution]` convention.
 */
export const FORCE_CONTINUE_NOTIFY_TAG = '[notify] forced-continue';

// Feature 098 (T038, FR-019, FR-021) — this module's second copy of the
// built-in Phase ids is gone, along with the `BuiltInPhaseId` type derived from
// it and the `INVOCABLE_PHASES` list derived from that. It was a ten-id
// duplicate of `pipeline-config.ts`'s seventeen, kept in sync by hand; with the
// catalog resolved at runtime there is no fixed set of ids to name, and `Phase`
// was already `string` because an operator's Phase id is data.
//
// The `'done'` string further down this file is untouched. It is a terminal
// *state* of the phase state machine, not a Phase definition — nothing imports
// it as a catalog entry, and the sequencer needs a name for "finished".
export type Phase = string;

export const LOOP_PHASES: ReadonlySet<string> = new Set<string>(['speckit-clarify', 'speckit-analyze', 'speckit-implement', 'speckit-review']);

export type PhaseOutcome =
  | 'clean'
  | 'issues_remain'
  | 'failed'
  | 'rate_limited'
  | 'timeout'
  | 'transient_error'
  | 'skipped'
  // Feature 028 — US2 future-phase breakpoint outcome. The driver consumed
  // the breakpoint at the dispatch boundary BEFORE invoking the CLI, so the
  // recorded `PhaseResult` carries `exitCode: null` and synthesized
  // stdout/stderr summaries. Transition logic treats this as a halt to
  // paused with cause `'breakpoint'`.
  | 'paused-at-breakpoint';

export interface PipelineLike {
  /**
   * Feature 098 — the element carries `retryCondition` as well as `id` because
   * the transition needs the *successor's* definition, not just its name, to
   * say which iteration it enters at. Optional, so a caller that only has ids
   * still type-checks and simply gets the no-definition answer.
   */
  readonly phases: ReadonlyArray<{ readonly id: string; readonly retryCondition?: string }>;
}

export interface PhaseDefLike {
  readonly id: string;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  /**
   * When the `retryCondition` is STILL truthy at the iteration cap, advance
   * with a `[notify]` warning instead of halting `failed`.
   *
   * Scoped deliberately to the cap. A phase whose condition can never go
   * falsy — one gated on a step no headless run can perform — otherwise
   * burns every iteration and then fails the whole task, and the only ways
   * out were to leave it failing or to record work that did not happen.
   *
   * This is NOT a way past a `failed` or `timeout` outcome: those are
   * terminal and never reach the retryCondition branch at all. Forcing past
   * a fatal-signature match is a different decision on different evidence,
   * and `isRequired: false` is the field that already makes it.
   */
  readonly forceContinueOnRetryCap?: boolean;
}

export type TransitionInput = {
  phase: Phase;
  outcome: PhaseOutcome;
  iteration: number;
  iterationCap: number;
  pipeline?: PipelineLike;
  phaseDef?: PhaseDefLike;
  // Feature 010 — operator-authored retryCondition is evaluated against the
  // SCHEGENT AUDIT LOG metrics map. Optional; absent for legacy callers.
  metrics?: Readonly<Record<string, number>>;
  /**
   * Workspace-level default for `PhaseDefLike.forceContinueOnRetryCap`,
   * read fresh per phase invocation from `schegent.retry.forceContinueOnCap`.
   * The phase field overrides it; absent on both sides means `false`.
   */
  forceContinueOnRetryCapDefault?: boolean;
};

export type TransitionResult =
  | { kind: 'advance'; nextPhase: Phase; nextIteration: number; warnings: string[] }
  | { kind: 'loop'; nextPhase: Phase; nextIteration: number; warnings: string[] }
  | { kind: 'halt'; status: 'failed' | 'paused'; warnings: string[]; cause?: string };

export function isLoopPhase(phase: Phase, phaseDef?: PhaseDefLike): boolean {
  if (phaseDef !== undefined) {
    // Trimmed, because `transition()` below consults the condition only when it
    // is non-empty after trimming. A whitespace-only string is not a condition
    // to the branch that would evaluate it, and this predicate must not call it
    // one either: doing so made a blank `retryCondition` loop the phase to the
    // cap on `issues_remain` through the legacy branch, with no condition ever
    // evaluated to end it.
    return phaseDef.retryCondition !== undefined && phaseDef.retryCondition.trim().length > 0;
  }
  return LOOP_PHASES.has(phase);
}

export function nextSuccessor(phase: Phase, pipeline?: PipelineLike): Phase {
  if (pipeline !== undefined) {
    const idx = pipeline.phases.findIndex((p) => p.id === phase);
    if (idx === -1) {
      return 'done';
    }
    const next = pipeline.phases[idx + 1];
    return next ? next.id : 'done';
  }
  switch (phase) {
    case 'speckit-specify':
      return 'speckit-clarify';
    case 'speckit-clarify':
      return 'speckit-plan';
    case 'speckit-plan':
      return 'speckit-tasks';
    case 'speckit-tasks':
      return 'speckit-checklist';
    case 'speckit-checklist':
      return 'speckit-analyze';
    case 'speckit-analyze':
      return 'speckit-implement';
    case 'speckit-implement':
      return 'speckit-review';
    case 'speckit-review':
      return 'finalize';
    case 'finalize':
      return 'done';
    case 'done':
      return 'done';
    default:
      return 'done';
  }
}

/**
 * The iteration a successor enters at: 1 if it loops, 0 if it does not.
 *
 * Read off the successor's own row in the plan rather than off its id. Every
 * advancing branch below asked `isLoopPhase(next)` with no definition, so the
 * answer came from `LOOP_PHASES` — four hardcoded Spec Kit ids, and feature 098
 * made the catalog runtime-only, where those ids mean nothing. The consequence
 * was an off-by-one against the operator's own bound: a loop phase entered at 0
 * runs at 0,1,…,cap before `iteration >= iterationCap` bites, one invocation
 * more than the frozen `maxPhaseInvocations` weighted it.
 *
 * With no pipeline to consult there is no row to read, and the legacy set
 * answers exactly as before.
 */
function successorIteration(next: Phase, pipeline?: PipelineLike): number {
  const def = pipeline?.phases.find((phase) => phase.id === next);
  return isLoopPhase(next, def) ? 1 : 0;
}

export function transition(input: TransitionInput): TransitionResult {
  const {
    phase,
    outcome,
    iteration,
    iterationCap,
    pipeline,
    phaseDef,
    metrics,
    forceContinueOnRetryCapDefault
  } = input;
  const warnings: string[] = [];

  // Terminal outcomes bypass retryCondition entirely (FR-010).
  if (outcome === 'skipped') {
    const next = nextSuccessor(phase, pipeline);
    return {
      kind: 'advance',
      nextPhase: next,
      nextIteration: successorIteration(next, pipeline),
      warnings
    };
  }
  // Feature 028 — US2: future-phase breakpoint fired. Halt with explicit
  // pause cause so the controller can stamp `manualPauseCause: 'breakpoint-paused'`
  // and `resumeTargetPhaseId: <phase>` for resume.
  if (outcome === 'paused-at-breakpoint') {
    return { kind: 'halt', status: 'paused', warnings, cause: 'breakpoint' };
  }
  if (outcome === 'failed' || outcome === 'timeout') {
    if (phaseDef?.isRequired === false) {
      const next = nextSuccessor(phase, pipeline);
      warnings.push(`optional phase ${phase} ${outcome}; continuing`);
      return {
        kind: 'advance',
        nextPhase: next,
        nextIteration: successorIteration(next, pipeline),
        warnings
      };
    }
    return { kind: 'halt', status: 'failed', warnings };
  }
  if (outcome === 'rate_limited') {
    // Feature 011 — FR-003: rate-limit halts to paused with explicit cause so
    // the controller can schedule a 60-min delayed retry.
    return { kind: 'halt', status: 'paused', warnings, cause: 'rate_limit' };
  }
  if (outcome === 'transient_error') {
    // Feature 011 — FR-002: non-zero exit with no fatal-signature and no
    // rate-limit match halts to paused with explicit cause so the controller
    // can schedule a 15-min delayed retry.
    return { kind: 'halt', status: 'paused', warnings, cause: 'transient_error' };
  }

  // Feature 010 — FR-010: consult retryCondition for well-formed outcomes
  // (clean / open_questions / remaining_issues are all surfaced here as
  // either 'clean' or 'issues_remain' through PhaseOutcome).
  const retrySource = phaseDef?.retryCondition;
  if (retrySource && retrySource.trim().length > 0) {
    const truthy = evaluateRetryCondition(retrySource, metrics ?? {}, warnings);
    if (truthy) {
      if (iteration >= iterationCap) {
        // Phase field wins over the workspace default; absent on both is `false`,
        // which is the pre-existing halt.
        const forceContinue =
          phaseDef?.forceContinueOnRetryCap ?? forceContinueOnRetryCapDefault ?? false;
        if (forceContinue) {
          const next = nextSuccessor(phase, pipeline);
          warnings.push(
            `${FORCE_CONTINUE_NOTIFY_TAG} ${phase}: retryCondition still truthy at cap ` +
              `(${iterationCap}) — forced continue to ${next}. The condition was never ` +
              'satisfied, so whatever it gates is UNVERIFIED.'
          );
          return {
            kind: 'advance',
            nextPhase: next,
            nextIteration: successorIteration(next, pipeline),
            warnings
          };
        }
        // FR-010 / SC-009: cap reached + truthy condition → terminal failure
        // with a redacted cause string distinct from the fatal-CLI cause.
        warnings.push(`retryCondition still truthy at cap (${iterationCap}) on ${phase}`);
        return { kind: 'halt', status: 'failed', warnings, cause: 'cap_exhausted' };
      }
      return { kind: 'loop', nextPhase: phase, nextIteration: iteration + 1, warnings };
    }
    // Falsy → advance regardless of legacy loop semantics.
    const next = nextSuccessor(phase, pipeline);
    return {
      kind: 'advance',
      nextPhase: next,
      nextIteration: successorIteration(next, pipeline),
      warnings
    };
  }

  if (isLoopPhase(phase, phaseDef) && outcome === 'issues_remain') {
    if (iteration >= iterationCap) {
      const next = nextSuccessor(phase, pipeline);
      warnings.push(`iteration cap (${iterationCap}) reached on ${phase}; force-advancing`);
      return {
        kind: 'advance',
        nextPhase: next,
        nextIteration: successorIteration(next, pipeline),
        warnings
      };
    }
    return { kind: 'loop', nextPhase: phase, nextIteration: iteration + 1, warnings };
  }

  const next = nextSuccessor(phase, pipeline);
  return {
    kind: 'advance',
    nextPhase: next,
    nextIteration: successorIteration(next, pipeline),
    warnings
  };
}

function evaluateRetryCondition(
  source: string,
  metrics: Readonly<Record<string, number>>,
  warnings: string[]
): boolean {
  const parsed = parseRetryCondition(source);
  if (!parsed.ok) {
    warnings.push(`retryCondition parse error: ${parsed.error}`);
    return false; // FR-013 — runtime error treated as falsy (advance).
  }
  const result = evalRetryCondition(parsed.expression, metrics);
  if (!result.ok) {
    warnings.push(`retryCondition evaluation error: ${result.error.error}`);
    return false;
  }
  if (result.evaluation.missingKeys.length > 0) {
    warnings.push(
      `retryCondition missing metric(s): ${result.evaluation.missingKeys.join(', ')}`
    );
  }
  return result.evaluation.value;
}
