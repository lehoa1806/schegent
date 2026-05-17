// Feature 031 T018 — unit tests for manual "Wake up now" reading the
// same settings mirror as scheduled fires.
//
// The manual trigger MUST NOT inject a per-call model override (out
// of scope per spec). It reads `model` via `readSettings(deps.readConfig())`
// — the same code path scheduled fires use after T015 publishes the
// mirror with the field.
//
// Coverage (per tasks.md T018):
//   (a) The manual trigger reads `model` from the settings mirror it
//       receives via `readConfig()`.
//   (b) The model flows through `publishRunnerBundle` to the mirror file
//       under `<homeDir>/settings.json` (identical to the scheduled path).
//   (c) The trigger does NOT accept a per-call override argument.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualWakeUpTrigger } from '../../../src/wakeup/manual-trigger';
import { InvocationLog } from '../../../src/wakeup/invocation-log';
import type { WakeUpConfig } from '../../../src/wakeup/settings';

class FakeConfigWithModel implements WakeUpConfig {
  constructor(private readonly model: string | undefined) {}
  private readonly values = new Map<string, unknown>([
    ['wakeUp.enabled', false],
    ['wakeUp.schedulerType', 'chronological'],
    ['wakeUp.chronologicalTime', '04:00'],
    ['wakeUp.periodicInterval', 'Every 4h']
  ]);

  get<T>(key: string, defaultValue: T): T {
    if (key === 'wakeUp.model') {
      return (this.model === undefined ? defaultValue : this.model) as T;
    }
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(): Promise<void> {
    throw new Error('manual trigger must not mutate config');
  }
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schegent-manual-wakeup-model-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function recordSucceededInvocation(homeDir: string): Promise<void> {
  const log = new InvocationLog(homeDir);
  await log.append({
    timestamp: '2026-05-14T00:00:00.000Z',
    platform: 'darwin',
    pid: 1,
    lockAcquired: true,
    ephemeralCwd: '/tmp/manual',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 12,
    triggerSource: 'manual',
    status: 'succeeded',
    rawResponse: 'pong'
  });
}

describe('Feature 031 T018 — manual trigger reads the same settings mirror', () => {
  it('serializes `model` from the settings mirror into the published bundle', async () => {
    const sourceRunnerPath = join(tempDir, 'source-runner.js');
    const homeDir = join(tempDir, 'home');
    writeFileSync(sourceRunnerPath, 'module.exports = {};\n', 'utf8');

    const trigger = createManualWakeUpTrigger({
      readConfig: () => new FakeConfigWithModel('claude-opus-4-7'),
      workspaceRoots: () => ['/workspace'],
      sourceRunnerPath,
      homeDir,
      sanitize: (s) => s,
      runner: async (opts) => {
        // The runner is invoked AFTER publishRunnerBundle. By the time
        // we reach here, the settings.json mirror file MUST already
        // carry the operator's model selection.
        const mirror = JSON.parse(
          readFileSync(join(opts.homeDir, 'settings.json'), 'utf8')
        );
        expect(mirror.model).toBe('claude-opus-4-7');
        await recordSucceededInvocation(opts.homeDir);
        return 0;
      }
    });

    const result = await trigger();
    expect(result.outcome).toBe('succeeded');
  });

  it('serializes the `runner-default` sentinel when no model is set', async () => {
    const sourceRunnerPath = join(tempDir, 'source-runner.js');
    const homeDir = join(tempDir, 'home');
    writeFileSync(sourceRunnerPath, 'module.exports = {};\n', 'utf8');

    const trigger = createManualWakeUpTrigger({
      readConfig: () => new FakeConfigWithModel(undefined),
      workspaceRoots: () => ['/workspace'],
      sourceRunnerPath,
      homeDir,
      sanitize: (s) => s,
      runner: async (opts) => {
        const mirror = JSON.parse(
          readFileSync(join(opts.homeDir, 'settings.json'), 'utf8')
        );
        // Absent → coerced to the canonical sentinel by readSettings.
        expect(mirror.model).toBe('runner-default');
        await recordSucceededInvocation(opts.homeDir);
        return 0;
      }
    });

    await trigger();
  });

  it('does NOT accept a per-call model override argument', async () => {
    const sourceRunnerPath = join(tempDir, 'source-runner.js');
    const homeDir = join(tempDir, 'home');
    writeFileSync(sourceRunnerPath, 'module.exports = {};\n', 'utf8');

    const trigger = createManualWakeUpTrigger({
      readConfig: () => new FakeConfigWithModel('claude-sonnet-4-6'),
      workspaceRoots: () => [],
      sourceRunnerPath,
      homeDir,
      sanitize: (s) => s,
      runner: async (opts) => {
        await recordSucceededInvocation(opts.homeDir);
        return 0;
      }
    });

    // The trigger is a zero-arg function. Any call attempting to pass
    // a per-call override is a type error (no overload accepts one).
    // The runtime call signature `trigger()` is the canonical shape.
    const argCount = trigger.length;
    expect(argCount).toBe(0);
    await trigger();
  });
});
