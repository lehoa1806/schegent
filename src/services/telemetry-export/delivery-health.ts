/**
 * FR-R6-F14 (FR-011; NFR-006) — the delivery counters and the health projection built from
 * them. Everything here is a count, a time or a closed class: no endpoint, header, credential
 * or destination text can reach a surface through it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  COVERAGE_OUTCOMES,
  DROP_REASONS,
  EXPIRY_REASONS,
  TELEMETRY_MAPPING_REVISION,
  type CoverageOutcome,
  type DeliveryErrorClass,
  type DeliveryHealth,
  type DeliveryHealthState,
  type DropReason,
  type ExpiryReason
} from '../../contracts/telemetry-export';

/** What the exporter holds now, which the counters do not know. */
export interface HealthView {
  readonly hasDestination: boolean;
  /** A batch failed an attempt and is not finished. */
  readonly retrying: boolean;
  readonly queuedBatches: number;
  readonly queuedBytes: number;
}

export interface HealthCounters {
  acknowledged(at: number, rejectedDataPoints: number, anomaly: DeliveryErrorClass | null): void;
  expired(reason: ExpiryReason): void;
  dropped(reason: DropReason): void;
  duplicateRecord(): void;
  unsupportedSchemaRecord(): void;
  invalidRecord(): void;
  refusedOffer(): void;
  ledgerFault(): void;
  coverage(outcome: CoverageOutcome): void;
  error(errorClass: DeliveryErrorClass): void;
  /** A new or cleared destination starts with no last error and no failed batch. */
  destinationChanged(): void;
  snapshot(view: HealthView): DeliveryHealth;
}

/** Drops the caller asked for; they say nothing about the destination's health. */
const DELIBERATE_DROPS: ReadonlySet<DropReason> = new Set(['disabled', 'authorization-changed', 'shutdown']);

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function stateOf(view: HealthView, lastBatchFailed: boolean): DeliveryHealthState {
  if (!view.hasDestination) return 'disabled';
  if (view.retrying) return 'retrying';
  return lastBatchFailed ? 'degraded' : 'healthy';
}

export function createHealthCounters(): HealthCounters {
  const dropReasons = zeroCounts(DROP_REASONS);
  const expiryReasons = zeroCounts(EXPIRY_REASONS);
  const coverage = zeroCounts(COVERAGE_OUTCOMES);
  let lastSuccessAt: number | null = null;
  let acknowledgedBatches = 0;
  let expiredBatches = 0;
  let droppedBatches = 0;
  let duplicateRecords = 0;
  let unsupportedSchemaRecords = 0;
  let invalidRecords = 0;
  let refusedOffers = 0;
  let rejectedDataPoints = 0;
  let ledgerFaults = 0;
  let lastError: DeliveryErrorClass | null = null;
  let lastBatchFailed = false;

  return {
    acknowledged(at, rejected, anomaly) {
      acknowledgedBatches += 1;
      rejectedDataPoints += rejected;
      lastSuccessAt = at;
      lastError = anomaly;
      lastBatchFailed = false;
    },
    expired(reason) {
      expiredBatches += 1;
      expiryReasons[reason] += 1;
      lastBatchFailed = true;
    },
    dropped(reason) {
      droppedBatches += 1;
      dropReasons[reason] += 1;
      if (!DELIBERATE_DROPS.has(reason)) lastBatchFailed = true;
    },
    duplicateRecord() {
      duplicateRecords += 1;
    },
    unsupportedSchemaRecord() {
      unsupportedSchemaRecords += 1;
    },
    invalidRecord() {
      invalidRecords += 1;
    },
    refusedOffer() {
      refusedOffers += 1;
    },
    ledgerFault() {
      ledgerFaults += 1;
    },
    coverage(outcome) {
      coverage[outcome] += 1;
    },
    error(errorClass) {
      lastError = errorClass;
    },
    destinationChanged() {
      lastError = null;
      lastBatchFailed = false;
    },
    snapshot(view) {
      return Object.freeze({
        state: stateOf(view, lastBatchFailed),
        mappingRevision: TELEMETRY_MAPPING_REVISION,
        lastSuccessAt,
        queuedBatches: view.queuedBatches,
        queuedBytes: view.queuedBytes,
        acknowledgedBatches,
        expiredBatches,
        droppedBatches,
        dropReasons: Object.freeze({ ...dropReasons }),
        expiryReasons: Object.freeze({ ...expiryReasons }),
        duplicateRecords,
        unsupportedSchemaRecords,
        invalidRecords,
        refusedOffers,
        rejectedDataPoints,
        ledgerFaults,
        lastError,
        coverage: Object.freeze({ ...coverage })
      });
    }
  };
}
