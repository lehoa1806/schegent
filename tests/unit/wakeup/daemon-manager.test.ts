// Feature 014 T034 — unit tests for the cross-platform DaemonManager
// facade.
//
// What's covered here:
//   - `apply(enabled=true)` publishes the runner bundle (so `runner.js`,
//     `settings.json`, `workspace-roots.json` exist at homeDir) and
//     calls `installer.install()` with the normalized schedule.
//   - `apply(enabled=false)` skips bundle publish and calls
//     `installer.uninstall()`.
//   - `uninstall()` proxies straight to the installer.
//   - `inspect()` returns the installer's reported state.
//   - The `installerFactory` is asked for the platform the
//     `platform()` override returns — verifying dispatch correctness on
//     all four supported platforms.
//   - `reconcile()` state table (per contracts/daemon-registration.md):
//       enabled=false + state.registered=false  → action='none', no calls
//       enabled=false + state.registered=true   → action='uninstalled'
//       enabled=true  + state.registered=false  → action='installed'
//       enabled=true  + state.registered=true & schedule matches → 'none'
//       enabled=true  + state.registered=true & schedule differs → 'updated'
//   - Note: the FR-017 rollback of *config* lives in `save-handler.ts`,
//     not in `DaemonManager`. The daemon-manager faithfully propagates
//     install errors; the save-handler is the rollback layer. We DO
//     verify here that `apply()` re-raises installer errors (so the
//     save-handler can observe them).

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  DaemonManager,
  type CommandRunner,
  type DaemonInstaller,
  type DaemonState,
  type InstallOptions
} from '../../../src/wakeup/daemon-manager';
import type { WakeUpPlatform } from '../../../src/wakeup/platform-detect';
import type { WakeUpSettings } from '../../../src/wakeup/settings';
import type { NormalizedSchedule } from '../../../src/wakeup/schedule-spec';

// ── Fakes ───────────────────────────────────────────────────────────────────

class StubCommandRunner implements CommandRunner {
  public readonly calls: Array<{ cmd: string; args: readonly string[] }> = [];
  async run(cmd: string, args: readonly string[]) {
    this.calls.push({ cmd, args });
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

class FakeInstaller implements DaemonInstaller {
  public readonly installCalls: InstallOptions[] = [];
  public uninstallCalls = 0;
  public inspectCalls = 0;
  public throwOnInstall: Error | null = null;
  public throwOnUninstall: Error | null = null;
  private inspectResult: DaemonState = { registered: false, schedule: null };

  setInspectResult(s: DaemonState): void {
    this.inspectResult = s;
  }

  async install(opts: InstallOptions): Promise<void> {
    this.installCalls.push(opts);
    if (this.throwOnInstall) throw this.throwOnInstall;
  }
  async uninstall(): Promise<void> {
    this.uninstallCalls += 1;
    if (this.throwOnUninstall) throw this.throwOnUninstall;
  }
  async inspect(): Promise<DaemonState> {
    this.inspectCalls += 1;
    return this.inspectResult;
  }
}

const validChronologicalSettings: WakeUpSettings = Object.freeze({
  enabled: true,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 1h',
  model: 'runner-default'
});

const validPeriodicSettings: WakeUpSettings = Object.freeze({
  enabled: true,
  schedulerType: 'periodic',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 1h',
  model: 'runner-default'
});

const disabledSettings: WakeUpSettings = Object.freeze({
  ...validChronologicalSettings,
  enabled: false
});

interface TestHarness {
  manager: DaemonManager;
  installer: FakeInstaller;
  factoryCalls: Array<{ platform: WakeUpPlatform; runner: CommandRunner }>;
  homeDir: string;
  sourceRunnerPath: string;
  cleanup: () => void;
}

function createHarness(platform: WakeUpPlatform): TestHarness {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'schegent-daemon-mgr-'));
  const homeDir = path.join(tempDir, 'wakeup-home');
  const sourceRunnerPath = path.join(tempDir, 'runner.js');
  writeFileSync(sourceRunnerPath, '// runner bytes', 'utf8');

