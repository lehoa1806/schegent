<script lang="ts">
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import {
    GENERAL_SETTINGS_DESCRIPTIONS,
    type GeneralSettingsControlId
  } from '../GeneralSettingsTab.descriptions';
  import type { PipelineDefinition } from '../../../lib/snapshot-types';
  // FR-R3-144 (T031) — a VALUE import, from `src/contracts/` as the import-direction
  // rule requires. See `onEnumChange` for why a predicate rather than a cast.
  import { isBackendRunnerKind } from '../../../../../src/contracts/backend-kinds';
  import type { Draft, FieldSpec, FieldStatus, ScalarKey } from './field-types';
  import StringListField from './StringListField.svelte';

  // FR-R3-143 (T003) — `ScalarKey`, `FieldKind` and `FieldSpec` now come from
  // `field-types.ts`. The per-kind key unions below stay: they narrow `draft`
  // for this component's bindings and have no counterpart in the tab.
  type StringKey = 'cliPath' | 'codexPath' | 'agyPath' | 'runtimeLogFilePath';
  type BooleanKey =
    | 'loggingVerbose'
    | 'retryForceContinueOnCap'
    | 'cliInheritEnvironment'
    | 'uiConfirmationsEnable'
    | 'multiRootSuppressWarning';
  type NumberKey =
    | 'loopMaxIterations'
    | 'invocationIdleTimeoutSeconds'
    | 'invocationMaxDurationSeconds'
    | 'watchdogPollIntervalMinutes'
    | 'auditRotationSizeMB'
    | 'auditRotationMaxAgeDays'
    | 'retryMaxAttempts'
    | 'runtimeLogMaxBytes'
    | 'runtimeLogMaxGenerations'
    | 'backendProbeTimeoutSeconds';
  // FR-R3-143 (T029, T030) — one member each so far. Written as unions anyway:
  // both kinds are generic, and the `-add` / `-remove-<i>` description keys the
  // list editor needs are indexed off this type, so a second list setting is a
  // member here and three description entries, not another component.
  type EnumKey = 'cliEnvironmentMode' | 'backendRunner';
  type StringListKey = 'cliEnvironmentAllowlist';
  // FR-R3-144 (T036) — the keys whose "no value" is `null` rather than a number.
  // `settings-draft.ts` holds the same set as `CLEARABLE_KEYS`, for the change
  // comparison; this union is the narrowing the bindings below need.
  type ClearableNumberKey =
    | 'claudeAutoCompactPctOverride'
    | 'spendMaxUsdPerRun'
    | 'spendMaxTokensPerRun';

  interface Props {
    spec: FieldSpec;
    draft: Draft;
    status: FieldStatus | undefined;
    changed: boolean;
    scopeLabel: string;
    pipelines: readonly PipelineDefinition[];
    onSave: () => void;
    onReset: () => void;
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
    actionsAppend
  }: Props & { actionsAppend?: import('svelte').Snippet } = $props();

  function saveId(key: ScalarKey): GeneralSettingsControlId {
    return `${key}-save`;
  }
  function resetId(key: ScalarKey): GeneralSettingsControlId {
    return `${key}-reset`;
  }
  function fieldLabelId(key: ScalarKey): string {
    return `general-settings-label-${key}`;
  }

  function onStringInput(event: Event): void {
    draft[spec.key as StringKey] = (event.currentTarget as HTMLInputElement).value;
  }

  /**
   * FR-R3-144 (T036) — `step="1"` was right for a percentage and wrong for a
   * dollar bound whose manifest minimum is `0.01`: a browser refuses a fractional
   * entry against an integer step, so the operator could not type the smallest
   * bound the host accepts. A spec whose own minimum is fractional accepts
   * fractions; every other clearable number keeps the integer step it had.
   */
  const numberStep = $derived((spec.min ?? 1) < 1 ? 'any' : '1');

  /**
   * FR-R3-144 (T031) — the generic enum's write path.
   *
   * `bind:value` cannot serve two enum keys once their draft types differ:
   * `cliEnvironmentMode` is a `string` and `backendRunner` is `BackendRunnerKind`,
   * so a write through `draft[spec.key as EnumKey]` would have to be assignable to
   * both, and a `<select>` yields a bare `string`. The cast that would silence
   * that is exactly the wrong instrument — the value comes from the DOM, so it is
   * external input at a boundary, and the honest move is to CHECK it. A backend id
   * that is not one this build supports is dropped rather than written into the
   * draft, where it would be posted on the next Save and rejected by the host.
   */
  function onEnumChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (spec.key === 'backendRunner') {
      if (isBackendRunnerKind(value)) draft.backendRunner = value;
      return;
    }
    draft[spec.key as Exclude<EnumKey, 'backendRunner'>] = value;
  }

  /**
   * FR-R3-144 (T036) — the clearable-number input's write path, for WHICHEVER key
   * the spec names.
   *
   * This was `onAutoCompactInput`, threaded from `GeneralSettingsTab` through
   * every group to this one arm, and hardwired to `claudeAutoCompactPctOverride`
   * at both ends: the input's `value` read that field by name and the handler
   * wrote it by name. One `kind: 'number-optional'` field could exist, and it had
   * to be Claude's. The two per-run spend bounds are the second and third, so the
   * key comes from `spec` like every other arm's does, and the handler that had to
   * be passed down four levels to reach the component that owns the input is gone
   * from all of them.
   *
   * Empty input is `null` — the clear sentinel the host translates to
   * `config.update(key, undefined)` — and so is anything non-finite, so a
   * half-typed `1e` clears rather than writing `NaN` into the draft.
   */
  function onClearableNumberInput(event: Event): void {
    const raw = (event.currentTarget as HTMLInputElement).value;
    const parsed = raw === '' ? Number.NaN : Number(raw);
    draft[spec.key as ClearableNumberKey] = Number.isFinite(parsed) ? parsed : null;
  }
