// Feature 011 — typed read/write surface for scalar `schegent.*` keys.
//
// Covers:
//   - Allowlist enforcement: unknown keys rejected, no write attempted.
//   - Per-key runtime type check (string/number/boolean/array-of-string).
//   - `fatalSignatures` MUST be an array of non-empty strings.
//   - All writes target `ConfigurationTarget.Workspace` only (FR-020).
//   - Transactional semantics: if ANY key fails validation, NO key is
//     written (matches contracts/general-settings-ipc.md).
//   - `readGeneralSettings()` projects the current effective workspace
//     configuration into a typed `GeneralSettings` snapshot with a
//     `scopes` map indicating the source (workspace > user > default).

import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_KEYS,
  readGeneralSettings,
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';

// Minimal stub matching the slice of `vscode.WorkspaceConfiguration` that
// the surface depends on. The real VS Code object is not importable in
// unit tests; we exercise the contract via this stub.
interface InspectResult<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

class FakeWorkspaceConfig {
  public readonly updateCalls: Array<{ key: string; value: unknown; target: number }> = [];
  constructor(
    private readonly defaults: Record<string, unknown> = {},
    private readonly workspace: Record<string, unknown> = {},
    private readonly user: Record<string, unknown> = {}
  ) {}

  get<T>(key: string, fallback: T): T {
    if (key in this.workspace) return this.workspace[key] as T;
    if (key in this.user) return this.user[key] as T;
    if (key in this.defaults) return this.defaults[key] as T;
    return fallback;
  }

  inspect<T>(key: string): InspectResult<T> | undefined {
    const out: InspectResult<T> = {};
    if (key in this.defaults) out.defaultValue = this.defaults[key] as T;
    if (key in this.user) out.globalValue = this.user[key] as T;
    if (key in this.workspace) out.workspaceValue = this.workspace[key] as T;
    return out;
  }

  update(key: string, value: unknown, target: number): Promise<void> {
    this.updateCalls.push({ key, value, target });
    if (value === undefined) {
      delete this.workspace[key];
    } else {
      this.workspace[key] = value;
    }
    return Promise.resolve();
  }
}

function makeConfig(opts: {
  defaults?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}): GeneralSettingsConfig {
  const fake = new FakeWorkspaceConfig(opts.defaults, opts.workspace, opts.user);
  return fake as unknown as GeneralSettingsConfig;
}

const CONFIGURATION_TARGET_WORKSPACE = 2; // vscode.ConfigurationTarget.Workspace

describe('Feature 011 — general-settings allowlist', () => {
  it('ALLOWED_KEYS contains exactly the scalar keys (unprefixed)', () => {
    expect(ALLOWED_KEYS).toEqual(
      new Set([
        'cli.path',
        'logging.verbose',
        'loop.maxIterations',
        'invocation.timeoutSeconds',
        'watchdog.pollIntervalMinutes',
        'audit.rotation.sizeMB',
        'audit.rotation.maxAgeDays',
        'rules.injectPerPhase',
        'defaultPipelineId',
        'fatalSignatures',
        'claude.autoCompactPctOverride',
        'queue.globalConcurrencyCap',
        'queue.defaultQueueId',
        'logging.runtimeLogLevel',
        'logging.runtimeLogFilePath',
        'logging.runtimeLogMaxBytes',
        'logging.runtimeLogMaxGenerations',
        'retry.maxAttempts'
      ])
    );
  });

  it('rejects unknown keys with `unknown-key:<key>` and writes nothing', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'phases': [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-key:phases');
    expect((config as unknown as FakeWorkspaceConfig).updateCalls).toHaveLength(0);
  });

  it('rejects bogus keys with `unknown-key:<key>`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'not.a.real.key': 'oops' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-key:not.a.real.key');
    expect((config as unknown as FakeWorkspaceConfig).updateCalls).toHaveLength(0);
  });
});

