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
// FR-R3-132 (T1502) — `SettingScope` moved to `src/contracts/snapshot-vocabulary.ts`,
// so the webview imports it rather than restating it. Re-exported unchanged.
import type { SettingScope } from '../contracts/snapshot-vocabulary';
export type { SettingScope };
// FR-R3-143 (T015, revised at T034) — the element pattern for
// `cli.environmentAllowlist` is READ, not restated: a fourth copy of
// `^[A-Za-z_][A-Za-z0-9_]*$` would be the copy that drifts. From `contracts/`
// rather than `SETTINGS_SCHEMA`, because T034 made contracts the single
// declaration the schema itself now reads — indexing the schema here would be
// reading a copy of a copy, through an index access the strictness ratchet counts.
import { PROCESS_ENV_NAME_PATTERN_SOURCE } from '../contracts/process-environment-policy';

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

/** Mirrors `vscode.ConfigurationTarget.Global`. */
export const CONFIGURATION_TARGET_GLOBAL = 1;

/** Mirrors `vscode.ConfigurationTarget.Workspace`. */
export const CONFIGURATION_TARGET_WORKSPACE = 2;

/**
 * FR-R3-051 (M-05) — the one place a key's configuration target is decided.
 * An `application`-scoped setting has no workspace layer, so real VS Code
 * refuses that write. See the contract named above for why this is one resolver
 * and not a constant at each of the three call sites.
 */
export function configurationTargetFor(scope: ManifestSettingScope): number {
  return scope === 'application' ? CONFIGURATION_TARGET_GLOBAL : CONFIGURATION_TARGET_WORKSPACE;
}



export interface GeneralSettings {
  readonly cliPath: string;
  readonly loggingVerbose: boolean;
  readonly loopMaxIterations: number;
  readonly invocationIdleTimeoutSeconds: number;
  readonly invocationMaxDurationSeconds: number;
  readonly watchdogPollIntervalMinutes: number;
  readonly auditRotationSizeMB: number;
  readonly auditRotationMaxAgeDays: number;
  readonly defaultPipelineId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly runtimeLogLevel: string;
  readonly runtimeLogFilePath: string;
  readonly retryMaxAttempts: number;
  readonly retryForceContinueOnCap: boolean;
  readonly codexPath: string;
  readonly agyPath: string;
  readonly runtimeLogMaxBytes: number;
  readonly runtimeLogMaxGenerations: number;
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
  readonly rawTranscriptMode: import('../state/workflow-run').RawTranscriptMode;
  // FR-R3-143 (T017) — six settings the manifest has always contributed and
  // this surface never projected, so the tab could not draw them.
  readonly cliInheritEnvironment: boolean;
  readonly cliEnvironmentMode: string;
  readonly cliEnvironmentAllowlist: readonly string[];
  readonly backendProbeTimeoutSeconds: number;
  readonly uiConfirmationsEnable: boolean;
  readonly multiRootSuppressWarning: boolean;
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationIdleTimeoutSeconds: SettingScope;
    readonly invocationMaxDurationSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly defaultPipelineId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly runtimeLogLevel: SettingScope;
    readonly runtimeLogFilePath: SettingScope;
    readonly retryMaxAttempts: SettingScope;
    readonly retryForceContinueOnCap: SettingScope;
    readonly codexPath: SettingScope;
    readonly agyPath: SettingScope;
    readonly runtimeLogMaxBytes: SettingScope;
    readonly runtimeLogMaxGenerations: SettingScope;
    readonly sessionRetentionMaxAgeDays: SettingScope;
    readonly sessionRetentionMaxBytes: SettingScope;
    readonly rawTranscriptMode: SettingScope;
    readonly cliInheritEnvironment: SettingScope;
    readonly cliEnvironmentMode: SettingScope;
    readonly cliEnvironmentAllowlist: SettingScope;
    readonly backendProbeTimeoutSeconds: SettingScope;
    readonly uiConfirmationsEnable: SettingScope;
    readonly multiRootSuppressWarning: SettingScope;
  };
}

