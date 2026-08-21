import type { Phase } from './phase';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { PhaseDef } from '../config/pipeline-config';
import type { InvocationResult } from '../parser/stdout-parser';
import type { LastRetryDecision } from '../state/workflow-run';
import {
  validate as validateRetryCondition,
  evaluate as evaluateRetryCondition
} from '../lib/retry-condition';
import { PHASE_RETRY_CONDITION_MAX_LEN } from '../contracts/process-definitions';

export interface PhaseRetryEvaluatorInputs {
  readonly phase: Phase;
  readonly phaseDef?: PhaseDef;
  readonly pipelineId?: string;
  readonly runId: string;
  readonly iteration: number;
  readonly result: InvocationResult;
  readonly metrics: Readonly<Record<string, number>>;
}

/**
 * Feature 010 — FR-017. Emit one `phase.retry_evaluated` audit record
 * per consulted decision. The envelope `outcome` is always `'info'`;
 * the loop-vs-advance boolean lives at `payload.decision` to avoid
 * colliding with the envelope field.
 *
 * Feature 057 Track 2 — extracted from `phase-runner.ts` for review-
 * friction reduction. The runner shell instantiates one instance and
 * calls `maybeEmit()` once per iteration.
 *
 * Hard rule: `retryCondition` expressions are evaluated exclusively
 * through the sandboxed DSL evaluator (`lib/retry-condition`). The
 * module accepts the validator and evaluator as constructor deps so
 * tests can inject fakes without re-implementing parser logic.
 */
/**
 * Feature 010 — BUG-001 (FR-028). Optional sink invoked once per decision
 * with the operator-visible projection. Wired by the workflow-controller to
 * write to `WorkflowRun.lastRetryDecision` via `WorkspaceStateStore.setRun()`.
 * Unset in unit tests; the evaluator never blocks on a missing sink.
 *
 * Feature 093 (T047) — the decision now names the Run it was evaluated for.
 * Without an identity in the payload the sink wrote to "the" Run: correct by
 * construction while a window had one, and last-writer-wins once it has
 * several, so one queue's `missingKeys` would render in a sibling's phase tile.
 * The binding resolves the id to its queue and addresses the write there.
 */
export type LastRetryDecisionSink = (
  runId: string,
  decision: LastRetryDecision
) => Promise<void> | void;

export class PhaseRetryEvaluator {
  constructor(
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: Pick<SanitizedLogger, 'warn'>,
    private readonly validate: typeof validateRetryCondition = validateRetryCondition,
    private readonly evaluate: typeof evaluateRetryCondition = evaluateRetryCondition,
    private readonly decisionSink: LastRetryDecisionSink | null = null
  ) {}

  public async maybeEmit(inputs: PhaseRetryEvaluatorInputs): Promise<void> {
    const expression = inputs.phaseDef?.retryCondition;
    if (typeof expression !== 'string' || expression.trim().length === 0) return;
    // FR-017 — do not emit when the parser outcome is malformed; that path
    // already records the failure via phase-end (with `cause` when fatal).
    // Feature 011 — transient_error and rate_limited likewise route through
    // a dedicated delayed-retry audit channel (`retry-scheduled`); do not
    // double-count via phase.retry_evaluated.
    if (
      inputs.result.kind === 'malformed' ||
      inputs.result.kind === 'transient_error' ||
      inputs.result.kind === 'rate_limited'
    ) {
      return;
    }

    const phaseDefId = inputs.phaseDef?.id ?? inputs.phase;
    const basePayload = {
      // Feature 098 (T045, FR-034) — omitted, not substituted. This read
      // `?? BUILT_IN_PIPELINE_ID`, so an invocation that carried no Pipeline id
      // produced a `phase.retry_evaluated` record attributing the decision to a
      // Pipeline that had nothing to do with it — and, once the built-in layer
      // emptied, to one no installation holds.
      ...(inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId }),
      phaseId: phaseDefId,
      expression,
      metrics: inputs.metrics
    };

    const parsed = this.validate(expression, PHASE_RETRY_CONDITION_MAX_LEN);
    if (!parsed.ok) {
      const errorMessage = parsed.error;
      this.logger.warn(`retryCondition parse error on ${phaseDefId}: ${errorMessage}`);
      await this.append(inputs, {
        ...basePayload,
        decision: false,
        evaluationError: true,
        errorMessage
      });
      return;
    }

    const evalResult = this.evaluate(parsed.expression, inputs.metrics);
    if (!evalResult.ok) {
      const errorMessage = evalResult.error.error;
      this.logger.warn(`retryCondition evaluation error on ${phaseDefId}: ${errorMessage}`);
      await this.append(inputs, {
        ...basePayload,
        decision: false,
        evaluationError: true,
        errorMessage
      });
      return;
    }

    // FR-028: surface missing metric keys on every retry evaluation so the
    // operator UI can distinguish "no metrics missing" from "field omitted".
    // Always emit the array (empty when none missing), not omitted; sorted
    // alphabetically for stable rendering.
    const missing = [...evalResult.evaluation.missingKeys].sort();
    const decision = evalResult.evaluation.value;
    const payload: Record<string, unknown> = {
      ...basePayload,
      decision,
      missingKeys: missing
    };
    if (missing.length > 0) {
      // FR-012 + FR-029: canonical WARN text with cross-reference to FR-007
      // sub-block continuation rule. Helps operators debug retryCondition
      // expressions that resolve to zero because the phase prompt did not
      // emit the keys at the top level, or emitted them inside a sub-block
      // (Notes:/Findings:/Open Questions:/Remaining Issues:) without a
      // trailing blank line or top-level field separator.
      this.logger.warn(
        `retryCondition missing metric(s) on ${phaseDefId}: ${missing.join(', ')} — ` +
          'phase prompt may not be emitting these keys, or they appeared inside a ' +
          'sub-block (Notes:/Findings:/Open Questions:/Remaining Issues:) without a ' +
          'trailing blank line or top-level field separator (see spec FR-007)'
      );
    }
    await this.append(inputs, payload);
    // FR-028 — project the decision onto WorkflowRun.lastRetryDecision so the
    // sidebar / run history surfaces `missingKeys` without enabling verbose
    // mode. The sink is optional and never blocks the audit emission.
    if (this.decisionSink !== null) {
      try {
        await this.decisionSink(inputs.runId, {
          phase: inputs.phase,
          iteration: inputs.iteration,
          decision,
          missingKeys: missing,
          at: Date.now()
        });
      } catch (err) {
        // The projection is best-effort; the canonical record is the audit
        // event. Log once and continue.
        this.logger.warn(
          `retryCondition projection sink failed on ${phaseDefId}: ${(err as Error)?.message ?? 'unknown'}`
        );
      }
    }
  }

  private append(
    inputs: PhaseRetryEvaluatorInputs,
    payload: Record<string, unknown>
  ) {
    return this.auditWriter.append({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType: 'phase.retry_evaluated',
      payload,
      outcome: 'info'
    });
  }
}
