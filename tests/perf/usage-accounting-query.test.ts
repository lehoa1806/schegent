// FR-R6-F06 (T052; NFR-003, SC-006) — accounting reads at 100,000 retained attempts.
//
// 100,000 attempts, each with one invocation carrying four measures (input, output and cache-read
// tokens, and cost), ingested through the facade so the projection writes the contributions.
// Attempts spread over two backends, four models and 500 phases. Each read groups by phase,
// filters one backend and asks for the 200-row page bound, cycling through every cursor.
//
// Sample counts follow the F03 floor that `measureOperationDistribution` enforces (20 warm-up,
// 200 measured), which is stricter than the task's 5/50: the helper refuses fewer.

import * as os from 'node:os';
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
