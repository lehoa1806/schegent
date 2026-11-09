/**
 * FR-R6-F03 — Runtime resource budgets: the common queue and query bounds (FR-015).
 *
 * These are F03-owned defaults for queues that no existing contract bounds. The first
 * count, byte or age limit reached applies, and acceptance covers the limit and the
 * limit-plus-one case. They are owned-data bounds, not predictions of V8 overhead, and an
 * explicit refusal is preferred to silently losing an already accepted fact.
 *
 * Existing contract authorities (snapshot budgets, control-ledger root limits, stream
 * caps…) are NOT restated here (FR-012). The inventory in
 * `src/services/runtime-resource-budgets/resource-inventory.ts` imports them from where
 * they live.
 *
 * Zero `vscode` imports.
 */

export const RUNTIME_RESOURCE_BUDGETS_CONTRACT_VERSION = 1 as const;

const KIB = 1024;
const MIB = 1024 * KIB;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Resource collector sampling window — the entire collector (FR-015, FR-021). */
export const RESOURCE_COLLECTOR_MAX_SAMPLES = 4_096 as const;
export const RESOURCE_COLLECTOR_MAX_BYTES = 4 * MIB;

/** Pending optional usage ingestion (owning consumer: F06). */
export const PENDING_USAGE_INGESTION_MAX_ITEMS = 4_096 as const;
export const PENDING_USAGE_INGESTION_MAX_BYTES = 16 * MIB;

/** Unattributed usage observations (owning consumer: F06). */
export const UNATTRIBUTED_USAGE_MAX_ITEMS = 1_024 as const;
export const UNATTRIBUTED_USAGE_MAX_BYTES = 4 * MIB;
export const UNATTRIBUTED_USAGE_MAX_AGE_MS = 24 * HOUR_MS;

/** Pending in-memory accounting projection work (owning consumer: F06). */
export const PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS = 2_048 as const;
export const PENDING_ACCOUNTING_PROJECTION_MAX_BYTES = 8 * MIB;

/** Outstanding durable accounting projection intents (owning consumer: F06). */
export const OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS = 10_000 as const;
export const OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES = 32 * MIB;

/** Accepted correction history per attempt, within the retained horizon (F02/F06). */
export const CORRECTION_HISTORY_MAX_ITEMS = 64 as const;
export const CORRECTION_HISTORY_MAX_BYTES = 256 * KIB;

/** Historical query concurrency per workspace (owning consumer: F11). */
export const HISTORICAL_QUERY_MAX_EXECUTING = 2 as const;
export const HISTORICAL_QUERY_MAX_WAITING = 8 as const;
export const HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES = 1 * MIB;

/** Historical query working data per workspace, excluding the shared store cache (F11). */
export const HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES = 32 * MIB;

/** Live report snapshot/cursor leases per workspace (owning consumer: F11). */
export const LIVE_REPORT_MAX_LEASES = 4 as const;
export const LIVE_REPORT_LEASE_LIFETIME_MS = 5 * MINUTE_MS;

export const COMMON_BOUND_IDS = [
  'resource-collector-window',
  'pending-usage-ingestion',
  'unattributed-usage-observations',
  'pending-accounting-projection-work',
  'outstanding-accounting-intents',
  'correction-history-per-attempt',
  'historical-query-concurrency',
  'historical-query-working-data',
  'live-report-leases'
] as const;

export type CommonBoundId = (typeof COMMON_BOUND_IDS)[number];

export type CommonBoundOverflow =
  | 'overwrite-oldest-after-aggregates'
  | 'coalesce-or-refuse-with-coverage-gap'
  | 'expire-or-quarantine-with-omission-count'
  | 'refuse-and-refill-from-durable-intents'
  | 'pause-acceptance-before-bound'
  | 'refuse-before-acceptance-keep-last-accepted'
  | 'busy-or-limited-cancel-removes'
  | 'stream-batch-or-typed-limit'
  | 'expire-with-restart-instruction-no-renewal';

/**
 * Where a bound is enforced this cycle (clarification Q3): the resource collector is the
 * only FR-015 queue that exists today; every other bound ships contract values plus
 * limit / limit-plus-one conformance fixtures its owning consumer must pass.
 */
