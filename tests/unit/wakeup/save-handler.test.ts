// Feature 014 T035 — unit tests for the `CMD_SAVE_WAKEUP_SETTINGS`
// host save-handler. Exercises every `RejectReason` from
// `contracts/wakeup-settings-ipc.md` and the FR-017 rollback rule.
//
// What's covered here:
//   - envelope validation: `unknown-key`
//   - payload validation reasons (delegated to `writeSettings`):
//     `invalid-scheduler-type`, `invalid-chronological-time`,
//     `invalid-periodic-interval`, `periodic-interval-below-minimum`
//   - `config-write-failed` when `writeSettings` throws non-validation
//   - `daemon-install-failed:<sanitized>` when the daemon driver throws
//   - rollback-of-prior-settings ONLY when `priorRegistration.registered === true`
//     and the daemon driver failed (FR-017)
//   - audit event shape for each successful transition
//     (`wakeup-daemon-installed`, `wakeup-daemon-updated`,
//     `wakeup-daemon-uninstalled`) and for the failure case
//     (`wakeup-daemon-install-failed`)
//
// Everything is in-memory: no `vscode`, no `child_process`, no real fs.

import { describe, it, expect } from 'vitest';
import {
  createSaveWakeUpSettingsHandler,
  type SaveWakeUpHandlerDeps,
  type SaveWakeUpPayload
} from '../../../src/wakeup/save-handler';
import type {
  DaemonManager,
  DaemonState,
  ApplyOptions
} from '../../../src/wakeup/daemon-manager';
import type { WakeUpConfig } from '../../../src/wakeup/settings';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeConfig implements WakeUpConfig {
  private values: Map<string, unknown> = new Map();
  public failOn: string | null = null;
  public failKind: 'throw' | 'reject' = 'throw';

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown, _target: number): Promise<void> {
    if (this.failOn === key) {
      if (this.failKind === 'throw') throw new Error('simulated EACCES');
      throw new Error('rejected');
    }
    this.values.set(key, value);
  }
}

interface FakeDaemonOpts {
  inspectResult: DaemonState;
  applyError?: Error;
  uninstallError?: Error;
}

class FakeDaemonManager
  implements Pick<DaemonManager, 'apply' | 'uninstall' | 'inspect'>
{
  public readonly applyCalls: ApplyOptions[] = [];
  public uninstallCalls = 0;

  constructor(private readonly opts: FakeDaemonOpts) {}

  async apply(opts: ApplyOptions): Promise<void> {
    this.applyCalls.push(opts);
    if (this.opts.applyError) throw this.opts.applyError;
  }
  async uninstall(): Promise<void> {
    this.uninstallCalls += 1;
    if (this.opts.uninstallError) throw this.opts.uninstallError;
  }
  async inspect(): Promise<DaemonState> {
    return this.opts.inspectResult;
  }
}

interface AuditCall {
  runId: string;
  phase: string;
  iteration: number;
  eventType: string;
  payload: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'info';
}

class FakeAudit {
  public readonly calls: AuditCall[] = [];
  async append(entry: AuditCall): Promise<void> {
    this.calls.push(entry);
  }
}

const validPayload: SaveWakeUpPayload = Object.freeze({
  enabled: true,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h'
});

function makeDeps(
  overrides: Partial<SaveWakeUpHandlerDeps> & { config?: FakeConfig; daemon?: FakeDaemonManager; audit?: FakeAudit } = {}
): {
  deps: SaveWakeUpHandlerDeps;
  config: FakeConfig;
  daemon: FakeDaemonManager;
  audit: FakeAudit;
} {
  const config = overrides.config ?? new FakeConfig();
  const daemon =
    overrides.daemon ??
    new FakeDaemonManager({ inspectResult: { registered: false, schedule: null } });
  const audit = overrides.audit ?? new FakeAudit();
  const deps: SaveWakeUpHandlerDeps = {
    readConfig: () => config,
    daemonManager: daemon as unknown as DaemonManager,
    workspaceRoots: () => [],
    sourceRunnerPath: '/dist/wakeup-runner.js',
    homeDir: '/tmp/wakeup-home',
    audit,
    platform: () => 'darwin',
    sanitize: (m) => m.replace(/\/[^\s]+/g, '<redacted>'),
    ...overrides
  };
  return { deps, config, daemon, audit };
}

// ── Envelope validation ─────────────────────────────────────────────────────

