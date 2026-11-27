/**
 * Post-merge review Finding 5 — Read-only `node:worker_threads` snapshot capture
 * for file-backed run-derived historical reports.
 *
 * Keeps large run-population reads (25,000 roots / 100,000 attempts + auxiliary
 * metadata) off the extension-host event loop while preserving exact
 * `captureRunSnapshot` semantics:
 *   - Opens the file-backed SQLite database strictly read-only (`readOnly: true`,
 *     `PRAGMA query_only = ON`, `PRAGMA trusted_schema = OFF`, `PRAGMA temp_store = MEMORY`,
 *     `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout`).
 *   - Reads all tables inside one `BEGIN DEFERRED ... ROLLBACK` WAL snapshot and
 *     closes the read transaction IMMEDIATELY before streaming rows, minimizing
 *     WAL snapshot hold duration so checkpoints and settlement writes proceed.
 *   - Streams results in bounded 4,000-row chunks so host-thread structured-clone
 *     deserialization stays within a few milliseconds per event-loop turn instead
 *     of stalling the host for ~100–200 ms.
 *   - Supports real mid-read cancellation via `AbortSignal` -> `worker.terminate()`
 *     and deadline enforcement from request start.
 *   - Executes a typed, self-contained worker entry module
 *     (`run-snapshot-worker-entry.ts` directly in Vitest under Node's built-in type
 *     stripping, or bundled `dist/run-snapshot.worker.js` in production) with explicit
 *     V8 `resourceLimits` so OOM conditions fail cleanly as `limited / working-data`
 *     rather than crashing the extension host.
 *
 * Zero `vscode` imports (keeps module headless-testable).
 */
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { FAILURE_CAUSES } from '../../contracts/failure-cause';
import {
  reportCancelled,
  reportFailed,
  reportLimited,
  reportOk,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import type {
  AttemptAcpAttribution,
  AttemptHandoffSummary,
  ReportEvidenceReference,
  RootReviewLoopSummary
} from '../../contracts/reporting/report-rows';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../contracts/sqlite-store/schema-types';
import { isFileBackedSqlitePath } from '../usage-accounting/accounting-query-worker';
import {
  extractWorkerErrorCode,
  isWorkerOutOfMemoryError,
  resolveWorkerEntryPath,
  workerExecArgvForEntry
} from '../worker-entry-path';
import type {
  RunSnapshotWorkerConfig,
  RunSnapshotWorkerRequestEnvelope,
  RunSnapshotWorkerResponseMessage
} from './run-snapshot-worker-entry';
import {
  AUXILIARY_TRUNCATION_REASON,
  CAUSE_NOT_RECORDED,
  CAUSE_OTHER,
  type CaptureRequest,
  type CapturedRuns,
  type SnapshotAttempt,
  type SnapshotRoot
} from './snapshot-capture';

const MAX_PENDING_CAPTURES = 32;
const IDLE_WORKER_TTL_MS = 10_000;
const STREAM_CHUNK_SIZE = 4_000;

export const RUN_SNAPSHOT_WORKER_FILENAME = 'run-snapshot.worker.js';

/**
 * V8 heap limits for the read-only run-snapshot capture worker.
 *
 * Sized against the 100,000-attempt / 25,000-root reference fixture and the 32 MiB
 * shared workspace working-data budget (`HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES`):
 * peak worker heap briefly holds one transaction's raw SQLite row objects plus mapped
 * chunk slices (~60–90 MiB peak on 100k attempts) before chunk streaming releases them.
 * 256 MiB old-gen + 32 MiB young-gen gives ~3x headroom for legitimate 100k-attempt
 * captures while bounding runaway heap growth so the worker cannot OOM the extension host.
 */
export const RUN_SNAPSHOT_WORKER_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
});

export function resolveRunSnapshotWorkerPath(options?: {
  readonly callerDir?: string | undefined;
  readonly callerFilename?: string | undefined;
  readonly fileExists?: ((candidatePath: string) => boolean) | undefined;
}): string {
  return resolveWorkerEntryPath({
    bundledFilename: RUN_SNAPSHOT_WORKER_FILENAME,
    sourceEntryStem: 'run-snapshot-worker-entry',
    callerDir: options?.callerDir ?? __dirname,
    callerFilename: options?.callerFilename ?? __filename,
    fileExists: options?.fileExists
  });
}

export { isFileBackedSqlitePath };

export interface RunSnapshotWorkerMetrics {
  readonly queueWaitMs: number;
  readonly sqlReadMs: number;
  readonly totalWorkerMs: number;
}

export interface RunSnapshotWorkerCaptureOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineMs?: number | undefined;
  readonly onMetrics?: ((metrics: RunSnapshotWorkerMetrics) => void) | undefined;
}

interface MutableCaptureAccumulator {
  readonly roots: SnapshotRoot[];
  readonly attempts: SnapshotAttempt[];
  readonly evidenceRefs: ReportEvidenceReference[];
  readonly acpAttributions: AttemptAcpAttribution[];
  readonly handoffSummaries: AttemptHandoffSummary[];
  readonly reviewSummaries: RootReviewLoopSummary[];
}

interface QueuedCapture {
  readonly id: number;
  readonly request: CaptureRequest;
  readonly enqueuedAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly deadlineMs: number | undefined;
  readonly onMetrics: ((metrics: RunSnapshotWorkerMetrics) => void) | undefined;
  readonly resolve: (result: ReportResult<CapturedRuns>) => void;
  readonly acc: MutableCaptureAccumulator;
  abortCleanup?: (() => void) | undefined;
}

export interface RunSnapshotWorkerClient {
  capture(
    request: CaptureRequest,
    options?: RunSnapshotWorkerCaptureOptions
  ): Promise<ReportResult<CapturedRuns>>;
  close(): Promise<void>;
  readonly spawnCount: number;
  readonly terminationCount: number;
}

function freezeBatch<T>(items: readonly unknown[], target: T[]): void {
  for (let i = 0; i < items.length; i += 1) {
    target.push(Object.freeze(items[i] as T));
  }
}

