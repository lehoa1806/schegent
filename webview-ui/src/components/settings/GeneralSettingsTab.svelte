<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS, IDLE_SESSION_ARTIFACTS } from '../../lib/snapshot-types';
  import { saveGeneralSettings } from '../../lib/save-general-settings';
  import type { Draft, FieldSpec, FieldStatus, ScalarKey } from './general/field-types';
  import type { SaveResult } from '../../lib/save-general-settings';
  import { isOutcomeNotYetKnown } from '../../lib/boundary-refusal-text';
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
  import { TRANSPORT_CAPTURE_SETTINGS } from '../../../../src/contracts/transport-capture-mode';
  import { SettingsPage, type SettingsSectionId } from './settings-page.svelte';
  import SettingsSection from './SettingsSection.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The page whose header saves and reverts this tab's draft; a tab on its own gets its own. */
    page?: SettingsPage;
    /**
     * The Queues section, drawn between Runs and retries and Logs and retention so the sections
     * read in the navigation's order. It is a part of its own with its own commands: the queue
     * settings are not general fields (spec 095 FR-010), so this tab gains no row for them.
     */
    queues?: Snippet;
  }
  const { snapshot, page = new SettingsPage(), queues }: Props = $props();

  // FR-R3-143 (T002) — one definition, in `general/field-types.ts`.

  // FR-R3-145 (T1569) — `FIELDS` below is a subset of the scalar `schegent.*`
  // keys the manifest declares, not all of them. The FR-020 claim that stood
  // here stopped being true as keys were contributed without controls, so it
  // is stated as the subset it is rather than as coverage. fatalSignatures
  // is intentionally handled by FatalSignaturesTab (array-of-string).
  // FR-R3-143 (T009) — `GENERAL_FIELDS` was one flat array in no particular
  // order. It is split into the three groups §4 names; the backend group is the
  // fourth, and since FR-R3-144 (T025) its fields are keyed by backend rather
  // than listed. Within a group the rows come in the order the redesign's
  // settings page draws them, and a setting the mockup does not draw sits beside
  // its kin (the log file path beside the log size, verbose logging beside the
  // log level). `settings/__tests__/general-settings-rows.test.ts` asserts that
  // order and the labels, which are the mockup's words.
  const AUDIT_LOGGING_FIELDS: readonly FieldSpec[] = [
    {
      key: 'runtimeLogLevel',
      ipcKey: 'logging.runtimeLogLevel',
      label: 'Log level',
      kind: 'level-select'
    },
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
      label: 'Verbose logging',
      kind: 'boolean',
      note: 'For Claude, additionally writes unredacted debug, stream, and verbose artifacts. Codex and Agy currently ignore this setting. Changes apply to the next invocation.'
    },
    {
      key: 'rawTranscriptMode',
      ipcKey: 'logging.rawTranscriptMode',
      label: 'Keep raw transcripts',
      kind: 'raw-transcript-select',
      note: 'Full backend conversations, stored locally.'
    },
    {
      key: 'transportCaptureMode',
      ipcKey: 'logging.transportCaptureMode',
      label: 'Record backend traffic',
      kind: 'enum',
      options: TRANSPORT_CAPTURE_SETTINGS,
      // The host keeps backend traffic only for a run that fails or is canceled under
      // `errors-only`, which is why its words differ from the raw transcript's.
      optionLabels: {
        inherit: 'Same as raw transcripts',
        off: 'Never',
        'errors-only': 'For failed or canceled runs',
        on: 'Always'
      },
      note: 'For debugging transport problems only.'
    },
    { key: 'auditRotationMaxAgeDays', ipcKey: 'audit.rotation.maxAgeDays', label: 'Keep audit events for', kind: 'number', unit: 'days', min: 1, max: 365 },
    { key: 'auditRotationSizeMB', ipcKey: 'audit.rotation.sizeMB', label: 'Start a new audit file at', kind: 'number', unit: 'MB', min: 1, max: 100 },
    {
      key: 'sessionRetentionMaxAgeDays',
      ipcKey: 'logging.sessionRetentionMaxAgeDays',
      label: 'Keep run artifacts for',
      kind: 'number',
      unit: 'days',
      min: 1,
      max: 3650
    },
    {
      key: 'sessionRetentionMaxBytes',
      ipcKey: 'logging.sessionRetentionMaxBytes',
      label: 'Run artifact space',
      kind: 'number',
      unit: 'bytes',
      wide: true,
      min: 1048576,
      max: 10737418240
    },
    {
      key: 'runtimeLogFilePath',
      ipcKey: 'logging.runtimeLogFilePath',
      label: 'Log file path',
      kind: 'string',
      placeholder: '<workspace>/.schegent/syslog'
    },
    { key: 'runtimeLogMaxBytes', ipcKey: 'logging.runtimeLogMaxBytes', label: 'Log file size', kind: 'number', unit: 'bytes', wide: true, min: 1048576, max: 1073741824 },
    // FR-R3-143 (T047) — `0, 20`, from the manifest. T013 wrote `1, 50`, which
    // offered 21..50 to an operator the host would refuse and hid `0` (keep no
    // rotated generations), the one value with a distinct meaning.
    { key: 'runtimeLogMaxGenerations', ipcKey: 'logging.runtimeLogMaxGenerations', label: 'Log files kept', kind: 'number', unit: 'files', min: 0, max: 20 }
  ] as const;

  const EXECUTION_RETRY_FIELDS: readonly FieldSpec[] = [
    {
      key: 'defaultWorkflowId',
      ipcKey: 'defaultWorkflowId',
      label: 'Default workflow',
      kind: 'workflow-select',
      note: 'Used when you add a task without choosing one.'
    },
    // FR-R3-143 (T047) — `1, 5`, from the manifest. T012 wrote `0, 20` and the
    // hover text explained that zero disables retries; the host's minimum is 1,
    // so that was an instruction to enter a value it would reject.
    {
      key: 'retryMaxAttempts',
      ipcKey: 'retry.maxAttempts',
      label: 'Retry attempts per step',
      kind: 'number',
      unit: 'attempts',
      min: 1,
      max: 5,
      note: 'The first attempt is not counted. When they run out, the run and its queue pause.'
    },
    {
      key: 'invocationIdleTimeoutSeconds',
      ipcKey: 'invocation.idleTimeoutSeconds',
      label: 'Stop a step that is silent for',
      kind: 'number',
      unit: 'seconds',
      min: 60,
      max: 7200,
      note: 'No output for this long counts as stuck.'
    },
    { key: 'invocationMaxDurationSeconds', ipcKey: 'invocation.maxDurationSeconds', label: 'Time limit per step', kind: 'number', unit: 'seconds', min: 60, max: 86400 },
    // FR-R3-143 (T047) — `max: 50`, from the manifest. This one is not this
    // feature's doing: Feature 018 wrote `100` and the host has accepted at most
    // 50 the whole time. It is corrected here rather than filed because
    // `tests/lint/settings-field-bounds-parity.test.ts`, added by the same task,
    // fails on it, and an allowance list on a new gate's first day is a worse
    // artifact than the one-token fix it would be excusing.
    {
      key: 'loopMaxIterations',
      ipcKey: 'loop.maxIterations',
      label: 'Loop limit',
      kind: 'number',
      unit: 'times',
      min: 1,
      max: 50,
      note: 'Most times a Phase with a retry condition repeats in one run.'
    },
    // What a Phase does when its retry condition still holds at the loop limit: the
    // boolean's two values are the two outcomes, so the row offers them by name.
    {
      key: 'retryForceContinueOnCap',
      ipcKey: 'retry.forceContinueOnCap',
      label: 'When the loop limit is reached',
      kind: 'boolean',
      choices: { false: 'Fail the run', true: 'Continue with a warning' },
      note: 'Phases can override this.'
    },
    { key: 'watchdogPollIntervalMinutes', ipcKey: 'watchdog.pollIntervalMinutes', label: 'Check paused runs every', kind: 'number', unit: 'minutes', min: 1, max: 240 }
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
      label: 'Ask before destructive actions',
      kind: 'boolean',
      note: 'Off means destructive actions happen on the first click, with no prompt.'
    },
    // The redesign asks whether to warn; the setting stores whether to suppress the
    // warning, so the toggle reads the opposite of the stored value.
    {
      key: 'multiRootSuppressWarning',
      ipcKey: 'multiRoot.suppressWarning',
      label: 'Warn about multi-root workspaces',
      kind: 'boolean',
      inverted: true,
      note: 'The warning is emitted once during activation, so this takes effect the next time the window opens or the Extension Host reloads.'
    }
  ] as const;

  // Every spec on the tab, in group order. The page Save writes from this and `dirty` is
  // computed from it, so a spec that reached the screen but not this array would
  // be a control whose edit the page Save silently dropped — which is why the backend
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

  let statusByKey = $state<Partial<Record<ScalarKey, FieldStatus>>>({});

  // FR-R4-F05 (I5, I6, I8, FR-024) — one status path for an on-time and a late answer: a timeout
  // reads as not yet known, and the late answer replaces it. Unmounting aborts the waits.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showSaveResult(specs: readonly { readonly key: ScalarKey; readonly ipcKey?: string }[], result: SaveResult): void {
    const next: typeof statusByKey = { ...statusByKey };
    for (const spec of specs) {
      next[spec.key] = result.status === 'accepted'
        ? { status: 'accepted' }
        : isOutcomeNotYetKnown(result.reason)
          ? { status: 'unknown' }
          : { status: 'rejected', reason: friendlyReason(spec, result.reason) };
    }
    statusByKey = next;
  }
  function saveWait(specs: readonly { readonly key: ScalarKey; readonly ipcKey?: string }[]) {
    return { signal: lifetime.signal, onLateOutcome: (late: SaveResult) => showSaveResult(specs, late) };
  }

  // Bound to the current projection so the groups keep the `(key) => …` prop
  // signature `SettingsGroupProps` declares.
  function fieldChanged(key: ScalarKey): boolean {
    return isFieldChanged(key, draft, currentSettings);
  }

  function fieldScopeLabel(key: ScalarKey): string {
    return scopeLabelFor(key, currentSettings);
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
    // apply atomically. FR-R3-143 (T042) — declining also reverts the toggle, so
    // the control does not sit showing a state that was never written; the other
    // drafts stay changed and Save still works.
    if (!(await confirmSettingsWrite(updates))) return resetField('uiConfirmationsEnable');
    const pending: Partial<typeof statusByKey> = {};
    for (const spec of changedSpecs) {
      pending[spec.key] = { status: 'pending' };
    }
    statusByKey = { ...statusByKey, ...pending };
    showSaveResult(changedSpecs, await saveGeneralSettings(updates, undefined, saveWait(changedSpecs)));
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

  // The page header counts this tab's edits under the section that shows each group.
  const SECTION_FIELDS: ReadonlyArray<readonly [SettingsSectionId, readonly FieldSpec[]]> = [
    ['backends', BACKEND_GROUP_FIELDS],
    ['execution', EXECUTION_RETRY_FIELDS],
    ['logging', AUDIT_LOGGING_FIELDS],
    ['trust', UI_TRUST_FIELDS]
  ];
  function changesBySection(): Partial<Record<SettingsSectionId, number>> {
    const counts: Partial<Record<SettingsSectionId, number>> = {};
    for (const [section, specs] of SECTION_FIELDS) {
      const changed = specs.filter((spec) => fieldChanged(spec.key)).length;
      if (changed > 0) counts[section] = changed;
    }
    return counts;
  }

  $effect(() =>
    page.register({
      changes: changesBySection,
      canSave: () => dirty,
      save: saveAll,
      revert: resetAll
    })
  );

  // A privacy profile sets its five settings in the draft; the page Save writes them with the
  // rest. Detection reads the draft, so the selector names the profile the page would save.
  function chooseProfile(updates: Partial<Draft>): void {
    draft = { ...draft, ...updates };
  }

  // Feature 285 (OD-2, FR-003) — the default select lists the effective Workflows only.
  const workflows = $derived(snapshot.workflowCatalog?.effective ?? []);
</script>

<div class="general-settings" data-testid="general-settings-tab">
  <SettingsSection {page} id="backends">
    <BackendEnvironmentGroup
      {snapshot}
      bind:draft
      {statusByKey}
      {workflows}
      {fieldChanged}
      {fieldScopeLabel}
    />
  </SettingsSection>

  <SettingsSection {page} id="execution">
    <ExecutionRetryGroup
      fields={EXECUTION_RETRY_FIELDS}
      bind:draft
      {statusByKey}
      {workflows}
      {fieldChanged}
      {fieldScopeLabel}
    />
  </SettingsSection>

  {@render queues?.()}

  <SettingsSection {page} id="logging">
    <AuditLoggingGroup
      fields={AUDIT_LOGGING_FIELDS}
      transportUsage={snapshot.generalSettings?.transportUsage}
      bind:draft
      {statusByKey}
      {workflows}
      {fieldChanged}
      {fieldScopeLabel}
    />
  </SettingsSection>

  <SettingsSection {page} id="privacy">
    <GeneralSettingsHeader
      settings={currentSettings}
      {draft}
      {sessionArtifacts}
      {chooseProfile}
    />
  </SettingsSection>

  <SettingsSection {page} id="trust">
    <UiTrustGroup
      {snapshot}
      fields={UI_TRUST_FIELDS}
      bind:draft
      {statusByKey}
      {workflows}
      {fieldChanged}
      {fieldScopeLabel}
    />
  </SettingsSection>
</div>

<style>
  /* The tab holds five of the page's sections and the slot for a sixth (Queues), one shown at a
     time, each group a `.sg .section` whose top margin spaces it, so the tab sets no gap of its
     own. The page scrolls; the tab does not. */
  /* The header's own rules moved with its markup into
   * `general/GeneralSettingsHeader.svelte` — Svelte scopes styles per
   * component, so leaving them here would have styled nothing. */
</style>
