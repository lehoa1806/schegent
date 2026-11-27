<script lang="ts">
  // The left half of the Workflow editor's head (`.ed-head`): breadcrumb
  // (`Workflows / [Parent /] <Current v>`), status chips, and floating
  // workflow switcher popover (`0 px` shift of toolbar or canvas; Escape and
  // outside-click dismissal).
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
    /** Returns from the full-page editor to the Workflows list view. */
    onclose?: () => void;
  }

  const {
    rows,
    selected,
    selectedKey,
    lifecycleByKey,
    dirty = false,
    breadcrumbs = [],
    onselect,
    onbreadcrumbselect,
    onclose
  }: Props = $props();

  const LIST_ID = 'workflow-picker-list';

  let open = $state(false);
  let switcher = $state<HTMLSpanElement | undefined>(undefined);
  let toggle = $state<HTMLButtonElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);

  const currentName = $derived(
    selected ? selected.name || selected.workflowId : 'No Workflow selected'
  );
  const lifecycle = $derived(selected ? lifecycleByKey.get(selected.sourceKey) : undefined);
  const stateView = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);

  function choose(sourceKey: string): void {
    const focusInList = list?.contains(document.activeElement) === true;
    onselect(sourceKey);
    open = false;
    if (focusInList) toggle?.focus();
  }

  function togglePicker(): void {
    open = !open;
    if (open) {
      flushSync();
      const row =
        list?.querySelector<HTMLElement>('[aria-current="true"]') ??
        list?.querySelector<HTMLElement>('button');
      row?.focus();
    }
  }

  function handleCrumbListClick(): void {
    open = false;
    if (onclose) {
      onclose();
      return;
    }
    togglePicker();
  }

  $effect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (event.target instanceof Node && switcher?.contains(event.target) === true) return;
      open = false;
    }
    function onWindowKeydown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      const focusInList = list?.contains(document.activeElement) === true;
      open = false;
      if (focusInList) toggle?.focus();
    }
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onWindowKeydown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onWindowKeydown, true);
    };
  });
</script>

<div class="wf-topbar" data-testid="workflow-topbar">
  <nav class="crumbs" aria-label="Breadcrumb" data-testid="workflow-breadcrumbs">
    <button
      type="button"
      class="linkbtn"
      data-testid="workflow-crumb-list"
      onclick={handleCrumbListClick}>Workflows</button
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
    <span class="wf-switcher" bind:this={switcher}>
      <button
        type="button"
        class="cur"
        bind:this={toggle}
        data-testid="workflow-picker-toggle"
        aria-expanded={open}
        aria-controls={open ? LIST_ID : undefined}
        aria-label="{currentName}, switch workflow"
        onclick={togglePicker}
      >
        <span class="cur-name" data-testid="workflow-breadcrumb-current">{currentName}</span>
        <svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg>
      </button>

      {#if open}
        <div
          class="wf-picker-pop"
          id={LIST_ID}
          bind:this={list}
          data-testid="workflow-picker-list"
        >
          <WorkflowLibraryList {rows} {selectedKey} {lifecycleByKey} onselect={choose} />
          {#if rows.length === 0}
            <div class="wf-picker-empty" data-testid="workflow-picker-empty">No Workflow yet.</div>
          {/if}
        </div>
      {/if}
    </span>
  </nav>

  {#if selected}
    {#if lifecycle && stateView}
      <span class="chip {STATE_TONE_CLASSES[lifecycle.state]}" data-testid="workflow-topbar-state"
        ><span class="dot" aria-hidden="true"></span>{stateView.stateBadge}</span
      >
    {/if}
    <span
      class="chip status-{selected.sourceStatus} {selected.sourceStatus === 'invalid'
        ? 's-err'
        : 's-idle'}"
      data-testid="workflow-topbar-status"
      ><svg class="i" aria-hidden="true"
        ><use href={selected.sourceStatus === 'invalid' ? '#i-warn' : '#i-check'}></use></svg
      >{selected.sourceStatus}</span
    >
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
</div>

<style>
  .wf-topbar {
    display: contents;
  }

  .wf-switcher {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .cur-name {
    max-width: 32ch;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* True floating popover overlaying the canvas without shifting the toolbar
     or canvas in document flow (Feature 326). */
  .wf-picker-pop {
    position: absolute;
    top: calc(100% + var(--schegent-space-1));
    left: 0;
    z-index: var(--schegent-z-popover);
    min-width: 300px;
    max-width: min(460px, 90vw);
    max-height: 340px;
    overflow-y: auto;
    padding: var(--schegent-space-2);
    background: var(--schegent-surface);
    color: var(--schegent-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    box-shadow: var(--schegent-shadow-popover);
  }
</style>
