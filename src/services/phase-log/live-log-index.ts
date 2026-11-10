/**
 * FR-R6-F07 (FR-018, research R9) — the live-log segment index over migration 4.
 *
 * It records, per stream, the current source generation, the byte ranges of segments and the
 * ranges that cannot be shown, so a restart can say what is readable and what is not.
 *
 * PROMISES:
 *   - A segment is inserted unverified (`durable = 0`). It becomes readable only when the
 *     caller finalizes it with a verified file size at least its end offset.
 *   - A restart replay never lists an unverified segment as readable; it lists it apart.
 *   - With capture disabled no segment is kept, and a restart replay reports one
 *     `capture-disabled` range.
 *   - Reading changes no row and never changes a capture setting.
 *   - Refusals are values, never throws, so a caller can count them.
 *
 * The F04 store is not opened in production before the F01-B cutover, so no production code
 * constructs this yet (spec Assumptions); it is qualified against an in-memory store.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash, randomUUID } from 'node:crypto';
import { LIVE_LOG_COVERAGE_REASONS, type LiveLogCoverageReason } from '../../contracts/phase-log-bounds';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from '../usage-accounting/accounting-transaction';
import { LIVE_LOG_CAPTURE_MODES, type LiveLogCaptureMode } from './live-log-index-schema';

/** Longest stream key, generation and artifact reference accepted; the table CHECKs match. */
export const LIVE_LOG_STREAM_KEY_MAX_LENGTH = 512;
export const LIVE_LOG_GENERATION_MAX_LENGTH = 256;
export const LIVE_LOG_ARTIFACT_REF_MAX_LENGTH = 1024;

/** Most segments, and most coverage rows, one restart replay returns. */
export const LIVE_LOG_REPLAY_MAX_ROWS = 1024;

export type LiveLogIndexRefusal =
  | 'invalid'
  | 'conflict'
  | 'unknown-stream'
  | 'stale-generation'
  | 'capture-disabled'
  | 'unknown-segment'
  | 'extent-unverified';

export interface LiveLogIndexRefused {
  readonly outcome: 'refused';
  readonly reason: LiveLogIndexRefusal;
}

export interface OpenStreamInput {
  readonly streamKey: string;
  readonly generation: string;
  readonly captureMode: LiveLogCaptureMode;
  readonly nowMs: number;
}

export interface AppendSegmentInput {
  readonly streamKey: string;
  readonly generation: string;
  readonly segmentSeq: number;
  readonly artifactRef: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly recordCount: number;
}

export interface FinalizeSegmentInput {
  readonly streamKey: string;
  readonly generation: string;
  readonly segmentSeq: number;
  readonly verifiedSize: number;
}

export interface RecordCoverageInput {
  readonly streamKey: string;
  readonly generation: string;
  readonly reason: LiveLogCoverageReason;
  readonly fromOffset: number;
  readonly toOffset: number | null;
  readonly count: number;
  readonly nowMs: number;
}

export interface LiveLogSegmentExtent {
  readonly segmentSeq: number;
  readonly artifactRef: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly recordCount: number;
}

export interface LiveLogUnavailableRange {
  readonly generation: string;
  readonly reason: LiveLogCoverageReason;
  readonly fromOffset: number;
  /** `null` when the end is unknown, as for a stream whose capture is off. */
  readonly toOffset: number | null;
  readonly count: number;
}

export interface LiveLogRestartReplay {
  readonly generation: string;
  readonly captureMode: LiveLogCaptureMode;
  /** Finalized segments of the current generation, in segment order. */
  readonly readable: readonly LiveLogSegmentExtent[];
  /** Segments of the current generation never finalized: their bytes are not promised. */
  readonly unverified: readonly LiveLogSegmentExtent[];
  readonly unavailable: readonly LiveLogUnavailableRange[];
  /** True when a list was cut at `LIVE_LOG_REPLAY_MAX_ROWS`. */
  readonly truncated: boolean;
}

export interface LiveLogIndex {
  openStream(input: OpenStreamInput): { readonly outcome: 'opened' | 'unchanged' | 'replaced' } | LiveLogIndexRefused;
  appendSegment(input: AppendSegmentInput): { readonly outcome: 'appended' | 'unchanged' } | LiveLogIndexRefused;
  finalizeSegment(input: FinalizeSegmentInput): { readonly outcome: 'finalized' } | LiveLogIndexRefused;
  recordCoverage(input: RecordCoverageInput): { readonly outcome: 'recorded' } | LiveLogIndexRefused;
  /** What a restart can show for `streamKey`; `null` for a stream never opened. Read-only. */
  restartReplay(input: { readonly streamKey: string }): LiveLogRestartReplay | null;
}

interface StreamRow {
  readonly generation: string;
  readonly capture_mode: LiveLogCaptureMode;
}

interface SegmentRow {
  readonly segment_seq: number;
  readonly artifact_ref: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly record_count: number;
  readonly durable: number;
}

