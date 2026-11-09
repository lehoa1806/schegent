/**
 * FR-R6-F06 (T024, FR-001, FR-002, FR-005, FR-020, research R3, R4, R9) — a `phase-end` audit
 * row, as the audit writer hands it to subscribers, becomes one accounting observation.
 *
 * WHAT THE ROW CARRIES. The projected `phase-end` payload is built field by field
 * (`projectPhaseEnd`), so it holds the usage, the attempt id and the outcome, but no runner,
 * model or phase id. The same attempt's `cli-invocation` row, appended first, does carry the
 * runner and the model. `PhaseEndCorrelator` remembers those two values per run, phase and
 * iteration, and attaches them when the `phase-end` row arrives. The phase id is the envelope
 * `phase`. A row with no remembered invocation has no backend: its cache relation and cost are
 * then unqualified, never guessed.
 *
 * WHAT IS COPIED. A snapshot holds only closed or bounded values: identifiers, the outcome
 * mapped onto the attempt vocabulary, the five usage figures read through `readPhaseEndUsage`,
 * and the parser's cost-baseline marker when it is one of the three members. Prompt text,
 * paths, tool arguments and error text are never read.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AuditEntry } from '../../audit/audit-entry';
import type { PhaseEndOutcome } from '../../audit/audit-payload';
import type { AttemptOutcome, CacheRelation, Measure } from '../../contracts/usage-accounting/accounting-types';
import { PHASE_END_PRODUCER_NAMESPACE } from '../../contracts/usage-accounting/accounting-types';
import { qualificationFor } from '../../contracts/usage-accounting/provider-qualifications';
import { type PhaseEndUsage, type UsageValue, readPhaseEndUsage } from '../usage-reader';
import { type CostBaselineMarker, costBaselineOf, qualifyCumulativeCost } from './cumulative-qualifier';
import type { AccountingMeasureInput, AccountingObservationInput } from './observation-normalizer';

export const PHASE_END_ADAPTER_VERSION = 'phase-end/1';
export const PHASE_END_SOURCE = 'phase-end';
/** How many open invocation contexts the correlator holds before it evicts the oldest. */
export const DEFAULT_CORRELATOR_CAPACITY = 256;

const COST_UNIT = 'USD';
const COUNT_UNIT = 'count';
const MONEY_DIGITS = 6;
const REASON_NOT_REPORTED = 'not-reported';
const REASON_REJECTED = 'rejected-value';
const REASON_UNQUALIFIED = 'unqualified-backend';

/** The copy the watcher queues: nothing in it came from free text. */
export interface PhaseEndSnapshot {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
  readonly timestamp: string;
  readonly attemptId: string | null;
  readonly backend: string | null;
  readonly model: string | null;
  readonly outcome: AttemptOutcome;
  readonly usage: PhaseEndUsage;
  readonly costBaseline: CostBaselineMarker | null;
}

const OUTCOME_MAP: Readonly<Record<PhaseEndOutcome, AttemptOutcome>> = Object.freeze({
  clean: 'succeeded',
  issues_remain: 'succeeded',
  failed: 'failed',
  rate_limited: 'failed',
  'rate-limited': 'failed',
  timeout: 'failed',
  deadline: 'failed',
  transient_error: 'failed',
  skipped: 'cancelled',
  'paused-at-breakpoint': 'interrupted',
  incomplete_turn: 'interrupted',
  malformed: 'unknown'
});

/** A `phase-end` outcome on the attempt vocabulary; anything outside the closed set is `unknown`. */
export function attemptOutcomeOf(outcome: unknown): AttemptOutcome {
  if (typeof outcome !== 'string' || !Object.hasOwn(OUTCOME_MAP, outcome)) return 'unknown';
  return OUTCOME_MAP[outcome as PhaseEndOutcome];
}

function boundedText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface InvocationContext {
  readonly backend: string | null;
  readonly model: string | null;
}

/**
 * Pairs each `phase-end` row with the runner and model of the `cli-invocation` row that opened
 * the same run, phase and iteration. Bounded: past `capacity` open contexts the oldest goes.
 */
export class PhaseEndCorrelator {
  private readonly contexts = new Map<string, InvocationContext>();

  public constructor(private readonly capacity: number = DEFAULT_CORRELATOR_CAPACITY) {}

  public get size(): number {
    return this.contexts.size;
  }

  /** Returns a snapshot for a `phase-end` row; remembers context for a phase `cli-invocation`. */
  public observe(entry: AuditEntry): PhaseEndSnapshot | undefined {
    const key = `${entry.runId}\u0000${entry.phase}\u0000${entry.iteration}`;
    if (entry.eventType === 'cli-invocation') {
      this.remember(key, entry.payload);
      return undefined;
    }
    if (entry.eventType !== 'phase-end') return undefined;
    const context = this.contexts.get(key);
    this.contexts.delete(key);
    return snapshotOf(entry, context);
  }

