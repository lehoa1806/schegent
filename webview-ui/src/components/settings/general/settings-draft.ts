// FR-R3-143 (T033) — the pure half of the general settings tab: everything that
// is a function of (projection, draft) and of nothing reactive.
//
// WHY IT IS A SEPARATE MODULE. `GeneralSettingsTab.svelte` crossed the 500-line
// component budget (`tests/lint/svelte-component-loc-budget.test.ts`) once this
// feature added six settings and their groups. The budget is a decomposition
// prompt, and this is the seam it points at: the tab owns reactive state — the
// draft, the per-key status map, the effect that re-syncs against the
// projection — while the functions below own none of it. They took their inputs
// as arguments already; they were simply written inside a component.
//
// WHAT DELIBERATELY DID NOT MOVE. The `FIELDS` arrays stay in `.svelte`. Their
// `key:`/`ipcKey:` literals are the entire evidence base of the settings
// coverage gate (`tests/integration/settings-surface.integration.test.ts:252`),
// which scans `.svelte` files under the settings root and nothing else; moving
// them into a `.ts` module would empty that gate while every test still passed.
// `field-types.ts` records the same constraint for the same reason.

import type { GeneralSettings } from '../../../lib/snapshot-types';
import type { Draft, ScalarKey } from './field-types';

/** Human-readable byte size for the session-artifact usage line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Project the saved settings into a fresh editable draft.
 *
 * The draft is kept separate from the projection so a key is committed only on
 * Save — an operator can revert by reloading without saving.
 */
export function snapshotToDraft(s: GeneralSettings): Draft {
  return {
    cliPath: s.cliPath,
    codexPath: s.codexPath,
    agyPath: s.agyPath,
    loggingVerbose: s.loggingVerbose,
    loopMaxIterations: s.loopMaxIterations,
    invocationIdleTimeoutSeconds: s.invocationIdleTimeoutSeconds,
    invocationMaxDurationSeconds: s.invocationMaxDurationSeconds,
    watchdogPollIntervalMinutes: s.watchdogPollIntervalMinutes,
    auditRotationSizeMB: s.auditRotationSizeMB,
    auditRotationMaxAgeDays: s.auditRotationMaxAgeDays,
    defaultPipelineId: s.defaultPipelineId,
    claudeAutoCompactPctOverride: s.claudeAutoCompactPctOverride ?? null,
    runtimeLogLevel: s.runtimeLogLevel,
    runtimeLogFilePath: s.runtimeLogFilePath,
    sessionRetentionMaxAgeDays: s.sessionRetentionMaxAgeDays,
    sessionRetentionMaxBytes: s.sessionRetentionMaxBytes,
    rawTranscriptMode: s.rawTranscriptMode,
    retryMaxAttempts: s.retryMaxAttempts,
    retryForceContinueOnCap: s.retryForceContinueOnCap,
    runtimeLogMaxBytes: s.runtimeLogMaxBytes,
    runtimeLogMaxGenerations: s.runtimeLogMaxGenerations,
    cliInheritEnvironment: s.cliInheritEnvironment,
    cliEnvironmentMode: s.cliEnvironmentMode,
    // FR-R3-143 (T030) — a COPY. The projection's array is frozen, and the
    // list editor assigns a new array on every edit; aliasing it here would
    // make the draft and the "changed" comparison the same object.
    cliEnvironmentAllowlist: [...s.cliEnvironmentAllowlist],
    backendProbeTimeoutSeconds: s.backendProbeTimeoutSeconds,
    uiConfirmationsEnable: s.uiConfirmationsEnable,
    multiRootSuppressWarning: s.multiRootSuppressWarning
  };
}

/** Whether the drafted value for `key` diverges from what is saved. */
export function isFieldChanged(
  key: ScalarKey,
  draft: Draft,
  current: GeneralSettings
): boolean {
  const drafted = draft[key];
  const projected = current[key] as unknown;
  // Feature 012: treat null draft == undefined projection as unchanged.
  if (key === 'claudeAutoCompactPctOverride') {
    return (drafted ?? null) !== (projected ?? null);
  }
  // FR-R3-143 (T030) — the draft holds a copy of the projected array, so `!==`
  // is true the moment the tab mounts: every row would show as changed, Save
  // All would post an unedited allowlist, and Reset All would never disable.
  // Element-wise for the one array-valued field.
  if (Array.isArray(drafted) || Array.isArray(projected)) {
    const a = Array.isArray(drafted) ? drafted : [];
    const b = Array.isArray(projected) ? projected : [];
    return a.length !== b.length || a.some((item, i) => item !== b[i]);
  }
  return drafted !== projected;
}

/**
 * The settings layer `key` was resolved from, capitalised for display.
 *
 * `scopes` is read as a `Partial`, and the `Unknown` fallback is kept, because
 * this object arrives over IPC from a host bundle that may be older than this
 * webview: `GeneralSettings` declares every scope required, and a host that
 * predates a key simply does not send it. Without the guard `scope.charAt(0)`
 * throws and takes the whole Settings tab down over a missing label.
 *
 * The `Partial` cast is what makes that guard type-honest — the previous
 * `current.scopes?.[key]` said the same thing in a form the compiler read as
 * dead code, which is how `@typescript-eslint/no-unnecessary-condition` came to
 * flag a live runtime check.
 */
export function scopeLabelFor(key: ScalarKey, current: GeneralSettings): string {
  const scopes: Partial<GeneralSettings['scopes']> = current.scopes;
  const scope = scopes[key];
  if (scope === undefined) return 'Unknown';
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

/**
 * Wire-format IPC key. Feature 012 uses dotted names like
 * `claude.autoCompactPctOverride`; where the two coincide, `key` is the wire name.
 */
export function ipcKeyFor(spec: { readonly key: ScalarKey; readonly ipcKey?: string }): string {
  return spec.ipcKey ?? spec.key;
}

/**
 * Map rejection reasons (Feature 012 T026) to user-friendly messages for
 * `claude.autoCompactPctOverride`. Other keys keep the raw reason.
 */
export function friendlyReason(
  spec: { readonly key: ScalarKey },
  reason?: string
): string | undefined {
  if (!reason) return reason;
  if (spec.key !== 'claudeAutoCompactPctOverride') return reason;
  if (reason.startsWith('out-of-range:')) return 'Value must be an integer between 1 and 100';
  if (reason.startsWith('type-mismatch:')) return 'Value must be a whole number';
  if (reason.startsWith('clear-failed:')) return 'Failed to clear override — please retry';
  return reason;
}
