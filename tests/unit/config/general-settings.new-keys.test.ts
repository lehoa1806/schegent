// FR-R3-143 (T028) — the six settings the manifest has always contributed and
// the general-settings surface never carried, proved end to end.
//
// Each one is written through `writeGeneralSettings`, and then read back
// through `readGeneralSettings` FROM THE LAYER `configurationTargetFor` chose
// for it. That distinction is the whole point of the round trip: four of the
// six are `application`-scoped, which in real VS Code has no workspace layer, so
// a surface that wrote them to Workspace would appear to succeed and project
// nothing back. The fake below therefore stores by target rather than always
// into `workspace`, which the fake in `general-settings.test.ts` does — that one
// answers a different question and cannot answer this one.

import { describe, expect, it } from 'vitest';

import {
  CONFIGURATION_TARGET_GLOBAL,
  CONFIGURATION_TARGET_WORKSPACE,
  KEY_SPECS,
  configurationTargetFor,
  readGeneralSettings,
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';
import {
  REQUIRED_PROCESS_ENV_NAMES,
  buildSpawnEnv
} from '../../../src/runner/spawn-env';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';

interface InspectResult<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
}

/** A config whose layers are distinct, so writing to the wrong one is visible. */
class LayeredConfig {
  public readonly updateCalls: Array<{ key: string; value: unknown; target: number }> = [];
  private readonly global: Record<string, unknown> = {};
  private readonly workspace: Record<string, unknown> = {};

  get<T>(key: string, fallback: T): T {
    if (key in this.workspace) return this.workspace[key] as T;
    if (key in this.global) return this.global[key] as T;
    return fallback;
  }

  inspect<T>(key: string): InspectResult<T> | undefined {
    const out: InspectResult<T> = {};
    if (key in this.global) out.globalValue = this.global[key] as T;
    if (key in this.workspace) out.workspaceValue = this.workspace[key] as T;
    return out;
  }

  update(key: string, value: unknown, target: number): Promise<void> {
    this.updateCalls.push({ key, value, target });
    const layer = target === CONFIGURATION_TARGET_GLOBAL ? this.global : this.workspace;
    if (value === undefined) delete layer[key];
    else layer[key] = value;
    return Promise.resolve();
  }
}

function makeConfig(): { config: GeneralSettingsConfig; fake: LayeredConfig } {
  const fake = new LayeredConfig();
  return { config: fake as unknown as GeneralSettingsConfig, fake };
}

/**
 * One row per key this feature admits: what to save, what the projection must
 * report, and which scope the read path must attribute it to. `scope` is
 * derived from the key's own `KEY_SPECS` entry rather than restated, so a row
 * cannot claim a target the surface would not actually use.
 */
const NEW_KEYS = [
  {
    key: 'cli.inheritEnvironment' as const,
    typedField: 'cliInheritEnvironment' as const,
    saved: false,
    expected: false
  },
  {
    key: 'cli.environmentMode' as const,
    typedField: 'cliEnvironmentMode' as const,
    saved: 'minimal',
    expected: 'minimal'
  },
  {
    key: 'cli.environmentAllowlist' as const,
    typedField: 'cliEnvironmentAllowlist' as const,
    saved: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'],
    expected: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']
  },
  {
    key: 'backend.probeTimeoutSeconds' as const,
    typedField: 'backendProbeTimeoutSeconds' as const,
    saved: 12,
    expected: 12
  },
  {
    key: 'ui.confirmations.enable' as const,
    typedField: 'uiConfirmationsEnable' as const,
    saved: false,
    expected: false
  },
  {
    key: 'multiRoot.suppressWarning' as const,
    typedField: 'multiRootSuppressWarning' as const,
    saved: true,
    expected: true
  }
];

