// Feature 011 — US2 P2: unified Settings surface.
//
// Covers:
//   SC-004 — every scalar `schegent.*` key is projected into the
//            WorkflowSnapshot's `generalSettings` field with the current
//            effective value AND a scope indicator (workspace/user/default).
//   SC-005 — `writeGeneralSettings()` persists to Workspace target;
//            re-reading after a write returns the new value (survives
//            "reload" — simulated by re-invoking `readGeneralSettings`).
//
// Drives `readGeneralSettings()` and `writeGeneralSettings()` directly
// against a fake `vscode.WorkspaceConfiguration` to keep the test
// hermetic and avoid touching the real settings.json. The router-side
// CMD_SAVE_GENERAL_SETTINGS plumbing is covered by the router unit
// tests in tests/unit/ui/sidebar/general-settings-router.test.ts.

import { describe, it, expect } from 'vitest';
import {
  readGeneralSettings,
  writeGeneralSettings,
  ALLOWED_KEYS,
  type GeneralSettingsConfig
} from '../../src/config/general-settings';

interface InspectResult<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
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
    this.workspace[key] = value;
    return Promise.resolve();
  }
}

const DEFAULTS: Record<string, unknown> = {
  'cli.path': 'claude',
  'logging.verbose': false,
  'loop.maxIterations': 10,
  'invocation.timeoutSeconds': 1800,
  'watchdog.pollIntervalMinutes': 30,
  'audit.rotation.sizeMB': 5,
  'audit.rotation.maxAgeDays': 30,
  'rules.injectPerPhase': false,
  defaultPipelineId: 'speckit-new-feature',
  fatalSignatures: []
};

function makeConfig(opts: {
  workspace?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}): GeneralSettingsConfig {
  return new FakeWorkspaceConfig(
    { ...DEFAULTS },
    opts.workspace ?? {},
    opts.user ?? {}
  ) as unknown as GeneralSettingsConfig;
}

describe('Feature 011 — Settings surface (US2)', () => {
  it('SC-004: every scalar schegent.* key is in the projected GeneralSettings', () => {
    const config = makeConfig();
    const snap = readGeneralSettings(config);

    // Every key in the allowlist must appear in the projection with a
    // typed value, and have a `scopes` entry.
    expect(typeof snap.cliPath).toBe('string');
    expect(typeof snap.loggingVerbose).toBe('boolean');
    expect(typeof snap.loopMaxIterations).toBe('number');
    expect(typeof snap.invocationTimeoutSeconds).toBe('number');
    expect(typeof snap.watchdogPollIntervalMinutes).toBe('number');
    expect(typeof snap.auditRotationSizeMB).toBe('number');
    expect(typeof snap.auditRotationMaxAgeDays).toBe('number');
    expect(typeof snap.rulesInjectPerPhase).toBe('boolean');
    expect(typeof snap.defaultPipelineId).toBe('string');
    expect(Array.isArray(snap.fatalSignatures)).toBe(true);

    // Scopes must be present for every typed field. Cardinality check:
    // 10 keys in allowlist → 10 entries in scopes map.
    const scopeKeys = Object.keys(snap.scopes);
    expect(scopeKeys.length).toBe(ALLOWED_KEYS.size);
    for (const v of Object.values(snap.scopes)) {
      expect(['workspace', 'user', 'default']).toContain(v);
    }
  });

  it('SC-005: a write to workspace persists; re-read reflects the new value', async () => {
    const config = makeConfig();

    const before = readGeneralSettings(config);
    expect(before.loopMaxIterations).toBe(10);
    expect(before.scopes.loopMaxIterations).toBe('default');

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 25,
      'logging.verbose': true
    });
    expect(result.ok).toBe(true);

    // Simulate "reopen" by reading the same backing store again — the
    // workspace overrides we just wrote must now dominate the defaults.
    const after = readGeneralSettings(config);
    expect(after.loopMaxIterations).toBe(25);
    expect(after.loggingVerbose).toBe(true);
    expect(after.scopes.loopMaxIterations).toBe('workspace');
    expect(after.scopes.loggingVerbose).toBe('workspace');
  });

  it('a transactional reject does NOT mutate any key', async () => {
    const config = makeConfig();
    const before = readGeneralSettings(config);

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 42,
      'unknown.key': 'oops'
    });
    expect(result.ok).toBe(false);

    const after = readGeneralSettings(config);
    expect(after.loopMaxIterations).toBe(before.loopMaxIterations);
    expect(after.scopes.loopMaxIterations).toBe('default');
  });

  it('fatalSignatures round-trips through write+read', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      fatalSignatures: ['context length exceeded', 'token quota exceeded']
    });
    expect(result.ok).toBe(true);

    const snap = readGeneralSettings(config);
    expect(snap.fatalSignatures).toEqual([
      'context length exceeded',
      'token quota exceeded'
    ]);
    expect(snap.scopes.fatalSignatures).toBe('workspace');
  });

  it('user-scope values do not override an explicit workspace value', () => {
    const config = makeConfig({
      workspace: { 'cli.path': '/opt/claude' },
      user: { 'cli.path': '/usr/local/bin/claude' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('/opt/claude');
    expect(snap.scopes.cliPath).toBe('workspace');
  });
});
