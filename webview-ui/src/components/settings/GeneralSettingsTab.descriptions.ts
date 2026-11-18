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
 *   - For controls that can be rendered in a disabled state the body MUST
 *     explain WHY they are disabled and what the operator can do to
 *     re-enable them. The fields have no Save or Reset of their own: the
 *     page header's Save and Revert write and discard every field, and
 *     their bodies are in `SettingsPageHeader.descriptions.ts`.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type GeneralSettingsControlId =
  | 'cliPath'
  | 'codexPath'
  | 'agyPath'
  | 'loggingVerbose'
  | 'loopMaxIterations'
  | 'invocationIdleTimeoutSeconds'
  | 'invocationMaxDurationSeconds'
  | 'watchdogPollIntervalMinutes'
  | 'auditRotationSizeMB'
  | 'auditRotationMaxAgeDays'
  // FR-R3-143 (T012, T013) — four keys the IPC already accepted, now drawn.
  | 'retryMaxAttempts'
  | 'retryForceContinueOnCap'
  | 'runtimeLogMaxBytes'
  | 'runtimeLogMaxGenerations'
  | 'defaultWorkflowId'
  | 'claudeAutoCompactPctOverride'
  | 'runtimeLogLevel'
  | 'runtimeLogFilePath'
  | 'sessionRetentionMaxAgeDays'
  | 'sessionRetentionMaxBytes'
  | 'rawTranscriptMode'
  // FR-R4-F04 (FR-001) — the transport capture mode.
  | 'transportCaptureMode'
  // FR-R3-143 (T033) — the six the manifest declared and no surface could
  // reach. `cliEnvironmentAllowlist` carries two extra ids because it is the
  // one list-valued field: its editor has an Add button and a Remove button
  // per row, and every focusable control needs a description
  // (`__tests__/hover-text-coverage.test.ts`).
  | 'cliInheritEnvironment'
  | 'cliEnvironmentMode'
  | 'cliEnvironmentAllowlist'
  | 'cliEnvironmentAllowlist-add'
  | 'cliEnvironmentAllowlist-remove'
  | 'backendProbeTimeoutSeconds'
  | 'uiConfirmationsEnable'
  | 'multiRootSuppressWarning'
  // FR-R3-143 (T039) — the two read-only trust disclosures. Only the affordance
  // carries a description key: the disclosure's own text is static prose, not a
  // control.
  | 'trust-phases-open-settings'
  | 'trust-retryConditions-open-settings'
  | 'backend-ping'
  // The Settings redesign's backend card: its Details link, the "Set path…"
  // button of a backend that was not found, and the actions menu with its
  // "Change path…" item. The test keeps the key it had as the Ping button.
  | 'backend-details'
  | 'backend-set-path'
  | 'backend-actions'
  | 'backend-change-path'
  // FR-R3-144 (T031, T036, T034) — the backend selector, both per-run spend
  // bounds, and the uncontained grant. The grant is not a draft field the page
  // Save writes: it writes through its own IPC command the moment it is
  // confirmed, which is why the confirmation exists.
  | 'backendRunner'
  | 'spendMaxUsdPerRun'
  | 'spendMaxTokensPerRun'
  | 'backend-grant';

