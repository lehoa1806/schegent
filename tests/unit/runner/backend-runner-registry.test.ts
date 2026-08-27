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

describe('BackendRunnerRegistry', () => {
  it('lazily constructs runners on first getOrCreate()', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'claude');
    // No construction yet.
    expect(createBackendRunner).not.toHaveBeenCalled();

    const runner = registry.getOrCreate('claude');
    expect(runner).toBeDefined();
    expect(createBackendRunner).toHaveBeenCalledWith('claude', { uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) });
  });

  it('returns the same runner on repeated getOrCreate() calls', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'claude');
    const a = registry.getOrCreate('claude');
    const b = registry.getOrCreate('claude');
    expect(a).toBe(b);
  });

  it('creates separate runners for different kinds', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'claude');
    const claude = registry.getOrCreate('claude');
    const agy = registry.getOrCreate('agy');
    expect(claude).not.toBe(agy);
  });

  it('falls back to globalDefault when kind is undefined', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'agy');
    const runner = registry.getOrCreate(undefined);
    expect(createBackendRunner).toHaveBeenCalledWith('agy', { uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) });
    expect(runner).toBeDefined();
  });

  it('getGlobalDefault() returns the configured default', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'codex');
    expect(registry.getGlobalDefault()).toBe('codex');
  });

  it('cancelAll() calls cancelActive() on every cached runner', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'claude');
    const r1 = registry.getOrCreate('claude');
    const r2 = registry.getOrCreate('agy');
    registry.cancelAll();
    expect(r1.cancelActive).toHaveBeenCalled();
    expect(r2.cancelActive).toHaveBeenCalled();
  });

  it('hasAnyActiveProcess() returns true when any runner is active', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>(['claude', 'agy']) }, 'claude');
    const runner = registry.getOrCreate('claude');
    expect(registry.hasAnyActiveProcess()).toBe(false);
    // Simulate an active process.
    Object.defineProperty(runner, 'hasActiveProcess', { get: () => true });
    expect(registry.hasAnyActiveProcess()).toBe(true);
  });
});