  const installer = new FakeInstaller();
  const factoryCalls: Array<{ platform: WakeUpPlatform; runner: CommandRunner }> = [];
  const factory = (p: WakeUpPlatform, r: CommandRunner) => {
    factoryCalls.push({ platform: p, runner: r });
    return installer;
  };

  const manager = new DaemonManager({
    installerFactory: factory,
    commandRunner: new StubCommandRunner(),
    platform: () => platform
  });

  return {
    manager,
    installer,
    factoryCalls,
    homeDir,
    sourceRunnerPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DaemonManager.apply', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it('publishes the runner bundle and installs when enabled=true (chronological)', async () => {
    h = createHarness('darwin');

    await h.manager.apply({
      settings: validChronologicalSettings,
      workspaceRoots: ['/workspace/a', '/workspace/b'],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });

    // Bundle files were written.
    await expect(fs.stat(path.join(h.homeDir, 'runner.js'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(h.homeDir, 'settings.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(h.homeDir, 'workspace-roots.json'))).resolves.toBeDefined();

    // Settings mirror payload is exactly the input.
    const persisted = JSON.parse(await fs.readFile(path.join(h.homeDir, 'settings.json'), 'utf8'));
    expect(persisted).toEqual(validChronologicalSettings);

    // Workspace roots mirror is the input list under { roots: [...] }.
    const roots = JSON.parse(
      await fs.readFile(path.join(h.homeDir, 'workspace-roots.json'), 'utf8')
    );
    expect(roots).toEqual({ roots: ['/workspace/a', '/workspace/b'] });

    // Installer received the chronological schedule projection.
    expect(h.installer.installCalls).toHaveLength(1);
    expect(h.installer.installCalls[0].schedule).toEqual({
      kind: 'chronological',
      hour: 4,
      minute: 0
    });
    expect(h.installer.uninstallCalls).toBe(0);
  });

  it('emits periodic schedule projection when enabled=true (periodic)', async () => {
    h = createHarness('darwin');

    await h.manager.apply({
      settings: { ...validPeriodicSettings, periodicInterval: 'Every 15m' },
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });

    expect(h.installer.installCalls[0].schedule).toEqual({
      kind: 'periodic',
      everyMs: 15 * 60 * 1000
    });
  });

  it('passes the published bundle paths to the installer', async () => {
    h = createHarness('darwin');

    await h.manager.apply({
      settings: validChronologicalSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });

    expect(h.installer.installCalls[0].bundle).toEqual({
      homeDir: h.homeDir,
      runnerPath: path.join(h.homeDir, 'runner.js'),
      settingsPath: path.join(h.homeDir, 'settings.json'),
      workspaceRootsPath: path.join(h.homeDir, 'workspace-roots.json')
    });
  });

  it('skips bundle publish and calls uninstall when enabled=false', async () => {
    h = createHarness('darwin');

    await h.manager.apply({
      settings: disabledSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });

    // Uninstall called; install NOT called; no bundle files written.
    expect(h.installer.uninstallCalls).toBe(1);
    expect(h.installer.installCalls).toHaveLength(0);
    await expect(fs.stat(path.join(h.homeDir, 'runner.js'))).rejects.toThrow();
  });

  it('re-raises installer errors so the save-handler can decide to rollback', async () => {
    h = createHarness('darwin');
    h.installer.throwOnInstall = new Error('install failed: launchctl exit 1');

    await expect(
      h.manager.apply({
        settings: validChronologicalSettings,
        workspaceRoots: [],
        sourceRunnerPath: h.sourceRunnerPath,
        homeDir: h.homeDir
      })
    ).rejects.toThrow(/install failed: launchctl exit 1/);
  });
});

describe('DaemonManager.uninstall', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it('proxies straight to the installer', async () => {
    h = createHarness('darwin');
    await h.manager.uninstall();
    expect(h.installer.uninstallCalls).toBe(1);
  });
});

describe('DaemonManager.inspect', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it('returns the installer-reported state verbatim', async () => {
    h = createHarness('darwin');
    const sched: NormalizedSchedule = { kind: 'chronological', hour: 4, minute: 0 };
    h.installer.setInspectResult({ registered: true, schedule: sched });
    const out = await h.manager.inspect();
    expect(out).toEqual({ registered: true, schedule: sched });
  });
});

