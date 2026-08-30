// Feature 011 — typed read/write surface for scalar `schegent.*` keys.
//
// Two responsibilities:
//   1. `readGeneralSettings(config)` projects the current effective values into a
//      typed `GeneralSettings` snapshot for the webview, including a per-key
//      `scopes` map (workspace > user > default).
//   2. `writeGeneralSettings(config, updates)` validates a batch transactionally —
//      every key in the allowlist, every value matching its declared runtime type —
//      then writes each accepted key at the target its MANIFEST SCOPE requires:
//      `Global` for an `application`-scoped key, which has no workspace layer, and
//      `Workspace` otherwise (FR-R3-051 / M-05, superseding FR-020's "Workspace
//      only"). On validation failure no key is written; on a later persistence
//      failure, keys already written are restored at the layer they went to.
//
// The host adds the `schegent.` prefix; payload keys are unprefixed scalar setting
// names. See contracts/general-settings-ipc.md.
//

// FR-R3-144 (T001) — the table, the payload shape and the validator moved out;
// this module keeps the two functions that touch the host config object. Every
// moved name is re-exported below, so no importer changed.
import {
  ALLOWED_KEYS,
  CONFIGURATION_TARGET_GLOBAL,
  CONFIGURATION_TARGET_WORKSPACE,
  KEY_SPECS,
  configurationTargetFor,
  type AllowedKey,
  type GeneralSettings,
  type ManifestSettingScope,
  type SettingScope
} from './general-settings-keys';
import {
  checkArrayElements,
  checkType,
  isAllowedKey,
  type WriteResult
} from './general-settings-validate';

export {
  ALLOWED_KEYS,
  CONFIGURATION_TARGET_GLOBAL,
  CONFIGURATION_TARGET_WORKSPACE,
  KEY_SPECS,
  configurationTargetFor
};
export type {
  AllowedKey,
  GeneralSettings,
  ManifestSettingScope,
  SettingScope,
  WriteResult
};
export type { KeySpec, RuntimeType } from './general-settings-keys';

/**
 * Minimal slice of `vscode.WorkspaceConfiguration` that this surface
 * depends on. Defined here (instead of importing `vscode`) so we can
 * unit-test the surface without spinning up the @vscode/test-electron
 * harness — the real VS Code object satisfies this contract by
 * construction.
 */
export interface GeneralSettingsConfig {
  get<T>(key: string, defaultValue: T): T;
  inspect<T>(key: string):
    | {
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      }
    | undefined;
  // FR-R3-143 (T022) — `Promise<void> | Thenable<void>`, until the payload-parity
  // gate imported this module from the webview and `Thenable` turned out to be an
  // ambient `@types/vscode` global. The module's header says it is `vscode`-free
  // so it can be tested without the electron harness; that was true of its imports
  // and false of its types. `@types/vscode` declares `Thenable<T> extends
  // PromiseLike<T>` with no members, so the real `WorkspaceConfiguration.update`
  // still satisfies this and nothing that assigned before stops.
  update(key: string, value: unknown, target: number): PromiseLike<void>;
}

interface WrittenValueSnapshot {
  readonly hadValue: boolean;
  readonly value: unknown;
}

/**
 * Validate a batch of updates AND persist each one to
 * `ConfigurationTarget.Workspace` if every entry validates. Validation
 * failure is a no-op. Write failure triggers compensating rollback of
 * keys already written by this batch so the effective workspace values
 * return to their pre-call state when rollback succeeds.
 *
 * Possible failure reasons:
 *   - `unknown-key:<key>` — key not in `ALLOWED_KEYS`
 *   - `type-mismatch:<key>` — runtime type does not match spec
 *   - `invalid-array:<key>` — array contains a non-string or empty element
 *   - `out-of-range:<key>` — integer outside the declared `[min, max]` range
 *   - `write-failed:<key>` — underlying `config.update()` rejected
 *   - `clear-failed:<key>` — clear via `config.update(key, undefined)` rejected
 *   - `rollback-failed:<key>:after:<reason>:<detail>` — a write failed and
 *     the compensating rollback for a previously-written key also failed
 */
/**
 * Optional callback fired AFTER a successful write that touched either
 * `logging.runtimeLogLevel` or `logging.runtimeLogFilePath` (Feature
 * 019). The host wires this to `runtimeLogSink.clearSuppression(...)`
 * so an operator's correction unlocks the next emit. The callback is
 * NEVER invoked on validation failure or write failure.
 */
export interface WriteGeneralSettingsHooks {
  readonly onRuntimeLogSettingChanged?: () => void;
}

