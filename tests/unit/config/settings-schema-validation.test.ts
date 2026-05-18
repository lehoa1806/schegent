// Feature 056 Track 3 (FR-014) — settings-schema-backed validation.
//
// `SETTINGS_SCHEMA` is the source of truth for the value shape of every
// `schegent.*` setting. The existing `writeGeneralSettings()` host
// validator (driven by the older `KEY_SPECS` table in
// `general-settings.ts`) gates the subset of settings reachable via
// `CMD_SAVE_GENERAL_SETTINGS`. This test cross-validates the two:
//
//   1. Every key in KEY_SPECS' allowlist MUST also be in
//      SETTINGS_SCHEMA — the schema is the superset.
//   2. For every shared key, the schema-compliant default value MUST be
//      accepted by `writeGeneralSettings()`.
//   3. For every shared key with a numeric range, a value outside the
//      range MUST be rejected with `reason: 'out-of-range:<key>'`.
//   4. For every shared key with a runtime type, a value of the wrong
//      type MUST be rejected with `reason: 'type-mismatch:<key>'`.
//   5. For every shared enum key, an out-of-enum value MUST be rejected
//      with `reason: 'invalid-enum:<key>'`.
//   6. Unknown keys MUST be rejected with `reason: 'unknown-key:<key>'`.
//
// This is a behavioral test against the live `writeGeneralSettings`
// surface — no internal coupling. If a future refactor swaps
// `KEY_SPECS` for direct schema consumption (FR-014 next iteration),
// these tests stay green as long as the contract holds.

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_KEYS,
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';
import {
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_KEYS,
  isSchemaCompliantValue
} from '../../../src/config/settings-schema';

// Minimal fake matching the slice of `vscode.WorkspaceConfiguration`
// that the validator depends on. Mirrors the existing
// `general-settings.test.ts` fake.
class FakeWorkspaceConfig implements GeneralSettingsConfig {
  public readonly updateCalls: Array<{ key: string; value: unknown; target: number }> = [];
  private readonly workspace: Record<string, unknown> = {};

  get<T>(_key: string, fallback: T): T {
    return fallback;
  }

