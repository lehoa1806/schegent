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
// Feature 059 added nullable boolean trust-scope settings; feature 099 (T491,
// FR-045) removed the two that gated layer overrides, leaving the two that gate
// document content:
//   - schegent.trust.allowCustomPhases
//   - schegent.trust.allowCustomRetryConditions
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
// general-settings IPC; this schema is the superset that includes the
// Model Catalog and backend-runner keys whose IPC paths live elsewhere.
// Feature 099 (T494, FR-054) — it no longer includes definition keys at
// all: Phases, Pipelines and Workflows are stored, not configured.

/** Setting value-shape category, mirroring JSON Schema vocabulary. */
export type SettingsSchemaType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'array'
  | 'enum'
  | 'object';

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
  /** Optional element pattern for string arrays. */
  readonly itemPattern?: string;
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
  'schegent.cli.environmentMode': {
    key: 'schegent.cli.environmentMode',
    type: 'enum',
    // Feature 098 (PRIV-02) — `inherit` -> `allowlist`; see package.json.
    default: 'allowlist',
    scope: 'application',
    enum: ['inherit', 'minimal', 'allowlist'],
    docLabel: 'Backend CLI environment policy mode'
  },
  'schegent.cli.environmentAllowlist': {
    key: 'schegent.cli.environmentAllowlist',
    type: 'array',
    default: [],
    itemType: 'string',
    itemPattern: '^[A-Za-z_][A-Za-z0-9_]*$',
    scope: 'application',
    docLabel: 'Backend CLI environment variable name allowlist'
  },
  'schegent.backend.runner': {
    key: 'schegent.backend.runner',
    type: 'enum',
    default: 'claude',
    scope: 'application',
    enum: ['claude', 'codex', 'agy'],
    docLabel: 'Backend runner selection'
  },
  // FR-R3-056 (H-01) — `application`-scoped deliberately: this is a machine-level
  // safety posture, and a workspace must not be able to grant itself the right to
  // run an unbounded agent.
  'schegent.backend.allowUncontainedBackends': {
    key: 'schegent.backend.allowUncontainedBackends',
    type: 'boolean',
    default: false,
    scope: 'application',
    docLabel: 'Allow backends with no OS-enforced bound'
  },
  'schegent.backend.probeTimeoutSeconds': {
    key: 'schegent.backend.probeTimeoutSeconds',
    type: 'integer',
    default: 5,
    min: 1,
    max: 30,
    scope: 'application',
    docLabel: 'Backend capability probe timeout (seconds)'
  },
  'schegent.codex.path': {
    key: 'schegent.codex.path',
    type: 'string',
    default: 'codex',
    scope: 'application',
    docLabel: 'Codex CLI binary path'
  },
  'schegent.agy.path': {
    key: 'schegent.agy.path',
    type: 'string',
    default: 'agy',
    scope: 'application',
    docLabel: 'Agy CLI binary path'
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
  'schegent.models': {
    key: 'schegent.models',
    type: 'object',
    default: { claude: [], codex: [], agy: [] },
    scope: 'resource',
    docLabel: 'Custom model identifiers'
  },
  // Feature 099 (T494, FR-054) — the three retired definition settings keys
  // are deleted, not drained. Definitions live in the
  // versioned store; a settings key that still declared them would be a second
  // place to author a definition from, which is the thing the store replaces.
  // The keys that remain here name what a Pipeline may select and which Pipeline
  // a surface opens on — neither is a definition.
  'schegent.defaultPipelineId': {
    key: 'schegent.defaultPipelineId',
    type: 'string',
    // Feature 098 (T047, FR-033/FR-033a) — unset, spelled as the empty string.
    // The extension ships no Pipelines, so a default naming one was a default
    // naming nothing. The pattern admits the empty string alongside a real id:
    // it is the value the manifest now contributes, and an operator who clears
    // the field writes it back explicitly, so a grammar that rejected it would
    // report the unset state as drift.
    default: '',
    scope: 'resource',
    pattern: '^$|^[a-z][a-z0-9-]{0,63}$',
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
  'schegent.retry.forceContinueOnCap': {
    key: 'schegent.retry.forceContinueOnCap',
    type: 'boolean',
    default: false,
    scope: 'resource',
    docLabel: 'Continue past an unsatisfied retryCondition at the cap'
  },
  // Feature 092 (T054, FR-026/FR-027) — the cap is no longer pinned. Feature
  // 056 held it at exactly 1 because a single workspace lock made concurrency
  // unrepresentable; the lock split of US2 removed that constraint, so the
  // knob now means what it says.
  //
  // Feature 094 — the note above is the mechanism, not the permission. The
  // authority to ship a default above one is
  // `docs/architecture/local-queue-parallelism-ratification.md`, which narrows
  // one clause of the remote/multi-user expansion gate for the local
  // single-operator shape only, dispositions the gate's seven exit criteria
  // individually, and refuses precedent for anything wider. This is one of
  // three sites that *advertise* the range to the operator; three others
  // enforce it, and unlike those three this one restates the numbers rather
  // than deriving them, so it is a place drift can be recorded.
  //
  // Six sites in total. Do not take that count from any other comment: before
  // feature 094 the codebase carried two counts, four and five, which
  // disagreed with each other and with the truth.
  'schegent.queue.globalConcurrencyCap': {
    key: 'schegent.queue.globalConcurrencyCap',
    type: 'integer',
    // Feature 098 (REL-02) — default 3 -> 1; the RANGE is unchanged.
    default: 1,
    min: 1,
    max: 20,
    scope: 'resource',
    docLabel: 'Global queue concurrency cap'
  },
  'schegent.logging.verbose': {
    key: 'schegent.logging.verbose',
    type: 'boolean',
    default: false,
    scope: 'resource',
    docLabel: 'Verbose CLI diagnostic sink'
  },
  'schegent.logging.rawTranscriptMode': {
    key: 'schegent.logging.rawTranscriptMode',
    type: 'enum',
    // Feature 098 (PRIV-02) — `always` -> `errors-only`; see package.json.
    default: 'errors-only',
    enum: ['always', 'errors-only', 'off'],
    scope: 'resource',
    docLabel: 'Raw transcript retention policy for new runs'
  },
  'schegent.logging.sessionRetentionMaxAgeDays': {
    key: 'schegent.logging.sessionRetentionMaxAgeDays',
    type: 'integer',
    default: 30,
    min: 1,
    max: 3650,
    scope: 'resource',
    docLabel: 'Unredacted session artifact maximum age (days)'
  },
  'schegent.logging.sessionRetentionMaxBytes': {
    key: 'schegent.logging.sessionRetentionMaxBytes',
    type: 'integer',
    default: 536870912,
    min: 1048576,
    max: 10737418240,
    scope: 'resource',
    docLabel: 'Unredacted session artifact total byte budget'
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
  }
});

/** The set of schema keys, frozen for downstream iteration. */
export const SETTINGS_SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(SETTINGS_SCHEMA));

/**
 * Returns `true` iff `value` satisfies the entry's type, bounds, enum,
 * nullable, and declared array-element constraints. Domain-specific rules
 * such as non-empty fatal signatures remain in their owning validators.
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
      if (!Array.isArray(value)) return false;
      if (entry.itemType === undefined) return true;
      return value.every((item) => {
        const typeMatches = (() => {
          switch (entry.itemType) {
            case 'string': return typeof item === 'string';
            case 'integer': return typeof item === 'number' && Number.isInteger(item);
            case 'number': return typeof item === 'number' && Number.isFinite(item);
            case 'boolean': return typeof item === 'boolean';
            case 'object': return typeof item === 'object' && item !== null && !Array.isArray(item);
            case 'enum': return typeof item === 'string';
            case undefined: return true;
          }
        })();
        return typeMatches && (
          entry.itemPattern === undefined ||
          (typeof item === 'string' && new RegExp(entry.itemPattern).test(item))
        );
      });
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'enum':
      return (
        typeof value === 'string' &&
        Array.isArray(entry.enum) &&
        entry.enum.includes(value)
      );
  }
}
