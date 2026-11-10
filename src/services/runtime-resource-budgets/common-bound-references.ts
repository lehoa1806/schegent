/**
 * Reference implementations of the FR-015 common queue and query bounds (`F03-AC-05`,
 * `FR-008`, `FR-009`, `FR-010`, `FR-015`, `SC-008`).
 *
 * The resource collector (`resource-collector.ts`) is the only FR-015 queue that lives inside
 * F03 itself. For the queues whose owning consumers (`F06`, `F11`) are not yet built, these
 * reference implementations exercise `BoundedWindow<T>` and admission/lease primitives at both
 * their production defaults and reduced test scales so `common-bound-conformance.ts` can verify
 * every limit and limit-plus-one case in this cycle.
 *
 * Zero `vscode` imports.
 */

import {
  CORRECTION_HISTORY_MAX_BYTES,
  CORRECTION_HISTORY_MAX_ITEMS,
  HISTORICAL_QUERY_MAX_EXECUTING,
  HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES,
  HISTORICAL_QUERY_MAX_WAITING,
  HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES,
  LIVE_REPORT_LEASE_LIFETIME_MS,
  LIVE_REPORT_MAX_LEASES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
  PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
  PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
  PENDING_USAGE_INGESTION_MAX_BYTES,
  PENDING_USAGE_INGESTION_MAX_ITEMS,
  UNATTRIBUTED_USAGE_MAX_AGE_MS,
  UNATTRIBUTED_USAGE_MAX_BYTES,
  UNATTRIBUTED_USAGE_MAX_ITEMS
} from '../../contracts/runtime-resource-budgets/common-bounds.js';
import { BoundedWindow } from './bounded-window.js';

export interface UsageObservationItem {
  readonly key?: string;
  readonly tokens: number;
  readonly bytes: number;
  readonly provisional: boolean;
}

export interface PendingUsageIngestionOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

export interface UsageOfferOutcome {
  readonly status: 'accepted' | 'coalesced' | 'refused-coverage-gap';
  readonly coverageGapCount: number;
  readonly coalescedCount: number;
}

/**
 * FR-008 / FR-015: Pending optional usage ingestion (`4,096` items or `16 MiB`).
 * Synchronous, non-blocking offer: coalesces provisional counters by key or refuses with a
 * counted coverage gap; never blocks runner control parsing or attempt settlement.
 */
export class PendingUsageIngestionQueue {
  private readonly window: BoundedWindow<UsageObservationItem>;
  private coverageGaps = 0;

  constructor(options: PendingUsageIngestionOptions = {}) {
    this.window = new BoundedWindow<UsageObservationItem>({
      maxItems: options.maxItems ?? PENDING_USAGE_INGESTION_MAX_ITEMS,
      maxBytes: options.maxBytes ?? PENDING_USAGE_INGESTION_MAX_BYTES,
      overflow: 'coalesce-or-refuse',
      coalescer: (existing, incoming) => {
        if (!incoming.provisional || incoming.key === undefined) {
          return null;
        }
        const index = existing.findIndex(
          (item) => item.provisional && item.key === incoming.key
        );
        if (index === -1) {
          return null;
        }
        const target = existing[index]!;
        return {
          index,
          merged: {
            key: target.key,
            tokens: target.tokens + incoming.tokens,
            bytes: target.bytes,
            provisional: true
          },
          mergedBytes: target.bytes
        };
      }
    });
  }

  offer(item: UsageObservationItem, nowMs = 0): UsageOfferOutcome {
    const res = this.window.offer(item, item.bytes, nowMs, nowMs);
    const counters = this.window.counters;
    if (res.status === 'refused') {
      this.coverageGaps += 1;
      return {
        status: 'refused-coverage-gap',
        coverageGapCount: this.coverageGaps,
        coalescedCount: counters.coalesced
      };
    }
    return {
      status: res.status === 'coalesced' ? 'coalesced' : 'accepted',
      coverageGapCount: this.coverageGaps,
      coalescedCount: counters.coalesced
    };
  }

