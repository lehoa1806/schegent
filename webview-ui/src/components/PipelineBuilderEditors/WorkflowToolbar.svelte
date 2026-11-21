<script lang="ts">
  // Feature 083 (US5, T059) — the Workflow editor head's actions.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget. It holds no rules: every control is
  // enabled by a flag the editor derives, and every click calls back.
  //
  // The two destructive controls raise their handler and nothing else — the
  // confirmation lives with the mutation it authorises, in
  // `workflow-catalog-actions.ts`, so this file has no way to send a write and
  // no way to skip the prompt.
  //
  // Feature 086 T017 — Export is the one control here that owns its own rule, and
  // deliberately so. Every other control mutates, so its gate is a mutation gate
  // the editor derives from trust, readiness, and a pending save. Export writes
  // nothing this extension owns (research R2), needs neither trust nor an idle
  // save, and shares none of those flags; its single precondition is that the
  // catalog actually holds the row, which is readable from the selection itself.
  // Deriving it in the editor would mean threading a flag whose inputs live here.
  //
  // Feature 099 (T494a, FR-043) — no scope picker. A save had a destination to
  // choose while there were three layers; there is one, so the control is gone.
  //
  // Feature 100 (FR-R3-016) T509b — and Reset Catalog is gone with it. It emptied
  // the layer in one write, which the store can no longer do: definitions are
  // addressed by id and removal is one confirmed deactivation each. A button whose
  // atomicity the store does not provide is a button that lies, so it is deleted
  // rather than reimplemented as a loop behind a single prompt.
  //
  // The redesign (workflow_builder_redesign.html, the editor head) sets these at
  // the right end of the head's row, beside WorkflowFlowTopBar's breadcrumb (the
  // switcher's open list pushes them onto a line under it, feature 186 D-5): Undo
  // and Redo as icon buttons, every other action in the "More workflow actions"
  // menu, and Save as the one primary button. The mockup's Publish stays in the
  // inspector's lifecycle panel, as on the Phase editor, and its Version history
  // is that panel's History. "New workflow" joins the menu: the mockup moves it to
  // a list page (its pin 3), and this product's list is the switcher's. Save
  // carries no shortcut hint, because the Builder binds no shortcut.
  import { flushSync } from 'svelte';
  import type { WorkflowExportInclusion } from '../../lib/messages';
  import { exportWorkflowYaml } from '../../lib/process-yaml-ipc';
  import SgMenu from '../sg/SgMenu.svelte';
  import type { MutableWorkflow } from './types';

  /**
   * Feature 086 T023 (FR-013) — the depths this control offers, each with the
   * words an operator decides by rather than the identifier the request carries.
   *
   * A list, not a boolean, because a Workflow has two levels of dependency below
   * it: "the Pipelines" and "the Pipelines and their Phases" are different
   * answers and neither is the negation of the other. The Pipeline equivalent is
   * a checkbox precisely because one level admits only two depths.
   *
   * Every arm of `WorkflowExportInclusion`, and only because each one now has a
   * host arm that produces its payload (T028). The list was deliberately shorter
   * while `included.phases` was unrendered: a control offering a depth the
   * exporter ignored would have handed back a document missing the payload it
   * named with no error to say so. An option lands with its host arm, never ahead
   * of it.
   */
  const INCLUSIONS: readonly { readonly value: WorkflowExportInclusion; readonly label: string }[] =
    [
      { value: 'references-only', label: 'References only' },
      { value: 'include-closure', label: 'Include child Workflows and Phases' }
    ];

  /** The reason's id: Export's description, on the menu item that offers it. */
  const EXPORT_REASON_ID = 'workflows-export-reason';

  interface Props {
    savePending: boolean;
    mutatingDisabled: boolean;
    /** The effective Pipeline catalog resolved and holds nothing (FR-045). */
    noPipelines: boolean;
    duplicateDisabled: boolean;
    removeDisabled: boolean;
    saveDisabled: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    canReset?: boolean;
    /** The Library row in focus, or null when nothing is selected. */
    selected: MutableWorkflow | null;
    onadd: () => void;
    onduplicate: () => void;
    onremove: (event: MouseEvent) => void;
    onsave: () => void;
    onundo?: () => void;
    onredo?: () => void;
    onreset?: () => void;
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
    onadd,
    onduplicate,
    onremove,
    onsave,
    onundo,
    onredo,
    onreset
  }: Props = $props();

  /**
   * Why the selected Workflow cannot be exported, or `null` when it can.
   *
   * An unsaved draft is the one case decided here: export reads the catalog, and
   * a draft is not in it yet, so the host would answer `not-found` for an id it
   * has never seen (US1 scenario 3). Saying so beside the control is better than
   * sending a request whose only possible answer is a refusal.
   *
   * Nothing else is pre-checked. A stored Workflow whose Pipelines are missing
   * from every layer is still exportable, graph intact (FR-016) — refusing it
   * here would break the exact case that requirement exists for. Whether a row
   * resolves is the host's decision, because only the host reads the effective
   * catalog and only it can tell a missing reference from a structural defect.
   */
  const exportDisabledReason = $derived(
    selected === null || selected.persisted
      ? null
      : 'Save this Workflow first. Export writes the definition the catalog holds, not an unsaved draft.'
  );

  /** Nothing to export, or a draft the catalog does not hold yet. */
  const exportDisabled = $derived(selected === null || exportDisabledReason !== null);

  /**
   * Feature 086 T023 (FR-013) — the inclusion choice, made BEFORE the document is
   * produced rather than discovered in the save dialog after it.
   *
   * A property of how this operator is handing the definition over, not of the
   * Workflow, so it survives changing the selection instead of resetting under
   * someone exporting several rows in a row. Nothing is persisted: it describes
   * one session's exports, and the default is the smallest document (FR-013).
   */
  let inclusion = $state<WorkflowExportInclusion>('references-only');

  /**
   * Which Workflow the export panel is open for, or null while it is closed.
   *
   * The mockup's "Export YAML…" exports at once; here it takes one more input,
   * the inclusion depth above, so the item opens a small panel under the actions
   * instead. Keyed to the selection, so choosing another Workflow never leaves
   * the panel offering the first one's export.
   */
  let exportFor = $state<string | null>(null);
  const exportShown = $derived(!exportDisabled && exportFor === selected?.sourceKey);

  let actions = $state<HTMLDivElement | undefined>(undefined);
  let exportPanel = $state<HTMLDivElement | undefined>(undefined);
  let inclusionSelect = $state<HTMLSelectElement | undefined>(undefined);

  /**
   * Flushed first, so the select is rendered and focusable before the menu closes
   * behind this click: the menu then finds focus outside itself and leaves it
   * there. Set, then flushed with no callback: the callback form keeps a branch of
   * Svelte's runtime in the chunk the sidebar loads at startup.
   */
  function openExport(): void {
    if (selected === null) return;
    exportFor = selected.sourceKey;
    flushSync();
    inclusionSelect?.focus();
  }

  /** Closes the panel and hands focus back to the menu button it came from. */
  function closeExport(): void {
    exportFor = null;
    actions?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  }

  /**
   * FR-013 / FR-015 — references only unless the operator asked for the
   * definitions. Either way `spec` is untouched: inclusion adds a section and
   * never rewrites a node's `pipelineId` into an inline body (FR-009).
   *
   * Whether every referenced Pipeline actually resolves is the host's call
   * (FR-016, FR-018): only it reads the effective catalog, and only it can tell a
   * missing reference from a structural defect. Pre-checking here would refuse
   * exports the host would have allowed and would need a second copy of the
   * resolution rule to do it.
   *
   * No location is named here and none comes back: the host opens its own save
   * dialog (FR-019, FR-057).
   */
  function onExport(): void {
    if (exportDisabledReason !== null || selected === null) return;
    exportWorkflowYaml(selected.workflowId, inclusion);
    closeExport();
  }

  /** Escape leaves the panel without exporting. The menu behind it is closed already. */
  function onExportKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeExport();
  }

  /**
   * Focus moving to a control outside the panel closes it. Focus that goes
   * nowhere (a press on the page, another window) leaves that to the press.
   */
  function onExportFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || exportPanel?.contains(next) === true) return;
    exportFor = null;
  }

  // A press outside the open panel dismisses it, as one outside the menu
  // dismisses the menu.
  $effect(() => {
    if (!exportShown) return;
    function onPointerDown(event: MouseEvent): void {
      if (event.target instanceof Node && exportPanel?.contains(event.target) === true) return;
      exportFor = null;
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  });
</script>

<div class="push" bind:this={actions}>
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
      data-testid="workflows-add"
      aria-disabled={mutatingDisabled}
      onclick={onadd}
      ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>New workflow</button
    >
    <button
      type="button"
      role="menuitem"
      data-testid="workflows-duplicate"
      aria-disabled={duplicateDisabled}
      onclick={onduplicate}
      ><svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>Duplicate</button
    >
    {#if onreset}
      <button
        type="button"
        role="menuitem"
        data-testid="workflows-discard"
        aria-disabled={mutatingDisabled || !canReset}
        onclick={onreset}
        ><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg>Revert unsaved changes</button
      >
    {/if}
    <!-- Export is read-only: it needs neither trust nor an idle save, because it
         writes nothing this extension owns. When it cannot run, the reason sits
         under its word, so an operator does not have to guess why it is dead.
         The label keeps the reason out of the item's name; it is the description. -->
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
    <hr />
    <!-- A deactivation, not a delete (`deactivateDefinition`): the Workflow stays
         in the catalog and can be restored, so the item says what it does. The
         confirmation returns focus to this menu's button. -->
    <button
      type="button"
      role="menuitem"
      class="danger"
      data-testid="workflows-remove"
      aria-disabled={removeDisabled}
      onclick={onremove}><svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>Deactivate…</button
    >
  </SgMenu>
  <button
    type="button"
    class="btn btn-primary"
    data-testid="workflows-save-all"
    disabled={saveDisabled}
    onclick={onsave}>{savePending ? 'Saving…' : 'Save'}</button
  >
  <!-- FR-013 — the depth is chosen before the document is produced rather than
       after. Disabled on exactly the condition Export is: there is no depth to
       choose for a row that cannot be exported at all. -->
  <div
    class="export-pop"
    role="dialog"
    tabindex="-1"
    aria-label="Export YAML"
    data-testid="workflows-export-panel"
    hidden={!exportShown}
    bind:this={exportPanel}
    onkeydown={onExportKeydown}
    onfocusout={onExportFocusOut}
  >
    <label class="field">
      <span>Include</span>
      <select
        class="input"
        data-testid="workflows-export-inclusion"
        bind:this={inclusionSelect}
        value={inclusion}
        disabled={exportDisabled}
        title="How much of the Workflow's dependencies the document carries"
        onchange={(event) => (inclusion = event.currentTarget.value as WorkflowExportInclusion)}
      >
        {#each INCLUSIONS as depth (depth.value)}
          <option value={depth.value}>{depth.label}</option>
        {/each}
      </select>
    </label>
    <div class="export-acts">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        data-testid="workflows-export-cancel"
        onclick={closeExport}>Cancel</button
      >
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="workflows-export"
        disabled={exportDisabled}
        title={exportDisabledReason ?? 'Export the selected Workflow as a document'}
        aria-describedby={exportDisabledReason !== null ? EXPORT_REASON_ID : undefined}
        onclick={onExport}>Export</button
      >
    </div>
  </div>
</div>

<!--
  The explanation sits with the control it explains: a disabled Save with no
  reason beside it is the failure FR-045 exists to prevent. Announced politely
  so a refresh that resolves the prerequisite reaches a screen reader too.
-->
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
  /* sg-builder.css lays out the row (`.ed-head .push`) and sg-pages.css draws the
     menu and its items; this sheet adds only what these actions need beyond them. */

  /* sg-pages.css draws an item that is off; Export's reason keeps its own colour
     there, so it stays readable while the word and icon dim. */

  /* The reason takes a row of its own, under the word. A grid rather than a
     wrapping flex row: the menu sizes itself to its widest item, and a flex
     row's widest size holds every item on one line, so the reason would sit
     beside the word. `:global(.menu)` outranks sg-pages' `.menu button`, which
     makes every item a flex row. */
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

  /* Anchored under the actions (sg-builder.css makes `.push` its containing
     block) and over the canvas. Toggled with `hidden`, so no `display` here: one
     would override the attribute. */
  .export-pop {
    position: absolute;
    top: calc(100% + var(--schegent-space-1));
    right: 0;
    z-index: var(--schegent-z-popover);
    width: 280px;
    padding: var(--schegent-space-3);
    background: var(--schegent-surface);
    color: var(--schegent-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    box-shadow: var(--schegent-shadow-popover);
  }
  .export-acts {
    display: flex;
    justify-content: flex-end;
    gap: var(--schegent-space-1-5);
  }

  /* A line of its own under the head's row, whatever the DOM order. Two classes,
     to outrank sg-core's `.attn` margin rather than tie with it. */
  .attn.head-note {
    order: 1;
    flex: 0 0 100%;
    margin: 0;
  }
</style>
