import { describe, expect, it, vi } from 'vitest';
import { BackendPingService } from '../../../src/services/backend-ping-service';

interface CapturedAuditEntry extends Record<string, unknown> {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('BackendPingService', () => {
  it('publishes bounded success state and a paths-free audit event', async () => {
    const auditEntries: CapturedAuditEntry[] = [];
    const audit = { append: async (entry: Record<string, unknown>) => { auditEntries.push(entry as CapturedAuditEntry); } };
    const onDidChange = vi.fn();
    const ticks = [1_000, 1_037];
    const service = new BackendPingService({
      capabilities: { probe: async () => ({ runner: 'claude' as const, available: true as const, exitCode: 0 as const }) },
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
      capabilities: { probe },
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
      capabilities: {
        probe: async () => ({
          runner: 'agy' as const, available: false as const,
          cause: 'non-zero-exit' as const, exitCode: 17
        })
      },
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