  get state() {
    const counters = this.window.counters;
    return {
      items: this.window.size,
      bytes: this.window.currentBytes,
      coalescedCount: counters.coalesced,
      refusedCount: counters.refused,
      coverageGapCount: this.coverageGaps
    };
  }

  values(): readonly UsageObservationItem[] {
    return this.window.items();
  }
}

export interface UnattributedUsageItem {
  readonly rawPayloadSummary: string;
  readonly bytes: number;
}

export interface UnattributedUsageOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
}

export interface UnattributedOfferOutcome {
  readonly status: 'accepted' | 'quarantined-or-expired';
  readonly omissionCount: number;
  readonly expiredCount: number;
}

/**
 * FR-008 / FR-015: Unattributed usage observations (`1,024` items, `4 MiB`, or `24 hours`).
 * Expires old entries first; when still at capacity, quarantines/drops with an omission count
 * and never guesses attribution to an active attempt.
 */
export class UnattributedUsageQueue {
  private readonly window: BoundedWindow<UnattributedUsageItem>;
  private omissions = 0;

  constructor(options: UnattributedUsageOptions = {}) {
    this.window = new BoundedWindow<UnattributedUsageItem>({
      maxItems: options.maxItems ?? UNATTRIBUTED_USAGE_MAX_ITEMS,
      maxBytes: options.maxBytes ?? UNATTRIBUTED_USAGE_MAX_BYTES,
      maxAgeMs: options.maxAgeMs ?? UNATTRIBUTED_USAGE_MAX_AGE_MS,
      overflow: 'expire-then-refuse'
    });
  }

  offer(item: UnattributedUsageItem, nowMs: number): UnattributedOfferOutcome {
    const res = this.window.offer(item, item.bytes, nowMs, nowMs);
    const counters = this.window.counters;
    if (res.status === 'refused') {
      this.omissions += 1;
      return {
        status: 'quarantined-or-expired',
        omissionCount: this.omissions,
        expiredCount: counters.expired
      };
    }
    return {
      status: 'accepted',
      omissionCount: this.omissions,
      expiredCount: counters.expired
    };
  }

  get state() {
    const counters = this.window.counters;
    return {
      items: this.window.size,
      bytes: this.window.currentBytes,
      expiredCount: counters.expired,
      omissionCount: this.omissions
    };
  }
}

export interface ProjectionWorkRef {
  readonly intentId: string;
  readonly bytes: number;
}

export interface PendingProjectionQueueOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/**
 * FR-015: Pending in-memory accounting projection work (`2,048` references or `8 MiB`).
 * Refuses duplicate or excess in-memory work and signals that the worker should refill from
 * durable intents after draining.
 */
export class PendingAccountingProjectionQueue {
  private readonly window: BoundedWindow<ProjectionWorkRef>;
  private readonly activeIds = new Set<string>();
  private refillFromDurableRequired = false;

  constructor(options: PendingProjectionQueueOptions = {}) {
    this.window = new BoundedWindow<ProjectionWorkRef>({
      maxItems: options.maxItems ?? PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
      maxBytes: options.maxBytes ?? PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
      overflow: 'refuse'
    });
  }

  offer(ref: ProjectionWorkRef): {
    readonly status: 'accepted' | 'duplicate-ignored' | 'refused-refill-from-durable';
    readonly refillFromDurableRequired: boolean;
  } {
    if (this.activeIds.has(ref.intentId)) {
      return {
        status: 'duplicate-ignored',
        refillFromDurableRequired: this.refillFromDurableRequired
      };
    }
    const res = this.window.offer(ref, ref.bytes);
    if (res.status === 'refused') {
      this.refillFromDurableRequired = true;
      return {
        status: 'refused-refill-from-durable',
        refillFromDurableRequired: true
      };
    }
    this.activeIds.add(ref.intentId);
    return {
      status: 'accepted',
      refillFromDurableRequired: this.refillFromDurableRequired
    };
  }