describe('Feature 011 — general-settings type checking', () => {
  it('rejects boolean→string mismatch with `type-mismatch:<key>`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'logging.verbose': 'true' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:logging.verbose');
  });

  it('rejects string→number mismatch with `type-mismatch:<key>`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'loop.maxIterations': '10' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:loop.maxIterations');
  });

  it('rejects bounded number settings outside their package/schema range', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'loop.maxIterations': 51 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range:loop.maxIterations');
  });

  it('rejects array→string mismatch with `type-mismatch:<key>`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'cli.path': ['claude'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:cli.path');
  });

  it('accepts a valid scalar update and writes to Workspace target', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'loop.maxIterations': 5 });

    expect(result.ok).toBe(true);
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toEqual([
      { key: 'loop.maxIterations', value: 5, target: CONFIGURATION_TARGET_WORKSPACE }
    ]);
  });

  it('accepts boolean true / false uniformly', async () => {
    const config = makeConfig();
    const r1 = await writeGeneralSettings(config, { 'logging.verbose': true });
    const r2 = await writeGeneralSettings(config, { 'rules.injectPerPhase': false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe('Feature 011 — general-settings transactional accept/reject', () => {
  it('rejects entire batch if any key is unknown — no writes', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 7,
      'unknown.key': 42
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-key:unknown.key');
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('rejects entire batch if any key has wrong type — no writes', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 7,
      'logging.verbose': 'no'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:logging.verbose');
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('writes ALL keys transactionally when every one validates', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 7,
      'logging.verbose': true,
      'cli.path': '/usr/local/bin/claude'
    });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toHaveLength(3);
    for (const call of fake.updateCalls) {
      expect(call.target).toBe(CONFIGURATION_TARGET_WORKSPACE);
    }
  });
});

describe('Feature 011 — fatalSignatures array-of-non-empty-string validation', () => {
  it('rejects non-array with `type-mismatch:fatalSignatures`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { fatalSignatures: 'one,two' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:fatalSignatures');
  });

  it('rejects array containing a non-string with `invalid-array:fatalSignatures`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { fatalSignatures: ['ok', 42] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-array:fatalSignatures');
  });

  it('rejects array containing an empty string with `invalid-array:fatalSignatures`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { fatalSignatures: ['ok', ''] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-array:fatalSignatures');
  });

  it('rejects array containing whitespace-only string with `invalid-array:fatalSignatures`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { fatalSignatures: ['ok', '   '] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-array:fatalSignatures');
  });

  it('accepts a clean array of non-empty strings', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      fatalSignatures: ['context length exceeded', 'token quota']
    });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toEqual([
      {
        key: 'fatalSignatures',
        value: ['context length exceeded', 'token quota'],
        target: CONFIGURATION_TARGET_WORKSPACE
      }
    ]);
  });

  it('accepts an empty array (FR-033 baseline)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { fatalSignatures: [] });
    expect(result.ok).toBe(true);
  });
});

