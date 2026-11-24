// FR-R6-F06 (T052; NFR-003, SC-006) — accounting reads at 100,000 retained attempts.
//
// 100,000 attempts, each with one invocation carrying four measures (input, output and cache-read
// tokens, and cost), ingested through the facade so the projection writes the contributions.
// Attempts spread over two backends, four models and 500 phases. Each read groups by phase,
// filters one backend and asks for the 200-row page bound, cycling through every cursor.
//
// Sample counts follow the F03 floor that `measureOperationDistribution` enforces (20 warm-up,
// 200 measured), which is stricter than the task's 5/50: the helper refuses fewer.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES
} from '../../src/contracts/sqlite-store/schema-types';
import { DEFAULT_ACCOUNTING_BOUNDS } from '../../src/contracts/usage-accounting/accounting-types';
import { NodeSqliteConnection, SchemaBootstrapService, measureOperationDistribution } from '../../src/services/sqlite-store';
import { createUsageAccountingService } from '../../src/services/usage-accounting/usage-accounting-service';

const NOW = '2026-11-10T12:00:00.000Z';
const ATTEMPT_COUNT = 100_000;
const MEASURES_PER_ATTEMPT = 4;
const PHASE_COUNT = 500;
const BACKENDS = ['claude', 'codex'] as const;
const MODELS = ['model-a', 'model-b', 'model-c', 'model-d'] as const;
const PAGE_ROWS = DEFAULT_ACCOUNTING_BOUNDS.maxQueryLimit;
const WARM_P95_BUDGET_MS = 500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TEST_TIMEOUT_MS = 900_000;

function phaseOf(index: number): string {
  return `phase-${String(index % PHASE_COUNT).padStart(3, '0')}`;
}

describe('FR-R6-F06 accounting reads at 100,000 attempts (NFR-003, SC-006)', () => {
  it(
    'reads filtered 200-row pages at warm p95 <= 500 ms, each response <= 1 MiB',
    () => {
      const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
      const service = createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-perf' });

      const seedStarted = performance.now();
      for (let index = 0; index < ATTEMPT_COUNT; index += 1) {
        const minute = String(index % 60).padStart(2, '0');
        const result = service.ingestObservation({
          producerNamespace: 'schegent.phase-end/1',
          source: 'phase-end',
          sourceKind: 'phase-end',
          sourceIdentity: `perf:${String(index)}`,
          rootId: `root-${String(Math.floor(index / 4))}`,
          attemptId: `attempt-${String(index)}`,
          invocationOrdinal: 0,
          counterScope: 'invocation-delta',
          adapterVersion: 'claude/1',
          dimensions: {
            backend: BACKENDS.at(index % BACKENDS.length) as string,
            modelReported: MODELS.at(index % MODELS.length) as string,
            phaseId: phaseOf(index)
          },
          eventUtc: `2026-11-10T10:${minute}:00.000Z`,
          observedUtc: `2026-11-10T10:${minute}:01.000Z`,
          measures: [
            { measure: 'input_tokens', quantity: 100 + (index % 1000), unit: 'count', provenance: 'provider-reported' },
            { measure: 'output_tokens', quantity: 40 + (index % 97), unit: 'count', provenance: 'provider-reported' },
            { measure: 'cache_read_tokens', quantity: index % 13, unit: 'count', provenance: 'provider-reported' },
            { measure: 'cost', quantity: `0.${String(index % 1000).padStart(3, '0')}125`, unit: 'USD', provenance: 'provider-reported' }
          ]
        });
        if (!result.ok) throw new Error(`seed refused: ${result.refusal.code}`);
      }
      const seedMs = performance.now() - seedStarted;
      expect(Number(conn.scalar('SELECT count(*) FROM accounting_contributions WHERE to_revision IS NULL'))).toBe(
        ATTEMPT_COUNT * MEASURES_PER_ATTEMPT
      );

      const request = (cursor: string | undefined) => ({
        groupBy: ['phaseId'],
        filters: { backend: 'claude' },
        from: '2026-11-10T00:00:00Z',
        to: '2026-11-11T00:00:00Z',
        limit: PAGE_ROWS,
        ...(cursor === undefined ? {} : { cursor })
      });

      const coldStarted = performance.now();
      const cold = service.query(request(undefined));
      const coldMs = performance.now() - coldStarted;
      if (!cold.ok) throw new Error(cold.refusal.code);
      expect(cold.value.rows).toHaveLength(PAGE_ROWS);

      let cursor: string | undefined;
      let maxBytes = 0;
      let rowsSeen = 0;
      const warm = measureOperationDistribution({
        operationName: 'usage_accounting_query_page',
        warmupSamples: SQLITE_BENCHMARK_WARMUP_SAMPLES,
        measuredSamples: SQLITE_BENCHMARK_MEASURED_SAMPLES,
        step: () => {
          const page = service.query(request(cursor));
          if (!page.ok) throw new Error(page.refusal.code);
          maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page.value), 'utf8'));
          rowsSeen += page.value.rows.length;
          cursor = page.value.nextCursor ?? undefined;
        }
      });

      console.info(
        JSON.stringify({
          platform: `${os.platform()}-${os.arch()}`,
          node: process.version,
          fixture: {
            attempts: ATTEMPT_COUNT,
            measuresPerAttempt: MEASURES_PER_ATTEMPT,
            phases: PHASE_COUNT,
            backends: BACKENDS.length,
            models: MODELS.length,
            pageRows: PAGE_ROWS
          },
          seed: { ms: Number(seedMs.toFixed(0)) },
          cold: { ms: Number(coldMs.toFixed(2)) },
          warm: { p50Ms: warm.p50Ms, p95Ms: warm.p95Ms, p99Ms: warm.p99Ms, maxMs: warm.maxMs },
          maxResponseBytes: maxBytes
        })
      );

      expect(warm.failureCount).toBe(0);
      expect(rowsSeen).toBeGreaterThan(0);
      expect(warm.p95Ms).toBeLessThanOrEqual(WARM_P95_BUDGET_MS);
      expect(maxBytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      conn.close();
    },
    TEST_TIMEOUT_MS
  );
});