</script>

<div
  class="field-row"
  data-testid="general-settings-field-{spec.key}"
  data-changed={changed}
  data-status={status?.status ?? 'idle'}
>
  <div class="field-label">
    <span class="field-name" id={fieldLabelId(spec.key)}>{spec.label}</span>
    <span class="field-scope" data-testid="general-settings-scope-{spec.key}">
      Scope: {scopeLabel}
    </span>
  </div>
  <div class="field-input">
    {#if spec.kind === 'boolean'}
      <label class="checkbox-label">
        <input
          type="checkbox"
          aria-labelledby={fieldLabelId(spec.key)}
          bind:checked={draft[spec.key as BooleanKey]}
          data-testid="general-settings-input-{spec.key}"
          use:hoverTextAnchor={{
            controlId: spec.key,
            description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
          }}
        />
        <span>{draft[spec.key as BooleanKey] ? 'On' : 'Off'}</span>
      </label>
    {:else if spec.kind === 'number'}
      <input
        type="number"
        aria-labelledby={fieldLabelId(spec.key)}
        class="text-input"
        min={spec.min}
        max={spec.max}
        data-testid="general-settings-input-{spec.key}"
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
        bind:value={draft[spec.key as NumberKey]}
      />
    {:else if spec.kind === 'pipeline-select'}
      <select
        class="select-input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.defaultPipelineId}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <!-- Feature 098 (T049, FR-033a) — the current value needs a row of its
             own whenever no Pipeline carries it, or the bound value and the
             displayed one diverge. Unset is the common case now, and it reads
             as a named state rather than a blank line. -->
        {#if !pipelines.some((p) => p.id === draft.defaultPipelineId)}
          <option value={draft.defaultPipelineId}>
            {draft.defaultPipelineId === '' ? 'No default' : draft.defaultPipelineId}
          </option>
        {/if}
        {#each pipelines as p (p.id)}
          <option value={p.id}>{p.name} ({p.id})</option>
        {/each}
      </select>
    {:else if spec.kind === 'number-optional'}
      <input
        type="number"
        aria-labelledby={fieldLabelId(spec.key)}
        class="text-input"
        min={spec.min}
        max={spec.max}
        step={numberStep}
        placeholder={spec.placeholder ?? ''}
        data-testid="general-settings-input-{spec.key}"
        value={draft[spec.key as ClearableNumberKey] ?? ''}
        oninput={onClearableNumberInput}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      />
    {:else if spec.kind === 'level-select'}
      <select
        class="select-input"
        aria-labelledby={fieldLabelId(spec.key)}
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
    {:else if spec.kind === 'raw-transcript-select'}
      <select
        class="select-input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.rawTranscriptMode}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <option value="always">Always retain</option>
        <option value="errors-only">Errors only</option>
        <option value="off">Off</option>
      </select>
    {:else if spec.kind === 'enum'}
      <!-- FR-R3-143 (T029) — the generic enum. Values are rendered as their own
           labels, which is what makes it generic; a kind whose labels differ
           from its values stays bespoke (see `FieldKind` in field-types.ts). -->
      <select
        class="select-input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        value={draft[spec.key as EnumKey]}
        onchange={onEnumChange}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        {#each spec.options ?? [] as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else if spec.kind === 'string-list'}
      <StringListField
        bind:value={draft[spec.key as StringListKey]}
        itemPattern={spec.itemPattern}
        invalidMessage={spec.invalidMessage}
        controlIdPrefix={spec.key}
        labelledBy={fieldLabelId(spec.key)}
        inputDescription={GENERAL_SETTINGS_DESCRIPTIONS[spec.key as StringListKey]}
        addDescription={GENERAL_SETTINGS_DESCRIPTIONS[`${spec.key as StringListKey}-add`]}
        removeDescription={GENERAL_SETTINGS_DESCRIPTIONS[`${spec.key as StringListKey}-remove`]}
      />
    {:else}
      <input
        type="text"
        aria-labelledby={fieldLabelId(spec.key)}
        class="text-input"
        placeholder={spec.placeholder ?? ''}
        data-testid="general-settings-input-{spec.key}"
        value={draft[spec.key as StringKey]}
        oninput={onStringInput}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      />
    {/if}
    {#if spec.note}
      <!-- FR-R3-143 (T031, T032) — static text, deliberately not a hover-text:
           a disclosure the operator has to hover to find is one they change the
           setting without. No `controlId`, so it creates no dangling surface. -->
      <p class="field-note" data-testid="general-settings-note-{spec.key}">{spec.note}</p>
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
    {@render actionsAppend?.()}
  </div>
  {#if status}
    <div
      class="field-status status-{status.status}"
      data-testid="general-settings-status-{spec.key}"
      role={status.status === 'rejected' ? 'alert' : 'status'}
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
    grid-template-columns: minmax(180px, 0.8fr) minmax(260px, 1.2fr) auto;
    grid-template-rows: auto auto;
    grid-template-areas:
      "label input actions"
      "status status status";
    gap: 4px 12px;
    padding: 12px;
    border: 0;
    border-bottom: 1px solid var(--schegent-divider);
    background: transparent;
    align-items: center;
  }
  .field-row[data-changed="true"] {
    background: var(--schegent-surface-selected);
    box-shadow: inset 0 0 0 1px var(--schegent-focus-border);
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
    letter-spacing: 0.02em;
  }
  .field-input { grid-area: input; }
  .field-note {
    margin: 4px 0 0;
    font-size: 0.8em;
    line-height: 1.4;
    color: var(--schegent-muted-fg);
  }
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
  .field-status.status-rejected { color: var(--schegent-error-text); }
  .text-input, .select-input {
    background: var(--vscode-input-background);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    padding: 4px 8px;
    border-radius: var(--schegent-radius-sm);
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
