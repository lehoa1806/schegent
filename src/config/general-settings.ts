// Feature 011 — typed read/write surface for scalar `schegent.*` keys.
//
// Two responsibilities:
//   1. `readGeneralSettings(config)` projects the current effective
//      values into a typed `GeneralSettings` snapshot for the webview,
//      including a per-key `scopes` map (workspace > user > default).
//   2. `writeGeneralSettings(config, updates)` validates a batch of
//      updates transactionally — every key must be in the allowlist
//      AND every value must match the declared runtime type — and then
//      writes each accepted key to `vscode.ConfigurationTarget.Workspace`
//      (FR-020). On validation failure no key is written; on a later
//      persistence failure, keys already written by the batch are restored
//      to their previous workspace-scope values.
//
// The host adds the `schegent.` prefix; payload keys are unprefixed
// scalar setting names. See contracts/general-settings-ipc.md.

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
  update(key: string, value: unknown, target: number): Promise<void> | Thenable<void>;
}

/** Mirrors `vscode.ConfigurationTarget.Workspace`. */
export const CONFIGURATION_TARGET_WORKSPACE = 2;

/** Setting scope as projected to the webview. */
export type SettingScope = 'workspace' | 'user' | 'default';

export interface GeneralSettings {
  readonly cliPath: string;
  readonly loggingVerbose: boolean;
  readonly loopMaxIterations: number;
  readonly invocationTimeoutSeconds: number;
  readonly watchdogPollIntervalMinutes: number;
  readonly auditRotationSizeMB: number;
  readonly auditRotationMaxAgeDays: number;
  readonly defaultPipelineId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly queueGlobalConcurrencyCap: number;
  readonly queueDefaultQueueId: string;
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
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationTimeoutSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly defaultPipelineId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly queueGlobalConcurrencyCap: SettingScope;
    readonly queueDefaultQueueId: SettingScope;
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
  };
}

type AllowedKey =
  | 'cli.path'
  | 'logging.verbose'
  | 'loop.maxIterations'
  | 'invocation.timeoutSeconds'
  | 'watchdog.pollIntervalMinutes'
  | 'audit.rotation.sizeMB'
  | 'audit.rotation.maxAgeDays'
  | 'defaultPipelineId'
  | 'fatalSignatures'
  | 'claude.autoCompactPctOverride'
  | 'queue.globalConcurrencyCap'
  | 'queue.defaultQueueId'
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
  | 'logging.rawTranscriptMode';

type RuntimeType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array-of-string'
  | 'number-int-range'
  | 'string-enum'
  | 'string-no-traversal';

interface KeySpec {
  readonly type: RuntimeType;
  readonly typedField: keyof Omit<GeneralSettings, 'scopes'>;
  readonly defaultValue: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly allowClear?: boolean;
  readonly allowedValues?: readonly string[];
}