const RETENTION_BOUND_OBSERVATIONS = DEFAULT_ACCOUNTING_BOUNDS.maxRetainedObservations;
const RETENTION_BOUND_ATTEMPTS = RETENTION_BOUND_OBSERVATIONS / MEASURES_PER_ATTEMPT;
const RETENTION_WARMUP_SAMPLES = 5;
const RETENTION_MEASURED_SAMPLES = 30;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

describe('FR-R7-16 (16-07) accounting reads at the 1,000,000-observation retention bound', () => {
  it(
    'measures 200-row read latency, synchronous host event-loop blocking, and between-statement abort at 1,000,000 retained observations',
    async () => {
      const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));

      const seedStarted = performance.now();
      conn.exec('BEGIN IMMEDIATE');
      conn.run(
        `INSERT INTO accounting_revisions (revision, committed_utc, cause, cutoff_ingest_seq, policy_version, calculation_version)
         VALUES (1, ?, 'ingest', ?, 1, 1)`,
        NOW,
        RETENTION_BOUND_OBSERVATIONS
      );
      conn.run(
        `WITH RECURSIVE cnt(x) AS (
           SELECT 0
           UNION ALL
           SELECT x + 1 FROM cnt WHERE x + 1 < ?
         )
         INSERT INTO accounting_attempts (
           attempt_id, root_id, workspace_id, backend, model, workflow_revision, phase_id, outcome, first_event_utc, last_event_utc
         )
         SELECT
           'att-' || x,
           'root-' || (x / 4),
           'ws-perf-1m',
           CASE WHEN x % 2 = 0 THEN 'claude' ELSE 'codex' END,
           CASE x % 4 WHEN 0 THEN 'model-a' WHEN 1 THEN 'model-b' WHEN 2 THEN 'model-c' ELSE 'model-d' END,
           'wf-1',
           'phase-' || printf('%03d', x % 500),
           'succeeded',
           '2026-11-10T10:' || printf('%02d', x % 60) || ':00.000Z',
           '2026-11-10T10:' || printf('%02d', x % 60) || ':01.000Z'
         FROM cnt`,
        RETENTION_BOUND_ATTEMPTS
      );
      conn.run(
        `WITH RECURSIVE cnt(x) AS (
           SELECT 0
           UNION ALL
           SELECT x + 1 FROM cnt WHERE x + 1 < ?
         )
         INSERT INTO accounting_observations (
           observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind,
           source_identity, observation_revision, workspace_id, root_id, attempt_id, invocation_ordinal,
           counter_scope, adapter_version, normalization_version, backend, model_requested, model_reported,
           provider_session_ref, workflow_revision, phase_id, event_utc, observed_utc, ingested_utc,
           ingested_monotonic_ms, clock_anomaly, disposition, uncertainty_reason
         )
         SELECT
           'obs-' || x,
           x + 1,
           'dk-' || x,
           printf('%064x', x),
           'schegent.phase-end/1',
           'phase-end',
           'perf1m:' || x,
           1,
           'ws-perf-1m',
           'root-' || (x / 16),
           'att-' || (x / 4),
           x % 4,
           'invocation-delta',
           'claude/1',
           1,
           CASE WHEN (x / 4) % 2 = 0 THEN 'claude' ELSE 'codex' END,
           NULL,
           CASE (x / 4) % 4 WHEN 0 THEN 'model-a' WHEN 1 THEN 'model-b' WHEN 2 THEN 'model-c' ELSE 'model-d' END,
           NULL,
           'wf-1',
           'phase-' || printf('%03d', (x / 4) % 500),
           '2026-11-10T10:' || printf('%02d', (x / 4) % 60) || ':00.000Z',
           '2026-11-10T10:' || printf('%02d', (x / 4) % 60) || ':01.000Z',
           ?,
           1,
           0,
           'accepted',
           NULL
         FROM cnt`,
        RETENTION_BOUND_OBSERVATIONS,
        NOW
      );
      conn.run(
        `WITH RECURSIVE cnt(x) AS (
           SELECT 0
           UNION ALL
           SELECT x + 1 FROM cnt WHERE x + 1 < ?
         )
         INSERT INTO accounting_contributions (
           attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, cost_origin, selected_observation_id, from_revision
         )
         SELECT
           'att-' || (x / 4),
           0,
           CASE x % 4
             WHEN 0 THEN 'input_tokens'
             WHEN 1 THEN 'output_tokens'
             WHEN 2 THEN 'cache_read_tokens'
             ELSE 'cost'
           END,
           CASE x % 4 WHEN 3 THEN 'USD' ELSE 'count' END,
           CASE x % 4
             WHEN 0 THEN 100 + ((x / 4) % 1000)
             WHEN 1 THEN 40 + ((x / 4) % 97)
             WHEN 2 THEN (x / 4) % 13
             ELSE ((x / 4) % 1000) * 1000 + 125
           END,
           'known',
           'provider-reported',
           CASE x % 4 WHEN 3 THEN 'reported' ELSE NULL END,
           'obs-' || x,
           1
         FROM cnt`,
        RETENTION_BOUND_OBSERVATIONS
      );
      conn.exec('COMMIT');
      const seedMs = performance.now() - seedStarted;

      expect(Number(conn.scalar('SELECT count(*) FROM accounting_observations'))).toBe(RETENTION_BOUND_OBSERVATIONS);
      expect(Number(conn.scalar('SELECT count(*) FROM accounting_contributions WHERE to_revision IS NULL'))).toBe(
        RETENTION_BOUND_OBSERVATIONS
      );

      const service = createUsageAccountingService({
        conn,
        nowUtc: () => NOW,
        monotonicMs: () => performance.now(),
        workspaceId: 'ws-perf-1m'
      });

      const request = (cursor: string | undefined) => ({
        groupBy: ['phaseId'],
        filters: { backend: 'claude' },
        from: '2026-11-10T00:00:00Z',
        to: '2026-11-11T00:00:00Z',
        limit: PAGE_ROWS,
        ...(cursor === undefined ? {} : { cursor })
      });

      const coldStarted = performance.now();
      const cold = service.query(request(undefined));
      const coldMs = performance.now() - coldStarted;
      if (!cold.ok) throw new Error(cold.refusal.code);
      expect(cold.value.rows).toHaveLength(PAGE_ROWS);

      let cursor: string | undefined;
      for (let i = 0; i < RETENTION_WARMUP_SAMPLES; i += 1) {
        const page = service.query(request(cursor));
        if (!page.ok) throw new Error(page.refusal.code);
        cursor = page.value.nextCursor ?? undefined;
      }

      const warmLatencies: number[] = [];
      const eventLoopBlocks: number[] = [];
      let maxBytes = 0;
      for (let i = 0; i < RETENTION_MEASURED_SAMPLES; i += 1) {
        let timerFiredAt = 0;
        const timerScheduledAt = performance.now();
        const timerDone = new Promise<void>((resolve) => {
          setTimeout(() => {
            timerFiredAt = performance.now();
            resolve();
          }, 0);
        });
        const t0 = performance.now();
        const page = service.query(request(cursor));
        const elapsed = performance.now() - t0;
        if (!page.ok) throw new Error(page.refusal.code);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page.value), 'utf8'));
        cursor = page.value.nextCursor ?? undefined;
        await timerDone;
        warmLatencies.push(elapsed);
        eventLoopBlocks.push(timerFiredAt - timerScheduledAt);
      }

      // Between-statement abort contract: an already-aborted signal refuses immediately with zero query blocking.
      const aborted = new AbortController();
      aborted.abort();
      const abortStart = performance.now();
      const abortResult = service.query(request(undefined), aborted.signal);
      const abortMs = performance.now() - abortStart;
      expect(abortResult).toEqual({ ok: false, refusal: { code: 'deadline-exceeded' } });

      const sortedLatencies = [...warmLatencies].sort((a, b) => a - b);
      const sortedBlocks = [...eventLoopBlocks].sort((a, b) => a - b);
      const report = {
        benchmark: 'retention-bound-1m-observations',
        platform: `${os.platform()}-${os.arch()}`,
        cpu: os.cpus().at(0)?.model ?? 'unknown',
        node: process.version,
        fixture: {
          observations: RETENTION_BOUND_OBSERVATIONS,
          attempts: RETENTION_BOUND_ATTEMPTS,
          openContributions: RETENTION_BOUND_OBSERVATIONS,
          phases: PHASE_COUNT,
          backends: BACKENDS.length,
          models: MODELS.length,
          pageRows: PAGE_ROWS,
          warmupSamples: RETENTION_WARMUP_SAMPLES,
          measuredSamples: RETENTION_MEASURED_SAMPLES
        },
        seedMs: Number(seedMs.toFixed(0)),
        coldMs: Number(coldMs.toFixed(2)),
        warm: {
          p50Ms: percentile(sortedLatencies, 50),
          p95Ms: percentile(sortedLatencies, 95),
          p99Ms: percentile(sortedLatencies, 99),
          maxMs: percentile(sortedLatencies, 100)
        },
        hostEventLoopBlocking: {
          p50Ms: percentile(sortedBlocks, 50),
          p95Ms: percentile(sortedBlocks, 95),
          p99Ms: percentile(sortedBlocks, 99),
          maxMs: percentile(sortedBlocks, 100)
        },
        abortedPreflightMs: Number(abortMs.toFixed(3)),
        maxResponseBytes: maxBytes
      };
      console.info(JSON.stringify(report));

      expect(maxBytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(report.warm.maxMs).toBeLessThan(DEFAULT_ACCOUNTING_BOUNDS.queryDeadlineMs);
      conn.close();
    },
    TEST_TIMEOUT_MS
  );
});

