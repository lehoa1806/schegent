// FR-R4-F02 (spec 240, US8; contract E1; research R9; FR-037 to FR-040) — the limits one Run runs
// under, and where each came from, computed from the inputs execution uses.
//
// The disclosure page lists the DEFAULT bounds, and the operator's trusted workspace and folder
// settings can move every one of them, so the page alone says nothing about a given Run. This
// resolver answers the per-Run question without a second opinion about it: it calls the same
// functions execution calls (the Phase's timeout resolution, the spend bound's Phase override, the
// retry-cap outcome and its source companion, the backend's spend denomination), and it reads the
// frozen plan, which it never writes (hard rule 8). A Phase override authored after the Run froze is
// therefore not seen, which is right: the value shown is the value execution uses.
//
// Pure and free of `vscode`. The settings layers arrive as `EffectiveLimit` pairs, each from the one
// `inspect` result that chose the value, so what this shows cannot be a different reading of the
// settings than the one the runner received.
//
// It never names the Phase's own retry-cap switch: the one place that decides from that field is
// `retry-cap-outcome.ts` (tests/lint/retry-cap-resolution-site.test.ts), and this module calls it.
import { effectivePhaseTimeoutMs, authoredPhaseTimeoutMs } from '../controller/effective-phase-timeout';
import { effectiveRunnerKindForPhase } from '../config/pipeline-snapshot';
import { spendDenominationOf, type SpendDenomination } from '../contracts/backend-spend-denomination';
import { resolveRetryCapOutcome, statesRetryCapOutcome } from '../contracts/retry-cap-outcome';
import type { ExecutionDecisionSettingSources } from '../contracts/execution-decision-observation';
import {
  normalizeMaxUnchangedComparisons,
  unchangedComparisonBoundState
} from '../contracts/unchanged-comparison-bound';
import { DELAYED_RETRY_CAP } from '../contracts/retry-bounds';
import type {
  EffectiveLimit,
  EffectiveLimitsProjection,
  LimitOrigin
} from '../contracts/snapshot-projections';
import type { WorkflowRun } from '../state/workflow-run';
import { effectiveSpendBound, phaseSpendBoundApplies } from './spend-bound';

export type { EffectiveLimit, EffectiveLimitsProjection, LimitOrigin };

const MS_PER_SECOND = 1000;

export interface EffectiveLimitsInput {
  /** Activation-resolved: what the runner received. */
  readonly settings: {
    readonly iterationCap: EffectiveLimit<number>;
    readonly idleTimeoutSeconds: EffectiveLimit<number>;
    readonly maxDurationSeconds: EffectiveLimit<number>;
  };
  /** Read per evaluation, as execution reads them. */
  readonly live: {
    readonly forceContinueOnCap: EffectiveLimit<boolean>;
    /** FR-R4-F17 — the raw bound; the resolver normalizes it, as execution does. */
    readonly maxUnchangedComparisons: EffectiveLimit<number>;
    readonly limitUsd: EffectiveLimit<number | null>;
    readonly limitTokens: EffectiveLimit<number | null>;
  };
  readonly run: Pick<WorkflowRun, 'pipeline' | 'currentPhase' | 'defaultRunnerKind'>;
  readonly spendTrust: (denomination: SpendDenomination) => 'enforced' | 'not-trustworthy';
}

/** The origin of a value a Phase states, else the settings layer's own. */
const originOrPhase = (phaseStates: boolean, fallback: LimitOrigin): LimitOrigin =>
  phaseStates ? 'phase' : fallback;

/**
 * FR-R5-F23 (F23-T02, F23-T03) — resolve the setting-source provenance for the active
 * Phase's iteration cap, retry-cap outcome, and unchanged-comparison threshold.
 */
export function resolvePhaseIterationSources(
  input: Pick<EffectiveLimitsInput, 'settings' | 'live' | 'run'>
): ExecutionDecisionSettingSources {
  const { settings, live, run } = input;
  const phase = run.pipeline?.phases.find((candidate) => candidate.id === run.currentPhase);
  const capOrigin = originOrPhase(
    statesRetryCapOutcome(phase),
    live.forceContinueOnCap.origin
  );
  const normalizedUnchanged = normalizeMaxUnchangedComparisons(
    live.maxUnchangedComparisons.value
  );
  return Object.freeze({
    maxIterations: settings.iterationCap.origin,
    capOutcome: capOrigin,
    ...(normalizedUnchanged > 0
      ? { noProgressThreshold: live.maxUnchangedComparisons.origin }
      : {})
  });
}

