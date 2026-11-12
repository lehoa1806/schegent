// FR-R6-F07 T041 (F07-AC-08, index half; FR-017, FR-018) — the live-log segment
// index on a file-backed store, across restarts.
//
// Every case uses a real temp directory: a file-backed SQLite store bootstrapped
// through `SchemaBootstrapService` and a real phase-log file written with
// `node:fs`. A restart is the first connection closed without any further call
// and a second connection opened on the same database file. A crash in the
// middle of publishing a segment is a segment appended and its bytes only partly
// written, with no finalize.
//
// WHAT THIS PINS:
//   - after a restart, no readable segment ends past the bytes the file holds;
//     an interrupted segment is listed apart, and it cannot be finalized until
//     its bytes exist;
//   - with capture disabled, a restart replay reports one `capture-disabled`
//     range and no segment, and reading it changes nothing in the store;
//   - a source replaced while the host was down is reported once, and the old
//     generation's segments are never offered for the new file;
//   - an ACP reconnect's `transport-gap` rows, recorded as coverage, survive a
//     restart;
//   - a version 3 store on disk upgrades to version 4 and keeps its rows.

import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../src/lib/logger';
import { initialAcpProjectionState, projectAcpEvents } from '../../src/services/phase-log/acp-live-projection';
import { createLiveLogIndex, type LiveLogIndex } from '../../src/services/phase-log/live-log-index';
import { F07_LIVE_LOG_TABLE_NAMES } from '../../src/services/phase-log/live-log-index-schema';
import { F08_HANDOFF_TABLE_NAMES } from '../../src/services/recovery-handoff/handoff-schema';
import { F10_LANES_TABLE_NAMES } from '../../src/services/execution-lanes/lane-schema';
import { F11_REPORTING_TABLE_NAMES } from '../../src/services/reporting/reporting-schema';
import { R6_INTEGRATION_TABLE_NAMES } from '../../src/services/sqlite-store/round6-integration-schema';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const STREAM = 'workspace-a/run-7/implement/1';
const LOG_NAME = 'implement-1.jsonl';
const RECORDS_PER_SEGMENT = 4;

let workspaceRoot: string;
const opened: NodeSqliteConnection[] = [];

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'f07-live-log-index-'));
});

afterEach(() => {
  for (const conn of opened.splice(0)) if (conn.db.isOpen) conn.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function openStore(migrations = BUILTIN_SCHEMA_MIGRATIONS): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: join(workspaceRoot, 'schegent.db') });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, migrations);
  opened.push(conn);
  return conn;
}

/** Closes `conn` with no further call, then opens the same file again: a restart. */
function restart(conn: NodeSqliteConnection): { conn: NodeSqliteConnection; index: LiveLogIndex } {
  conn.close();
  const next = openStore();
  return { conn: next, index: createLiveLogIndex(next) };
}

function logPath(): string {
  return join(workspaceRoot, LOG_NAME);
}

function records(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `${JSON.stringify({ type: 'assistant', n: from + i })}\n`).join('');
}

function fileSize(): number {
  return statSync(logPath()).size;
}

/** Every row of the three index tables, for an unchanged-store comparison. */
function dump(conn: NodeSqliteConnection): unknown[] {
  return F07_LIVE_LOG_TABLE_NAMES.map((name) => conn.all(`SELECT * FROM ${name} ORDER BY rowid`));
}