  get state() {
    return {
      items: this.window.size,
      bytes: this.window.currentBytes,
      refillFromDurableRequired: this.refillFromDurableRequired
    };
  }
}

export interface DurableAccountingIntent {
  readonly intentId: string;
  readonly bytes: number;
}

export interface DurableIntentAcceptanceOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/**
 * FR-009 / FR-015: Outstanding durable accounting projection intents (`10,000` intents or
 * `32 MiB`). Pauses new optional accounting acceptance before crossing the bound while
 * retaining already accepted facts and intents and exposing degraded coverage.
 */
export class DurableIntentAcceptanceGate {
  private readonly window: BoundedWindow<DurableAccountingIntent>;
  private degradedCoverage = false;

  constructor(options: DurableIntentAcceptanceOptions = {}) {
    this.window = new BoundedWindow<DurableAccountingIntent>({
      maxItems: options.maxItems ?? OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
      maxBytes: options.maxBytes ?? OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
      overflow: 'refuse'
    });
  }

  accept(intent: DurableAccountingIntent): {
    readonly status: 'accepted' | 'paused-degraded-coverage';
    readonly degradedCoverage: boolean;
    readonly retainedCount: number;
  } {
    const res = this.window.offer(intent, intent.bytes);
    if (res.status === 'refused') {
      this.degradedCoverage = true;
      return {
        status: 'paused-degraded-coverage',
        degradedCoverage: true,
        retainedCount: this.window.size
      };
    }
    return {
      status: 'accepted',
      degradedCoverage: this.degradedCoverage,
      retainedCount: this.window.size
    };
  }

  retainedIntents(): readonly DurableAccountingIntent[] {
    return this.window.items();
  }

  get state() {
    return {
      items: this.window.size,
      bytes: this.window.currentBytes,
      degradedCoverage: this.degradedCoverage
    };
  }
}

export interface AttemptCorrectionRecord {
  readonly revision: number;
  readonly contributionTokens: number;
  readonly bytes: number;
}

export interface CorrectionHistoryOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/**
 * FR-009 / FR-015: Accepted correction history per attempt (`64` corrections or `256 KiB`).
 * Refuses the 65th correction or any correction that would exceed `256 KiB` before acceptance,
 * keeps the last accepted contribution intact, and exposes an unresolved conflict status.
 */
export class AttemptCorrectionHistory {
  private readonly window: BoundedWindow<AttemptCorrectionRecord>;
  private lastAccepted: AttemptCorrectionRecord | null = null;
  private unresolvedConflict = false;

  constructor(options: CorrectionHistoryOptions = {}) {
    this.window = new BoundedWindow<AttemptCorrectionRecord>({
      maxItems: options.maxItems ?? CORRECTION_HISTORY_MAX_ITEMS,
      maxBytes: options.maxBytes ?? CORRECTION_HISTORY_MAX_BYTES,
      overflow: 'refuse'
    });
  }

  submit(correction: AttemptCorrectionRecord): {
    readonly status: 'accepted' | 'refused-conflict';
    readonly lastAccepted: AttemptCorrectionRecord | null;
    readonly unresolvedConflict: boolean;
  } {
    const res = this.window.offer(correction, correction.bytes);
    if (res.status === 'refused') {
      this.unresolvedConflict = true;
      return {
        status: 'refused-conflict',
        lastAccepted: this.lastAccepted,
        unresolvedConflict: true
      };
    }
    this.lastAccepted = correction;
    return {
      status: 'accepted',
      lastAccepted: this.lastAccepted,
      unresolvedConflict: this.unresolvedConflict
    };
  }

  get state() {
    return {
      items: this.window.size,
      bytes: this.window.currentBytes,
      lastAccepted: this.lastAccepted,
      unresolvedConflict: this.unresolvedConflict
    };
  }
}

