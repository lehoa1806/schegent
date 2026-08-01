import { validate as parseRetryCondition, evaluate as evalRetryCondition } from '../lib/retry-condition';

export const BUILT_IN_PHASE_IDS = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-review',
  'finalize',
  'done'
] as const;

export type BuiltInPhaseId = (typeof BUILT_IN_PHASE_IDS)[number];

export type Phase = string;

export const INVOCABLE_PHASES: readonly BuiltInPhaseId[] = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-review',
  'finalize'
] as const;

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
  readonly phases: ReadonlyArray<{ readonly id: string }>;
}

export interface PhaseDefLike {
  readonly id: string;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
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
};

export type TransitionResult =
  | { kind: 'advance'; nextPhase: Phase; nextIteration: number; warnings: string[] }
  | { kind: 'loop'; nextPhase: Phase; nextIteration: number; warnings: string[] }
  | { kind: 'halt'; status: 'failed' | 'paused'; warnings: string[]; cause?: string };

export function isLoopPhase(phase: Phase, phaseDef?: PhaseDefLike): boolean {
  if (phaseDef !== undefined) {
    return !!phaseDef.retryCondition;
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

export function transition(input: TransitionInput): TransitionResult {
  const { phase, outcome, iteration, iterationCap, pipeline, phaseDef, metrics } = input;
  const warnings: string[] = [];

  // Terminal outcomes bypass retryCondition entirely (FR-010).
  if (outcome === 'skipped') {
    const next = nextSuccessor(phase, pipeline);
    return {
      kind: 'advance',
      nextPhase: next,
      nextIteration: isLoopPhase(next) ? 1 : 0,
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
        nextIteration: isLoopPhase(next) ? 1 : 0,
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
      nextIteration: isLoopPhase(next) ? 1 : 0,
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
        nextIteration: isLoopPhase(next) ? 1 : 0,
        warnings
      };
    }
    return { kind: 'loop', nextPhase: phase, nextIteration: iteration + 1, warnings };
  }

  const next = nextSuccessor(phase, pipeline);
  return {
    kind: 'advance',
    nextPhase: next,
    nextIteration: isLoopPhase(next) ? 1 : 0,
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
