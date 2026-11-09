/**
 * FR-R6-F03 — Reusable bounded window primitive enforcing count, byte, and optional
 * age limits with explicit overflow policies (FR-015, FR-021, research R4).
 *
 * The first count, byte, or age limit reached applies.
 *
 * Zero `vscode` imports.
 */

export type BoundedWindowOverflowPolicy =
  | 'overwrite-oldest'
  | 'refuse'
  | 'coalesce-or-refuse'
  | 'expire-then-refuse';

export type BoundedLimitReason = 'count' | 'bytes' | 'age' | 'item-exceeds-bytes';

export interface CoalesceResolution<T> {
  readonly index: number;
  readonly merged: T;
  readonly mergedBytes: number;
}

export type BoundedWindowCoalescer<T> = (
  existing: readonly T[],
  incoming: T
) => CoalesceResolution<T> | null;

export interface BoundedWindowOptions<T> {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxAgeMs?: number;
  readonly overflow: BoundedWindowOverflowPolicy;
  readonly clock?: () => number;
  readonly onEvict?: (item: T, bytes: number, reason: 'count' | 'bytes' | 'age') => void;
  readonly coalescer?: BoundedWindowCoalescer<T>;
}

export type BoundedOfferOutcome =
  | {
      readonly status: 'accepted';
      readonly expiredCount: number;
    }
  | {
      readonly status: 'coalesced';
      readonly expiredCount: number;
      readonly targetIndex: number;
    }
  | {
      readonly status: 'overwrote';
      readonly evictedCount: number;
      readonly expiredCount: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: BoundedLimitReason;
      readonly expiredCount: number;
    };

export interface BoundedWindowCounters {
  readonly observed: number;
  readonly accepted: number;
  readonly coalesced: number;
  readonly refused: number;
  readonly overwritten: number;
  readonly expired: number;
}

interface WindowEntry<T> {
  item: T;
  bytes: number;
  timestampMs: number;
}

export class BoundedWindow<T> {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number | undefined;
  readonly overflow: BoundedWindowOverflowPolicy;

  private readonly clock: () => number;
  private readonly onEvict:
    | ((item: T, bytes: number, reason: 'count' | 'bytes' | 'age') => void)
    | undefined;
  private readonly coalescer: BoundedWindowCoalescer<T> | undefined;

  private readonly entries: WindowEntry<T>[] = [];
  private totalBytes = 0;

  private observedCount = 0;
  private acceptedCount = 0;
  private coalescedCount = 0;
  private refusedCount = 0;
  private overwrittenCount = 0;
  private expiredCount = 0;

  constructor(options: BoundedWindowOptions<T>) {
    if (!Number.isInteger(options.maxItems) || options.maxItems < 1) {
      throw new Error(`BoundedWindow maxItems must be a positive integer; got ${options.maxItems}`);
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
      throw new Error(`BoundedWindow maxBytes must be a positive number; got ${options.maxBytes}`);
    }
    if (options.maxAgeMs !== undefined && (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 1)) {
      throw new Error(`BoundedWindow maxAgeMs must be a positive number; got ${options.maxAgeMs}`);
    }
    this.maxItems = options.maxItems;
    this.maxBytes = options.maxBytes;
    this.maxAgeMs = options.maxAgeMs;
    this.overflow = options.overflow;
    this.clock = options.clock ?? Date.now;
    this.onEvict = options.onEvict;
    this.coalescer = options.coalescer;
  }

  get size(): number {
    return this.entries.length;
  }

  get currentBytes(): number {
    return this.totalBytes;
  }

  get counters(): BoundedWindowCounters {
    return {
      observed: this.observedCount,
      accepted: this.acceptedCount,
      coalesced: this.coalescedCount,
      refused: this.refusedCount,
      overwritten: this.overwrittenCount,
      expired: this.expiredCount
    };
  }

  items(): readonly T[] {
    return this.entries.map((entry) => entry.item);
  }

