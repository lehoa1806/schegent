// Feature 014 T051 — unit tests for the Wake up activation /
// deactivation lifecycle.
//
// What's covered:
//   activateWakeUp:
//     - mirrors workspace-roots.json to <homeDir>/workspace-roots.json
//     - calls daemon-manager.reconcile() with the current settings
//     - emits a single `wakeup-workspace-roots-updated` audit event
//       carrying `rootCount` (NOT the paths)
//     - swallows reconcile failures with a single warn log
//
//   deactivateWakeUp (the FR-023 contract):
//     - calls daemon-manager.uninstall() when settings.enabled=true
//     - SKIPS uninstall when settings.enabled=false (nothing to remove)
//     - on uninstall failure, emits exactly one audit event
//       `wakeup-daemon-uninstall-failed-on-deactivate` (outcome:
//       'failure') and never throws — extension shutdown must not be
//       blocked by a transient launchctl/schtasks/etc. error.
//
// The activation module owns the AUDIT EVENT VOCABULARY for two events
// that no other module emits. Audit-shape drift would silently strand
// operator-meaningful evidence on the floor, so we pin it here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { activateWakeUp, deactivateWakeUp, type ActivationDeps } from '../../../src/wakeup/activation';
import type {
  DaemonManager,
  DaemonState,
  ApplyOptions,
  ReconcileAction
} from '../../../src/wakeup/daemon-manager';
import type { WakeUpConfig } from '../../../src/wakeup/settings';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeConfig implements WakeUpConfig {
  private values: Map<string, unknown> = new Map();
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown, _target: number): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeDaemonManager
  implements Pick<DaemonManager, 'apply' | 'uninstall' | 'inspect' | 'reconcile'>
{
  public reconcileCalls: ApplyOptions[] = [];
  public uninstallCalls = 0;
  public applyCalls: ApplyOptions[] = [];
  public reconcileResult: { action: ReconcileAction } = { action: 'none' };
  public reconcileError: Error | null = null;
  public uninstallError: Error | null = null;

  async apply(opts: ApplyOptions): Promise<void> {
    this.applyCalls.push(opts);
  }
  async uninstall(): Promise<void> {
    this.uninstallCalls += 1;
    if (this.uninstallError) throw this.uninstallError;
  }
  async inspect(): Promise<DaemonState> {
    return { registered: false, schedule: null };
  }
  async reconcile(opts: ApplyOptions): Promise<{ action: ReconcileAction }> {
    this.reconcileCalls.push(opts);
    if (this.reconcileError) throw this.reconcileError;
    return this.reconcileResult;
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
  public failOn: string | null = null;
  async append(entry: AuditCall): Promise<void> {
    if (this.failOn && entry.eventType === this.failOn) {
      throw new Error('audit-append simulated failure');
    }
    this.calls.push(entry);
  }
}

class FakeLogger {
  public readonly warnings: string[] = [];
  warn(msg: string): void {
    this.warnings.push(msg);
  }
}

interface Harness {
  deps: ActivationDeps;
  config: FakeConfig;
  daemon: FakeDaemonManager;
  audit: FakeAudit;
  logger: FakeLogger;
  tempRoot: string;
  homeDir: string;
}

function buildHarness(overrides: Partial<ActivationDeps> = {}): Harness {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'wakeup-activation-'));
  const homeDir = path.join(tempRoot, 'wakeup-home');
  const config = new FakeConfig();
  const daemon = new FakeDaemonManager();
  const audit = new FakeAudit();
  const logger = new FakeLogger();
  const deps: ActivationDeps = {
    readConfig: () => config,
    daemonManager: daemon as unknown as DaemonManager,
    workspaceRoots: () => [],
    homeDir,
    sourceRunnerPath: path.join(tempRoot, 'runner.js'),
    audit,
    logger,
    ...overrides
  };
  return { deps, config, daemon, audit, logger, tempRoot, homeDir };
}

// ── activateWakeUp ──────────────────────────────────────────────────────────

