/**
 * Feature 018 — Per-tab description map for GeneralSettingsTab.
 *
 * Colocation rationale (FR-012, FR-019):
 *   - Descriptions live next to the component they describe so any
 *     additive control change is one PR diff, not two.
 *   - Removing a member from `GeneralSettingsControlId` without removing
 *     its entry in `GENERAL_SETTINGS_DESCRIPTIONS` (or vice versa) is a
 *     typecheck failure thanks to the mapped-type `satisfies` annotation
 *     on the const.
 *   - The structural test at
 *     `webview-ui/src/components/settings/__tests__/hover-text-coverage.test.ts`
 *     mounts the tab and asserts every focusable element has either an
 *     inline `<p id="desc-…">` or a hover-text anchored popover.
 *
 * Body length policy (FR-002):
 *   - body ≤ 80 chars → renders inline beneath the control.
 *   - body  > 80 chars → renders as a hover/focus popover anchored to
 *     the control itself.
 *   - The 80-char cutoff is enforced by the HoverText primitive at
 *     render time — authors do not pick the surface, content length does.
 *
 * FR-013 coverage:
 *   - For controls that can be rendered in a disabled state (per-field
 *     Save/Reset, Save All, Reset All) the body MUST explain WHY they
 *     are disabled and what the operator can do to re-enable them.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type GeneralSettingsControlId =
  | 'tab-header'
  | 'cliPath'
  | 'cliPath-save'
  | 'cliPath-reset'
  | 'loggingVerbose'
  | 'loggingVerbose-save'
  | 'loggingVerbose-reset'
  | 'loopMaxIterations'
  | 'loopMaxIterations-save'
  | 'loopMaxIterations-reset'
  | 'invocationTimeoutSeconds'
  | 'invocationTimeoutSeconds-save'
  | 'invocationTimeoutSeconds-reset'
  | 'watchdogPollIntervalMinutes'
  | 'watchdogPollIntervalMinutes-save'
  | 'watchdogPollIntervalMinutes-reset'
  | 'auditRotationSizeMB'
  | 'auditRotationSizeMB-save'
  | 'auditRotationSizeMB-reset'
  | 'auditRotationMaxAgeDays'
  | 'auditRotationMaxAgeDays-save'
  | 'auditRotationMaxAgeDays-reset'
  | 'defaultPipelineId'
  | 'defaultPipelineId-save'
  | 'defaultPipelineId-reset'
  | 'claudeAutoCompactPctOverride'
  | 'claudeAutoCompactPctOverride-save'
  | 'claudeAutoCompactPctOverride-reset'
  | 'runtimeLogLevel'
  | 'runtimeLogLevel-save'
  | 'runtimeLogLevel-reset'
  | 'runtimeLogFilePath'
  | 'runtimeLogFilePath-save'
  | 'runtimeLogFilePath-reset'
  | 'sessionRetentionMaxAgeDays'
  | 'sessionRetentionMaxAgeDays-save'
  | 'sessionRetentionMaxAgeDays-reset'
  | 'sessionRetentionMaxBytes'
  | 'sessionRetentionMaxBytes-save'
  | 'sessionRetentionMaxBytes-reset'
  | 'backend-ping'
  | 'save-all'
  | 'reset-all';

export const GENERAL_SETTINGS_DESCRIPTIONS = {
  'tab-header': {
    title: 'General Settings',
    body:
      "Scalar workspace settings backed by VS Code's configuration store. " +
      'Workspace-scope edits override user-scope, which override defaults. ' +
      'Edits are local drafts until you click Save; click Reset to discard.'
  },

  cliPath: {
    title: 'CLI path',
    body:
      'Absolute or PATH-resolvable path to the `claude` binary. Leave the ' +
      'default `claude` to use whatever resolves on the system PATH.'
  },
  'cliPath-save': {
    title: 'Save CLI path',
    body:
      'Persist this field to VS Code workspace settings. Disabled until you ' +
      'change the value — type an edit first, then click Save.'
  },
  'cliPath-reset': {
    title: 'Reset CLI path',
    body:
      'Discard the unsaved edit on this field and restore the projected ' +
      'value. Disabled when there are no unsaved changes on this field.'
  },

  loggingVerbose: {
    title: 'Verbose logging',
    body:
      'Capture unredacted per-iteration diagnostics under ' +
      '`.schegent/sessions/<runId>/diagnostics/`. Useful for support; the ' +
      'structured `.schegent/audit.log` remains sanitized either way.'
  },
  'loggingVerbose-save': {
    body:
      'Save this toggle. Disabled until the value differs from the saved ' +
      'projection — flip the checkbox first.'
  },
  'loggingVerbose-reset': {
    body:
      'Restore the projected verbose-logging value. Disabled when there ' +
      'are no unsaved changes on this field.'
  },

  loopMaxIterations: {
    title: 'Loop max iterations',
    body:
      'Maximum recursive iterations per loopable phase (1–100). The runner ' +
      'aborts the phase as a fatal error if this limit is reached without ' +
      'a clean exit.'
  },
  'loopMaxIterations-save': {
    body:
      'Save the loop iteration cap. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'loopMaxIterations-reset': {
    body:
      'Restore the projected loop iteration cap. Disabled when there are ' +
      'no unsaved changes on this field.'
  },

  invocationTimeoutSeconds: {
    title: 'Invocation timeout (seconds)',
    body:
      'Maximum wall-clock duration for a single CLI invocation (60–7200). ' +
      'The runner aborts the phase as a fatal error if any single call ' +
      'exceeds this budget.'
  },
  'invocationTimeoutSeconds-save': {
    body:
      'Save the invocation timeout. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'invocationTimeoutSeconds-reset': {
    body:
      'Restore the projected invocation timeout. Disabled when there are ' +
      'no unsaved changes on this field.'
  },

  watchdogPollIntervalMinutes: {
    title: 'Watchdog poll interval (minutes)',
    body:
      'How often the watchdog re-checks a paused run (1–240). Shorter ' +
      'intervals resume sooner after a manual unpause; longer intervals ' +
      'reduce idle CPU.'
  },
  'watchdogPollIntervalMinutes-save': {
    body:
      'Save the watchdog poll interval. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'watchdogPollIntervalMinutes-reset': {
    body:
      'Restore the projected poll interval. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  auditRotationSizeMB: {
    title: 'Audit rotation size (MB)',
    body:
      'Rotate the structured audit log when it exceeds this size (1–100 MB). ' +
      'Rotation moves the old file to `.schegent/audit.<N>.log` and starts a ' +
      'fresh one.'
  },
  'auditRotationSizeMB-save': {
    body:
      'Save the rotation size threshold. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'auditRotationSizeMB-reset': {
    body:
      'Restore the projected rotation size. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  auditRotationMaxAgeDays: {
    title: 'Audit retention (days)',
    body:
      'Delete rotated audit log files older than this many days (1–365). ' +
      'Only files matching `.schegent/audit.*.log` are affected.'
  },
  'auditRotationMaxAgeDays-save': {
    body:
      'Save the audit retention period. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'auditRotationMaxAgeDays-reset': {
    body:
      'Restore the projected retention period. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  defaultPipelineId: {
    title: 'Default pipeline',
    body:
      'Pipeline used when /speckit-auto runs without an explicit selection. ' +
      'The list reflects pipelines discovered in `schegent.pipelines`.'
  },
  'defaultPipelineId-save': {
    body:
      'Save the default pipeline selection. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'defaultPipelineId-reset': {
    body:
      'Restore the projected default pipeline. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  claudeAutoCompactPctOverride: {
    title: 'Claude auto-compaction threshold (%)',
    body:
      'When set (1–100), exported as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to the ' +
      'Claude CLI subprocess so it compacts earlier. Leave the field empty ' +
      'to use the CLI default.'
  },
  'claudeAutoCompactPctOverride-save': {
    body:
      'Save the auto-compaction threshold. Disabled until the value differs ' +
      'from the saved projection; an empty input clears the override.'
  },
  'claudeAutoCompactPctOverride-reset': {
    body:
      'Restore the projected auto-compaction threshold. Disabled when there ' +
      'are no unsaved changes on this field.'
  },

  runtimeLogLevel: {
    title: 'Runtime log level',
    body:
      'Default: INFO. Selects which records are written to the runtime log ' +
      'file. DEBUG includes all records; ERROR includes only error records. ' +
      'Independent of the Verbose Logging toggle above. Takes effect on the ' +
      'next log emission — no reload required.'
  },
  'runtimeLogLevel-save': {
    body:
      'Save the runtime log level. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'runtimeLogLevel-reset': {
    body:
      'Restore the projected runtime log level. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  runtimeLogFilePath: {
    title: 'Runtime log file path',
    body:
      'Default: <workspace>/.schegent/syslog. Where the runtime log file is ' +
      'written. Leave blank to use the default. Accepts an absolute path or ' +
      'a workspace-relative path. Relative paths with `..` are rejected for ' +
      'safety. Secret patterns are redacted before write. Failed writes are ' +
      'suppressed until you save this setting again.'
  },
  'runtimeLogFilePath-save': {
    body:
      'Save the runtime log file path. Disabled until the value differs ' +
      'from the saved projection; an empty input restores the default ' +
      '<workspace>/.schegent/syslog location.'
  },
  'runtimeLogFilePath-reset': {
    body:
      'Restore the projected runtime log file path. Disabled when there ' +
      'are no unsaved changes on this field.'
  },

  sessionRetentionMaxAgeDays: {
    title: 'Unredacted session retention age',
    body:
      'Complete inactive raw transcripts and verbose diagnostics older than ' +
      'this many days are removed. Active runs and audit.log are never pruned.'
  },
  'sessionRetentionMaxAgeDays-save': {
    body:
      'Save the session-artifact age limit. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'sessionRetentionMaxAgeDays-reset': {
    body:
      'Restore the projected session-artifact age limit. Disabled when there ' +
      'are no unsaved changes on this field.'
  },

  sessionRetentionMaxBytes: {
    title: 'Unredacted session byte budget',
    body:
      'Total byte budget for raw transcripts and verbose diagnostics. The ' +
      'oldest complete inactive runs are removed first; active runs and ' +
      'audit.log are protected.'
  },
  'sessionRetentionMaxBytes-save': {
    body:
      'Save the session-artifact byte budget. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'sessionRetentionMaxBytes-reset': {
    body:
      'Restore the projected session-artifact byte budget. Disabled when ' +
      'there are no unsaved changes on this field.'
  },

  'backend-ping': {
    title: 'Ping backend',
    body:
      'Run a bounded host-side CLI availability probe. The command carries ' +
      'only the backend identity; configured paths and process output never reach the webview.'
  },

  'save-all': {
    title: 'Save all changes',
    body:
      'Save every modified field in a single transactional write — if any ' +
      'value fails validation, none are written. Disabled when no fields ' +
      'have unsaved changes.'
  },
  'reset-all': {
    title: 'Reset all',
    body:
      'Discard every unsaved edit across all fields and restore the ' +
      'projected configuration. Disabled when no fields have unsaved changes.'
  }
} as const satisfies { readonly [K in GeneralSettingsControlId]: ControlDescription };
