// FR-R7-06 — single authoritative pure-data table describing every supported backend.
//
// WHY THIS EXISTS
//
// Backend metadata used to be scattered across more than fifty sites (settings schemas,
// path accessors, containment policies, confirmed/unbounded flag tables, spend
// denominations, qualified versions, ACP profiles, ambient config paths, repo-agent
// config paths, validation rules, and webview controls). Adding or changing a backend
// meant updating dozens of files by hand and relying on a census gate to catch misses.
//
// WHAT LIVES HERE — AND WHAT DOES NOT
//
// Pure, deeply frozen static data ONLY: display labels, setting keys, default binaries,
// containment mechanisms, confirmed and unbounded flag sets, spend denominations,
// qualified CLI versions, ACP profile descriptors, ambient and repo-agent config paths,
// and explicit capability flags. Every absent capability is an explicit sentinel value
// (`null`, `false`, `'none'`, or `[]`), never an omitted optional property.
//
// Behaviour (building adapter argv, spawning CLIs, bridging ACP streams, parsing usage
// JSONL) stays in per-backend adapters. Zero function-valued fields live on
// `BackendDescriptor`, and this module imports nothing from acting layers.
//
// Backend identity (`BackendRunnerKind`, `SUPPORTED_BACKENDS`, `DEFAULT_BACKEND`,
// `isBackendRunnerKind`) remains exclusively in `src/contracts/backend-kinds.ts` per
// FR-R3-089 (`tests/lint/backend-kind-placement.test.ts` forbids re-exporting them).

import { SUPPORTED_BACKENDS, type BackendRunnerKind } from './backend-kinds';
import type { RunnerLabel } from './backend-runner';
import type { PhaseDefinitionEffort } from './process-definitions';

/** Which OS-enforced containment boundary a backend's default argv establishes. */
export type BackendContainmentMechanism =
  /** `codex exec --sandbox workspace-write`; macOS Seatbelt on darwin. */
  | 'codex-sandbox-workspace-write'
  /** No OS-enforced bound in the adapter's argv. */
  | 'none';

/** Permission mode recorded on `cli-invocation` audit rows. */
export type AuditPermissionMode =
  | 'read-only'
  | 'workspace-write'
  | 'unrestricted';

/** What a backend's spend is measured in, for the purpose of bounding it. */
export type SpendDenomination = 'usd' | 'tokens';

/** Whether the backend speaks ACP natively over stdio or through the maintained stdio bridge. */
export type AcpProfileKind = 'native' | 'bridge';

/** Built-in ACP capability tokens required by host profiles. */
export type AcpRequiredCapability = 'load-session' | 'embedded-context';

/** Built-in ACP profile identifiers declared by `BACKEND_DESCRIPTORS`. */
export type BuiltinAcpProfileId =
  | 'agy-acp-native'
  | 'claude-acp-bridge'
  | 'codex-acp-bridge';

interface BackendAcpProfileBase {
  readonly profileId: BuiltinAcpProfileId;
  readonly revision: number;
  readonly provider: string;
  readonly executableRef: string;
  readonly requiredCapabilities: readonly AcpRequiredCapability[];
}

/** Static built-in ACP profile descriptor for a backend (discriminated on `kind`). */
export type BackendAcpProfileDescriptor =
  | (BackendAcpProfileBase & {
      readonly kind: 'native';
      /** Native ACP stdio launch arguments before permission flags. */
      readonly nativeStdioArgs: readonly string[];
    })
  | (BackendAcpProfileBase & {
      readonly kind: 'bridge';
      /** Bridged backends spawn the maintained Node.js stdio bridge instead of native stdio args. */
      readonly nativeStdioArgs: null;
    });

/**
 * Complete static metadata for one supported backend.
 *
 * No field is optional: an absent capability carries an explicit sentinel
 * (`null`, `false`, `'none'`, or `[]`). Zero function-valued fields are permitted.
 */
