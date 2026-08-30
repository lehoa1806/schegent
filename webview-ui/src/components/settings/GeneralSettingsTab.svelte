<script lang="ts">
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS, IDLE_SESSION_ARTIFACTS } from '../../lib/snapshot-types';
  import { saveGeneralSettings } from '../../lib/save-general-settings';
  import type { Draft, FieldSpec, ScalarKey } from './general/field-types';
  // FR-R3-143 (T033) — the pure functions of (projection, draft). See that
  // module's header for why they left the component and why `FIELDS` did not.
  import {
    friendlyReason,
    ipcKeyFor,
    isFieldChanged,
    scopeLabelFor,
    snapshotToDraft
  } from './general/settings-draft';
  import { confirmSettingsWrite } from './general/confirm-settings-write';
  // FR-R3-143 (T030, T034) — the mode list and the allowlist element pattern are
  // READ from the module that enforces them, not copied. A copy on the far side of
  // the IPC boundary is the one that would drift, and it would drift silently:
  // `sanitizeProcessEnvAllowlist` drops a name the surface accepted without saying
  // so, at spawn time, in another process.
  //
  // This import is `src/contracts/`, and that is not incidental. The first version
  // read the same two values from `src/config/settings-schema`, which
  // `tests/lint/webview-host-import-direction.test.ts` forbids: a webview VALUE
  // import drags everything the module transitively imports into the untrusted
  // bundle, so values come from contracts or not at all. T034 moved them there,
  // and `SETTINGS_SCHEMA` now reads the same two constants.
  import {
    PROCESS_ENVIRONMENT_MODES,
    PROCESS_ENV_NAME_PATTERN_SOURCE
  } from '../../../../src/contracts/process-environment-policy';
  import GeneralSettingsHeader from './general/GeneralSettingsHeader.svelte';
  import BackendEnvironmentGroup from './general/BackendEnvironmentGroup.svelte';
  import ExecutionRetryGroup from './general/ExecutionRetryGroup.svelte';
  import AuditLoggingGroup from './general/AuditLoggingGroup.svelte';
  import UiTrustGroup from './general/UiTrustGroup.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  // FR-R3-143 (T002) — one definition, in `general/field-types.ts`.

  // FR-R3-145 (T1569) — `FIELDS` below is a subset of the scalar `schegent.*`
  // keys the manifest declares, not all of them. The FR-020 claim that stood
  // here stopped being true as keys were contributed without controls, so it
  // is stated as the subset it is rather than as coverage. fatalSignatures
  // is intentionally handled by FatalSignaturesTab (array-of-string).
  const BACKEND_FIELDS: readonly FieldSpec[] = [
    { key: 'cliPath', ipcKey: 'cli.path', label: 'Claude CLI Path', kind: 'string' },
    { key: 'codexPath', ipcKey: 'codex.path', label: 'Codex CLI Path', kind: 'string' },
    { key: 'agyPath', ipcKey: 'agy.path', label: 'Agy CLI Path', kind: 'string' }
  ] as const;

  // FR-R3-143 (T009) — `GENERAL_FIELDS` was one flat array in no particular
  // order. It is split into the three groups §4 names; `BACKEND_FIELDS` above
  // is the fourth and is not split. Rendered field *order* changes as a
  // result, which is the point of grouping rather than a side effect: the old
  // array interleaved audit/logging (indices 1-6, 11-12) with execution
  // (7-10, 13). No test asserts field order.
  const AUDIT_LOGGING_FIELDS: readonly FieldSpec[] = [
    { key: 'loggingVerbose', ipcKey: 'logging.verbose', label: 'Verbose Logging', kind: 'boolean' },
    {
      key: 'runtimeLogLevel',
      ipcKey: 'logging.runtimeLogLevel',
      label: 'Runtime Log Level',
      kind: 'level-select'
    },
    {
      key: 'runtimeLogFilePath',
      ipcKey: 'logging.runtimeLogFilePath',
      label: 'Runtime Log File Path',
      kind: 'string',
      placeholder: '<workspace>/.schegent/syslog'
    },
    {
      key: 'rawTranscriptMode',
      ipcKey: 'logging.rawTranscriptMode',
      label: 'Raw Transcript Retention',
      kind: 'raw-transcript-select'
    },
    {
      key: 'sessionRetentionMaxAgeDays',
      ipcKey: 'logging.sessionRetentionMaxAgeDays',
      label: 'Session Artifact Retention (days)',
      kind: 'number',
      min: 1,
      max: 3650
    },
    {
      key: 'sessionRetentionMaxBytes',
      ipcKey: 'logging.sessionRetentionMaxBytes',
      label: 'Session Artifact Budget (bytes)',
      kind: 'number',
      min: 1048576,
      max: 10737418240
    },
    { key: 'auditRotationSizeMB', ipcKey: 'audit.rotation.sizeMB', label: 'Audit Rotation Size (MB)', kind: 'number', min: 1, max: 100 },
    { key: 'auditRotationMaxAgeDays', ipcKey: 'audit.rotation.maxAgeDays', label: 'Audit Retention (days)', kind: 'number', min: 1, max: 365 },
    { key: 'runtimeLogMaxBytes', ipcKey: 'logging.runtimeLogMaxBytes', label: 'Runtime Log Rotation Size (bytes)', kind: 'number', min: 1048576, max: 1073741824 },
    // FR-R3-143 (T047) — `0, 20`, from the manifest. T013 wrote `1, 50`, which
    // offered 21..50 to an operator the host would refuse and hid `0` (keep no
    // rotated generations), the one value with a distinct meaning.
    { key: 'runtimeLogMaxGenerations', ipcKey: 'logging.runtimeLogMaxGenerations', label: 'Runtime Logs Kept', kind: 'number', min: 0, max: 20 }
  ] as const;

  const EXECUTION_RETRY_FIELDS: readonly FieldSpec[] = [
    // FR-R3-143 (T047) — `max: 50`, from the manifest. This one is not this
    // feature's doing: Feature 018 wrote `100` and the host has accepted at most
    // 50 the whole time. It is corrected here rather than filed because
    // `tests/lint/settings-field-bounds-parity.test.ts`, added by the same task,
    // fails on it, and an allowance list on a new gate's first day is a worse
    // artifact than the one-token fix it would be excusing.
    { key: 'loopMaxIterations', ipcKey: 'loop.maxIterations', label: 'Loop Max Iterations', kind: 'number', min: 1, max: 50 },
    { key: 'invocationIdleTimeoutSeconds', ipcKey: 'invocation.idleTimeoutSeconds', label: 'Invocation Idle Timeout (seconds)', kind: 'number', min: 60, max: 7200 },
    { key: 'invocationMaxDurationSeconds', ipcKey: 'invocation.maxDurationSeconds', label: 'Invocation Max Duration (seconds)', kind: 'number', min: 60, max: 86400 },
    { key: 'watchdogPollIntervalMinutes', ipcKey: 'watchdog.pollIntervalMinutes', label: 'Watchdog Poll Interval (minutes)', kind: 'number', min: 1, max: 240 },
    { key: 'defaultPipelineId', ipcKey: 'defaultPipelineId', label: 'Default Pipeline', kind: 'pipeline-select' },
    // FR-R3-143 (T047) — `1, 5`, from the manifest. T012 wrote `0, 20` and the
    // hover text explained that zero disables retries; the host's minimum is 1,
    // so that was an instruction to enter a value it would reject.
    { key: 'retryMaxAttempts', ipcKey: 'retry.maxAttempts', label: 'Retry Max Attempts', kind: 'number', min: 1, max: 5 },
    { key: 'retryForceContinueOnCap', ipcKey: 'retry.forceContinueOnCap', label: 'Continue Past Retry Cap', kind: 'boolean' }
  ] as const;

  // FR-R3-143 (T031) — the process-environment and probe settings, in their own
  // array rather than appended to `BACKEND_FIELDS`. `BackendHealthSection`
  // pairs `BACKEND_FIELDS[i]` with `RUNNERS[i]` positionally, so a fourth entry
  // there would be a CLI path the section never draws. That positional coupling
  // is FR-R3-144's to remove (T1563); this feature does not touch it.
  //
  // The three environment settings and the probe timeout differ in when they
  // take effect, and each `note` says which — see the descriptions module for
  // where that was read from. All four are `application`-scoped, so the host
  // writes them to User settings for every workspace on this machine.
  const PROCESS_ENVIRONMENT_FIELDS: readonly FieldSpec[] = [
    {
      key: 'cliEnvironmentMode',
      ipcKey: 'cli.environmentMode',
      label: 'Environment Mode',
      kind: 'enum',
      options: PROCESS_ENVIRONMENT_MODES,
      note: 'Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'cliEnvironmentAllowlist',
      ipcKey: 'cli.environmentAllowlist',
      label: 'Environment Allowlist',
      kind: 'string-list',
      itemPattern: PROCESS_ENV_NAME_PATTERN_SOURCE,
      invalidMessage:
        'Not a legal environment variable name — use letters, digits and underscores, and do not start with a digit.',
      note: 'Names only; values are read at spawn time and never stored here. Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'cliInheritEnvironment',
      ipcKey: 'cli.inheritEnvironment',
      label: 'Inherit Host Environment (legacy)',
      kind: 'boolean',
      note: 'Superseded by Environment Mode; Off forces minimal. Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'backendProbeTimeoutSeconds',
      ipcKey: 'backend.probeTimeoutSeconds',
      label: 'Backend Probe Timeout (seconds)',
      kind: 'number',
      min: 1,
      max: 30,
      note: 'Applies to every workspace on this machine. Read at the start of each probe — the next Ping uses it, no reload.'
    }
  ] as const;

  const UI_TRUST_FIELDS: readonly FieldSpec[] = [
    {
      key: 'claudeAutoCompactPctOverride',
      ipcKey: 'claude.autoCompactPctOverride',
      label: 'Claude auto-compaction threshold (%)',
      kind: 'number-optional',
      min: 1,
      max: 100,
      placeholder: 'Unset — use CLI default'
    },
    // FR-R3-143 (T032) — both `window`-scoped, so the host writes them to this
    // workspace. Only the multi-root one is read once per activation, and only
    // it discloses that.
    {
      key: 'uiConfirmationsEnable',
      ipcKey: 'ui.confirmations.enable',
      label: 'Confirmation Prompts',
      kind: 'boolean',
      note: 'Off means destructive actions happen on the first click, with no prompt.'
    },
    {
      key: 'multiRootSuppressWarning',
      ipcKey: 'multiRoot.suppressWarning',
      label: 'Suppress Multi-Root Warning',
      kind: 'boolean',
      note: 'The warning is emitted once during activation, so this takes effect the next time the window opens or the Extension Host reloads.'
    }
  ] as const;

  const FIELDS = [
    ...BACKEND_FIELDS,
    ...PROCESS_ENVIRONMENT_FIELDS,
    ...AUDIT_LOGGING_FIELDS,
    ...EXECUTION_RETRY_FIELDS,
    ...UI_TRUST_FIELDS
  ] as const;

  const currentSettings = $derived<GeneralSettings>(
    snapshot.generalSettings ?? IDLE_GENERAL_SETTINGS
  );
  const sessionArtifacts = $derived(snapshot.sessionArtifacts ?? IDLE_SESSION_ARTIFACTS);

  // Initialize with IDLE_GENERAL_SETTINGS shape; the $effect below
  // immediately re-syncs against the real projection (this avoids the
  // svelte/state_referenced_locally warning).
  let draft = $state<Draft>(snapshotToDraft(IDLE_GENERAL_SETTINGS));
  let lastProjectedJson = $state('');

  // Re-sync the draft when the projection changes (e.g. external save,
  // workspace settings reloaded). Only overwrites local edits when the
  // last projected value also differs — i.e. there is no in-flight
  // unsaved edit conflict to clobber.
  $effect(() => {
    const next = snapshotToDraft(currentSettings);
    const nextJson = JSON.stringify(next);
    if (nextJson === lastProjectedJson) return;
    draft = next;
    lastProjectedJson = nextJson;
    statusByKey = {};
  });

  let statusByKey = $state<
    Partial<Record<ScalarKey, { status: 'pending' | 'accepted' | 'rejected'; reason?: string }>>
  >({});

  // Bound to the current projection so the groups keep the `(key) => …` prop
  // signature `SettingsGroupProps` declares.
  function fieldChanged(key: ScalarKey): boolean {
    return isFieldChanged(key, draft, currentSettings);
  }

  function fieldScopeLabel(key: ScalarKey): string {
    return scopeLabelFor(key, currentSettings);
  }

  async function saveOne(spec: { readonly key: ScalarKey; readonly ipcKey?: string }): Promise<void> {
    const key = spec.key;
    const updates = { [ipcKeyFor(spec)]: draft[key] };
    // FR-R3-143 (T042) — declining reverts the toggle, so the control does not
    // sit showing a state that was never written.
    if (!(await confirmSettingsWrite(updates))) return resetField('uiConfirmationsEnable');
    statusByKey = { ...statusByKey, [key]: { status: 'pending' } };
    const result = await saveGeneralSettings(updates);
    statusByKey = {
      ...statusByKey,
      [key]: result.status === 'accepted'
        ? { status: 'accepted' }
        : { status: 'rejected', reason: friendlyReason(spec, result.reason) }
    };
  }

  async function saveAll(): Promise<void> {
    // Build an updates object containing only fields whose draft
    // diverges from the projected value. Transactional accept/reject
    // is enforced by the host per contracts/general-settings-ipc.md —
    // if any single key fails validation, none are written.
    const updates: Record<string, unknown> = {};
    const changedSpecs: typeof FIELDS[number][] = [];
    for (const spec of FIELDS) {
      if (fieldChanged(spec.key)) {
        updates[ipcKeyFor(spec)] = draft[spec.key];
        changedSpecs.push(spec);
      }
    }
    if (changedSpecs.length === 0) return;
    // The whole batch is transactional on the host, so declining aborts all of
    // it rather than dropping one key out of a payload the host was told to
    // apply atomically. The other drafts stay dirty and Save All still works.
    if (!(await confirmSettingsWrite(updates))) return resetField('uiConfirmationsEnable');
    const pending: Partial<typeof statusByKey> = {};
    for (const spec of changedSpecs) {
      pending[spec.key] = { status: 'pending' };
    }
    statusByKey = { ...statusByKey, ...pending };
    const result = await saveGeneralSettings(updates);
    const next: typeof statusByKey = { ...statusByKey };
    for (const spec of changedSpecs) {
      next[spec.key] = result.status === 'accepted'
        ? { status: 'accepted' }
        : { status: 'rejected', reason: friendlyReason(spec, result.reason) };
    }
    statusByKey = next;
  }

  function resetField(key: ScalarKey): void {
    if (key === 'claudeAutoCompactPctOverride') {
      draft.claudeAutoCompactPctOverride = currentSettings.claudeAutoCompactPctOverride ?? null;
    } else {
      const projected = currentSettings[key] as unknown;
      // FR-R3-143 (T030) — copy, for the reason `snapshotToDraft` copies: the
      // projection's array is frozen, and the list editor would be resetting
      // the field into an array it cannot then edit.
      (draft as Record<string, unknown>)[key] = Array.isArray(projected)
        ? [...projected]
        : projected;
    }
    const next = { ...statusByKey };
    delete next[key];
    statusByKey = next;
  }

  function resetAll(): void {
    draft = snapshotToDraft(currentSettings);
    statusByKey = {};
  }

  // Feature 012 — bind helper for the optional integer field. Empty input
  // converts to `null` (clear sentinel); otherwise to an integer.
  function onAutoCompactInput(ev: Event): void {
    const raw = (ev.target as HTMLInputElement).value;
    if (raw === '' || raw == null) {
      draft.claudeAutoCompactPctOverride = null;
      return;
    }
    const n = Number(raw);
    draft.claudeAutoCompactPctOverride = Number.isFinite(n) ? n : null;
  }

  const dirty = $derived(
    FIELDS.some((spec) => fieldChanged(spec.key))
  );

  const pipelines = $derived(snapshot.availablePipelines ?? []);