describe('FR-R6-F07 T041 — the segment index across restarts (F07-AC-08)', () => {
  it('never offers bytes the file does not hold after a crash in the middle of a segment', () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });

    writeFileSync(logPath(), records(0, RECORDS_PER_SEGMENT));
    const firstEnd = fileSize();
    expect(
      index.appendSegment({
        streamKey: STREAM,
        generation: 'gen-1',
        segmentSeq: 0,
        artifactRef: LOG_NAME,
        startOffset: 0,
        endOffset: firstEnd,
        recordCount: RECORDS_PER_SEGMENT
      })
    ).toEqual({ outcome: 'appended' });
    expect(index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: fileSize() })).toEqual({
      outcome: 'finalized'
    });

    // The second segment is announced, then the host stops with half its bytes written.
    const second = records(RECORDS_PER_SEGMENT, RECORDS_PER_SEGMENT);
    const secondEnd = firstEnd + Buffer.byteLength(second, 'utf8');
    index.appendSegment({
      streamKey: STREAM,
      generation: 'gen-1',
      segmentSeq: 1,
      artifactRef: LOG_NAME,
      startOffset: firstEnd,
      endOffset: secondEnd,
      recordCount: RECORDS_PER_SEGMENT
    });
    appendFileSync(logPath(), second.slice(0, Math.floor(second.length / 2)));

    const after = restart(conn);
    const replay = after.index.restartReplay({ streamKey: STREAM });
    expect(replay?.readable.map((s) => s.segmentSeq)).toEqual([0]);
    expect(replay?.unverified.map((s) => s.segmentSeq)).toEqual([1]);
    for (const segment of replay?.readable ?? []) {
      expect(segment.endOffset).toBeLessThanOrEqual(fileSize());
    }

    // The interrupted segment cannot be finalized against the bytes that exist.
    expect(
      after.index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 1, verifiedSize: fileSize() })
    ).toEqual({ outcome: 'refused', reason: 'extent-unverified' });

    appendFileSync(logPath(), second.slice(Math.floor(second.length / 2)));
    expect(fileSize()).toBe(secondEnd);
    expect(
      after.index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 1, verifiedSize: fileSize() })
    ).toEqual({ outcome: 'finalized' });
    expect(after.index.restartReplay({ streamKey: STREAM })?.readable.map((s) => s.segmentSeq)).toEqual([0, 1]);
  });

  it('with capture disabled reports one capture-disabled range after a restart, and reading changes nothing', () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'disabled', nowMs: NOW });
    // The phase still writes its log; the index keeps none of it.
    writeFileSync(logPath(), records(0, RECORDS_PER_SEGMENT));
    expect(
      index.appendSegment({
        streamKey: STREAM,
        generation: 'gen-1',
        segmentSeq: 0,
        artifactRef: LOG_NAME,
        startOffset: 0,
        endOffset: fileSize(),
        recordCount: RECORDS_PER_SEGMENT
      })
    ).toEqual({ outcome: 'refused', reason: 'capture-disabled' });

    const after = restart(conn);
    const before = dump(after.conn);
    const replay = after.index.restartReplay({ streamKey: STREAM });
    expect(replay).toEqual({
      generation: 'gen-1',
      captureMode: 'disabled',
      readable: [],
      unverified: [],
      unavailable: [{ generation: 'gen-1', reason: 'capture-disabled', fromOffset: 0, toOffset: null, count: 1 }],
      truncated: false
    });
    expect(dump(after.conn)).toEqual(before);
  });

  it('reports a source replaced while the host was down once, and never offers the old generation', () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });
    writeFileSync(logPath(), records(0, RECORDS_PER_SEGMENT));
    const oldEnd = fileSize();
    index.appendSegment({
      streamKey: STREAM,
      generation: 'gen-1',
      segmentSeq: 0,
      artifactRef: LOG_NAME,
      startOffset: 0,
      endOffset: oldEnd,
      recordCount: RECORDS_PER_SEGMENT
    });
    index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: oldEnd });

    // While the host is down the phase is re-run and its log rewritten.
    const after = restart(conn);
    writeFileSync(logPath(), records(100, 1));
    expect(after.index.openStream({ streamKey: STREAM, generation: 'gen-2', captureMode: 'captured', nowMs: NOW + 1 })).toEqual({
      outcome: 'replaced'
    });
    expect(after.index.openStream({ streamKey: STREAM, generation: 'gen-2', captureMode: 'captured', nowMs: NOW + 2 })).toEqual({
      outcome: 'unchanged'
    });

    const replay = restart(after.conn).index.restartReplay({ streamKey: STREAM });
    expect(replay?.generation).toBe('gen-2');
    expect(replay?.readable).toEqual([]);
    expect(replay?.unverified).toEqual([]);
    expect(replay?.unavailable).toEqual([
      { generation: 'gen-1', reason: 'source-replaced', fromOffset: 0, toOffset: oldEnd, count: 1 }
    ]);
  });

  it('keeps an ACP reconnect gap, recorded as coverage, across a restart', () => {
    const logger = new SanitizedLogger();
    const options = { sanitize: (s: string): string => logger.sanitize(s), caps: { perFieldBytes: 4096 } };
    const base = { attemptId: 'attempt-1', sourceEventId: null, origin: 'live', kind: 'message' } as const;
    const projected = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, connectionGeneration: 'c1', text: 'before' },
        { ...base, connectionGeneration: 'c2', text: 'after' }
      ],
      options
    );
    expect(projected.gaps).toEqual({ 'transport-gap': 1 });

    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'acp-1', captureMode: 'captured', nowMs: NOW });
    for (const item of projected.items) {
      if (item.entry.kind !== 'coverage-gap') continue;
      expect(
        index.recordCoverage({
          streamKey: STREAM,
          generation: 'acp-1',
          reason: 'transport-gap',
          fromOffset: item.streamSeq,
          toOffset: item.streamSeq,
          count: 1,
          nowMs: NOW
        })
      ).toEqual({ outcome: 'recorded' });
    }

    const replay = restart(conn).index.restartReplay({ streamKey: STREAM });
    expect(replay?.unavailable.map((range) => range.reason)).toEqual(['transport-gap']);
    expect(replay?.readable).toEqual([]);
  });

  it('upgrades a version 3 store on disk through version 4 and keeps its rows', () => {
    const upToThree = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 3);
    const v3 = openStore(upToThree);
    const tablesBefore = v3.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
    v3.close();

    const conn = new NodeSqliteConnection({ databasePath: join(workspaceRoot, 'schegent.db') });
    opened.push(conn);
    const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
    expect(result.appliedMigrations).toEqual([4, 5, 6, 7, 8]);
    expect(result.schemaVersion).toBe(8);
    const tablesAfter = conn
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((row) => row.name);
    const expected = [
      ...tablesBefore.map((row) => row.name),
      ...F07_LIVE_LOG_TABLE_NAMES,
      ...F08_HANDOFF_TABLE_NAMES,
      ...F10_LANES_TABLE_NAMES,
      ...F11_REPORTING_TABLE_NAMES,
      ...R6_INTEGRATION_TABLE_NAMES
    ];
    expect(tablesAfter).toEqual(expected.sort((a, b) => a.localeCompare(b)));
  });
});
