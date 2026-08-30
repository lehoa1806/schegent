// Feature 011 — typed read/write surface for scalar `schegent.*` keys.
//
// Covers:
//   - Allowlist enforcement: unknown keys rejected, no write attempted.
//   - Per-key runtime type check (string/number/boolean/array-of-string).
//   - `fatalSignatures` MUST be an array of non-empty strings.
//   - Each write targets the layer its manifest scope declares: `Global` for
//     `application`-scoped keys, `Workspace` otherwise (FR-R3-051 / M-05,
//     superseding the original FR-020 "Workspace only").
//   - Transactional semantics: if ANY key fails validation, NO key is
//     written (matches contracts/general-settings-ipc.md).
//   - `readGeneralSettings()` projects the current effective workspace
//     configuration into a typed `GeneralSettings` snapshot with a
//     `scopes` map indicating the source (workspace > user > default).

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ALLOWED_KEYS,
  readGeneralSettings,
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';
import { SETTINGS_SCHEMA } from '../../../src/config/settings-schema';
import { PIPELINE_ID_PATTERN } from '../../../src/config/pipeline-definition-validator';
import { EMPTY_CATALOG } from '../../../src/config/pipeline-config';
import {
  WorkflowRunFactory,
  describePipelineRefusal
} from '../../../src/services/workflow-run-factory';
import { SanitizedLogger } from '../../../src/lib/logger';

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

// FR-R3-051 (M-06) — imported, not restated. A local copy of a constant the
// source already exports is the same defect this feature is removing elsewhere:
// it agrees until it doesn't, and nothing checks.
import {
  CONFIGURATION_TARGET_WORKSPACE,
  CONFIGURATION_TARGET_GLOBAL
} from '../../../src/config/general-settings';

