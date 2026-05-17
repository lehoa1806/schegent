// Feature 014 — Cross-platform daemon manager facade.
//
// One object exposes three verbs the host needs:
//   apply(opts)        — publish bundle + install or update daemon.
//   uninstall()        — remove daemon. Idempotent.
//   inspect()          — return current registered state.
//   reconcile(opts)    — drift-detect (settings vs OS) and re-align.
//
// Delegates to the four platform installers (launchd / Task Scheduler /
// cron / systemd-user) via a small `DaemonInstaller` interface. A
// `CommandRunner` is injected through to each installer so unit tests
// can replace `launchctl` / `schtasks` / `crontab` / `systemctl` with
// a fake that just records arguments.

import { spawn } from 'node:child_process';
import { detectPlatform, type WakeUpPlatform } from './platform-detect';
import { normalizeSchedule, type NormalizedSchedule } from './schedule-spec';
import { publishRunnerBundle, type PublishedBundle } from './runner-bundle';
import type { WakeUpSettings } from './settings';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(cmd: string, args: readonly string[], opts?: CommandRunOptions): Promise<CommandResult>;
}

export interface DaemonInstaller {
  install(opts: InstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  inspect(): Promise<DaemonState>;
}

export interface InstallOptions {
  readonly bundle: PublishedBundle;
  readonly schedule: NormalizedSchedule;
}

export interface DaemonState {
  readonly registered: boolean;
  readonly schedule: NormalizedSchedule | null;
}

export interface ApplyOptions {
  readonly settings: WakeUpSettings;
  readonly workspaceRoots: readonly string[];
  readonly sourceRunnerPath: string;
  readonly homeDir: string;
}

export type ReconcileAction = 'none' | 'installed' | 'uninstalled' | 'updated';

export interface DaemonManagerDeps {
  readonly installerFactory: (p: WakeUpPlatform, c: CommandRunner) => DaemonInstaller;
  readonly commandRunner: CommandRunner;
  /** Override for tests; defaults to `detectPlatform()`. */
  readonly platform?: () => WakeUpPlatform;
}

export class DaemonManager {
  constructor(private readonly deps: DaemonManagerDeps) {}

  private installer(): DaemonInstaller {
    const platform = this.deps.platform ? this.deps.platform() : detectPlatform();
    return this.deps.installerFactory(platform, this.deps.commandRunner);
  }

  async apply(opts: ApplyOptions): Promise<void> {
    const installer = this.installer();
    if (!opts.settings.enabled) {
      await installer.uninstall();
      return;
    }
    const schedule = normalizeSchedule(opts.settings);
    const bundle = await publishRunnerBundle(
      opts.sourceRunnerPath,
      opts.homeDir,
      { settings: opts.settings, workspaceRoots: opts.workspaceRoots }
    );
    await installer.install({ bundle, schedule });
  }

  async uninstall(): Promise<void> {
    await this.installer().uninstall();
  }

  async inspect(): Promise<DaemonState> {
    return this.installer().inspect();
  }

  /**
   * Drift detection. Compares persisted settings to the OS-registered
   * state and re-aligns. Useful at activation and after the workspace
   * root list changes.
   */
  async reconcile(opts: ApplyOptions): Promise<{ action: ReconcileAction }> {
    const installer = this.installer();
    const state = await installer.inspect();

    if (!opts.settings.enabled) {
      if (state.registered) {
        await installer.uninstall();
        return { action: 'uninstalled' };
      }
      return { action: 'none' };
    }

    const desired = normalizeSchedule(opts.settings);
    if (!state.registered) {
      await this.apply(opts);
      return { action: 'installed' };
    }
    if (!scheduleEqual(state.schedule, desired)) {
      await this.apply(opts);
      return { action: 'updated' };
    }
    return { action: 'none' };
  }
}

function scheduleEqual(a: NormalizedSchedule | null, b: NormalizedSchedule): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'chronological') {
    return a.hour === b.hour && a.minute === b.minute;
  }
  return a.everyMs === b.everyMs;
}

/**
 * Default command runner used in production. Wraps `child_process.spawn`
 * with a Promise + optional stdin input + bounded timeout. Tests can
 * pass a fake `CommandRunner` instead.
 */
export function defaultCommandRunner(): CommandRunner {
  return {
    run(cmd, args, opts = {}) {
      return new Promise<CommandResult>((resolve) => {
        const child = spawn(cmd, [...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: opts.env ?? process.env
        });
        let stdout = '';
        let stderr = '';
        let timer: NodeJS.Timeout | undefined;
        let settled = false;

        if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* noop */ }
            setTimeout(() => {
              try { child.kill('SIGKILL'); } catch { /* noop */ }
            }, 5_000).unref();
          }, opts.timeoutMs);
          timer.unref();
        }

        child.stdout?.on('data', (d) => { stdout += String(d); });
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 });
        });
        child.on('error', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: -1 });
        });

        if (typeof opts.input === 'string' && child.stdin) {
          child.stdin.write(opts.input);
          child.stdin.end();
        } else if (child.stdin) {
          child.stdin.end();
        }
      });
    }
  };
}
