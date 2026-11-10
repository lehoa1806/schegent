// FR-R6-F07 T039 (FR-018, F07-AC-08 index half) — the live-log segment index in
// SQLite migration 4.
//
// WHAT THIS PINS:
//   - migration 4 applies after 1 to 3 and creates three STRICT tables whose
//     CHECK lists still equal the contract constants;
//   - no column can hold log content: every column is a key, an offset, a count,
//     a time, a reason or a reference;
//   - a segment is never readable before it is finalized against a verified
//     size, and a short size is refused `extent-unverified`;
//   - a duplicate segment with other extents is refused `conflict`;
//   - a new source generation records one `source-replaced` range for the old one;
//   - with capture disabled, restart replay reports one `capture-disabled` range
//     and never a segment, and reading changes no row.

import { describe, expect, it } from 'vitest';
import { LIVE_LOG_COVERAGE_REASONS } from '../../../../src/contracts/phase-log-bounds';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../../../src/contracts/sqlite-store/schema-types';
import { STRUCTURED_STATE_CENSUS } from '../../../../src/contracts/sqlite-store/state-census';
import {
  LIVE_LOG_CAPTURE_MODES,
  F07_LIVE_LOG_MIGRATION_NAME,
  F07_LIVE_LOG_MIGRATION_VERSION,
  F07_LIVE_LOG_TABLE_NAMES
} from '../../../../src/services/phase-log/live-log-index-schema';
import { createLiveLogIndex, type LiveLogIndex } from '../../../../src/services/phase-log/live-log-index';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const STREAM = 'workspace-a/run-1/implement/1';

/** Every column the three tables may have; none of them is log content. */
const ALLOWED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  live_log_streams: ['stream_key', 'generation', 'capture_mode', 'created_at_ms', 'updated_at_ms'],
  live_log_segments: [
    'segment_id',
    'stream_key',
    'generation',
    'segment_seq',
    'artifact_ref',
    'start_offset',
    'end_offset',
    'record_count',
    'durable'
  ],
  live_log_coverage: [
    'coverage_id',
    'stream_key',
    'generation',
    'reason',
    'from_offset',
    'to_offset',
    'count',
    'recorded_at_ms'
  ]
});

function openMigrated(): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  return conn;
}

function withIndex(body: (index: LiveLogIndex, conn: NodeSqliteConnection) => void): void {
  const conn = openMigrated();
  try {
    body(createLiveLogIndex(conn), conn);
  } finally {
    conn.close();
  }
}

function tableSql(conn: NodeSqliteConnection, name: string): string {
  const row = conn.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
  return row?.sql ?? '';
}

/** The quoted values of the first `<column> IN (...)` list in `sql`. */
function checkList(sql: string, column: string): readonly string[] {
  const start = sql.indexOf(`${column} IN (`);
  expect(start, `CHECK list for ${column}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(')', start);
  return [...sql.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match.at(1) ?? '');
}

function segment(segmentSeq: number, startOffset: number, endOffset: number, generation = 'gen-1') {
  return {
    streamKey: STREAM,
    generation,
    segmentSeq,
    artifactRef: `phase-logs/implement-1.jsonl#${segmentSeq}`,
    startOffset,
    endOffset,
    recordCount: 3
  };
}