describe('Feature 011 — readGeneralSettings projects current values + scopes', () => {
  it('returns default values + `default` scopes when nothing is overridden', () => {
    const config = makeConfig({
      defaults: {
        'cli.path': 'claude',
        'logging.verbose': false,
        'loop.maxIterations': 10,
        'invocation.timeoutSeconds': 1800,
        'watchdog.pollIntervalMinutes': 30,
        'audit.rotation.sizeMB': 5,
        'audit.rotation.maxAgeDays': 30,
        'rules.injectPerPhase': false,
        'defaultPipelineId': 'speckit-new-feature',
        'fatalSignatures': [],
        'queue.globalConcurrencyCap': 1,
        'queue.defaultQueueId': 'default'
      }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('claude');
    expect(snap.loggingVerbose).toBe(false);
    expect(snap.loopMaxIterations).toBe(10);
    expect(snap.fatalSignatures).toEqual([]);
    expect(snap.queueGlobalConcurrencyCap).toBe(1);
    expect(snap.queueDefaultQueueId).toBe('default');
    expect(snap.scopes.cliPath).toBe('default');
    expect(snap.scopes.fatalSignatures).toBe('default');
  });

  it('reports `workspace` scope when workspace overrides are present', () => {
    const config = makeConfig({
      defaults: { 'cli.path': 'claude', 'loop.maxIterations': 10 },
      workspace: { 'cli.path': '/opt/claude' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('/opt/claude');
    expect(snap.scopes.cliPath).toBe('workspace');
    expect(snap.scopes.loopMaxIterations).toBe('default');
  });

  it('reports `user` scope when only the user override is present', () => {
    const config = makeConfig({
      defaults: { 'cli.path': 'claude' },
      user: { 'cli.path': '/usr/bin/claude' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('/usr/bin/claude');
    expect(snap.scopes.cliPath).toBe('user');
  });

  it('falls back to a safe default when inspect() is undefined for a key', () => {
    const config = makeConfig({});
    const snap = readGeneralSettings(config);
    // The shape must be present even if no values are configured.
    expect(typeof snap.cliPath).toBe('string');
    expect(Array.isArray(snap.fatalSignatures)).toBe(true);
  });

  it('falls back to defaults when bounded number settings are malformed in storage', () => {
    const config = makeConfig({
      workspace: {
        'loop.maxIterations': 51,
        'invocation.timeoutSeconds': 29
      }
    });
    const snap = readGeneralSettings(config);
    expect(snap.loopMaxIterations).toBe(10);
    expect(snap.invocationTimeoutSeconds).toBe(1800);
  });
});

describe('Feature 017 — queue settings validation', () => {
  it('accepts queue global concurrency cap in [1, 1] (Feature 056 Track 4)', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, { 'queue.globalConcurrencyCap': 1 });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toEqual([
      { key: 'queue.globalConcurrencyCap', value: 1, target: CONFIGURATION_TARGET_WORKSPACE }
    ]);
  });

  it('rejects queue global concurrency cap outside [1, 1] (Feature 056 Track 4)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'queue.globalConcurrencyCap': 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range:queue.globalConcurrencyCap');
  });

  it('accepts queue default id as a string', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'queue.defaultQueueId': 'default' });
    expect(result.ok).toBe(true);
  });

  it('projects malformed queue cap to the default cap', () => {
    const config = makeConfig({ workspace: { 'queue.globalConcurrencyCap': 100 } });
    const snap = readGeneralSettings(config);
    expect(snap.queueGlobalConcurrencyCap).toBe(1);
  });
});

describe('Feature 011 — empty updates', () => {
  it('accepts an empty update batch as a no-op success', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {});
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toHaveLength(0);
  });
});

describe('Feature 011 — writeGeneralSettings surfaces underlying errors', () => {
  it('returns a typed error when the underlying config.update rejects', async () => {
    const erroring = {
      get: <T,>(_k: string, fallback: T) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {
        throw new Error('settings.json: ENOSPC');
      })
    } as unknown as GeneralSettingsConfig;

    const result = await writeGeneralSettings(erroring, { 'loop.maxIterations': 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/write-failed/);
  });

  it('rolls back earlier workspace writes when a later update rejects', async () => {
    const config = makeConfig({
      defaults: {
        'loop.maxIterations': 10,
        'logging.verbose': false
      },
      workspace: {
        'loop.maxIterations': 3
      }
    });
    const fake = config as unknown as FakeWorkspaceConfig;
    const update = fake.update.bind(fake);
    const updateSpy = vi
      .spyOn(fake, 'update')
      .mockImplementation(async (key, value, target) => {
        if (key === 'logging.verbose') {
          fake.updateCalls.push({ key, value, target });
          throw new Error('settings.json: EBUSY');
        }
        return update(key, value, target);
      });

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 7,
      'logging.verbose': true
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('write-failed:logging.verbose:settings.json: EBUSY');
    expect(fake.updateCalls).toEqual([
      { key: 'loop.maxIterations', value: 7, target: CONFIGURATION_TARGET_WORKSPACE },
      { key: 'logging.verbose', value: true, target: CONFIGURATION_TARGET_WORKSPACE },
      { key: 'loop.maxIterations', value: 3, target: CONFIGURATION_TARGET_WORKSPACE }
    ]);
    expect(readGeneralSettings(config).loopMaxIterations).toBe(3);
    expect(readGeneralSettings(config).loggingVerbose).toBe(false);
    updateSpy.mockRestore();
  });

  it('rolls back a newly-created workspace key by clearing it', async () => {
    const config = makeConfig({
      defaults: {
        'loop.maxIterations': 10,
        'logging.verbose': false
      }
    });
    const fake = config as unknown as FakeWorkspaceConfig;
    const update = fake.update.bind(fake);
    vi.spyOn(fake, 'update').mockImplementation(async (key, value, target) => {
      if (key === 'logging.verbose') {
        fake.updateCalls.push({ key, value, target });
        throw new Error('settings.json: EBUSY');
      }
      return update(key, value, target);
    });

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 7,
      'logging.verbose': true
    });

    expect(result.ok).toBe(false);
    const after = readGeneralSettings(config);
    expect(after.loopMaxIterations).toBe(10);
    expect(after.scopes.loopMaxIterations).toBe('default');
  });
});