interface CoverageRow {
  readonly generation: string;
  readonly reason: LiveLogCoverageReason;
  readonly from_offset: number;
  readonly to_offset: number | null;
  readonly count: number;
}

const CAPTURE_MODES: ReadonlySet<string> = new Set(LIVE_LOG_CAPTURE_MODES);
const COVERAGE_REASONS: ReadonlySet<string> = new Set(LIVE_LOG_COVERAGE_REASONS);

function refused(reason: LiveLogIndexRefusal): LiveLogIndexRefused {
  return { outcome: 'refused', reason };
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStreamKey(value: unknown): value is string {
  return isText(value, LIVE_LOG_STREAM_KEY_MAX_LENGTH);
}

function isGeneration(value: unknown): value is string {
  return isText(value, LIVE_LOG_GENERATION_MAX_LENGTH);
}

function segmentId(streamKey: string, generation: string, segmentSeq: number): string {
  return createHash('sha256').update(JSON.stringify([streamKey, generation, segmentSeq])).digest('hex');
}

function toExtent(row: SegmentRow): LiveLogSegmentExtent {
  return {
    segmentSeq: row.segment_seq,
    artifactRef: row.artifact_ref,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    recordCount: row.record_count
  };
}

function toRange(row: CoverageRow): LiveLogUnavailableRange {
  return {
    generation: row.generation,
    reason: row.reason,
    fromOffset: row.from_offset,
    toOffset: row.to_offset,
    count: row.count
  };
}

function validAppend(input: AppendSegmentInput): boolean {
  return (
    isStreamKey(input.streamKey) &&
    isGeneration(input.generation) &&
    isCount(input.segmentSeq) &&
    isText(input.artifactRef, LIVE_LOG_ARTIFACT_REF_MAX_LENGTH) &&
    isCount(input.startOffset) &&
    isCount(input.endOffset) &&
    input.endOffset >= input.startOffset &&
    isCount(input.recordCount)
  );
}

function validCoverage(input: RecordCoverageInput): boolean {
  const toOffsetValid = input.toOffset === null || (isCount(input.toOffset) && input.toOffset >= input.fromOffset);
  return (
    isStreamKey(input.streamKey) &&
    isGeneration(input.generation) &&
    typeof input.reason === 'string' &&
    COVERAGE_REASONS.has(input.reason) &&
    isCount(input.fromOffset) &&
    toOffsetValid &&
    isCount(input.count) &&
    Number.isSafeInteger(input.nowMs)
  );
}

class SqliteLiveLogIndex implements LiveLogIndex {
  constructor(private readonly conn: NodeSqliteConnection) {}

  openStream(input: OpenStreamInput): ReturnType<LiveLogIndex['openStream']> {
    const valid =
      isStreamKey(input.streamKey) &&
      isGeneration(input.generation) &&
      CAPTURE_MODES.has(input.captureMode) &&
      Number.isSafeInteger(input.nowMs);
    if (!valid) return refused('invalid');
    return inImmediateTransaction(this.conn, () => {
      const current = this.stream(input.streamKey);
      if (current === undefined) {
        this.conn.run(
          `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
          input.streamKey,
          input.generation,
          input.captureMode,
          input.nowMs,
          input.nowMs
        );
        return { outcome: 'opened' } as const;
      }
      if (current.generation === input.generation) {
        return current.capture_mode === input.captureMode ? ({ outcome: 'unchanged' } as const) : refused('conflict');
      }
      this.recordReplaced(input.streamKey, current.generation, input.nowMs);
      this.conn.run(
        `UPDATE live_log_streams SET generation = ?, capture_mode = ?, updated_at_ms = ? WHERE stream_key = ?`,
        input.generation,
        input.captureMode,
        input.nowMs,
        input.streamKey
      );
      return { outcome: 'replaced' } as const;
    });
  }

  appendSegment(input: AppendSegmentInput): ReturnType<LiveLogIndex['appendSegment']> {
    if (!validAppend(input)) return refused('invalid');
    return inImmediateTransaction(this.conn, () => {
      const current = this.stream(input.streamKey);
      if (current === undefined) return refused('unknown-stream');
      if (current.generation !== input.generation) return refused('stale-generation');
      if (current.capture_mode === 'disabled') return refused('capture-disabled');
      const existing = this.segment(input.streamKey, input.generation, input.segmentSeq);
      if (existing !== undefined) {
        const same =
          existing.artifact_ref === input.artifactRef &&
          existing.start_offset === input.startOffset &&
          existing.end_offset === input.endOffset &&
          existing.record_count === input.recordCount;
        return same ? ({ outcome: 'unchanged' } as const) : refused('conflict');
      }
      this.conn.run(
        `INSERT INTO live_log_segments
           (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        segmentId(input.streamKey, input.generation, input.segmentSeq),
        input.streamKey,
        input.generation,
        input.segmentSeq,
        input.artifactRef,
        input.startOffset,
        input.endOffset,
        input.recordCount
      );
      return { outcome: 'appended' } as const;
    });
  }

  finalizeSegment(input: FinalizeSegmentInput): ReturnType<LiveLogIndex['finalizeSegment']> {
    const valid =
      isStreamKey(input.streamKey) &&
      isGeneration(input.generation) &&
      isCount(input.segmentSeq) &&
      isCount(input.verifiedSize);
    if (!valid) return refused('invalid');
    return inImmediateTransaction(this.conn, () => {
      const existing = this.segment(input.streamKey, input.generation, input.segmentSeq);
      if (existing === undefined) return refused('unknown-segment');
      if (input.verifiedSize < existing.end_offset) return refused('extent-unverified');
      this.conn.run(
        `UPDATE live_log_segments SET durable = 1 WHERE stream_key = ? AND generation = ? AND segment_seq = ?`,
        input.streamKey,
        input.generation,
        input.segmentSeq
      );
      return { outcome: 'finalized' } as const;
    });
  }

  recordCoverage(input: RecordCoverageInput): ReturnType<LiveLogIndex['recordCoverage']> {
    if (!validCoverage(input)) return refused('invalid');
    return inImmediateTransaction(this.conn, () => {
      if (this.stream(input.streamKey) === undefined) return refused('unknown-stream');
      this.insertCoverage(input);
      return { outcome: 'recorded' } as const;
    });
  }

  restartReplay(input: { readonly streamKey: string }): LiveLogRestartReplay | null {
    if (!isStreamKey(input.streamKey)) return null;
    const current = this.stream(input.streamKey);
    if (current === undefined) return null;
    if (current.capture_mode === 'disabled') {
      const range: LiveLogUnavailableRange = {
        generation: current.generation,
        reason: 'capture-disabled',
        fromOffset: 0,
        toOffset: null,
        count: 1
      };
      return {
        generation: current.generation,
        captureMode: 'disabled',
        readable: [],
        unverified: [],
        unavailable: [range],
        truncated: false
      };
    }
    const segments = this.conn.all<SegmentRow>(
      `SELECT segment_seq, artifact_ref, start_offset, end_offset, record_count, durable
       FROM live_log_segments WHERE stream_key = ? AND generation = ?
       ORDER BY segment_seq ASC LIMIT ?`,
      input.streamKey,
      current.generation,
      LIVE_LOG_REPLAY_MAX_ROWS + 1
    );
    const coverage = this.conn.all<CoverageRow>(
      `SELECT generation, reason, from_offset, to_offset, count
       FROM live_log_coverage WHERE stream_key = ?
       ORDER BY recorded_at_ms ASC, rowid ASC LIMIT ?`,
      input.streamKey,
      LIVE_LOG_REPLAY_MAX_ROWS + 1
    );
    const keptSegments = segments.slice(0, LIVE_LOG_REPLAY_MAX_ROWS);
    return {
      generation: current.generation,
      captureMode: 'captured',
      readable: keptSegments.filter((row) => row.durable === 1).map(toExtent),
      unverified: keptSegments.filter((row) => row.durable !== 1).map(toExtent),
      unavailable: coverage.slice(0, LIVE_LOG_REPLAY_MAX_ROWS).map(toRange),
      truncated: segments.length > LIVE_LOG_REPLAY_MAX_ROWS || coverage.length > LIVE_LOG_REPLAY_MAX_ROWS
    };
  }

  /** One `source-replaced` range covering what the old generation's segments claimed. */
  private recordReplaced(streamKey: string, oldGeneration: string, nowMs: number): void {
    const extent = this.conn.get<{ end: number | null }>(
      `SELECT MAX(end_offset) AS end FROM live_log_segments WHERE stream_key = ? AND generation = ?`,
      streamKey,
      oldGeneration
    );
    this.insertCoverage({
      streamKey,
      generation: oldGeneration,
      reason: 'source-replaced',
      fromOffset: 0,
      toOffset: extent?.end ?? null,
      count: 1,
      nowMs
    });
  }

  private insertCoverage(input: RecordCoverageInput): void {
    this.conn.run(
      `INSERT INTO live_log_coverage
         (coverage_id, stream_key, generation, reason, from_offset, to_offset, count, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.streamKey,
      input.generation,
      input.reason,
      input.fromOffset,
      input.toOffset,
      input.count,
      input.nowMs
    );
  }

  private stream(streamKey: string): StreamRow | undefined {
    return this.conn.get<StreamRow>(
      `SELECT generation, capture_mode FROM live_log_streams WHERE stream_key = ?`,
      streamKey
    );
  }

  private segment(streamKey: string, generation: string, segmentSeq: number): SegmentRow | undefined {
    return this.conn.get<SegmentRow>(
      `SELECT segment_seq, artifact_ref, start_offset, end_offset, record_count, durable
       FROM live_log_segments WHERE stream_key = ? AND generation = ? AND segment_seq = ?`,
      streamKey,
      generation,
      segmentSeq
    );
  }
}

/** The segment index over a migrated connection (schema version 4 or later). */
export function createLiveLogIndex(conn: NodeSqliteConnection): LiveLogIndex {
  return new SqliteLiveLogIndex(conn);
}
