<script lang="ts">
  // Feature 083 (US5, T059) — the Library's action bar.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget. It holds no rules: every control is
  // enabled by a flag the editor derives, and every click calls back.
  //
  // The two destructive controls raise their handler and nothing else — the
  // confirmation lives with the mutation it authorises, in
  // `workflow-catalog-actions.ts`, so this file has no way to send a write and
  // no way to skip the prompt.
  import type { WritableWorkflowDefinitionScope } from '../../lib/snapshot-types';

  interface Props {
    scope: WritableWorkflowDefinitionScope;
    scopes: readonly WritableWorkflowDefinitionScope[];
    savePending: boolean;
    mutatingDisabled: boolean;
    /** The effective Pipeline catalog resolved and holds nothing (FR-045). */
    noPipelines: boolean;
    duplicateDisabled: boolean;
    removeDisabled: boolean;
    saveDisabled: boolean;
    onscope: (scope: WritableWorkflowDefinitionScope) => void;
    onadd: () => void;
    onduplicate: () => void;
    onremove: (event: MouseEvent) => void;
    onreset: (event: MouseEvent) => void;
    onsave: () => void;
  }

  const {
    scope,
    scopes,
    savePending,
    mutatingDisabled,
    noPipelines,
    duplicateDisabled,
    removeDisabled,
    saveDisabled,
    onscope,
    onadd,
    onduplicate,
    onremove,
    onreset,
    onsave
  }: Props = $props();
</script>

<div class="toolbar">
  <label class="scope-select">
    Scope
    <select
      data-testid="workflows-scope"
      value={scope}
      disabled={mutatingDisabled}
      aria-label="Workflow scope"
      onchange={(event) =>
        onscope(event.currentTarget.value as WritableWorkflowDefinitionScope)}
    >
      {#each scopes as writable (writable)}
        <option value={writable}>{writable}</option>
      {/each}
    </select>
  </label>
  <button
    class="btn btn-secondary"
    data-testid="workflows-duplicate"
    disabled={duplicateDisabled}
    onclick={onduplicate}
  >
    Duplicate
  </button>
  <button
    class="btn btn-primary"
    data-testid="workflows-add"
    onclick={onadd}
    disabled={mutatingDisabled}
  >
    Add Workflow
  </button>
  <button
    class="btn btn-secondary destructive"
    data-testid="workflows-remove"
    disabled={removeDisabled}
    onclick={onremove}
  >
    Delete
  </button>
  <button
    class="btn btn-secondary destructive"
    data-testid="workflows-reset"
    disabled={mutatingDisabled}
    onclick={onreset}
  >
    Reset Scope
  </button>
  <button
    class="btn btn-secondary"
    data-testid="workflows-save-all"
    style="margin-left:auto"
    onclick={onsave}
    disabled={saveDisabled}
  >
    {savePending ? 'Saving…' : 'Save Workflow'}
  </button>
</div>

<!--
  The explanation sits with the control it explains: a disabled Save with no
  reason beside it is the failure FR-045 exists to prevent. Announced politely
  so a refresh that resolves the prerequisite reaches a screen reader too.
-->
{#if noPipelines}
  <div
    class="catalog-state"
    role="status"
    aria-live="polite"
    data-testid="workflows-no-pipelines"
  >
    No effective Pipeline is available. Every Workflow node runs a Pipeline, so add or restore at
    least one valid Pipeline in the Pipeline Library before saving a Workflow.
  </div>
{/if}