type AllowedKey =
  | 'cli.path'
  | 'logging.verbose'
  | 'loop.maxIterations'
  | 'invocation.idleTimeoutSeconds'
  | 'invocation.maxDurationSeconds'
  | 'watchdog.pollIntervalMinutes'
  | 'audit.rotation.sizeMB'
  | 'audit.rotation.maxAgeDays'
  | 'defaultPipelineId'
  | 'fatalSignatures'
  | 'claude.autoCompactPctOverride'
  | 'logging.runtimeLogLevel'
  | 'logging.runtimeLogFilePath'
  | 'retry.maxAttempts'
  | 'retry.forceContinueOnCap'
  | 'codex.path'
  | 'agy.path'
  | 'logging.runtimeLogMaxBytes'
  | 'logging.runtimeLogMaxGenerations'
  | 'logging.sessionRetentionMaxAgeDays'
  | 'logging.sessionRetentionMaxBytes'
  | 'logging.rawTranscriptMode'
  | 'cli.inheritEnvironment'
  | 'cli.environmentMode'
  | 'cli.environmentAllowlist'
  | 'backend.probeTimeoutSeconds'
  | 'ui.confirmations.enable'
  | 'multiRoot.suppressWarning';

type RuntimeType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array-of-string'
  | 'number-int-range'
  | 'string-enum'
  | 'string-no-traversal';

/**
 * FR-R3-051 (M-05) — the manifest's `scope`, mirrored so a write can pick the
 * target that scope requires. Required, so a key without one fails to compile.
 * See specs/136-settings-scope-and-defaults/contracts/settings-write-target.md.
 */
export type ManifestSettingScope = 'application' | 'window' | 'resource';

interface KeySpec {
  readonly scope: ManifestSettingScope;
  readonly type: RuntimeType;
  readonly typedField: keyof Omit<GeneralSettings, 'scopes'>;
  readonly defaultValue: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly allowClear?: boolean;
  readonly allowedValues?: readonly string[];
  /** Element pattern for `array-of-string`; mirrors the schema's `itemPattern`. */
  readonly itemPattern?: string;
}

