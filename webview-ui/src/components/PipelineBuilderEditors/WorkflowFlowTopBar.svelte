<script lang="ts">
  // The left half of the Workflow editor's head (`.ed-head`, which
  // WorkflowCatalogEditor owns): where the open Workflow sits, and what state it
  // is in. The redesign's breadcrumb (workflow_builder_redesign.html, the editor
  // head): "Workflows", any parent Workflow the operator opened a child from,
  // then the open Workflow's name with the chevron that switches it.
  //
  // The root is `display: contents`, so the crumbs and chips are items of the
  // head's own flex row and share it with WorkflowToolbar's actions on the right.
  //
  // The switcher opens the Library list, which is the redesign's list view in this
  // product: there is no separate list page. Keeping `WorkflowLibraryList` rather
  // than reimplementing a picker keeps its row summary — purpose, Pipeline
  // sequence, derived ports, validation state — and its lifecycle badges. A
  // bespoke dropdown would have dropped all of it.
  //
  // The head draws its own state and validity chips rather than mounting
  // `DefinitionLifecycleRow`: the list below it mounts one per row, and the open
  // Workflow's row would then carry its test handles twice.
  import { flushSync } from 'svelte';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import { deriveDefinitionRowView, STATE_TONE_CLASSES } from '../Builder/definition-row-state';
  import type { MutableWorkflow } from './types';
  import WorkflowLibraryList from './WorkflowLibraryList.svelte';

  export interface WorkflowBreadcrumbEntry {
    readonly sourceKey: string;
    readonly workflowId: string;
    readonly name: string;
    readonly fromNodeId?: string;
  }

  interface Props {
    rows: readonly MutableWorkflow[];
    selected: MutableWorkflow | null;
    selectedKey: string | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    dirty?: boolean;
    breadcrumbs?: readonly WorkflowBreadcrumbEntry[];
    onselect: (sourceKey: string) => void;
    onbreadcrumbselect?: (index: number) => void;
  }

  const {
    rows,
    selected,
    selectedKey,
    lifecycleByKey,
    dirty = false,
    breadcrumbs = [],
    onselect,
    onbreadcrumbselect
  }: Props = $props();

  /** The list's id: the switcher's `aria-controls` target while it is open. */
  const LIST_ID = 'workflow-picker-list';

  /**
   * Null until the operator opens or closes the picker themselves, and a boolean
   * after that.
   *
   * The default it falls back to is "open while nothing is selected": the Library
   * list moved in here, so the picker is now the only way to select a Workflow, and
   * starting closed with no selection would leave the operator looking at an empty
   * canvas with no visible way in. Held as an override rather than as an
   * initialised flag so the default is *derived* — a `$state` seeded from
   * `selected` would capture only its value at mount.
   */
  let overridden = $state<boolean | null>(null);
  const open = $derived(overridden ?? selected === null);

  let toggle = $state<HTMLButtonElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);

  const currentName = $derived(
    selected ? selected.name || selected.workflowId : 'No Workflow selected'
  );
  const lifecycle = $derived(selected ? lifecycleByKey.get(selected.sourceKey) : undefined);
  const stateView = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);

  function choose(sourceKey: string): void {
    onselect(sourceKey);
    overridden = false;
  }

  /**
   * The breadcrumb's root. In the redesign it leads back to the list page; here the
   * list is the switcher's, so the crumb opens it and moves focus to the open
   * Workflow's row (the first row when none is open), the way arriving on a list
   * page would. Set, then flushed with no callback, as the toolbar's export does.
   */
  function showList(): void {
    overridden = true;
    flushSync();
    const row =
      list?.querySelector<HTMLElement>('[aria-current="true"]') ??
      list?.querySelector<HTMLElement>('button');
    row?.focus();
  }

  /**
   * Escape closes the list from anywhere inside it, including from a row. A
   * dropdown that only closes by clicking its trigger again is a keyboard trap.
   * Focus on a row would be left on an element about to unmount, so it goes back
   * to the switcher.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return;
    const focusInList = list?.contains(document.activeElement) === true;
    overridden = false;
    if (focusInList) toggle?.focus();
  }
</script>

<div class="wf-topbar" data-testid="workflow-topbar" onkeydown={onKeydown} role="presentation">
  <nav class="crumbs" aria-label="Breadcrumb" data-testid="workflow-breadcrumbs">
    <button type="button" class="linkbtn" data-testid="workflow-crumb-list" onclick={showList}
      >Workflows</button
    >
    <span class="muted" aria-hidden="true">/</span>
    {#if selected}
      {#each breadcrumbs as crumb, index (crumb.sourceKey + '-' + index)}
        <button
          type="button"
          class="linkbtn"
          data-testid="workflow-breadcrumb-{index}"
          onclick={() => onbreadcrumbselect?.(index)}>{crumb.name || crumb.workflowId}</button
        >
        <span class="muted" aria-hidden="true">/</span>
      {/each}
    {/if}
    <!-- The name is the button's text and its label starts with it, so a voice
         command that reads the name finds the control (WCAG 2.5.3). -->
    <button
      type="button"
      class="cur"
      bind:this={toggle}
      data-testid="workflow-picker-toggle"
      aria-expanded={open}
      aria-controls={open ? LIST_ID : undefined}
      aria-label="{currentName}, switch workflow"
      onclick={() => (overridden = !open)}
    >
      <span class="cur-name" data-testid="workflow-breadcrumb-current">{currentName}</span>
      <svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg>
    </button>
  </nav>

  {#if selected}
    {#if lifecycle && stateView}
      <span class="chip {STATE_TONE_CLASSES[lifecycle.state]}" data-testid="workflow-topbar-state"
        ><span class="dot" aria-hidden="true"></span>{stateView.stateBadge}</span
      >
    {/if}
    <!-- The lowercase word the list rows show (FR-015), with an icon beside it so
         colour is never the only signal. -->
    <span
      class="chip status-{selected.sourceStatus} {selected.sourceStatus === 'invalid'
        ? 's-err'
        : 's-idle'}"
      data-testid="workflow-topbar-status"
      ><svg class="i" aria-hidden="true"
        ><use href={selected.sourceStatus === 'invalid' ? '#i-warn' : '#i-check'}></use></svg
      >{selected.sourceStatus}</span
    >
    <!-- An unsaved draft is the one state the canvas cannot infer from the
         canvas: it looks identical to a stored row until a save is attempted. -->
    {#if !selected.persisted}
      <span class="chip st-modified" data-testid="workflow-topbar-unsaved"
        ><span class="dot" aria-hidden="true"></span>Unsaved draft</span
      >
    {:else if dirty}
      <span class="chip st-modified" data-testid="workflow-topbar-dirty"
        ><span class="dot" aria-hidden="true"></span>Unsaved changes</span
      >
    {/if}
  {/if}

  {#if open}
    <div class="wf-picker-pop" id={LIST_ID} bind:this={list} data-testid="workflow-picker-list">
      <WorkflowLibraryList {rows} {selectedKey} {lifecycleByKey} onselect={choose} />
      <!-- Outside the list: an empty catalog is not a row. `CatalogEmptyState`
           below the head owns the guidance; this only explains the blank. -->
      {#if rows.length === 0}
        <div class="wf-picker-empty" data-testid="workflow-picker-empty">No Workflow yet.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* No box of its own: the crumbs, the chips and the list are items of the head's
     flex row (sg-builder.css `.ed-head`), and the actions at its right end are
     WorkflowToolbar's. sg-builder.css draws the crumbs and the switcher (`.cur`),
     sg-core the chips. */
  .wf-topbar {
    display: contents;
  }

  /* A long name gives way before the actions do. The switcher's label still
     carries all of it. */
  .cur-name {
    max-width: 32ch;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Feature 186 (US2/US3, T016, FR-005, D-5) — the list stays in document flow,
     so its default-open state pushes the canvas and the guidance down instead of
     covering them. A full-width basis breaks it onto a line of its own, and
     `order` puts that line under the actions, whatever the DOM order. */
  .wf-picker-pop {
    order: 1;
    flex: 0 0 100%;
    max-height: 340px;
    overflow-y: auto;
    padding: var(--schegent-space-2);
    background: var(--schegent-surface-raised);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
  }
</style>
