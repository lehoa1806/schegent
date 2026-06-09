// Feature 056 Track 3 (FR-013..FR-018) — typed single source of truth
// for every `schegent.*` setting the host accepts.
//
// `SETTINGS_SCHEMA` mirrors the properties under
// `package.json` → `contributes.configuration.properties`. The parity
// test at `tests/unit/config/settings-schema-parity.test.ts` enforces
// bidirectional agreement: every package property has a schema entry
// and every schema entry has a package property, with matching
// `type` / `default` / `minimum` / `maximum` / `enum` constraints.
//
// Feature 059 added three nullable boolean trust-scope settings:
//   - schegent.trust.allowCustomPhases
//   - schegent.trust.allowCustomRetryConditions
//   - schegent.trust.allowPipelineOverrides
//
// This module is intentionally `vscode`-free: it is imported by host
// validators (transitively via `general-settings.ts`) and by tests.
// No I/O, no side effects, no module-level state besides the frozen
// schema record itself.
//
// The companion allowlist in `general-settings.ts` (`KEY_SPECS`) is
// preserved as the authoritative payload-key gate for
// `CMD_SAVE_GENERAL_SETTINGS` (CLAUDE.md hard rule 011 T039 / T071).
// `KEY_SPECS` covers the subset of settings that flow through the
// general-settings IPC; this schema is the superset that includes
// wake-up, phases, pipelines, models, and backend-runner keys whose
// IPC paths live elsewhere.

/** Setting value-shape category, mirroring JSON Schema vocabulary. */
export type SettingsSchemaType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'array'
  | 'enum';

/** Setting scope as documented in `package.json` contributions. */
export type SettingsSchemaScope = 'resource' | 'application' | 'window';

export interface SettingsSchemaEntry {
  /** Fully qualified key (prefixed with `schegent.`). */
  readonly key: string;
  readonly type: SettingsSchemaType;
  /** Default value as documented in `package.json`. */
  readonly default: unknown;
  readonly scope: SettingsSchemaScope;
  /** Short human-readable label used by docs / parity test failure messages. */
  readonly docLabel: string;
  readonly min?: number;
  readonly max?: number;
  /** Closed set of accepted values for `type === 'enum'`. */
  readonly enum?: readonly string[];
  /** Regex pattern (mirrors `pattern` in package.json) for `type === 'string'`. */
  readonly pattern?: string;
  /** Element type for `type === 'array'`. */
  readonly itemType?: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'object';
  /** `true` when `default === null` and the value may be cleared back to null. */
  readonly nullable?: boolean;
}

/**
 * Authoritative typed schema for the `schegent.*` settings shipped in
 * this extension. Every entry MUST agree byte-for-byte with the matching
 * property under `package.json` → `contributes.configuration.properties`.
 *
 * Adding a setting requires THREE edits in lock-step:
 *   1. Append the property under `package.json` contributions.
 *   2. Append a typed entry here.
 *   3. (If the IPC path is `CMD_SAVE_GENERAL_SETTINGS`) extend `KEY_SPECS`
 *      in `general-settings.ts`.
 *
 * The parity test fails the build if any of the three drift.
 */
