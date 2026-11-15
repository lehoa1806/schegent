<script lang="ts">
  // The open Phase as a page of its own: a breadcrumb back to the list, the Phase's title and status,
  // its actions, and the form beside a Summary of where it is used, its lifecycle and its issues.
  //
  // While it is open it stands in for the Builder's title and tabs (PipelineBuilder asks
  // `phaseEditorOpen` for that), so the breadcrumb is the way back to the list. Every action keeps
  // the handler, test id and disabled rule it had in the single-card editor this replaces; the
  // ones the redesign tucks away moved into the "More phase actions" menu.
  import type { Snippet } from 'svelte';
  import type { BuilderLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';
  import DefinitionLifecyclePanel from '../Builder/DefinitionLifecyclePanel.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import ProcessExportButton from '../ProcessImport/ProcessExportButton.svelte';
  import { phaseExportAvailability } from '../ProcessImport/process-exchange-entry';
  import RawJsonPhaseEditor from '../settings/RawJsonPhaseEditor.svelte';
  import SgMenu from '../sg/SgMenu.svelte';
  import { authoredPhaseDocument } from './phase-catalog-state';
  import { phaseErrorId } from './phase-catalog-view';
  import PhaseEditorForm from './PhaseEditorForm.svelte';
  import type { MutablePhase, PhaseEditState } from './types';
  import { dependentWorkflowsForPhase } from './workflow-catalog-state';

  interface Props {
    snapshot: WorkflowSnapshot;
    phase: MutablePhase;
    /** The Phase's position in the authored list, which every write addresses. */
    index: number;
    /** How many Phases the list holds, so the last one cannot move further down. */
    phaseCount: number;
    editState: PhaseEditState;
    /** Absent on a host with no catalog store wired. */
    lifecycle?: BuilderLifecycle;
    /** Every Workflow definition the Builder knows, to find the ones that use this Phase. */
    workflows: Parameters<typeof dependentWorkflowsForPhase>[1];
    readOnly: boolean;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    retryConditionsTrusted: boolean;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    /** The catalog's banners and warnings, drawn under the header. */
    notices?: Snippet;
    /** Back to the list. */
    onclose: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onphasechange: (index: number, patch: Partial<MutablePhase>) => void;
    onmoveup: (index: number) => void;
    onmovedown: (index: number) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ontoggleraw: (phaseId: string) => void;
    onrawsave: (index: number, parsed: Record<string, unknown>) => void;
    ontoggleretry: (index: number) => void;
    onretrychange: (index: number, event: { source: string; valid: boolean }) => void;
    onduplicate: (index: number) => void;
    onopenworkflow?: (workflowId: string) => void;
  }

  const {
    snapshot,
    phase,
    index,
    phaseCount,
    editState,
    lifecycle,
    workflows,
    readOnly,
    historyIndex,
    historyLength,
    trusted,
    retryConditionsTrusted,
    savePending,
    mutationActive,
    editableSourceKey,
    notices,
    onclose,
    onremove,
    onreset,
    onphasechange,
    onmoveup,
    onmovedown,
    onundo,
    onredo,
    onsave,
    ontoggleraw,
    onrawsave,
    ontoggleretry,
    onretrychange,
    onduplicate,
    onopenworkflow
  }: Props = $props();

  const exportable = $derived(phaseExportAvailability(phase));
  const dependents = $derived(dependentWorkflowsForPhase(phase.id, workflows));
  /** Whether the pending edit is this Phase's: only then has it changes to save or revert. */
  const editing = $derived(mutationActive && editableSourceKey === phase.sourceKey);
  /** A move is refused while any edit is pending, as the list's own move buttons always were. */
  const moveBlocked = $derived(!trusted || savePending || mutationActive);

  /**
   * The page opens from a row of the list, and that row's button leaves with the list, so focus
   * would drop to the document. It goes to the title instead; focus the operator put somewhere
   * else stays where it is.
   */
  function focusIfIdle(node: HTMLElement): void {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) node.focus();
  }
</script>

