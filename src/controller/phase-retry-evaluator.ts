import type { Phase } from './phase';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import { BUILT_IN_PIPELINE_ID, type PhaseDef } from '../config/pipeline-config';
import type { InvocationResult } from '../parser/stdout-parser';
import {
  validate as validateRetryCondition,
  evaluate as evaluateRetryCondition
} from '../lib/retry-condition';

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
export class PhaseRetryEvaluator {
  constructor(
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: Pick<SanitizedLogger, 'warn'>,
    private readonly validate: typeof validateRetryCondition = validateRetryCondition,
    private readonly evaluate: typeof evaluateRetryCondition = evaluateRetryCondition
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
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: phaseDefId,
      expression,
      metrics: inputs.metrics
    };

    const parsed = this.validate(expression);
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

    const payload: Record<string, unknown> = {
      ...basePayload,
      decision: evalResult.evaluation.value
    };
    if (evalResult.evaluation.missingKeys.length > 0) {
      const missing = [...evalResult.evaluation.missingKeys];
      payload.missingKeys = missing;
      this.logger.warn(
        `retryCondition missing metric(s) on ${phaseDefId}: ${missing.join(', ')}`
      );
    }
    await this.append(inputs, payload);
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