describe('activateWakeUp', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness({
      workspaceRoots: () => ['/Users/op/project-a', '/Users/op/project-b']
    });
  });

  afterEach(() => {
    rmSync(harness.tempRoot, { recursive: true, force: true });
  });

  it('mirrors workspace-roots.json atomically (.tmp → rename)', async () => {
    await activateWakeUp(harness.deps);

    const target = path.join(harness.homeDir, 'workspace-roots.json');
    expect(existsSync(target)).toBe(true);
    const body = JSON.parse(readFileSync(target, 'utf8'));
    expect(body).toEqual({ roots: ['/Users/op/project-a', '/Users/op/project-b'] });
  });

  it('emits wakeup-workspace-roots-updated audit event with rootCount only', async () => {
    await activateWakeUp(harness.deps);

    const evt = harness.audit.calls.find((c) => c.eventType === 'wakeup-workspace-roots-updated');
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('info');
    expect(evt?.payload).toEqual({ rootCount: 2 });
    // Defense-in-depth: paths must never leak into the audit pipeline.
    const serialized = JSON.stringify(evt?.payload);
    expect(serialized).not.toContain('/Users/op/project-a');
    expect(serialized).not.toContain('/Users/op/project-b');
  });

  it('calls daemon-manager.reconcile with current settings', async () => {
    harness.config.set('wakeUp.enabled', true);
    harness.config.set('wakeUp.schedulerType', 'chronological');
    harness.config.set('wakeUp.chronologicalTime', '03:30');
    harness.daemon.reconcileResult = { action: 'installed' };

    const result = await activateWakeUp(harness.deps);

    expect(harness.daemon.reconcileCalls.length).toBe(1);
    expect(harness.daemon.reconcileCalls[0].settings.enabled).toBe(true);
    expect(harness.daemon.reconcileCalls[0].settings.chronologicalTime).toBe('03:30');
    expect(result.reconcileAction).toBe('installed');
    expect(result.workspaceRootsMirrored).toBe(true);
  });

  it('swallows reconcile failures and logs one warn line (FR-024 best-effort)', async () => {
    harness.daemon.reconcileError = new Error('launchctl boom');

    const result = await activateWakeUp(harness.deps);

    expect(result.reconcileAction).toBe('none');
    expect(harness.logger.warnings.length).toBe(1);
    expect(harness.logger.warnings[0]).toContain('reconcile failed');
    expect(harness.logger.warnings[0]).toContain('launchctl boom');
  });

  it('returns workspaceRootsMirrored=false when the mirror write fails', async () => {
    // Force a write failure by passing a homeDir that the FS can't create
    // (an existing FILE where the directory should go).
    const bogusHome = path.join(harness.tempRoot, 'is-a-file');
    writeFileSync(bogusHome, 'sentinel');
    const fail = buildHarness({
      homeDir: bogusHome,
      workspaceRoots: () => ['/x']
    });
    const result = await activateWakeUp(fail.deps);
    expect(result.workspaceRootsMirrored).toBe(false);
    expect(fail.logger.warnings.some((w) => w.includes('workspace-roots mirror failed'))).toBe(true);
    rmSync(fail.tempRoot, { recursive: true, force: true });
  });
});

// ── deactivateWakeUp (FR-023) ───────────────────────────────────────────────

describe('deactivateWakeUp (FR-023)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  afterEach(() => {
    rmSync(harness.tempRoot, { recursive: true, force: true });
  });

  it('calls daemon-manager.uninstall when settings.enabled=true', async () => {
    harness.config.set('wakeUp.enabled', true);

    await deactivateWakeUp(harness.deps);

    expect(harness.daemon.uninstallCalls).toBe(1);
  });

  it('SKIPS uninstall when settings.enabled=false (nothing was installed)', async () => {
    harness.config.set('wakeUp.enabled', false);

    await deactivateWakeUp(harness.deps);

    expect(harness.daemon.uninstallCalls).toBe(0);
    // No failure audit either — this is the "nothing to do" branch.
    expect(
      harness.audit.calls.find((c) => c.eventType === 'wakeup-daemon-uninstall-failed-on-deactivate')
    ).toBeUndefined();
  });

  it('emits wakeup-daemon-uninstall-failed-on-deactivate when uninstall throws', async () => {
    harness.config.set('wakeUp.enabled', true);
    harness.daemon.uninstallError = new Error('launchctl unload: Permission denied');

    await deactivateWakeUp(harness.deps);

    const evt = harness.audit.calls.find(
      (c) => c.eventType === 'wakeup-daemon-uninstall-failed-on-deactivate'
    );
    expect(evt).toBeDefined();
    expect(evt?.outcome).toBe('failure');
    expect(evt?.payload).toEqual({ reason: 'launchctl unload: Permission denied' });
    expect(evt?.runId).toBe('wakeup-system');
    expect(evt?.phase).toBe('wakeup');
    expect(evt?.iteration).toBe(0);
  });

  it('does NOT throw when uninstall AND audit both fail (best-effort shutdown)', async () => {
    harness.config.set('wakeUp.enabled', true);
    harness.daemon.uninstallError = new Error('boom');
    harness.audit.failOn = 'wakeup-daemon-uninstall-failed-on-deactivate';

    await expect(deactivateWakeUp(harness.deps)).resolves.toBeUndefined();
    expect(harness.logger.warnings.some((w) => w.includes('deactivate uninstall failed'))).toBe(true);
  });

  it('logs the uninstall error message at warn level (defense-in-depth)', async () => {
    harness.config.set('wakeUp.enabled', true);
    harness.daemon.uninstallError = new Error('schtasks /Delete failed (8)');

    await deactivateWakeUp(harness.deps);

    expect(harness.logger.warnings.length).toBe(1);
    expect(harness.logger.warnings[0]).toContain('deactivate uninstall failed');
    expect(harness.logger.warnings[0]).toContain('schtasks /Delete failed (8)');
  });
});