// ── Dispatch: the installer factory must be called with the platform()
// override's value, on all four supported platforms. ───────────────────────

describe('DaemonManager — installerFactory dispatch', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it.each<WakeUpPlatform>(['darwin', 'win32', 'linux-systemd', 'linux-cron'])(
    'passes platform=%s through to installerFactory',
    async (platform) => {
      h = createHarness(platform);
      // Anything that drives the installer.
      await h.manager.inspect();
      expect(h.factoryCalls).toHaveLength(1);
      expect(h.factoryCalls[0].platform).toBe(platform);
    }
  );

  it('passes the same commandRunner instance to every factory call', async () => {
    h = createHarness('darwin');
    const sharedRunner = new StubCommandRunner();
    const factoryRunners: CommandRunner[] = [];
    const m = new DaemonManager({
      installerFactory: (_p, r) => {
        factoryRunners.push(r);
        return new FakeInstaller();
      },
      commandRunner: sharedRunner,
      platform: () => 'darwin'
    });

    await m.inspect();
    await m.inspect();
    await m.uninstall();

    expect(factoryRunners).toHaveLength(3);
    expect(factoryRunners.every((r) => r === sharedRunner)).toBe(true);
  });
});

// ── Reconcile state table (from contracts/daemon-registration.md) ──────────

describe('DaemonManager.reconcile', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it('action="none" when enabled=false and OS state is not registered', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({ registered: false, schedule: null });

    const r = await h.manager.reconcile({
      settings: disabledSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('none');
    expect(h.installer.installCalls).toHaveLength(0);
    expect(h.installer.uninstallCalls).toBe(0);
  });

  it('action="uninstalled" when enabled=false and OS state IS registered', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({
      registered: true,
      schedule: { kind: 'chronological', hour: 4, minute: 0 }
    });

    const r = await h.manager.reconcile({
      settings: disabledSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('uninstalled');
    expect(h.installer.uninstallCalls).toBe(1);
    expect(h.installer.installCalls).toHaveLength(0);
  });

  it('action="installed" when enabled=true and OS state is not registered', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({ registered: false, schedule: null });

    const r = await h.manager.reconcile({
      settings: validChronologicalSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('installed');
    expect(h.installer.installCalls).toHaveLength(1);
  });

  it('action="none" when enabled=true and OS schedule already matches', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({
      registered: true,
      schedule: { kind: 'chronological', hour: 4, minute: 0 }
    });

    const r = await h.manager.reconcile({
      settings: validChronologicalSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('none');
    expect(h.installer.installCalls).toHaveLength(0);
    expect(h.installer.uninstallCalls).toBe(0);
  });

  it('action="updated" when enabled=true and OS schedule differs', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({
      registered: true,
      schedule: { kind: 'chronological', hour: 9, minute: 30 }  // different
    });

    const r = await h.manager.reconcile({
      settings: validChronologicalSettings,  // 04:00
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('updated');
    expect(h.installer.installCalls).toHaveLength(1);
    // The new install carries the desired schedule, not the prior one.
    expect(h.installer.installCalls[0].schedule).toEqual({
      kind: 'chronological',
      hour: 4,
      minute: 0
    });
  });

  it('action="updated" when registered kind differs (chronological → periodic)', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({
      registered: true,
      schedule: { kind: 'periodic', everyMs: 60 * 60 * 1000 }
    });

    const r = await h.manager.reconcile({
      settings: validChronologicalSettings,
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('updated');
  });

  it('action="updated" when registered periodic interval differs', async () => {
    h = createHarness('darwin');
    h.installer.setInspectResult({
      registered: true,
      schedule: { kind: 'periodic', everyMs: 30 * 60 * 1000 }
    });

    const r = await h.manager.reconcile({
      settings: { ...validPeriodicSettings, periodicInterval: 'Every 1h' },
      workspaceRoots: [],
      sourceRunnerPath: h.sourceRunnerPath,
      homeDir: h.homeDir
    });
    expect(r.action).toBe('updated');
  });
});