// Feature 056 Track 9 (T060) — runtimeLogMaxBytes / runtimeLogMaxGenerations
// extend the suppression-clear trigger surface. A save of either rotation
// key MUST clear the sink's suppression map even when the saved value is
// unchanged (mirrors CLAUDE.md hard rule 019 FR-019 / FR-020). Forgetting
// to extend this set means a one-time write failure permanently silences
// the sink for an operator-corrected rotation policy.
const RUNTIME_LOG_KEYS = new Set<string>([
  'logging.runtimeLogLevel',
  'logging.runtimeLogFilePath',
  'logging.runtimeLogMaxBytes',
  'logging.runtimeLogMaxGenerations'
]);

/**
 * FR-R3-051 (M-05) — snapshot the layer this batch is about to WRITE, which is
 * the only layer a rollback may restore. Scope-aware through the same resolver
 * as the write, not a parallel pair; see the contract for why.
 */
function captureWrittenValue(
  config: GeneralSettingsConfig,
  key: string,
  scope: ManifestSettingScope
): WrittenValueSnapshot {
  const inspected = config.inspect<unknown>(key);
  const value =
    configurationTargetFor(scope) === CONFIGURATION_TARGET_GLOBAL
      ? inspected?.globalValue
      : inspected?.workspaceValue;
  return {
    hadValue: value !== undefined,
    value
  };
}

async function restoreWrittenValue(
  config: GeneralSettingsConfig,
  key: AllowedKey,
  snapshot: WrittenValueSnapshot
): Promise<void> {
  await Promise.resolve(
    config.update(
      key,
      snapshot.hadValue ? snapshot.value : undefined,
      configurationTargetFor(KEY_SPECS[key].scope)
    )
  );
}

async function rollbackWrittenSettings(
  config: GeneralSettingsConfig,
  snapshots: ReadonlyMap<string, WrittenValueSnapshot>,
  writtenKeys: readonly string[],
  primaryReason: string
): Promise<string | null> {
  for (const key of [...writtenKeys].reverse()) {
    const snapshot = snapshots.get(key);
    if (!snapshot) continue;
    try {
      await restoreWrittenValue(config, key as AllowedKey, snapshot);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown';
      return `rollback-failed:${key}:after:${primaryReason}:${detail}`;
    }
  }
  return null;
}

export async function writeGeneralSettings(
  config: GeneralSettingsConfig,
  updates: Readonly<Record<string, unknown>>,
  hooks?: WriteGeneralSettingsHooks
): Promise<WriteResult> {
  // Validate every entry first; bail out without writing if any fails.
  const entries = Object.entries(updates);
  for (const [key, value] of entries) {
    if (!isAllowedKey(key)) {
      return { ok: false, reason: `unknown-key:${key}` };
    }
    const spec = KEY_SPECS[key];
    const typeCheck = checkType(spec, value);
    if (!typeCheck.ok) {
      return { ok: false, reason: `${typeCheck.reason}:${key}` };
    }
    if (spec.type === 'array-of-string') {
      const arrCheck = checkArrayElements(spec, value as readonly unknown[]);
      if (!arrCheck.ok) {
        return { ok: false, reason: `invalid-array:${key}` };
      }
    }
  }

  const snapshots = new Map<string, WrittenValueSnapshot>();
  for (const [key] of entries) {
    snapshots.set(key, captureWrittenValue(config, key, KEY_SPECS[key as AllowedKey].scope));
  }

  // All valid — write each. Surface the first underlying failure as
  // `write-failed:<key>` so the operator gets the offending key id. If
  // a later key fails, restore any earlier keys changed by this batch.
  const writtenKeys: string[] = [];
  for (const [key, value] of entries) {
    const spec = KEY_SPECS[key as AllowedKey];
    // FR-R3-144 (T008) — the third and last place the clear sentinel was pinned
    // to `number-int-range`. Found by a test, not by reading: `spend.maxUsdPerRun`
    // is a `number`, so clearing it fell through to `config.update(key, null)`
    // and wrote an explicit null, while its twin `spend.maxTokensPerRun` took
    // this branch and REMOVED the key. Same operator action on two settings that
    // mean the same thing, two different `settings.json` states — and two
    // different scope labels afterwards, since an explicit null reads back as
    // `workspace` and a removal as `default`.
    //
    // Clearing is a property of `allowClear`; the runtime type decides what a
    // non-cleared value must look like and nothing else.
    const isClear = spec.allowClear === true && (value === null || value === undefined);
    // FR-R3-051 (M-05) — the target the key's manifest scope requires.
    const target = configurationTargetFor(spec.scope);
    try {
      if (isClear) {
        await Promise.resolve(config.update(key, undefined, target));
      } else {
        await Promise.resolve(config.update(key, value, target));
      }
      writtenKeys.push(key);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown';
      const primaryReason = isClear ? `clear-failed:${key}` : `write-failed:${key}:${detail}`;
      const rollbackReason = await rollbackWrittenSettings(
        config,
        snapshots,
        writtenKeys,
        primaryReason
      );
      return { ok: false, reason: rollbackReason ?? primaryReason };
    }
  }
  if (hooks?.onRuntimeLogSettingChanged) {
    const touched = entries.some(([key]) => RUNTIME_LOG_KEYS.has(key));
    if (touched) {
      try {
        hooks.onRuntimeLogSettingChanged();
      } catch {
        // Swallow callback errors — the write itself already succeeded.
      }
    }
  }
  return { ok: true };
}

