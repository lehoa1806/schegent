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
import {
  createLiveLogIndex,
  LIVE_LOG_ARTIFACT_REF_MAX_LENGTH,
  LIVE_LOG_REPLAY_MAX_ROWS,
  type LiveLogIndex
} from '../../../../src/services/phase-log/live-log-index';
import { parseContainedArtifactRef } from '../../../../src/services/phase-log/live-log-replay-reader';
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
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(result.schemaVersion).toBe(9);
      expect(result.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
      expect(result.appliedMigrations).toEqual([4, 5, 6, 7, 8, 9]);
      expect(result.schemaVersion).toBe(9);
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

  it('returns out-of-order inserted segments in oldest-first segmentSeq order', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      for (const seq of [5, 1, 3, 0, 2, 4]) {
        expect(index.appendSegment(segment(seq, seq * 10, (seq + 1) * 10))).toEqual({ outcome: 'appended' });
      }
      for (const seq of [4, 0, 2]) {
        expect(
          index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: seq, verifiedSize: 100 })
        ).toEqual({ outcome: 'finalized' });
      }
      const replay = index.restartReplay({ streamKey: STREAM });
      expect(replay?.readable.map((s) => s.segmentSeq)).toEqual([0, 2, 4]);
      expect(replay?.unverified.map((s) => s.segmentSeq)).toEqual([1, 3, 5]);
      expect(replay?.truncated).toBe(false);
    });
  });

  it('enforces exact 1024 and 1025 truncation boundaries for segments, keeping the oldest 1024', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      for (let seq = 0; seq < LIVE_LOG_REPLAY_MAX_ROWS; seq += 1) {
        expect(index.appendSegment(segment(seq, seq * 10, (seq + 1) * 10))).toEqual({ outcome: 'appended' });
        expect(
          index.finalizeSegment({
            streamKey: STREAM,
            generation: 'gen-1',
            segmentSeq: seq,
            verifiedSize: (seq + 1) * 10
          })
        ).toEqual({ outcome: 'finalized' });
      }

      const atCap = index.restartReplay({ streamKey: STREAM });
      expect(atCap?.readable).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
      expect(atCap?.truncated).toBe(false);
      expect(atCap?.readable.at(0)?.segmentSeq).toBe(0);
      expect(atCap?.readable.at(-1)?.segmentSeq).toBe(LIVE_LOG_REPLAY_MAX_ROWS - 1);

      const extraSeq = LIVE_LOG_REPLAY_MAX_ROWS;
      expect(index.appendSegment(segment(extraSeq, extraSeq * 10, (extraSeq + 1) * 10))).toEqual({
        outcome: 'appended'
      });
      expect(
        index.finalizeSegment({
          streamKey: STREAM,
          generation: 'gen-1',
          segmentSeq: extraSeq,
          verifiedSize: (extraSeq + 1) * 10
        })
      ).toEqual({ outcome: 'finalized' });

      const overCap = index.restartReplay({ streamKey: STREAM });
      expect(overCap?.readable).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
      expect(overCap?.truncated).toBe(true);
      expect(overCap?.readable.at(0)?.segmentSeq).toBe(0);
      expect(overCap?.readable.at(-1)?.segmentSeq).toBe(LIVE_LOG_REPLAY_MAX_ROWS - 1);
    });
  });

  it('enforces exact 1024 and 1025 truncation boundaries for coverage rows, keeping the oldest 1024', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      for (let i = 0; i < LIVE_LOG_REPLAY_MAX_ROWS; i += 1) {
        expect(
          index.recordCoverage({
            streamKey: STREAM,
            generation: 'gen-1',
            reason: 'range-skipped',
            fromOffset: i * 10,
            toOffset: (i + 1) * 10,
            count: 1,
            nowMs: NOW + i
          })
        ).toEqual({ outcome: 'recorded' });
      }

      const atCap = index.restartReplay({ streamKey: STREAM });
      expect(atCap?.unavailable).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
      expect(atCap?.truncated).toBe(false);
      expect(atCap?.unavailable.at(0)?.fromOffset).toBe(0);
      expect(atCap?.unavailable.at(-1)?.fromOffset).toBe((LIVE_LOG_REPLAY_MAX_ROWS - 1) * 10);

      expect(
        index.recordCoverage({
          streamKey: STREAM,
          generation: 'gen-1',
          reason: 'range-skipped',
          fromOffset: LIVE_LOG_REPLAY_MAX_ROWS * 10,
          toOffset: (LIVE_LOG_REPLAY_MAX_ROWS + 1) * 10,
          count: 1,
          nowMs: NOW + LIVE_LOG_REPLAY_MAX_ROWS
        })
      ).toEqual({ outcome: 'recorded' });

      const overCap = index.restartReplay({ streamKey: STREAM });
      expect(overCap?.unavailable).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
      expect(overCap?.truncated).toBe(true);
      expect(overCap?.unavailable.at(0)?.fromOffset).toBe(0);
      expect(overCap?.unavailable.at(-1)?.fromOffset).toBe((LIVE_LOG_REPLAY_MAX_ROWS - 1) * 10);
    });
  });

  it('transitions captured gen-1 to disabled gen-2 and returns a single capture-disabled range', () => {
    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      index.appendSegment(segment(0, 0, 100, 'gen-1'));
      index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: 100 });
      index.recordCoverage({
        streamKey: STREAM,
        generation: 'gen-1',
        reason: 'oversized-record',
        fromOffset: 100,
        toOffset: 200,
        count: 1,
        nowMs: NOW + 1
      });

      expect(
        index.openStream({ streamKey: STREAM, generation: 'gen-2', captureMode: 'disabled', nowMs: NOW + 2 })
      ).toEqual({ outcome: 'replaced' });

      const replay = index.restartReplay({ streamKey: STREAM });
      expect(replay).toEqual({
        generation: 'gen-2',
        captureMode: 'disabled',
        readable: [],
        unverified: [],
        unavailable: [{ generation: 'gen-2', reason: 'capture-disabled', fromOffset: 0, toOffset: null, count: 1 }],
        truncated: false
      });
    });
  });

  it('accepts a 1024-char artifactRef and refuses a 1025-char artifactRef', () => {
    const dir = 'a'.repeat(63);
    const segments1024 = Array.from({ length: 15 }, () => dir).join('/') + '/' + 'b'.repeat(64);
    expect(segments1024.length).toBe(LIVE_LOG_ARTIFACT_REF_MAX_LENGTH);
    const segments1025 = `${segments1024}x`;
    expect(segments1025.length).toBe(LIVE_LOG_ARTIFACT_REF_MAX_LENGTH + 1);

    expect(parseContainedArtifactRef(segments1024)).toHaveLength(16);
    expect(parseContainedArtifactRef(segments1025)).toBeNull();

    withIndex((index) => {
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
      expect(index.appendSegment({ ...segment(0, 0, 10), artifactRef: segments1024 })).toEqual({
        outcome: 'appended'
      });
      expect(index.appendSegment({ ...segment(1, 10, 20), artifactRef: segments1025 })).toEqual({
        outcome: 'refused',
        reason: 'invalid'
      });
    });
  });
});