export interface BackendDescriptor {
  readonly kind: BackendRunnerKind;
  readonly displayLabel: string;
  readonly runnerLabel: RunnerLabel;
  /** Setting key under the `schegent.` namespace (e.g. `'cli.path'`). */
  readonly cliPathSettingKey: string;
  /** Typed camelCase field name on `GeneralSettings` (e.g. `'cliPath'`). */
  readonly cliPathFieldKey: string;
  /** Human-readable label for settings schema docs (e.g. `'Claude CLI binary path'`). */
  readonly cliPathDocLabel: string;
  /** Default executable name resolved via PATH when the path setting is blank. */
  readonly defaultCliBinary: string;
  /** Whether `resolveCliPath` falls back to `fallbackDefaultPath` before `defaultCliBinary`. */
  readonly usesLegacyFallbackPath: boolean;
  readonly containmentMechanism: BackendContainmentMechanism;
  readonly defaultAuditPermissionMode: AuditPermissionMode;
  /** Flags confirmed present in the installed CLI's `--help` capture. */
  readonly confirmedFlags: readonly string[];
  /** Permission argv flags emitted when no capabilities are withheld. */
  readonly unboundedFlags: readonly string[];
  readonly spendDenomination: SpendDenomination;
  /** Qualified CLI version token matching `docs/release/backend-qualification-log.md`. */
  readonly qualifiedCliVersion: string;
  readonly acpProfile: BackendAcpProfileDescriptor;
  /** Home-directory-relative path segments for ambient user CLI config, or `null` when none. */
  readonly ambientConfigSegments: readonly string[] | null;
  /** Repository-relative agent configuration paths scanned for operator acknowledgement. */
  readonly repoAgentConfigPaths: readonly string[];
  /** Whether the backend can execute phases declaring `sideEffects: git`. */
  readonly supportsGitSideEffects: boolean;
  /** Whether the backend honours the auto-compaction percentage override env var. */
  readonly supportsAutoCompactOverride: boolean;
  /** Whether the controller runs pre-phase session compaction on session reuse. */
  readonly supportsSessionCompaction: boolean;
  /** CLI arguments for dynamic model discovery, or `null` when the CLI cannot list models. */
  readonly modelDiscoveryArgs: readonly string[] | null;
  /** Effort levels rejected by this backend (empty array when all levels are accepted). */
  readonly unsupportedEffortLevels: readonly PhaseDefinitionEffort[];
  /** Example model identifier shown in the Model Catalog editor placeholder. */
  readonly exampleModelPlaceholder: string;
}

/** Readonly map keyed exhaustively by `BackendRunnerKind`. */
export type BackendMap<T> = { readonly [K in BackendRunnerKind]: T };

/** Mutable map keyed exhaustively by `BackendRunnerKind`. */
export type MutableBackendMap<T> = { [K in BackendRunnerKind]: T };

/**
 * Exhaustive descriptor table keyed by `BackendRunnerKind`.
 *
 * Adding a fourth union member to `BackendRunnerKind` fails TypeScript compilation right here
 * with the missing backend key and every required field.
 */
export const BACKEND_DESCRIPTORS: Readonly<Record<BackendRunnerKind, BackendDescriptor>> =
  Object.freeze({
    claude: Object.freeze({
      kind: 'claude',
      displayLabel: 'Claude',
      runnerLabel: 'claude-cli',
      cliPathSettingKey: 'cli.path',
      cliPathFieldKey: 'cliPath',
      cliPathDocLabel: 'Claude CLI binary path',
      defaultCliBinary: 'claude',
      usesLegacyFallbackPath: true,
      containmentMechanism: 'none',
      defaultAuditPermissionMode: 'unrestricted',
      confirmedFlags: Object.freeze([
        '--dangerously-skip-permissions',
        '--disallowedTools',
        '--permission-mode'
      ]),
      unboundedFlags: Object.freeze(['--dangerously-skip-permissions']),
      spendDenomination: 'usd',
      qualifiedCliVersion: '2.1.302',
      acpProfile: Object.freeze({
        profileId: 'claude-acp-bridge',
        revision: 1,
        kind: 'bridge',
        provider: 'anthropic',
        executableRef: 'claude',
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        nativeStdioArgs: null
      }),
      ambientConfigSegments: Object.freeze(['.claude', 'settings.json']),
      repoAgentConfigPaths: Object.freeze([
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.mcp.json',
        'CLAUDE.md',
        '.claude/CLAUDE.md',
        '.claude/skills/',
        '.claude/commands/',
        '.claude/agents/',
        '.claude/hooks/'
      ]),
      supportsGitSideEffects: true,
      supportsAutoCompactOverride: true,
      supportsSessionCompaction: true,
      modelDiscoveryArgs: null,
      unsupportedEffortLevels: Object.freeze([] as const),
      exampleModelPlaceholder: 'claude-3-7-sonnet-20250219'
    }),
    codex: Object.freeze({
      kind: 'codex',
      displayLabel: 'Codex',
      runnerLabel: 'codex-cli',
      cliPathSettingKey: 'codex.path',
      cliPathFieldKey: 'codexPath',
      cliPathDocLabel: 'Codex CLI binary path',
      defaultCliBinary: 'codex',
      usesLegacyFallbackPath: false,
      containmentMechanism: 'codex-sandbox-workspace-write',
      defaultAuditPermissionMode: 'workspace-write',
      confirmedFlags: Object.freeze(['--sandbox']),
      unboundedFlags: Object.freeze(['--sandbox', 'workspace-write']),
      spendDenomination: 'tokens',
      qualifiedCliVersion: '0.159.2',
      acpProfile: Object.freeze({
        profileId: 'codex-acp-bridge',
        revision: 1,
        kind: 'bridge',
        provider: 'openai',
        executableRef: 'codex',
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        nativeStdioArgs: null
      }),
      ambientConfigSegments: Object.freeze(['.codex', 'config.toml']),
      repoAgentConfigPaths: Object.freeze([
        '.codex/config.toml',
        'AGENTS.md',
        'AGENTS.override.md'
      ]),
      supportsGitSideEffects: false,
      supportsAutoCompactOverride: false,
      supportsSessionCompaction: false,
      modelDiscoveryArgs: null,
      unsupportedEffortLevels: Object.freeze([] as const),
      exampleModelPlaceholder: 'model-name'
    }),
    agy: Object.freeze({
      kind: 'agy',
      displayLabel: 'Agy',
      runnerLabel: 'agy-cli',
      cliPathSettingKey: 'agy.path',
      cliPathFieldKey: 'agyPath',
      cliPathDocLabel: 'Agy CLI binary path',
      defaultCliBinary: 'agy',
      usesLegacyFallbackPath: false,
      containmentMechanism: 'none',
      defaultAuditPermissionMode: 'unrestricted',
      confirmedFlags: Object.freeze(['--dangerously-skip-permissions', '--mode', '--sandbox']),
      unboundedFlags: Object.freeze(['--dangerously-skip-permissions']),
      spendDenomination: 'tokens',
      qualifiedCliVersion: '1.4.2',
      acpProfile: Object.freeze({
        profileId: 'agy-acp-native',
        revision: 1,
        kind: 'native',
        provider: 'google',
        executableRef: 'agy',
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        nativeStdioArgs: Object.freeze(['acp', '--stdio', '--disable-telemetry'])
      }),
      ambientConfigSegments: null,
      // Workspace-level Antigravity / Gemini-family config, rules, workflows, and skill trees.
      // Evidence note: `.agents/skills/` is observed in workspace skill loading; `.agents/rules/`,
      // `.agents/workflows/`, `AGENTS.md`, `GEMINI.md`, and `.gemini/settings.json` are included
      // conservatively from Antigravity/Gemini CLI conventions as risk reduction. Agy's full
      // workspace discovery surface is not vendor-documented, so unlisted paths remain a stated
      // limit in `docs/security/threat-model.md`.
      repoAgentConfigPaths: Object.freeze([
        'AGENTS.md',
        'GEMINI.md',
        '.agents/skills/',
        '.agents/rules/',
        '.agents/workflows/',
        '.gemini/settings.json'
      ]),
      supportsGitSideEffects: true,
      supportsAutoCompactOverride: false,
      supportsSessionCompaction: false,
      modelDiscoveryArgs: Object.freeze(['models']),
      unsupportedEffortLevels: Object.freeze(['xhigh', 'max'] as const),
      exampleModelPlaceholder: 'model-name'
    })
  });

