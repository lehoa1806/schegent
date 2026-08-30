<script lang="ts">
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS, IDLE_SESSION_ARTIFACTS } from '../../lib/snapshot-types';
  import { saveGeneralSettings } from '../../lib/save-general-settings';
  import type { Draft, FieldSpec, ScalarKey } from './general/field-types';
  // FR-R3-143 (T033) — the pure functions of (projection, draft). See that
  // module's header for why they left the component and why `FIELDS` did not.
  import {
    CLEARABLE_KEYS,
    friendlyReason,
    ipcKeyFor,
    isFieldChanged,
    scopeLabelFor,
    snapshotToDraft
  } from './general/settings-draft';
  import { confirmSettingsWrite } from './general/confirm-settings-write';
  import GeneralSettingsHeader from './general/GeneralSettingsHeader.svelte';
  // FR-R3-144 (T038) — the backend group declares its own specs and exports them
  // flattened. This tab composes the groups and owns the draft, the save/reset
  // machinery and the dirty marker; it does not also hold every group's data.
  // See that component's header for why the specs live in a `.svelte` module
  // block rather than a `.ts` one.
  import BackendEnvironmentGroup, {
    BACKEND_GROUP_FIELDS
  } from './general/BackendEnvironmentGroup.svelte';
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
  // FR-R3-143 (T009) — `GENERAL_FIELDS` was one flat array in no particular
  // order. It is split into the three groups §4 names; the backend group is the
  // fourth, and since FR-R3-144 (T025) its fields are keyed by backend rather
  // than listed. Rendered field *order* changes as a result, which is the point
  // of grouping rather than a side effect: the old array interleaved
  // audit/logging (indices 1-6, 11-12) with execution (7-10, 13). No test
  // asserts field order.
  const AUDIT_LOGGING_FIELDS: readonly FieldSpec[] = [
    // FR-R3-144 (T037, FR-008) — the note is not new prose. It is the sentence
    // `docs/reference/settings.md` already carries for this key, and this is the
    // only setting in that document whose behaviour is conditional on the backend.
    // The doc said so and the control did not, so an operator who turned this on
    // under Codex got nothing and had no way to know why.
    //
    // (Prose in this file avoids the pinned per-task status vocabulary — the word
    // for "in flight" included. The lint gate that keeps that vocabulary out of
    // files with no business holding it greps by substring, comments and all, and
    // it is right not to make an exception for prose.)
    {
      key: 'loggingVerbose',
      ipcKey: 'logging.verbose',
      label: 'Verbose Logging',
      kind: 'boolean',
      note: 'For Claude, additionally writes unredacted debug, stream, and verbose artifacts. Codex and Agy currently ignore this setting. Changes apply to the next invocation.'
    },
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

  // FR-R3-144 (T029) — `claudeAutoCompactPctOverride` is no longer in this list.
  // It sat between "Confirmation Prompts" and "Suppress Multi-Root Warning" under
  // a "UI and trust" heading, where the word `Claude` in its own label was the only
  // thing distinguishing a Claude-only setting from two that apply to every
  // backend. It is now `BACKENDS.claude.specific`, drawn inside Claude's section.
  const UI_TRUST_FIELDS: readonly FieldSpec[] = [
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

  // Every spec on the tab, in group order. Save All iterates this and `dirty` is
  // computed from it, so a spec that reached the screen but not this array would
  // be a control whose edit Save All silently dropped — which is why the backend
  // group exports its own flattened list rather than leaving the tab to restate
  // it. `FIELDS` is now the only thing the tab needs the specs FOR.
  const FIELDS: readonly FieldSpec[] = [
    ...BACKEND_GROUP_FIELDS,
    ...AUDIT_LOGGING_FIELDS,
    ...EXECUTION_RETRY_FIELDS,
    ...UI_TRUST_FIELDS
  ];

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
    // FR-R3-144 (T036) — `CLEARABLE_KEYS`, not a name comparison. Resetting a
    // clearable field to the projection's `undefined` rather than to `null` would
    // put the draft in a state `isFieldChanged` reads as unchanged and the input
    // renders as blank — indistinguishable from cleared, but the opposite write.
    if (CLEARABLE_KEYS.has(key)) {
      (draft as Record<string, unknown>)[key] = currentSettings[key] ?? null;
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

  // FR-R3-144 (T036) — `onAutoCompactInput` is gone. It was a handler named after
  // one Claude-only setting, declared here and threaded through all four groups —
  // including the two with no clearable number in them — to reach the single
  // `number-optional` arm in `GeneralSettingFieldRow`, which wrote
  // `draft.claudeAutoCompactPctOverride` by name. With three fields of that kind
  // the arm writes `draft[spec.key]` and owns its own handler, so there is nothing
  // left to thread.

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
    bind:draft
    {statusByKey}
    {pipelines}
    {fieldChanged}
    {fieldScopeLabel}
    {saveOne}
    {resetField}
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
