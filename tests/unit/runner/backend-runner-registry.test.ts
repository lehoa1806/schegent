import { afterEach, describe, it, expect, vi } from 'vitest';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import type {
  BackendRunner,
  TreeTeardownOutcome,
  TreeTeardownResult
} from '../../../src/contracts/backend-runner';
import { TEARDOWN_BOUND_MS } from '../../../src/runner/process-tree';

// Minimal BackendRunner stub for registry tests.
function makeStub(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: vi.fn().mockResolvedValue({
      stdoutBuffer: null,
      stderrBuffer: null,
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 100,
      command: 'stub'
    }),
    cancelActive: vi.fn().mockReturnValue(false),
    close: vi.fn(),
    // FR-R4-F06 (TA9) -- the contract gained a member; a stub with no ladder has no outcome.
    settleTeardowns: async () => []
  };
}

// Intercept the factory to track construction calls.
vi.mock('../../../src/runner/backend-runner-factory', async () => {
  const actual = await vi.importActual<typeof import('../../../src/contracts/backend-kinds')>(
    '../../../src/runner/backend-runner-factory'
  );
  return {
    ...actual,
    createBackendRunner: vi.fn().mockImplementation(() => makeStub())
  };
});

import { createBackendRunner } from '../../../src/runner/backend-runner-factory';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';

/**
 * FR-R3-146 (FR-003) — the grant is a thunk read at judgement time, so the double is
 * one too. Hoisted to a single reference because the registry forwards its options
 * object verbatim and `toHaveBeenCalledWith` compares functions by identity.
 */
const GRANT_CLAUDE_AGY = (): ReadonlySet<BackendRunnerKind> =>
  new Set<BackendRunnerKind>(['claude', 'agy']);

describe('BackendRunnerRegistry', () => {
  it('lazily constructs runners on first getOrCreate()', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    // No construction yet.
    expect(createBackendRunner).not.toHaveBeenCalled();

    const runner = registry.getOrCreate('claude');
    expect(runner).toBeDefined();
    expect(createBackendRunner).toHaveBeenCalledWith('claude', { uncontainedGranted: GRANT_CLAUDE_AGY });
  });

  it('returns the same runner on repeated getOrCreate() calls', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const a = registry.getOrCreate('claude');
    const b = registry.getOrCreate('claude');
    expect(a).toBe(b);
  });

  it('creates separate runners for different kinds', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const claude = registry.getOrCreate('claude');
    const agy = registry.getOrCreate('agy');
    expect(claude).not.toBe(agy);
  });

  it('falls back to globalDefault when kind is undefined', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'agy');
    const runner = registry.getOrCreate(undefined);
    expect(createBackendRunner).toHaveBeenCalledWith('agy', { uncontainedGranted: GRANT_CLAUDE_AGY });
    expect(runner).toBeDefined();
  });

  it('getGlobalDefault() returns the configured default', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'codex');
    expect(registry.getGlobalDefault()).toBe('codex');
  });

  it('cancelAll() calls cancelActive() on every cached runner', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const r1 = registry.getOrCreate('claude');
    const r2 = registry.getOrCreate('agy');
    registry.cancelAll();
    expect(r1.cancelActive).toHaveBeenCalled();
    expect(r2.cancelActive).toHaveBeenCalled();
  });

  /**
   * The feature-228 security review, S1: a child the teardown stopped can read as
   * an unfinished turn, and its resume would spawn a new CLI after the teardown.
   * Closing every runner makes that spawn a refusal.
   */
  it('cancelAll() closes every cached runner', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const r1 = registry.getOrCreate('claude');
    const r2 = registry.getOrCreate('agy');
    registry.cancelAll();
    expect(r1.close).toHaveBeenCalledTimes(1);
    expect(r2.close).toHaveBeenCalledTimes(1);
  });

  it('hands out a runner built after cancelAll() already closed', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    registry.cancelAll();
    const late = registry.getOrCreate('codex');
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  /**
   * FR-R3-146 (FR-003, plan A2) — caching a refusal would undo the live read.
   *
   * `getOrCreate` caches the runner it constructed, and a construction that threw
   * produced no runner to cache. That is what makes the second call re-judge rather
   * than replay the first verdict, so a grant written between the two is seen. It
   * holds today by the shape of the code — the `set` is after the call — which is
   * exactly the kind of property that survives until someone adds a `try`.
   */
  it('caches only on success, so a refused kind is re-judged on the next call', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    // A delta, not a total: this file's spy is shared across its tests, and the
    // property under test is "asked twice", not "asked twice ever".
    const before = vi.mocked(createBackendRunner).mock.calls.length;
    vi.mocked(createBackendRunner).mockImplementationOnce(() => {
      throw new Error('refused');
    });

    expect(() => registry.getOrCreate('claude')).toThrow('refused');
    // Not "the refusal is remembered": the factory is asked again.
    expect(registry.getOrCreate('claude')).toBeDefined();
    expect(vi.mocked(createBackendRunner).mock.calls.length - before).toBe(2);
  });

  it('hasAnyActiveProcess() returns true when any runner is active', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const runner = registry.getOrCreate('claude');
    expect(registry.hasAnyActiveProcess()).toBe(false);
    // Simulate an active process.
    Object.defineProperty(runner, 'hasActiveProcess', { get: () => true });
    expect(registry.hasAnyActiveProcess()).toBe(true);
  });
});

