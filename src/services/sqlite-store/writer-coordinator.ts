/**
 * FR-R6-F04 (F04-A, FR-005, FR-007) — Single-writer queue admission coordinator
 * and WAL checkpoint / starvation controller.
 *
 * Enforces F03 / F04 runtime budgets:
 * - Total queue capacity: 64 requests / 16 MiB
 * - Settlement reserve: 16 slots / 4 MiB (reserved for `Terminal acceptance`,
 *   lock renewal/release, and durability flushes)
 * - Normal/background limit: 48 requests / 12 MiB
 * - Passive WAL checkpoint at 1,000 pages or 30,000 ms
 * - Escalated `RESTART` / `TRUNCATE` checkpoint at 64 MiB when readers are idle
 * - Background write pause at 128 MiB WAL size while preserving settlement lane
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  SQLITE_WAL_ESCALATION_BYTES,
  SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS,
  SQLITE_WAL_PASSIVE_CHECKPOINT_PAGES,
  SQLITE_WAL_PAUSE_BACKGROUND_BYTES,
  SQLITE_WRITER_MAX_QUEUE_BYTES,
  SQLITE_WRITER_MAX_QUEUE_REQUESTS,
  SQLITE_WRITER_NORMAL_MAX_BYTES,
  SQLITE_WRITER_NORMAL_MAX_REQUESTS,
  type WriterPriorityLane
} from '../../contracts/sqlite-store/schema-types';
import type { BoundedReadConnectionPool, NodeSqliteConnection } from './sqlite-driver';

export type WalCheckpointMode = 'PASSIVE' | 'RESTART' | 'TRUNCATE';

export interface WalCheckpointRecord {
  readonly mode: WalCheckpointMode;
  readonly triggeredBy: 'pages_threshold' | 'interval_threshold' | 'size_escalation' | 'manual';
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
  readonly timestampMs: number;
}

export type WriterAdmissionResult =
  | {
      readonly admitted: true;
      readonly lane: WriterPriorityLane;
      readonly queueDepthAfterAdmit: number;
      readonly queuedBytesAfterAdmit: number;
      readonly release: () => void;
    }
  | {
      readonly admitted: false;
      readonly code: 'QUEUE_SATURATED' | 'WAL_BACKGROUND_PAUSED';
      readonly message: string;
      readonly currentDepth: number;
      readonly currentBytes: number;
    };

export class WriterCoordinator {
  private readonly conn: NodeSqliteConnection;
  private readonly readPool: BoundedReadConnectionPool;
  private readonly nowMs: () => number;

  private activeDepth = 0;
  private activeBytes = 0;
  private accumulatedWalPages = 0;
  private simulatedWalBytes = 0;
  private lastCheckpointAtMs: number;
  private readonly checkpointHistory: WalCheckpointRecord[] = [];

  public constructor(
    conn: NodeSqliteConnection,
    readPool: BoundedReadConnectionPool,
    nowMs: () => number = () => Date.now()
  ) {
    this.conn = conn;
    this.readPool = readPool;
    this.nowMs = nowMs;
    this.lastCheckpointAtMs = this.nowMs();
  }

  public getQueueMetrics(): {
    readonly activeDepth: number;
    readonly activeBytes: number;
    readonly accumulatedWalPages: number;
    readonly simulatedWalBytes: number;
    readonly lastCheckpointAtMs: number;
    readonly checkpointCount: number;
  } {
    return {
      activeDepth: this.activeDepth,
      activeBytes: this.activeBytes,
      accumulatedWalPages: this.accumulatedWalPages,
      simulatedWalBytes: this.simulatedWalBytes,
      lastCheckpointAtMs: this.lastCheckpointAtMs,
      checkpointCount: this.checkpointHistory.length
    };
  }

  public getCheckpointHistory(): readonly WalCheckpointRecord[] {
    return this.checkpointHistory;
  }

  /**
   * Test and runtime hook to report current WAL state (pages and byte size).
   */
  public recordWalGrowth(addedPages: number, currentWalBytes: number): void {
    this.accumulatedWalPages += Math.max(0, addedPages);
    this.simulatedWalBytes = Math.max(0, currentWalBytes);
  }

  /**
   * Evaluates queue admission against the 64-request / 16 MiB hard cap and
   * 16-slot / 4 MiB settlement reserve (FR-005, FR-007).
   */
  public tryAdmitWrite(lane: WriterPriorityLane, payloadBytes: number): WriterAdmissionResult {
    const normalizedBytes = Math.max(0, payloadBytes);

    if (lane === 'background' && this.simulatedWalBytes >= SQLITE_WAL_PAUSE_BACKGROUND_BYTES) {
      return {
        admitted: false,
        code: 'WAL_BACKGROUND_PAUSED',
        message: `Background write paused because WAL size (${this.simulatedWalBytes} B) reached 128 MiB ceiling`,
        currentDepth: this.activeDepth,
        currentBytes: this.activeBytes
      };
    }

    const maxRequests =
      lane === 'settlement' ? SQLITE_WRITER_MAX_QUEUE_REQUESTS : SQLITE_WRITER_NORMAL_MAX_REQUESTS;
    const maxBytes =
      lane === 'settlement' ? SQLITE_WRITER_MAX_QUEUE_BYTES : SQLITE_WRITER_NORMAL_MAX_BYTES;

    if (
      this.activeDepth + 1 > maxRequests ||
      this.activeBytes + normalizedBytes > maxBytes
    ) {
      return {
        admitted: false,
        code: 'QUEUE_SATURATED',
        message:
          `Writer queue saturated for lane '${lane}' ` +
          `(depth=${this.activeDepth}/${maxRequests}, bytes=${this.activeBytes + normalizedBytes}/${maxBytes})`,
        currentDepth: this.activeDepth,
        currentBytes: this.activeBytes
      };
    }

    this.activeDepth += 1;
    this.activeBytes += normalizedBytes;
    let released = false;

    return {
      admitted: true,
      lane,
      queueDepthAfterAdmit: this.activeDepth,
      queuedBytesAfterAdmit: this.activeBytes,
      release: () => {
        if (released) return;
        released = true;
        this.activeDepth = Math.max(0, this.activeDepth - 1);
        this.activeBytes = Math.max(0, this.activeBytes - normalizedBytes);
      }
    };
  }

  /**
   * Executes a synchronous write callback under admission control and evaluates
   * WAL checkpoint policies after commit.
   */
  public executeSerializedWrite<T>(
    lane: WriterPriorityLane,
    payloadBytes: number,
    estimatedWalPages: number,
    fn: (conn: NodeSqliteConnection) => T
  ):
    | { readonly admitted: true; readonly result: T }
    | { readonly admitted: false; readonly code: 'QUEUE_SATURATED' | 'WAL_BACKGROUND_PAUSED'; readonly message: string } {
    const admission = this.tryAdmitWrite(lane, payloadBytes);
    if (!admission.admitted) {
      return admission;
    }

    try {
      const result = fn(this.conn);
      this.accumulatedWalPages += Math.max(1, estimatedWalPages);
      this.evaluateCheckpointPolicy();
      return { admitted: true, result };
    } finally {
      admission.release();
    }
  }

  public evaluateCheckpointPolicy(): WalCheckpointRecord | null {
    const now = this.nowMs();
    const readersIdle = this.readPool.getActiveLeaseCount() === 0;

    if (this.simulatedWalBytes >= SQLITE_WAL_ESCALATION_BYTES && readersIdle) {
      return this.runCheckpoint('TRUNCATE', 'size_escalation', now);
    }

    if (this.accumulatedWalPages >= SQLITE_WAL_PASSIVE_CHECKPOINT_PAGES) {
      return this.runCheckpoint('PASSIVE', 'pages_threshold', now);
    }

    if (now - this.lastCheckpointAtMs >= SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS && this.accumulatedWalPages > 0) {
      return this.runCheckpoint('PASSIVE', 'interval_threshold', now);
    }

    return null;
  }

  public runCheckpoint(
    mode: WalCheckpointMode,
    triggeredBy: WalCheckpointRecord['triggeredBy'] = 'manual',
    timestampMs: number = this.nowMs()
  ): WalCheckpointRecord {
    const row = this.conn.get<{ busy: number; log: number; checkpointed: number }>(
      `PRAGMA wal_checkpoint(${mode})`
    );
    const record: WalCheckpointRecord = {
      mode,
      triggeredBy,
      busy: Number(row?.busy ?? 0),
      logFrames: Number(row?.log ?? 0),
      checkpointedFrames: Number(row?.checkpointed ?? 0),
      timestampMs
    };
    this.checkpointHistory.push(record);
    this.lastCheckpointAtMs = timestampMs;
    this.accumulatedWalPages = 0;
    if (mode === 'TRUNCATE' || mode === 'RESTART') {
      this.simulatedWalBytes = 0;
    }
    return record;
  }
}