describe('Feature 011 — general-settings allowlist', () => {
  it('ALLOWED_KEYS contains exactly the scalar keys (unprefixed)', () => {
    expect(ALLOWED_KEYS).toEqual(
      new Set([
        'cli.path',
        'codex.path',
        'agy.path',
        'logging.verbose',
        'loop.maxIterations',
        'invocation.idleTimeoutSeconds',
        'invocation.maxDurationSeconds',
        'watchdog.pollIntervalMinutes',
        'audit.rotation.sizeMB',
        'audit.rotation.maxAgeDays',
        'defaultPipelineId',
        'fatalSignatures',
        'claude.autoCompactPctOverride',
        'logging.runtimeLogLevel',
        'logging.runtimeLogFilePath',
        'logging.rawTranscriptMode',
        'logging.runtimeLogMaxBytes',
        'logging.runtimeLogMaxGenerations',
        'logging.sessionRetentionMaxAgeDays',
        'logging.sessionRetentionMaxBytes',
        'retry.maxAttempts',
        'retry.forceContinueOnCap',
        // FR-R3-143 (T025) — six manifest settings the tab could not offer
        // because nothing here accepted them. The two `window`-scoped ones are
        // the first of that scope in `KEY_SPECS`.
        'cli.inheritEnvironment',
        'cli.environmentMode',
        'cli.environmentAllowlist',
        'backend.probeTimeoutSeconds',
        'ui.confirmations.enable',
        'multiRoot.suppressWarning',
        // FR-R3-144 (T006) — which backend runs, and the two denominations a
        // spend bound can be set in. `backend.uncontainedBackends` is NOT here
        // and is not an oversight: an entry would make it a whole-array write
        // through this same batch, and a whole-array payload cannot tell a
        // revoke from a stale draft. It has its own per-backend command.
        'backend.runner',
        'spend.maxUsdPerRun',
        'spend.maxTokensPerRun'
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

  it('accepts boolean settings', async () => {
    const config = makeConfig();
    const r1 = await writeGeneralSettings(config, { 'logging.verbose': true });
    expect(r1.ok).toBe(true);
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
    // FR-R3-051 (M-05) — this loop used to assert every key went to the
    // WORKSPACE target, `cli.path` included. That is the defect, asserted as
    // correct: `cli.path` is `application`-scoped and has no workspace layer in
    // real VS Code. Made scope-aware rather than dropped, so it now distinguishes
    // the two targets instead of accepting either.
    expect(
      fake.updateCalls.map((call) => [call.key, call.target] as const)
    ).toEqual([
      ['loop.maxIterations', CONFIGURATION_TARGET_WORKSPACE],
      ['logging.verbose', CONFIGURATION_TARGET_WORKSPACE],
      ['cli.path', CONFIGURATION_TARGET_GLOBAL]
    ]);
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
        'invocation.idleTimeoutSeconds': 5400,
        'invocation.maxDurationSeconds': 21600,
        'watchdog.pollIntervalMinutes': 30,
        'audit.rotation.sizeMB': 5,
        'audit.rotation.maxAgeDays': 30,
        'defaultPipelineId': 'speckit-new-feature',
        'fatalSignatures': [],
      }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('claude');
    expect(snap.loggingVerbose).toBe(false);
    expect(snap.loopMaxIterations).toBe(10);
    expect(snap.fatalSignatures).toEqual([]);
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
        'invocation.idleTimeoutSeconds': 29
      }
    });
    const snap = readGeneralSettings(config);
    expect(snap.loopMaxIterations).toBe(10);
    expect(snap.invocationIdleTimeoutSeconds).toBe(5400);
  });
});

describe('FR-R3-145 (T1570) — the queue settings are not configuration', () => {
  // This block replaces `Feature 017 — queue settings validation`, five cases
  // that wrote `queue.globalConcurrencyCap` and `queue.defaultQueueId` through
  // `writeGeneralSettings` and asserted the bound `[1, 20]` on the way in. Every
  // one of them passed against a configuration key that no scheduling path read:
  // `hasExecutionCapacity` and `hasWorkspaceCapacity` gate on the workspace
  // memento, which `QueueConfigModal` writes through `CMD_SAVE_QUEUE_SETTINGS`.
  // The configuration key is gone, so the only honest assertion left about it is
  // that it is refused. The bound those five cases were built to protect is
  // enforced at the IPC boundary by `validateSaveQueueSettings` in
  // `src/contracts/validators/queue-management.ts` and again in
  // `QueueManager.saveQueueSettings`; both are covered where they live.
  it('refuses the removed queue keys as unknown rather than validating them', async () => {
    for (const key of ['queue.globalConcurrencyCap', 'queue.defaultQueueId']) {
      const result = await writeGeneralSettings(makeConfig(), { [key]: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(`unknown-key:${key}`);
    }
  });

  it('writes nothing to configuration when a removed queue key is supplied', async () => {
    // The refusal has to be a refusal, not a partial write. `writeGeneralSettings`
    // validates the whole batch before it updates anything, and this is the
    // property that made removing the key safe: a caller still passing it gets
    // an error, not a half-applied settings save.
    const config = makeConfig();
    const fake = config as unknown as FakeWorkspaceConfig;
    const result = await writeGeneralSettings(config, {
      'logging.verbose': true,
      'queue.globalConcurrencyCap': 2
    });
    expect(result.ok).toBe(false);
    expect(fake.updateCalls).toEqual([]);
  });

  // FR-R3-145 (T1570) — 'projects malformed queue cap to the default cap' stood
  // here. It asserted that an out-of-range *configuration* read fell back to the
  // declared default, which was true and which nothing depended on: no scheduling
  // path read that configuration. The behaviour that matters — an out-of-range
  // *persisted* cap being refused rather than saturated — is
  // `WorkspaceStateStore`'s, and is covered in
  // `tests/unit/state/workspace-state.test.ts`. A different surface with a
  // different failure mode, which is why deleting this one loses no coverage.
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

// ---------------------------------------------------------------------------
// Feature 098 (T043, US6) — the default-Pipeline setting ships unset.
//
// FR-033/FR-033a/FR-033b, SC-012. The setting used to default to
// `speckit-new-feature`, a Pipeline the built-in catalog supplied. The catalog
// ships empty, so that default named a definition no installation holds: a
// fresh install pointed its "default Pipeline" at nothing, and every consumer
// that resolved it got a miss it had no vocabulary for.
//
// The correction is that the default is *unset*, spelled as the empty string so
// the declared type stays `string` across the boundary contract. Three things
// then have to hold together, and this block asserts all three:
//   1. All four declarations agree on `''` — a fresh install reads one value,
//      not four.
//   2. `''` can never name a Pipeline, so nothing can offer it as a choice.
//   3. A launch that falls through to it is *refused, naming the id*, rather
//      than silently doing nothing.
// ---------------------------------------------------------------------------

describe('Feature 098 (T043) — the default-Pipeline setting ships unset', () => {
  const SETTING_KEY = 'schegent.defaultPipelineId';

  it('reads as the empty string in all four declarations on a fresh install', async () => {
    // 1 — the package manifest, the surface VS Code renders in its Settings UI.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')
    ) as {
      contributes: {
        configuration: { properties: Record<string, { default?: unknown }> };
      };
    };
    expect(manifest.contributes.configuration.properties[SETTING_KEY].default).toBe('');

    // 2 — the settings schema, which the drift validator reads.
    expect(SETTINGS_SCHEMA[SETTING_KEY].default).toBe('');

    // 3 — the settings accessor, asserted through what it answers rather than
    // through `KEY_SPECS`: a config that holds nothing is a fresh install.
    expect(readGeneralSettings(makeConfig()).defaultPipelineId).toBe('');

    // 4 — the idle view, both halves. The host projection and the webview
    // projection are separate literals and `settings-defaults-parity.test.ts`
    // exists because they have drifted before.
    const hostIdle = await import('../../../src/ui/sidebar/snapshot.js');
    const webviewIdle = await import('../../../webview-ui/src/lib/snapshot-types.js');
    expect(hostIdle.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
    expect(webviewIdle.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
  });

  it('keeps the declared type `string`, so the unset value crosses the boundary as a value', () => {
    // FR-033a. "Unset" is deliberately not `undefined` or a missing key: the
    // field is non-optional in the IPC contract, and making it optional to
    // express absence would have every consumer handle two shapes of nothing.
    expect(typeof readGeneralSettings(makeConfig()).defaultPipelineId).toBe('string');
    expect(SETTINGS_SCHEMA[SETTING_KEY].type).toBe('string');
  });

  it('can never name a Pipeline, so no consumer can present it as a selectable one', () => {
    // FR-033a's "MUST NOT present it as a selectable Pipeline" holds by
    // construction rather than by three separate guards. Both consumers pick by
    // membership — the schedule picker builds its items from the catalog, and
    // the queue input form keeps the default only when some available Pipeline
    // carries that id — so an id no Pipeline can ever carry is an id neither can
    // ever offer. The Pipeline id grammar requires a leading letter, so the
    // empty string is outside it and always will be.
    expect(PIPELINE_ID_PATTERN.test('')).toBe(false);

    // The setting's own pattern must accept it, though, or the value the
    // manifest ships as its default would be flagged as drift the moment an
    // operator writes it back explicitly.
    const settingPattern = SETTINGS_SCHEMA[SETTING_KEY].pattern;
    expect(settingPattern).toBeDefined();
    expect(new RegExp(settingPattern as string).test('')).toBe(true);
    expect(new RegExp(settingPattern as string).test('speckit-new-feature')).toBe(true);
    expect(new RegExp(settingPattern as string).test('Not An Id')).toBe(false);
  });

  it('refuses a launch that falls through to it, naming the missing id', () => {
    // FR-033b. The failure mode this rules out is a silent no-op: a launch that
    // resolves no Pipeline, starts nothing, and says nothing. `resolvePipeline`
    // is the one place that decides "fail", and it reports the id it could not
    // find — the empty string here, which is what the operator needs to see to
    // understand that the setting is unset rather than wrong.
    const factory = new WorkflowRunFactory({
      getCatalog: () => EMPTY_CATALOG,
      logger: new SanitizedLogger()
    });

    const resolution = factory.resolvePipeline(EMPTY_CATALOG.defaultPipelineId);

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal).toEqual({ reason: 'pipeline-not-found', pipelineId: '' });
    expect(describePipelineRefusal(resolution.refusal)).toBe(
      "pipeline '' is not in the effective catalog"
    );
  });
});
