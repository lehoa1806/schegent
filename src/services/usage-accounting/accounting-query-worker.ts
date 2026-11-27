/**
 * FR-R8-03 (03-03) — Read-only `node:worker_threads` query executor for usage accounting.
 *
 * Keeps retention-limit (1,000,000-observation) aggregate reads off the extension-host event loop
 * (`<= 50 ms p95` host-thread blocking) while preserving exact `runAccountingQuery` semantics,
 * read-only SQLite isolation (`readOnly: true`, `PRAGMA query_only = ON`, `trusted_schema = OFF`),
 * bounded FIFO queueing, and real mid-read cancellation via `AbortSignal` -> `worker.terminate()`.
 *
 * Executes a typed, self-contained worker entry module (`accounting-query-worker-entry.ts`
 * directly in Vitest under Node's built-in type stripping, or bundled
 * `dist/accounting-query.worker.js` in production) with explicit V8 `resourceLimits` so OOM
 * conditions fail cleanly as `response-too-large` (`worker-memory-limit`) rather than crashing
 * the host. Falls back transparently to synchronous execution for `:memory:` DBs.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../contracts/sqlite-store/schema-types';
import {
  ACCOUNTING_CALCULATION_VERSION,
  ACCOUNTING_POLICY_VERSION,
  ATTEMPT_OUTCOMES,
  MEASURES,
  OCCUPANCY_MEASURES,
  type AccountingBounds,
  type AccountingResult
} from '../../contracts/usage-accounting/accounting-types';
import {
  DIMENSION_VALUE_PATTERNS,
  MAX_QUERY_CURSOR_CHARS,
  MAX_REPORTED_GAP_KINDS,
  type AccountingQueryRequest,
  type AccountingQueryResponse
} from '../../contracts/usage-accounting/query-contract';
import {
  extractWorkerErrorCode,
  isWorkerOutOfMemoryError,
  resolveWorkerEntryPath,
  workerExecArgvForEntry
} from '../worker-entry-path';
import type {
  AccountingWorkerConfigPayload,
  AccountingWorkerRequestEnvelope,
  AccountingWorkerResponseEnvelope
} from './accounting-query-worker-entry';

const MAX_PENDING_QUERIES = 64;
const IDLE_WORKER_TTL_MS = 10_000;

export const ACCOUNTING_QUERY_WORKER_FILENAME = 'accounting-query.worker.js';

/**
 * V8 heap limits for the read-only usage-accounting query worker.
 *
 * SQL grouping and aggregation execute inside SQLite's native engine over up to
 * 1,000,000 retained observations; V8 heap holds at most one 200-group page
 * (`maxQueryLimit = 200`, `maxResponseBytes = 1 MiB`) plus measure aggregates.
 * 128 MiB old-gen + 16 MiB young-gen provides ample headroom for JSON serialization
 * and worst-case multi-unit pages while preventing runaway worker heap from crashing
 * the VS Code extension host.
 */
export const ACCOUNTING_QUERY_WORKER_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
});

export function resolveAccountingQueryWorkerPath(options?: {
  readonly callerDir?: string | undefined;
  readonly callerFilename?: string | undefined;
  readonly fileExists?: ((candidatePath: string) => boolean) | undefined;
}): string {
  return resolveWorkerEntryPath({
    bundledFilename: ACCOUNTING_QUERY_WORKER_FILENAME,
    sourceEntryStem: 'accounting-query-worker-entry',
    callerDir: options?.callerDir ?? __dirname,
    callerFilename: options?.callerFilename ?? __filename,
    fileExists: options?.fileExists
  });
}

export interface AccountingWorkerQueryMetrics {
  readonly queueWaitMs: number;
  readonly workerExecMs: number;
}

export interface AccountingWorkerQueryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onMetrics?: ((metrics: AccountingWorkerQueryMetrics) => void) | undefined;
}

