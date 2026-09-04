import { validate as parseRetryCondition, evaluate as evalRetryCondition } from '../lib/retry-condition';
import {
  PHASE_RETRY_CONDITION_MAX_LEN,
  type RetryCapOutcome
} from '../contracts/process-definitions';
import type { DegradedPhaseEntry } from '../contracts/snapshot-projections';
import { CAP_EXHAUSTED_CAUSE } from '../audit/audit-payload';

/**
 * Prefix on the system-log line emitted when a phase is forced past its
 * retry cap. Tagged rather than plain so the one case where the pipeline
 * advanced WITHOUT its condition being satisfied is greppable, and reads
 * differently from the ordinary `retryCondition missing metric(s)` noise.
 *
 * Bracketed-lowercase to match the existing `[constitution]` convention.
 */
export const FORCE_CONTINUE_NOTIFY_TAG = '[notify] forced-continue';

/**
 * FR-R3-157 — the same line for `'continue-degraded'`, under a tag of its own.
 *
 * A DISTINCT tag, not a suffix on the one above, because the two outcomes differ
 * in exactly the thing a log reader is looking for: whether a durable record was
 * written. Sharing the tag would make `continue` and `continue-degraded`
 * indistinguishable to anyone grepping the log — and "a degraded run is never
 * indistinguishable from a clean one" is the whole point of the third outcome
 * (FR-006). It also keeps `FORCE_CONTINUE_NOTIFY_TAG`'s meaning exactly what it
 * was, which contract C2.4 requires.
 */
export const DEGRADED_CONTINUE_NOTIFY_TAG = '[notify] continued-degraded';

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

/**
 * What `transition()` needs to know about a Phase — and, since FR-R3-157,
 * deliberately nothing about what it does at the retry cap.
 *
 * The cap outcome used to be read from a boolean on this interface. It is now
 * resolved before the call, by `contracts/retry-cap-outcome.ts`, and arrives as
 * `TransitionInput.capOutcome`. Removing the field from here is the substance of
 * that rule rather than a tidy-up: while the field remained, a later edit could
 * consult it "just this once" beside the resolved value, and the two would agree
 * on every input except a Phase carrying both authored forms.
 * `tests/lint/retry-cap-resolution-site.test.ts` asserts this file names it nowhere.
 */
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
  /**
   * FR-R3-157 (contract C2) — what this Phase does if `retryCondition` is still
   * truthy at the cap, ALREADY RESOLVED by `contracts/retry-cap-outcome.ts` from
   * the Phase's own fields and the workspace default.
   *
   * It arrives resolved rather than as the ingredients because resolution has one
   * home (FR-007), and an input this branch could re-derive is an invitation to
   * re-derive it slightly differently. The caller that owns both ingredients —
   * `phase-sequencer.ts` — is the one that calls the resolver.
   *
   * `undefined` means `'fail'`, which is not a fourth state: it is what a caller
   * that passes nothing has always meant, and what a workspace that configured
   * none of this has always done.
   */
  capOutcome?: RetryCapOutcome;
  /**
   * Feature 194 (FR-010, contract C3.3) — the consecutive-unchanged-iterations
   * count computed once by `PhaseRetryEvaluator` and surfaced on
   * `PhaseRunOutput`. Threaded here so both cap warnings render the SAME
   * number from the ONE computation, rather than a second one that could
   * disagree with it. `undefined` when no count was computed (rule does not
   * apply, or no prior comparable iteration exists) — a distinct state from
   * `1`, which is a real count that simply does not clear the `> 1` threshold.
   */
  stalledCount?: number;
};