describe('save-handler: envelope validation', () => {
  it('rejects an extra key with reason "unknown-key"', async () => {
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({ ...validPayload, extra: 1 } as SaveWakeUpPayload);
    expect(result).toEqual({ ok: false, reason: 'unknown-key' });
  });
});

// ── Payload validation reasons ──────────────────────────────────────────────

describe('save-handler: payload validation', () => {
  it('rejects bad schedulerType with "invalid-scheduler-type"', async () => {
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...validPayload,
      schedulerType: 'wat' as 'chronological' | 'periodic'
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-scheduler-type' });
  });

  it('rejects malformed chronologicalTime with "invalid-chronological-time"', async () => {
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({ ...validPayload, chronologicalTime: '25:99' });
    expect(result).toEqual({ ok: false, reason: 'invalid-chronological-time' });
  });

  it('rejects malformed periodicInterval with "invalid-periodic-interval"', async () => {
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...validPayload,
      schedulerType: 'periodic',
      periodicInterval: 'Soon'
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-periodic-interval' });
  });

  it('rejects "Every 0m" as "invalid-periodic-interval"', async () => {
    // `parsePeriodic` rejects count<=0 before the below-minimum branch
    // ever runs, so 0 minutes is classified as malformed (which is
    // operator-meaningful: 0 ≠ "below minimum", it is "not a valid
    // periodic spec at all"). The `periodic-interval-below-minimum`
    // reason remains in the closed RejectReason set as defense-in-depth
    // against a future relaxation of `parsePeriodic`.
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...validPayload,
      schedulerType: 'periodic',
      periodicInterval: 'Every 0m'
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-periodic-interval' });
  });
});

// ── Successful transitions + audit shape ────────────────────────────────────

describe('save-handler: successful transitions emit correct audit events', () => {
  it('prior unregistered + enabled = "wakeup-daemon-installed"', async () => {
    const { deps, audit, daemon } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: true });
    expect(daemon.applyCalls.length).toBe(1);
    expect(daemon.uninstallCalls).toBe(0);
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-daemon-installed');
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('success');
    expect(evt?.payload).toMatchObject({
      platform: 'darwin',
      identifier: 'com.schegent.wakeup',
      schedulerType: 'chronological',
      scheduleExpression: '04:00'
    });
    expect(evt?.runId).toBe('wakeup-system');
    expect(evt?.phase).toBe('wakeup');
    expect(evt?.iteration).toBe(0);
  });

  it('prior registered + enabled = "wakeup-daemon-updated"', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: true, schedule: { kind: 'chronological', hour: 3, minute: 0 } }
    });
    const { deps, audit } = makeDeps({ daemon });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: true });
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-daemon-updated');
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('success');
  });

  it('disabled = "wakeup-daemon-uninstalled" via daemon.uninstall()', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: true, schedule: { kind: 'chronological', hour: 4, minute: 0 } }
    });
    const { deps, audit } = makeDeps({ daemon });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({ ...validPayload, enabled: false });
    expect(result).toEqual({ ok: true });
    expect(daemon.applyCalls.length).toBe(0);
    expect(daemon.uninstallCalls).toBe(1);
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-daemon-uninstalled');
    expect(evt).toBeDefined();
  });
});

// ── T041 — wakeup-workspace-roots-updated event ────────────────────────────
//
// On every successful enabled=true Save, the handler MUST emit
// `wakeup-workspace-roots-updated` carrying ONLY the platform + count.
// The count is the operator-meaningful trace signal (when did the
// runner's defense set change), and excluding the paths preserves the
// audit-pipeline redaction policy on workspace paths (FR-024).

