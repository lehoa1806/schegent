import { describe, it, expect, vi } from 'vitest';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import type { BackendRunner } from '../../../src/contracts/backend-runner';

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
    cancelActive: vi.fn().mockReturnValue(false)
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