export type CommonBoundEnforcement = 'f03-resource-collector' | 'conformance-fixture';

export interface CommonQueueBound {
  readonly id: CommonBoundId;
  readonly description: string;
  readonly owningConsumer: 'F03' | 'F06' | 'F11';
  readonly maxItems?: number;
  /** Executing slots, for admission-gate shaped bounds. */
  readonly maxExecuting?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** Fixed lifetime with no renewal, for lease-shaped bounds. */
  readonly fixedLifetimeMs?: number;
  readonly overflow: CommonBoundOverflow;
  readonly enforcedIn: CommonBoundEnforcement;
}

export const COMMON_QUEUE_BOUNDS: readonly CommonQueueBound[] = Object.freeze([
  {
    id: 'resource-collector-window',
    description: 'Resource collector sampling window (entire collector)',
    owningConsumer: 'F03',
    maxItems: RESOURCE_COLLECTOR_MAX_SAMPLES,
    maxBytes: RESOURCE_COLLECTOR_MAX_BYTES,
    overflow: 'overwrite-oldest-after-aggregates',
    enforcedIn: 'f03-resource-collector'
  },
  {
    id: 'pending-usage-ingestion',
    description: 'Pending optional usage ingestion',
    owningConsumer: 'F06',
    maxItems: PENDING_USAGE_INGESTION_MAX_ITEMS,
    maxBytes: PENDING_USAGE_INGESTION_MAX_BYTES,
    overflow: 'coalesce-or-refuse-with-coverage-gap',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'unattributed-usage-observations',
    description: 'Unattributed usage observations',
    owningConsumer: 'F06',
    maxItems: UNATTRIBUTED_USAGE_MAX_ITEMS,
    maxBytes: UNATTRIBUTED_USAGE_MAX_BYTES,
    maxAgeMs: UNATTRIBUTED_USAGE_MAX_AGE_MS,
    overflow: 'expire-or-quarantine-with-omission-count',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'pending-accounting-projection-work',
    description: 'Pending in-memory accounting projection work',
    owningConsumer: 'F06',
    maxItems: PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
    maxBytes: PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
    overflow: 'refuse-and-refill-from-durable-intents',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'outstanding-accounting-intents',
    description: 'Outstanding durable accounting projection intents',
    owningConsumer: 'F06',
    maxItems: OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
    maxBytes: OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
    overflow: 'pause-acceptance-before-bound',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'correction-history-per-attempt',
    description: 'Accepted correction history per attempt (retained correction horizon)',
    owningConsumer: 'F06',
    maxItems: CORRECTION_HISTORY_MAX_ITEMS,
    maxBytes: CORRECTION_HISTORY_MAX_BYTES,
    overflow: 'refuse-before-acceptance-keep-last-accepted',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'historical-query-concurrency',
    description: 'Historical query concurrency per workspace',
    owningConsumer: 'F11',
    maxExecuting: HISTORICAL_QUERY_MAX_EXECUTING,
    maxItems: HISTORICAL_QUERY_MAX_WAITING,
    maxBytes: HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES,
    overflow: 'busy-or-limited-cancel-removes',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'historical-query-working-data',
    description: 'Historical query working data per workspace (excludes shared store cache)',
    owningConsumer: 'F11',
    maxBytes: HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES,
    overflow: 'stream-batch-or-typed-limit',
    enforcedIn: 'conformance-fixture'
  },
  {
    id: 'live-report-leases',
    description: 'Live report snapshot/cursor leases per workspace',
    owningConsumer: 'F11',
    maxItems: LIVE_REPORT_MAX_LEASES,
    fixedLifetimeMs: LIVE_REPORT_LEASE_LIFETIME_MS,
    overflow: 'expire-with-restart-instruction-no-renewal',
    enforcedIn: 'conformance-fixture'
  }
] satisfies readonly CommonQueueBound[]);

export function getCommonQueueBound(id: CommonBoundId): CommonQueueBound {
  const bound = COMMON_QUEUE_BOUNDS.find((entry) => entry.id === id);
  if (bound === undefined) {
    throw new Error(`Unknown common bound '${id}'.`);
  }
  return bound;
}

