<script lang="ts">
  // Feature 083 (US5, T059) & Feature 326 — the Workflow editor head's actions.
  //
  // Right side of `.ed-head`: Undo / Redo, divider, `⋯` (`Duplicate`,
  // `Export YAML…`, `Revert unsaved changes`, `<hr />`, `Deactivate…`), and
  // primary `Save`. `New workflow` moved to the Workflows list primary CTA;
  // export depth selection opens the shared `WorkflowExportDialog` modal.
  import type { WorkflowExportInclusion } from '../../lib/messages';
  import { exportWorkflowYaml } from '../../lib/process-yaml-ipc';
  import { workflowExportDisabledReason } from '../ProcessImport/process-exchange-entry';
  import SgMenu from '../sg/SgMenu.svelte';
  import WorkflowExportDialog from './WorkflowExportDialog.svelte';
  import type { MutableWorkflow } from './types';

  const EXPORT_REASON_ID = 'workflows-export-reason';

  interface Props {
    savePending: boolean;
    mutatingDisabled: boolean;
    /** The effective Phase/Pipeline catalog resolved and holds nothing (FR-045). */
    noPipelines: boolean;
    duplicateDisabled: boolean;
    removeDisabled: boolean;
    saveDisabled: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    canReset?: boolean;
    /** The open Workflow row, or null. */
    selected: MutableWorkflow | null;
    onduplicate: () => void;
    onremove: (event: MouseEvent) => void;
    onsave: () => void;
    onundo?: () => void;
    onredo?: () => void;
    onreset?: () => void;
    /** Optional parent-hosted export modal trigger (falls back to local dialog). */
    onopenexport?: (originatingElement: HTMLElement | null) => void;
  }

  const {
    savePending,
    mutatingDisabled,
    noPipelines,
    duplicateDisabled,
    removeDisabled,
    saveDisabled,
    canUndo = false,
    canRedo = false,
    canReset = false,
    selected,
    onduplicate,
    onremove,
    onsave,
    onundo,
    onredo,
    onreset,
    onopenexport
  }: Props = $props();

  const exportDisabledReason = $derived(workflowExportDisabledReason(selected));
  const exportDisabled = $derived(selected === null || exportDisabledReason !== null);

  let localInclusion = $state<WorkflowExportInclusion>('references-only');
  let localExportFor = $state<string | null>(null);
  let localExportOrigin = $state<HTMLElement | null>(null);
  const localExportShown = $derived(
    !onopenexport && !exportDisabled && selected !== null && localExportFor === selected.sourceKey
  );

  function openExport(event: MouseEvent): void {
    if (exportDisabled || selected === null) return;
    const origin = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (onopenexport) {
      onopenexport(origin);
      return;
    }
    localExportOrigin = origin;
    localExportFor = selected.sourceKey;
  }

  function confirmLocalExport(): void {
    if (exportDisabled || selected === null) return;
    exportWorkflowYaml(selected.workflowId, localInclusion);
    localExportFor = null;
  }
</script>

<div class="push">
  {#if onundo}
    <button
      type="button"
      class="icon-btn"
      id="wf-undo"
      data-testid="workflows-undo"
      aria-label="Undo"
      title="Undo"
      disabled={mutatingDisabled || !canUndo}
      onclick={onundo}><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg></button
    >
  {/if}
  {#if onredo}
    <button
      type="button"
      class="icon-btn"
      data-testid="workflows-redo"
      aria-label="Redo"
      title="Redo"
      disabled={mutatingDisabled || !canRedo}
      onclick={onredo}><svg class="i" aria-hidden="true"><use href="#i-redo"></use></svg></button
    >
  {/if}
  {#if onundo || onredo}
    <span class="sep" aria-hidden="true"></span>
  {/if}
  <SgMenu label="More workflow actions" testid="workflows-menu">
    <button
      type="button"
      role="menuitem"
      data-testid="workflows-duplicate"
      aria-disabled={duplicateDisabled}
      onclick={() => { if (!duplicateDisabled) onduplicate(); }}
      ><svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>Duplicate</button
    >
    <button
      type="button"
      role="menuitem"
      class="export-item"
      data-testid="workflows-export-open"
      aria-disabled={exportDisabled}
      aria-label="Export YAML"
      aria-describedby={exportDisabledReason !== null ? EXPORT_REASON_ID : undefined}
      onclick={openExport}
      ><svg class="i" aria-hidden="true"><use href="#i-export"></use></svg><span
        class="export-word">Export YAML…</span
      >{#if exportDisabledReason !== null}<span
          class="export-why"
          id={EXPORT_REASON_ID}
          data-testid="workflows-export-disabled-reason">{exportDisabledReason}</span
        >{/if}</button
    >
    {#if onreset}
      <button
        type="button"
        role="menuitem"
        data-testid="workflows-discard"
        aria-disabled={mutatingDisabled || !canReset}
        onclick={() => { if (!mutatingDisabled && canReset) onreset(); }}
        ><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg>Revert unsaved changes</button
      >
    {/if}
    <hr />
    <button
      type="button"
      role="menuitem"
      class="danger"
      data-testid="workflows-remove"
      aria-disabled={removeDisabled}
      onclick={(event) => { if (!removeDisabled) onremove(event); }}><svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>Deactivate…</button
    >
  </SgMenu>
  <button
    type="button"
    class="btn btn-primary"
    data-testid="workflows-save-all"
    disabled={saveDisabled}
    onclick={onsave}>{savePending ? 'Saving…' : 'Save'}</button
  >
</div>

{#if localExportShown && selected}
  <WorkflowExportDialog
    workflowId={selected.workflowId}
    workflowName={selected.name || selected.workflowId}
    inclusion={localInclusion}
    originatingElement={localExportOrigin}
    oninclusionchange={(value) => (localInclusion = value)}
    onconfirm={confirmLocalExport}
    oncancel={() => (localExportFor = null)}
  />
{/if}

{#if noPipelines}
  <div
    class="attn warn head-note"
    role="status"
    aria-live="polite"
    data-testid="workflows-no-pipelines"
  >
    <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
    <div class="body">
      No effective Phase is available. Every Workflow step runs a Phase or child Workflow, so add
      or publish at least one valid Phase in the Phases tab before saving a Workflow.
    </div>
  </div>
{/if}

<style>
  :global(.menu) .export-item {
    display: grid;
    grid-template-columns: auto 1fr;
    row-gap: var(--schegent-space-0-5);
  }
  .export-why {
    grid-column: 2;
    max-width: 32ch;
    white-space: normal;
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
  }

  .attn.head-note {
    order: 1;
    flex: 0 0 100%;
    margin: 0;
  }
</style>