describe('FR-R7-16 (16-09) — parseContainedArtifactRef lexical containment grammar', () => {
  it('accepts valid relative POSIX artifact refs including double-dot-prefixed directory names', () => {
    expect(parseContainedArtifactRef('implement-1.jsonl')).toEqual(['implement-1.jsonl']);
    expect(parseContainedArtifactRef('phase-logs/run-1/implement-1.jsonl')).toEqual([
      'phase-logs',
      'run-1',
      'implement-1.jsonl'
    ]);
    expect(parseContainedArtifactRef('logs/..scratch/segment.jsonl')).toEqual(['logs', '..scratch', 'segment.jsonl']);
  });

  it.each([
    ['empty string', ''],
    ['over 1024 chars', 'a'.repeat(LIVE_LOG_ARTIFACT_REF_MAX_LENGTH + 1)],
    ['parent traversal', '../secret.jsonl'],
    ['nested parent traversal', 'logs/../secret.jsonl'],
    ['bare double dot', '..'],
    ['bare single dot', '.'],
    ['leading dot segment', './logs/a.jsonl'],
    ['interior dot segment', 'logs/./a.jsonl'],
    ['empty double slash segment', 'logs//a.jsonl'],
    ['trailing slash', 'logs/a/'],
    ['POSIX absolute', '/etc/passwd'],
    ['UNC forward slash', '//server/share/a.jsonl'],
    ['Windows drive relative', 'C:foo'],
    ['Windows drive absolute', 'C:/foo/bar.jsonl'],
    ['Windows drive in segment', 'logs/D:bar.jsonl'],
    ['backslash separator', 'logs\\a.jsonl'],
    ['UNC backslash', '\\\\server\\share\\a.jsonl'],
    ['embedded NUL', 'logs/a\0b.jsonl'],
    ['embedded newline', 'logs/a\nb.jsonl'],
    ['embedded CR', 'logs/a\rb.jsonl'],
    ['embedded unit separator', 'logs/a\x1fb.jsonl'],
    ['embedded DEL', 'logs/a\x7fb.jsonl']
  ])('refuses %s lexically', (_label, ref) => {
    expect(parseContainedArtifactRef(ref)).toBeNull();
  });
});
