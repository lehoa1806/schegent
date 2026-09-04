import type { Phase } from './phase';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { PhaseDef } from '../config/pipeline-config';
import type { InvocationResult } from '../parser/stdout-parser';
import type { LastRetryDecision } from '../state/workflow-run';
import {
  validate as validateRetryCondition,
  evaluate as evaluateRetryCondition,
  referencedIdentifiers,
  type Expression
} from '../lib/retry-condition';
import { PHASE_RETRY_CONDITION_MAX_LEN } from '../contracts/process-definitions';

/**
 * Feature 194 (data-model.md §4). One prior figure map, restricted to the
 * judged set, plus an accumulating count — per independently looping phase. Nested
 * by (runId, phaseId) rather than a concatenated string key, so a separator
 * collision can't merge two distinct keys. Nesting buys only that: there is no
 * whole-run eviction API and every caller names both halves of the pair, so the
 * outer map is a namespace, not a coarser unit of removal.
 */
interface StagnationEntry {
  /** Prior judged-figure snapshot: only identifiers PRESENT that iteration,
   * restricted to the referenced set. Comparison treats presence and value
   * together, so an appearing/disappearing figure counts as change (FR-009). */
  readonly metrics: Readonly<Record<string, number>>;
  /** Consecutive comparisons in which the judged figures did not move. */
  readonly count: number;
}

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
  // Feature 194 — keyed by runId then phaseId. This evaluator is
  // constructed once per window and serves every queue (research.md R1); a
  // single prior-metrics field would be last-writer-wins across concurrent
  // Runs, the defect feature 093 (T047) already fixed in this module.
  private readonly stagnationTrackers = new Map<string, Map<string, StagnationEntry>>();

  constructor(
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: Pick<SanitizedLogger, 'warn'>,
    private readonly validate: typeof validateRetryCondition = validateRetryCondition,
    private readonly evaluate: typeof evaluateRetryCondition = evaluateRetryCondition,
    private readonly decisionSink: LastRetryDecisionSink | null = null
  ) {}

  /**
   * Feature 194 (FR-009, T019) — drop one looping phase's retained figure
   * map, so no later comparison spans an iteration nobody compared. No-op if
   * no entry exists.
   *
   * Callers, all of them mid-drive: `RunDriver` (via `PhaseRunner`) when
   * `PostPhaseDecision.evictStagnationTracker` is true — every halt and pause,
   * and 'advance', everything but a continuing 'loop' — and on the two paths
   * that leave a phase without a `PostPhaseDecision` at all, a skip and an
   * override abort; plus this class itself, for an outcome it declines to
   * compare. Whole-run teardown is `evictRunStagnationTrackers()` below, not a
   * sweep of this one.
   */
  public evictStagnationTracker(runId: string, phaseId: string): void {
    const perPhase = this.stagnationTrackers.get(runId);
    if (perPhase === undefined) return;
    perPhase.delete(phaseId);
    if (perPhase.size === 0) this.stagnationTrackers.delete(runId);
  }

  /**
   * Feature 194 (SC-007) — drop every phase's entry for one Run.
   *
   * The per-phase form above cannot be a backstop: `RunDriver`'s end-of-drive
   * funnel knows `run.currentPhase`, which by then is the phase the Run
   * ADVANCED to (or `'done'`), so a single-key eviction there deletes a key
   * nothing ever wrote and any entry left behind by an earlier looping phase
   * survives for the life of the window. This evaluator is window-scoped, so
   * that is one retained map per looped phase per Run, growing monotonically —
   * SC-007's bound held only by the per-phase evictions all firing, with no
   * catch-all beneath them. A Run is over when `drive()` returns, so its whole
   * subtree goes, and the funnel's claim becomes true rather than aspirational.
   */
  public evictRunStagnationTrackers(runId: string): void {
    this.stagnationTrackers.delete(runId);
  }

  /**
   * Feature 194 (SC-007) — how many `(runId, phaseId)` pairs retain a prior
   * figure map. SC-007 bounds MEMORY, and no emitted field can witness it: a
   * per-iteration history would produce the identical `stalled` sequence. So the
   * bound is asserted against the structure, through an accessor rather than a
   * test reaching into a private field — the latter breaks on any reshape instead
   * of on a behaviour change. A count, not the map: enough to settle the bound,
   * and it exposes no figure name or value to route anywhere (FR-022).
   */
  public get retainedStagnationKeyCount(): number {
    let total = 0;
    for (const perPhase of this.stagnationTrackers.values()) total += perPhase.size;
    return total;
  }

  public async maybeEmit(inputs: PhaseRetryEvaluatorInputs): Promise<number | undefined> {
    const expression = inputs.phaseDef?.retryCondition;
    if (typeof expression !== 'string' || expression.trim().length === 0) return undefined;
    // FR-017 / Feature 011 — emit nothing for these: malformed is recorded by phase-end
    // and the delayed-retry kinds by `retry-scheduled`, so a record here double-counts.
    // Evict, though (FR-009): malformed with exit 0 maps to `issues_remain`, whose
    // retryCondition can `loop`, so nothing else drops a baseline a later count would span.
    if (
      inputs.result.kind === 'malformed' ||
      inputs.result.kind === 'transient_error' ||
      inputs.result.kind === 'rate_limited'
    ) {
      this.evictStagnationTracker(inputs.runId, inputs.phaseDef?.id ?? inputs.phase);
      return undefined;
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
      // Feature 194 (data-model.md state transitions) — parse error: no
      // count maintained, no `stalled` emitted. Leave any existing tracker
      // entry untouched; eviction on the phase's next advance/halt/pause is
      // the sequencer's job (T012, T019), not this error path's.
      return undefined;
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
      // Feature 194 — evaluation error: no count maintained, no `stalled`
      // emitted (data-model.md state transitions; the condition "was not
      // satisfied-and-truthy, so there is no stalled loop to describe").
      return undefined;
    }

    // FR-028: surface missing metric keys on every retry evaluation so the
    // operator UI can distinguish "no metrics missing" from "field omitted".
    // Always emit the array (empty when none missing), not omitted; sorted
    // alphabetically for stable rendering.
    const missing = [...evalResult.evaluation.missingKeys].sort();
    const decision = evalResult.evaluation.value;

    // Feature 194 (FR-006 through FR-009, Delta 2) — computed here, where the
    // parsed AST already lives, so a second parse downstream can't disagree
    // with the one actually evaluated. Touches the tracker only when
    // `decision === true`; every other outcome leaves it untouched rather
    // than reset (data-model.md's state-transition table).
    //
    // Read in isolation that looks like it could resume a stale count across a
    // falsy iteration — the figures moved, so the next truthy comparison would
    // match a pre-move snapshot and overstate. It cannot, and the reason is
    // outside this method: a falsy retryCondition always advances
    // (`phase.ts` — "Falsy -> advance regardless of legacy loop semantics"),
    // advance always sets `evictStagnationTracker`, and the driver evicts before
    // the phase can be entered again. The legacy loop path never reaches here at
    // all, having no retryCondition. So the falsy branch has no successor
    // comparison to mislead; resetting here would be a second spelling of the
    // eviction that already happens, not a repair.
    const stalled = decision
      ? this.updateStagnationTracker(inputs.runId, phaseDefId, parsed.expression, inputs.metrics)
      : undefined;

    const payload: Record<string, unknown> = {
      ...basePayload,
      decision,
      missingKeys: missing,
      ...(stalled !== undefined ? { stalled } : {})
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
    return stalled;
  }

  /**
   * Compares this iteration's judged-figure snapshot to the (runId, phaseId)
   * pair's prior one, updates the tracker, and returns the new `stalled`
   * count — or `undefined` on the first comparable iteration (no prior
   * entry) or an empty judged set (a constant condition names nothing to
   * compare; reporting a stall there would be a false signal — FR-009).
   *
   * Also `undefined` when the judged set is non-empty but NONE of its names
   * appears in `metrics`. That is the same false signal by a second route:
   * `resolveTerm` (`src/lib/retry-condition.ts`) reads a missing identifier
   * as 0 and records it in `missingKeys`, so any condition truthy at zero
   * (`< n`, `<= n`, `== 0`) stays truthy forever on a phase that never
   * reports the figure — and an empty snapshot compares equal to an empty
   * snapshot, so the count would climb while nothing was ever measured.
   * FR-009 permits understating and forbids overstating; `missingKeys` on
   * the same record is the signal for that case, not `stalled`.
   */
  private updateStagnationTracker(
    runId: string,
    phaseId: string,
    expression: Expression,
    metrics: Readonly<Record<string, number>>
  ): number | undefined {
    const judged = referencedIdentifiers(expression);
    if (judged.length === 0) return undefined;

    // `Object.create(null)`, not `{}`: the DSL lexer admits `__proto__` as an
    // identifier, so `judged` can name it. The parser now drops it from
    // `metrics` too (`RESERVED_METRIC_KEYS` subset (c)), but `metrics` is the
    // caller's value and this record is not: on a literal the write below
    // stores nothing through the inherited setter, then reads back equal on
    // both sides — a figure that moved scored unchanged, which FR-009 forbids.
    const snapshot: Record<string, number> = Object.create(null) as Record<string, number>;
    let present = 0;
    for (const name of judged) {
      const value = Object.prototype.hasOwnProperty.call(metrics, name) ? metrics[name] : undefined;
      if (value === undefined) continue;
      snapshot[name] = value;
      present += 1;
    }

    if (present === 0) {
      // Nothing was measured this iteration, so there is nothing to compare and
      // no baseline worth keeping: evict, rather than let a later reappearance
      // of the figure compare against a snapshot taken before the gap.
      // Understates by one comparison, the direction FR-009 requires.
      this.evictStagnationTracker(runId, phaseId);
      return undefined;
    }

    let perPhase = this.stagnationTrackers.get(runId);
    if (perPhase === undefined) {
      perPhase = new Map();
      this.stagnationTrackers.set(runId, perPhase);
    }

    // Compared over `judged` — the set already in hand — rather than by
    // hand-rolled record equality over two key sets drawn from it. Presence and
    // value are still judged together (FR-009): a figure absent on one side
    // reads `undefined`, which never equals a number, and one absent on BOTH
    // reads equal, which is spec.md's "missing on both counts as unchanged".
    // Both records are prototype-free, so a judged `__proto__` compares its own
    // value and not an inherited accessor.
    const prior = perPhase.get(phaseId);
    if (prior !== undefined && judged.every((name) => prior.metrics[name] === snapshot[name])) {
      const count = prior.count + 1;
      perPhase.set(phaseId, { metrics: snapshot, count });
      return count;
    }
    // No prior entry (first comparable iteration), or the figures changed:
    // either way this comparison starts a fresh baseline at count 0, and
    // neither case emits `stalled` (C2.2 — "First unchanged comparison is 1").
    perPhase.set(phaseId, { metrics: snapshot, count: 0 });
    return undefined;
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