export function resolveEffectiveLimits(input: EffectiveLimitsInput): EffectiveLimitsProjection {
  const { settings, live, run } = input;
  const phase = run.pipeline?.phases.find((candidate) => candidate.id === run.currentPhase);

  const idleMs = effectivePhaseTimeoutMs({
    timeoutMs: settings.idleTimeoutSeconds.value * MS_PER_SECOND,
    phaseDef: phase
  });

  const bound = effectiveSpendBound(
    { limitUsd: live.limitUsd.value, limitTokens: live.limitTokens.value },
    phase
  );
  const denomination = spendDenominationOf(effectiveRunnerKindForPhase(phase, run.defaultRunnerKind));
  const limit = denomination === 'usd' ? bound.limitUsd : bound.limitTokens;
  const layer = denomination === 'usd' ? live.limitUsd : live.limitTokens;
  const phaseLimit = denomination === 'usd' ? phase?.spendBoundUsd : phase?.spendBoundTokens;
  // One resolution, used for the outcome shown and for the early stop's state (FR-R4-F17 L1.2).
  const capOutcome = resolveRetryCapOutcome(phase, live.forceContinueOnCap.value);
  const capOrigin = originOrPhase(statesRetryCapOutcome(phase), live.forceContinueOnCap.origin);
  const normalizedUnchanged = normalizeMaxUnchangedComparisons(live.maxUnchangedComparisons.value);
  const retrySource = phase?.retryCondition?.trim() ?? '';
  const settingSources = resolvePhaseIterationSources(input);

  return {
    iterationCap: settings.iterationCap,
    idleTimeoutSeconds: {
      value: idleMs / MS_PER_SECOND,
      origin: originOrPhase(authoredPhaseTimeoutMs(phase) !== undefined, settings.idleTimeoutSeconds.origin)
    },
    maxDurationSeconds: settings.maxDurationSeconds,
    // A code constant, not a setting (G2).
    retryCap: { value: DELAYED_RETRY_CAP, origin: 'default' },
    onRetryCap: {
      value: capOutcome,
      origin: capOrigin
    },
    unchangedComparisons: {
      value: normalizedUnchanged,
      origin: live.maxUnchangedComparisons.origin,
      state: unchangedComparisonBoundState({
        bound: live.maxUnchangedComparisons.value,
        capOutcome,
        retryCondition: phase?.retryCondition
      })
    },
    phaseRetryPolicy: {
      retryCondition: retrySource.length > 0 ? retrySource : 'single-pass',
      capOutcome,
      ...(normalizedUnchanged > 0 ? { noProgressThreshold: normalizedUnchanged } : {}),
      settingSources
    },
    spend:
      limit === null
        ? { kind: 'none' }
        : {
            kind: 'bounded',
            denomination,
            limit: { value: limit, origin: originOrPhase(phaseSpendBoundApplies(layer.value, phaseLimit), layer.origin) },
            trust: input.spendTrust(denomination)
          }
  };
}

/**
 * FR-R5-F30 (SPEC-08, D6) — resolve the effective root control budget limits,
 * allowing a live workspace USD cap to tighten (never increase) the frozen root
 * `strict-usd` cap.
 */
export function resolveRootControlBudgetLimits(input: {
  readonly maxPhaseAttempts: number;
  readonly budgetMode?: 'count-only' | 'strict-usd' | undefined;
  readonly frozenLimitMicrousd?: number | undefined;
  readonly liveLimitMicrousd?: number | null | undefined;
}): {
  readonly maxPhaseAttempts: number;
  readonly budgetMode: 'count-only' | 'strict-usd';
  readonly effectiveLimitMicrousd?: number | undefined;
} {
  const budgetMode =
    input.budgetMode ??
    (input.frozenLimitMicrousd !== undefined ? 'strict-usd' : 'count-only');
  const liveCap =
    typeof input.liveLimitMicrousd === 'number' &&
    Number.isSafeInteger(input.liveLimitMicrousd) &&
    input.liveLimitMicrousd > 0
      ? input.liveLimitMicrousd
      : undefined;
  const effectiveLimitMicrousd =
    input.frozenLimitMicrousd !== undefined && liveCap !== undefined
      ? Math.min(input.frozenLimitMicrousd, liveCap)
      : input.frozenLimitMicrousd ?? liveCap;
  return Object.freeze({
    maxPhaseAttempts: input.maxPhaseAttempts,
    budgetMode,
    ...(effectiveLimitMicrousd !== undefined ? { effectiveLimitMicrousd } : {})
  });
}
