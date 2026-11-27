import { afterEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  KEYS,
  SERIALIZE_OP_LIVENESS_THRESHOLD_MS,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('WorkspaceStateStore serialize-chain liveness timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs a single sanitized warning with key and duration when a serialize op stays pending past threshold, and clears timer in finally', async () => {
    vi.useFakeTimers();
    const pendingWrite = createDeferred();
    const data = new Map<string, unknown>();
    const memento: Memento = {
      get<T>(key: string): T | undefined {
        return data.get(key) as T | undefined;
      },
      update(key: string, value: unknown): PromiseLike<void> {
        if (key === KEYS.queueGlobalConcurrencyCap && value === 3) {
          return pendingWrite.promise.then(() => {
            data.set(key, value);
          });
        }
        if (value === undefined) data.delete(key);
        else data.set(key, value);
        return Promise.resolve();
      }
    };

    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const unrefSpy = vi.fn();
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const handle = origSetTimeout(fn, ms, ...rest);
      const origUnref = typeof handle.unref === 'function' ? handle.unref.bind(handle) : undefined;
      handle.unref = () => {
        unrefSpy();
        return origUnref ? origUnref() : handle;
      };
      return handle;
    }) as typeof setTimeout);

    const store = new WorkspaceStateStore(memento, logger, undefined, {
      serializeLivenessThresholdMs: 2_000
    });
    expect(SERIALIZE_OP_LIVENESS_THRESHOLD_MS).toBe(30_000);

    // Fast op finishes before threshold: zero warnings and timer is cleared.
    await store.setGlobalConcurrencyCap(2);
    vi.advanceTimersByTime(5_000);
    expect(warnSpy).not.toHaveBeenCalled();

    // Hung op exceeds threshold: warns once with key name and duration, and unrefs timer.
    // Note: MementoWriteGate has a 5_000 ms deadline, so threshold 2_000 ms fires first.
    const slowPromise = store.setGlobalConcurrencyCap(3);
    vi.advanceTimersByTime(1_999);
    expect(warnSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(unrefSpy).toHaveBeenCalled();
    const [message, meta] = warnSpy.mock.calls[0]!;
    expect(String(message)).toContain('liveness threshold');
    expect(meta).toMatchObject({
      key: KEYS.queueGlobalConcurrencyCap,
      thresholdMs: 2_000
    });
    expect((meta as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(2_000);

    // Advancing further before settlement does not emit a duplicate liveness warning.
    vi.advanceTimersByTime(2_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    pendingWrite.resolve();
    await slowPromise;
    expect(store.getGlobalConcurrencyCap()).toBe(3);
  });

  it('tracks multi-key serializeAcrossKeys operations and clears timer on rejection', async () => {
    vi.useFakeTimers();
    const pendingGate = createDeferred();
    const data = new Map<string, unknown>();
    const memento: Memento = {
      get<T>(key: string): T | undefined {
        return data.get(key) as T | undefined;
      },
      update(key: string, value: unknown): PromiseLike<void> {
        if (key === KEYS.resetMarker) {
          return pendingGate.promise.then(() => {
            throw new Error('simulated-reset-write-failure');
          });
        }
        if (value === undefined) data.delete(key);
        else data.set(key, value);
        return Promise.resolve();
      }
    };

    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const store = new WorkspaceStateStore(memento, logger, undefined, {
      serializeLivenessThresholdMs: 1_000
    });

    const resetPromise = store.reset();
    // Attach rejection handler immediately to avoid unhandled rejection warning.
    const settled = resetPromise.catch((err: unknown) => err);

    vi.advanceTimersByTime(1_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0]!;
    expect(String((meta as { key: string }).key)).toContain(KEYS.resetMarker);
    expect((meta as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(1_000);

    pendingGate.resolve();
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('simulated-reset-write-failure');
  });
});
