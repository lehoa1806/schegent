/**
 * FR-R6-F04 (F04-A, FR-001, SC-001) — SQLite engine qualification evaluator
 * and comparative benchmark harness (`>= 200` measured samples after `20`
 * warm-up samples per operation under the F03 benchmark protocol).
 *
 * Compares incremental `BEGIN IMMEDIATE` SQLite transaction units against
 * legacy whole-state Memento JSON clone/serialize writes.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { performance } from 'node:perf_hooks';
import {
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES,
  SQLITE_MIN_SUPPORTED_ENGINE_VERSION,
  type LatencyDistributionSummary,
  type SqliteQualificationReport
} from '../../contracts/sqlite-store/schema-types';
import { SchemaBootstrapService } from './schema-bootstrap';
import { BoundedReadConnectionPool, NodeSqliteConnection } from './sqlite-driver';
import { AtomicTransactionUnitsService } from './transaction-units';
import { WriterCoordinator } from './writer-coordinator';

export function compareSemverFloor(version: string, floor: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.trim().split('.').map((n) => Number(n));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [vMaj, vMin, vPat] = parse(version);
  const [fMaj, fMin, fPat] = parse(floor);
  if (vMaj !== fMaj) return vMaj > fMaj;
  if (vMin !== fMin) return vMin > fMin;
  return vPat >= fPat;
}

function computePercentile(sortedSamples: readonly number[], percentile: number): number {
  if (sortedSamples.length === 0) return 0;
  const idx = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedSamples.length) - 1)
  );
  return Number(sortedSamples[idx]!.toFixed(4));
}

export function measureOperationDistribution(params: {
  readonly operationName: string;
  readonly warmupSamples?: number | undefined;
  readonly measuredSamples?: number | undefined;
  readonly step: (sampleIndex: number) => void;
}): LatencyDistributionSummary {
  const warmup = params.warmupSamples ?? SQLITE_BENCHMARK_WARMUP_SAMPLES;
  const measured = params.measuredSamples ?? SQLITE_BENCHMARK_MEASURED_SAMPLES;

  if (warmup < SQLITE_BENCHMARK_WARMUP_SAMPLES || measured < SQLITE_BENCHMARK_MEASURED_SAMPLES) {
    throw new Error(
      `BENCHMARK_SAMPLE_FLOOR_VIOLATION: requires >= ${SQLITE_BENCHMARK_WARMUP_SAMPLES} warm-up and >= ${SQLITE_BENCHMARK_MEASURED_SAMPLES} measured samples`
    );
  }

  for (let i = 0; i < warmup; i += 1) {
    params.step(i);
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const latenciesMs: number[] = [];
  let failureCount = 0;

  for (let i = 0; i < measured; i += 1) {
    const t0 = performance.now();
    try {
      params.step(warmup + i);
    } catch {
      failureCount += 1;
    }
    const elapsed = performance.now() - t0;
    latenciesMs.push(elapsed);
  }

  const heapAfter = process.memoryUsage().heapUsed;
  const sorted = [...latenciesMs].sort((a, b) => a - b);

  return {
    operationName: params.operationName,
    warmupSamples: warmup,
    measuredSamples: measured,
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95),
    p99Ms: computePercentile(sorted, 99),
    maxMs: sorted.length > 0 ? Number(sorted[sorted.length - 1]!.toFixed(4)) : 0,
    failureCount,
    heapDeltaBytes: Math.max(0, heapAfter - heapBefore)
  };
}

export class EngineQualificationService {
  public static runQualificationSuite(options?: {
    readonly warmupSamples?: number | undefined;
    readonly measuredSamples?: number | undefined;
  }): SqliteQualificationReport {
    const warmupSamples = options?.warmupSamples ?? SQLITE_BENCHMARK_WARMUP_SAMPLES;
    const measuredSamples = options?.measuredSamples ?? SQLITE_BENCHMARK_MEASURED_SAMPLES;

    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    const readPool = new BoundedReadConnectionPool(':memory:');

    try {
      const bootstrap = SchemaBootstrapService.bootstrapAndMigrate(conn);
      const runtimeMeta = conn.inspectRuntimeMetadata();
      const meetsFloor = compareSemverFloor(
        runtimeMeta.sqliteVersion,
        SQLITE_MIN_SUPPORTED_ENGINE_VERSION
      );

      const writer = new WriterCoordinator(conn, readPool);
      const txUnits = new AtomicTransactionUnitsService(conn, writer);
      txUnits.acquireOrRenewLeaseFence({
        fenceScope: 'window_primacy',
        resourceId: 'ws-qual',
        ownerId: 'qual-owner',
        epoch: 1,
        ttlMs: 600_000
      });

      const sqliteAdmissionDist = measureOperationDistribution({
        operationName: 'sqlite_incremental_admission_and_settlement',
        warmupSamples,
        measuredSamples,
        step: (idx) => {
          const runId = `run-qual-${idx}`;
          const admitOut = txUnits.executeAdmission({
            idempotency: {
              scopeKind: 'run',
              scopeId: runId,
              idempotencyKey: `admit-${idx}`,
              requestSha256: `sha-admit-${idx}`
            },
            fence: {
              fenceScope: 'window_primacy',
              resourceId: 'ws-qual',
              ownerId: 'qual-owner',
              epoch: 1
            },
            expectedRevision: 0,
            run: {
              runId,
              workspaceId: 'ws-qual',
              workflowId: 'wf-qual',
              priority: 1,
              inputs: { sample: idx },
              initialStep: {
                stepId: `step-${idx}`,
                stepIndex: 0,
                phaseId: 'implement',
                attemptId: `att-${idx}`
              }
            }
          });
          if (admitOut.status !== 'committed') {
            throw new Error(`Qualification admission failed: ${admitOut.code}`);
          }

          const termOut = txUnits.executeTerminalAcceptance({
            idempotency: {
              scopeKind: 'run',
              scopeId: runId,
              idempotencyKey: `term-${idx}`,
              requestSha256: `sha-term-${idx}`
            },
            fence: {
              fenceScope: 'window_primacy',
              resourceId: 'ws-qual',
              ownerId: 'qual-owner',
              epoch: 1
            },
            expectedRevision: 1,
            settlement: {
              runId,
              terminalStatus: 'succeeded',
              terminalReason: 'qualification_complete',
              stepSettlement: {
                stepId: `step-${idx}`,
                status: 'succeeded',
                attemptId: `att-${idx}`,
                attemptStatus: 'succeeded',
                exitCode: 0
              }
            }
          });
          if (termOut.status !== 'committed') {
            throw new Error(`Qualification settlement failed: ${termOut.code}`);
          }
        }
      });

      const sqliteKeysetDist = measureOperationDistribution({
        operationName: 'sqlite_keyset_summary_page_query',
        warmupSamples,
        measuredSamples,
        step: () => {
          const rows = conn.all(
            `SELECT run_id, status, revision, updated_at_ms
             FROM execution_summary_revisions
             WHERE workspace_id = 'ws-qual' AND revision <= 999999
             ORDER BY updated_at_ms DESC, run_id DESC
             LIMIT 25`
          );
          if (rows.length === 0) {
            throw new Error('Expected summary rows');
          }
        }
      });

      // Baseline comparison: legacy whole-map Memento clone + JSON serialize of 250 runs
      const legacyMap: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < 200; i += 1) {
        legacyMap[`run-seed-${i}`] = {
          runId: `run-seed-${i}`,
          workspaceId: 'ws-qual',
          workflowId: 'wf-qual',
          status: 'succeeded',
          revision: 2,
          steps: [{ stepId: `step-${i}`, status: 'succeeded', logs: 'x'.repeat(256) }]
        };
      }

      const legacyMementoDist = measureOperationDistribution({
        operationName: 'legacy_whole_map_memento_clone_write',
        warmupSamples,
        measuredSamples,
        step: (idx) => {
          const cloned = structuredClone(legacyMap);
          cloned[`run-live-${idx % 50}`] = {
            runId: `run-live-${idx % 50}`,
            workspaceId: 'ws-qual',
            workflowId: 'wf-qual',
            status: 'queued',
            revision: idx + 1,
            steps: [{ stepId: `step-${idx}`, status: 'queued', logs: 'y'.repeat(256) }]
          };
          const serialized = JSON.stringify(cloned);
          if (serialized.length === 0) {
            throw new Error('Empty serialization');
          }
        }
      });

      const fkViolations = conn.runForeignKeyCheck().length;
      const qualificationPassed =
        meetsFloor &&
        conn.verifiedPragmas.synchronous === 2 &&
        bootstrap.strictTableCount >= 78 &&
        fkViolations === 0 &&
        sqliteAdmissionDist.failureCount === 0 &&
        sqliteKeysetDist.failureCount === 0;

      return {
        engineName: 'node:sqlite',
        sqliteVersion: runtimeMeta.sqliteVersion,
        sqliteSourceId: runtimeMeta.sqliteSourceId,
        meetsMinimumVersionFloor: meetsFloor,
        compileOptions: runtimeMeta.compileOptions,
        verifiedPragmas: conn.verifiedPragmas,
        strictSchemaTableCount: bootstrap.strictTableCount,
        foreignKeyCheckViolations: fkViolations,
        sqliteBenchmarks: [sqliteAdmissionDist, sqliteKeysetDist],
        legacyMementoBenchmarks: [legacyMementoDist],
        qualificationPassed
      };
    } finally {
      readPool.closeAll();
      conn.close();
    }
  }
}
