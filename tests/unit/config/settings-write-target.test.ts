import { describe, it, expect } from 'vitest';
import {
  writeGeneralSettings,
  CONFIGURATION_TARGET_GLOBAL,
  CONFIGURATION_TARGET_WORKSPACE,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';

/**
 * FR-R3-051 (M-05) — a write must land on the layer the key's manifest scope
 * declares.
 *
 * The production config double accepts any target, which is exactly why this
 * defect shipped: real VS Code has no workspace layer for an
 * `application`-scoped setting, so `writeGeneralSettings` was rejected or
 * misapplied by the product while the suite stayed green. This double RECORDS
 * the target instead of accepting it, so the argument is the assertion.
 */
interface Call {
  readonly key: string;
  readonly value: unknown;
  readonly target: number;
}

function recorder(
  inspected: Readonly<
    Record<string, { globalValue?: unknown; workspaceValue?: unknown } | undefined>
  > = {},
  failOn?: string
): { config: GeneralSettingsConfig; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    config: {
      get: <T>(key: string, fallback: T): T =>
        (inspected[key]?.workspaceValue as T | undefined) ??
        (inspected[key]?.globalValue as T | undefined) ??
        fallback,
      inspect: <T>(key: string) => inspected[key] as
        | { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
        | undefined,
      update: (key: string, value: unknown, target: number) => {
        calls.push({ key, value, target });
        if (key === failOn) return Promise.reject(new Error('nope'));
        return Promise.resolve();
      }
    } as GeneralSettingsConfig
  };
}

const targetOf = (calls: readonly Call[], key: string): number | undefined =>
  calls.find((c) => c.key === key)?.target;

describe('a write targets the layer its manifest scope declares (M-05)', () => {
  it('writes application-scoped keys to the global layer', async () => {
    const { config, calls } = recorder();
    const result = await writeGeneralSettings(config, {
      'cli.path': '/usr/local/bin/claude',
      'codex.path': '/usr/local/bin/codex',
      'agy.path': '/usr/local/bin/agy'
    });
    expect(result.ok).toBe(true);
    expect(targetOf(calls, 'cli.path')).toBe(CONFIGURATION_TARGET_GLOBAL);
    expect(targetOf(calls, 'codex.path')).toBe(CONFIGURATION_TARGET_GLOBAL);
    expect(targetOf(calls, 'agy.path')).toBe(CONFIGURATION_TARGET_GLOBAL);
  });

  it('leaves non-application keys on the workspace layer', async () => {
    const { config, calls } = recorder();
    const result = await writeGeneralSettings(config, {
      'logging.verbose': true,
      'loop.maxIterations': 7
    });
    expect(result.ok).toBe(true);
    expect(targetOf(calls, 'logging.verbose')).toBe(CONFIGURATION_TARGET_WORKSPACE);
    expect(targetOf(calls, 'loop.maxIterations')).toBe(CONFIGURATION_TARGET_WORKSPACE);
  });

  it('clears at the same target it writes', async () => {
    // A clear that goes to the wrong layer leaves the real value in place while
    // reporting success -- the setting appears not to have changed at all.
    const { config, calls } = recorder();
    await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': null });
    const clear = calls.find((c) => c.value === undefined);
    expect(clear?.target).toBe(CONFIGURATION_TARGET_WORKSPACE);
  });
});

describe('a rollback restores the layer it wrote (M-05)', () => {
  it('restores an application-scoped key globally and never touches the workspace', async () => {
    // `cli.path` writes first and succeeds; `loop.maxIterations` then fails, so
    // the batch rolls back. Before the fix the restore went to the workspace,
    // which left the global value the batch had just written in place AND wrote a
    // workspace layer that never held the value -- a rollback leaving the state
    // worse than the failure did.
    const { config, calls } = recorder(
      { 'cli.path': { globalValue: '/previous/claude' } },
      'loop.maxIterations'
    );
    const result = await writeGeneralSettings(config, {
      'cli.path': '/new/claude',
      'loop.maxIterations': 9
    });
    expect(result.ok).toBe(false);

    const cliCalls = calls.filter((c) => c.key === 'cli.path');
    expect(cliCalls).toHaveLength(2);
    expect(cliCalls[1]).toEqual({
      key: 'cli.path',
      value: '/previous/claude',
      target: CONFIGURATION_TARGET_GLOBAL
    });
    expect(cliCalls.every((c) => c.target === CONFIGURATION_TARGET_GLOBAL)).toBe(true);
  });

  it('clears an application-scoped key that had no prior global value', async () => {
    const { config, calls } = recorder({}, 'loop.maxIterations');
    await writeGeneralSettings(config, { 'cli.path': '/new/claude', 'loop.maxIterations': 9 });
    const restore = calls.filter((c) => c.key === 'cli.path')[1];
    expect(restore).toEqual({
      key: 'cli.path',
      value: undefined,
      target: CONFIGURATION_TARGET_GLOBAL
    });
  });
});