/**
 * FR-R4-F06 (FR-010; T8; contract D, D8 and D9) -- a revoked grant refuses the NEXT
 * start, not only a first construction.
 *
 * The registry caches each runner for the window, and the grant used to be judged only
 * when a runner was built. So after a backend's first Run, removing it from
 * `schegent.backend.uncontainedBackends` changed nothing until a reload: the launch
 * notice said the grant was application-scoped and revocable, and a revoke did not take.
 * `getOrCreate` now re-judges a cached UNCONTAINED runner at each lookup. A contained
 * backend is never re-judged, and a child already running is left running (the runner is
 * kept, not closed).
 */
describe('BackendRunnerRegistry re-judges a cached uncontained runner (T8)', () => {
  function grantable(initial: readonly BackendRunnerKind[]) {
    const granted = new Set<BackendRunnerKind>(initial);
    const read = vi.fn((): ReadonlySet<BackendRunnerKind> => new Set(granted));
    return { granted, read };
  }

  it('refuses the next lookup after a revoke, and keeps the cached runner running', () => {
    const { granted, read } = grantable(['claude']);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'claude');
    const runner = registry.getOrCreate('claude');
    expect(runner).toBeDefined();

    granted.delete('claude');

    expect(() => registry.getOrCreate('claude')).toThrow(UncontainedBackendRefusedError);
    // A child already running keeps running: nothing was closed or cancelled.
    expect(runner.close).not.toHaveBeenCalled();
    expect(runner.cancelActive).not.toHaveBeenCalled();
  });

  it('admits the lookup again once the backend is granted again', () => {
    const { granted, read } = grantable(['claude']);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'claude');
    const runner = registry.getOrCreate('claude');
    granted.delete('claude');
    expect(() => registry.getOrCreate('claude')).toThrow(UncontainedBackendRefusedError);

    granted.add('claude');

    expect(registry.getOrCreate('claude')).toBe(runner);
  });

  it('names the backend in the refusal, the same one construction throws', () => {
    const { granted, read } = grantable(['agy']);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'agy');
    registry.getOrCreate('agy');
    granted.delete('agy');

    let thrown: unknown;
    try {
      registry.getOrCreate('agy');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UncontainedBackendRefusedError);
    expect((thrown as UncontainedBackendRefusedError).kind).toBe('agy');
  });

  it('never calls the judgement for a contained backend', () => {
    const { read } = grantable([]);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'codex');

    registry.getOrCreate('codex');
    registry.getOrCreate('codex');
    registry.getOrCreate('codex');

    // The thunk is only read to judge, so a count of zero is a count of judgements.
    expect(read).not.toHaveBeenCalled();
  });

  it('judges again on each lookup of an uncontained backend', () => {
    const { read } = grantable(['claude']);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'claude');
    registry.getOrCreate('claude');
    const afterConstruction = read.mock.calls.length;

    registry.getOrCreate('claude');
    registry.getOrCreate('claude');

    expect(read.mock.calls.length - afterConstruction).toBe(2);
  });

  describe('construction still refuses with the real factory', () => {
    async function realFactory() {
      const actual = await vi.importActual<typeof import('../../../src/runner/backend-runner-factory')>(
        '../../../src/runner/backend-runner-factory'
      );
      return actual.createBackendRunner;
    }

    it('refuses with no grant', async () => {
      const { read } = grantable([]);
      vi.mocked(createBackendRunner).mockImplementationOnce(await realFactory());
      const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'claude');

      expect(() => registry.getOrCreate('claude')).toThrow(UncontainedBackendRefusedError);
    });

    it('refuses with a revoked grant, on a runner built in the window', async () => {
      const { granted, read } = grantable(['claude']);
      granted.delete('claude');
      vi.mocked(createBackendRunner).mockImplementationOnce(await realFactory());
      const registry = new BackendRunnerRegistry({ uncontainedGranted: read }, 'claude');

      expect(() => registry.getOrCreate('claude')).toThrow(UncontainedBackendRefusedError);
    });
  });
});