// ---------------------------------------------------------------
// Feature 012 — schegent.claude.autoCompactPctOverride
// ---------------------------------------------------------------

describe('Feature 012 — claude.autoCompactPctOverride accepts valid integers', () => {
  it.each([1, 50, 100])('accepts %s and writes to Workspace', async (value) => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'claude.autoCompactPctOverride': value
    });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toEqual([
      { key: 'claude.autoCompactPctOverride', value, target: CONFIGURATION_TARGET_WORKSPACE }
    ]);
  });
});

describe('Feature 012 — claude.autoCompactPctOverride rejects bad values', () => {
  it('rejects 0 as out-of-range', async () => {
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range:claude.autoCompactPctOverride');
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('rejects 101 as out-of-range', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': 101 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range:claude.autoCompactPctOverride');
  });

  it('rejects -5 as out-of-range', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': -5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range:claude.autoCompactPctOverride');
  });

  it('rejects 3.14 as type-mismatch (non-integer)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': 3.14 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:claude.autoCompactPctOverride');
  });

  it('rejects "abc" as type-mismatch (string)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:claude.autoCompactPctOverride');
  });

  it('rejects NaN as type-mismatch (non-finite)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, { 'claude.autoCompactPctOverride': NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:claude.autoCompactPctOverride');
  });

  it('rejects Infinity as type-mismatch', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'claude.autoCompactPctOverride': Number.POSITIVE_INFINITY
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('type-mismatch:claude.autoCompactPctOverride');
  });
});

describe('Feature 012 — claude.autoCompactPctOverride clear semantics', () => {
  it('null clears the workspace key via update(key, undefined)', async () => {
    const config = makeConfig({ workspace: { 'claude.autoCompactPctOverride': 80 } });
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'claude.autoCompactPctOverride': null
    });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toEqual([
      {
        key: 'claude.autoCompactPctOverride',
        value: undefined,
        target: CONFIGURATION_TARGET_WORKSPACE
      }
    ]);
  });

  it('undefined clears the workspace key via update(key, undefined)', async () => {
    const config = makeConfig({ workspace: { 'claude.autoCompactPctOverride': 80 } });
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'claude.autoCompactPctOverride': undefined
    });
    expect(result.ok).toBe(true);
    expect(fake.updateCalls).toEqual([
      {
        key: 'claude.autoCompactPctOverride',
        value: undefined,
        target: CONFIGURATION_TARGET_WORKSPACE
      }
    ]);
  });

  it('surfaces clear-failed:<key> when update throws on the clear path', async () => {
    const erroring = {
      get: <T,>(_k: string, fallback: T) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {
        throw new Error('settings.json locked');
      })
    } as unknown as GeneralSettingsConfig;
    const result = await writeGeneralSettings(erroring, {
      'claude.autoCompactPctOverride': null
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('clear-failed:claude.autoCompactPctOverride');
  });
});