export interface HistoricalQueryRequest {
  readonly queryId: string;
  readonly parameterBytes: number;
}

export interface QueryAdmissionOptions {
  readonly maxExecuting?: number;
  readonly maxWaiting?: number;
  readonly maxQueuedParameterBytes?: number;
}

export type QueryAdmissionOutcome =
  | { readonly status: 'executing'; readonly queryId: string }
  | { readonly status: 'waiting'; readonly queryId: string; readonly position: number }
  | {
      readonly status: 'busy' | 'limited';
      readonly reason: 'waiting-queue-full' | 'parameter-bytes-exceeded';
    };

/**
 * FR-010 / FR-015: Historical query concurrency per workspace (`2` executing, `8` waiting,
 * `1 MiB` total queued parameter bytes). Excess queries return `busy` or `limited`;
 * cancellation removes waiting queries before execution.
 */
export class HistoricalQueryAdmissionGate {
  private readonly maxExecuting: number;
  private readonly maxWaiting: number;
  private readonly maxQueuedParameterBytes: number;
  private readonly executing = new Map<string, HistoricalQueryRequest>();
  private readonly waiting: HistoricalQueryRequest[] = [];
  private queuedParameterBytes = 0;

  constructor(options: QueryAdmissionOptions = {}) {
    this.maxExecuting = options.maxExecuting ?? HISTORICAL_QUERY_MAX_EXECUTING;
    this.maxWaiting = options.maxWaiting ?? HISTORICAL_QUERY_MAX_WAITING;
    this.maxQueuedParameterBytes =
      options.maxQueuedParameterBytes ?? HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES;
  }

  submit(request: HistoricalQueryRequest): QueryAdmissionOutcome {
    if (this.executing.size < this.maxExecuting) {
      if (request.parameterBytes > this.maxQueuedParameterBytes) {
        return { status: 'limited', reason: 'parameter-bytes-exceeded' };
      }
      this.executing.set(request.queryId, request);
      return { status: 'executing', queryId: request.queryId };
    }
    if (this.waiting.length >= this.maxWaiting) {
      return { status: 'busy', reason: 'waiting-queue-full' };
    }
    if (this.queuedParameterBytes + request.parameterBytes > this.maxQueuedParameterBytes) {
      return { status: 'limited', reason: 'parameter-bytes-exceeded' };
    }
    this.waiting.push(request);
    this.queuedParameterBytes += request.parameterBytes;
    return { status: 'waiting', queryId: request.queryId, position: this.waiting.length };
  }

  cancel(queryId: string): boolean {
    const kept: HistoricalQueryRequest[] = [];
    let removed = false;
    for (const item of this.waiting) {
      if (!removed && item.queryId === queryId) {
        this.queuedParameterBytes -= item.parameterBytes;
        removed = true;
      } else {
        kept.push(item);
      }
    }
    if (!removed) {
      return false;
    }
    this.waiting.length = 0;
    this.waiting.push(...kept);
    return true;
  }

  complete(queryId: string): string | null {
    if (!this.executing.delete(queryId)) {
      return null;
    }
    const next = this.waiting.shift();
    if (next === undefined) {
      return null;
    }
    this.queuedParameterBytes -= next.parameterBytes;
    this.executing.set(next.queryId, next);
    return next.queryId;
  }

  get state() {
    return {
      executingCount: this.executing.size,
      waitingCount: this.waiting.length,
      queuedParameterBytes: this.queuedParameterBytes
    };
  }
}

export interface WorkingDataBudgetOptions {
  readonly maxBytes?: number;
}

/**
 * FR-010 / FR-015: Historical query working data per workspace (`32 MiB` excluding shared
 * store cache). Allocations beyond the cap return a `typed-limit` refusal instructing the
 * caller to stream or batch.
 */
export class HistoricalQueryWorkingDataBudget {
  private readonly maxBytes: number;
  private allocatedBytes = 0;

  constructor(options: WorkingDataBudgetOptions = {}) {
    this.maxBytes = options.maxBytes ?? HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES;
  }

