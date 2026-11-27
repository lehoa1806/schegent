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

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../src/lib/logger';
import { initialAcpProjectionState, projectAcpEvents } from '../../src/services/phase-log/acp-live-projection';
import {
  createLiveLogIndex,
  LIVE_LOG_ARTIFACT_REF_MAX_LENGTH,
  LIVE_LOG_REPLAY_MAX_ROWS,
  type LiveLogIndex
} from '../../src/services/phase-log/live-log-index';
import {
  parseContainedArtifactRef,
  readContainedLiveLogReplay
} from '../../src/services/phase-log/live-log-replay-reader';
import { F07_LIVE_LOG_TABLE_NAMES } from '../../src/services/phase-log/live-log-index-schema';
import { F08_HANDOFF_TABLE_NAMES } from '../../src/services/recovery-handoff/handoff-schema';
import { F10_LANES_TABLE_NAMES } from '../../src/services/execution-lanes/lane-schema';
import { F11_REPORTING_TABLE_NAMES } from '../../src/services/reporting/reporting-schema';
import { R6_INTEGRATION_TABLE_NAMES } from '../../src/services/sqlite-store/round6-integration-schema';
import { FR_R7_02_OPERATIONAL_ENTITY_TABLE_NAMES } from '../../src/services/sqlite-store/operational-entity-schema';
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
    expect(result.appliedMigrations).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.schemaVersion).toBe(9);
    const tablesAfter = conn
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((row) => row.name);
    const expected = [
      ...tablesBefore.map((row) => row.name),
      ...F07_LIVE_LOG_TABLE_NAMES,
      ...F08_HANDOFF_TABLE_NAMES,
      ...F10_LANES_TABLE_NAMES,
      ...F11_REPORTING_TABLE_NAMES,
      ...R6_INTEGRATION_TABLE_NAMES,
      ...FR_R7_02_OPERATIONAL_ENTITY_TABLE_NAMES
    ];
    expect(tablesAfter).toEqual(expected.sort((a, b) => a.localeCompare(b)));
  });
});