export function createRunSnapshotWorkerClient(
  databasePath: string,
  options?: {
    readonly busyTimeoutMs?: number | undefined;
    readonly maxPendingCaptures?: number | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly chunkSize?: number | undefined;
    readonly resourceLimits?: ResourceLimits | undefined;
    readonly workerEntryPath?: string | undefined;
    readonly onErrorCode?: ((errorCode: string) => void) | undefined;
  }
): RunSnapshotWorkerClient {
  const busyTimeoutMs = options?.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  const maxPending = options?.maxPendingCaptures ?? MAX_PENDING_CAPTURES;
  const idleTtlMs = options?.idleTtlMs ?? IDLE_WORKER_TTL_MS;
  const chunkSize = options?.chunkSize ?? STREAM_CHUNK_SIZE;
  const resourceLimits = options?.resourceLimits ?? RUN_SNAPSHOT_WORKER_RESOURCE_LIMITS;
  const workerPath = options?.workerEntryPath ?? resolveRunSnapshotWorkerPath();
  const execArgv = workerExecArgvForEntry(workerPath);

  let worker: Worker | null = null;
  let active: QueuedCapture | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let spawns = 0;
  let terminations = 0;
  const queue: QueuedCapture[] = [];
  const pendingTerminations = new Set<Promise<unknown>>();

  const workerData: RunSnapshotWorkerConfig = {
    databasePath,
    busyTimeoutMs,
    chunkSize,
    failureCauses: [...FAILURE_CAUSES],
    causeNotRecorded: CAUSE_NOT_RECORDED,
    causeOther: CAUSE_OTHER,
    truncationReason: AUXILIARY_TRUNCATION_REASON
  };

  function trackTermination(dying: Worker): Promise<number> {
    const p = dying.terminate();
    const settled = p.finally(() => {
      pendingTerminations.delete(settled);
    });
    pendingTerminations.add(settled);
    return p;
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearActiveTimer(): void {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  }

  function scheduleIdleShutdown(): void {
    clearIdleTimer();
    if (worker === null || active !== null || queue.length > 0) return;
    worker.unref();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker !== null && active === null && queue.length === 0) {
        const dying = worker;
        worker = null;
        void trackTermination(dying);
      }
    }, idleTtlMs);
    idleTimer.unref();
  }

  function terminateCurrentWorker(): Promise<number> {
    clearIdleTimer();
    const dying = worker;
    worker = null;
    if (dying === null) return Promise.resolve(0);
    terminations += 1;
    return trackTermination(dying);
  }

  function finishActive(
    current: QueuedCapture,
    result: ReportResult<CapturedRuns>,
    metrics: RunSnapshotWorkerMetrics
  ): void {
    if (active !== current) return;
    active = null;
    clearActiveTimer();
    current.abortCleanup?.();
    current.abortCleanup = undefined;
    try {
      current.onMetrics?.(metrics);
    } catch {
      // Metrics observer faults must not affect capture resolution.
    }
    current.resolve(result);
    pump();
  }

  function ensureWorker(): Worker {
    if (worker !== null) return worker;
    spawns += 1;
    const spawned = new Worker(workerPath, {
      workerData,
      resourceLimits,
      ...(execArgv !== undefined ? { execArgv } : {})
    });
    spawned.on('message', (msg: RunSnapshotWorkerResponseMessage) => {
      if (worker !== spawned || active === null || msg.id !== active.id) return;
      const current = active;
      if (msg.kind === 'chunk') {
        switch (msg.target) {
          case 'roots':
            freezeBatch(msg.rows, current.acc.roots);
            break;
          case 'attempts':
            freezeBatch(msg.rows, current.acc.attempts);
            break;
          case 'evidenceRefs':
            freezeBatch(msg.rows, current.acc.evidenceRefs);
            break;
          case 'acpAttributions':
            freezeBatch(msg.rows, current.acc.acpAttributions);
            break;
          case 'handoffSummaries':
            freezeBatch(msg.rows, current.acc.handoffSummaries);
            break;
          case 'reviewSummaries':
            freezeBatch(msg.rows, current.acc.reviewSummaries);
            break;
        }
        // Yield to the host event loop before requesting the next chunk so UI input,
        // heartbeats, cancellation, and settlement writes interleave with < 10 ms gaps.
        setImmediate(() => {
          if (worker === spawned && active === current) {
            spawned.postMessage({
              kind: 'ack',
              id: current.id
            } satisfies RunSnapshotWorkerRequestEnvelope);
          }
        });
        return;
      }
      if (msg.kind === 'limited') {
        finishActive(current, reportLimited(msg.limit), {
          queueWaitMs: 0,
          sqlReadMs: msg.sqlReadMs,
          totalWorkerMs: msg.totalWorkerMs
        });
        return;
      }
      if (msg.kind === 'done') {
        const frozenOmissions =
          msg.omissions.length > 0
            ? Object.freeze(msg.omissions.map((o) => Object.freeze({ what: o.what, reason: o.reason })))
            : undefined;
        const captured: CapturedRuns = Object.freeze({
          roots: Object.freeze(current.acc.roots),
          attempts: Object.freeze(current.acc.attempts),
          ...(current.acc.evidenceRefs.length > 0
            ? { evidenceRefs: Object.freeze(current.acc.evidenceRefs) }
            : {}),
          ...(current.acc.acpAttributions.length > 0
            ? { acpAttributions: Object.freeze(current.acc.acpAttributions) }
            : {}),
          ...(current.acc.handoffSummaries.length > 0
            ? { handoffSummaries: Object.freeze(current.acc.handoffSummaries) }
            : {}),
          ...(current.acc.reviewSummaries.length > 0
            ? { reviewSummaries: Object.freeze(current.acc.reviewSummaries) }
            : {}),
          ...(frozenOmissions !== undefined ? { omissions: frozenOmissions } : {})
        });
        finishActive(current, reportOk(captured), {
          queueWaitMs: 0,
          sqlReadMs: msg.sqlReadMs,
          totalWorkerMs: msg.totalWorkerMs
        });
        return;
      }
      options?.onErrorCode?.(msg.errorCode);
      finishActive(current, reportFailed('source-read-failed'), {
        queueWaitMs: 0,
        sqlReadMs: 0,
        totalWorkerMs: msg.totalWorkerMs
      });
    });
    spawned.on('error', (err: Error) => {
      if (worker !== spawned) return;
      const isOom = isWorkerOutOfMemoryError(err);
      options?.onErrorCode?.(extractWorkerErrorCode(err, 'WORKER_ERROR'));
      worker = null;
      if (active !== null) {
        finishActive(
          active,
          isOom ? reportLimited('working-data') : reportFailed('source-read-failed'),
          {
            queueWaitMs: 0,
            sqlReadMs: 0,
            totalWorkerMs: 0
          }
        );
      }
    });
    spawned.on('exit', () => {
      if (worker !== spawned) return;
      worker = null;
      if (active !== null) {
        finishActive(active, reportFailed('source-read-failed'), {
          queueWaitMs: 0,
          sqlReadMs: 0,
          totalWorkerMs: 0
        });
      }
    });
    worker = spawned;
    return spawned;
  }

  function pump(): void {
    if (closed || active !== null) return;
    const next = queue.shift();
    if (next === undefined) {
      scheduleIdleShutdown();
      return;
    }
    if (next.signal?.aborted === true) {
      next.abortCleanup?.();
      next.abortCleanup = undefined;
      next.resolve(reportCancelled());
      pump();
      return;
    }

    clearIdleTimer();
    const queueWaitMs = Math.max(0, performance.now() - next.enqueuedAtMs);
    const originalOnMetrics = next.onMetrics;
    const wrapped: QueuedCapture = {
      ...next,
      onMetrics:
        originalOnMetrics !== undefined
          ? (m) =>
              originalOnMetrics({
                queueWaitMs,
                sqlReadMs: m.sqlReadMs,
                totalWorkerMs: m.totalWorkerMs
              })
          : undefined
    };
    active = wrapped;

    const terminateWith = (outcome: ReportResult<CapturedRuns>): void => {
      if (active !== wrapped) return;
      void terminateCurrentWorker();
      finishActive(wrapped, outcome, { queueWaitMs, sqlReadMs: 0, totalWorkerMs: 0 });
    };

    next.abortCleanup?.();
    if (wrapped.signal !== undefined) {
      if (wrapped.signal.aborted) {
        terminateWith(reportCancelled());
        return;
      }
      const onAbort = (): void => terminateWith(reportCancelled());
      wrapped.signal.addEventListener('abort', onAbort, { once: true });
      wrapped.abortCleanup = () => wrapped.signal?.removeEventListener('abort', onAbort);
    }

    if (wrapped.deadlineMs !== undefined && Number.isFinite(wrapped.deadlineMs)) {
      activeTimer = setTimeout(() => {
        terminateWith(reportLimited('deadline-exceeded'));
      }, Math.max(1, wrapped.deadlineMs));
    }

    try {
      const target = ensureWorker();
      target.ref();
      const envelope: RunSnapshotWorkerRequestEnvelope = {
        kind: 'capture',
        id: wrapped.id,
        request: wrapped.request
      };
      target.postMessage(envelope);
    } catch (err: unknown) {
      const isOom = isWorkerOutOfMemoryError(err);
      options?.onErrorCode?.(isOom ? 'ERR_WORKER_OUT_OF_MEMORY' : 'WORKER_DISPATCH_FAILED');
      void terminateCurrentWorker();
      finishActive(
        wrapped,
        isOom ? reportLimited('working-data') : reportFailed('source-read-failed'),
        {
          queueWaitMs,
          sqlReadMs: 0,
          totalWorkerMs: 0
        }
      );
    }
  }

  return {
    get spawnCount(): number {
      return spawns;
    },
    get terminationCount(): number {
      return terminations;
    },
    capture(request, captureOptions) {
      if (closed) {
        return Promise.resolve(reportFailed('source-read-failed'));
      }
      const signal = captureOptions?.signal;
      if (signal?.aborted === true) {
        return Promise.resolve(reportCancelled());
      }
      if (queue.length >= maxPending) {
        return Promise.resolve(reportFailed('source-read-failed'));
      }
      return new Promise<ReportResult<CapturedRuns>>((resolve) => {
        const entry: QueuedCapture = {
          id: nextId++,
          request,
          enqueuedAtMs: performance.now(),
          signal,
          deadlineMs: captureOptions?.deadlineMs,
          onMetrics: captureOptions?.onMetrics,
          resolve,
          acc: {
            roots: [],
            attempts: [],
            evidenceRefs: [],
            acpAttributions: [],
            handoffSummaries: [],
            reviewSummaries: []
          }
        };
        if (signal !== undefined) {
          const onQueuedAbort = (): void => {
            const idx = queue.indexOf(entry);
            if (idx >= 0) {
              queue.splice(idx, 1);
              entry.abortCleanup = undefined;
              resolve(reportCancelled());
            }
          };
          signal.addEventListener('abort', onQueuedAbort, { once: true });
          entry.abortCleanup = () => signal.removeEventListener('abort', onQueuedAbort);
        }
        queue.push(entry);
        pump();
      });
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      clearIdleTimer();
      clearActiveTimer();
      const pending = queue.splice(0, queue.length);
      for (const entry of pending) {
        entry.abortCleanup?.();
        entry.resolve(reportFailed('source-read-failed'));
      }
      const current = active;
      active = null;
      if (current !== null) {
        current.abortCleanup?.();
        current.resolve(reportFailed('source-read-failed'));
      }
      const dying = worker;
      worker = null;
      if (dying !== null) {
        void trackTermination(dying);
      }
      closePromise = Promise.allSettled([...pendingTerminations]).then(() => undefined);
      return closePromise;
    }
  };
}
