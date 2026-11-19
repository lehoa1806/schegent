/**
 * FR-R7-02 (FR-001, FR-002, FR-003, SC-001, SC-002) — Repeatable perf-tier
 * benchmark of `SqliteOperationalBacking` commit latency, read-clone latency,
 * `pruneConnectedRunsMap` cost, and host event-loop delay on an on-disk
 * `WAL` + `PRAGMA synchronous = FULL` database.
 *
 * Runs strictly in `npm run test:perf` (`vitest.perf.config.ts`, single-threaded)
 * and is excluded from hermetic `npm run test:host`.
 */

import { describe, expect, it } from 'vitest';
import {
  captureBenchmarkEnvironment,
  evaluateDecisionGate,
  OPERATIONAL_WORKLOAD_TIERS,
  runOperationalLatencyTier,
  type TierBenchmarkReport
} from './helpers/sqlite-operational-latency-harness.js';

function fmtMs(value: number): string {
  return value.toFixed(3);
}

describe('FR-R7-02 SQLite operational state commit latency & event-loop delay (perf tier)', () => {
  it(
    'measures separated write-commit, read-clone, prune, and event-loop delay across all four documented workload tiers and evaluates the Round 6 decision gate',
    { timeout: 180_000 },
    async () => {
      const reports: TierBenchmarkReport[] = [];

      for (const tierSpec of OPERATIONAL_WORKLOAD_TIERS) {
        const report = await runOperationalLatencyTier(tierSpec);
        reports.push(report);

        // Verify production durability pragmas held for every tier
        expect(report.pragmaVerified.journalMode).toBe('wal');
        expect(report.pragmaVerified.synchronous).toBe(2);
        expect(report.pragmaVerified.foreignKeys).toBe(1);
        expect(report.pragmaVerified.busyTimeout).toBe(250);

        // Verify SC-002 sample sufficiency across 3 isolated runs
        expect(report.runs.length).toBe(3);
        for (const run of report.runs) {
          expect(run.writeQueueCommit.rawCount).toBe(220);
          expect(run.writeQueueCommit.warmUpCount).toBe(20);
          expect(run.writeQueueCommit.p95).toBeGreaterThanOrEqual(run.writeQueueCommit.p50);
          expect(run.writeQueueCommit.p99).toBeGreaterThanOrEqual(run.writeQueueCommit.p95);
          expect(run.writeQueueCommit.max).toBeGreaterThanOrEqual(run.writeQueueCommit.p99);

          expect(run.writeRunCommit.rawCount).toBe(220);
          expect(run.writeHistoryCommit.rawCount).toBe(220);
          expect(run.writeConnectedRunsCommit.rawCount).toBe(220);
          expect(run.pruneConnectedRunsOnly.rawCount).toBe(220);

          expect(run.readQueueClone.rawCount).toBe(220);
          expect(run.readRunClone.rawCount).toBe(220);
          expect(run.readHistoryClone.rawCount).toBe(220);
          expect(run.readConnectedRunsClone.rawCount).toBe(220);

          expect(run.eventLoopDelay.sampleCount).toBeGreaterThanOrEqual(200);
          expect(run.eventLoopDelay.p95Ms).toBeGreaterThanOrEqual(run.eventLoopDelay.p50Ms);
          expect(run.eventLoopDelay.p99Ms).toBeGreaterThanOrEqual(run.eventLoopDelay.p95Ms);

          if (tierSpec.measureAtomicAdmissionBatch) {
            expect(run.writeAdmissionBatchCommit).toBeDefined();
            expect(run.writeAdmissionBatchCommit!.rawCount).toBe(220);
          }
        }
      }

      const env = captureBenchmarkEnvironment(reports[0]!.pragmaVerified.sqliteVersion);
      const verdict = evaluateDecisionGate(reports);

      // Emit machine-readable + human-readable summary for the committed measurement record.
      if (process.env.SCHEGENT_PRINT_R7_02_REPORT === '1') {
        console.log(
          JSON.stringify(
            {
              environment: env,
              verdict,
              tiers: reports.map((r) => ({
                tierId: r.spec.tierId,
                pragmaVerified: r.pragmaVerified,
                payloadBytes: r.runs[0]!.payloadBytes,
                runs: r.runs.map((run) => ({
                  runId: run.runId,
                  writeQueue: {
                    p50: Number(fmtMs(run.writeQueueCommit.p50)),
                    p95: Number(fmtMs(run.writeQueueCommit.p95)),
                    p99: Number(fmtMs(run.writeQueueCommit.p99)),
                    max: Number(fmtMs(run.writeQueueCommit.max))
                  },
                  writeRun: {
                    p50: Number(fmtMs(run.writeRunCommit.p50)),
                    p95: Number(fmtMs(run.writeRunCommit.p95)),
                    p99: Number(fmtMs(run.writeRunCommit.p99)),
                    max: Number(fmtMs(run.writeRunCommit.max))
                  },
                  writeHistory: {
                    p50: Number(fmtMs(run.writeHistoryCommit.p50)),
                    p95: Number(fmtMs(run.writeHistoryCommit.p95)),
                    p99: Number(fmtMs(run.writeHistoryCommit.p99)),
                    max: Number(fmtMs(run.writeHistoryCommit.max))
                  },
                  writeConnectedRuns: {
                    p50: Number(fmtMs(run.writeConnectedRunsCommit.p50)),
                    p95: Number(fmtMs(run.writeConnectedRunsCommit.p95)),
                    p99: Number(fmtMs(run.writeConnectedRunsCommit.p99)),
                    max: Number(fmtMs(run.writeConnectedRunsCommit.max))
                  },
                  pruneConnectedRunsOnly: {
                    p50: Number(fmtMs(run.pruneConnectedRunsOnly.p50)),
                    p95: Number(fmtMs(run.pruneConnectedRunsOnly.p95)),
                    p99: Number(fmtMs(run.pruneConnectedRunsOnly.p99)),
                    max: Number(fmtMs(run.pruneConnectedRunsOnly.max))
                  },
                  ...(run.writeAdmissionBatchCommit
                    ? {
                        writeAdmissionBatch: {
                          p50: Number(fmtMs(run.writeAdmissionBatchCommit.p50)),
                          p95: Number(fmtMs(run.writeAdmissionBatchCommit.p95)),
                          p99: Number(fmtMs(run.writeAdmissionBatchCommit.p99)),
                          max: Number(fmtMs(run.writeAdmissionBatchCommit.max))
                        }
                      }
                    : {}),
                  readQueueClone: {
                    p50: Number(fmtMs(run.readQueueClone.p50)),
                    p95: Number(fmtMs(run.readQueueClone.p95)),
                    p99: Number(fmtMs(run.readQueueClone.p99)),
                    max: Number(fmtMs(run.readQueueClone.max))
                  },
                  readRunClone: {
                    p50: Number(fmtMs(run.readRunClone.p50)),
                    p95: Number(fmtMs(run.readRunClone.p95)),
                    p99: Number(fmtMs(run.readRunClone.p99)),
                    max: Number(fmtMs(run.readRunClone.max))
                  },
                  readHistoryClone: {
                    p50: Number(fmtMs(run.readHistoryClone.p50)),
                    p95: Number(fmtMs(run.readHistoryClone.p95)),
                    p99: Number(fmtMs(run.readHistoryClone.p99)),
                    max: Number(fmtMs(run.readHistoryClone.max))
                  },
                  readConnectedRunsClone: {
                    p50: Number(fmtMs(run.readConnectedRunsClone.p50)),
                    p95: Number(fmtMs(run.readConnectedRunsClone.p95)),
                    p99: Number(fmtMs(run.readConnectedRunsClone.p99)),
                    max: Number(fmtMs(run.readConnectedRunsClone.max))
                  },
                  eventLoopDelay: {
                    p50: Number(fmtMs(run.eventLoopDelay.p50Ms)),
                    p95: Number(fmtMs(run.eventLoopDelay.p95Ms)),
                    p99: Number(fmtMs(run.eventLoopDelay.p99Ms)),
                    max: Number(fmtMs(run.eventLoopDelay.maxMs)),
                    sampleCount: run.eventLoopDelay.sampleCount
                  },
                  timerLateness: {
                    p50: Number(fmtMs(run.timerLateness.p50)),
                    p95: Number(fmtMs(run.timerLateness.p95)),
                    p99: Number(fmtMs(run.timerLateness.p99)),
                    max: Number(fmtMs(run.timerLateness.max))
                  }
                }))
              }))
            },
            null,
            2
          )
        );
      }

      expect(['defer-migration-9', 'proceed-migration-9']).toContain(verdict.outcome);
      expect(verdict.budgetP95Ms).toBe(20);
      expect(verdict.budgetP99Ms).toBe(100);
      expect(env.sqliteVersion.length).toBeGreaterThan(0);
    }
  );
});