</script>

<section class="general-settings" data-testid="general-settings-tab">
  <GeneralSettingsHeader
    settings={currentSettings}
    {sessionArtifacts}
    {dirty}
    {saveAll}
    {resetAll}
  />

  <BackendEnvironmentGroup
    {snapshot}
    fields={BACKEND_FIELDS}
    environmentFields={PROCESS_ENVIRONMENT_FIELDS}
    bind:draft
    {statusByKey}
    {pipelines}
    {fieldChanged}
    {fieldScopeLabel}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />

  <ExecutionRetryGroup
    fields={EXECUTION_RETRY_FIELDS}
    bind:draft
    {statusByKey}
    {pipelines}
    {fieldChanged}
    {fieldScopeLabel}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />

  <AuditLoggingGroup
    fields={AUDIT_LOGGING_FIELDS}
    bind:draft
    {statusByKey}
    {pipelines}
    {fieldChanged}
    {fieldScopeLabel}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />

  <UiTrustGroup
    {snapshot}
    fields={UI_TRUST_FIELDS}
    bind:draft
    {statusByKey}
    {pipelines}
    {fieldChanged}
    {fieldScopeLabel}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />
</section>

<style>
  .general-settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 8px 0;
    height: 100%;
  }
  /* The header's own rules moved with its markup into
   * `general/GeneralSettingsHeader.svelte` — Svelte scopes styles per
   * component, so leaving them here would have styled nothing. */
</style>