describe('FR-R6-F07 T039 — migration 4, the live-log segment index (FR-018)', () => {
  it('is registered as version 4 and applies after 1 to 3 on a fresh store', () => {
    expect(F07_LIVE_LOG_MIGRATION_VERSION).toBe(4);
    expect(F07_LIVE_LOG_MIGRATION_NAME).toBe('004_f07_live_log_index');
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBeGreaterThanOrEqual(F07_LIVE_LOG_MIGRATION_VERSION);
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(result.schemaVersion).toBe(7);
      expect(result.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      conn.close();
    }
  });

  it('upgrades a version 3 store by applying migration 4 and the later ones', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const upToThree = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 3);
      expect(SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, upToThree).appliedMigrations).toEqual([
        1, 2, 3
      ]);
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([4, 5, 6, 7]);
      expect(result.schemaVersion).toBe(7);
    } finally {
      conn.close();
    }
  });

  it('creates three STRICT tables whose CHECK lists equal the contract constants', () => {
    const conn = openMigrated();
    try {
      expect([...F07_LIVE_LOG_TABLE_NAMES]).toEqual(['live_log_streams', 'live_log_segments', 'live_log_coverage']);
      for (const name of F07_LIVE_LOG_TABLE_NAMES) {
        expect(tableSql(conn, name), name).toMatch(/\)\s*STRICT$/);
      }
      expect(checkList(tableSql(conn, 'live_log_streams'), 'capture_mode')).toEqual([...LIVE_LOG_CAPTURE_MODES]);
      expect(checkList(tableSql(conn, 'live_log_coverage'), 'reason')).toEqual([...LIVE_LOG_COVERAGE_REASONS]);
    } finally {
      conn.close();
    }
  });

  it('has no column that can hold log content', () => {
    const conn = openMigrated();
    try {
      for (const name of F07_LIVE_LOG_TABLE_NAMES) {
        const columns = conn.all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, name).map((c) => c.name);
        expect(columns, name).toEqual(ALLOWED_COLUMNS[name]);
      }
    } finally {
      conn.close();
    }
  });

  it('retargets the log-segment-index census row to the three tables', () => {
    const row = STRUCTURED_STATE_CENSUS.find((entry) => entry.surfaceId === 'log-segment-index');
    expect(row?.targetTables).toStrictEqual([...F07_LIVE_LOG_TABLE_NAMES]);
    expect(row?.owningFeature).toBe('F07');
  });
});

