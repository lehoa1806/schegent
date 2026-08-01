<script lang="ts">
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import {
    GENERAL_SETTINGS_DESCRIPTIONS,
    type GeneralSettingsControlId
  } from '../GeneralSettingsTab.descriptions';
  import type { PipelineDefinition } from '../../../lib/snapshot-types';

  type ScalarKey =
    | 'cliPath'
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
    | 'sessionRetentionMaxBytes';

  type FieldKind =
    | 'string'
    | 'boolean'
    | 'number'
    | 'pipeline-select'
    | 'number-optional'
    | 'level-select';

  interface FieldSpec {
    readonly key: ScalarKey;
    readonly ipcKey?: string;
    readonly label: string;
    readonly kind: FieldKind;
    readonly min?: number;
    readonly max?: number;
    readonly placeholder?: string;
  }

  type Draft = {
    cliPath: string;
    loggingVerbose: boolean;
    loopMaxIterations: number;
    invocationTimeoutSeconds: number;
    watchdogPollIntervalMinutes: number;
    auditRotationSizeMB: number;
    auditRotationMaxAgeDays: number;
    defaultPipelineId: string;
    claudeAutoCompactPctOverride: number | null;
    runtimeLogLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    runtimeLogFilePath: string;
    sessionRetentionMaxAgeDays: number;
    sessionRetentionMaxBytes: number;
  };

  interface FieldStatus {
    status: 'pending' | 'accepted' | 'rejected';
    reason?: string;
  }

  interface Props {
    spec: FieldSpec;
    draft: Draft;
    status: FieldStatus | undefined;
    changed: boolean;
    scopeLabel: string;
    pipelines: readonly PipelineDefinition[];
    onSave: () => void;
    onReset: () => void;
    onAutoCompactInput: (ev: Event) => void;
  }

  let {
    spec,
    draft = $bindable(),
    status,
    changed,
    scopeLabel,
    pipelines,
    onSave,
    onReset,
    onAutoCompactInput
  }: Props = $props();

  function saveId(key: ScalarKey): GeneralSettingsControlId {
    return `${key}-save`;
  }
  function resetId(key: ScalarKey): GeneralSettingsControlId {
    return `${key}-reset`;
  }
</script>

<div
  class="field-row"
  data-testid="general-settings-field-{spec.key}"
  data-changed={changed}
  data-status={status?.status ?? 'idle'}
>
  <div class="field-label">
    <span class="field-name">{spec.label}</span>
    <span class="field-scope" data-testid="general-settings-scope-{spec.key}">
      Scope: {scopeLabel}
    </span>
  </div>
  <div class="field-input">
    {#if spec.kind === 'boolean'}
      <label class="checkbox-label">
        <input
          type="checkbox"
          bind:checked={draft[spec.key as 'loggingVerbose']}
          data-testid="general-settings-input-{spec.key}"
          use:hoverTextAnchor={{
            controlId: spec.key,
            description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
          }}
        />
        <span>{draft[spec.key as 'loggingVerbose'] ? 'On' : 'Off'}</span>
      </label>
    {:else if spec.kind === 'number'}
      <input
        type="number"
        class="text-input"
        min={spec.min}
        max={spec.max}
        data-testid="general-settings-input-{spec.key}"
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
        bind:value={
          draft[
            spec.key as
              | 'loopMaxIterations'
              | 'invocationTimeoutSeconds'
              | 'watchdogPollIntervalMinutes'
              | 'auditRotationSizeMB'
              | 'auditRotationMaxAgeDays'
          ]
        }
      />
    {:else if spec.kind === 'pipeline-select'}
      <select
        class="select-input"
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.defaultPipelineId}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        {#if pipelines.length === 0}
          <option value={draft.defaultPipelineId}>{draft.defaultPipelineId}</option>
        {/if}
        {#each pipelines as p (p.id)}
          <option value={p.id}>{p.name} ({p.id})</option>
        {/each}
      </select>
    {:else if spec.kind === 'number-optional'}
      <input
        type="number"
        class="text-input"
        min={spec.min}
        max={spec.max}
        step="1"
        placeholder={spec.placeholder ?? ''}
        data-testid="general-settings-input-{spec.key}"
        value={draft.claudeAutoCompactPctOverride ?? ''}
        oninput={onAutoCompactInput}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      />
    {:else if spec.kind === 'level-select'}
      <select
        class="select-input"
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.runtimeLogLevel}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <option value="DEBUG">DEBUG</option>
        <option value="INFO">INFO</option>
        <option value="WARN">WARN</option>
        <option value="ERROR">ERROR</option>
      </select>
    {:else}
      <input
        type="text"
        class="text-input"
        placeholder={spec.placeholder ?? ''}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft[spec.key as 'cliPath' | 'runtimeLogFilePath']}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      />
    {/if}
  </div>
  <div class="field-actions">
    <button
      type="button"
      class="btn btn-primary"
      data-testid="general-settings-save-{spec.key}"
      disabled={!changed || status?.status === 'pending'}
      onclick={onSave}
      use:hoverTextAnchor={{
        controlId: saveId(spec.key),
        description: GENERAL_SETTINGS_DESCRIPTIONS[saveId(spec.key)]
      }}
    >Save</button>
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="general-settings-reset-{spec.key}"
      disabled={!changed}
      onclick={onReset}
      use:hoverTextAnchor={{
        controlId: resetId(spec.key),
        description: GENERAL_SETTINGS_DESCRIPTIONS[resetId(spec.key)]
      }}
    >Reset</button>
  </div>
  {#if status}
    <div
      class="field-status status-{status.status}"
      data-testid="general-settings-status-{spec.key}"
    >
      {#if status.status === 'pending'}
        <span class="status-text">Saving…</span>
      {:else if status.status === 'accepted'}
        <span class="status-text">Saved</span>
      {:else}
        <span class="status-text">Rejected{status.reason ? `: ${status.reason}` : ''}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    grid-template-rows: auto auto;
    grid-template-areas:
      "label input actions"
      "status status status";
    gap: 4px 12px;
    padding: 12px;
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    align-items: center;
  }
  .field-row[data-changed="true"] {
    border-color: var(--schegent-focus-border);
  }
  .field-label {
    grid-area: label;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .field-name { font-weight: 600; }
  .field-scope {
    font-size: 0.75em;
    color: var(--schegent-muted-fg);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .field-input { grid-area: input; }
  .field-actions {
    grid-area: actions;
    display: flex;
    gap: 8px;
  }
  .field-status {
    grid-area: status;
    font-size: 0.85em;
  }
  .field-status.status-pending { color: var(--schegent-muted-fg); }
  .field-status.status-accepted { color: var(--vscode-charts-green); }
  .field-status.status-rejected { color: var(--schegent-color-error); }
  .text-input, .select-input {
    background: var(--vscode-input-background);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    padding: 4px 8px;
    border-radius: var(--schegent-radius);
    width: 100%;
    box-sizing: border-box;
  }
  .text-input:focus, .select-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
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
  @media (max-width: 720px) {
    .field-row {
      grid-template-columns: 1fr;
      grid-template-areas:
        "label"
        "input"
        "actions"
        "status";
    }
  }
</style>