export type TransitionResult =
  | {
      kind: 'advance';
      nextPhase: Phase;
      nextIteration: number;
      warnings: string[];
      /**
       * FR-R3-157 — set only when this advance came from a `'continue-degraded'`
       * cap exhaustion (contract C2.5). Its ABSENCE is meaningful and is the
       * common case: every other advance leaves it undefined, and the caller
       * reads that as "not degraded" rather than as "unknown".
       */
      degraded?: DegradedPhaseEntry;
    }
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
    capOutcome,
    stalledCount
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
        // Feature 194 (contract C3.1, C3.2) — threshold is strictly > 1. A count
        // of exactly 1 is a real, computed count that simply does not clear it:
        // the clause's presence always means "more than one consecutive
        // comparison went nowhere", so its absence stays informative on its own.
        //
        // "comparisons", not "iterations" (C3.1a): C2.2 defines the value as
        // comparisons and rules out the iteration reading, and n comparisons span
        // n + 1 iterations. Rendering the same number under the wrong noun would
        // report one fewer iteration than actually went nowhere; rendering n + 1
        // would break C3.3's one-computation-two-renderings. The noun moved.
        //
        // Declared HERE, not at the top of `transition()`: this branch and the
        // two warnings inside it are the clause's only readers, and every other
        // return — a skip, a breakpoint pause, a terminal failure, an optional
        // phase advancing, a loop under the cap — used to build and discard it.
        const stagnationClause =
          stalledCount !== undefined && stalledCount > 1
            ? `; metrics unchanged across the last ${stalledCount} comparisons`
            : '';
        // The clause opens with `; `, which reads correctly appended to the
        // terminal warning (it ends on `${phase}`) but not to the forced-continue
        // one, whose last sentence ends in a full stop — that rendered
        // `UNVERIFIED.; metrics unchanged …`. C3.4 forbids rewording either
        // warning, so the stop MOVES to the end of the appended clause rather
        // than the clause being reworded: the words on both sides are untouched,
        // the clause is appended and not substituted, and the sentence keeps a
        // terminator either way. An earlier draft dropped the stop instead, which
        // left the stalled rendering ending mid-thought on `… comparisons` while
        // claiming in this comment that it did not — the two renderings of one
        // warning must not differ in punctuation.
        //
        // FR-R3-157 (contract C2) — this branch RESOLVES NOTHING. The outcome was
        // resolved by `contracts/retry-cap-outcome.ts` before the call, from the
        // Phase's own fields and the workspace default; here it is only acted on.
        // The switch replaced a `?? ?? false` coalesce of those same two inputs,
        // and the two arms below produce byte-identical warnings, cause and result
        // to what that coalesce produced for `true` and `false` respectively
        // (FR-002, FR-003) — the text inside them is untouched, not re-derived.
        switch (capOutcome) {
          case 'continue': {
            const next = nextSuccessor(phase, pipeline);
            // Feature 194 (contract C3.4) — the clause is APPENDED, never
            // substituted: the existing text, including the UNVERIFIED
            // declaration, is retained unchanged.
            warnings.push(
              `${FORCE_CONTINUE_NOTIFY_TAG} ${phase}: retryCondition still truthy at cap ` +
                `(${iterationCap}) — forced continue to ${next}. The condition was never ` +
                `satisfied, so whatever it gates is UNVERIFIED${stagnationClause}.`
            );
            return {
              kind: 'advance',
              nextPhase: next,
              nextIteration: successorIteration(next, pipeline),
              warnings
            };
          }
          case 'continue-degraded': {
            // FR-R3-157 (C2.3) — the same advance as `'continue'`, computed the
            // same way. `nextSuccessor` and `successorIteration` are called
            // here rather than shared with the arm above deliberately: the two
            // arms must agree on WHERE the run goes, and the way to guarantee
            // that is for both to ask the same two functions, not for one to
            // inherit a value the other happened to compute.
            const next = nextSuccessor(phase, pipeline);
            // Two claims in one sentence, per C2.3: what is unverified, and that
            // the run now carries a durable record of it. The second half is
            // what tells a log reader there is something to go and look at —
            // `retrySource` is non-empty here by the branch's own guard.
            warnings.push(
              `${DEGRADED_CONTINUE_NOTIFY_TAG} ${phase}: retryCondition still truthy at cap ` +
                `(${iterationCap}) — continued to ${next} and RECORDED as degraded. The ` +
                `condition was never satisfied, so whatever it gates is ` +
                `UNVERIFIED${stagnationClause}.`
            );
            return {
              kind: 'advance',
              nextPhase: next,
              nextIteration: successorIteration(next, pipeline),
              warnings,
              // The condition AS AUTHORED, untrimmed and unnormalized (FR-009).
              // An operator reading the mark has to be able to match it against
              // the line in their own pipeline file.
              degraded: { phaseId: phase, condition: retrySource }
            };
          }
          case 'fail':
          case undefined:
            break;
        }
        // FR-010 / SC-009: cap reached + truthy condition → terminal failure
        // with a redacted cause string distinct from the fatal-CLI cause.
        warnings.push(
          `retryCondition still truthy at cap (${iterationCap}) on ${phase}${stagnationClause}`
        );
        return { kind: 'halt', status: 'failed', warnings, cause: CAP_EXHAUSTED_CAUSE };
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
  const parsed = parseRetryCondition(source, PHASE_RETRY_CONDITION_MAX_LEN);
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