const KEY_SPECS: Readonly<Record<AllowedKey, KeySpec>> = Object.freeze({
  'cli.path': { type: 'string', typedField: 'cliPath', defaultValue: 'claude' },
  'codex.path': { type: 'string', typedField: 'codexPath', defaultValue: 'codex' },
  'agy.path': { type: 'string', typedField: 'agyPath', defaultValue: 'agy' },
  'logging.verbose': {
    type: 'boolean',
    typedField: 'loggingVerbose',
    defaultValue: false
  },
  'loop.maxIterations': {
    type: 'number',
    typedField: 'loopMaxIterations',
    defaultValue: 10,
    min: 1,
    max: 50
  },
  'invocation.timeoutSeconds': {
    type: 'number',
    typedField: 'invocationTimeoutSeconds',
    defaultValue: 5400,
    min: 30
  },
  'watchdog.pollIntervalMinutes': {
    type: 'number',
    typedField: 'watchdogPollIntervalMinutes',
    defaultValue: 30,
    min: 1
  },
  'audit.rotation.sizeMB': {
    type: 'number',
    typedField: 'auditRotationSizeMB',
    defaultValue: 5,
    min: 1
  },
  'audit.rotation.maxAgeDays': {
    type: 'number',
    typedField: 'auditRotationMaxAgeDays',
    defaultValue: 30,
    min: 1
  },
  defaultPipelineId: {
    type: 'string',
    typedField: 'defaultPipelineId',
    // Feature 056 Track 3 (FR-013..FR-017) — Align host default with
    // package.json contribution default so a fresh workspace and the
    // webview idle snapshot agree on which pipeline is selected.
    defaultValue: 'speckit-new-feature'
  },
  fatalSignatures: {
    type: 'array-of-string',
    typedField: 'fatalSignatures',
    defaultValue: []
  },
  'claude.autoCompactPctOverride': {
    type: 'number-int-range',
    typedField: 'claudeAutoCompactPctOverride',
    defaultValue: undefined,
    min: 1,
    max: 100,
    allowClear: true
  },
  'queue.globalConcurrencyCap': {
    type: 'number-int-range',
    typedField: 'queueGlobalConcurrencyCap',
    // Feature 092 (T055, FR-026/FR-027) — the cap was pinned at 1 by feature
    // 056 Track 4 (FR-018..FR-022) because one workspace lock meant one run.
    // US2 split that lock into window primacy plus a per-queue execution
    // lease, so the RANGE opened to [1, 20]; `settings-schema-parity.test.ts`
    // fails unless the advertising sites agree. Feature 098 (REL-02) moved the
    // DEFAULT back to 1 — range untouched — as concurrent Runs share a tree.
    //
    // Feature 094 — the bound lives in six sites, not the "three and a fourth"
    // this comment used to claim: three advertise (this one,
    // `settings-schema.ts`, package.json) and three enforce. All six, the
    // authority for a range wider than one, and the 098 default's reasoning:
    // `docs/architecture/local-queue-parallelism-ratification.md`.
    defaultValue: 1,
    min: 1,
    max: 20
  },
  'queue.defaultQueueId': {
    type: 'string',
    typedField: 'queueDefaultQueueId',
    defaultValue: 'default'
  },
  'logging.runtimeLogLevel': {
    type: 'string-enum',
    typedField: 'runtimeLogLevel',
    defaultValue: 'INFO',
    allowedValues: ['DEBUG', 'INFO', 'WARN', 'ERROR']
  },
  'logging.runtimeLogFilePath': {
    type: 'string-no-traversal',
    typedField: 'runtimeLogFilePath',
    defaultValue: ''
  },
  'retry.maxAttempts': {
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
  'retry.forceContinueOnCap': {
    type: 'boolean',
    typedField: 'retryForceContinueOnCap',
    defaultValue: false
  },
  'logging.runtimeLogMaxBytes': {
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
  'logging.runtimeLogMaxGenerations': {
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
  'logging.sessionRetentionMaxAgeDays': {
    type: 'number-int-range',
    typedField: 'sessionRetentionMaxAgeDays',
    defaultValue: 30,
    min: 1,
    max: 3650
  },
  'logging.sessionRetentionMaxBytes': {
    type: 'number-int-range',
    typedField: 'sessionRetentionMaxBytes',
    defaultValue: 512 * 1024 * 1024,
    min: 1024 * 1024,
    max: 10 * 1024 * 1024 * 1024
  },
  'logging.rawTranscriptMode': {
    type: 'string-enum',
    typedField: 'rawTranscriptMode',
    defaultValue: 'always',
    allowedValues: ['always', 'errors-only', 'off']
  }
});

/** Unprefixed scalar setting names accepted by `writeGeneralSettings`. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(KEY_SPECS));

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface WorkspaceValueSnapshot {
  readonly hadWorkspaceValue: boolean;
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

function checkArrayElements(value: readonly unknown[]): WriteResult {
  for (const el of value) {
    if (typeof el !== 'string') return { ok: false, reason: 'invalid-array' };
    if (el.trim().length === 0) return { ok: false, reason: 'invalid-array' };
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

function captureWorkspaceValue(
  config: GeneralSettingsConfig,
  key: string
): WorkspaceValueSnapshot {
  const inspected = config.inspect<unknown>(key);
  const value = inspected?.workspaceValue;
  return {
    hadWorkspaceValue: value !== undefined,
    value
  };
}

async function restoreWorkspaceValue(
  config: GeneralSettingsConfig,
  key: string,
  snapshot: WorkspaceValueSnapshot
): Promise<void> {
  await Promise.resolve(
    config.update(
      key,
      snapshot.hadWorkspaceValue ? snapshot.value : undefined,
      CONFIGURATION_TARGET_WORKSPACE
    )
  );
}

async function rollbackWrittenSettings(
  config: GeneralSettingsConfig,
  snapshots: ReadonlyMap<string, WorkspaceValueSnapshot>,
  writtenKeys: readonly string[],
  primaryReason: string
): Promise<string | null> {
  for (const key of [...writtenKeys].reverse()) {
    const snapshot = snapshots.get(key);
    if (!snapshot) continue;
    try {
      await restoreWorkspaceValue(config, key, snapshot);
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
      const arrCheck = checkArrayElements(value as readonly unknown[]);
      if (!arrCheck.ok) {
        return { ok: false, reason: `invalid-array:${key}` };
      }
    }
  }

  const snapshots = new Map<string, WorkspaceValueSnapshot>();
  for (const [key] of entries) {
    snapshots.set(key, captureWorkspaceValue(config, key));
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
    try {
      if (isClear) {
        await Promise.resolve(config.update(key, undefined, CONFIGURATION_TARGET_WORKSPACE));
      } else {
        await Promise.resolve(config.update(key, value, CONFIGURATION_TARGET_WORKSPACE));
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
      if (!Array.isArray(value)) value = [];
      else value = (value as unknown[]).filter((el) => typeof el === 'string' && el.length > 0);
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
