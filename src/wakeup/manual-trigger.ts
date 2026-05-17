import { runWakeup } from '../headless/wakeup-runner';
import { InvocationLog, type WakeUpLogProjectionEntry } from './invocation-log';
import { publishRunnerBundle } from './runner-bundle';
import { readSettings, type WakeUpConfig } from './settings';

export type WakeUpNowOutcome = 'started' | 'succeeded' | 'failed' | 'skipped';

export interface WakeUpNowResult {
  readonly outcome: WakeUpNowOutcome;
  readonly message: string;
  readonly attempt: WakeUpLogProjectionEntry | null;
}

export interface ManualTriggerDeps {
  readonly readConfig: () => WakeUpConfig;
  readonly workspaceRoots: () => readonly string[];
  readonly sourceRunnerPath: string;
  readonly homeDir: string;
  readonly sanitize: (message: string) => string;
  readonly runner?: (opts: {
    readonly homeDir: string;
    readonly triggerSource: 'manual';
    readonly ignoreDisabledSetting: true;
    readonly recordLockSkipped: true;
  }) => Promise<number>;
}

export function createManualWakeUpTrigger(deps: ManualTriggerDeps) {
  return async (): Promise<WakeUpNowResult> => {
    const log = new InvocationLog(deps.homeDir);
    try {
      const settings = readSettings(deps.readConfig());
      await publishRunnerBundle(deps.sourceRunnerPath, deps.homeDir, {
        settings,
        workspaceRoots: deps.workspaceRoots()
      });
      const code = await (deps.runner ?? runWakeup)({
        homeDir: deps.homeDir,
        triggerSource: 'manual',
        ignoreDisabledSetting: true,
        recordLockSkipped: true
      });
      const latest = log.projectRecent(deps.sanitize, 1).entries[0] ?? null;
      const outcome = latest
        ? mapAttemptStatus(latest.status)
        : code === 0
          ? 'started'
          : 'failed';
      return {
        outcome,
        message: messageFor(outcome),
        attempt: latest
      };
    } catch (err) {
      return {
        outcome: 'failed',
        message: deps.sanitize((err as Error).message ?? 'Wake up failed'),
        attempt: log.projectRecent(deps.sanitize, 1).entries[0] ?? null
      };
    }
  };
}

function mapAttemptStatus(status: WakeUpLogProjectionEntry['status']): WakeUpNowOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'skipped':
      return 'skipped';
    case 'timed-out':
    case 'failed':
      return 'failed';
  }
}

function messageFor(outcome: WakeUpNowOutcome): string {
  switch (outcome) {
    case 'started':
      return 'Wake up started';
    case 'succeeded':
      return 'Wake up completed';
    case 'skipped':
      return 'Wake up skipped because another invocation is active';
    case 'failed':
      return 'Wake up failed';
  }
}
