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
  | 'codexPath'
  | 'codexPath-save'
  | 'codexPath-reset'
  | 'agyPath'
  | 'agyPath-save'
  | 'agyPath-reset'
  | 'loggingVerbose'
  | 'loggingVerbose-save'
  | 'loggingVerbose-reset'
  | 'loopMaxIterations'
  | 'loopMaxIterations-save'
  | 'loopMaxIterations-reset'
  | 'invocationIdleTimeoutSeconds'
  | 'invocationIdleTimeoutSeconds-save'
  | 'invocationIdleTimeoutSeconds-reset'
  | 'invocationMaxDurationSeconds'
  | 'invocationMaxDurationSeconds-save'
  | 'invocationMaxDurationSeconds-reset'
  | 'watchdogPollIntervalMinutes'
  | 'watchdogPollIntervalMinutes-save'
  | 'watchdogPollIntervalMinutes-reset'
  | 'auditRotationSizeMB'
  | 'auditRotationSizeMB-save'
  | 'auditRotationSizeMB-reset'
  | 'auditRotationMaxAgeDays'
  | 'auditRotationMaxAgeDays-save'
  | 'auditRotationMaxAgeDays-reset'
  // FR-R3-143 (T012, T013) — four keys the IPC already accepted, now drawn.
  | 'retryMaxAttempts'
  | 'retryMaxAttempts-save'
  | 'retryMaxAttempts-reset'
  | 'retryForceContinueOnCap'
  | 'retryForceContinueOnCap-save'
  | 'retryForceContinueOnCap-reset'
  | 'runtimeLogMaxBytes'
  | 'runtimeLogMaxBytes-save'
  | 'runtimeLogMaxBytes-reset'
  | 'runtimeLogMaxGenerations'
  | 'runtimeLogMaxGenerations-save'
  | 'runtimeLogMaxGenerations-reset'
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
  | 'rawTranscriptMode'
  | 'rawTranscriptMode-save'
  | 'rawTranscriptMode-reset'
  // FR-R3-143 (T033) — the six the manifest declared and no surface could
  // reach. `cliEnvironmentAllowlist` carries two extra ids because it is the
  // one list-valued field: its editor has an Add button and a Remove button
  // per row, and every focusable control needs a description
  // (`__tests__/hover-text-coverage.test.ts`).
  | 'cliInheritEnvironment'
  | 'cliInheritEnvironment-save'
  | 'cliInheritEnvironment-reset'
  | 'cliEnvironmentMode'
  | 'cliEnvironmentMode-save'
  | 'cliEnvironmentMode-reset'
  | 'cliEnvironmentAllowlist'
  | 'cliEnvironmentAllowlist-save'
  | 'cliEnvironmentAllowlist-reset'
  | 'cliEnvironmentAllowlist-add'
  | 'cliEnvironmentAllowlist-remove'
  | 'backendProbeTimeoutSeconds'
  | 'backendProbeTimeoutSeconds-save'
  | 'backendProbeTimeoutSeconds-reset'
  | 'uiConfirmationsEnable'
  | 'uiConfirmationsEnable-save'
  | 'uiConfirmationsEnable-reset'
  | 'multiRootSuppressWarning'
  | 'multiRootSuppressWarning-save'
  | 'multiRootSuppressWarning-reset'
  // FR-R3-143 (T039) — the two read-only trust disclosures. Only the affordance
  // carries a description key: the disclosure's own text is static prose, not a
  // control, so it has no `-save`/`-reset` pair to explain.
  | 'trust-phases-open-settings'
  | 'trust-retryConditions-open-settings'
  | 'backend-ping'
  // FR-R3-144 (T031, T036, T034) — the backend selector, both per-run spend
  // bounds, and the uncontained grant. The grant carries no `-save`/`-reset` pair
  // because it is not a draft field: it writes through its own IPC command the
  // moment it is confirmed, which is why the confirmation exists.
  | 'backendRunner'
  | 'backendRunner-save'
  | 'backendRunner-reset'
  | 'spendMaxUsdPerRun'
  | 'spendMaxUsdPerRun-save'
  | 'spendMaxUsdPerRun-reset'
  | 'spendMaxTokensPerRun'
  | 'spendMaxTokensPerRun-save'
  | 'spendMaxTokensPerRun-reset'
  | 'backend-grant'
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

  codexPath: {
    title: 'Codex CLI path',
    body:
      'Absolute or PATH-resolvable path to the `codex` binary. Leave the ' +
      'default `codex` to use whatever resolves on the system PATH.'
  },
  'codexPath-save': {
    title: 'Save Codex CLI path',
    body:
      'Persist this field to VS Code workspace settings. Disabled until you ' +
      'change the value — type an edit first, then click Save.'
  },
  'codexPath-reset': {
    title: 'Reset Codex CLI path',
    body:
      'Discard the unsaved edit on this field and restore the projected ' +
      'value. Disabled when there are no unsaved changes on this field.'
  },

  agyPath: {
    title: 'Agy CLI path',
    body:
      'Absolute or PATH-resolvable path to the `agy` binary. Leave the ' +
      'default `agy` to use whatever resolves on the system PATH.'
  },
  'agyPath-save': {
    title: 'Save Agy CLI path',
    body:
      'Persist this field to VS Code workspace settings. Disabled until you ' +
      'change the value — type an edit first, then click Save.'
  },
  'agyPath-reset': {
    title: 'Reset Agy CLI path',
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
  rawTranscriptMode: {
    title: 'Raw transcript retention',
    body: 'Choose whether new runs retain unredacted transcripts always, only when interrupted or unsuccessful, or never. The choice is frozen for each run.'
  },
  'rawTranscriptMode-save': {
    body: 'Save this raw-transcript policy for future runs. Active and paused runs keep the policy frozen when they were created.'
  },
  'rawTranscriptMode-reset': {
    body: 'Restore the projected raw-transcript policy. This control stays disabled when there are no unsaved changes to discard.'
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
      'Maximum recursive iterations per loopable phase (1–50). The runner ' +
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

  invocationIdleTimeoutSeconds: {
    title: 'Invocation idle timeout (seconds)',
    body:
      'Idle window for a single CLI invocation (60–7200): the runner ' +
      'terminates the phase after this long with no output. Output resets ' +
      'the window, so a streaming phase runs on — the max duration below is ' +
      'what bounds it.'
  },
  'invocationIdleTimeoutSeconds-save': {
    body:
      'Save the idle timeout. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'invocationIdleTimeoutSeconds-reset': {
    body:
      'Restore the projected idle timeout. Disabled when there are ' +
      'no unsaved changes on this field.'
  },

  invocationMaxDurationSeconds: {
    title: 'Invocation max duration (seconds)',
    body:
      'Absolute wall-clock bound for a single CLI invocation (60–86400), ' +
      'armed at spawn and never reset — a chatty child that keeps emitting ' +
      'output cannot extend it. Terminations under this bound are recorded ' +
      'as deadline, distinct from an idle timeout.'
  },
  'invocationMaxDurationSeconds-save': {
    body:
      'Save the max duration. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'invocationMaxDurationSeconds-reset': {
    body:
      'Restore the projected max duration. Disabled when there are ' +
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
      // Feature 099 (T494a, FR-054) — the retired Pipeline settings key is
      // deleted, not drained. The list is the Pipeline catalog the store holds.
      'Pipeline used when /speckit-auto runs without an explicit selection. ' +
      'The list reflects the Pipelines in the catalog.'
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

  // FR-R3-144 (T031) — the setting the whole item turns on.
  backendRunner: {
    title: 'Backend',
    body:
      'Which CLI Schegent invokes for every task. Applies to every workspace on ' +
      'this machine, and takes effect on the next invocation — a run already in ' +
      'flight finishes on the backend it started with. Each backend reports spend ' +
      'in its own denomination and carries its own containment, both shown below.'
  },
  'backendRunner-save': {
    title: 'Save backend',
    body:
      'Persist the selected backend to your user settings. Disabled until you ' +
      'change the selection.'
  },
  'backendRunner-reset': {
    body:
      'Restore the backend currently in force. Disabled when there are no unsaved ' +
      'changes on this field.'
  },

  // FR-R3-144 (T036) — one key per denomination; the tab offers the one that
  // matches the selected backend, because a bound in a denomination the backend
  // never reports is a bound that silently does nothing.
  spendMaxUsdPerRun: {
    title: 'Per-run spend bound (USD)',
    body:
      'Pause a run once its reported cost crosses this many US dollars. It pauses ' +
      'and never fails or cancels: you can resume, and the accounting continues ' +
      'from where it stopped. Leave it empty for no bound. Applies to backends ' +
      'that report a cost.'
  },
  'spendMaxUsdPerRun-save': {
    title: 'Save spend bound',
    body:
      'Persist this per-run dollar bound. Disabled until you change the value. ' +
      'Clearing the field saves "no bound".'
  },
  'spendMaxUsdPerRun-reset': {
    body:
      'Restore the projected dollar bound. Disabled when there are no unsaved ' +
      'changes on this field.'
  },
  spendMaxTokensPerRun: {
    title: 'Per-run spend bound (tokens)',
    body:
      'Pause a run once its reported token usage crosses this count. It pauses ' +
      'and never fails or cancels: you can resume, and the accounting continues ' +
      'from where it stopped. Leave it empty for no bound. Applies to backends ' +
      'that report tokens and no cost.'
  },
  'spendMaxTokensPerRun-save': {
    title: 'Save spend bound',
    body:
      'Persist this per-run token bound. Disabled until you change the value. ' +
      'Clearing the field saves "no bound".'
  },
  'spendMaxTokensPerRun-reset': {
    body:
      'Restore the projected token bound. Disabled when there are no unsaved ' +
      'changes on this field.'
  },

  // FR-R3-144 (T034) — the grant, and what granting it actually means. The
  // sentence the operator sees BEFORE writing is the enforcement's own refusal,
  // carried by the posture projection; this is the standing explanation of the
  // control itself.
  'backend-grant': {
    title: 'Uncontained permission',
    body:
      'Allow this backend to run even though the platform enforces no sandbox for ' +
      'it. The permission is per backend, is stored in your settings, and can be ' +
      'revoked here at any time — revoking takes effect on the next invocation. ' +
      'Without it the run is refused before the process starts, which is what the ' +
      'sentence beside this button says.'
  },

  'trust-phases-open-settings': {
    title: 'Change in Settings',
    body:
      'Opens the VS Code Settings editor filtered to the Schegent trust keys. This tab ' +
      'shows the resolved value but cannot change it: the capability is decided against ' +
      'Workspace Trust and can be denied from your user settings, which this tab has no ' +
      'way to write. The editor can target either layer.'
  },
  'trust-retryConditions-open-settings': {
    body:
      'Opens the VS Code Settings editor filtered to the Schegent trust keys, the same ' +
      'destination as the button above — both keys are edited on that one surface.'
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
  },
  // FR-R3-143 (T012) — retry.
  retryMaxAttempts: {
    title: 'Retry max attempts',
    body:
      'How many delayed-retry attempts a phase gets before the Run and its ' +
      'Queue pause (1–5). Retries cannot be switched off here: the lowest ' +
      'accepted value is 1, and the first attempt is not counted as a retry.'
  },
  'retryMaxAttempts-save': {
    body:
      'Save the retry attempt limit. Disabled until the value differs from ' +
      'the saved projection.'
  },
  'retryMaxAttempts-reset': {
    body: 'Restore the projected retry attempt limit. Disabled when there are no unsaved edits.'
  },
  retryForceContinueOnCap: {
    title: 'Continue past retry cap',
    body:
      'When a phase reaches its last allowed iteration with its retry condition ' +
      'still truthy, advance instead of halting, and record a forced-continue ' +
      'runtime event. This is the workspace default only — a Phase definition ' +
      'overrides it — and it does not carry a failure forward: failed and ' +
      'timed-out outcomes stay terminal.'
  },
  'retryForceContinueOnCap-save': {
    body:
      'Save whether a run continues past the retry cap. Disabled until the ' +
      'value differs from the saved projection.'
  },
  'retryForceContinueOnCap-reset': {
    body: 'Restore the projected setting. Disabled when there are no unsaved edits.'
  },
  // FR-R3-143 (T013) — runtime log rotation.
  runtimeLogMaxBytes: {
    title: 'Runtime log rotation size (bytes)',
    body:
      'Rotate the runtime debug log once it reaches this size (1 MiB–1 GiB). ' +
      'Rotation is by size only; there is no time-based trigger.'
  },
  'runtimeLogMaxBytes-save': {
    body:
      'Save the rotation size. Disabled until the value differs from the ' +
      'saved projection.'
  },
  'runtimeLogMaxBytes-reset': {
    body: 'Restore the projected rotation size. Disabled when there are no unsaved edits.'
  },
  runtimeLogMaxGenerations: {
    title: 'Runtime logs kept',
    body:
      'How many numbered runtime-log generations to keep (0–20). The oldest is ' +
      'deleted once the count is exceeded. Zero opts out of rotation entirely: ' +
      'the log is truncated in place, so its earlier contents are gone.'
  },
  'runtimeLogMaxGenerations-save': {
    body:
      'Save how many rotated logs are kept. Disabled until the value differs ' +
      'from the saved projection.'
  },
  'runtimeLogMaxGenerations-reset': {
    body: 'Restore the projected count. Disabled when there are no unsaved edits.'
  },

  // FR-R3-143 (T031) — process environment and backend probing. These four are
  // `application`-scoped: they are saved to User settings and apply to every
  // workspace this installation opens, which each body says outright. The
  // three environment ones are read once, at activation
  // (`src/activation/workspace-settings.ts:50`), and threaded by value into
  // every consumer — hence the reload sentence. `backend.probeTimeoutSeconds`
  // is read through a callback at probe time
  // (`src/activation/backend-wiring.ts:59`), so it deliberately says the
  // opposite. Getting either one backwards is how an operator concludes a
  // setting does not work.
  cliInheritEnvironment: {
    title: 'Inherit the extension host environment (legacy)',
    body:
      'Superseded by Environment Mode below, and kept because existing settings ' +
      'still carry it: setting it Off forces `minimal` regardless of the mode. ' +
      'Leave it On unless you are deliberately reproducing the old behaviour. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
  },
  'cliInheritEnvironment-save': {
    body:
      'Save this toggle to User settings, for every workspace on this machine. ' +
      'Disabled until the value differs from the saved projection — flip the ' +
      'checkbox first.'
  },
  'cliInheritEnvironment-reset': {
    body:
      'Restore the projected value of the legacy inherit toggle. Disabled when ' +
      'there are no unsaved changes on this field.'
  },

  cliEnvironmentMode: {
    title: 'Environment mode',
    body:
      'What the backend CLI subprocess inherits. `allowlist` (the default) ' +
      'forwards the required PATH/home/temp/locale bootstrap variables plus the ' +
      'names listed below; `minimal` forwards only Schegent-controlled ' +
      'variables; `inherit` forwards the whole extension-host environment, ' +
      'including any ambient cloud, registry and signing credentials in it. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
  },
  'cliEnvironmentMode-save': {
    body:
      'Save the environment mode to User settings, for every workspace on this ' +
      'machine. Disabled until the value differs from the saved projection.'
  },
  'cliEnvironmentMode-reset': {
    body:
      'Restore the projected environment mode. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  cliEnvironmentAllowlist: {
    title: 'Environment allowlist',
    body:
      'Variable NAMES to forward when the mode is `allowlist` — values are read ' +
      'from the extension host at spawn time and are never stored in this ' +
      'setting. Add `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` or `ANTHROPIC_API_KEY` ' +
      'here if your setup needs them. Type a name and press Enter or click Add. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
  },
  'cliEnvironmentAllowlist-save': {
    body:
      'Save the allowlist to User settings, for every workspace on this machine. ' +
      'Disabled until the list differs from the saved projection — add or remove ' +
      'a name first.'
  },
  'cliEnvironmentAllowlist-reset': {
    body:
      'Discard the added and removed names and restore the projected allowlist. ' +
      'Disabled when there are no unsaved changes on this field.'
  },
  'cliEnvironmentAllowlist-add': {
    body:
      'Add the typed name to the draft list. Names must match the shape a shell ' +
      'accepts — letters, digits and underscores, not starting with a digit — ' +
      'because a name that does not is dropped silently at spawn time. Nothing ' +
      'is persisted until you click Save.'
  },
  'cliEnvironmentAllowlist-remove': {
    body:
      'Remove this name from the draft list; the variable stops being forwarded ' +
      'to backend CLIs once you save. The removal is not persisted until you ' +
      'click Save, and Reset restores the projected list.'
  },

  backendProbeTimeoutSeconds: {
    title: 'Backend probe timeout (seconds)',
    body:
      'How long a backend availability probe may run before it is treated as ' +
      'unavailable (1–30). Raise it on a slow filesystem or a cold network ' +
      'mount. Applies to every workspace on this machine, and is read at the ' +
      'start of each probe — the next Ping uses the new value, with no reload.'
  },
  'backendProbeTimeoutSeconds-save': {
    body:
      'Save the probe timeout to User settings, for every workspace on this ' +
      'machine. Disabled until the value differs from the saved projection.'
  },
  'backendProbeTimeoutSeconds-reset': {
    body:
      'Restore the projected probe timeout. Disabled when there are no unsaved ' +
      'changes on this field.'
  },

  // FR-R3-143 (T032) — two `window`-scoped settings, saved to this workspace.
  uiConfirmationsEnable: {
    title: 'Confirmation prompts',
    body:
      'Ask before destructive actions such as clearing the queue or deleting a ' +
      'definition. Turning this Off removes those prompts, so the action happens ' +
      'on the first click. Saved for this workspace, and applied to the next ' +
      'confirmation — no reload.'
  },
  'uiConfirmationsEnable-save': {
    body:
      'Save this toggle to workspace settings. Disabled until the value differs ' +
      'from the saved projection — flip the checkbox first.'
  },
  'uiConfirmationsEnable-reset': {
    body:
      'Restore the projected confirmation setting. Disabled when there are no ' +
      'unsaved changes on this field.'
  },

  multiRootSuppressWarning: {
    title: 'Suppress the multi-root warning',
    body:
      'Stop the one-per-activation notice that a multi-root workspace is open ' +
      'and only the canonical folder is used. The warning is emitted once during ' +
      'activation, so this takes effect the next time the window is opened or ' +
      'the Extension Host reloads. Saved for this workspace.'
  },
  'multiRootSuppressWarning-save': {
    body:
      'Save this toggle to workspace settings. Disabled until the value differs ' +
      'from the saved projection — flip the checkbox first.'
  },
  'multiRootSuppressWarning-reset': {
    body:
      'Restore the projected suppression setting. Disabled when there are no ' +
      'unsaved changes on this field.'
  },
} as const satisfies { readonly [K in GeneralSettingsControlId]: ControlDescription };
