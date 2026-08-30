<script lang="ts">
  import GeneralSettingFieldRow from './GeneralSettingFieldRow.svelte';
  import type { SettingsGroupProps } from './field-types';

  let {
    fields,
    draft = $bindable(),
    statusByKey,
    pipelines,
    fieldChanged,
    fieldScopeLabel,
    saveOne,
    resetField
  }: SettingsGroupProps = $props();
</script>

<!--
  FR-R3-143 (T006) — `open` is not a style choice. A collapsed group would put
  every description key in `orphanKeys` (hover-text-coverage collects the DOM
  unfiltered) and would hide its controls from the 44px touch-target check,
  which skips 0x0 rects.
-->
<details class="settings-group" data-testid="settings-group-execution-retry" open>
  <summary>Execution, queues, and retry</summary>
  <div class="field-list">
    {#each fields as spec (spec.key)}
      <GeneralSettingFieldRow
        {spec}
        bind:draft
        status={statusByKey[spec.key]}
        changed={fieldChanged(spec.key)}
        scopeLabel={fieldScopeLabel(spec.key)}
        {pipelines}
        onSave={() => saveOne(spec)}
        onReset={() => resetField(spec.key)}
      />
    {/each}
  </div>
</details>
<style>
  .settings-group {
    border: 1px solid var(--schegent-divider);
    border-radius: var(--schegent-radius);
  }
  .settings-group > summary {
    padding: 8px 10px;
    font-weight: 600;
    font-size: 0.95em;
    cursor: pointer;
    list-style: revert;
  }
  .settings-group > summary:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .field-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border-top: 1px solid var(--schegent-divider);
  }
</style>
