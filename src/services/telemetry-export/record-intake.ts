/**
 * FR-R6-F14 (FR-003, FR-005, FR-006, FR-007, FR-013; research R4, R5) — the intake side of the
 * exporter: one untrusted value is validated, told from a copy already taken, mapped, held to
 * the attribute-set limit and added to the open batch, with its coverage outcomes.
 *
 * The open batch is the one still taking records. It ends when it is closed (encoded for the
 * queue) or discarded. `onBound` is called when the batch must be closed before or after a
 * record: at 256 source records, or when the next record would take the estimate past 1 MiB.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';

import {
  COVERAGE_OUTCOMES,
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_MAPPING_REVISION,
  type CoverageOutcome,
  type ExporterClock,
  type TelemetryLedgerPort
} from '../../contracts/telemetry-export';
import { OVERFLOW_ATTRIBUTES, createCardinalityGuard } from './cardinality-guard';
import type { HealthCounters } from './delivery-health';
import type { InstrumentId } from './mapping-revision';
import { createRecordMapper } from './metadata-mapper';
import {
  coverageObservation,
  createMetricsBatch,
  type BatchObservation,
  type MetricsBatch,
  type MetricsBatchOptions
} from './otlp-metrics-encoder';
import { parseSourceRecord } from './source-record';

const BOUNDS = TELEMETRY_EXPORT_BOUNDS;
const ADJUSTMENT_INSTRUMENTS: ReadonlySet<InstrumentId> = new Set(['token-adjustment', 'cost-adjustment']);
/** One observation per coverage outcome: the most a record can add to the coverage instrument. */
const ALL_COVERAGE: readonly BatchObservation[] = Object.freeze(COVERAGE_OUTCOMES.map(coverageObservation));

export type Intake = 'accepted' | 'duplicate' | 'refused';

export interface ClosedBatch {
  readonly body: Uint8Array;
  /** How many source records the batch carries. */
  readonly records: number;
}

export interface RecordIntakeOptions {
  readonly ledger: TelemetryLedgerPort;
  readonly counters: HealthCounters;
  readonly clock: ExporterClock;
  readonly batch: MetricsBatchOptions;
  /** The open batch has reached a bound and must be closed now. */
  readonly onBound: () => void;
}

export interface RecordIntake {
  take(value: unknown, profileId: string): Intake;
  /** Ends the open batch and returns its encoding; `null` when it holds no record. */
  close(): ClosedBatch | null;
  /** Ends the open batch without encoding it; true when it held a record. */
  discard(): boolean;
}

interface OpenBatch {
  readonly batch: MetricsBatch;
  readonly startedAt: number;
  /**
   * The room kept for coverage: what one data point per outcome adds to an empty batch. The
   * estimate does not depend on values, so the outcomes still to come never need more.
   */
  readonly coverageReserve: number;
  records: number;
}

interface Staged {
  readonly observation: BatchObservation;
  readonly overflow: boolean;
}

/** The identity of one copy: the same record under the same profile and mapping, sent once. */
export function copyIdentityOf(profileId: string, sourceId: string, sourceRevision: number): string {
  const text = `${profileId}\n${String(TELEMETRY_MAPPING_REVISION)}\n${sourceId}\n${String(sourceRevision)}`;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createRecordIntake(options: RecordIntakeOptions): RecordIntake {
  const { ledger, counters, clock, onBound } = options;
  /** One guard for the exporter's lifetime, so the attribute-set limit holds across batches. */
  const guard = createCardinalityGuard();
  /** One mapper for the same lifetime: equal attribute lists are one object, built once. */
  const mapRecord = createRecordMapper();
  let open: OpenBatch | null = null;

  function takeOpen(): OpenBatch | null {
    const taken = open;
    open = null;
    return taken;
  }

  /** The open batch with room for these observations; a full one is closed first. */
  function openBatchFor(observations: readonly BatchObservation[]): OpenBatch {
    const current = open;
    if (current !== null && current.records > 0) {
      // No observation is on the coverage instrument, so the two parts share no data point.
      const growth = current.batch.growthOf(observations) + current.coverageReserve;
      if (current.batch.estimatedBytes() + growth > BOUNDS.batchBytesMax) onBound();
    }
    // `onBound` closes the open batch, so it is read again here.
    const kept = open ?? openBatch();
    open = kept;
    return kept;
  }

  function openBatch(): OpenBatch {
    const batch = createMetricsBatch(options.batch);
    return { batch, startedAt: clock.now(), coverageReserve: batch.growthOf(ALL_COVERAGE), records: 0 };
  }

  /** Whether this copy is the first one; a ledger that throws refuses the record. */
  function isFirstCopy(copyId: string): boolean | null {
    try {
      return ledger.rememberCopy(copyId) === 'new';
    } catch {
      // Without the ledger a second copy could not be told from the first.
      counters.ledgerFault();
      return null;
    }
  }

  function stage(observation: BatchObservation, admitted: boolean): Staged {
    if (admitted) return { observation, overflow: false };
    return { observation: { ...observation, attributes: OVERFLOW_ATTRIBUTES }, overflow: true };
  }

  return {
    take(value, profileId) {
      const parsed = parseSourceRecord(value);
      if (parsed.kind === 'unsupported-schema') {
        counters.unsupportedSchemaRecord();
        return 'refused';
      }
      if (parsed.kind === 'invalid') {
        counters.invalidRecord();
        return 'refused';
      }
      const { record } = parsed;
      const first = isFirstCopy(copyIdentityOf(profileId, record.sourceId, record.sourceRevision));
      if (first === null) return 'refused';
      if (!first) {
        counters.duplicateRecord();
        return 'duplicate';
      }
      const mapped = mapRecord(record);
      const staged = mapped.observations.map((observation) =>
        stage(observation, guard.admit(observation.instrument, observation.attributes) === 'admitted')
      );
      const target = openBatchFor(staged.map((entry) => entry.observation));
      const outcomes: CoverageOutcome[] = mapped.coverage.filter((outcome) => outcome !== 'exported' && outcome !== 'correction');
      for (const { observation, overflow } of staged) {
        if (target.batch.add(observation) === 'out-of-range') outcomes.push('out-of-range');
        else if (overflow) outcomes.push('overflow');
        else outcomes.push(ADJUSTMENT_INSTRUMENTS.has(observation.instrument) ? 'correction' : 'exported');
      }
      for (const outcome of outcomes) {
        counters.coverage(outcome);
        target.batch.add(coverageObservation(outcome));
      }
      target.records += 1;
      if (target.records >= BOUNDS.batchRecordsMax) onBound();
      return 'accepted';
    },
    close() {
      const closing = takeOpen();
      if (closing === null || closing.records === 0) return null;
      return { body: closing.batch.encode({ startTimeMs: closing.startedAt, timeMs: clock.now() }), records: closing.records };
    },
    discard() {
      const discarded = takeOpen();
      return discarded !== null && discarded.records > 0;
    }
  };
}
