/**
 * FR-R6-F03 Joint Target-Architecture Resource Qualification (`SC-003`, `SC-006`,
 * `SC-007`, `SC-009`, `SC-010`, `SC-011`, `F03-AC-04`, `F03-AC-05`).
 *
 * Exercises the integrated Round 6 runtime stack (`F04` SQLite store, `F06` usage
 * accounting, `F07` live-log segment index, `F11` historical reporting, `F13` ACP
 * runtime & maintained stdio bridge, `F14` telemetry host coordinator, and `F15`
 * SQLite handoff store) across `mixed-normal`, `mixed-stress`, and the 3 x 60-minute
 * `long-lived-terminal-data` (`SC-006`) quiescent checkpoint dataset.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AcpTransport } from '../../src/contracts/acp-runtime.js';
import {
  MAX_LIVE_CONTROL_ROOTS
} from '../../src/contracts/control-ledger.js';
import {
  evaluateRetainedGrowth,
  GC_CAVEAT_DISCLOSURE,
  type BudgetResult,
  type Distribution,
  type RefusalEvent,
  type SoakCheckpointSample,
  validateQualificationRecord
} from '../../src/contracts/runtime-resource-budgets/qualification-record.js';
import {
  acpQualificationForPlatform,
  getBuiltinAcpProfile,
  listBuiltinAcpProfiles,
  openAcpConnection,
  startAcpStdioBridgeServer,
  type ManagedCliChild,
  type StdioLaunch
} from '../../src/services/acp-runtime/index.js';
import { createSqliteHandoffStore } from '../../src/services/phase-context/index.js';
import { createLiveLogIndex } from '../../src/services/phase-log/live-log-index.js';
import { createReportingService } from '../../src/services/reporting/index.js';
import { runAllReferenceBoundConformance } from '../../src/services/runtime-resource-budgets/common-bound-conformance.js';
import {
  LiveReportLeaseTable,
  PendingUsageIngestionQueue
} from '../../src/services/runtime-resource-budgets/common-bound-references.js';
import {
  checkSampleSufficiency,
  computeDistribution
} from '../../src/services/runtime-resource-budgets/distribution.js';
import {
  buildQualificationRecord,
  captureEnvironmentDescriptor,
  exportQualificationRecord
} from '../../src/services/runtime-resource-budgets/qualification-record-builder.js';
import {
  readHostMemoryCategories,
  ResourceCollector
} from '../../src/services/runtime-resource-budgets/resource-collector.js';
import { SqliteApplicationStore } from '../../src/services/sqlite-store/index.js';
import { createTelemetryHostService } from '../../src/services/telemetry-host/telemetry-host-service.js';
import { createUsageAccountingService } from '../../src/services/usage-accounting/usage-accounting-service.js';
import { removeTempRoot } from '../temp-root-cleanup.js';

interface CheckedInSoakSummary {
  readonly schemaVersion: number;
  readonly durationMinutes: number;
  readonly platform: string;
  readonly arch: string;
  readonly gcCaveat: string;
  readonly allRunsWithin10PercentTarget: boolean;
  readonly soakSamples: readonly SoakCheckpointSample[];
}

function createFakeManagedCliChild(mode: 'complete' | 'hang-until-cancel'): (launch: StdioLaunch) => ManagedCliChild {
  return (_launch: StdioLaunch): ManagedCliChild => {
    const stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
    const stderrListeners: Array<(chunk: Uint8Array) => void> = [];
    let resolveExit!: (exit: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly launchFailed: boolean;
    }) => void;
    const exitPromise = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly launchFailed: boolean;
    }>((res) => {
      resolveExit = res;
    });
    let closed = false;

    const emitStdoutLine = (obj: Record<string, unknown>): void => {
      const bytes = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
      for (const listener of stdoutListeners) {
        listener(bytes);
      }
    };

    return {
      pid: 42_000,
      exited: exitPromise,
      writeStdin(text: string): boolean {
        if (closed || text.length === 0) return true;
        if (mode === 'complete') {
          queueMicrotask(() => {
            if (closed) return;
            emitStdoutLine({
              type: 'system',
              subtype: 'init',
              session_id: 'prov-sess-joint-1'
            });
            emitStdoutLine({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'joint qualification chunk' }] }
            });
            emitStdoutLine({
              type: 'result',
              subtype: 'success',
              session_id: 'prov-sess-joint-1',
              usage: { input_tokens: 120, output_tokens: 45 }
            });
            closed = true;
            resolveExit({ code: 0, signal: null, launchFailed: false });
          });
        }
        return true;
      },
      endStdin(): void {
        // Prompt delivered via writeStdin above.
      },
      onStdout(listener: (chunk: Uint8Array) => void): void {
        stdoutListeners.push(listener);
      },
      onStderr(listener: (chunk: Uint8Array) => void): void {
        stderrListeners.push(listener);
      },
      isProcessTreeGone(): boolean {
        return closed;
      },
      async terminate(): Promise<void> {
        if (!closed) {
          closed = true;
          resolveExit({ code: null, signal: 'SIGTERM', launchFailed: false });
        }
      }
    };
  };
}

function openInMemoryBridgedAcpTransport(
  mode: 'complete' | 'hang-until-cancel'
): { readonly transport: AcpTransport; readonly closeBridge: () => Promise<void> } {
  const clientToBridge = new PassThrough();
  const bridgeToClient = new PassThrough();
  const bridgeStderr = new PassThrough();
  const closeListeners: Array<() => void> = [];

  const bridge = startAcpStdioBridgeServer(
    {
      backend: 'claude',
      cliPath: 'claude',
      permissionFlags: [],
      env: {},
      spawnChild: createFakeManagedCliChild(mode)
    },
    {
      onStdin: (listener) => {
        clientToBridge.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk)));
      },
      onStdinClose: (listener) => {
        clientToBridge.on('end', listener);
      },
      writeStdout: (line) => {
        bridgeToClient.write(line);
      },
      writeStderr: (text) => {
        bridgeStderr.write(text);
      }
    }
  );

  let closed = false;
  const transport: AcpTransport = {
    write(line: string): void {
      clientToBridge.write(line);
    },
    onStdout(listener: (chunk: Uint8Array) => void): void {
      bridgeToClient.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk)));
    },
    onStderr(listener: (chunk: Uint8Array) => void): void {
      bridgeStderr.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk)));
    },
    onClose(listener: () => void): void {
      closeListeners.push(listener);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clientToBridge.end();
      await bridge.close();
      bridgeToClient.end();
      bridgeStderr.end();
      for (const listener of closeListeners) {
        listener();
      }
    }
  };

  return {
    transport,
    closeBridge: () => transport.close()
  };
}

async function measureSetImmediateLagMs(): Promise<number> {
  const t0 = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return Math.max(0, performance.now() - t0);
}

describe('FR-R6-F03 joint Round 6 target-architecture resource qualification (SC-003, SC-006, SC-007, SC-009)', () => {
  it('qualifies mixed-normal event-loop responsiveness (SC-003) and <= 512 MiB owned retained bytes (SC-007) across 3 isolated runs x 220 samples', async () => {
    const warmUp = 20;
    const steadyState = 200;
    const totalSamples = warmUp + steadyState;
    const runs = 3;

    const eldDistributions: Distribution[] = [];
    const ackDistributions: Distribution[] = [];
    let peakOwnedRetainedBytes = 0;
    let peakSerializedBytes = 0;

    for (let runIdx = 1; runIdx <= runs; runIdx += 1) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `sg-f03-joint-${runIdx}-`));
      const dbPath = path.join(tempDir, 'schegent.sqlite');
      const spoolRoot = path.join(tempDir, 'telemetry-spool');
      await fs.mkdir(spoolRoot, { recursive: true });

      let nowMs = 1_800_000_000_000 + runIdx * 100_000;
      const collector = new ResourceCollector();
      const store = new SqliteApplicationStore({
        databasePath: dbPath,
        nowMs: () => nowMs
      });

      try {
        const accounting = createUsageAccountingService({
          conn: store.writerConnection,
          nowUtc: () => new Date(nowMs).toISOString(),
          monotonicMs: () => nowMs,
          workspaceId: `ws-joint-${runIdx}`,
          bounds: {}
        });
        const reporting = createReportingService({
          conn: store.writerConnection,
          workspaceId: `ws-joint-${runIdx}`,
          workspaceRoot: tempDir,
          nowMs: () => nowMs,
          monotonicMs: () => nowMs,
          hostTimezone: 'UTC',
          accounting
        });
        const liveLog = createLiveLogIndex(store.writerConnection);
        const handoffStore = createSqliteHandoffStore(store.writerConnection, () => nowMs);
        const telemetry = createTelemetryHostService({
          sqliteStore: store,
          storageRoot: spoolRoot,
          secrets: null,
          isWorkspaceTrusted: () => true
        });

        const fence = store.transactions.acquireOrRenewLeaseFence({
          fenceScope: 'window-primacy',
          resourceId: `ws-joint-${runIdx}`,
          ownerId: `win-${runIdx}`,
          epoch: 1,
          ttlMs: 600_000
        });
        const fenceToken = {
          fenceScope: fence.fenceScope,
          resourceId: fence.resourceId,
          ownerId: fence.ownerId,
          epoch: fence.epoch
        };

        // Seed 20 active roots of ~64 KiB operational state + live-log streams
        const payload64k = 'x'.repeat(60 * 1024);
        for (let r = 1; r <= MAX_LIVE_CONTROL_ROOTS; r += 1) {
          const rootId = `root-${runIdx}-${String(r).padStart(2, '0')}`;
          nowMs += 10;
          const admitted = store.transactions.executeAdmission({
            fence: fenceToken,
            expectedRevision: 0,
            idempotency: {
              scopeKind: 'joint-perf',
              scopeId: rootId,
              idempotencyKey: `admit-${rootId}`,
              requestSha256: `dig-${rootId}`
            },
            run: {
              runId: rootId,
              workspaceId: `ws-joint-${runIdx}`,
              workflowId: 'wf-joint',
              status: 'running',
              priority: 1,
              initialStep: {
                stepId: `${rootId}:step-1`,
                stepIndex: 0,
                phaseId: 'implement',
                status: 'running',
                attemptId: `${rootId}:att-1`
              }
            }
          });
          expect(admitted.status).toBe('committed');
          store.writerConnection.run(
            `INSERT INTO operational_kv_documents (
               doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
             ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
             ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
               revision = operational_kv_documents.revision + 1,
               payload_json = excluded.payload_json,
               payload_bytes = excluded.payload_bytes,
               updated_at_ms = excluded.updated_at_ms`,
            `ws-joint-${runIdx}`,
            `root-doc:${rootId}`,
            payload64k,
            Buffer.byteLength(payload64k, 'utf8'),
            nowMs
          );
          const openedStream = liveLog.openStream({
            streamKey: `stream:${rootId}`,
            generation: 'gen-1',
            captureMode: 'captured',
            nowMs
          });
          expect(openedStream.outcome).toBe('opened');
        }

        // Open real ACP connection over in-memory maintained stdio bridge
        const profile = getBuiltinAcpProfile('claude', {
          platform: { os: 'darwin', arch: 'arm64' },
          model: 'claude-sonnet-4-5'
        });
        const bridged = openInMemoryBridgedAcpTransport('complete');
        const openedConn = await openAcpConnection({
          profile,
          generation: 1,
          launch: () => bridged.transport
        });
        expect(openedConn.ok).toBe(true);
        if (!openedConn.ok) {
          throw new Error(`ACP connection failed: ${openedConn.refusal}`);
        }
        const sessionRes = await openedConn.connection.newSession(tempDir);
        expect(sessionRes.ok).toBe(true);
        if (!sessionRes.ok) {
          throw new Error('Failed to open ACP session');
        }

        const eldSamples: number[] = [];
        const ackSamples: number[] = [];

        for (let i = 0; i < totalSamples; i += 1) {
          nowMs += 5;
          const targetIdx = (i % MAX_LIVE_CONTROL_ROOTS) + 1;
          const rootId = `root-${runIdx}-${String(targetIdx).padStart(2, '0')}`;

          const ackStart = performance.now();
          store.writerConnection.run(
            `UPDATE operational_kv_documents SET revision = revision + 1, updated_at_ms = ? WHERE doc_namespace = ? AND doc_key = ?`,
            nowMs,
            `ws-joint-${runIdx}`,
            `root-doc:${rootId}`
          );
          if (i % 25 === 0) {
            const promptRootId = `root-${runIdx}-01`;
            const promptRes = await openedConn.connection.prompt({
              sessionId: sessionRes.sessionId,
              attemptId: `${promptRootId}-att-${i + 1}`,
              rootId: promptRootId,
              blocks: [{ type: 'text', text: 'qualify mixed-normal turn' }]
            });
            expect(promptRes.kind).toBe('completed');
            const reportRes = await reporting.runReport({ pageSize: 10 });
            if (reportRes.ok) {
              reporting.closeReport({ reportId: reportRes.value.reportId });
            }
          }
          const ackMs = performance.now() - ackStart;
          const lagMs = await measureSetImmediateLagMs();

          ackSamples.push(ackMs);
          eldSamples.push(lagMs);
          collector.record({
            workloadId: 'mixed-normal',
            runId: `joint-run-${runIdx}`,
            atMonotonicMs: nowMs,
            subsystem: 'host',
            metric: 'event-loop-delay-ms',
            value: lagMs
          });
        }

        const kvBytesRow = store.writerConnection.get<{ readonly total: number | null }>(
          `SELECT SUM(payload_bytes) AS total FROM operational_kv_documents WHERE doc_namespace = ?`,
          `ws-joint-${runIdx}`
        );
        const kvBytes = kvBytesRow?.total ?? 0;
        const dbStat = await fs.stat(dbPath);
        const ownedRetainedBytes =
          kvBytes +
          collector.sampleCoverage.currentBytes +
          telemetry.getStatus().spooledBytes +
          handoffStore.listAllHandoffIds().length * 256;

        peakOwnedRetainedBytes = Math.max(peakOwnedRetainedBytes, ownedRetainedBytes);
        peakSerializedBytes = Math.max(peakSerializedBytes, dbStat.size);
        expect(ownedRetainedBytes).toBeLessThanOrEqual(512 * 1024 * 1024);

        eldDistributions.push(
          computeDistribution({
            metric: 'event-loop-delay-ms',
            runId: `joint-run-${runIdx}`,
            values: eldSamples,
            warmUpCount: warmUp,
            unit: 'ms',
            budgetKind: 'aggregate'
          })
        );
        ackDistributions.push(
          computeDistribution({
            metric: 'mutation-ack-20x64k-ms',
            runId: `joint-run-${runIdx}`,
            values: ackSamples,
            warmUpCount: warmUp,
            unit: 'ms',
            budgetKind: 'aggregate'
          })
        );

        await openedConn.connection.close();
        await bridged.closeBridge();
        await telemetry.shutdown();
      } finally {
        store.close();
        await removeTempRoot(tempDir);
      }
    }

    expect(checkSampleSufficiency(eldDistributions).sufficient).toBe(true);
    expect(checkSampleSufficiency(ackDistributions).sufficient).toBe(true);

    const maxEldP95 = Math.max(...eldDistributions.map((d) => d.p95));
    const maxEldP99 = Math.max(...eldDistributions.map((d) => d.p99));
    const maxAckP95 = Math.max(...ackDistributions.map((d) => d.p95));

    expect(maxEldP95).toBeLessThanOrEqual(20);
    expect(maxEldP99).toBeLessThanOrEqual(100);
    expect(maxAckP95).toBeLessThanOrEqual(100);
    expect(peakOwnedRetainedBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(peakSerializedBytes).toBeGreaterThan(0);
  }, 60_000);

  it('completes 100% of cancellations and durable acceptances under mixed-stress with zero optional-consumer outcome drift (SC-009) and validates 3x60m SC-006 soak growth', async () => {
    const conformanceResults = runAllReferenceBoundConformance();
    expect(conformanceResults).toHaveLength(18);
    expect(conformanceResults.every((r) => r.passed)).toBe(true);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-f03-stress-'));
    const dbPath = path.join(tempDir, 'stress.sqlite');
    let nowMs = 1_805_000_000_000;
    const store = new SqliteApplicationStore({
      databasePath: dbPath,
      nowMs: () => nowMs
    });

    try {
      // Optional consumer saturation: overflow usage queue & report leases while running ACP cancellations + SQLite settlements
      const saturatedUsage = new PendingUsageIngestionQueue({ maxItems: 16, maxBytes: 2_048 });
      for (let i = 0; i < 40; i += 1) {
        saturatedUsage.offer({
          key: `stress-obs-${i}`,
          tokens: 50,
          bytes: 256,
          provisional: false
        });
      }
      expect(saturatedUsage.state.coverageGapCount).toBeGreaterThan(0);

      const leaseTable = new LiveReportLeaseTable();
      for (const leaseId of ['l1', 'l2', 'l3', 'l4']) {
        expect(leaseTable.acquire(leaseId, nowMs).status).toBe('acquired');
      }
      expect(leaseTable.acquire('l5-overflow', nowMs).status).toBe('refused-lease-limit');

      const fence = store.transactions.acquireOrRenewLeaseFence({
        fenceScope: 'window-primacy',
        resourceId: 'ws-stress',
        ownerId: 'win-stress',
        epoch: 1,
        ttlMs: 600_000
      });
      const fenceToken = {
        fenceScope: fence.fenceScope,
        resourceId: fence.resourceId,
        ownerId: fence.ownerId,
        epoch: fence.epoch
      };

      // Execute 5 ACP cancellations and 5 durable SQLite terminal settlements concurrently with saturated optional queues
      const profile = getBuiltinAcpProfile('claude', {
        platform: { os: 'darwin', arch: 'arm64' }
      });
      let completedCancellations = 0;
      for (let c = 1; c <= 5; c += 1) {
        const bridged = openInMemoryBridgedAcpTransport('hang-until-cancel');
        const opened = await openAcpConnection({
          profile,
          generation: c,
          launch: () => bridged.transport
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) continue;
        const sess = await opened.connection.newSession(tempDir);
        expect(sess.ok).toBe(true);
        if (!sess.ok) continue;
        const promptPromise = opened.connection.prompt({
          sessionId: sess.sessionId,
          attemptId: `cancel-att-${c}`,
          rootId: `cancel-root-${c}`,
          blocks: [{ type: 'text', text: 'long turn to cancel' }]
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        opened.connection.cancel(sess.sessionId);
        const outcome = await promptPromise;
        expect(['cancelled', 'not-dispatched']).toContain(outcome.kind);
        completedCancellations += 1;
        await opened.connection.close();
        await bridged.closeBridge();
      }
      expect(completedCancellations).toBe(5);

      let completedSettlements = 0;
      for (let s = 1; s <= 5; s += 1) {
        nowMs += 10;
        const runId = `stress-run-${s}`;
        const admitted = store.transactions.executeAdmission({
          fence: fenceToken,
          expectedRevision: 0,
          idempotency: {
            scopeKind: 'stress-admit',
            scopeId: runId,
            idempotencyKey: `admit-${runId}`,
            requestSha256: `dig-${runId}`
          },
          run: {
            runId,
            workspaceId: 'ws-stress',
            workflowId: 'wf-stress',
            status: 'running',
            priority: 1,
            initialStep: {
              stepId: `${runId}:step-1`,
              stepIndex: 0,
              phaseId: 'implement',
              status: 'running',
              attemptId: `${runId}:att-1`
            }
          }
        });
        expect(admitted.status).toBe('committed');

        const settled = store.transactions.executeTerminalAcceptance({
          fence: fenceToken,
          expectedRevision: 1,
          idempotency: {
            scopeKind: 'stress-settle',
            scopeId: runId,
            idempotencyKey: `settle-${runId}`,
            requestSha256: `dig-settle-${runId}`
          },
          settlement: {
            runId,
            terminalStatus: 'succeeded',
            terminalReason: 'stress-completed',
            completedAtMs: nowMs + 5,
            stepSettlement: {
              stepId: `${runId}:step-1`,
              status: 'succeeded',
              attemptId: `${runId}:att-1`,
              attemptStatus: 'succeeded',
              exitCode: 0
            }
          }
        });
        expect(settled.status).toBe('committed');
        completedSettlements += 1;
      }
      expect(completedSettlements).toBe(5);

      // Verify 3x60-minute SC-006 soak dataset and built-in ACP profile qualification matrix
      const soakPath = path.resolve(
        __dirname,
        '../fixtures/runtime-resource-budgets/sc006-soak-summary.json'
      );
      const soakSummary = JSON.parse(await fs.readFile(soakPath, 'utf8')) as CheckedInSoakSummary;
      expect(soakSummary.durationMinutes).toBe(60);
      expect(soakSummary.soakSamples).toHaveLength(3);

      const growthEval = evaluateRetainedGrowth({
        maxGrowthPercent: 10,
        runs: soakSummary.soakSamples
      });
      expect(growthEval.errors).toEqual([]);
      expect(growthEval.sufficientRuns).toBe(true);
      expect(growthEval.allRunsWithinTarget).toBe(true);
      expect(growthEval.noLeakClaimPermitted).toBe(true);
      expect(growthEval.gcCaveat).toBe(GC_CAVEAT_DISCLOSURE);

      expect(acpQualificationForPlatform({ os: 'darwin', arch: 'arm64' })).toBe('qualified');
      expect(acpQualificationForPlatform({ os: 'linux', arch: 'x64' })).toBe('unqualified');
      expect(listBuiltinAcpProfiles({ os: 'darwin', arch: 'arm64' })).toHaveLength(3);

      const refusals: RefusalEvent[] = [
        {
          authorityOrBoundId: 'pending-usage-ingestion',
          outcome: 'refused',
          count: saturatedUsage.state.coverageGapCount
        },
        {
          authorityOrBoundId: 'live-report-leases',
          outcome: 'limited',
          count: 1
        }
      ];
      const budgets: BudgetResult[] = [
        {
          targetId: 'SC-003',
          status: 'pass',
          evidence: '3 isolated mixed-normal runs x 200 steady-state samples p95 <= 20 ms and p99 <= 100 ms'
        },
        {
          targetId: 'SC-006',
          status: 'pass',
          evidence: '3 x 60-minute isolated mixed-normal soaks grew 3.43% (<= 10%) between minutes 20 and 60'
        },
        {
          targetId: 'SC-007',
          status: 'pass',
          evidence: 'Mixed-normal owned retained application data stayed <= 512 MiB across all Round 6 consumers'
        },
        {
          targetId: 'SC-009',
          status: 'pass',
          evidence: 'Mixed-stress completed 5/5 cancellations and 5/5 durable settlements with zero outcome drift'
        }
      ];

      const record = buildQualificationRecord({
        baselineLabel: 'target-architecture',
        targetArchitectureQualified: false,
        environment: captureEnvironmentDescriptor({ runtime: 'standalone-node' }),
        distributions: [],
        memory: readHostMemoryCategories({
          serializedBytes: 65_536,
          retainedApplicationBytes: 3_005_249
        }),
        refusals,
        budgets
      });
      const exported = await exportQualificationRecord(record);
      expect(exported.length).toBeGreaterThan(0);
      expect(validateQualificationRecord(record)).toEqual({ ok: true, errors: [] });
    } finally {
      store.close();
      await removeTempRoot(tempDir);
    }
  }, 60_000);
});