export const KEY_SPECS: Readonly<Record<AllowedKey, KeySpec>> = Object.freeze({
  'cli.path': { scope: 'application', type: 'string', typedField: 'cliPath', defaultValue: 'claude' },
  'codex.path': { scope: 'application', type: 'string', typedField: 'codexPath', defaultValue: 'codex' },
  'agy.path': { scope: 'application', type: 'string', typedField: 'agyPath', defaultValue: 'agy' },
  'logging.verbose': { scope: 'resource',
    type: 'boolean',
    typedField: 'loggingVerbose',
    defaultValue: false
  },
  'loop.maxIterations': { scope: 'resource',
    type: 'number',
    typedField: 'loopMaxIterations',
    defaultValue: 10,
    min: 1,
    max: 50
  },
  'invocation.idleTimeoutSeconds': { scope: 'resource',
    type: 'number',
    typedField: 'invocationIdleTimeoutSeconds',
    defaultValue: 5400,
    min: 30
  },
  // FR-R3-075 -- the absolute wall-clock bound beside the idle window above.
  // 21600 s = 4x the idle default and ~1.7x the longest legitimately long
  // phase observed to date (3.6 h): loose enough that no real phase yet seen
  // would have been killed, bounded enough that a chatty runaway stops.
  'invocation.maxDurationSeconds': { scope: 'resource',
    type: 'number',
    typedField: 'invocationMaxDurationSeconds',
    defaultValue: 21600,
    min: 60
  },
  'watchdog.pollIntervalMinutes': { scope: 'resource',
    type: 'number',
    typedField: 'watchdogPollIntervalMinutes',
    defaultValue: 30,
    min: 1
  },
  'audit.rotation.sizeMB': { scope: 'resource',
    type: 'number',
    typedField: 'auditRotationSizeMB',
    defaultValue: 5,
    min: 1
  },
  'audit.rotation.maxAgeDays': { scope: 'resource',
    type: 'number',
    typedField: 'auditRotationMaxAgeDays',
    defaultValue: 30,
    min: 1
  },
  defaultPipelineId: { scope: 'resource',
    type: 'string',
    typedField: 'defaultPipelineId',
    // Feature 056 Track 3 (FR-013..FR-017) — Align host default with the
    // package.json contribution default so a fresh workspace and the webview
    // idle snapshot agree. Feature 098 (T047, FR-033a) — that value is unset.
    defaultValue: ''
  },
  fatalSignatures: { scope: 'resource',
    type: 'array-of-string',
    typedField: 'fatalSignatures',
    defaultValue: []
  },
  'claude.autoCompactPctOverride': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'claudeAutoCompactPctOverride',
    defaultValue: undefined,
    min: 1,
    max: 100,
    allowClear: true
  },
  'logging.runtimeLogLevel': { scope: 'resource',
    type: 'string-enum',
    typedField: 'runtimeLogLevel',
    defaultValue: 'INFO',
    allowedValues: ['DEBUG', 'INFO', 'WARN', 'ERROR']
  },
  'logging.runtimeLogFilePath': { scope: 'resource',
    type: 'string-no-traversal',
    typedField: 'runtimeLogFilePath',
    defaultValue: ''
  },
  'retry.maxAttempts': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'retryMaxAttempts',
    // Feature 056 Track 4 (FR-018..FR-022) — The advertised maximum
    // matches the effective implementation cap (`DELAYED_RETRY_CAP = 5`)
    // in src/controller/retry-handler.ts. Previously the contribution
    // schema and host validator exposed [1, 20] which silently saturated
    // at 5 in production.
    defaultValue: 5,
    min: 1,
    max: 5
  },
  // Workspace-wide default for a phase's `forceContinueOnRetryCap`. Defaults
  // OFF: advancing on an unsatisfied condition is a deliberate trade of
  // verification for progress, so it is opted into, never inherited.
  'retry.forceContinueOnCap': { scope: 'resource',
    type: 'boolean',
    typedField: 'retryForceContinueOnCap',
    defaultValue: false
  },
  'logging.runtimeLogMaxBytes': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'runtimeLogMaxBytes',
    // Feature 056 Track 7 (F-009 runtime-log retention) — Default 5 MiB.
    // 64 KiB minimum is large enough to avoid pathological rotation
    // thrash; 1 GiB upper bound prevents accidental fork-bomb-style
    // unbounded growth via the workspace mirror.
    defaultValue: 5 * 1024 * 1024,
    min: 65536,
    max: 1073741824
  },
  'logging.runtimeLogMaxGenerations': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'runtimeLogMaxGenerations',
    // Feature 056 Track 7 (F-009 runtime-log retention) — Default 3
    // rotated generations (current + 3 = 4 files total). Operators can
    // disable rotation entirely with 0; the upper bound caps the
    // worst-case disk footprint at (1 + 20) × runtimeLogMaxBytes.
    defaultValue: 3,
    min: 0,
    max: 20
  },
  'logging.sessionRetentionMaxAgeDays': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'sessionRetentionMaxAgeDays',
    defaultValue: 30,
    min: 1,
    max: 3650
  },
  'logging.sessionRetentionMaxBytes': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'sessionRetentionMaxBytes',
    defaultValue: 512 * 1024 * 1024,
    min: 1024 * 1024,
    max: 10 * 1024 * 1024 * 1024
  },
  'logging.rawTranscriptMode': { scope: 'resource',
    type: 'string-enum',
    typedField: 'rawTranscriptMode',
    // FR-R3-051 (M-06) — `errors-only`, matching the manifest. This said
    // `always`: the manifest is what VS Code applies, so a code fallback here
    // retained MORE raw transcript data than the setting the user was shown.
    defaultValue: 'errors-only',
    allowedValues: ['always', 'errors-only', 'off']
  },
  // FR-R3-143 (T018) — six keys the manifest contributes that this allowlist
  // did not carry, so the settings tab had no write path for them. Every
  // `defaultValue`, `min`, `max` and `allowedValues` below is the manifest's;
  // `settings-defaults-parity` compares the two and fails on drift.
  'cli.inheritEnvironment': { scope: 'application',
    type: 'boolean',
    typedField: 'cliInheritEnvironment',
    defaultValue: true
  },
  'cli.environmentMode': { scope: 'application',
    type: 'string-enum',
    typedField: 'cliEnvironmentMode',
    defaultValue: 'allowlist',
    allowedValues: ['inherit', 'minimal', 'allowlist']
  },
  'cli.environmentAllowlist': { scope: 'application',
    type: 'array-of-string',
    typedField: 'cliEnvironmentAllowlist',
    defaultValue: [],
    // Read, not restated — see the import note at the head of this file.
    itemPattern: PROCESS_ENV_NAME_PATTERN_SOURCE
  },
  'backend.probeTimeoutSeconds': { scope: 'application',
    type: 'number-int-range',
    typedField: 'backendProbeTimeoutSeconds',
    defaultValue: 5,
    min: 1,
    max: 30
  },
  // The first two `window`-scoped entries in this table. `configurationTargetFor`
  // already routes anything that is not `application` to Workspace, so they need
  // no code change there — only the correct scope declared here.
  'ui.confirmations.enable': { scope: 'window',
    type: 'boolean',
    typedField: 'uiConfirmationsEnable',
    defaultValue: true
  },
  'multiRoot.suppressWarning': { scope: 'window',
    type: 'boolean',
    typedField: 'multiRootSuppressWarning',
    defaultValue: false
  }
});