  private remember(key: string, payload: Readonly<Record<string, unknown>>): void {
    if (payload.operation !== undefined && payload.operation !== 'phase') return;
    this.contexts.delete(key);
    this.contexts.set(key, { backend: boundedText(payload.runner), model: boundedText(payload.modelId) });
    while (this.contexts.size > this.capacity) {
      const oldest = this.contexts.keys().next();
      if (oldest.done === true) break;
      this.contexts.delete(oldest.value);
    }
  }
}

function snapshotOf(entry: AuditEntry, context: InvocationContext | undefined): PhaseEndSnapshot {
  const payload = entry.payload;
  return Object.freeze({
    runId: entry.runId,
    phase: entry.phase,
    iteration: entry.iteration,
    timestamp: entry.timestamp,
    attemptId: boundedText(payload.attemptId),
    backend: context?.backend ?? null,
    model: context?.model ?? null,
    outcome: attemptOutcomeOf(payload.outcome),
    usage: readPhaseEndUsage(payload),
    costBaseline: costBaselineOf(payload.costBaseline)
  });
}

function unknownMeasure(measure: Measure, unit: string, reason: string, cacheRelation?: CacheRelation): AccountingMeasureInput {
  return {
    measure,
    quantity: null,
    unit,
    provenance: 'provider-reported',
    unknownReason: reason,
    ...(cacheRelation !== undefined ? { cacheRelation } : {})
  };
}

function countMeasure(measure: Measure, value: UsageValue, cacheRelation?: CacheRelation): AccountingMeasureInput {
  if (value.kind !== 'present' || !Number.isSafeInteger(value.value)) {
    const reason = value.kind === 'absent' ? REASON_NOT_REPORTED : REASON_REJECTED;
    return unknownMeasure(measure, COUNT_UNIT, reason, cacheRelation);
  }
  return {
    measure,
    quantity: value.value,
    unit: COUNT_UNIT,
    provenance: 'provider-reported',
    ...(cacheRelation !== undefined ? { cacheRelation } : {})
  };
}

/**
 * The cost, by what the backend is qualified to report (FR-020, research R3). A session-cumulative
 * cost is known only when the parser subtracted a qualified baseline; it is then `derived`.
 */
function costMeasure(snapshot: PhaseEndSnapshot): AccountingMeasureInput {
  const cost = snapshot.usage.costUsd;
  if (cost.kind !== 'present') {
    return unknownMeasure('cost', COST_UNIT, cost.kind === 'absent' ? REASON_NOT_REPORTED : REASON_REJECTED);
  }
  const qualification = qualificationFor(snapshot.backend ?? '');
  if (qualification.qualification === 'unqualified') return unknownMeasure('cost', COST_UNIT, REASON_UNQUALIFIED);
  const amount = cost.value.toFixed(MONEY_DIGITS);
  if (qualification.costScope === 'invocation-delta' && !qualification.costNeedsBaseline) {
    return { measure: 'cost', quantity: amount, unit: COST_UNIT, provenance: 'provider-reported' };
  }
  if (!qualification.costNeedsBaseline) return unknownMeasure('cost', COST_UNIT, REASON_UNQUALIFIED);
  const cumulative = qualifyCumulativeCost(snapshot.costBaseline);
  if (cumulative.known) return { measure: 'cost', quantity: amount, unit: COST_UNIT, provenance: cumulative.provenance };
  return unknownMeasure('cost', COST_UNIT, cumulative.reason);
}

/** The observation for one snapshot. Deterministic in the snapshot; `observedUtc` is the ingest clock. */
export function phaseEndObservation(snapshot: PhaseEndSnapshot, observedUtc: string): AccountingObservationInput {
  const cacheRelation = qualificationFor(snapshot.backend ?? '').cacheRelation;
  const usage = snapshot.usage;
  const attemptId = snapshot.attemptId;
  return {
    producerNamespace: PHASE_END_PRODUCER_NAMESPACE,
    source: PHASE_END_SOURCE,
    sourceKind: 'phase-end',
    sourceIdentity:
      attemptId === null ? null : `${snapshot.runId}:${snapshot.phase}:${attemptId}:${snapshot.iteration}`,
    rootId: snapshot.runId,
    attemptId,
    invocationOrdinal: snapshot.iteration,
    counterScope: 'invocation-delta',
    adapterVersion: PHASE_END_ADAPTER_VERSION,
    dimensions: { backend: snapshot.backend, modelRequested: snapshot.model, phaseId: snapshot.phase },
    eventUtc: snapshot.timestamp,
    observedUtc,
    measures: [
      countMeasure('input_tokens', usage.inputTokens),
      countMeasure('output_tokens', usage.outputTokens),
      countMeasure('cache_read_tokens', usage.cacheReadInputTokens, cacheRelation),
      countMeasure('cache_creation_tokens', usage.cacheCreationInputTokens, cacheRelation),
      costMeasure(snapshot)
    ]
  };
}