describe('FR-R3-143 — the six settings the tab could not offer', () => {
  it.each(NEW_KEYS)('$key round-trips at the target its scope requires', async (row) => {
    const { config, fake } = makeConfig();

    const result = await writeGeneralSettings(config, { [row.key]: row.saved });
    expect(result).toEqual({ ok: true });

    const expectedTarget = configurationTargetFor(KEY_SPECS[row.key].scope);
    expect(fake.updateCalls).toEqual([
      { key: row.key, value: row.saved, target: expectedTarget }
    ]);

    const projected = readGeneralSettings(config);
    expect(projected[row.typedField]).toEqual(row.expected);
    // A key written to Global reads back as `user`; to Workspace, as `workspace`.
    // Getting this wrong is how a machine-level policy would appear to be a
    // per-workspace one in the tab's scope label.
    expect(projected.scopes[row.typedField]).toBe(
      expectedTarget === CONFIGURATION_TARGET_GLOBAL ? 'user' : 'workspace'
    );
  });

  it('sends the four application-scoped keys to Global and the two window keys to Workspace', () => {
    const targets = Object.fromEntries(
      NEW_KEYS.map((row) => [row.key, configurationTargetFor(KEY_SPECS[row.key].scope)])
    );
    expect(targets).toEqual({
      'cli.inheritEnvironment': CONFIGURATION_TARGET_GLOBAL,
      'cli.environmentMode': CONFIGURATION_TARGET_GLOBAL,
      'cli.environmentAllowlist': CONFIGURATION_TARGET_GLOBAL,
      'backend.probeTimeoutSeconds': CONFIGURATION_TARGET_GLOBAL,
      'ui.confirmations.enable': CONFIGURATION_TARGET_WORKSPACE,
      'multiRoot.suppressWarning': CONFIGURATION_TARGET_WORKSPACE
    });
  });

  it('rolls the whole batch back when one of the six fails validation', async () => {
    const { config, fake } = makeConfig();

    // Five valid keys and one out of range: `backend.probeTimeoutSeconds` is
    // bounded [1, 30] by the manifest. Validation runs over the whole batch
    // before any write, so nothing may reach the config at all.
    const result = await writeGeneralSettings(config, {
      'cli.inheritEnvironment': false,
      'cli.environmentMode': 'minimal',
      'cli.environmentAllowlist': ['HTTPS_PROXY'],
      'backend.probeTimeoutSeconds': 31,
      'ui.confirmations.enable': false,
      'multiRoot.suppressWarning': true
    });

    expect(result).toEqual({ ok: false, reason: 'out-of-range:backend.probeTimeoutSeconds' });
    expect(fake.updateCalls).toEqual([]);

    const projected = readGeneralSettings(config);
    for (const row of NEW_KEYS) {
      expect(projected[row.typedField]).toEqual(KEY_SPECS[row.key].defaultValue);
    }
  });

  it('refuses an allowlist entry that is not a legal environment variable name', async () => {
    const { config, fake } = makeConfig();

    // The element pattern comes from `SETTINGS_SCHEMA`, not from a fourth copy
    // of the regex. Without it the write path accepted any non-empty string,
    // and the invalid name was silently dropped later, at spawn time.
    const result = await writeGeneralSettings(config, {
      'cli.environmentAllowlist': ['HTTPS_PROXY', 'not a name']
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-array:cli.environmentAllowlist' });
    expect(fake.updateCalls).toEqual([]);
  });

  it('drops an illegal allowlist entry a hand-edited settings.json holds', async () => {
    const { config } = makeConfig();
    await writeGeneralSettings(config, { 'cli.environmentAllowlist': ['HTTPS_PROXY'] });

    // Nothing stops an operator editing settings.json directly, so the read
    // path applies the same pattern the write path does. Projecting a value the
    // tab could not save back is how a field becomes un-editable.
    const doctored = {
      get: <T,>(key: string, fallback: T): T =>
        key === 'cli.environmentAllowlist'
          ? (['HTTPS_PROXY', 'not a name', ''] as unknown as T)
          : fallback,
      inspect: () => ({ globalValue: ['HTTPS_PROXY', 'not a name', ''] }),
      update: () => Promise.resolve()
    } as unknown as GeneralSettingsConfig;

    expect(readGeneralSettings(doctored).cliEnvironmentAllowlist).toEqual(['HTTPS_PROXY']);
  });

  it('saves the shipped empty allowlist and leaves every bootstrap variable intact', async () => {
    // The default `cli.environmentAllowlist` is `[]`, and `allowlist` is the
    // default mode — so this is what a stock installation spawns with. No test
    // in the tree exercised `processEnvAllowlist: []` through the allowlist
    // branch: `spawn-env-parity.test.ts` uses a populated list, and
    // `spawn-env.test.ts` only reaches `[]` via the invalid-mode fallback.
    // An empty list must mean "nothing EXTRA", never "nothing".
    const { config, fake } = makeConfig();

    const result = await writeGeneralSettings(config, { 'cli.environmentAllowlist': [] });
    expect(result).toEqual({ ok: true });
    expect(fake.updateCalls).toEqual([
      { key: 'cli.environmentAllowlist', value: [], target: CONFIGURATION_TARGET_GLOBAL }
    ]);

    const saved = readGeneralSettings(config).cliEnvironmentAllowlist;
    expect(saved).toEqual([]);

    const env = buildSpawnEnv({ env: {}, processEnvAllowlist: saved });
    const present = REQUIRED_PROCESS_ENV_NAMES.filter((name) => name in process.env);
    // Guard against a vacuous pass: this machine must actually have some of the
    // bootstrap variables for their survival to mean anything. PATH and HOME are
    // set on every platform this runs on.
    expect(present.length).toBeGreaterThan(0);
    for (const name of present) {
      expect(env[name]).toBe(process.env[name]);
    }

    // And it forwards nothing beyond the bootstrap set plus `LC_*`.
    const unexpected = Object.keys(env).filter(
      (name) => !REQUIRED_PROCESS_ENV_NAMES.includes(name) && !name.startsWith('LC_')
    );
    expect(unexpected).toEqual([]);
  });
});

/**
 * FR-R3-144 (T008, T009) — the three that let the tab name a backend and bound
 * what it spends, in the harness above rather than beside a second copy of it.
 * The `LayeredConfig` fake is the whole point: these three do NOT share a
 * target, and a fake with one layer cannot tell the difference.
 */
const BACKEND_AND_SPEND_KEYS = [
  {
    key: 'backend.runner' as const,
    typedField: 'backendRunner' as const,
    saved: 'codex',
    expected: 'codex'
  },
  {
    key: 'spend.maxUsdPerRun' as const,
    typedField: 'spendMaxUsdPerRun' as const,
    saved: 12.5,
    expected: 12.5
  },
  {
    key: 'spend.maxTokensPerRun' as const,
    typedField: 'spendMaxTokensPerRun' as const,
    saved: 250_000,
    expected: 250_000
  }
];

describe('FR-R3-144 — naming a backend and bounding what it spends', () => {
  it.each(BACKEND_AND_SPEND_KEYS)(
    '$key round-trips at the target its scope requires',
    async (row) => {
      const { config, fake } = makeConfig();

      const result = await writeGeneralSettings(config, { [row.key]: row.saved });
      expect(result).toEqual({ ok: true });

      // Derived, never hardcoded. The filed task asked for all three at Global;
      // two of them are `resource`-scoped in the manifest and belong in
      // Workspace, and a test that asserted Global for all three would have
      // passed against an implementation that ignored the scope column
      // entirely — which is the failure this line exists to prevent.
      const expectedTarget = configurationTargetFor(KEY_SPECS[row.key].scope);
      expect(fake.updateCalls).toEqual([
        { key: row.key, value: row.saved, target: expectedTarget }
      ]);

      const projected = readGeneralSettings(config);
      expect(projected[row.typedField]).toEqual(row.expected);
      expect(projected.scopes[row.typedField]).toBe(
        expectedTarget === CONFIGURATION_TARGET_GLOBAL ? 'user' : 'workspace'
      );
    }
  );

  it('sends the runner to Global and both spend bounds to Workspace', () => {
    const targets = Object.fromEntries(
      BACKEND_AND_SPEND_KEYS.map((row) => [
        row.key,
        configurationTargetFor(KEY_SPECS[row.key].scope)
      ])
    );
    expect(targets).toEqual({
      // A machine-level posture: which backend drives every phase, and so what
      // permission posture the installation runs under.
      'backend.runner': CONFIGURATION_TARGET_GLOBAL,
      // A bound on the work in THIS workspace.
      'spend.maxUsdPerRun': CONFIGURATION_TARGET_WORKSPACE,
      'spend.maxTokensPerRun': CONFIGURATION_TARGET_WORKSPACE
    });
  });

  it.each(['spend.maxUsdPerRun', 'spend.maxTokensPerRun'] as const)(
    '%s clears to null, which is no bound and not a bound of zero',
    async (key) => {
      const { config, fake } = makeConfig();
      const typedField = KEY_SPECS[key].typedField;

      await writeGeneralSettings(config, { [key]: key === 'spend.maxUsdPerRun' ? 7.5 : 7500 });
      const cleared = await writeGeneralSettings(config, { [key]: null });
      expect(cleared).toEqual({ ok: true });

      // Clearing REMOVES the key rather than writing an explicit null, so the
      // setting falls back to its default instead of pinning one in the
      // operator's settings.json. Both keys must do this: one is a `number` and
      // the other a `number-int-range`, and until this feature only the second
      // took the clear branch — the first wrote a literal null, which read back
      // with scope `workspace` while its twin read back as `default`.
      expect(fake.updateCalls.at(-1)).toEqual({
        key,
        value: undefined,
        target: CONFIGURATION_TARGET_WORKSPACE
      });
      const projected = readGeneralSettings(config);
      expect(projected[typedField]).toBeNull();
      expect(projected.scopes[typedField]).toBe('default');
    }
  );

  it('refuses a spend bound of zero rather than storing an unrunnable one', async () => {
    const { config, fake } = makeConfig();

    // `null` means unbounded and `0` means "stop before starting". The manifest
    // sets a minimum for exactly this reason, and the write path must enforce it
    // rather than leave the surface to.
    expect(await writeGeneralSettings(config, { 'spend.maxUsdPerRun': 0 })).toEqual({
      ok: false,
      reason: 'out-of-range:spend.maxUsdPerRun'
    });
    expect(await writeGeneralSettings(config, { 'spend.maxTokensPerRun': 0 })).toEqual({
      ok: false,
      reason: 'out-of-range:spend.maxTokensPerRun'
    });
    expect(fake.updateCalls).toEqual([]);
  });

  it('takes a decimal dollar bound and refuses a fractional token count', async () => {
    const { config } = makeConfig();

    // The distinction the two runtime types exist for: dollars are decimal,
    // tokens are counted.
    expect(await writeGeneralSettings(config, { 'spend.maxUsdPerRun': 0.25 })).toEqual({
      ok: true
    });
    expect(await writeGeneralSettings(config, { 'spend.maxTokensPerRun': 1.5 })).toEqual({
      ok: false,
      reason: 'type-mismatch:spend.maxTokensPerRun'
    });
  });

  it('refuses a backend the product does not support', async () => {
    const { config, fake } = makeConfig();
    expect(await writeGeneralSettings(config, { 'backend.runner': 'gpt' })).toEqual({
      ok: false,
      reason: 'invalid-enum:backend.runner'
    });
    expect(fake.updateCalls).toEqual([]);
  });

  it("backend.runner's allowed values ARE SUPPORTED_BACKENDS, not a copy of them", () => {
    // Identity, not membership. A hand-written `['claude','codex','agy']` here
    // would satisfy every other assertion in this file and would be a fourth
    // place a fourth backend has to be added — the one nothing reminds you
    // about, because the copy is correct on the day it is written.
    expect(KEY_SPECS['backend.runner'].allowedValues).toBe(SUPPORTED_BACKENDS);
  });
});
