/**
 * FR-R8-03 (03-03) — Unit & parity verification for the read-only `node:worker_threads`
 * usage-accounting query executor (`accounting-query-worker.ts`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNTING_BOUNDS } from '../../../src/contracts/usage-accounting/accounting-types';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import {
  ACCOUNTING_QUERY_WORKER_FILENAME,
  ACCOUNTING_QUERY_WORKER_RESOURCE_LIMITS,
  createAccountingQueryWorkerClient,
  isFileBackedSqlitePath,
  resolveAccountingQueryWorkerPath,
  type AccountingWorkerQueryMetrics
} from '../../../src/services/usage-accounting/accounting-query-worker';
import { WORKER_OOM_ERROR_CODE } from '../../../src/services/worker-entry-path';
import { createUsageAccountingReader, queryUsageAccountingAsync } from '../../../src/headless/usage-accounting-api';
import { readUsage, readUsageAsync } from '../../../src/services/reporting/report-usage';

const NOW = '2026-11-24T12:00:00.000Z';
const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-acct-worker-'));
  tempDirs.push(dir);
  return path.join(dir, 'schegent-state.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FR-R8-03 (03-03) read-only usage-accounting query worker', () => {
  it('identifies file-backed vs in-memory SQLite paths accurately', () => {
    expect(isFileBackedSqlitePath(':memory:')).toBe(false);
    expect(isFileBackedSqlitePath('file::memory:?cache=shared')).toBe(false);
    expect(isFileBackedSqlitePath('')).toBe(false);
    expect(isFileBackedSqlitePath('/tmp/schegent-state.db')).toBe(true);
  });

  it('produces byte-identical results to synchronous query across filters, cursors, occupancy, legacy, gaps, and errors', async () => {
    const dbPath = createTempDbPath();
    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
    const service = createUsageAccountingService({
      conn,
      nowUtc: () => NOW,
      monotonicMs: () => performance.now(),
      workspaceId: 'ws-worker-parity'
    });

    try {
      for (let i = 0; i < 40; i += 1) {
        const res = service.ingestObservation({
          producerNamespace: 'schegent.phase-end/1',
          source: 'phase-end',
          sourceKind: 'phase-end',
          sourceIdentity: `parity:${String(i)}`,
          rootId: `root-${String(Math.floor(i / 4))}`,
          attemptId: `att-${String(i)}`,
          invocationOrdinal: 0,
          counterScope: 'invocation-delta',
          adapterVersion: 'claude/1',
          dimensions: {
            backend: i % 2 === 0 ? 'claude' : 'codex',
            modelReported: i % 3 === 0 ? 'model-a' : 'model-b',
            phaseId: `phase-${String(i % 8).padStart(2, '0')}`
          },
          eventUtc: `2026-11-24T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
          observedUtc: `2026-11-24T10:${String(i % 60).padStart(2, '0')}:01.000Z`,
          measures: [
            { measure: 'input_tokens', quantity: 100 + i, unit: 'count', provenance: 'provider-reported' },
            { measure: 'output_tokens', quantity: 50 + i, unit: 'count', provenance: 'provider-reported' },
            { measure: 'cost', quantity: `0.${String(i).padStart(3, '0')}250`, unit: 'USD', provenance: 'provider-reported' },
            { measure: 'context_used', quantity: 1000 + i * 10, unit: 'count', provenance: 'provider-reported' }
          ]
        });
        expect(res.ok).toBe(true);
      }
      service.recordGaps('dimension-excluded', 3);

      // Page 1 + Page 2 parity (grouped with cursor + legacy + occupancy)
      const q1 = {
        groupBy: ['phaseId'],
        filters: { backend: 'claude' },
        from: '2026-11-24T00:00:00Z',
        to: '2026-11-25T00:00:00Z',
        includeLegacy: true,
        limit: 3
      };
      const syncPage1 = service.query(q1);
      const metrics: AccountingWorkerQueryMetrics[] = [];
      const asyncPage1 = await service.queryAsync(q1, undefined, { onMetrics: (m) => metrics.push(m) });
      expect(asyncPage1).toEqual(syncPage1);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.workerExecMs).toBeGreaterThanOrEqual(0);
      expect(syncPage1.ok).toBe(true);
      if (!syncPage1.ok) return;
      expect(syncPage1.value.nextCursor).toBeDefined();

      const q2 = { ...q1, asOfRevision: syncPage1.value.revision, cursor: syncPage1.value.nextCursor };
      expect(await service.queryAsync(q2)).toEqual(service.query(q2));

      // Non-occupancy measure-filtered parity (exercises occupancy skip)
      const qNoOcc = {
        groupBy: ['backend', 'model'],
        measures: ['input_tokens', 'cost'],
        limit: 10
      };
      expect(await service.queryAsync(qNoOcc)).toEqual(service.query(qNoOcc));

      // Ungrouped total parity
      const qUngrouped = { groupBy: [], limit: 1 };
      expect(await service.queryAsync(qUngrouped)).toEqual(service.query(qUngrouped));

      // Refusal parity (invalid cursor, asOfRevision past latest)
      const badCursor = { ...q1, cursor: '1~invalid' };
      expect(await service.queryAsync(badCursor)).toEqual(service.query(badCursor));
      const futureRev = { groupBy: [], asOfRevision: syncPage1.value.revision + 99, limit: 1 };
      expect(await service.queryAsync(futureRev)).toEqual(service.query(futureRev));

      // Headless reader & reporting readUsageAsync parity
      const reader = createUsageAccountingReader(service);
      expect(await queryUsageAccountingAsync(reader, q1)).toEqual(syncPage1);

      const syncReport = readUsage(service, { groupBy: ['backend'], from: q1.from, to: q1.to }, { cap: 100 });
      const asyncReport = await readUsageAsync(service, { groupBy: ['backend'], from: q1.from, to: q1.to }, { cap: 100 });
      expect(asyncReport).toEqual(syncReport);
    } finally {
      await service.close();
      conn.close();
    }
  });

  it('falls back cleanly to synchronous execution on :memory: SQLite stores', async () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
    const service = createUsageAccountingService({
      conn,
      nowUtc: () => NOW,
      monotonicMs: () => performance.now(),
      workspaceId: 'ws-memory-fallback'
    });
    try {
      const res = await service.queryAsync({ groupBy: ['phaseId'], limit: 10 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.rows).toEqual([]);
    } finally {
      await service.close();
      conn.close();
    }
  });

  it('supports real mid-read AbortSignal termination and transparently respawns a clean worker for subsequent queries', async () => {
    const dbPath = createTempDbPath();
    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));

    // Seed enough rows (120k contributions / 30k attempts) so a real SQL read stays in-flight
    // long enough for an AbortSignal to cancel it mid-execution.
    conn.exec('BEGIN IMMEDIATE');
    conn.run(
      `INSERT INTO accounting_revisions (revision, committed_utc, cause, cutoff_ingest_seq, policy_version, calculation_version)
       VALUES (1, ?, 'ingest', 120000, 1, 1)`,
      NOW
    );
    conn.run(
      `WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM cnt WHERE x + 1 < 30000)
       INSERT INTO accounting_attempts (attempt_id, root_id, workspace_id, backend, model, workflow_revision, phase_id, outcome, first_event_utc, last_event_utc)
       SELECT 'a-' || x, 'r-' || (x / 4), 'ws-cancel', CASE WHEN x % 2 = 0 THEN 'claude' ELSE 'codex' END,
              'model-a', 'wf-1', 'phase-' || printf('%03d', x % 250), 'succeeded',
              '2026-11-24T10:00:00.000Z', '2026-11-24T10:00:01.000Z'
       FROM cnt`
    );
    conn.run(
      `WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM cnt WHERE x + 1 < 120000)
       INSERT INTO accounting_contributions (attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, cost_origin, selected_observation_id, from_revision)
       SELECT 'a-' || (x / 4), 0,
              CASE x % 4 WHEN 0 THEN 'input_tokens' WHEN 1 THEN 'output_tokens' WHEN 2 THEN 'cache_read_tokens' ELSE 'cost' END,
              CASE x % 4 WHEN 3 THEN 'USD' ELSE 'count' END,
              100, 'known', 'provider-reported', CASE x % 4 WHEN 3 THEN 'reported' ELSE NULL END, NULL, 1
       FROM cnt`
    );
    conn.exec('COMMIT');

    const client = createAccountingQueryWorkerClient(dbPath);
    try {
      const request = {
        groupBy: ['phaseId'] as const,
        filters: { backend: 'claude' as const },
        limit: 200
      };

      // Warm up worker once so spawnCount = 1
      const warmup = await client.query(request, DEFAULT_ACCOUNTING_BOUNDS);
      expect(warmup.ok).toBe(true);
      expect(client.spawnCount).toBe(1);

      // Start a real query AND immediately abort after 1ms while the worker is executing SQL
      const controller = new AbortController();
      const inFlight = client.query(request, DEFAULT_ACCOUNTING_BOUNDS, { signal: controller.signal });
      setTimeout(() => controller.abort(), 1);
      const cancelled = await inFlight;
      expect(cancelled).toEqual({ ok: false, refusal: { code: 'deadline-exceeded' } });
      expect(client.terminationCount).toBeGreaterThanOrEqual(1);

      // Queue abort while behind another query: queued abort does NOT terminate the active query
      const queuedAbort = new AbortController();
      const firstPromise = client.query(request, DEFAULT_ACCOUNTING_BOUNDS);
      const secondPromise = client.query(request, DEFAULT_ACCOUNTING_BOUNDS, { signal: queuedAbort.signal });
      queuedAbort.abort();
      const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
      expect(firstRes.ok).toBe(true);
      expect(secondRes).toEqual({ ok: false, refusal: { code: 'deadline-exceeded' } });
      // A fresh worker spawned after the earlier termination and remained healthy
      expect(client.spawnCount).toBe(2);

      // Concurrent abort + immediate close + duplicate close all settle cleanly after termination
      const abortCtrl2 = new AbortController();
      const inFlight2 = client.query(request, DEFAULT_ACCOUNTING_BOUNDS, { signal: abortCtrl2.signal });
      setTimeout(() => abortCtrl2.abort(), 1);
      await inFlight2;
      await Promise.all([client.close(), client.close()]);
    } finally {
      await client.close();
      conn.close();
    }
  }, 30_000);

  it('maintains atomic WAL read-snapshot consistency under concurrent host outcome updates and compaction', async () => {
    const dbPath = createTempDbPath();
    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
    const service = createUsageAccountingService({
      conn,
      nowUtc: () => NOW,
      monotonicMs: () => performance.now(),
      workspaceId: 'ws-wal-snapshot'
    });

    try {
      for (let i = 0; i < 60; i += 1) {
        const res = service.ingestObservation({
          producerNamespace: 'schegent.phase-end/1',
          source: 'phase-end',
          sourceKind: 'phase-end',
          sourceIdentity: `snap:${String(i)}`,
          rootId: `root-${String(i % 10)}`,
          attemptId: `snap-att-${String(i)}`,
          invocationOrdinal: 0,
          counterScope: 'invocation-delta',
          adapterVersion: 'claude/1',
          dimensions: { backend: 'claude', modelReported: 'model-a', phaseId: `phase-${String(i % 5)}` },
          eventUtc: '2026-11-24T10:00:00.000Z',
          observedUtc: '2026-11-24T10:00:01.000Z',
          measures: [{ measure: 'input_tokens', quantity: 500, unit: 'count', provenance: 'provider-reported' }]
        });
        expect(res.ok).toBe(true);
      }

      // Issue concurrent read-only worker queries while the host mutates attempt outcomes
      const queryPromises = Array.from({ length: 12 }, () =>
        service.queryAsync({
          groupBy: ['attemptOutcome'],
          measures: ['input_tokens'],
          limit: 50
        })
      );
      for (let i = 0; i < 60; i += 1) {
        service.recordAttemptOutcome({
          attemptId: `snap-att-${String(i)}`,
          outcome: i % 2 === 0 ? 'succeeded' : 'failed'
        });
      }

      const results = await Promise.all(queryPromises);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        // Every snapshot row must satisfy coverage invariant known <= denominator (no torn group/measure read)
        const totalAttempts = result.value.rows.reduce((acc, row) => acc + row.attempts, 0);
        expect(totalAttempts).toBe(60);
        for (const row of result.value.rows) {
          const inputMeasure = row.measures.find((m) => m.measure === 'input_tokens');
          expect(inputMeasure).toBeDefined();
          if (inputMeasure !== undefined) {
            expect(inputMeasure.coverage.known).toBeLessThanOrEqual(inputMeasure.coverage.denominator);
            expect(inputMeasure.coverage.denominator).toBe(row.attempts);
          }
        }
      }
    } finally {
      await service.close();
      conn.close();
    }
  });

  it('resolves bundled vs source worker entry path and maps ERR_WORKER_OUT_OF_MEMORY cleanly to response-too-large', async () => {
    const distDir = path.resolve('/app/dist');
    const distBundle = path.join(distDir, ACCOUNTING_QUERY_WORKER_FILENAME);
    expect(
      resolveAccountingQueryWorkerPath({
        callerDir: distDir,
        callerFilename: path.join(distDir, 'extension.js'),
        fileExists: (candidate) => candidate === distBundle
      })
    ).toBe(distBundle);
    expect(
      resolveAccountingQueryWorkerPath().endsWith(
        path.join('usage-accounting', 'accounting-query-worker-entry.ts')
      )
    ).toBe(true);
    expect(ACCOUNTING_QUERY_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(128);
    expect(ACCOUNTING_QUERY_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb).toBe(16);

    const dbPath = createTempDbPath();
    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
    const scriptDir = path.dirname(dbPath);
    const oomScript = path.join(scriptDir, 'oom-acct-worker.cjs');
    fs.writeFileSync(
      oomScript,
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', () => {
         const hold = [];
         while (true) hold.push(new Array(1024 * 1024).fill(1));
       });`,
      'utf8'
    );
    const crashScript = path.join(scriptDir, 'crash-acct-worker.cjs');
    fs.writeFileSync(
      crashScript,
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', () => {
         throw new Error('simulated worker crash');
       });`,
      'utf8'
    );

    const oomCodes: string[] = [];
    const oomClient = createAccountingQueryWorkerClient(dbPath, {
      workerEntryPath: oomScript,
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      onErrorCode: (code) => oomCodes.push(code)
    });
    const crashClient = createAccountingQueryWorkerClient(dbPath, {
      workerEntryPath: crashScript
    });
    try {
      const oomResult = await oomClient.query({ groupBy: [], limit: 10 }, DEFAULT_ACCOUNTING_BOUNDS);
      expect(oomResult).toEqual({
        ok: false,
        refusal: { code: 'response-too-large', detail: 'worker-memory-limit' }
      });
      expect(oomCodes).toContain(WORKER_OOM_ERROR_CODE);

      const crashResult = await crashClient.query(
        { groupBy: [], limit: 10 },
        DEFAULT_ACCOUNTING_BOUNDS
      );
      expect(crashResult).toEqual({
        ok: false,
        refusal: { code: 'store-error', detail: 'queryAsync' }
      });
    } finally {
      await oomClient.close();
      await crashClient.close();
      conn.close();
    }
  });
});