<div class="phase-editor-page" data-testid="phases-editor-{phase.id}">
  <!-- Where you are, what this Phase is and its state, then what you can do with it. -->
  <div class="phead">
    <div>
      <nav class="crumbs" aria-label="Breadcrumb">
        <button type="button" class="linkbtn" data-testid="phases-editor-back" onclick={onclose}>Phases</button>
        <span class="muted" aria-hidden="true">/</span>
      </nav>
      <div class="titlerow">
        <h1 class="phase-title" tabindex="-1" use:focusIfIdle>{phase.name || 'Untitled Phase'}</h1>
        <span class="mono muted small">{phase.id}</span>
        <DefinitionLifecycleRow definitionId={phase.id} {lifecycle} validity={phase.sourceStatus} />
        {#if phase.modelAvailable === false}
          <span class="chip s-err"><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>model unavailable</span>
        {/if}
        {#if editing}
          <span class="chip s-warn" data-testid="phases-editor-unsaved">Unsaved changes</span>
        {/if}
      </div>
    </div>
    <div class="actions">
      <button type="button" class="icon-btn" aria-label="Undo" title="Undo" disabled={!trusted || savePending || historyIndex <= 0} onclick={onundo}><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg></button>
      <button type="button" class="icon-btn" aria-label="Redo" title="Redo" disabled={!trusted || savePending || historyIndex >= historyLength - 1} onclick={onredo}><svg class="i" aria-hidden="true"><use href="#i-redo"></use></svg></button>
      <span class="sep" aria-hidden="true"></span>
      <SgMenu label="More phase actions" testid="phases-editor-menu">
        {#if !readOnly}
          <button type="button" role="menuitem" data-testid="phases-raw-json-toggle" onclick={() => ontoggleraw(phase.sourceKey)}>{editState.rawJsonMode ? 'Form view' : 'Edit as JSON'}</button>
        {/if}
        <button type="button" role="menuitem" data-testid="phases-duplicate" aria-disabled={moveBlocked} onclick={() => onduplicate(index)}><svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>Duplicate</button>
        <!-- Feature 099 (T494a, FR-043) — every row is reorderable against every other: one layer
             leaves no neighbour in a different one. -->
        <button type="button" role="menuitem" data-testid="phases-move-up-{phase.id}" aria-disabled={moveBlocked || index === 0} onclick={() => onmoveup(index)}>Move up</button>
        <button type="button" role="menuitem" data-testid="phases-move-down-{phase.id}" aria-disabled={moveBlocked || index === phaseCount - 1} onclick={() => onmovedown(index)}>Move down</button>
        <!-- FR-052 — Export is per phase, writes a file the operator names
             and changes no catalog state; shown here in the editor header
             rather than the sidebar to reduce visual clutter. -->
        <ProcessExportButton
          phaseId={phase.id}
          rowKey={phase.sourceKey}
          resolves={exportable.resolves}
          disabledReason={exportable.disabledReason}
        />
        <button type="button" role="menuitem" data-testid="phases-revert" aria-disabled={readOnly || !editing} onclick={() => onreset(index)}><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg>Revert unsaved changes</button>
        {#if !readOnly}
          <hr />
          <!-- A deactivation, not a delete: the Phase stays in the catalog and can be restored, so
               the item says what it does. The confirmation returns focus to this menu's button. -->
          <button type="button" role="menuitem" data-testid="phases-remove" aria-disabled={!trusted || savePending} onclick={(event) => onremove(index, event.currentTarget)}>Deactivate…</button>
        {/if}
      </SgMenu>
      <button type="button" class="btn btn-primary" data-testid="phases-save-all" disabled={!trusted || savePending || !mutationActive} onclick={onsave}>{savePending ? 'Saving…' : 'Save'}</button>
    </div>
  </div>

  {@render notices?.()}

  <div class="ed-grid">
    <div>
      {#if editState.rawJsonMode}
        <div class="form-sec">
          <RawJsonPhaseEditor
            phase={authoredPhaseDocument(phase)}
            onsave={(parsed) => onrawsave(index, parsed as Record<string, unknown>)}
          />
        </div>
      {:else}
        <PhaseEditorForm {snapshot} {phase} {index} {readOnly} {retryConditionsTrusted} {onphasechange} {ontoggleretry} {onretrychange} />
      {/if}
    </div>

    <aside class="card phase-summary" aria-labelledby="phase-summary-h">
      <h2 id="phase-summary-h">Summary</h2>
      <dl class="kv">
        <dt>Used by</dt>
        <dd data-testid="phase-dependent-workflows">
          {#each dependents as w, i (w.workflowId)}
            {#if i > 0},{/if}
            {#if onopenworkflow}
              <button type="button" class="linkbtn" data-testid="phase-dependent-workflow-{w.workflowId}" onclick={() => onopenworkflow(w.workflowId)}>{w.name || w.workflowId}</button>
            {:else}
              {w.name || w.workflowId}
            {/if}
          {:else}
            <span class="muted">None</span>
          {/each}
        </dd>
      </dl>
      <!-- Feature 186 (US1, T008, D-1, D-3) — the open Phase's lifecycle
           facts and actions. -->
      <DefinitionLifecyclePanel
        kind="phase"
        definitionId={phase.id}
        definitionName={phase.name || 'Untitled Phase'}
        {lifecycle}
        defects={phase.sourceErrors}
      />
      <h3>Issues</h3>
      {#if phase.sourceErrors.length > 0}
        <div class="field-errors" id={phaseErrorId(phase)} role="alert">
          {#each phase.sourceErrors as error}
            <div><strong>{error.field}:</strong> {error.message}</div>
          {/each}
        </div>
      {:else}
        <p class="small muted">None.</p>
      {/if}
    </aside>
  </div>
</div>

<style>
  /* sg-pages' `.phead`, `.crumbs` and `.titlerow` head the page, sg-builder's `.ed-grid` sets the
     form beside the Summary, and sg-core's `.kv` lists the Summary's facts. These place what the
     redesign sets inline. */
  .phase-title:focus {
    outline: none;
  }

  /* The redesign's Summary is one key and value list. Here Used by is the page's own row and
     Created, Modified and Active version are the lifecycle panel's, so the card is a two-column
     grid and both lists are subgrids of it: one key column for every fact. Everything else spans
     the card. Grid items' margins do not collapse, so the panel takes the list's own 5px row gap
     and the Used by list keeps no bottom margin. */
  .phase-summary {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    column-gap: var(--schegent-space-4);
    align-content: start;
  }

  .phase-summary > :global(*),
  .phase-summary :global(.definition-lifecycle-panel > *) {
    grid-column: 1 / -1;
  }

  .phase-summary .kv,
  .phase-summary :global(.definition-lifecycle-panel),
  .phase-summary :global(.definition-lifecycle-panel > .kv) {
    grid-template-columns: subgrid;
  }

  .phase-summary :global(.definition-lifecycle-panel) {
    display: grid;
    margin-top: 5px;
  }

  .phase-summary h2 {
    font-size: var(--schegent-text-body);
    margin: 0 0 var(--schegent-space-2);
  }

  .phase-summary h3 {
    font-size: var(--schegent-text-secondary);
    margin: var(--schegent-space-3-5) 0 var(--schegent-space-1-5);
  }

  .phase-summary p {
    margin: 0;
  }

  .phase-summary .field-errors {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1);
    font-size: var(--schegent-text-secondary);
  }
</style>