describe('save-handler: wakeup-workspace-roots-updated (T041)', () => {
  it('fires with the exact count of roots on enabled=true install', async () => {
    const { deps, audit } = makeDeps({
      workspaceRoots: () => ['/Users/op/projects/a', '/Users/op/projects/b', '/Users/op/projects/c']
    });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: true });
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('info');
    expect(evt?.payload).toEqual({ platform: 'darwin', count: 3 });
  });

  it('fires with count: 0 when no workspaces are open', async () => {
    const { deps, audit } = makeDeps({ workspaceRoots: () => [] });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: true });
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeDefined();
    expect(evt?.payload).toEqual({ platform: 'darwin', count: 0 });
  });

  it('fires on the update transition (prior registered + enabled = true)', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: true, schedule: { kind: 'chronological', hour: 3, minute: 0 } }
    });
    const { deps, audit } = makeDeps({
      daemon,
      workspaceRoots: () => ['/w1']
    });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: true });
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeDefined();
    expect(evt?.payload).toEqual({ platform: 'darwin', count: 1 });
  });

  it('does NOT fire on the uninstall path (enabled=false)', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: true, schedule: { kind: 'chronological', hour: 4, minute: 0 } }
    });
    const { deps, audit } = makeDeps({
      daemon,
      workspaceRoots: () => ['/w1', '/w2']
    });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({ ...validPayload, enabled: false });
    expect(result).toEqual({ ok: true });
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeUndefined();
  });

  it('does NOT fire when the daemon driver fails (no successful publish)', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: false, schedule: null },
      applyError: new Error('launchctl failed')
    });
    const { deps, audit } = makeDeps({
      daemon,
      workspaceRoots: () => ['/w1']
    });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result.ok).toBe(false);
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeUndefined();
  });

  it('payload carries ONLY platform + count — no paths/roots fields leak', async () => {
    const { deps, audit } = makeDeps({
      workspaceRoots: () => ['/Users/op/secret-project', '/Users/op/other']
    });
    const handler = createSaveWakeUpSettingsHandler(deps);
    await handler(validPayload);
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeDefined();
    // Defense-in-depth: explicit absence of every field name an operator
    // might be tempted to add in a future "ergonomics" change.
    const payload = evt!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('paths');
    expect(payload).not.toHaveProperty('roots');
    expect(payload).not.toHaveProperty('workspaceRoots');
    expect(payload).not.toHaveProperty('workspaces');
    expect(Object.keys(payload).sort()).toEqual(['count', 'platform']);
    // And the actual path strings must not appear anywhere in the
    // serialized payload (covers any future stray nesting).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('/Users/op/secret-project');
    expect(serialized).not.toContain('/Users/op/other');
  });
});

// ── Daemon driver failure + rollback rule (FR-017) ──────────────────────────

describe('save-handler: daemon-install-failed with rollback rule', () => {
  it('emits "daemon-install-failed:<sanitized>" + sanitizes path-like fragments', async () => {
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: false, schedule: null },
      applyError: new Error('launchctl failed at /Users/secret/Library/foo')
    });
    const { deps, audit } = makeDeps({ daemon });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason.startsWith('daemon-install-failed:')).toBe(true);
    expect(result.reason).not.toContain('/Users/secret');
    const evt = audit.calls.find((c) => c.eventType === 'wakeup-daemon-install-failed');
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('failure');
    const reasonField = evt?.payload?.reason as string;
    expect(reasonField).not.toContain('/Users/secret');
  });

  it('does NOT roll back when prior state was unregistered (operator intent preserved)', async () => {
    const config = new FakeConfig();
    // Seed config so we can detect a write happened (and was NOT rolled back).
    const daemon = new FakeDaemonManager({
      inspectResult: { registered: false, schedule: null },
      applyError: new Error('boom')
    });
    const { deps } = makeDeps({ config, daemon });
    const handler = createSaveWakeUpSettingsHandler(deps);
    await handler({
      ...validPayload,
      chronologicalTime: '05:30'
    });
    // No rollback → the new value sticks.
    expect(config.get('wakeUp.chronologicalTime', '')).toBe('05:30');
  });

  it('DOES roll back when prior state was registered (FR-017)', async () => {
    const config = new FakeConfig();
    // Seed PRIOR state via direct config writes (NOT via the handler).
    config.set('wakeUp.enabled', true);
    config.set('wakeUp.chronologicalTime', '03:00');
    const daemon = new FakeDaemonManager({
      inspectResult: {
        registered: true,
        schedule: { kind: 'chronological', hour: 3, minute: 0 }
      },
      applyError: new Error('boom')
    });
    const { deps } = makeDeps({ config, daemon });
    const handler = createSaveWakeUpSettingsHandler(deps);
    await handler({
      ...validPayload,
      chronologicalTime: '05:30'
    });
    // Rollback → the prior value is restored.
    expect(config.get('wakeUp.chronologicalTime', '')).toBe('03:00');
  });
});

// ── Config-write failure ────────────────────────────────────────────────────

describe('save-handler: config-write-failed', () => {
  it('returns "config-write-failed" when writeSettings throws non-validation', async () => {
    const config = new FakeConfig();
    config.failOn = 'wakeUp.enabled';
    const { deps } = makeDeps({ config });
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(validPayload);
    expect(result).toEqual({ ok: false, reason: 'config-write-failed' });
  });
});