export const GENERAL_SETTINGS_DESCRIPTIONS = {

  cliPath: {
    title: 'CLI path',
    body:
      'Absolute or PATH-resolvable path to the `claude` binary. Leave the ' +
      'default `claude` to use whatever resolves on the system PATH.'
  },

  codexPath: {
    title: 'Codex CLI path',
    body:
      'Absolute or PATH-resolvable path to the `codex` binary. Leave the ' +
      'default `codex` to use whatever resolves on the system PATH.'
  },

  agyPath: {
    title: 'Agy CLI path',
    body:
      'Absolute or PATH-resolvable path to the `agy` binary. Leave the ' +
      'default `agy` to use whatever resolves on the system PATH.'
  },

  loggingVerbose: {
    title: 'Verbose logging',
    body:
      'Capture unredacted per-iteration diagnostics under ' +
      '`.schegent/sessions/<runId>/diagnostics/`. Useful for support; the ' +
      'structured `.schegent/audit.log` remains sanitized either way.'
  },
  rawTranscriptMode: {
    title: 'Keep raw transcripts',
    body:
      'Whether new runs keep their unredacted transcripts: "Always"; "Unless the run completes", ' +
      'which keeps a run\'s transcript when it fails, is canceled or pauses; or "Never". The ' +
      'choice is frozen for each run.'
  },
  transportCaptureMode: {
    title: 'Record backend traffic',
    body:
      'Whether Schegent records backend traffic, the stream lines exchanged with the CLI, with ' +
      'secret patterns redacted and otherwise as sent. Kept per Run, bounded by size and by how ' +
      'long run artifacts are kept. "Same as raw transcripts" follows Keep raw transcripts; ' +
      '"Never" keeps nothing; "For failed or canceled runs" keeps a Run\'s traffic only if it ' +
      'fails or is canceled; "Always" keeps all of it. Claude Code itself sends the conversation ' +
      'to the model vendor whatever this setting.'
  },

  loopMaxIterations: {
    title: 'Loop limit',
    body:
      'Most times a Phase with a retry condition repeats in one run (1–50). If ' +
      'the condition still holds at the limit, the run fails, unless the Phase ' +
      'or "When the loop limit is reached" says to continue.'
  },

  invocationIdleTimeoutSeconds: {
    title: 'Stop a step that is silent for (seconds)',
    body:
      'Idle window for a single CLI invocation (60–7200): the runner ' +
      'terminates the Phase after this long with no output. Output resets ' +
      'the window, so a streaming Phase runs on — the time limit per step, ' +
      'below, is what bounds it.'
  },

  invocationMaxDurationSeconds: {
    title: 'Time limit per step (seconds)',
    body:
      'Absolute wall-clock bound for a single CLI invocation (60–86400), ' +
      'armed at spawn and never reset — a chatty child that keeps emitting ' +
      'output cannot extend it. Terminations under this bound are recorded ' +
      'as deadline, distinct from an idle timeout.'
  },

  watchdogPollIntervalMinutes: {
    title: 'Check paused runs every (minutes)',
    body:
      'How often the watchdog re-checks a paused run (1–240). Shorter ' +
      'intervals resume sooner after a manual unpause; longer intervals ' +
      'reduce idle CPU.'
  },

  auditRotationSizeMB: {
    title: 'Start a new audit file at (MB)',
    body:
      'Rotate the structured audit log when it exceeds this size (1–100 MB). ' +
      'Rotation moves the old file to `.schegent/audit.<N>.log` and starts a ' +
      'fresh one.'
  },

  auditRotationMaxAgeDays: {
    title: 'Keep audit events for (days)',
    body:
      'Delete rotated audit log files older than this many days (1–365). ' +
      'Only files matching `.schegent/audit.*.log` are affected.'
  },

  defaultWorkflowId: {
    title: 'Default workflow',
    body:
      // Feature 285 (OD-2, FR-003) — `schegent.defaultWorkflowId`. The list is the
      // effective Workflows the store holds; no Pipeline row is offered.
      'Workflow the Queue Add work composer preselects when nothing is selected. ' +
      'The list reflects the Workflows in the catalog. While this is unset, the ' +
      'deprecated schegent.defaultPipelineId is read when it names a Workflow.'
  },

  claudeAutoCompactPctOverride: {
    title: 'Claude compaction threshold (%)',
    body:
      'When set (1–100), exported as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to the ' +
      'Claude CLI subprocess so it compacts earlier. Leave the field empty ' +
      'to use the CLI default.'
  },

  runtimeLogLevel: {
    title: 'Log level',
    body:
      'Default: Info. Selects which records are written to the runtime log ' +
      'file. Debug includes all records; Error includes only error records. ' +
      'Independent of the Verbose logging toggle. Takes effect on the next ' +
      'log emission — no reload required.'
  },

  runtimeLogFilePath: {
    title: 'Log file path',
    body:
      'Default: <workspace>/.schegent/syslog. Where the runtime log file is ' +
      'written. Leave blank to use the default. Accepts an absolute path or ' +
      'a workspace-relative path. Relative paths with `..` are rejected for ' +
      'safety. Secret patterns are redacted before write. Failed writes are ' +
      'suppressed until you save this setting again.'
  },

  sessionRetentionMaxAgeDays: {
    title: 'Keep run artifacts for (days)',
    body:
      'Complete inactive raw transcripts and verbose diagnostics older than ' +
      'this many days are removed. Active runs and audit.log are never pruned.'
  },

  sessionRetentionMaxBytes: {
    title: 'Run artifact space (bytes)',
    body:
      'Total byte budget for raw transcripts and verbose diagnostics. The ' +
      'oldest complete inactive runs are removed first; active runs and ' +
      'audit.log are protected.'
  },

  'backend-ping': {
    title: 'Test backend',
    body:
      'Run a bounded host-side CLI availability probe. The command carries ' +
      'only the backend identity; configured paths and process output never reach the webview.'
  },

  // The backend card's other controls. Each body is longer than the inline
  // limit on purpose: a short one is injected as a paragraph beside its control,
  // which would break a title row, a button group or a menu.
  'backend-details': {
    title: 'Backend details',
    body:
      'Show or hide the path this backend is started from, the sandbox it runs ' +
      'under, the reason it cannot run when there is one, and the settings that ' +
      'apply to it alone.'
  },
  'backend-set-path': {
    title: 'Set path',
    body:
      'Open the path field for this backend. Enter the command name or the full ' +
      'path of its CLI, then save; Schegent looks for the backend again after the ' +
      'path is saved.'
  },
  'backend-actions': {
    title: 'Backend actions',
    body:
      'Open the other actions for this backend: change the path it is started ' +
      'from, test it when it was not found, and allow or revoke permission to run ' +
      'unsandboxed where that applies.'
  },
  'backend-change-path': {
    title: 'Change path',
    body:
      'Open the path field for this backend so you can point it at another CLI. ' +
      'The new path is used after you save, and Schegent then looks for the ' +
      'backend again.'
  },

  // FR-R3-144 (T031) — the setting the whole item turns on.
  backendRunner: {
    title: 'Backend for new runs',
    body:
      'Which CLI Schegent invokes for every task. Applies to every workspace on ' +
      'this machine, and takes effect on the next invocation — a run already in ' +
      'flight finishes on the backend it started with. Each backend reports spend ' +
      'in its own denomination and carries its own containment, both shown below.'
  },

  // FR-R3-144 (T036) — one key per denomination; the tab offers the one that
  // matches the selected backend, because a bound in a denomination the backend
  // never reports is a bound that silently does nothing.
  spendMaxUsdPerRun: {
    title: 'Spend limit per run (USD)',
    body:
      'Pause a run once its reported cost crosses this many US dollars. It pauses ' +
      'and never fails or cancels: you can resume, and the accounting continues ' +
      'from where it stopped. Leave it empty for no limit. Applies to backends ' +
      'that report a cost.'
  },
  spendMaxTokensPerRun: {
    title: 'Spend limit per run (tokens)',
    body:
      'Pause a run once its reported token usage crosses this count. It pauses ' +
      'and never fails or cancels: you can resume, and the accounting continues ' +
      'from where it stopped. Leave it empty for no limit. Applies to backends ' +
      'that report tokens and no cost.'
  },

  // FR-R3-144 (T034) — the grant, and what granting it actually means. The
  // sentence the operator sees BEFORE writing is the enforcement's own refusal,
  // carried by the posture projection; this is the standing explanation of the
  // control itself.
  'backend-grant': {
    title: 'Permission to run unsandboxed',
    body:
      'Allow this backend to run even though the platform enforces no sandbox for ' +
      'it. The permission is per backend, is stored in your settings, and can be ' +
      'revoked from this menu at any time — revoking takes effect on the next ' +
      'invocation. Without it the run is refused before the process starts, and ' +
      'Details on this card gives the reason.'
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
  // FR-R3-143 (T012) — retry.
  retryMaxAttempts: {
    title: 'Retry attempts per step',
    body:
      'How many delayed-retry attempts a Phase gets before the Run and its ' +
      'Queue pause (1–5). Retries cannot be switched off here: the lowest ' +
      'accepted value is 1, and the first attempt is not counted as a retry.'
  },
  retryForceContinueOnCap: {
    title: 'When the loop limit is reached',
    body:
      'What a Phase does when it reaches the loop limit with its retry condition ' +
      'still truthy: "Fail the run" fails it, and "Continue with a warning" ' +
      'advances and records a forced-continue runtime event. This is the ' +
      'workspace default only — a Phase definition ' +
      'overrides it — and it does not carry a failure forward: failed and ' +
      'timed-out outcomes stay terminal.'
  },
  // FR-R3-143 (T013) — runtime log rotation.
  runtimeLogMaxBytes: {
    title: 'Log file size (bytes)',
    body:
      'Rotate the runtime debug log once it reaches this size (1 MiB–1 GiB). ' +
      'Rotation is by size only; there is no time-based trigger.'
  },
  runtimeLogMaxGenerations: {
    title: 'Log files kept',
    body:
      'How many numbered runtime-log generations to keep (0–20). The oldest is ' +
      'deleted once the count is exceeded. Zero opts out of rotation entirely: ' +
      'the log is truncated in place, so its earlier contents are gone.'
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
      'Superseded by Environment passed to backends, and kept because existing settings ' +
      'still carry it: setting it Off forces `minimal` regardless of the mode. ' +
      'Leave it On unless you are deliberately reproducing the old behaviour. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
  },

  cliEnvironmentMode: {
    title: 'Environment passed to backends',
    body:
      'What the backend CLI subprocess inherits. `allowlist` (the default) ' +
      'forwards the required PATH/home/temp/locale bootstrap variables plus the ' +
      'names listed below; `minimal` forwards only Schegent-controlled ' +
      'variables; `inherit` forwards the whole extension-host environment, ' +
      'including any ambient cloud, registry and signing credentials in it. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
  },

  cliEnvironmentAllowlist: {
    title: 'Allowed variables',
    body:
      'Variable NAMES to forward when the mode is `allowlist` — values are read ' +
      'from the extension host at spawn time and are never stored in this ' +
      'setting. Add `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` or `ANTHROPIC_API_KEY` ' +
      'here if your setup needs them. Type a name and press Enter or click Add. ' +
      'Applies to every workspace on this machine, and takes effect after ' +
      'reloading the VS Code Extension Host.'
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
      'click Save, and Revert restores the saved list.'
  },

  backendProbeTimeoutSeconds: {
    title: 'Backend check timeout (seconds)',
    body:
      'How long a backend availability probe may run before it is treated as ' +
      'unavailable (1–30). Raise it on a slow filesystem or a cold network ' +
      'mount. Applies to every workspace on this machine, and is read at the ' +
      'start of each probe — the next test uses the new value, with no reload.'
  },

  // FR-R3-143 (T032) — two `window`-scoped settings, saved to this workspace.
  uiConfirmationsEnable: {
    title: 'Ask before destructive actions',
    body:
      'Ask before destructive actions such as clearing the queue or deleting a ' +
      'definition. Turning this Off removes those prompts, so the action happens ' +
      'on the first click. Saved for this workspace, and applied to the next ' +
      'confirmation — no reload.'
  },

  multiRootSuppressWarning: {
    title: 'Warn about multi-root workspaces',
    body:
      'Show the one-per-activation notice that a multi-root workspace is open ' +
      'and only the canonical folder is used; Off stops it. The setting stores ' +
      'the opposite, `multiRoot.suppressWarning`. The warning is emitted once ' +
      'during activation, so a change takes effect the next time the window is ' +
      'opened or the Extension Host reloads. Saved for this workspace.'
  },
} as const satisfies { readonly [K in GeneralSettingsControlId]: ControlDescription };