/**
 * FR-R4-F06 (FR-020, FR-021, FR-024; T22; contract S, S3) -- one teardown per registry.
 *
 * `cancelAll()` fired every runner's ladder and returned, so shutdown could not wait for any
 * tree. `closeAndTearDown()` closes admission synchronously, then waits for the outcomes under
 * one shared deadline, and is memoized so a second caller gets the first answer.
 */
describe('BackendRunnerRegistry.closeAndTearDown (T22)', () => {
  const outcomeOf = (result: TreeTeardownResult, runId = 'run-1'): TreeTeardownOutcome => ({
    attribution: { runId, phase: 'speckit-implement', iteration: 2 },
    runner: 'claude-cli',
    pid: 4242,
    result
  });

  /** A stub whose `settleTeardowns` is whatever the case needs. */
  function stubSettling(settle: BackendRunner['settleTeardowns']): BackendRunner {
    return { ...makeStub(), settleTeardowns: settle };
  }

  function registryOver(...stubs: BackendRunner[]): {
    registry: BackendRunnerRegistry;
    runners: BackendRunner[];
  } {
    for (const stub of stubs) vi.mocked(createBackendRunner).mockImplementationOnce(() => stub);
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const kinds: BackendRunnerKind[] = ['claude', 'agy'];
    return { registry, runners: stubs.map((_s, index) => registry.getOrCreate(kinds[index])) };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes admission, closes every runner and cancels every runner before its first await', () => {
    const { registry, runners } = registryOver(
      stubSettling(async () => []),
      stubSettling(async () => [])
    );

    void registry.closeAndTearDown();

    // Asserted synchronously: nothing may spawn between the call and the first await.
    for (const runner of runners) {
      expect(runner.close).toHaveBeenCalledTimes(1);
      expect(runner.cancelActive).toHaveBeenCalledTimes(1);
    }
    vi.mocked(createBackendRunner).mockImplementationOnce(() => makeStub());
    const late = registry.getOrCreate('codex');
    expect(late.close, 'a runner built after the call is handed out closed').toHaveBeenCalledTimes(1);
  });

  it('returns the same promise on a second call, and closes each runner once', async () => {
    const { registry, runners } = registryOver(stubSettling(async () => []));

    const first = registry.closeAndTearDown();
    const second = registry.closeAndTearDown();

    expect(second).toBe(first);
    await first;
    expect(runners[0]?.close).toHaveBeenCalledTimes(1);
    expect(runners[0]?.cancelActive).toHaveBeenCalledTimes(1);
  });

  it('reports every runner\'s outcomes, the bound and a non-negative elapsed time', async () => {
    const { registry } = registryOver(
      stubSettling(async () => [outcomeOf('group-gone', 'run-a')]),
      stubSettling(async () => [outcomeOf('platform-unanswerable', 'run-b')])
    );

    const report = await registry.closeAndTearDown();

    expect(report.outcomes.map((outcome) => outcome.attribution.runId)).toEqual(['run-a', 'run-b']);
    expect(report.boundMs).toBe(TEARDOWN_BOUND_MS);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports no outcomes when no runner was ever built', async () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: GRANT_CLAUDE_AGY }, 'claude');
    const report = await registry.closeAndTearDown();
    expect(report.outcomes).toEqual([]);
    expect(report.boundMs).toBe(TEARDOWN_BOUND_MS);
  });

  it('hands every runner one shared deadline that elapses at TEARDOWN_BOUND_MS and not before', async () => {
    vi.useFakeTimers();
    const seen: Array<Promise<void> | undefined> = [];
    // Each stub waits for the deadline, as a runner with a pending ladder does. Stubs that
    // answered at once would let the registry finish early and cancel the timer.
    const { registry } = registryOver(
      stubSettling(async (deadline) => {
        seen.push(deadline);
        await deadline;
        return [];
      }),
      stubSettling(async (deadline) => {
        seen.push(deadline);
        await deadline;
        return [];
      })
    );

    void registry.closeAndTearDown();

    expect(seen).toHaveLength(2);
    expect(seen[0], 'the deadline is shared, not one per runner').toBe(seen[1]);
    let elapsed = false;
    void seen[0]?.then(() => {
      elapsed = true;
    });
    await vi.advanceTimersByTimeAsync(TEARDOWN_BOUND_MS - 1);
    expect(elapsed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(elapsed).toBe(true);
  });

  it('reports a ladder still pending at the bound as bound-elapsed, with its attribution', async () => {
    vi.useFakeTimers();
    // A cooperative runner: it stamps bound-elapsed when the registry's deadline passes first.
    const { registry } = registryOver(
      stubSettling(async (deadline) => {
        await deadline;
        return [outcomeOf('bound-elapsed')];
      })
    );

    const reported = registry.closeAndTearDown();
    await vi.advanceTimersByTimeAsync(TEARDOWN_BOUND_MS);
    const report = await reported;

    expect(report.outcomes).toEqual([outcomeOf('bound-elapsed')]);
  });

  it('settles at the bound even when a runner ignores the deadline', async () => {
    vi.useFakeTimers();
    const { registry } = registryOver(
      stubSettling(() => new Promise<readonly TreeTeardownOutcome[]>(() => undefined)),
      stubSettling(async () => [outcomeOf('group-gone')])
    );

    let settled = false;
    const reported = registry.closeAndTearDown().then((report) => {
      settled = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(TEARDOWN_BOUND_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    const report = await reported;

    expect(settled).toBe(true);
    // The silent runner can be neither attributed nor reported; the other one still is.
    expect(report.outcomes).toEqual([outcomeOf('group-gone')]);
  });

  it('measures elapsedMs with a monotonic clock, not the wall clock', async () => {
    vi.useFakeTimers();
    const { registry } = registryOver(
      stubSettling(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
      )
    );

    const reported = registry.closeAndTearDown();
    // The wall clock jumps back an hour mid-teardown, as an NTP step can make it.
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(500);
    const report = await reported;

    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.elapsedMs).toBeLessThan(1_000);
  });

  it('keeps going when one runner throws while closing, and still reports the other', async () => {
    const throwing = stubSettling(async () => []);
    vi.mocked(throwing.close).mockImplementation(() => {
      throw new Error('adapter teardown failure');
    });
    const { registry, runners } = registryOver(
      throwing,
      stubSettling(async () => [outcomeOf('group-gone', 'run-b')])
    );

    const report = await registry.closeAndTearDown();

    expect(runners[1]?.cancelActive).toHaveBeenCalledTimes(1);
    expect(report.outcomes.map((outcome) => outcome.attribution.runId)).toEqual(['run-b']);
  });

  it('never rejects when a runner\'s settleTeardowns rejects', async () => {
    const { registry } = registryOver(
      stubSettling(async () => {
        throw new Error('the adapter lost its ladders');
      }),
      stubSettling(async () => [outcomeOf('group-gone')])
    );

    const report = await registry.closeAndTearDown();

    expect(report.outcomes).toEqual([outcomeOf('group-gone')]);
  });

  it('cancelAll() stays idempotent and delegates to the same teardown', async () => {
    const { registry, runners } = registryOver(stubSettling(async () => []));

    registry.cancelAll();
    registry.cancelAll();
    await registry.closeAndTearDown();

    expect(runners[0]?.close).toHaveBeenCalledTimes(1);
    expect(runners[0]?.cancelActive).toHaveBeenCalledTimes(1);
  });
});