  reserve(bytes: number): {
    readonly status: 'reserved' | 'typed-limit';
    readonly allocatedBytes: number;
    readonly maxBytes: number;
  } {
    if (bytes < 0 || !Number.isFinite(bytes)) {
      throw new Error(`Working data reservation must be a non-negative finite number (got ${bytes}).`);
    }
    if (this.allocatedBytes + bytes > this.maxBytes) {
      return {
        status: 'typed-limit',
        allocatedBytes: this.allocatedBytes,
        maxBytes: this.maxBytes
      };
    }
    this.allocatedBytes += bytes;
    return {
      status: 'reserved',
      allocatedBytes: this.allocatedBytes,
      maxBytes: this.maxBytes
    };
  }

  release(bytes: number): void {
    this.allocatedBytes = Math.max(0, this.allocatedBytes - Math.max(0, bytes));
  }

  get state() {
    return {
      allocatedBytes: this.allocatedBytes,
      maxBytes: this.maxBytes
    };
  }
}

export interface ReportLease {
  readonly leaseId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ReportLeaseTableOptions {
  readonly maxLeases?: number;
  readonly leaseLifetimeMs?: number;
}

/**
 * FR-010 / FR-015: Live report snapshot/cursor leases per workspace (`4` leases, fixed
 * `5-minute` lifetime, no automatic renewal). Expired leases return `restart-required` with
 * an explicit restart instruction; renewal attempts are always refused.
 */
export class LiveReportLeaseTable {
  private readonly maxLeases: number;
  private readonly leaseLifetimeMs: number;
  private readonly leases = new Map<string, ReportLease>();

  constructor(options: ReportLeaseTableOptions = {}) {
    this.maxLeases = options.maxLeases ?? LIVE_REPORT_MAX_LEASES;
    this.leaseLifetimeMs = options.leaseLifetimeMs ?? LIVE_REPORT_LEASE_LIFETIME_MS;
  }

  acquire(
    leaseId: string,
    nowMs: number
  ):
    | { readonly status: 'acquired'; readonly lease: ReportLease }
    | { readonly status: 'refused-lease-limit'; readonly activeLeases: number } {
    this.evictExpired(nowMs);
    if (this.leases.size >= this.maxLeases && !this.leases.has(leaseId)) {
      return { status: 'refused-lease-limit', activeLeases: this.leases.size };
    }
    const lease: ReportLease = {
      leaseId,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.leaseLifetimeMs
    };
    this.leases.set(leaseId, lease);
    return { status: 'acquired', lease };
  }

  useLease(
    leaseId: string,
    nowMs: number
  ):
    | { readonly status: 'active'; readonly lease: ReportLease }
    | {
        readonly status: 'expired-restart-required';
        readonly instruction: 'restart-report-query';
      } {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || nowMs - lease.issuedAtMs > this.leaseLifetimeMs) {
      this.leases.delete(leaseId);
      return {
        status: 'expired-restart-required',
        instruction: 'restart-report-query'
      };
    }
    return { status: 'active', lease };
  }

  /**
   * FR-R6-F11: frees a lease when its report closes, so the slot is not held until expiry.
   * Answers false for an unknown, expired-and-evicted or already released lease.
   */
  release(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }

  renew(): {
    readonly status: 'refused-no-automatic-renewal';
    readonly instruction: 'restart-report-query';
  } {
    return {
      status: 'refused-no-automatic-renewal',
      instruction: 'restart-report-query'
    };
  }

  private evictExpired(nowMs: number): void {
    for (const [id, lease] of this.leases.entries()) {
      if (nowMs - lease.issuedAtMs > this.leaseLifetimeMs) {
        this.leases.delete(id);
      }
    }
  }

  get state() {
    return {
      activeLeases: this.leases.size,
      maxLeases: this.maxLeases,
      leaseLifetimeMs: this.leaseLifetimeMs
    };
  }
}