  /**
   * Expire entries older than `maxAgeMs` relative to `nowMs`.
   */
  expireStale(nowMs: number = this.clock()): number {
    if (this.maxAgeMs === undefined) return 0;
    let removed = 0;
    let idx = 0;
    while (idx < this.entries.length) {
      const entry = this.entries[idx]!;
      if (nowMs - entry.timestampMs > this.maxAgeMs) {
        this.onEvict?.(entry.item, entry.bytes, 'age');
        this.totalBytes -= entry.bytes;
        this.entries.splice(idx, 1);
        this.expiredCount += 1;
        removed += 1;
      } else {
        idx += 1;
      }
    }
    return removed;
  }

  /**
   * Offer an item of `bytes` size to the bounded window.
   */
  offer(
    item: T,
    bytes: number,
    nowMs: number = this.clock(),
    itemTimestampMs: number = nowMs
  ): BoundedOfferOutcome {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`BoundedWindow offer bytes must be non-negative; got ${bytes}`);
    }

    this.observedCount += 1;
    const expiredBefore = this.expireStale(nowMs);

    if (this.maxAgeMs !== undefined && nowMs - itemTimestampMs > this.maxAgeMs) {
      this.onEvict?.(item, bytes, 'age');
      this.expiredCount += 1;
      this.refusedCount += 1;
      return {
        status: 'refused',
        reason: 'age',
        expiredCount: expiredBefore + 1
      };
    }

    if (bytes > this.maxBytes) {
      this.refusedCount += 1;
      return {
        status: 'refused',
        reason: 'item-exceeds-bytes',
        expiredCount: expiredBefore
      };
    }

    const wouldExceedCount = this.entries.length + 1 > this.maxItems;
    const wouldExceedBytes = this.totalBytes + bytes > this.maxBytes;

    if (!wouldExceedCount && !wouldExceedBytes) {
      this.entries.push({ item, bytes, timestampMs: itemTimestampMs });
      this.totalBytes += bytes;
      this.acceptedCount += 1;
      return {
        status: 'accepted',
        expiredCount: expiredBefore
      };
    }

    const hitReason: 'count' | 'bytes' = wouldExceedCount ? 'count' : 'bytes';

    if (this.overflow === 'overwrite-oldest') {
      let evictedCount = 0;
      while (
        this.entries.length > 0 &&
        (this.entries.length + 1 > this.maxItems || this.totalBytes + bytes > this.maxBytes)
      ) {
        const oldest = this.entries[0]!;
        const reason: 'count' | 'bytes' =
          this.entries.length + 1 > this.maxItems ? 'count' : 'bytes';
        this.onEvict?.(oldest.item, oldest.bytes, reason);
        this.entries.shift();
        this.totalBytes -= oldest.bytes;
        this.overwrittenCount += 1;
        evictedCount += 1;
      }
      this.entries.push({ item, bytes, timestampMs: itemTimestampMs });
      this.totalBytes += bytes;
      this.acceptedCount += 1;
      return {
        status: 'overwrote',
        evictedCount,
        expiredCount: expiredBefore
      };
    }

    if (this.overflow === 'coalesce-or-refuse' && this.coalescer !== undefined) {
      const resolution = this.coalescer(
        this.entries.map((e) => e.item),
        item
      );
      if (
        resolution !== null &&
        resolution.index >= 0 &&
        resolution.index < this.entries.length
      ) {
        const target = this.entries[resolution.index]!;
        const nextTotalBytes = this.totalBytes - target.bytes + resolution.mergedBytes;
        if (resolution.mergedBytes >= 0 && nextTotalBytes <= this.maxBytes) {
          target.item = resolution.merged;
          target.bytes = resolution.mergedBytes;
          target.timestampMs = itemTimestampMs;
          this.totalBytes = nextTotalBytes;
          this.coalescedCount += 1;
          return {
            status: 'coalesced',
            expiredCount: expiredBefore,
            targetIndex: resolution.index
          };
        }
      }
    }

    this.refusedCount += 1;
    return {
      status: 'refused',
      reason: hitReason,
      expiredCount: expiredBefore
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.totalBytes = 0;
  }
}