export const SETTINGS_SCHEMA: Readonly<Record<string, SettingsSchemaEntry>> = Object.freeze({
  'schegent.cli.path': {
    key: 'schegent.cli.path',
    type: 'string',
    default: 'claude',
    scope: 'application',
    docLabel: 'Claude CLI binary path'
  },
  'schegent.cli.inheritEnvironment': {
    key: 'schegent.cli.inheritEnvironment',
    type: 'boolean',
    default: true,
    scope: 'application',
    docLabel: 'Backend CLI environment inheritance'
  },
  'schegent.backend.runner': {
    key: 'schegent.backend.runner',
    type: 'enum',
    default: 'claude',
    scope: 'application',
    enum: ['claude', 'codex'],
    docLabel: 'Backend runner selection'
  },
  'schegent.loop.maxIterations': {
    key: 'schegent.loop.maxIterations',
    type: 'number',
    default: 10,
    min: 1,
    max: 50,
    scope: 'resource',
    docLabel: 'Loop phase max iterations'
  },
  'schegent.watchdog.pollIntervalMinutes': {
    key: 'schegent.watchdog.pollIntervalMinutes',
    type: 'number',
    default: 30,
    min: 1,
    scope: 'resource',
    docLabel: 'Credit watchdog poll interval (minutes)'
  },
  'schegent.invocation.timeoutSeconds': {
    key: 'schegent.invocation.timeoutSeconds',
    type: 'number',
    default: 5400,
    min: 30,
    scope: 'resource',
    docLabel: 'Per-phase invocation timeout (seconds)'
  },
  'schegent.audit.rotation.sizeMB': {
    key: 'schegent.audit.rotation.sizeMB',
    type: 'number',
    default: 5,
    min: 1,
    scope: 'resource',
    docLabel: 'Audit log rotation size (MB)'
  },
  'schegent.audit.rotation.maxAgeDays': {
    key: 'schegent.audit.rotation.maxAgeDays',
    type: 'number',
    default: 30,
    min: 1,
    scope: 'resource',
    docLabel: 'Audit log rotation max age (days)'
  },
  'schegent.rules.injectPerPhase': {
    key: 'schegent.rules.injectPerPhase',
    type: 'boolean',
    default: false,
    scope: 'resource',
    docLabel: 'Reserved per-phase rule injection toggle'
  },
  'schegent.models': {
    key: 'schegent.models',
    type: 'array',
    default: [],
    itemType: 'string',
    scope: 'resource',
    docLabel: 'Custom model identifiers'
  },
  'schegent.phases': {
    key: 'schegent.phases',
    type: 'array',
    default: [],
    itemType: 'object',
    scope: 'resource',
    docLabel: 'Custom phase definitions'
  },
  'schegent.pipelines': {
    key: 'schegent.pipelines',
    type: 'array',
    default: [],
    itemType: 'object',
    scope: 'resource',
    docLabel: 'Custom pipeline definitions'
  },
  'schegent.defaultPipelineId': {
    key: 'schegent.defaultPipelineId',
    type: 'string',
    default: 'dev-new-feature',
    scope: 'resource',
    pattern: '^[a-z][a-z0-9-]{0,63}$',
    docLabel: 'Default pipeline id'
  },
  'schegent.retry.maxAttempts': {
    key: 'schegent.retry.maxAttempts',
    type: 'integer',
    default: 5,
    min: 1,
    max: 5,
    scope: 'resource',
    docLabel: 'Maximum delayed-retry attempts per run'
  },
  'schegent.queue.globalConcurrencyCap': {
    key: 'schegent.queue.globalConcurrencyCap',
    type: 'integer',
    default: 1,
    min: 1,
    max: 1,
    scope: 'resource',
    docLabel: 'Global queue concurrency cap (pinned at 1)'
  },
  'schegent.logging.verbose': {
    key: 'schegent.logging.verbose',
    type: 'boolean',
    default: false,
    scope: 'resource',
    docLabel: 'Verbose CLI diagnostic sink'
  },
  'schegent.logging.runtimeLogLevel': {
    key: 'schegent.logging.runtimeLogLevel',
    type: 'enum',
    default: 'INFO',
    enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
    scope: 'resource',
    docLabel: 'Runtime log severity filter'
  },
  'schegent.logging.runtimeLogFilePath': {
    key: 'schegent.logging.runtimeLogFilePath',
    type: 'string',
    default: '',
    scope: 'resource',
    docLabel: 'Runtime log file path (empty = workspace default)'
  },
  'schegent.logging.runtimeLogMaxBytes': {
    key: 'schegent.logging.runtimeLogMaxBytes',
    type: 'integer',
    default: 5242880,
    min: 65536,
    max: 1073741824,
    scope: 'resource',
    docLabel: 'Runtime log rotation threshold (bytes)'
  },
  'schegent.logging.runtimeLogMaxGenerations': {
    key: 'schegent.logging.runtimeLogMaxGenerations',
    type: 'integer',
    default: 3,
    min: 0,
    max: 20,
    scope: 'resource',
    docLabel: 'Runtime log rotated generations to keep'
  },
  'schegent.fatalSignatures': {
    key: 'schegent.fatalSignatures',
    type: 'array',
    default: [],
    itemType: 'string',
    scope: 'resource',
    docLabel: 'Operator-additive fatal-signature substrings'
  },
  'schegent.claude.autoCompactPctOverride': {
    key: 'schegent.claude.autoCompactPctOverride',
    type: 'integer',
    default: null,
    min: 1,
    max: 100,
    nullable: true,
    scope: 'resource',
    docLabel: 'Override for CLAUDE_AUTOCOMPACT_PCT (1-100, null = CLI default)'
  },
  'schegent.multiRoot.suppressWarning': {
    key: 'schegent.multiRoot.suppressWarning',
    type: 'boolean',
    default: false,
    scope: 'window',
    docLabel: 'Suppress multi-root workspace warning toast'
  },
  'schegent.ui.confirmations.enable': {
    key: 'schegent.ui.confirmations.enable',
    type: 'boolean',
    default: true,
    scope: 'window',
    docLabel: 'Show confirmation prompts for destructive UI actions'
  },
  'schegent.trust.allowCustomPhases': {
    key: 'schegent.trust.allowCustomPhases',
    type: 'boolean',
    default: null,
    nullable: true,
    scope: 'window',
    docLabel: 'Trust scope: allow saving non-default phase definitions'
  },
  'schegent.trust.allowCustomRetryConditions': {
    key: 'schegent.trust.allowCustomRetryConditions',
    type: 'boolean',
    default: null,
    nullable: true,
    scope: 'window',
    docLabel: 'Trust scope: allow saving non-default retry-condition DSL expressions on phase rows'
  },
  'schegent.trust.allowPipelineOverrides': {
    key: 'schegent.trust.allowPipelineOverrides',
    type: 'boolean',
    default: null,
    nullable: true,
    scope: 'window',
    docLabel: 'Trust scope: allow saving non-default pipeline catalog entries'
  },
  'schegent.wakeUp.enabled': {
    key: 'schegent.wakeUp.enabled',
    type: 'boolean',
    default: false,
    scope: 'application',
    docLabel: 'Wake up background scheduler enabled'
  },
  'schegent.wakeUp.schedulerType': {
    key: 'schegent.wakeUp.schedulerType',
    type: 'enum',
    default: 'chronological',
    enum: ['chronological', 'periodic'],
    scope: 'application',
    docLabel: 'Wake up scheduler trigger style'
  },
  'schegent.wakeUp.chronologicalTime': {
    key: 'schegent.wakeUp.chronologicalTime',
    type: 'string',
    default: '04:00',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    scope: 'application',
    docLabel: 'Wake up daily fire time (HH:MM)'
  },
  'schegent.wakeUp.periodicInterval': {
    key: 'schegent.wakeUp.periodicInterval',
    type: 'string',
    default: 'Every 4h',
    pattern: '^Every (\\d+)(m|h)$',
    scope: 'application',
    docLabel: 'Wake up periodic interval (Every Nm | Every Nh)'
  },
  'schegent.wakeUp.model': {
    key: 'schegent.wakeUp.model',
    type: 'enum',
    default: 'runner-default',
    enum: ['runner-default', 'claude-fable-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-6'],
    scope: 'application',
    docLabel: 'Wake up Claude model selection'
  }
});

/** The set of schema keys, frozen for downstream iteration. */
export const SETTINGS_SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(SETTINGS_SCHEMA));

/**
 * Returns `true` iff `value` satisfies the entry's `type`, `min`, `max`,
 * `enum`, and `nullable` constraints. The check is intentionally narrow
 * — array element validation lives in `general-settings.ts` because the
 * shape requirements vary by key (`fatalSignatures` rejects empty
 * strings; `models` allows them).
 */
export function isSchemaCompliantValue(
  entry: SettingsSchemaEntry,
  value: unknown
): boolean {
  if (value === null || value === undefined) {
    return entry.nullable === true;
  }
  switch (entry.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        (entry.min === undefined || value >= entry.min) &&
        (entry.max === undefined || value <= entry.max)
      );
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (entry.min === undefined || value >= entry.min) &&
        (entry.max === undefined || value <= entry.max)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'enum':
      return (
        typeof value === 'string' &&
        Array.isArray(entry.enum) &&
        entry.enum.includes(value)
      );
  }
}