/** All backend descriptors in canonical `SUPPORTED_BACKENDS` order. */
export const BACKEND_DESCRIPTOR_LIST: readonly BackendDescriptor[] = Object.freeze(
  SUPPORTED_BACKENDS.map((kind) => BACKEND_DESCRIPTORS[kind])
);

/**
 * Total, unknown-safe lookup by backend identifier.
 *
 * Returns `undefined` for any unrecognized, non-string, blank, or prototype-chain key —
 * NEVER falls back to `'claude'` or `DEFAULT_BACKEND`.
 */
export function findBackendDescriptor(kind: unknown): BackendDescriptor | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(BACKEND_DESCRIPTORS, kind)) return undefined;
  return BACKEND_DESCRIPTORS[kind as BackendRunnerKind];
}

/**
 * Exhaustive lookup for an already-narrowed `BackendRunnerKind`.
 *
 * Still guards with an own-property check at runtime and throws `TypeError` rather than
 * falling back to `'claude'` if an untyped caller passes an invalid value.
 */
export function getBackendDescriptor(kind: BackendRunnerKind): BackendDescriptor {
  const descriptor = findBackendDescriptor(kind);
  if (descriptor === undefined) {
    throw new TypeError(`unknown backend kind "${String(kind)}"`);
  }
  return descriptor;
}

/** Whether `effort` is explicitly unsupported by `kind` (returns `false` for unknown kinds). */
export function isUnsupportedEffortForBackend(kind: unknown, effort: string): boolean {
  const descriptor = findBackendDescriptor(kind);
  if (descriptor === undefined) return false;
  return (descriptor.unsupportedEffortLevels as readonly string[]).includes(effort);
}

/** Build a mutable exhaustive map keyed by `SUPPORTED_BACKENDS` in canonical order. */
export function mapMutableBackends<T>(
  fn: (descriptor: BackendDescriptor) => T
): MutableBackendMap<T> {
  return Object.fromEntries(
    SUPPORTED_BACKENDS.map((kind) => [kind, fn(BACKEND_DESCRIPTORS[kind])])
  ) as MutableBackendMap<T>;
}

/** Build a frozen exhaustive map keyed by `SUPPORTED_BACKENDS` in canonical order. */
export function mapBackends<T>(
  fn: (descriptor: BackendDescriptor) => T
): BackendMap<T> {
  return Object.freeze(mapMutableBackends(fn));
}

const FROZEN_EMPTY_STRINGS: readonly string[] = Object.freeze([]);

/** Frozen empty per-backend model map (`{ claude: [], codex: [], agy: [] }`). */
export const EMPTY_BACKEND_MODELS: BackendMap<readonly string[]> = mapBackends(
  () => FROZEN_EMPTY_STRINGS
);

/** Returns the shared frozen empty per-backend model map. */
export function emptyBackendModels(): BackendMap<readonly string[]> {
  return EMPTY_BACKEND_MODELS;
}