describe('FR-R7-16 (16-09) — contained live-log segment replay reader end-to-end', () => {
  it('replays out-of-order finalized segments oldest-first, skips unverified segments, and reads contained nested refs', async () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });

    const nestedRef = 'phase-logs/run-7/iter-1/implement-1.jsonl';
    mkdirSync(join(workspaceRoot, 'phase-logs', 'run-7', 'iter-1'), { recursive: true });
    const part0 = `${JSON.stringify({ type: 'assistant', seg: 0 })}\n`;
    const part1 = `${JSON.stringify({ type: 'assistant', seg: 1 })}\n`;
    const part2 = `${JSON.stringify({ type: 'assistant', seg: 2 })}\n`;
    const part3 = `${JSON.stringify({ type: 'assistant', seg: 3 })}\n`;
    const full = part0 + part1 + part2 + part3;
    writeFileSync(join(workspaceRoot, nestedRef), full);

    const off0 = 0;
    const off1 = Buffer.byteLength(part0, 'utf8');
    const off2 = off1 + Buffer.byteLength(part1, 'utf8');
    const off3 = off2 + Buffer.byteLength(part2, 'utf8');
    const off4 = off3 + Buffer.byteLength(part3, 'utf8');

    // Insert segments out of order; finalize 2, 0, 1 and leave 3 unverified.
    for (const [seq, startOffset, endOffset] of [
      [2, off2, off3],
      [0, off0, off1],
      [3, off3, off4],
      [1, off1, off2]
    ] as const) {
      expect(
        index.appendSegment({
          streamKey: STREAM,
          generation: 'gen-1',
          segmentSeq: seq,
          artifactRef: nestedRef,
          startOffset,
          endOffset,
          recordCount: 1
        })
      ).toEqual({ outcome: 'appended' });
    }
    for (const seq of [2, 0, 1]) {
      expect(
        index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: seq, verifiedSize: off4 })
      ).toEqual({ outcome: 'finalized' });
    }

    const after = restart(conn);
    const result = await readContainedLiveLogReplay({
      index: after.index,
      streamKey: STREAM,
      trustedRoot: workspaceRoot
    });

    expect(result.streamKey).toBe(STREAM);
    expect(result.generation).toBe('gen-1');
    expect(result.captureMode).toBe('captured');
    expect(result.truncated).toBe(false);
    expect(result.unavailable).toEqual([]);
    expect(result.segments).toEqual([
      { segmentSeq: 0, startOffset: off0, endOffset: off1, durable: true, outcome: 'read', text: part0, bytesRead: off1 - off0 },
      { segmentSeq: 1, startOffset: off1, endOffset: off2, durable: true, outcome: 'read', text: part1, bytesRead: off2 - off1 },
      { segmentSeq: 2, startOffset: off2, endOffset: off3, durable: true, outcome: 'read', text: part2, bytesRead: off3 - off2 }
    ]);
  });

  it('enforces exact 1024/1025 truncation boundary and captured->disabled single range through the replay reader', async () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });

    const line = 'x\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const totalCount = LIVE_LOG_REPLAY_MAX_ROWS + 1;
    writeFileSync(logPath(), line.repeat(totalCount));

    for (let seq = 0; seq < LIVE_LOG_REPLAY_MAX_ROWS; seq += 1) {
      index.appendSegment({
        streamKey: STREAM,
        generation: 'gen-1',
        segmentSeq: seq,
        artifactRef: LOG_NAME,
        startOffset: seq * lineBytes,
        endOffset: (seq + 1) * lineBytes,
        recordCount: 1
      });
      index.finalizeSegment({
        streamKey: STREAM,
        generation: 'gen-1',
        segmentSeq: seq,
        verifiedSize: totalCount * lineBytes
      });
    }

    const atCap = await readContainedLiveLogReplay({ index, streamKey: STREAM, trustedRoot: workspaceRoot });
    expect(atCap.truncated).toBe(false);
    expect(atCap.segments).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
    expect(atCap.segments.every((s) => s.outcome === 'read')).toBe(true);

    const lastSeq = LIVE_LOG_REPLAY_MAX_ROWS;
    index.appendSegment({
      streamKey: STREAM,
      generation: 'gen-1',
      segmentSeq: lastSeq,
      artifactRef: LOG_NAME,
      startOffset: lastSeq * lineBytes,
      endOffset: (lastSeq + 1) * lineBytes,
      recordCount: 1
    });
    index.finalizeSegment({
      streamKey: STREAM,
      generation: 'gen-1',
      segmentSeq: lastSeq,
      verifiedSize: totalCount * lineBytes
    });

    const overCap = await readContainedLiveLogReplay({ index, streamKey: STREAM, trustedRoot: workspaceRoot });
    expect(overCap.truncated).toBe(true);
    expect(overCap.segments).toHaveLength(LIVE_LOG_REPLAY_MAX_ROWS);
    expect(overCap.segments.at(0)?.segmentSeq).toBe(0);
    expect(overCap.segments.at(-1)?.segmentSeq).toBe(LIVE_LOG_REPLAY_MAX_ROWS - 1);

    // Transition captured gen-1 -> disabled gen-2: single capture-disabled range and zero segments read.
    index.openStream({ streamKey: STREAM, generation: 'gen-2', captureMode: 'disabled', nowMs: NOW + 10 });
    const disabled = await readContainedLiveLogReplay({
      index: restart(conn).index,
      streamKey: STREAM,
      trustedRoot: workspaceRoot
    });
    expect(disabled).toEqual({
      streamKey: STREAM,
      generation: 'gen-2',
      captureMode: 'disabled',
      segments: [],
      unavailable: [{ generation: 'gen-2', reason: 'capture-disabled', fromOffset: 0, toOffset: null, count: 1 }],
      truncated: false
    });
  });

  it('refuses escaping, absolute, Windows-drive, backslash, NUL/control, symlink-component, and symlink-leaf artifact_ref rows without reading outside trustedRoot', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'f07-outside-secret-'));
    try {
      const outsideSecret = 'OUTSIDE-CANARY-SECRET-NEVER-READ\n';
      const outsideFile = join(outsideDir, 'secret.jsonl');
      writeFileSync(outsideFile, outsideSecret);
      const outsideSize = Buffer.byteLength(outsideSecret, 'utf8');

      // Also place a sibling file reachable via `../<outsideDirName>/secret.jsonl` if traversal were allowed.
      const outsideName = outsideDir.split('/').at(-1) ?? 'missing';
      mkdirSync(join(workspaceRoot, 'logs'), { recursive: true });
      symlinkSync(outsideDir, join(workspaceRoot, 'symlink-dir'));
      symlinkSync(outsideFile, join(workspaceRoot, 'logs', 'symlink-leaf.jsonl'));

      const validRef = 'logs/valid.jsonl';
      const validContent = 'CONTAINED-OK\n';
      writeFileSync(join(workspaceRoot, validRef), validContent);

      // 1,024-char lexical acceptance & 1,025-char refusal verified alongside disk containment.
      const ref1024 = Array.from({ length: 15 }, () => 'd'.repeat(63)).join('/') + '/' + 'f'.repeat(64);
      expect(ref1024.length).toBe(LIVE_LOG_ARTIFACT_REF_MAX_LENGTH);
      expect(parseContainedArtifactRef(ref1024)).not.toBeNull();
      expect(parseContainedArtifactRef(`${ref1024}z`)).toBeNull();

      const conn = openStore();
      const index = createLiveLogIndex(conn);
      index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });

      expect(index.appendSegment({
        streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, artifactRef: 'logs/name\0suffix',
        startOffset: 0, endOffset: 0, recordCount: 0
      })).toEqual({ outcome: 'refused', reason: 'invalid' });

      const maliciousRefs: readonly string[] = [
        `../${outsideName}/secret.jsonl`,
        `logs/../../${outsideName}/secret.jsonl`,
        outsideFile,
        'C:foo',
        'C:/Windows/win.ini',
        'logs\\valid.jsonl',
        'logs/valid\0.jsonl',
        'logs/valid\n.jsonl',
        'logs/valid\x7f.jsonl',
        'symlink-dir/secret.jsonl',
        'logs/symlink-leaf.jsonl'
      ];

      // Seed malicious rows directly as finalized (`durable = 1`) rows in SQLite,
      // plus one valid contained row at the end to verify replay continues cleanly.
      for (let i = 0; i < maliciousRefs.length; i += 1) {
        const ref = maliciousRefs.at(i) ?? '';
        conn.run(
          `INSERT INTO live_log_segments
             (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          `malicious-seg-${String(i).padStart(50, '0')}`,
          STREAM,
          'gen-1',
          i,
          ref,
          0,
          outsideSize,
          1
        );
      }

      const validSeq = maliciousRefs.length;
      const validSize = Buffer.byteLength(validContent, 'utf8');
      index.appendSegment({
        streamKey: STREAM,
        generation: 'gen-1',
        segmentSeq: validSeq,
        artifactRef: validRef,
        startOffset: 0,
        endOffset: validSize,
        recordCount: 1
      });
      index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: validSeq, verifiedSize: validSize });

      const result = await readContainedLiveLogReplay({
        index: restart(conn).index,
        streamKey: STREAM,
        trustedRoot: workspaceRoot
      });

      expect(result.segments).toHaveLength(maliciousRefs.length + 1);
      for (let i = 0; i < maliciousRefs.length; i += 1) {
        const readSeg = result.segments.at(i);
        expect(readSeg, `ref ${maliciousRefs.at(i)}`).toEqual({
          segmentSeq: i,
          startOffset: 0,
          endOffset: outsideSize,
          durable: true,
          outcome: 'permission-refused',
          bytesRead: 0
        });
      }
      expect(result.segments.at(validSeq)).toEqual({
        segmentSeq: validSeq,
        startOffset: 0,
        endOffset: validSize,
        durable: true,
        outcome: 'read',
        text: validContent,
        bytesRead: validSize
      });
      expect(JSON.stringify(result)).not.toContain(outsideSecret);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reports artifact-expired, extent-invalid, and budget-exceeded outcomes cleanly', async () => {
    const conn = openStore();
    const index = createLiveLogIndex(conn);
    index.openStream({ streamKey: STREAM, generation: 'gen-1', captureMode: 'captured', nowMs: NOW });

    const missingRef = 'missing.jsonl';
    const shrunkRef = 'shrunk.jsonl';
    const okRef = 'ok.jsonl';
    writeFileSync(join(workspaceRoot, missingRef), '0123456789');
    writeFileSync(join(workspaceRoot, shrunkRef), '0123456789');
    writeFileSync(join(workspaceRoot, okRef), 'abcdefghijklmnop');

    index.appendSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, artifactRef: missingRef, startOffset: 0, endOffset: 10, recordCount: 1 });
    index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 0, verifiedSize: 10 });

    index.appendSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 1, artifactRef: shrunkRef, startOffset: 0, endOffset: 10, recordCount: 1 });
    index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 1, verifiedSize: 10 });

    index.appendSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 2, artifactRef: okRef, startOffset: 0, endOffset: 8, recordCount: 1 });
    index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 2, verifiedSize: 16 });

    index.appendSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 3, artifactRef: okRef, startOffset: 8, endOffset: 16, recordCount: 1 });
    index.finalizeSegment({ streamKey: STREAM, generation: 'gen-1', segmentSeq: 3, verifiedSize: 16 });

    // Simulate file expiry and truncation after finalization.
    unlinkSync(join(workspaceRoot, missingRef));
    writeFileSync(join(workspaceRoot, shrunkRef), 'short');

    const result = await readContainedLiveLogReplay({
      index,
      streamKey: STREAM,
      trustedRoot: workspaceRoot,
      maxPassBytes: 12
    });

    expect(result.segments).toEqual([
      { segmentSeq: 0, startOffset: 0, endOffset: 10, durable: true, outcome: 'artifact-expired', bytesRead: 0 },
      { segmentSeq: 1, startOffset: 0, endOffset: 10, durable: true, outcome: 'extent-invalid', bytesRead: 0 },
      { segmentSeq: 2, startOffset: 0, endOffset: 8, durable: true, outcome: 'read', text: 'abcdefgh', bytesRead: 8 },
      { segmentSeq: 3, startOffset: 8, endOffset: 16, durable: true, outcome: 'budget-exceeded', bytesRead: 0 }
    ]);
    expect(result.unavailable.map((u) => u.reason)).toEqual(['artifact-expired', 'range-skipped']);

    const unknown = await readContainedLiveLogReplay({
      index,
      streamKey: 'never-opened',
      trustedRoot: workspaceRoot
    });
    expect(unknown).toEqual({
      streamKey: 'never-opened',
      generation: null,
      captureMode: null,
      segments: [],
      unavailable: [],
      truncated: false
    });
  });
});