describe('FR-R6-F07 T039 — the index never promises bytes it has not verified (FR-018)', () => {
  it('opens a stream idempotently', () => {
    withIndex((index) => {
      const open = { streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW } as const;
      expect(index.openStream(open)).toEqual({ outcome: 'opened' });
      expect(index.openStream({ ...open, nowMs: NOW + 5 })).toEqual({ outcome: 'unchanged' });
      expect(index.openStream({ ...open, captureMode: 'disabled' })).toEqual({ outcome: 'refused', reason: 'conflict' });
    });
  });

  it('never returns a segment as readable before it is finalized', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      expect(index.appendSegment(segment(0, 0, 100))).toEqual({ outcome: 'appended' });
      expect(index.appendSegment(segment(1, 100, 250))).toEqual({ outcome: 'appended' });
      expect(index.restartReplay({ streamKey: STREAM })?.readable).toEqual([]);

      expect(index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: 100 })).toEqual({
        outcome: 'finalized'
      });
      const replay = index.restartReplay({ streamKey: STREAM });
      expect(replay?.readable.map((s) => [s.segmentSeq, s.startOffset, s.endOffset])).toEqual([[0, 0, 100]]);
      expect(replay?.unverified.map((s) => s.segmentSeq)).toEqual([1]);
    });
  });

  it('refuses to finalize a segment whose verified size is short of its end', () => {
    withIndex((index, conn) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      index.appendSegment(segment(0, 0, 100));
      expect(index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: 99 })).toEqual({
        outcome: 'refused',
        reason: 'extent-unverified'
      });
      const durable = conn.get<{ durable: number }>(`SELECT durable FROM live_log_segments`);
      expect(durable?.durable).toBe(0);
      expect(index.restartReplay({ streamKey: STREAM })?.readable).toEqual([]);
      expect(index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 7, verifiedSize: 999 })).toEqual({
        outcome: 'refused',
        reason: 'unknown-segment'
      });
    });
  });

  it('accepts a repeated segment with the same extents and refuses one with other extents', () => {
    withIndex((index, conn) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      expect(index.appendSegment(segment(0, 0, 100))).toEqual({ outcome: 'appended' });
      expect(index.appendSegment(segment(0, 0, 100))).toEqual({ outcome: 'unchanged' });
      expect(index.appendSegment(segment(0, 0, 120))).toEqual({ outcome: 'refused', reason: 'conflict' });
      expect(index.appendSegment({ ...segment(0, 0, 100), recordCount: 4 })).toEqual({
        outcome: 'refused',
        reason: 'conflict'
      });
      const rows = conn.get<{ n: number }>(`SELECT COUNT(*) AS n FROM live_log_segments`);
      expect(rows?.n).toBe(1);
    });
  });

  it('refuses segments for an unknown stream, a stale generation or invalid extents', () => {
    withIndex((index) => {
      expect(index.appendSegment(segment(0, 0, 100))).toEqual({ outcome: 'refused', reason: 'unknown-stream' });
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      expect(index.appendSegment(segment(0, 0, 100, 'gen-0'))).toEqual({ outcome: 'refused', reason: 'stale-generation' });
      expect(index.appendSegment(segment(0, 100, 50))).toEqual({ outcome: 'refused', reason: 'invalid' });
      expect(index.appendSegment(segment(-1, 0, 50))).toEqual({ outcome: 'refused', reason: 'invalid' });
      expect(index.appendSegment({ ...segment(0, 0, 50), artifactRef: '' })).toEqual({ outcome: 'refused', reason: 'invalid' });
    });
  });

  it('records one source-replaced range for the old generation when a new one opens', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      index.appendSegment(segment(0, 0, 100));
      index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: 100 });
      expect(index.openStream({ streamKey: STREAM, generation: 'gen-2', captureMode: 'captured', nowMs: NOW + 10 })).toEqual({
        outcome: 'replaced'
      });

      const replay = index.restartReplay({ streamKey: STREAM });
      expect(replay?.generation).toBe('gen-2');
      // The old generation's bytes are not the new file's: nothing is readable yet.
      expect(replay?.readable).toEqual([]);
      expect(replay?.unavailable).toEqual([
        { generation: 'gen-1', reason: 'source-replaced', fromOffset: 0, toOffset: 100, count: 1 }
      ]);
    });
  });

  it('keeps coverage rows and reports them on restart replay', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      expect(
        index.recordCoverage({
          streamKey: STREAM,
          generation: 'gen-1',
          reason: 'oversized-record',
          fromOffset: 40,
          toOffset: 90,
          count: 1,
          nowMs: NOW + 1
        })
      ).toEqual({ outcome: 'recorded' });
      expect(
        index.recordCoverage({
          streamKey: STREAM,
          generation: 'gen-1',
          reason: 'not-a-reason' as never,
          fromOffset: 0,
          toOffset: 1,
          count: 1,
          nowMs: NOW
        })
      ).toEqual({ outcome: 'refused', reason: 'invalid' });
      expect(index.restartReplay({ streamKey: STREAM })?.unavailable).toEqual([
        { generation: 'gen-1', reason: 'oversized-record', fromOffset: 40, toOffset: 90, count: 1 }
      ]);
    });
  });

  it('with capture disabled reports one capture-disabled range, never a segment, and reading changes no row', () => {
    withIndex((index, conn) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'disabled', nowMs: NOW });
      expect(index.appendSegment(segment(0, 0, 100))).toEqual({ outcome: 'refused', reason: 'capture-disabled' });

      const before = conn.get<{ changes: number }>(`SELECT total_changes() AS changes`)?.changes;
      const replay = index.restartReplay({ streamKey: STREAM });
      const again = index.restartReplay({ streamKey: STREAM });
      const after = conn.get<{ changes: number }>(`SELECT total_changes() AS changes`)?.changes;

      expect(replay?.captureMode).toBe('disabled');
      expect(replay?.readable).toEqual([]);
      expect(replay?.unverified).toEqual([]);
      expect(replay?.unavailable).toEqual([
        { generation: 'gen-1', reason: 'capture-disabled', fromOffset: 0, toOffset: null, count: 1 }
      ]);
      expect(again).toEqual(replay);
      expect(after).toBe(before);
      const mode = conn.get<{ capture_mode: string }>(`SELECT capture_mode FROM live_log_streams WHERE stream_key = ?`, STREAM);
      expect(mode?.capture_mode).toBe('disabled');
    });
  });

  it('returns null for a stream it has never seen', () => {
    withIndex((index) => {
      expect(index.restartReplay({ streamKey: 'never-opened' })).toBeNull();
    });
  });
});
