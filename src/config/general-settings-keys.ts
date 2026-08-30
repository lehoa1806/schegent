// FR-R3-144 (T001) — the settings TABLE and the payload shape it projects, split
// out of `general-settings.ts`.
//
// The seam is table / validator / transaction, and it is a seam rather than a
// line-count cut: this file is data plus the types that describe it, the
// validator is a pure function of a spec and a value, and the transaction is the
// only part that touches the host config object. `general-settings.ts` re-exports
// every name below, so the 29 modules that import from it are untouched — the
// shim precedent is `runner/spawn-env.ts` (FR-R3-143).
//
// `GeneralSettings` lives HERE and not with the transaction because `KeySpec`'s
// `typedField` is `keyof Omit<GeneralSettings, 'scopes'>`: the table and the shape
// it projects are one fact, and splitting them would have put a type-only cycle
// across the seam to say so.
//
// Nothing in this move changed. New entries arrive at the bottom of `KEY_SPECS`.

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
// FR-R3-144 (T006/T009) — `backend.runner`'s allowed values ARE
// `SUPPORTED_BACKENDS`, not a list with the same three members. A hand-written
// `['claude','codex','agy']` here is a fourth place a backend has to be added.
import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../contracts/backend-kinds';

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
  // FR-R3-144 (T005) — the three the Settings tab needed in order to say which
  // backend runs and what it may spend. `backendRunner` is the product's largest
  // privilege choice and was reachable only by hand-editing settings.json.
  //
  // Both bounds are `number | null`, and `null` is the manifest's own default: it
  // means NO BOUND, not zero. That is why they are `allowClear` — see the
  // sentinel note in `general-settings-validate.ts`.
  readonly backendRunner: BackendRunnerKind;
  readonly spendMaxUsdPerRun: number | null;
  readonly spendMaxTokensPerRun: number | null;
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
    readonly backendRunner: SettingScope;
    readonly spendMaxUsdPerRun: SettingScope;
    readonly spendMaxTokensPerRun: SettingScope;
  };
}

export type AllowedKey =
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
  | 'multiRoot.suppressWarning'
  | 'backend.runner'
  | 'spend.maxUsdPerRun'
  | 'spend.maxTokensPerRun';

export type RuntimeType =
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

export interface KeySpec {
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
  },
  // FR-R3-144 (T006) — the three settings that let the tab name a backend and
  // bound what it spends. Each carries the scope its manifest contribution
  // DECLARES, which is the point of the `scope` column: `backend.runner` is a
  // machine-level posture (`application` -> Global), while a spend bound belongs
  // to the workspace being run (`resource` -> Workspace). Writing all three to
  // Global would put the two bounds in a layer their own contribution says they
  // do not live in, and `restricted-configurations-parity` proves the mapping
  // rather than a comment asserting it.
  'backend.runner': { scope: 'application',
    type: 'string-enum',
    typedField: 'backendRunner',
    defaultValue: DEFAULT_BACKEND,
    allowedValues: SUPPORTED_BACKENDS
  },
  // Decimal, because it is US dollars, and nullable, because `null` means NO
  // bound rather than a bound of zero. `number` rather than `number-int-range`
  // for the first reason and `allowClear` for the second — the pair no key had
  // before, which is why the clear sentinel had to leave `number-int-range`.
  'spend.maxUsdPerRun': { scope: 'resource',
    type: 'number',
    typedField: 'spendMaxUsdPerRun',
    defaultValue: null,
    min: 0.01,
    allowClear: true
  },
  // The token twin, for backends that report tokens and no cost. Integer, and
  // nullable for the same reason.
  'spend.maxTokensPerRun': { scope: 'resource',
    type: 'number-int-range',
    typedField: 'spendMaxTokensPerRun',
    defaultValue: null,
    min: 1,
    allowClear: true
  }
});

/** Unprefixed scalar setting names accepted by `writeGeneralSettings`. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(KEY_SPECS));
