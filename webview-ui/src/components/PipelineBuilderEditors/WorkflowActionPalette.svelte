<script lang="ts">
  // Feature 183 (US2, T015, FR-007) / FR-R5-F05 — the "Add steps" palette
  // (workflow_builder_redesign.html, 3.4).
  //
  // Offers atomic Phases (`kind: 'phase'`), reusable child Workflows
  // (`kind: 'workflow'`, never the open one) and Logic (`Split`). Pipelines are
  // accepted but not offered: they are transitional, and only count toward
  // whether the catalog is empty. The search narrows every group at once, and
  // `/` moves focus to it from anywhere but a field or an open popup.
  //
  // Whether the palette is collapsed is the caller's state, so it survives a
  // re-render of this component; without `ontoggle` there is no toggle.
  import { tick } from 'svelte';
  import type {
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition
  } from '../../lib/snapshot-types';
  import type { WorkflowNodeTarget } from './workflow-catalog-state';

  interface Props {
    pipelines: readonly PortablePipelineDefinition[];
    phases?: readonly PortablePhaseDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
    currentWorkflowId?: string;
    readonly: boolean;
    /** The node a `Split` click will branch from, or null when nothing can split. */
    splitTargetId: string | null;
    onaddnode: (target: WorkflowNodeTarget) => void;
    onaddsplit: () => void;
    /** True while the palette shows only its toggle. */
    collapsed?: boolean;
    /** Flips `collapsed`. The toggle renders only when this is set. */
    ontoggle?: () => void;
  }

  /** One row of the palette: what it shows, and what a click adds. */
  interface Entry {
    readonly kind: 'phase' | 'workflow' | 'logic';
    /** A whole sprite reference, so the sprite test can check it names a symbol. */
    readonly icon: string;
    readonly name: string;
    /** The definition id, shown in mono. Logic has none. */
    readonly id: string | null;
    readonly detail: string;
    readonly testid: string;
    readonly disabled: boolean;
    readonly add: () => void;
  }

  const BODY_ID = 'workflow-palette-body';
  const GROUP_PHASES_ID = 'workflow-palette-phases';
  const GROUP_WORKFLOWS_ID = 'workflow-palette-workflows';
  const GROUP_LOGIC_ID = 'workflow-palette-logic';
  const DETAIL_SEPARATOR = ' · ';
  const SEARCH_KEY = '/';
  const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  /** Popups that own the keyboard while open; `/` must not pull focus out of them. */
  const POPUP_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

  const {
    pipelines,
    phases = [],
    workflows = [],
    currentWorkflowId,
    readonly: readOnly,
    splitTargetId,
    onaddnode,
    onaddsplit,
    collapsed = false,
    ontoggle
  }: Props = $props();

  let query = $state('');
  let searchInput = $state<HTMLInputElement | null>(null);

  function joinDetail(parts: readonly (string | undefined)[]): string {
    return parts
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join(DETAIL_SEPARATOR);
  }

  function portList(label: string, ports: readonly { portId: string }[] | undefined): string | undefined {
    if (ports === undefined || ports.length === 0) return undefined;
    return `${label}: ${ports.map((port) => port.portId).join(', ')}`;
  }

  function workflowDetail(workflow: PortableWorkflowDefinition): string {
    const count = workflow.nodes.length;
    return joinDetail([
      `${count} ${count === 1 ? 'step' : 'steps'}`,
      portList('in', workflow.inputs),
      portList('out', workflow.outputs)
    ]);
  }

  const needle = $derived(query.trim().toLowerCase());

  function matches(entry: Entry): boolean {
    return `${entry.name} ${entry.id ?? ''} ${entry.detail}`.toLowerCase().includes(needle);
  }

  const childWorkflows = $derived(
    workflows.filter((wf) => wf.workflowId !== currentWorkflowId)
  );
  const isEmpty = $derived(
    phases.length === 0 && childWorkflows.length === 0 && pipelines.length === 0
  );

  const phaseEntries = $derived(
    phases
      .map((phase): Entry => ({
        kind: 'phase',
        icon: '#i-phase',
        name: phase.name,
        id: phase.phaseId,
        detail: joinDetail([phase.description, phase.runner, phase.model, phase.effort]),
        testid: `workflow-palette-phase-${phase.phaseId}`,
        disabled: readOnly,
        add: () => onaddnode({ kind: 'phase', phaseId: phase.phaseId })
      }))
      .filter(matches)
  );

  const workflowEntries = $derived(
    childWorkflows
      .map((wf): Entry => ({
        kind: 'workflow',
        icon: '#i-workflow',
        name: wf.name,
        id: wf.workflowId,
        detail: workflowDetail(wf),
        testid: `workflow-palette-workflow-${wf.workflowId}`,
        disabled: readOnly,
        add: () => onaddnode({ kind: 'workflow', workflowId: wf.workflowId })
      }))
      .filter(matches)
  );

  const splitEntry = $derived<Entry>({
    kind: 'logic',
    icon: '#i-cond',
    name: 'Split',
    id: null,
    detail: splitTargetId !== null ? `Add branch on ${splitTargetId}` : 'Select or add a node first',
    testid: 'workflow-palette-split',
    disabled: readOnly || splitTargetId === null,
    add: onaddsplit
  });
  const logicEntries = $derived([splitEntry].filter(matches));

  const noMatch = $derived(
    phaseEntries.length === 0 && workflowEntries.length === 0 && logicEntries.length === 0
  );

  function ownsTheKeyboard(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      TYPING_TAGS.has(target.tagName) ||
      target.isContentEditable ||
      target.closest(POPUP_SELECTOR) !== null
    );
  }

  /** The redesign's shortcut: `/` searches the steps, expanding the palette first. */
  function focusSearchOnSlash(event: KeyboardEvent): void {
    if (event.key !== SEARCH_KEY || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (ownsTheKeyboard(event.target)) return;
    if (collapsed && !ontoggle) return;
    event.preventDefault();
    if (!collapsed) {
      searchInput?.focus();
      return;
    }
    ontoggle?.();
    void tick().then(() => searchInput?.focus());
  }
</script>

<svelte:window onkeydown={focusSearchOnSlash} />

{#snippet group(id: string, title: string, entries: readonly Entry[])}
  {#if entries.length > 0}
    <div class="pal-group" role="group" aria-labelledby={id}>
      <h3 {id}>{title}</h3>
      {#each entries as entry (entry.testid)}
        <button
          type="button"
          class="pal-item"
          data-testid={entry.testid}
          disabled={entry.disabled}
          onclick={entry.add}
        >
          <span class="kicon k-{entry.kind}">
            <svg class="i" aria-hidden="true"><use href={entry.icon}></use></svg>
          </span>
          <span class="pal-text">
            <span class="t">{entry.name}</span>
            {#if entry.id !== null}<span class="d mono">{entry.id}</span>{/if}
            {#if entry.detail !== ''}<span class="d">{entry.detail}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<aside class="palette" class:collapsed aria-label="Add steps" data-testid="workflow-action-palette">
  <div class="pal-head">
    <span class="pal-title">Add steps</span>
    {#if ontoggle}
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-palette-toggle"
        aria-label={collapsed ? 'Expand the Add steps panel' : 'Collapse the Add steps panel'}
        aria-expanded={!collapsed}
        aria-controls={BODY_ID}
        onclick={ontoggle}
      >
        <svg class="i" aria-hidden="true"><use href={collapsed ? '#i-expand' : '#i-collapse'}></use></svg>
      </button>
    {/if}
  </div>
  <div class="pal-body" id={BODY_ID} hidden={collapsed}>
    <div class="search rel">
      <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
      <input
        class="input"
        type="search"
        placeholder="Search steps  /"
        aria-label="Search steps"
        aria-keyshortcuts={SEARCH_KEY}
        data-testid="workflow-palette-search"
        bind:this={searchInput}
        bind:value={query}
      />
    </div>
    {@render group(GROUP_PHASES_ID, 'Phases', phaseEntries)}
    {@render group(GROUP_WORKFLOWS_ID, 'Workflows', workflowEntries)}
    {#if noMatch}
      <p class="muted pal-note">No step matches "{query.trim()}".</p>
    {:else if isEmpty}
      <p class="muted pal-note" data-testid="workflow-palette-empty">No effective Phases or Workflows</p>
    {/if}
    {@render group(GROUP_LOGIC_ID, 'Logic', logicEntries)}
  </div>
</aside>

<style>
  /* sg-builder.css draws the palette. What follows is what the redesign leaves
     to the product: a disabled item, long ids, the notes, and a collapsed head
     whose toggle fits the 40px rail. */
  .palette .pal-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: none;
  }
  .pal-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .pal-note {
    margin: var(--schegent-space-1) 0;
    padding: var(--schegent-space-1-5);
  }
  .palette.collapsed .pal-head {
    padding-inline: var(--schegent-space-1-5);
  }
</style>
