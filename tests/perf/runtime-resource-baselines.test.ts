import { performance } from 'node:perf_hooks';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type ControlFrame,
  type ExecutionFence,
  MAX_LIVE_CONTROL_ROOTS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES
} from '../../src/contracts/control-ledger.js';
import type {
  BudgetResult,
  Distribution
} from '../../src/contracts/runtime-resource-budgets/qualification-record.js';
import { validateQualificationRecord } from '../../src/contracts/runtime-resource-budgets/qualification-record.js';
import { DEFAULT_MAX_LINE_UNITS, LineFramer } from '../../src/lib/line-framer.js';
import {
  MAX_STREAM_BUFFER_BYTES,
  readStreamPressure,
  resetStreamPressure,
  STREAM_TRUNCATION_MARKER,
  ZippedStreamBuffer
} from '../../src/runner/zipped-stream-buffer.js';
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
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission.js';
import {
  ControlLedgerStore,
  measureRootLedgerBytes
} from '../../src/services/workflow-execution/control-ledger-store.js';
import type { Memento } from '../../src/state/workspace-state.js';

function createFastInMemoryMemento(): Memento & {
  lastSerializedBytes: number;
  lastPersistenceWaitMs: number;
} {
  const map = new Map<string, string>();
  const state = {
    lastSerializedBytes: 0,
    lastPersistenceWaitMs: 0,
    get<T>(key: string): T | undefined {
      const raw = map.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    update(key: string, value: unknown): Thenable<void> {
      const t0 = performance.now();
      if (value === undefined) {
        map.delete(key);
        state.lastSerializedBytes = 0;
      } else {
        const json = JSON.stringify(value);
        state.lastSerializedBytes = Buffer.byteLength(json, 'utf8');
        map.set(key, json);
      }
      state.lastPersistenceWaitMs = performance.now() - t0;
      return Promise.resolve();
    }
  };
  return state;
}

const DEFAULT_FENCE: ExecutionFence = {
  primacyClaim: 'primacy-perf-1',
  queueClaim: 'queue-perf-1',
  rootGeneration: 1
};

function buildFramesToTargetBytes(
  existing: Readonly<Record<string, ControlFrame>>,
  targetBytes: number
): Record<string, ControlFrame> {
  const frames: Record<string, ControlFrame> = { ...existing };
  const payload = 'p'.repeat(2_000);
  const frameApproxBytes = 2_202;
  const needed = Math.min(945, Math.max(1, Math.floor(targetBytes / frameApproxBytes)));
  for (let i = 0; i < needed; i += 1) {
    const k = `f-${String(i).padStart(4, '0')}`;
    frames[k] = {
      frameKey: k,
      parentFrameKey: 'root',
      invocationId: `inv-${k}-${payload}`,
      workflowId: 'wf-perf',
      kind: 'child-workflow',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      dispatchedCount: 1
    };
  }
  return frames;
}

type StreamShape = 'ordinary-text' | 'incompressible' | 'giant-line' | 'no-newline';

function makeDeterministicIncompressibleChunk(sizeBytes: number, seed: number): string {
  // Deterministic PRNG base64 characters to defeat gzip repetition
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chars = new Array<string>(sizeBytes);
  let state = seed >>> 0;
  for (let i = 0; i < sizeBytes; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    chars[i] =
      i > 0 && i % 128 === 0 ? '\n' : (alphabet[state & 63] ?? 'A');
  }
  return chars.join('');
}

function buildShapeChunks(shape: StreamShape): readonly string[] {
  const chunkSize = 256 * 1024;
  switch (shape) {
    case 'ordinary-text': {
      const line = `${'{"type":"assistant","text":"structured log output linewith newline"}'.padEnd(127, 'x')}\n`;
      const chunk = line.repeat(chunkSize / 128);
      return [chunk, chunk, chunk, chunk, chunk, chunk]; // 1.5 MiB
    }
    case 'incompressible': {
      const c1 = makeDeterministicIncompressibleChunk(chunkSize, 302_101);
      const c2 = makeDeterministicIncompressibleChunk(chunkSize, 302_202);
      const c3 = makeDeterministicIncompressibleChunk(chunkSize, 302_303);
      return [c1, c2, c3, c1, c2, c3]; // 1.5 MiB
    }
    case 'giant-line': {
      // Single 2 MiB line followed by newline
      const body = 'g'.repeat(chunkSize);
      return [body, body, body, body, body, body, body, `${body}\n`]; // 2 MiB
    }
    case 'no-newline': {
      const body = 'n'.repeat(chunkSize);
      return [body, body, body, body, body, body]; // 1.5 MiB with zero newlines
    }
  }
}

describe('runtime-resource-baselines (T018, T030, FR-003, FR-005, FR-006, SC-002, SC-004)', () => {
  beforeEach(() => {
    resetStreamPressure();
  });

  it('enforces ZippedStreamBuffer and LineFramer bounds across stream concurrencies 1, 2, 4, 8, and 20 and all 4 output shapes (T018, FR-006)', async () => {
    const concurrencies = [1, 2, 4, 8, 20] as const;
    const shapes: readonly StreamShape[] = [
      'ordinary-text',
      'incompressible',
      'giant-line',
      'no-newline'
    ];
    const reducedMaxBytes = 1024 * 1024; // 1 MiB cap to force overflow on 1.5-2 MiB bursts
    const reducedFlushBytes = 256 * 1024;
    const collector = new ResourceCollector();

    const precomputedChunks = new Map<StreamShape, readonly string[]>();
    for (const shape of shapes) {
      precomputedChunks.set(shape, buildShapeChunks(shape));
    }

    for (const shape of shapes) {
      const chunks = precomputedChunks.get(shape)!;
      for (const concurrency of concurrencies) {
        const buffers = Array.from(
          { length: concurrency },
          () => new ZippedStreamBuffer(reducedFlushBytes, reducedMaxBytes)
        );
        const framers = Array.from(
          { length: concurrency },
          () => new LineFramer(DEFAULT_MAX_LINE_UNITS)
        );

        for (const chunk of chunks) {
          const probeScheduledAt = performance.now();
          for (let s = 0; s < concurrency; s += 1) {
            buffers[s]!.append(chunk);
            framers[s]!.append(chunk);
            expect(buffers[s]!.retainedBytes).toBeLessThanOrEqual(reducedMaxBytes);
            expect(framers[s]!.retainedUnits).toBeLessThanOrEqual(DEFAULT_MAX_LINE_UNITS);
          }
          await new Promise<void>((resolve) => {
            setImmediate(() => {
              const latenessMs = Math.max(0, performance.now() - probeScheduledAt);
              collector.record({
                workloadId: 'stream-matrix',
                runId: `${shape}-c${concurrency}`,
                atMonotonicMs: performance.now(),
                subsystem: 'runner-stream',
                metric: 'control-probe-lateness-ms',
                value: latenessMs
              });
              resolve();
            });
          });
        }

        for (let s = 0; s < concurrency; s += 1) {
          const buf = buffers[s]!;
          const framer = framers[s]!;
          framer.flush();
          expect(buf.truncated).toBe(true);
          expect(buf.retainedBytes).toBeLessThanOrEqual(reducedMaxBytes);
          const decompressed = Array.from(buf.decompressStream()).join('');
          expect(decompressed).toContain(STREAM_TRUNCATION_MARKER);

          if (shape === 'giant-line' || shape === 'no-newline') {
            expect(framer.totals.truncatedLines).toBeGreaterThan(0);
            expect(framer.totals.droppedUnits).toBeGreaterThan(0);
          } else {
            expect(framer.totals.truncatedLines).toBe(0);
          }
          buf.finalize();
        }
        expect(readStreamPressure().liveBuffers).toBe(0);
      }
    }

    // Production 64 MiB cap sanity check at concurrency 20
    const prodBuffers = Array.from(
      { length: 20 },
      () => new ZippedStreamBuffer(1024 * 1024, MAX_STREAM_BUFFER_BYTES)
    );
    const prodChunk = precomputedChunks.get('ordinary-text')![0]!;
    for (const buf of prodBuffers) {
      buf.append(prodChunk);
      expect(buf.retainedBytes).toBeLessThanOrEqual(MAX_STREAM_BUFFER_BYTES);
    }
    expect(readStreamPressure().liveBuffers).toBe(20);
    for (const buf of prodBuffers) {
      buf.finalize();
    }
    expect(readStreamPressure().liveBuffers).toBe(0);
    expect(collector.sampleCoverage.observed).toBeGreaterThan(0);
  }, 30_000);

  it('records 3 isolated runs x 200 steady-state samples after 20 warm-up for SC-004a (20x64 KiB) and SC-004b (near-limit 2 MiB) and validates the qualification record (T030, SC-002, SC-004)', async () => {
    const warmUp = 20;
    const steadyState = 200;
    const totalSamplesPerRun = warmUp + steadyState;
    const runs = 3;

    const sc004aDistributions: Distribution[] = [];
    const sc004aCpuDistributions: Distribution[] = [];
    const sc004aPersistDistributions: Distribution[] = [];

    for (let runIdx = 1; runIdx <= runs; runIdx += 1) {
      const runId = `sc004a-run-${runIdx}`;
      const memento = createFastInMemoryMemento();
      const ledgerStore = new ControlLedgerStore(memento);
      const admission = new ControlAttemptAdmissionService({ ledgerStore });

      for (let r = 1; r <= MAX_LIVE_CONTROL_ROOTS; r += 1) {
        const rootId = `root-${String(r).padStart(2, '0')}`;
        await admission.prepareRootLink({
          ledgerRunId: rootId,
          connectedRunId: `crun-${r}`,
          rootWorkflowId: 'wf-perf',
          queueId: 'default',
          fence: DEFAULT_FENCE
        });
        await admission.activateRootLink({
          ledgerRunId: rootId,
          connectedRunId: `crun-${r}`,
          fence: DEFAULT_FENCE
        });
        const paddedFrames = buildFramesToTargetBytes(
          ledgerStore.getRoot(rootId)!.framesByKey,
          64 * 1024
        );
        await ledgerStore.mutate({ targetRootId: rootId }, ({ ledger }) => {
          const existing = ledger.roots[rootId]!;
          const candidate = { ...existing, framesByKey: paddedFrames };
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: { ...ledger.roots, [rootId]: candidate }
              },
              targetRootId: rootId,
              result: measureRootLedgerBytes(candidate)
            }
          };
        });
      }

      const wallSamples: number[] = [];
      const cpuSamples: number[] = [];
      const persistSamples: number[] = [];

      for (let i = 0; i < totalSamplesPerRun; i += 1) {
        const targetIdx = (i % MAX_LIVE_CONTROL_ROOTS) + 1;
        const rootId = `root-${String(targetIdx).padStart(2, '0')}`;
        const cpuBefore = process.cpuUsage();
        const t0 = performance.now();
        const mut = await ledgerStore.mutate({ targetRootId: rootId }, ({ ledger }) => {
          const r = ledger.roots[rootId]!;
          const candidate = { ...r, updatedAt: r.updatedAt + 1 };
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: { ...ledger.roots, [rootId]: candidate }
              },
              targetRootId: rootId,
              result: undefined
            }
          };
        });
        const wallMs = performance.now() - t0;
        const cpuDelta = process.cpuUsage(cpuBefore);
        const cpuMs = (cpuDelta.user + cpuDelta.system) / 1_000;
        expect(mut.ok).toBe(true);
        wallSamples.push(wallMs);
        cpuSamples.push(cpuMs);
        persistSamples.push(memento.lastPersistenceWaitMs);
      }

      sc004aDistributions.push(
        computeDistribution({
          metric: 'mutation-ack-20x64k-ms',
          runId,
          values: wallSamples,
          warmUpCount: warmUp,
          unit: 'ms',
          budgetKind: 'aggregate'
        })
      );
      sc004aCpuDistributions.push(
        computeDistribution({
          metric: 'mutation-ack-20x64k-cpu-ms',
          runId,
          values: cpuSamples,
          warmUpCount: warmUp,
          unit: 'ms',
          budgetKind: 'component'
        })
      );
      sc004aPersistDistributions.push(
        computeDistribution({
          metric: 'mutation-ack-20x64k-persistence-wait-ms',
          runId,
          values: persistSamples,
          warmUpCount: warmUp,
          unit: 'ms',
          budgetKind: 'component'
        })
      );
    }

    const sc004bDistributions: Distribution[] = [];
    const sc004bCpuDistributions: Distribution[] = [];
    let nearLimitRootBytes = 0;

    for (let runIdx = 1; runIdx <= runs; runIdx += 1) {
      const runId = `sc004b-run-${runIdx}`;
      const memento = createFastInMemoryMemento();
      const ledgerStore = new ControlLedgerStore(memento);
      const admission = new ControlAttemptAdmissionService({ ledgerStore });

      await admission.prepareRootLink({
        ledgerRunId: 'root-2mib',
        connectedRunId: 'crun-2mib',
        rootWorkflowId: 'wf-perf',
        queueId: 'default',
        fence: DEFAULT_FENCE
      });
      await admission.activateRootLink({
        ledgerRunId: 'root-2mib',
        connectedRunId: 'crun-2mib',
        fence: DEFAULT_FENCE
      });

      const frames = buildFramesToTargetBytes(
        ledgerStore.getRoot('root-2mib')!.framesByKey,
        MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES - 8_192
      );
      const padOut = await ledgerStore.mutate({ targetRootId: 'root-2mib' }, ({ ledger }) => {
        const existing = ledger.roots['root-2mib']!;
        const candidate = { ...existing, framesByKey: frames };
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: { ...ledger.roots, 'root-2mib': candidate }
            },
            targetRootId: 'root-2mib',
            result: measureRootLedgerBytes(candidate)
          }
        };
      });
      expect(padOut.ok).toBe(true);
      if (padOut.ok) {
        nearLimitRootBytes = padOut.result;
      }

      const wallSamples: number[] = [];
      const cpuSamples: number[] = [];

      for (let i = 0; i < totalSamplesPerRun; i += 1) {
        const cpuBefore = process.cpuUsage();
        const t0 = performance.now();
        const mut = await ledgerStore.mutate({ targetRootId: 'root-2mib' }, ({ ledger }) => {
          const r = ledger.roots['root-2mib']!;
          const candidate = { ...r, updatedAt: r.updatedAt + 1 };
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: { ...ledger.roots, 'root-2mib': candidate }
              },
              targetRootId: 'root-2mib',
              result: undefined
            }
          };
        });
        const wallMs = performance.now() - t0;
        const cpuDelta = process.cpuUsage(cpuBefore);
        const cpuMs = (cpuDelta.user + cpuDelta.system) / 1_000;
        expect(mut.ok).toBe(true);
        wallSamples.push(wallMs);
        cpuSamples.push(cpuMs);
      }

      sc004bDistributions.push(
        computeDistribution({
          metric: 'mutation-ack-near-limit-2mib-ms',
          runId,
          values: wallSamples,
          warmUpCount: warmUp,
          unit: 'ms',
          budgetKind: 'aggregate'
        })
      );
      sc004bCpuDistributions.push(
        computeDistribution({
          metric: 'mutation-ack-near-limit-2mib-cpu-ms',
          runId,
          values: cpuSamples,
          warmUpCount: warmUp,
          unit: 'ms',
          budgetKind: 'component'
        })
      );
    }

    expect(checkSampleSufficiency(sc004aDistributions).sufficient).toBe(true);
    expect(checkSampleSufficiency(sc004bDistributions).sufficient).toBe(true);

    const maxSc004aP95 = Math.max(...sc004aDistributions.map((d) => d.p95));
    const maxSc004bP95 = Math.max(...sc004bDistributions.map((d) => d.p95));
    expect(maxSc004aP95).toBeLessThanOrEqual(100);
    expect(maxSc004bP95).toBeLessThanOrEqual(500);

    const budgets: BudgetResult[] = [
      {
        targetId: 'SC-002',
        status: 'migration-baseline-recorded',
        evidence: '3 isolated runs x 200 steady-state samples after 20 warm-up'
      },
      {
        targetId: 'SC-004a',
        status: 'migration-baseline-recorded',
        evidence: `20x64KiB p95 max across 3 runs = ${maxSc004aP95.toFixed(2)} ms (<= 100 ms)`
      },
      {
        targetId: 'SC-004b',
        status: 'migration-baseline-recorded',
        evidence: `Near-limit 2MiB (${nearLimitRootBytes} B) p95 max across 3 runs = ${maxSc004bP95.toFixed(2)} ms (<= 500 ms)`
      },
      {
        targetId: 'SC-005',
        status: 'pass',
        evidence: 'Verified by tests/perf/webview-snapshot-cost.test.ts'
      }
    ];

    const record = buildQualificationRecord({
      baselineLabel: 'migration-baseline',
      environment: captureEnvironmentDescriptor(),
      distributions: [
        ...sc004aDistributions,
        ...sc004aCpuDistributions,
        ...sc004aPersistDistributions,
        ...sc004bDistributions,
        ...sc004bCpuDistributions
      ],
      memory: readHostMemoryCategories({
        serializedBytes: nearLimitRootBytes,
        retainedApplicationBytes: nearLimitRootBytes
      }),
      budgets
    });

    const validation = validateQualificationRecord(record);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);

    const exportPath = process.env.SCHEGENT_QUALIFICATION_RECORD;
    if (typeof exportPath === 'string' && exportPath.trim().length > 0) {
      const targetPath = exportPath.trim();
      await exportQualificationRecord(record, async (json) => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, json, 'utf8');
      });
    }
  }, 60_000);
});