describe('Feature 012 — readGeneralSettings projects claudeAutoCompactPctOverride', () => {
  it('returns undefined when unset', () => {
    const config = makeConfig({ defaults: { 'cli.path': 'claude' } });
    const snap = readGeneralSettings(config);
    expect(snap.claudeAutoCompactPctOverride).toBeUndefined();
    expect(snap.scopes.claudeAutoCompactPctOverride).toBe('default');
  });

  it('returns the integer when set at workspace scope', () => {
    const config = makeConfig({
      defaults: { 'cli.path': 'claude' },
      workspace: { 'claude.autoCompactPctOverride': 80 }
    });
    const snap = readGeneralSettings(config);
    expect(snap.claudeAutoCompactPctOverride).toBe(80);
    expect(snap.scopes.claudeAutoCompactPctOverride).toBe('workspace');
  });

  it('falls back to undefined when the workspace value is malformed', () => {
    const config = makeConfig({
      workspace: { 'claude.autoCompactPctOverride': 3.14 }
    });
    const snap = readGeneralSettings(config);
    expect(snap.claudeAutoCompactPctOverride).toBeUndefined();
  });

  it('falls back to undefined when out-of-range in workspace', () => {
    const config = makeConfig({
      workspace: { 'claude.autoCompactPctOverride': 200 }
    });
    const snap = readGeneralSettings(config);
    expect(snap.claudeAutoCompactPctOverride).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Feature 019 — schegent.logging.runtimeLogLevel / runtimeLogFilePath
// ───────────────────────────────────────────────────────────────────────────

describe('Feature 019 — runtimeLogLevel accepts canonical levels', () => {
  it.each(['DEBUG', 'INFO', 'WARN', 'ERROR'])(
    'accepts %s and writes to Workspace target',
    async (level) => {
      const config = makeConfig();
      const result = await writeGeneralSettings(config, {
        'logging.runtimeLogLevel': level
      });
      expect(result.ok).toBe(true);
      const fake = config as unknown as FakeWorkspaceConfig;
      expect(fake.updateCalls).toEqual([
        {
          key: 'logging.runtimeLogLevel',
          value: level,
          target: CONFIGURATION_TARGET_WORKSPACE
        }
      ]);
    }
  );
});

describe('Feature 019 — runtimeLogLevel rejects bad values', () => {
  it('rejects lowercase levels', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': 'info'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-enum:logging.runtimeLogLevel');
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toHaveLength(0);
  });

  it.each(['TRACE', 'FATAL', 'OFF', ''])('rejects %s (unrecognized)', async (level) => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': level
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-enum:logging.runtimeLogLevel');
  });

  it.each([42, true, null, undefined, {}, []])(
    'rejects non-string input %p',
    async (value) => {
      const config = makeConfig();
      const result = await writeGeneralSettings(config, {
        'logging.runtimeLogLevel': value
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('type-mismatch:logging.runtimeLogLevel');
    }
  );
});

describe('Feature 019 — runtimeLogFilePath accepts valid paths', () => {
  it('accepts empty string (= default)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': ''
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a workspace-relative path', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': 'logs/syslog'
    });
    expect(result.ok).toBe(true);
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toEqual([
      {
        key: 'logging.runtimeLogFilePath',
        value: 'logs/syslog',
        target: CONFIGURATION_TARGET_WORKSPACE
      }
    ]);
  });

  it('accepts an absolute POSIX path', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': '/tmp/schegent-debug.log'
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a Windows drive-letter path', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': 'C:\\Temp\\schegent.log'
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a Windows UNC path', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': '\\\\server\\share\\schegent.log'
    });
    expect(result.ok).toBe(true);
  });
});

describe('Feature 019 — runtimeLogFilePath rejects bad values', () => {
  it('rejects relative path containing `..`', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': '../escape/syslog'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('relative-traversal:logging.runtimeLogFilePath');
  });

  it('rejects embedded `..` segments', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogFilePath': 'logs/../../escape'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('relative-traversal:logging.runtimeLogFilePath');
  });

  it.each([42, true, null, undefined, {}, []])(
    'rejects non-string input %p',
    async (value) => {
      const config = makeConfig();
      const result = await writeGeneralSettings(config, {
        'logging.runtimeLogFilePath': value
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('type-mismatch:logging.runtimeLogFilePath');
    }
  );
});

