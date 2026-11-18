import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import {
  BackendCapabilityService,
  type BackendCapabilitySnapshot
} from '../../../src/services/backend-capability-service';
import {
  BackendPingService,
  type BackendPingServiceDeps
} from '../../../src/services/backend-ping-service';

interface CapturedAuditEntry extends Record<string, unknown> {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Probe = BackendPingServiceDeps['capabilities']['probe'];

/** The last scan as the capability service holds it; `generation` is 0 until one has published. */
function lastScan(
  generation: number,
  ...available: BackendRunnerKind[]
): BackendCapabilitySnapshot {
  return {
    generation,
    availableBackends: available,
    availableModels: { claude: [], codex: [], agy: [] }
  };
}

/** What a ping reads: its probe, the last scan, and a scan that records each start. */
function capabilitiesOf(probe: Probe, scanned: BackendCapabilitySnapshot = lastScan(0)) {
  return { probe, getSnapshot: () => scanned, scan: vi.fn(async () => scanned) };
}

/** Lets every queued promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

describe('BackendPingService', () => {
  it('publishes bounded success state and a paths-free audit event', async () => {
    const auditEntries: CapturedAuditEntry[] = [];
    const audit = { append: async (entry: Record<string, unknown>) => { auditEntries.push(entry as CapturedAuditEntry); } };
    const onDidChange = vi.fn();
    const ticks = [1_000, 1_037];
    const service = new BackendPingService({
      capabilities: capabilitiesOf(async () => ({ runner: 'claude' as const, available: true as const, exitCode: 0 as const })),
      readTimeoutSeconds: () => 5,
      audit,
      logger: { warn: vi.fn() },
      onDidChange,
      now: () => ticks.shift() ?? 1_037
    });

    const result = await service.ping('claude', 'correlation-1');

    expect(result).toEqual({
      accepted: true,
      state: {
        status: 'success', runner: 'claude', startedAt: 1_000,
        completedAt: 1_037, latencyMs: 37, timeoutSeconds: 5
      }
    });
    expect(onDidChange).toHaveBeenCalledTimes(2);
    const entry = auditEntries[0];
    expect(entry?.eventType).toBe('backend-ping');
    expect(Object.keys(entry?.payload ?? {}).sort()).toEqual([
      'accepted', 'completedAt', 'latencyMs', 'runner', 'startedAt',
      'status', 'timeoutSeconds'
    ]);
    expect(JSON.stringify(entry)).not.toMatch(/path|stdout|stderr|environment|stack|secret/i);
  });

  it('rejects a duplicate without starting a second probe', async () => {
    const pending = deferred<{ runner: 'claude'; available: true; exitCode: 0 }>();
    let probeCalls = 0;
    const probe = () => { probeCalls += 1; return pending.promise; };
    const audit = { append: vi.fn(async () => undefined) };
    const service = new BackendPingService({
      capabilities: capabilitiesOf(probe),
      readTimeoutSeconds: () => 5,
      audit,
      logger: { warn: vi.fn() },
      now: () => 10
    });

    const first = service.ping('claude', 'first');
    const duplicate = await service.ping('codex', 'duplicate');
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.state).toMatchObject({
      status: 'failure', runner: 'codex', cause: 'already-in-progress'
    });
    expect(probeCalls).toBe(1);
    expect(service.getState()).toMatchObject({ status: 'running', runner: 'claude' });

    pending.resolve({ runner: 'claude', available: true, exitCode: 0 });
    await first;
    expect(audit.append).toHaveBeenCalledTimes(2);
  });

  it('projects only a generic cause and numeric exit code on failure', async () => {
    const auditEntries: CapturedAuditEntry[] = [];
    const audit = { append: async (entry: Record<string, unknown>) => { auditEntries.push(entry as CapturedAuditEntry); } };
    const service = new BackendPingService({
      capabilities: capabilitiesOf(async () => ({
        runner: 'agy' as const, available: false as const,
        cause: 'non-zero-exit' as const, exitCode: 17
      })),
      readTimeoutSeconds: () => 3,
      audit,
      logger: { warn: vi.fn() },
      now: () => 20
    });
    await expect(service.ping('agy', 'failure')).resolves.toMatchObject({
      accepted: true,
      state: { status: 'failure', cause: 'non-zero-exit', exitCode: 17 }
    });
    expect(auditEntries[0]?.payload).toMatchObject({
      runner: 'agy', cause: 'non-zero-exit', exitCode: 17, timeoutSeconds: 3
    });
  });
});

// The host scans the backends once the window is trusted and again when a backend's path or the
// probe timeout changes. A backend installed or removed since, with no change of path, kept the
// tag the last scan gave it, "Not found" beside a passed test, until the window reloaded.
describe('BackendPingService against the last scan', () => {
  const finds: Probe = async (runner) => ({ runner, available: true, exitCode: 0 });
  const misses: Probe = async (runner) => ({ runner, available: false, cause: 'not-found' });
  const serviceOver = (
    capabilities: ReturnType<typeof capabilitiesOf>,
    overrides: Partial<BackendPingServiceDeps> = {}
  ) =>
    new BackendPingService({
      capabilities,
      readTimeoutSeconds: () => 5,
      audit: { append: vi.fn(async () => undefined) },
      logger: { warn: vi.fn() },
      now: () => 30,
      ...overrides
    });

  it('scans again when a ping finds a backend the last scan did not list', async () => {
    const capabilities = capabilitiesOf(finds, lastScan(1, 'codex'));
    await serviceOver(capabilities).ping('claude', 'installed-since');
    expect(capabilities.scan).toHaveBeenCalledTimes(1);
  });

  it('scans again when a ping misses a backend the last scan listed', async () => {
    const capabilities = capabilitiesOf(misses, lastScan(1, 'claude'));
    await serviceOver(capabilities).ping('claude', 'removed-since');
    expect(capabilities.scan).toHaveBeenCalledTimes(1);
  });

  it('does not scan when the ping agrees with the last scan', async () => {
    const found = capabilitiesOf(finds, lastScan(1, 'claude'));
    await serviceOver(found).ping('claude', 'still-found');
    const missing = capabilitiesOf(misses, lastScan(1));
    await serviceOver(missing).ping('claude', 'still-missing');
    expect(found.scan).not.toHaveBeenCalled();
    expect(missing.scan).not.toHaveBeenCalled();
  });

  it('does not scan before the first scan has published', async () => {
    const capabilities = capabilitiesOf(finds, lastScan(0));
    await serviceOver(capabilities).ping('claude', 'first-scan-pending');
    expect(capabilities.scan).not.toHaveBeenCalled();
  });

  it('starts the scan once the ping has published its result and appended its row', async () => {
    const capabilities = capabilitiesOf(finds, lastScan(1));
    const rows: unknown[] = [];
    const service = serviceOver(capabilities, {
      audit: { append: async (entry) => { rows.push(entry); } }
    });
    const seen: Array<{ readonly status: string; readonly rows: number }> = [];
    capabilities.scan.mockImplementation(async () => {
      seen.push({ status: service.getState().status, rows: rows.length });
      return lastScan(2, 'claude');
    });
    await service.ping('claude', 'ordered');
    expect(seen).toEqual([{ status: 'success', rows: 1 }]);
  });

  it('logs a failed scan in one fixed line and keeps the ping result', async () => {
    const capabilities = capabilitiesOf(finds, lastScan(1));
    capabilities.scan.mockRejectedValue(new Error('synthetic scan failure at /synthetic/path'));
    const logger = { warn: vi.fn() };
    const result = await serviceOver(capabilities, { logger }).ping('claude', 'scan-fails');
    await settle();
    expect(result).toMatchObject({
      accepted: true,
      state: { status: 'success', runner: 'claude' }
    });
    expect(logger.warn.mock.calls).toEqual([['backend-ping: rescan failed']]);
  });
});

interface FakeChild extends ChildProcess {
  readonly kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    pid: 123,
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(() => true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn()
  });
  return child;
}

describe('BackendPingService over the capability service', () => {
  it('lists a backend installed since the last scan once a ping finds it', async () => {
    let installed = false;
    let spawns = 0;
    const onDidChange = vi.fn();
    const capabilities = new BackendCapabilityService({
      cwd: '/workspace/project',
      resolveCliPath: (kind) => `/configured/${kind}`,
      readTimeoutSeconds: () => 5,
      buildEnv: () => ({ PATH: '/safe/bin' }),
      logger: { debug: vi.fn(), warn: vi.fn() },
      backendKinds: ['claude'],
      onDidChange,
      spawnFn: () => {
        spawns += 1;
        const child = makeChild();
        const present = installed;
        queueMicrotask(() => {
          if (!present) {
            child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
            return;
          }
          Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
          child.emit('close', 0, null);
        });
        return child;
      }
    });
    await capabilities.scan();
    expect(capabilities.getAvailableBackends()).toEqual([]);

    installed = true;
    const service = new BackendPingService({
      capabilities,
      readTimeoutSeconds: () => 5,
      audit: { append: vi.fn(async () => undefined) },
      logger: { warn: vi.fn() }
    });
    await expect(service.ping('claude', 'installed-since')).resolves.toMatchObject({
      state: { status: 'success' }
    });
    await vi.waitFor(() => { expect(capabilities.getAvailableBackends()).toEqual(['claude']); });
    // The first scan, the ping and the scan it started each ran the CLI once.
    expect(spawns).toBe(3);
    expect(onDidChange).toHaveBeenCalledTimes(1);
  });
});