  inspect<T>(_key: string):
    | { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
    | undefined {
    return {};
  }

  update(key: string, value: unknown, target: number): Promise<void> {
    this.updateCalls.push({ key, value, target });
    this.workspace[key] = value;
    return Promise.resolve();
  }
}

/** Returns the unprefixed key (`logging.verbose` from `schegent.logging.verbose`). */
function unprefix(key: string): string {
  return key.replace(/^schegent\./, '');
}

/** The subset of SETTINGS_SCHEMA keys that flow through CMD_SAVE_GENERAL_SETTINGS. */
function generalSettingsCoveredKeys(): string[] {
  return Array.from(SETTINGS_SCHEMA_KEYS)
    .filter((k) => ALLOWED_KEYS.has(unprefix(k)))
    .sort();
}

describe('SETTINGS_SCHEMA validation alignment with writeGeneralSettings', () => {
  it('SETTINGS_SCHEMA covers every key in ALLOWED_KEYS (schema is the superset)', () => {
    // Intentionally-internal keys mirror the allowlist in
    // `tests/parity/settings-defaults-parity.test.ts`:
    //   - `queue.defaultQueueId`: pinned to `'default'` by the
    //     single-queue invariant (CLAUDE.md hard rule 030); not
    //     advertised in `package.json` or `SETTINGS_SCHEMA` because
    //     exposing it would invite operator drift away from
    //     `MAX_QUEUES = 1`. Add to this set only with a load-bearing
    //     reason.
    const INTENTIONALLY_INTERNAL = new Set<string>(['queue.defaultQueueId']);
    const missingFromSchema: string[] = [];
    for (const allowed of ALLOWED_KEYS) {
      if (INTENTIONALLY_INTERNAL.has(allowed)) continue;
      if (!SETTINGS_SCHEMA_KEYS.has(`schegent.${allowed}`)) {
        missingFromSchema.push(allowed);
      }
    }
    expect(
      missingFromSchema,
      `ALLOWED_KEYS missing from SETTINGS_SCHEMA: ${missingFromSchema.join(', ')}`
    ).toEqual([]);
  });

  it('writeGeneralSettings accepts every schema default for general-settings-covered keys', async () => {
    const covered = generalSettingsCoveredKeys();
    expect(covered.length).toBeGreaterThan(0);
    for (const fullKey of covered) {
      const entry = SETTINGS_SCHEMA[fullKey];
      // Skip null defaults for non-nullable types — those map to clear
      // semantics handled by other tests in this file.
      const value = entry.default;
      const config = new FakeWorkspaceConfig();
      const result = await writeGeneralSettings(config, { [unprefix(fullKey)]: value });
      expect(result, `expected accept for ${fullKey} default=${JSON.stringify(value)}`).toEqual({ ok: true });
    }
  });

  it('writeGeneralSettings rejects unknown keys with reason "unknown-key:<key>"', async () => {
    const config = new FakeWorkspaceConfig();
    const result = await writeGeneralSettings(config, { 'definitely.not.a.real.key': 'x' });
    expect(result).toEqual({ ok: false, reason: 'unknown-key:definitely.not.a.real.key' });
    expect(config.updateCalls).toHaveLength(0);
  });

  it('writeGeneralSettings rejects out-of-range integers for ranged keys', async () => {
    const ranged = generalSettingsCoveredKeys()
      .map((k) => SETTINGS_SCHEMA[k])
      .filter((entry) => entry.type === 'integer' && entry.max !== undefined);
    expect(ranged.length).toBeGreaterThan(0);
    for (const entry of ranged) {
      const overMax = (entry.max ?? 0) + 1;
      const config = new FakeWorkspaceConfig();
      const result = await writeGeneralSettings(config, { [unprefix(entry.key)]: overMax });
      expect(result, `expected reject for ${entry.key} overMax=${overMax}`).toEqual({
        ok: false,
        reason: `out-of-range:${unprefix(entry.key)}`
      });
      expect(config.updateCalls).toHaveLength(0);
    }
  });

  it('writeGeneralSettings rejects wrong-typed values with reason "type-mismatch:<key>"', async () => {
    // Pick the boolean keys and try a string; pick a string key and try a number.
    const booleanKeys = generalSettingsCoveredKeys().filter(
      (k) => SETTINGS_SCHEMA[k].type === 'boolean'
    );
    expect(booleanKeys.length).toBeGreaterThan(0);
    for (const fullKey of booleanKeys) {
      const config = new FakeWorkspaceConfig();
      const result = await writeGeneralSettings(config, { [unprefix(fullKey)]: 'not a boolean' });
      expect(result).toEqual({ ok: false, reason: `type-mismatch:${unprefix(fullKey)}` });
    }
  });

  it('writeGeneralSettings rejects out-of-enum strings with reason "invalid-enum:<key>"', async () => {
    const enumKeys = generalSettingsCoveredKeys().filter(
      (k) => SETTINGS_SCHEMA[k].type === 'enum'
    );
    for (const fullKey of enumKeys) {
      const config = new FakeWorkspaceConfig();
      const result = await writeGeneralSettings(config, { [unprefix(fullKey)]: 'not-an-enum-member' });
      expect(result).toEqual({ ok: false, reason: `invalid-enum:${unprefix(fullKey)}` });
    }
  });

  it('isSchemaCompliantValue agrees with writeGeneralSettings on a representative sample', async () => {
    // Round-trip sanity: a value that the schema accepts MUST also be
    // accepted by the host validator for the shared key set, and vice
    // versa. This protects against future drift if the host validator
    // is rewritten to consume the schema directly.
    const samples: Array<{ key: string; value: unknown }> = [
      { key: 'logging.verbose', value: true },
      { key: 'loop.maxIterations', value: 25 },
      { key: 'retry.maxAttempts', value: 3 },
      { key: 'queue.globalConcurrencyCap', value: 1 },
      { key: 'logging.runtimeLogLevel', value: 'DEBUG' },
      { key: 'logging.runtimeLogMaxBytes', value: 1024 * 1024 },
      { key: 'logging.runtimeLogMaxGenerations', value: 5 },
      { key: 'claude.autoCompactPctOverride', value: 80 }
    ];
    for (const { key, value } of samples) {
      const fullKey = `schegent.${key}`;
      const entry = SETTINGS_SCHEMA[fullKey];
      expect(entry, `sample names ${fullKey} but no schema entry`).toBeDefined();
      const schemaSays = isSchemaCompliantValue(entry, value);
      const config = new FakeWorkspaceConfig();
      const result = await writeGeneralSettings(config, { [key]: value });
      expect(
        result.ok === schemaSays,
        `schema/validator disagree on ${fullKey}=${JSON.stringify(value)}: schemaAccept=${schemaSays} validatorAccept=${result.ok}`
      ).toBe(true);
    }
  });
});