const HOST_BLOCKING_P95_BUDGET_MS = 50;

function seedRetentionBoundDb(conn: NodeSqliteConnection): number {
  const seedStarted = performance.now();
  conn.exec('BEGIN IMMEDIATE');
  conn.run(
    `INSERT INTO accounting_revisions (revision, committed_utc, cause, cutoff_ingest_seq, policy_version, calculation_version)
     VALUES (1, ?, 'ingest', ?, 1, 1)`,
    NOW,
    RETENTION_BOUND_OBSERVATIONS
  );
  conn.run(
    `WITH RECURSIVE cnt(x) AS (
       SELECT 0
       UNION ALL
       SELECT x + 1 FROM cnt WHERE x + 1 < ?
     )
     INSERT INTO accounting_attempts (
       attempt_id, root_id, workspace_id, backend, model, workflow_revision, phase_id, outcome, first_event_utc, last_event_utc
     )
     SELECT
       'att-' || x,
       'root-' || (x / 4),
       'ws-perf-1m-worker',
       CASE WHEN x % 2 = 0 THEN 'claude' ELSE 'codex' END,
       CASE x % 4 WHEN 0 THEN 'model-a' WHEN 1 THEN 'model-b' WHEN 2 THEN 'model-c' ELSE 'model-d' END,
       'wf-1',
       'phase-' || printf('%03d', x % 500),
       'succeeded',
       '2026-11-10T10:' || printf('%02d', x % 60) || ':00.000Z',
       '2026-11-10T10:' || printf('%02d', x % 60) || ':01.000Z'
     FROM cnt`,
    RETENTION_BOUND_ATTEMPTS
  );
  conn.run(
    `WITH RECURSIVE cnt(x) AS (
       SELECT 0
       UNION ALL
       SELECT x + 1 FROM cnt WHERE x + 1 < ?
     )
     INSERT INTO accounting_observations (
       observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind,
       source_identity, observation_revision, workspace_id, root_id, attempt_id, invocation_ordinal,
       counter_scope, adapter_version, normalization_version, backend, model_requested, model_reported,
       provider_session_ref, workflow_revision, phase_id, event_utc, observed_utc, ingested_utc,
       ingested_monotonic_ms, clock_anomaly, disposition, uncertainty_reason
     )
     SELECT
       'obs-' || x,
       x + 1,
       'dk-' || x,
       printf('%064x', x),
       'schegent.phase-end/1',
       'phase-end',
       'perf1m:' || x,
       1,
       'ws-perf-1m-worker',
       'root-' || (x / 16),
       'att-' || (x / 4),
       x % 4,
       'invocation-delta',
       'claude/1',
       1,
       CASE WHEN (x / 4) % 2 = 0 THEN 'claude' ELSE 'codex' END,
       NULL,
       CASE (x / 4) % 4 WHEN 0 THEN 'model-a' WHEN 1 THEN 'model-b' WHEN 2 THEN 'model-c' ELSE 'model-d' END,
       NULL,
       'wf-1',
       'phase-' || printf('%03d', (x / 4) % 500),
       '2026-11-10T10:' || printf('%02d', (x / 4) % 60) || ':00.000Z',
       '2026-11-10T10:' || printf('%02d', (x / 4) % 60) || ':01.000Z',
       ?,
       1,
       0,
       'accepted',
       NULL
     FROM cnt`,
    RETENTION_BOUND_OBSERVATIONS,
    NOW
  );
  conn.run(
    `WITH RECURSIVE cnt(x) AS (
       SELECT 0
       UNION ALL
       SELECT x + 1 FROM cnt WHERE x + 1 < ?
     )
     INSERT INTO accounting_contributions (
       attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, cost_origin, selected_observation_id, from_revision
     )
     SELECT
       'att-' || (x / 4),
       0,
       CASE x % 4
         WHEN 0 THEN 'input_tokens'
         WHEN 1 THEN 'output_tokens'
         WHEN 2 THEN 'cache_read_tokens'
         ELSE 'cost'
       END,
       CASE x % 4 WHEN 3 THEN 'USD' ELSE 'count' END,
       CASE x % 4
         WHEN 0 THEN 100 + ((x / 4) % 1000)
         WHEN 1 THEN 40 + ((x / 4) % 97)
         WHEN 2 THEN (x / 4) % 13
         ELSE ((x / 4) % 1000) * 1000 + 125
       END,
       'known',
       'provider-reported',
       CASE x % 4 WHEN 3 THEN 'reported' ELSE NULL END,
       'obs-' || x,
       1
     FROM cnt`,
    RETENTION_BOUND_OBSERVATIONS
  );
  conn.exec('COMMIT');
  return performance.now() - seedStarted;
}