describe('Feature 019 — transactional rejection across the two new keys', () => {
  it('valid level + invalid path → NEITHER persisted', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': 'DEBUG',
      'logging.runtimeLogFilePath': '../escape/syslog'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('relative-traversal:logging.runtimeLogFilePath');
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('invalid level + valid path → NEITHER persisted', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': 'verbose',
      'logging.runtimeLogFilePath': '/tmp/syslog'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-enum:logging.runtimeLogLevel');
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toHaveLength(0);
  });

  it('both valid → both persisted', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': 'WARN',
      'logging.runtimeLogFilePath': '/var/log/schegent.log'
    });
    expect(result.ok).toBe(true);
    const fake = config as unknown as FakeWorkspaceConfig;
    expect(fake.updateCalls).toHaveLength(2);
    expect(fake.updateCalls).toContainEqual({
      key: 'logging.runtimeLogLevel',
      value: 'WARN',
      target: CONFIGURATION_TARGET_WORKSPACE
    });
    expect(fake.updateCalls).toContainEqual({
      key: 'logging.runtimeLogFilePath',
      value: '/var/log/schegent.log',
      target: CONFIGURATION_TARGET_WORKSPACE
    });
  });
});

describe('Feature 019 — readGeneralSettings projects new fields', () => {
  it('returns defaults when neither key is set', () => {
    const config = makeConfig();
    const snap = readGeneralSettings(config);
    expect(snap.runtimeLogLevel).toBe('INFO');
    expect(snap.runtimeLogFilePath).toBe('');
    expect(snap.scopes.runtimeLogLevel).toBe('default');
    expect(snap.scopes.runtimeLogFilePath).toBe('default');
  });

  it('returns workspace value + scope=workspace when set', () => {
    const config = makeConfig({
      workspace: {
        'logging.runtimeLogLevel': 'DEBUG',
        'logging.runtimeLogFilePath': '/tmp/schegent.log'
      }
    });
    const snap = readGeneralSettings(config);
    expect(snap.runtimeLogLevel).toBe('DEBUG');
    expect(snap.runtimeLogFilePath).toBe('/tmp/schegent.log');
    expect(snap.scopes.runtimeLogLevel).toBe('workspace');
    expect(snap.scopes.runtimeLogFilePath).toBe('workspace');
  });

  it('falls back to default when stored level is malformed', () => {
    const config = makeConfig({
      workspace: { 'logging.runtimeLogLevel': 'verbose' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.runtimeLogLevel).toBe('INFO');
  });

  it('falls back to default when stored path contains traversal', () => {
    const config = makeConfig({
      workspace: { 'logging.runtimeLogFilePath': '../escape/syslog' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.runtimeLogFilePath).toBe('');
  });
});

describe('Feature 019 — writeGeneralSettings hook onRuntimeLogSettingChanged', () => {
  it('fires the hook exactly once when runtimeLogLevel is touched', async () => {
    const config = makeConfig();
    const hook = vi.fn();
    const result = await writeGeneralSettings(
      config,
      { 'logging.runtimeLogLevel': 'WARN' },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('fires the hook exactly once when runtimeLogFilePath is touched', async () => {
    const config = makeConfig();
    const hook = vi.fn();
    const result = await writeGeneralSettings(
      config,
      { 'logging.runtimeLogFilePath': '/var/log/x.log' },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('fires the hook once per call even when both runtime-log keys are touched', async () => {
    const config = makeConfig();
    const hook = vi.fn();
    const result = await writeGeneralSettings(
      config,
      {
        'logging.runtimeLogLevel': 'DEBUG',
        'logging.runtimeLogFilePath': '/var/log/y.log'
      },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the hook when no runtime-log key is touched', async () => {
    const config = makeConfig();
    const hook = vi.fn();
    const result = await writeGeneralSettings(
      config,
      { 'claude.autoCompactPctOverride': 50 },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });

  it('does NOT fire the hook on validation failure', async () => {
    const config = makeConfig();
    const hook = vi.fn();
    const result = await writeGeneralSettings(
      config,
      { 'logging.runtimeLogLevel': 'verbose' },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  it('swallows hook errors so the write result still surfaces ok', async () => {
    const config = makeConfig();
    const hook = vi.fn(() => {
      throw new Error('boom in callback');
    });
    const result = await writeGeneralSettings(
      config,
      { 'logging.runtimeLogLevel': 'DEBUG' },
      { onRuntimeLogSettingChanged: hook }
    );
    expect(result.ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('works without the hooks argument (back-compat)', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      'logging.runtimeLogLevel': 'WARN'
    });
    expect(result.ok).toBe(true);
  });
});