/** Unprefixed scalar setting names accepted by `writeGeneralSettings`. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(KEY_SPECS));

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface WrittenValueSnapshot {
  readonly hadValue: boolean;
  readonly value: unknown;
}

function isAllowedKey(key: string): key is AllowedKey {
  return ALLOWED_KEYS.has(key);
}

function checkType(spec: KeySpec, value: unknown): WriteResult {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, reason: 'out-of-range' };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, reason: 'out-of-range' };
      }
      return { ok: true };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'array-of-string':
      return Array.isArray(value)
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'number-int-range': {
      // `null` / `undefined` are accepted as a clear sentinel iff `allowClear`.
      if (value === null || value === undefined) {
        return spec.allowClear === true
          ? { ok: true }
          : { ok: false, reason: 'type-mismatch' };
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, reason: 'out-of-range' };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, reason: 'out-of-range' };
      }
      return { ok: true };
    }
    case 'string-enum': {
      if (typeof value !== 'string') {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (!spec.allowedValues || !spec.allowedValues.includes(value)) {
        return { ok: false, reason: 'invalid-enum' };
      }
      return { ok: true };
    }
    case 'string-no-traversal': {
      // Allow empty string (= default), any absolute path, and relative
      // paths that contain no `..` segment. Path resolution against a
      // workspace happens at read time via `resolveRuntimeLogPath`.
      if (typeof value !== 'string') {
        return { ok: false, reason: 'type-mismatch' };
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) return { ok: true };
      const isAbsolute =
        trimmed.startsWith('/') ||
        trimmed.startsWith('\\\\') ||
        trimmed.startsWith('//') ||
        /^[A-Za-z]:[\\/]?/.test(trimmed);
      if (isAbsolute) return { ok: true };
      const segments = trimmed.split(/[\\/]+/);
      if (segments.some((seg) => seg === '..')) {
        return { ok: false, reason: 'relative-traversal' };
      }
      return { ok: true };
    }
  }
}

function checkArrayElements(spec: KeySpec, value: readonly unknown[]): WriteResult {
  const itemPattern = spec.itemPattern === undefined ? null : new RegExp(spec.itemPattern);
  for (const el of value) {
    if (typeof el !== 'string') return { ok: false, reason: 'invalid-array' };
    if (el.trim().length === 0) return { ok: false, reason: 'invalid-array' };
    if (itemPattern !== null && !itemPattern.test(el)) {
      return { ok: false, reason: 'invalid-array' };
    }
  }
  return { ok: true };
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
    const isClear =
      spec.type === 'number-int-range' &&
      spec.allowClear === true &&
      (value === null || value === undefined);
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
        value = spec.allowClear === true ? undefined : spec.defaultValue;
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
