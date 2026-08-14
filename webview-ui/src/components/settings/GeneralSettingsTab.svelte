<script lang="ts">
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS, IDLE_SESSION_ARTIFACTS } from '../../lib/snapshot-types';
  import { saveGeneralSettings } from '../../lib/save-general-settings';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from './GeneralSettingsTab.descriptions';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import GeneralSettingFieldRow from './general/GeneralSettingFieldRow.svelte';
  import BackendHealthSection from './BackendHealthSection.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  type ScalarKey =
    | 'cliPath'
    | 'codexPath'
    | 'agyPath'
    | 'loggingVerbose'
    | 'loopMaxIterations'
    | 'invocationTimeoutSeconds'
    | 'watchdogPollIntervalMinutes'
    | 'auditRotationSizeMB'
    | 'auditRotationMaxAgeDays'
    | 'defaultPipelineId'
    | 'claudeAutoCompactPctOverride'
    | 'runtimeLogLevel'
    | 'runtimeLogFilePath'
    | 'sessionRetentionMaxAgeDays'
    | 'sessionRetentionMaxBytes'
    | 'rawTranscriptMode';

  type FieldKind =
    | 'string'
    | 'boolean'
    | 'number'
    | 'pipeline-select'
    | 'number-optional'
    | 'level-select'
    | 'raw-transcript-select';

  interface FieldSpec {
    readonly key: ScalarKey;
    // Wire-format IPC key (defaults to `key`). Feature 012 uses dotted
    // names like `claude.autoCompactPctOverride` for the new override.
    readonly ipcKey?: string;
    readonly label: string;
    readonly kind: FieldKind;
    readonly min?: number;
    readonly max?: number;
    readonly placeholder?: string;
  }

  // Per FR-020 we surface every scalar `schegent.*` key. fatalSignatures
  // is intentionally handled by FatalSignaturesTab (array-of-string).
  const BACKEND_FIELDS: readonly FieldSpec[] = [
    { key: 'cliPath', ipcKey: 'cli.path', label: 'Claude CLI Path', kind: 'string' },
    { key: 'codexPath', ipcKey: 'codex.path', label: 'Codex CLI Path', kind: 'string' },
    { key: 'agyPath', ipcKey: 'agy.path', label: 'Agy CLI Path', kind: 'string' }
  ] as const;

  const GENERAL_FIELDS: readonly FieldSpec[] = [
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
    { key: 'loopMaxIterations', ipcKey: 'loop.maxIterations', label: 'Loop Max Iterations', kind: 'number', min: 1, max: 100 },
    { key: 'invocationTimeoutSeconds', ipcKey: 'invocation.timeoutSeconds', label: 'Invocation Timeout (seconds)', kind: 'number', min: 60, max: 7200 },
    { key: 'watchdogPollIntervalMinutes', ipcKey: 'watchdog.pollIntervalMinutes', label: 'Watchdog Poll Interval (minutes)', kind: 'number', min: 1, max: 240 },
    { key: 'auditRotationSizeMB', ipcKey: 'audit.rotation.sizeMB', label: 'Audit Rotation Size (MB)', kind: 'number', min: 1, max: 100 },
    { key: 'auditRotationMaxAgeDays', ipcKey: 'audit.rotation.maxAgeDays', label: 'Audit Retention (days)', kind: 'number', min: 1, max: 365 },
    { key: 'defaultPipelineId', ipcKey: 'defaultPipelineId', label: 'Default Pipeline', kind: 'pipeline-select' },
    {
      key: 'claudeAutoCompactPctOverride',
      ipcKey: 'claude.autoCompactPctOverride',
      label: 'Claude auto-compaction threshold (%)',
      kind: 'number-optional',
      min: 1,
      max: 100,
      placeholder: 'Unset — use CLI default'
    }
  ] as const;

  const FIELDS = [...BACKEND_FIELDS, ...GENERAL_FIELDS] as const;

  const currentSettings = $derived<GeneralSettings>(
    snapshot.generalSettings ?? IDLE_GENERAL_SETTINGS
  );
  const sessionArtifacts = $derived(snapshot.sessionArtifacts ?? IDLE_SESSION_ARTIFACTS);
  const sessionBudgetPercent = $derived(
    currentSettings.sessionRetentionMaxBytes > 0
      ? Math.round((sessionArtifacts.totalBytes / currentSettings.sessionRetentionMaxBytes) * 100)
      : 0
  );
  const sessionUsageWarning = $derived(
    sessionArtifacts.lastSweepFailures > 0 || sessionBudgetPercent >= 80
  );

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  // Local draft separate from the projected settings — we only commit
  // a key on Save so users can revert via reload-without-save.
  type Draft = {
    cliPath: string;
    codexPath: string;
    agyPath: string;
    loggingVerbose: boolean;
    loopMaxIterations: number;
    invocationTimeoutSeconds: number;
    watchdogPollIntervalMinutes: number;
    auditRotationSizeMB: number;
    auditRotationMaxAgeDays: number;
    defaultPipelineId: string;
    // Feature 012: `null` is the "clear / use CLI default" sentinel; the
    // host translates a payload of `null` to `config.update(key, undefined)`.
    claudeAutoCompactPctOverride: number | null;
    // Feature 019: runtime debug log sink controls.
    runtimeLogLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    runtimeLogFilePath: string;
    sessionRetentionMaxAgeDays: number;
    sessionRetentionMaxBytes: number;
    rawTranscriptMode: 'always' | 'errors-only' | 'off';
  };

  function snapshotToDraft(s: GeneralSettings): Draft {
    return {
      cliPath: s.cliPath,
      codexPath: s.codexPath,
      agyPath: s.agyPath,
      loggingVerbose: s.loggingVerbose,
      loopMaxIterations: s.loopMaxIterations,
      invocationTimeoutSeconds: s.invocationTimeoutSeconds,
      watchdogPollIntervalMinutes: s.watchdogPollIntervalMinutes,
      auditRotationSizeMB: s.auditRotationSizeMB,
      auditRotationMaxAgeDays: s.auditRotationMaxAgeDays,
      defaultPipelineId: s.defaultPipelineId,
      claudeAutoCompactPctOverride: s.claudeAutoCompactPctOverride ?? null,
      runtimeLogLevel: s.runtimeLogLevel,
      runtimeLogFilePath: s.runtimeLogFilePath,
      sessionRetentionMaxAgeDays: s.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: s.sessionRetentionMaxBytes,
      rawTranscriptMode: s.rawTranscriptMode
    };
  }

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

  function fieldChanged(key: ScalarKey): boolean {
    const drafted = draft[key];
    const projected = currentSettings[key] as unknown;
    // Feature 012: treat null draft == undefined projection as unchanged.
    if (key === 'claudeAutoCompactPctOverride') {
      const a = drafted ?? null;
      const b = projected ?? null;
      return a !== b;
    }
    return drafted !== projected;
  }

  function fieldScopeLabel(key: ScalarKey): string {
    const scope = currentSettings.scopes?.[key];
    if (!scope) return 'Unknown';
    return scope.charAt(0).toUpperCase() + scope.slice(1);
  }

  function ipcKeyFor(spec: { readonly key: ScalarKey; readonly ipcKey?: string }): string {
    return spec.ipcKey ?? spec.key;
  }

  // Map rejection reasons (Feature 012 T026) to user-friendly messages
  // for `claude.autoCompactPctOverride`. Other keys keep the raw reason.
  function friendlyReason(spec: { readonly key: ScalarKey }, reason?: string): string | undefined {
    if (!reason) return reason;
    if (spec.key !== 'claudeAutoCompactPctOverride') return reason;
    if (reason.startsWith('out-of-range:')) return 'Value must be an integer between 1 and 100';
    if (reason.startsWith('type-mismatch:')) return 'Value must be a whole number';
    if (reason.startsWith('clear-failed:')) return 'Failed to clear override — please retry';
    return reason;
  }

  async function saveOne(spec: { readonly key: ScalarKey; readonly ipcKey?: string }): Promise<void> {
    const key = spec.key;
    const value = draft[key];
    statusByKey = { ...statusByKey, [key]: { status: 'pending' } };
    const result = await saveGeneralSettings({ [ipcKeyFor(spec)]: value });
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
      (draft as Record<string, unknown>)[key] = currentSettings[key];
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
  <header class="tab-header">
    <h2>{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].title}</h2>
    <p class="hint">{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].body}</p>
    <div class:usage-warning={sessionUsageWarning} class="session-usage" data-testid="session-artifact-usage">
      <strong>Unredacted local session artifacts:</strong>
      {sessionArtifacts.artifactCount} run{sessionArtifacts.artifactCount === 1 ? '' : 's'},
      {formatBytes(sessionArtifacts.totalBytes)} retained.
      {#if sessionArtifacts.lastSweepAt}
        Last swept {new Date(sessionArtifacts.lastSweepAt).toLocaleString()}.
      {:else}
        Waiting for the activation sweep.
      {/if}
      {#if sessionArtifacts.lastSweepFailures > 0}
        {sessionArtifacts.lastSweepFailures} retention operation{sessionArtifacts.lastSweepFailures === 1 ? '' : 's'} failed; inspect the sanitized runtime log.
      {/if}
      {#if sessionBudgetPercent >= 80}
        Usage is {sessionBudgetPercent}% of the configured byte budget.
      {/if}
    </div>
    <div class="toolbar">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="general-settings-save-all"
        disabled={!dirty}
        onclick={saveAll}
        use:hoverTextAnchor={{
          controlId: 'save-all',
          description: GENERAL_SETTINGS_DESCRIPTIONS['save-all']
        }}
      >Save All Changes</button>
      <button
        type="button"
        class="btn btn-ghost"
        data-testid="general-settings-reset-all"
        disabled={!dirty}
        onclick={resetAll}
        use:hoverTextAnchor={{
          controlId: 'reset-all',
          description: GENERAL_SETTINGS_DESCRIPTIONS['reset-all']
        }}
      >Reset All</button>
    </div>
  </header>

  <BackendHealthSection
    {snapshot}
    {BACKEND_FIELDS}
    bind:draft
    {statusByKey}
    {fieldChanged}
    {fieldScopeLabel}
    {pipelines}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />

  <div class="field-list">
    {#each GENERAL_FIELDS as spec (spec.key)}
      <GeneralSettingFieldRow
        {spec}
        bind:draft
        status={statusByKey[spec.key]}
        changed={fieldChanged(spec.key)}
        scopeLabel={fieldScopeLabel(spec.key)}
        {pipelines}
        onSave={() => saveOne(spec)}
        onReset={() => resetField(spec.key)}
        {onAutoCompactInput}
      />
    {/each}
  </div>
</section>

<style>
  .general-settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 8px 0;
    height: 100%;
  }
  .tab-header h2 {
    margin: 0 0 4px 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 12px 0;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
  .session-usage {
    margin: 0 0 12px 0;
    padding: 8px 10px;
    border: 1px solid var(--vscode-notificationsInfoIcon-foreground);
    border-radius: var(--schegent-radius);
    background: var(--vscode-textBlockQuote-background);
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    line-height: 1.45;
  }
  .usage-warning {
    border-color: var(--vscode-notificationsWarningIcon-foreground);
    color: var(--vscode-foreground);
  }
  .toolbar {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .btn {
    min-height: var(--schegent-control-height-compact);
    padding: 3px 10px;
    border-radius: var(--schegent-radius-sm);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--schegent-button-bg); color: var(--schegent-button-fg); }
  .btn-primary:hover:not(:disabled) { background: var(--schegent-button-hover); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }

  .field-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border-top: 1px solid var(--schegent-divider);
  }
</style>