/**
 * Validate `schegent.fatalSignatures`. Returns the cleaned array on
 * success or `[]` on any malformation (per FR-036 — never block
 * activation on a bad value). The caller may surface a warn-once via
 * its own logger.
 */
export function readFatalSignaturesSetting(
  config: GeneralSettingsConfig
): readonly string[] {
  const raw = config.get<unknown>('fatalSignatures', []);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const el of raw) {
    if (typeof el !== 'string') return [];
    if (el.trim().length === 0) return [];
    out.push(el);
  }
  return Object.freeze(out);
}

function inspectScope(
  config: GeneralSettingsConfig,
  key: string
): SettingScope {
  const ins = config.inspect(key);
  if (!ins) return 'default';
  if (ins.workspaceValue !== undefined) return 'workspace';
  if (ins.globalValue !== undefined) return 'user';
  return 'default';
}

/**
 * Project the current effective workspace configuration into a typed
 * `GeneralSettings` snapshot for the webview. Falls back to the
 * registered defaults if a key is absent at every scope.
 */
export function readGeneralSettings(
  config: GeneralSettingsConfig
): GeneralSettings {
  const out: Record<string, unknown> = {};
  const scopes: Record<string, SettingScope> = {};
  for (const key of Object.keys(KEY_SPECS) as AllowedKey[]) {
    const spec = KEY_SPECS[key];
    let value = config.get(key, spec.defaultValue);
    if (spec.type === 'array-of-string') {
      // FR-R3-143 (T019) — a hand-edited settings.json can hold an element the
      // write path refuses. Drop it here too, so the tab never shows a value it
      // could not save back.
      const itemPattern = spec.itemPattern === undefined ? null : new RegExp(spec.itemPattern);
      if (!Array.isArray(value)) value = [];
      else
        value = (value as unknown[]).filter(
          (el) =>
            typeof el === 'string' && el.length > 0 && (itemPattern === null || itemPattern.test(el))
        );
    }
    if (spec.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        value = spec.defaultValue;
      }
    }
    if (spec.type === 'number-int-range') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        // FR-R3-144 (T006) — a cleared key projects ITS OWN declared default,
        // which for an `allowClear` key IS the cleared value. This used to be a
        // literal `undefined`, correct for the one `allowClear` key that existed
        // (`claude.autoCompactPctOverride`, whose `defaultValue` is `undefined`)
        // and wrong for `spend.maxTokensPerRun`, whose manifest default is
        // `null`. Its sibling `spend.maxUsdPerRun` is a `number` and reaches the
        // branch above, which already projects `defaultValue`; two settings that
        // mean the same thing would otherwise have arrived at the webview as
        // `undefined` and `null`. No behaviour changed for the autocompact key.
        value = spec.defaultValue;
      }
    }
    if (spec.type === 'string-enum') {
      if (
        typeof value !== 'string' ||
        !spec.allowedValues ||
        !spec.allowedValues.includes(value)
      ) {
        value = spec.defaultValue;
      }
    }
    if (spec.type === 'string-no-traversal') {
      if (typeof value !== 'string') {
        value = spec.defaultValue;
      } else {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          const isAbsolute =
            trimmed.startsWith('/') ||
            trimmed.startsWith('\\\\') ||
            trimmed.startsWith('//') ||
            /^[A-Za-z]:[\\/]?/.test(trimmed);
          if (!isAbsolute) {
            const segments = trimmed.split(/[\\/]+/);
            if (segments.some((seg) => seg === '..')) {
              value = spec.defaultValue;
            }
          }
        }
      }
    }
    out[spec.typedField] = value;
    scopes[spec.typedField] = inspectScope(config, key);
  }
  out.scopes = scopes;
  return Object.freeze(out) as unknown as GeneralSettings;
}
