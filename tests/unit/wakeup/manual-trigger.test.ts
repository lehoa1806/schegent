import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualWakeUpTrigger } from '../../../src/wakeup/manual-trigger';
import { InvocationLog } from '../../../src/wakeup/invocation-log';
import type { WakeUpConfig } from '../../../src/wakeup/settings';

class FakeConfig implements WakeUpConfig {
  private readonly values = new Map<string, unknown>([
    ['wakeUp.enabled', false],
    ['wakeUp.schedulerType', 'chronological'],
    ['wakeUp.chronologicalTime', '04:00'],
    ['wakeUp.periodicInterval', 'Every 4h']
  ]);

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(): Promise<void> {
    throw new Error('manual trigger must not mutate config');
  }
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schegent-manual-wakeup-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createManualWakeUpTrigger', () => {
  it('runs with disabled scheduling and returns the projected manual attempt', async () => {
    const sourceRunnerPath = join(tempDir, 'source-runner.js');
    const homeDir = join(tempDir, 'home');
    writeFileSync(sourceRunnerPath, 'module.exports = {};\n', 'utf8');
    const log = new InvocationLog(homeDir);

    const trigger = createManualWakeUpTrigger({
      readConfig: () => new FakeConfig(),
      workspaceRoots: () => ['/workspace'],
      sourceRunnerPath,
      homeDir,
      sanitize: (s) => s,
      runner: async (opts) => {
        expect(opts).toMatchObject({
          homeDir,
          triggerSource: 'manual',
          ignoreDisabledSetting: true,
          recordLockSkipped: true
        });
        await log.append({
          timestamp: '2026-05-14T00:00:00.000Z',
          platform: 'darwin',
          pid: 1,
          lockAcquired: true,
          ephemeralCwd: '/tmp/schegent-primer-session/manual',
          cwdInsideWorkspace: false,
          envScrubbed: true,
          claudeExitCode: 0,
          durationMs: 12,
          triggerSource: 'manual',
          status: 'succeeded',
          rawResponse: 'pong'
        });
        return 0;
      }
    });

    const result = await trigger();
    expect(result.outcome).toBe('succeeded');
    expect(result.attempt).toMatchObject({
      triggerSource: 'manual',
      status: 'succeeded',
      rawResponse: 'pong'
    });
  });
});