interface QueuedQuery {
  readonly id: number;
  readonly request: AccountingQueryRequest & { readonly limit: number };
  readonly bounds: AccountingBounds;
  readonly enqueuedAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly onMetrics: ((metrics: AccountingWorkerQueryMetrics) => void) | undefined;
  readonly resolve: (result: AccountingResult<AccountingQueryResponse>) => void;
  abortCleanup?: (() => void) | undefined;
}

export function isFileBackedSqlitePath(databasePath: string): boolean {
  return databasePath.length > 0 && databasePath !== ':memory:' && !databasePath.startsWith('file::memory:');
}

export interface AccountingQueryWorkerClient {
  query(
    request: AccountingQueryRequest & { readonly limit: number },
    bounds: AccountingBounds,
    options?: AccountingWorkerQueryOptions
  ): Promise<AccountingResult<AccountingQueryResponse>>;
  close(): Promise<void>;
  /** Number of times a worker thread was spawned (diagnostics/tests). */
  readonly spawnCount: number;
  /** Number of times an in-flight worker was terminated for abort or deadline (diagnostics/tests). */
  readonly terminationCount: number;
}

export function createAccountingQueryWorkerClient(
  databasePath: string,
  options?: {
    readonly busyTimeoutMs?: number | undefined;
    readonly maxPendingQueries?: number | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly resourceLimits?: ResourceLimits | undefined;
    readonly workerEntryPath?: string | undefined;
    readonly onErrorCode?: ((errorCode: string) => void) | undefined;
  }
): AccountingQueryWorkerClient {
  const busyTimeoutMs = options?.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  const maxPending = options?.maxPendingQueries ?? MAX_PENDING_QUERIES;
  const idleTtlMs = options?.idleTtlMs ?? IDLE_WORKER_TTL_MS;
  const resourceLimits = options?.resourceLimits ?? ACCOUNTING_QUERY_WORKER_RESOURCE_LIMITS;
  const workerPath = options?.workerEntryPath ?? resolveAccountingQueryWorkerPath();
  const execArgv = workerExecArgvForEntry(workerPath);

  let worker: Worker | null = null;
  let active: QueuedQuery | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let spawns = 0;
  let terminations = 0;
  const queue: QueuedQuery[] = [];
  const pendingTerminations = new Set<Promise<unknown>>();

  function trackTermination(dying: Worker): Promise<number> {
    const p = dying.terminate();
    const settled = p.finally(() => {
      pendingTerminations.delete(settled);
    });
    pendingTerminations.add(settled);
    return p;
  }

  const workerData: AccountingWorkerConfigPayload = {
    databasePath,
    busyTimeoutMs,
    policyVersion: ACCOUNTING_POLICY_VERSION,
    calculationVersion: ACCOUNTING_CALCULATION_VERSION,
    maxQueryCursorChars: MAX_QUERY_CURSOR_CHARS,
    maxReportedGapKinds: MAX_REPORTED_GAP_KINDS,
    attemptOutcomes: [...ATTEMPT_OUTCOMES],
    measures: [...MEASURES],
    occupancyMeasures: [...OCCUPANCY_MEASURES],
    patterns: {
      backend: DIMENSION_VALUE_PATTERNS.backend.source,
      model: DIMENSION_VALUE_PATTERNS.model.source,
      identifier: DIMENSION_VALUE_PATTERNS.identifier.source,
      utcDay: DIMENSION_VALUE_PATTERNS.utcDay.source
    }
  };

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
    current: QueuedQuery,
    result: AccountingResult<AccountingQueryResponse>,
    workerExecMs: number,
    queueWaitMs: number
  ): void {
    if (active !== current) return;
    active = null;
    clearActiveTimer();
    current.abortCleanup?.();
    current.abortCleanup = undefined;
    try {
      current.onMetrics?.({ queueWaitMs, workerExecMs });
    } catch {
      // Metrics observer faults must not break query resolution.
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
    spawned.on('message', (msg: AccountingWorkerResponseEnvelope) => {
      if (worker !== spawned || active === null || msg.id !== active.id) return;
      const current = active;
      if (msg.result !== undefined) {
        finishActive(current, msg.result, msg.execMs ?? 0, 0);
        return;
      }
      options?.onErrorCode?.(msg.errorCode ?? 'WORKER_SQL_ERROR');
      finishActive(current, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, msg.execMs ?? 0, 0);
    });
    spawned.on('error', (err: Error) => {
      if (worker !== spawned) return;
      const isOom = isWorkerOutOfMemoryError(err);
      options?.onErrorCode?.(extractWorkerErrorCode(err, 'WORKER_ERROR'));
      worker = null;
      if (active !== null) {
        const current = active;
        finishActive(
          current,
          isOom
            ? { ok: false, refusal: { code: 'response-too-large', detail: 'worker-memory-limit' } }
            : { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } },
          0,
          0
        );
      }
    });
    spawned.on('exit', () => {
      if (worker !== spawned) return;
      worker = null;
      if (active !== null) {
        const current = active;
        finishActive(current, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, 0, 0);
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
      next.resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
      pump();
      return;
    }

    clearIdleTimer();
    const queueWaitMs = Math.max(0, performance.now() - next.enqueuedAtMs);
    const originalOnMetrics = next.onMetrics;
    const wrapped: QueuedQuery = {
      ...next,
      onMetrics:
        originalOnMetrics !== undefined
          ? (m) => originalOnMetrics({ queueWaitMs, workerExecMs: m.workerExecMs })
          : undefined
    };
    active = wrapped;

    const abortInFlight = (): void => {
      if (active !== wrapped) return;
      void terminateCurrentWorker();
      finishActive(wrapped, { ok: false, refusal: { code: 'deadline-exceeded' } }, 0, queueWaitMs);
    };

    next.abortCleanup?.();
    if (wrapped.signal !== undefined) {
      if (wrapped.signal.aborted) {
        abortInFlight();
        return;
      }
      const onAbort = (): void => abortInFlight();
      wrapped.signal.addEventListener('abort', onAbort, { once: true });
      wrapped.abortCleanup = () => wrapped.signal?.removeEventListener('abort', onAbort);
    }

    const timeoutMs = Math.max(1, wrapped.bounds.queryDeadlineMs);
    activeTimer = setTimeout(() => {
      abortInFlight();
    }, timeoutMs);

    try {
      const target = ensureWorker();
      target.ref();
      const envelope: AccountingWorkerRequestEnvelope = {
        id: wrapped.id,
        request: wrapped.request,
        bounds: wrapped.bounds
      };
      target.postMessage(envelope);
    } catch (err: unknown) {
      const isOom = isWorkerOutOfMemoryError(err);
      options?.onErrorCode?.(isOom ? 'ERR_WORKER_OUT_OF_MEMORY' : 'WORKER_DISPATCH_FAILED');
      void terminateCurrentWorker();
      finishActive(
        wrapped,
        isOom
          ? { ok: false, refusal: { code: 'response-too-large', detail: 'worker-memory-limit' } }
          : { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } },
        0,
        queueWaitMs
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
    query(request, bounds, queryOptions) {
      if (closed) {
        return Promise.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
      }
      const signal = queryOptions?.signal;
      if (signal?.aborted === true) {
        return Promise.resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
      }
      if (queue.length >= maxPending) {
        return Promise.resolve({ ok: false, refusal: { code: 'store-error', detail: 'query-queue-full' } });
      }
      return new Promise<AccountingResult<AccountingQueryResponse>>((resolve) => {
        const entry: QueuedQuery = {
          id: nextId++,
          request,
          bounds,
          enqueuedAtMs: performance.now(),
          signal,
          onMetrics: queryOptions?.onMetrics,
          resolve
        };
        if (signal !== undefined) {
          const onQueuedAbort = (): void => {
            const idx = queue.indexOf(entry);
            if (idx >= 0) {
              queue.splice(idx, 1);
              entry.abortCleanup = undefined;
              resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
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
        entry.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
      }
      const current = active;
      active = null;
      if (current !== null) {
        current.abortCleanup?.();
        current.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
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