describe('FR-R8-03 (03-03) read-only worker accounting reads at 1,000,000 observations (<= 50 ms p95 host blocking)', () => {
  it(
    'keeps host event-loop blocking <= 50 ms p95 on file-backed WAL SQLite, services concurrent host actions, and cancels mid-read',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-perf-1m-worker-'));
      const dbPath = path.join(tempDir, 'schegent-state.db');
      const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
      const service = createUsageAccountingService({
        conn,
        nowUtc: () => NOW,
        monotonicMs: () => performance.now(),
        workspaceId: 'ws-perf-1m-worker'
      });

      try {
        const seedMs = seedRetentionBoundDb(conn);
        const request = (cursor: string | undefined) => ({
          groupBy: ['phaseId'],
          filters: { backend: 'claude' },
          from: '2026-11-10T00:00:00Z',
          to: '2026-11-11T00:00:00Z',
          limit: PAGE_ROWS,
          ...(cursor === undefined ? {} : { cursor })
        });

        // Cold first page on read-only worker + exact parity with sync query
        const coldStarted = performance.now();
        const cold = await service.queryAsync(request(undefined));
        const coldMs = performance.now() - coldStarted;
        if (!cold.ok) throw new Error(cold.refusal.code);
        expect(cold.value.rows).toHaveLength(PAGE_ROWS);
        const syncPage1 = service.query(request(undefined));
        expect(cold).toEqual(syncPage1);

        // Warm-up
        let cursor: string | undefined;
        for (let i = 0; i < RETENTION_WARMUP_SAMPLES; i += 1) {
          const page = await service.queryAsync(request(cursor));
          if (!page.ok) throw new Error(page.refusal.code);
          cursor = page.value.nextCursor ?? undefined;
        }

        // Comparable desktop profile (30 measured samples)
        const warmLatencies: number[] = [];
        const queueWaits: number[] = [];
        const hostBlocks: number[] = [];
        let maxBytes = 0;
        let concurrentActionTicksDuringRead = 0;
        const eld = monitorEventLoopDelay({ resolution: 1 });
        eld.enable();

        for (let i = 0; i < RETENTION_MEASURED_SAMPLES; i += 1) {
          let timerFiredAt = 0;
          let ticksThisRead = 0;
          const timerScheduledAt = performance.now();
          const probeTimer = new Promise<void>((resolve) => {
            setTimeout(() => {
              timerFiredAt = performance.now();
              resolve();
            }, 0);
          });
          // Unrelated editor/host action running concurrently while the worker executes SQL
          const editorHeartbeat = setInterval(() => {
            ticksThisRead += 1;
          }, 5);
          const t0 = performance.now();
          let qWait = 0;
          const page = await service.queryAsync(request(cursor), undefined, {
            onMetrics: (m) => {
              qWait = m.queueWaitMs;
            }
          });
          const elapsed = performance.now() - t0;
          clearInterval(editorHeartbeat);
          await probeTimer;
          if (!page.ok) throw new Error(page.refusal.code);
          maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page.value), 'utf8'));
          cursor = page.value.nextCursor ?? undefined;
          warmLatencies.push(elapsed);
          queueWaits.push(qWait);
          hostBlocks.push(timerFiredAt - timerScheduledAt);
          concurrentActionTicksDuringRead += ticksThisRead;
        }
        eld.disable();

        // Real mid-read cancellation during an active 1M-observation query
        const cancelCtrl = new AbortController();
        const cancelStart = performance.now();
        const inFlightRead = service.queryAsync(request(undefined), cancelCtrl.signal);
        setTimeout(() => cancelCtrl.abort(), 5);
        const cancelled = await inFlightRead;
        const cancelElapsedMs = performance.now() - cancelStart;
        expect(cancelled).toEqual({ ok: false, refusal: { code: 'deadline-exceeded' } });

        // Post-cancellation recovery: next read succeeds cleanly on respawned worker
        const recovered = await service.queryAsync(request(undefined));
        expect(recovered.ok).toBe(true);

        // Slower / contended local storage profile (30 samples alongside truly concurrent async disk fsync writes)
        const contentionFile = path.join(tempDir, 'io-contention.bin');
        const contentionBlock = Buffer.alloc(256 * 1024, 0x5a);
        const contendedLatencies: number[] = [];
        const contendedBlocks: number[] = [];
        const contentionCtrl = { stop: false };
        let contentionWrites = 0;
        const contentionLoop = (async () => {
          while (!contentionCtrl.stop) {
            const handle = await fs.promises.open(contentionFile, 'w');
            try {
              await handle.writeFile(contentionBlock);
              await handle.sync();
              contentionWrites += 1;
            } finally {
              await handle.close();
            }
          }
        })();
        try {
          for (let i = 0; i < RETENTION_MEASURED_SAMPLES; i += 1) {
            let firedAt = 0;
            const scheduledAt = performance.now();
            const probe = new Promise<void>((resolve) => {
              setTimeout(() => {
                firedAt = performance.now();
                resolve();
              }, 0);
            });
            const t0 = performance.now();
            const page = await service.queryAsync(request(cursor));
            const elapsed = performance.now() - t0;
            await probe;
            if (!page.ok) throw new Error(page.refusal.code);
            cursor = page.value.nextCursor ?? undefined;
            contendedLatencies.push(elapsed);
            contendedBlocks.push(firedAt - scheduledAt);
          }
        } finally {
          contentionCtrl.stop = true;
          await contentionLoop;
        }
        expect(contentionWrites).toBeGreaterThan(0);

        const sortedWarm = [...warmLatencies].sort((a, b) => a - b);
        const sortedQueue = [...queueWaits].sort((a, b) => a - b);
        const sortedBlocks = [...hostBlocks].sort((a, b) => a - b);
        const sortedContended = [...contendedLatencies].sort((a, b) => a - b);
        const sortedContendedBlocks = [...contendedBlocks].sort((a, b) => a - b);

        const report = {
          benchmark: 'retention-bound-1m-observations-readonly-worker',
          platform: `${os.platform()}-${os.arch()}`,
          cpu: os.cpus().at(0)?.model ?? 'unknown',
          node: process.version,
          seedMs: Number(seedMs.toFixed(0)),
          coldMs: Number(coldMs.toFixed(2)),
          warm: {
            p50Ms: percentile(sortedWarm, 50),
            p95Ms: percentile(sortedWarm, 95),
            p99Ms: percentile(sortedWarm, 99),
            maxMs: percentile(sortedWarm, 100)
          },
          queueWait: {
            p50Ms: percentile(sortedQueue, 50),
            p95Ms: percentile(sortedQueue, 95),
            maxMs: percentile(sortedQueue, 100)
          },
          hostEventLoopBlocking: {
            p50Ms: percentile(sortedBlocks, 50),
            p95Ms: percentile(sortedBlocks, 95),
            p99Ms: percentile(sortedBlocks, 99),
            maxMs: percentile(sortedBlocks, 100),
            eldP95Ms: Number((eld.percentile(95) / 1e6).toFixed(2)),
            eldMaxMs: Number((eld.max / 1e6).toFixed(2))
          },
          concurrentEditorTicksDuringReads: concurrentActionTicksDuringRead,
          midReadCancelMs: Number(cancelElapsedMs.toFixed(2)),
          contendedLocalStorage: {
            warmP50Ms: percentile(sortedContended, 50),
            warmP95Ms: percentile(sortedContended, 95),
            warmMaxMs: percentile(sortedContended, 100),
            hostBlockP50Ms: percentile(sortedContendedBlocks, 50),
            hostBlockP95Ms: percentile(sortedContendedBlocks, 95),
            hostBlockMaxMs: percentile(sortedContendedBlocks, 100)
          },
          maxResponseBytes: maxBytes
        };
        console.info(JSON.stringify(report));

        expect(report.hostEventLoopBlocking.p95Ms).toBeLessThanOrEqual(HOST_BLOCKING_P95_BUDGET_MS);
        expect(report.contendedLocalStorage.hostBlockP95Ms).toBeLessThanOrEqual(HOST_BLOCKING_P95_BUDGET_MS);
        expect(concurrentActionTicksDuringRead).toBeGreaterThan(0);
        expect(maxBytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
        expect(report.warm.maxMs).toBeLessThan(DEFAULT_ACCOUNTING_BOUNDS.queryDeadlineMs);
      } finally {
        await service.close();
        conn.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
