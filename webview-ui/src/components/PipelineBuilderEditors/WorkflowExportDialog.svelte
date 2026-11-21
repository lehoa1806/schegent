<script lang="ts">
  // Feature 326 — Modal dialog for collecting Workflow YAML export inclusion
  // depth (`References only` vs. `Include child Workflows and Phases`), shared
  // across both Workflows list row `⋯` menus and Workflow Editor header `⋯`.
  import { onMount, tick } from 'svelte';
  import type { WorkflowExportInclusion } from '../../lib/messages';

  const INCLUSIONS: readonly {
    readonly value: WorkflowExportInclusion;
    readonly label: string;
  }[] = [
    { value: 'references-only', label: 'References only' },
    { value: 'include-closure', label: 'Include child Workflows and Phases' }
  ];

  interface Props {
    workflowId: string;
    workflowName: string;
    inclusion: WorkflowExportInclusion;
    originatingElement: HTMLElement | null;
    oninclusionchange: (value: WorkflowExportInclusion) => void;
    onconfirm: () => void;
    oncancel: () => void;
  }

  const {
    workflowId,
    workflowName,
    inclusion,
    originatingElement,
    oninclusionchange,
    onconfirm,
    oncancel
  }: Props = $props();

  let selectEl = $state<HTMLSelectElement | null>(null);
  let cancelEl = $state<HTMLButtonElement | null>(null);
  let confirmEl = $state<HTMLButtonElement | null>(null);

  function focusReturnTarget(origin: HTMLElement | null): HTMLElement | null {
    const menu = origin?.closest<HTMLElement>('[role="menu"]');
    if (!menu?.hidden) return origin;
    const opener = Array.from(menu.parentElement?.children ?? []).find(
      (sibling) => sibling.getAttribute('aria-haspopup') === 'menu'
    );
    return opener instanceof HTMLElement ? opener : origin;
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      oncancel();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const order: ReadonlyArray<HTMLElement | null> = [selectEl, cancelEl, confirmEl];
    const focusable = order.filter(
      (el): el is HTMLElement => el !== null && !el.matches(':disabled')
    );
    if (focusable.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? focusable.indexOf(active) : -1;
    if (event.shiftKey) {
      if (idx <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      }
    } else if (idx === -1 || idx === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });

  onMount(() => {
    void tick().then(() => {
      selectEl?.focus();
    });
    return () => {
      focusReturnTarget(originatingElement)?.focus();
    };
  });
</script>

<div
  class="sg wf-export-backdrop"
  role="presentation"
  onclick={handleBackdropClick}
>
  <div
    class="wf-export-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="workflows-export-dialog-title"
    tabindex="-1"
    data-testid="workflows-export-panel"
  >
    <h2 id="workflows-export-dialog-title">Export Workflow YAML</h2>
    <p class="wf-export-target">
      {workflowName || workflowId}
      <span class="mono muted small">{workflowId}</span>
    </p>
    <label class="field">
      <span>Include</span>
      <select
        class="input"
        data-testid="workflows-export-inclusion"
        bind:this={selectEl}
        value={inclusion}
        title="How much of the Workflow's dependencies the document carries"
        onchange={(event) =>
          oninclusionchange(event.currentTarget.value as WorkflowExportInclusion)}
      >
        {#each INCLUSIONS as depth (depth.value)}
          <option value={depth.value}>{depth.label}</option>
        {/each}
      </select>
    </label>
    <div class="wf-export-actions">
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="workflows-export-cancel"
        bind:this={cancelEl}
        onclick={oncancel}>Cancel</button
      >
      <button
        type="button"
        class="btn btn-primary"
        data-testid="workflows-export"
        bind:this={confirmEl}
        title="Export the selected Workflow as a document"
        onclick={onconfirm}>Export YAML…</button
      >
    </div>
  </div>
</div>

<style>
  .wf-export-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--schegent-z-modal-backdrop);
    display: grid;
    place-items: center;
    padding: var(--schegent-space-4);
    background: color-mix(in srgb, var(--schegent-bg) 72%, transparent);
  }

  .wf-export-dialog {
    position: relative;
    z-index: var(--schegent-z-modal);
    width: min(440px, 100%);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-bg);
    color: var(--schegent-fg);
    padding: var(--schegent-space-4);
    box-shadow: var(--schegent-shadow-popover);
  }

  h2 {
    margin: 0 0 var(--schegent-space-1-5);
    font-size: var(--schegent-text-subheading);
  }

  .wf-export-target {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--schegent-space-2);
    margin: 0 0 var(--schegent-space-3);
    font-weight: 500;
  }

  .wf-export-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--schegent-space-2);
    margin-top: var(--schegent-space-4);
  }
</style>
