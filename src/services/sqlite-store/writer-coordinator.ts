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

import { lstatSync } from 'node:fs';
import {
  SQLITE_WAL_ESCALATION_BYTES,
  SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS,
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
  private walBytes: number | null = 0;
  private pressure: 'normal' | 'elevated' | 'paused' | 'unknown' = 'normal';
  private nextEscalationAtMs = 0;
  private checkpointCount = 0;
  private lastCheckpointAtMs: number;
  private readonly checkpointHistory: WalCheckpointRecord[] = [];

  public constructor(
    conn: NodeSqliteConnection,
    readPool: BoundedReadConnectionPool,
    nowMs: () => number = () => Date.now(),
    private readonly onHealth?: (message: string, fields: Record<string, unknown>) => void
  ) {
    this.conn = conn;
    this.readPool = readPool;
    this.nowMs = nowMs;
    this.lastCheckpointAtMs = this.nowMs();
  }

  public getQueueMetrics() {
    this.measureWal();
    return {
      activeDepth: this.activeDepth,
      activeBytes: this.activeBytes,
      walBytes: this.walBytes,
      pressure: this.pressure,
      lastCheckpoint: this.checkpointHistory.at(-1),
      lastCheckpointAtMs: this.lastCheckpointAtMs,
      checkpointCount: this.checkpointCount
    };
  }

  public getCheckpointHistory(): readonly WalCheckpointRecord[] {
    return this.checkpointHistory;
  }

  private reportHealth(message: string, fields: Record<string, unknown>): void {
    try {
      this.onHealth?.(message, fields);
    } catch {
      // A diagnostic sink cannot change a completed commit or a lane's admission.
    }
  }

  private measureWal(): void {
    let bytes: number | null = 0;
    if (this.conn.verifiedPragmas.journalMode === 'wal') {
      try {
        const stat = lstatSync(this.conn.databasePath + '-wal', { throwIfNoEntry: false });
        if (stat) bytes = stat.isFile() ? stat.size : null;
      } catch {
        bytes = null;
      }
    }
    this.walBytes = bytes;
    const pressure = bytes === null ? 'unknown' : bytes >= SQLITE_WAL_PAUSE_BACKGROUND_BYTES
      ? 'paused' : bytes >= SQLITE_WAL_ESCALATION_BYTES ? 'elevated' : 'normal';
    if (pressure !== this.pressure) {
      this.pressure = pressure;
      this.reportHealth('SQLite WAL pressure changed', { pressure, walBytes: bytes });
    }
  }

  /**
   * Evaluates queue admission against the 64-request / 16 MiB hard cap and
   * 16-slot / 4 MiB settlement reserve (FR-005, FR-007).
   */
  public tryAdmitWrite(lane: WriterPriorityLane, payloadBytes: number): WriterAdmissionResult {
    const normalizedBytes = Math.max(0, payloadBytes);

    if (lane === 'background') this.maintainWal(false);
    if (lane === 'background' && (this.pressure === 'paused' || this.pressure === 'unknown')) {
      return {
        admitted: false,
        code: 'WAL_BACKGROUND_PAUSED',
        message: this.walBytes === null ? 'Background write paused because WAL size is unavailable' : 'Background write paused at the 128 MiB WAL ceiling',
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

  /** The caller reports a durable commit after distinguishing it from a replay or refusal. */
  public executeSerializedWrite<T>(
    lane: WriterPriorityLane,
    payloadBytes: number,
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
      return { admitted: true, result };
    } finally {
      admission.release();
    }
  }

  /** Observe successful commits from both operational state and transaction units. */
  public afterCommit(): void {
    this.maintainWal(true);
  }

  private maintainWal(committed: boolean): void {
    if (this.conn.verifiedPragmas.journalMode !== 'wal') return;
    const now = this.nowMs();
    try {
      this.measureWal();
      if (this.walBytes === null || this.walBytes === 0) return;
      if (this.walBytes >= SQLITE_WAL_ESCALATION_BYTES &&
          this.readPool.getActiveLeaseCount() === 0 && now >= this.nextEscalationAtMs) {
        // Other connections (including reporting workers) can hold snapshots outside the pool.
        // A passive checkpoint samples their progress without waiting for them.
        this.nextEscalationAtMs = now + SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS;
        const sampled = this.runCheckpoint('PASSIVE', 'size_escalation', now);
        if (sampled.busy === 0 && sampled.logFrames >= 0 && sampled.logFrames === sampled.checkpointedFrames) {
          // An external reader may still hold the last checkpointed frame. Attempt the
          // exclusive lock once and restore the normal write timeout before returning.
          this.conn.exec('PRAGMA busy_timeout = 0');
          try {
            this.runCheckpoint('TRUNCATE', 'size_escalation', now);
          } finally {
            this.conn.exec(`PRAGMA busy_timeout = ${this.conn.verifiedPragmas.busyTimeoutMs}`);
          }
        }
        this.measureWal();
        this.reportHealth('SQLite WAL checkpoint under pressure', { walBytes: this.walBytes, ...this.checkpointHistory.at(-1) });
      } else if (committed && now - this.lastCheckpointAtMs >= SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS) {
        this.runCheckpoint('PASSIVE', 'interval_threshold', now);
      }
    } catch {
      // Maintenance is best effort. A completed write must never be reported as rolled back.
      this.lastCheckpointAtMs = now;
      this.reportHealth('SQLite WAL checkpoint unavailable', { walBytes: this.walBytes });
    }
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
    this.checkpointCount += 1;
    if (this.checkpointHistory.length >= 32) this.checkpointHistory.shift();
    this.checkpointHistory.push(record);
    this.lastCheckpointAtMs = timestampMs;
    return record;
  }
}
