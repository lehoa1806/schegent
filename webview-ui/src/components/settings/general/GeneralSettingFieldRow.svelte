<script lang="ts">
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
  import type { PortableWorkflowDefinition } from '../../../lib/snapshot-types';
  // FR-R3-144 (T031) — a VALUE import, from `src/contracts/` as the import-direction
  // rule requires. See `onEnumChange` for why a predicate rather than a cast.
  import { isBackendRunnerKind } from '../../../../../src/contracts/backend-kinds';
  import type { Draft, FieldSpec, FieldStatus, ScalarKey } from './field-types';
  import { OUTCOME_NOT_YET_KNOWN_TEXT } from '../../../lib/boundary-refusal-text';
  import { isTransportUsage, type TransportUsage } from '../../../../../src/contracts/sidebar-ipc/transport-usage';
  import { transportUsageLine } from './settings-draft';
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
  type EnumKey = 'cliEnvironmentMode' | 'backendRunner' | 'transportCaptureMode';
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
    workflows: readonly PortableWorkflowDefinition[];
    /** FR-R4-F04 (FR-003) — only the transport mode row is given one; absent means nothing is shown. */
    transportUsage?: TransportUsage;
  }

  let {
    spec,
    draft = $bindable(),
    status,
    changed,
    scopeLabel,
    workflows,
    transportUsage
  }: Props = $props();

  function fieldLabelId(key: ScalarKey): string {
    return `general-settings-label-${key}`;
  }
  function unitLabelId(key: ScalarKey): string {
    return `general-settings-unit-${key}`;
  }

  /** A number is read with its unit ("Keep audit events for days"), as the row draws it. */
  const numberLabelledBy = $derived(
    spec.unit === undefined ? fieldLabelId(spec.key) : `${fieldLabelId(spec.key)} ${unitLabelId(spec.key)}`
  );

  /**
   * A toggle shows the setting, or its opposite for an `inverted` spec: the multi-root row asks
   * whether to warn, and the setting stores whether to suppress the warning.
   */
  const toggleOn = $derived(
    spec.inverted === true ? !draft[spec.key as BooleanKey] : draft[spec.key as BooleanKey]
  );

  function onToggle(event: Event): void {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    draft[spec.key as BooleanKey] = spec.inverted === true ? !checked : checked;
  }

  /** A boolean drawn as a select of its two outcomes, whose option values are `false` and `true`. */
  function onChoiceChange(event: Event): void {
    draft[spec.key as BooleanKey] = (event.currentTarget as HTMLSelectElement).value === 'true';
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

<!--
  The redesign's setting row (`.srow`): the label and its notes on the left; on the right the
  control, then where the setting applies. A changed row carries the mockup's dot beside its
  label; the page header saves and reverts every row at once, so the row has no Save or Reset.
-->
<div
  class="srow field-row"
  data-testid="general-settings-field-{spec.key}"
  data-changed={changed}
  data-status={status?.status ?? 'idle'}
>
  <div class="field-label">
    <div class="lab">
      <span class="field-name" id={fieldLabelId(spec.key)}>{spec.label}</span>
      {#if changed}
        <span class="mod" role="img" aria-label="changed, not saved"></span>
      {/if}
    </div>
    {#if spec.note}
      <!-- FR-R3-143 (T031, T032) — static text, deliberately not a hover-text:
           a disclosure the operator has to hover to find is one they change the
           setting without. No `controlId`, so it creates no dangling surface. -->
      <p class="desc field-note" data-testid="general-settings-note-{spec.key}">{spec.note}</p>
    {/if}
    {#if spec.key === 'transportCaptureMode' && transportUsage !== undefined && isTransportUsage(transportUsage)}
      <!-- FR-R4-F04 (FR-003, O4) — what is kept and when it ages out, from the host's cached measure. Static
           text for the reason the note above is; nothing is shown until the host has measured. -->
      <p class="desc field-note" data-testid="general-settings-transport-usage">{transportUsageLine(transportUsage)}</p>
    {/if}
  </div>
  <div class="ctl">
    {#if spec.kind === 'boolean' && spec.choices !== undefined}
      <!-- A boolean whose two values are outcomes rather than on and off: the select names them. -->
      <select
        class="input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        value={draft[spec.key as BooleanKey] ? 'true' : 'false'}
        onchange={onChoiceChange}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <option value="false">{spec.choices.false}</option>
        <option value="true">{spec.choices.true}</option>
      </select>
    {:else if spec.kind === 'boolean'}
      <label class="toggle">
        <input
          type="checkbox"
          aria-labelledby={fieldLabelId(spec.key)}
          checked={toggleOn}
          onchange={onToggle}
          data-testid="general-settings-input-{spec.key}"
          use:hoverTextAnchor={{
            controlId: spec.key,
            description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
          }}
        />
        <span>{toggleOn ? 'On' : 'Off'}</span>
      </label>
    {:else if spec.kind === 'number'}
      <!-- `wide`: a size in bytes, whose largest value the mockup's narrow value field
           would cut off. -->
      <span class="unit" class:wide={spec.wide === true}>
        <input
          type="number"
          aria-labelledby={numberLabelledBy}
          class="input"
          min={spec.min}
          max={spec.max}
          data-testid="general-settings-input-{spec.key}"
          use:hoverTextAnchor={{
            controlId: spec.key,
            description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
          }}
          bind:value={draft[spec.key as NumberKey]}
        />
        {#if spec.unit !== undefined}
          <span class="muted" id={unitLabelId(spec.key)}>{spec.unit}</span>
        {/if}
      </span>
    {:else if spec.kind === 'workflow-select'}
      <select
        class="input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.defaultWorkflowId}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <!-- Feature 098 (T049, FR-033a) — the current value needs a row of its
             own whenever no Workflow carries it, or the bound value and the
             displayed one diverge. Unset is the common case now, and it reads
             as a named state rather than a blank line. Feature 285 (FR-003):
             the rows are the effective Workflows, never Pipelines. -->
        {#if !workflows.some((w) => w.workflowId === draft.defaultWorkflowId)}
          <option value={draft.defaultWorkflowId}>
            {draft.defaultWorkflowId === '' ? 'No default' : draft.defaultWorkflowId}
          </option>
        {/if}
        {#each workflows as w (w.workflowId)}
          <option value={w.workflowId}>{w.name} ({w.workflowId})</option>
        {/each}
      </select>
    {:else if spec.kind === 'number-optional'}
      <!-- `wide`: this field's unset state is its placeholder, a sentence ("Unset — no
           limit") that the mockup's narrow value field would cut off, so the field takes
           the row's width up to its unit. -->
      <span class="unit wide">
        <input
          type="number"
          aria-labelledby={numberLabelledBy}
          class="input"
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
        {#if spec.unit !== undefined}
          <span class="muted" id={unitLabelId(spec.key)}>{spec.unit}</span>
        {/if}
      </span>
    {:else if spec.kind === 'level-select'}
      <select
        class="input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.runtimeLogLevel}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <option value="DEBUG">Debug</option>
        <option value="INFO">Info</option>
        <option value="WARN">Warning</option>
        <option value="ERROR">Error</option>
      </select>
    {:else if spec.kind === 'raw-transcript-select'}
      <select
        class="input"
        aria-labelledby={fieldLabelId(spec.key)}
        data-testid="general-settings-input-{spec.key}"
        bind:value={draft.rawTranscriptMode}
        use:hoverTextAnchor={{
          controlId: spec.key,
          description: GENERAL_SETTINGS_DESCRIPTIONS[spec.key]
        }}
      >
        <option value="errors-only">Unless the run completes</option>
        <option value="always">Always</option>
        <option value="off">Never</option>
      </select>
    {:else if spec.kind === 'enum'}
      <!-- FR-R3-143 (T029) — the generic enum. A value shows as the words its spec's
           `optionLabels` gives it, or as itself (see `FieldKind` in field-types.ts). -->
      <select
        class="input"
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
          <option value={option}>{spec.optionLabels?.[option] ?? option}</option>
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
        class="input"
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
    <span class="hint" data-testid="general-settings-scope-{spec.key}">Applies to: {scopeLabel}</span>
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
        {:else if status.status === 'unknown'}
          <span class="status-text">{OUTCOME_NOT_YET_KNOWN_TEXT}</span>
        {:else}
          <span class="status-text">Rejected{status.reason ? `: ${status.reason}` : ''}</span>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* The `.sg .srow` rules draw the row, and `.sg .unit` a number with its unit after it. These
     place what the mockup's row has no slot for: the notes under the label, the width a clearable
     number's placeholder or a size in bytes needs, and the row's save status. */
  .field-label .desc {
    margin: var(--schegent-space-1) 0 0;
    line-height: 1.4;
  }

  .ctl .unit.wide .input {
    flex: 1;
    width: auto;
    min-width: 0;
  }

  .ctl .toggle {
    align-self: flex-start;
    cursor: pointer;
  }

  .ctl .field-status {
    font-size: var(--schegent-text-secondary);
  }
  .field-status.status-pending,
  .field-status.status-unknown { color: var(--schegent-muted-fg); }
  .field-status.status-accepted { color: var(--schegent-status-completed-text); }
  .field-status.status-rejected { color: var(--schegent-error-text); }
</style>
