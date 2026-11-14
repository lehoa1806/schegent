<script lang="ts">
  // Feature 084 T026 — the per-Phase Export control (FR-052, FR-057).
  //
  // The request goes through `exportPhaseYaml`, the single call site for the
  // exchange family (FR-058). This component never names a location: the host
  // opens its own save dialog and reports only whether a document was written
  // (FR-019).
  //
  // A row that carries no valid definition cannot produce a document (FR-015),
  // so the control is disabled AND says why, rather than failing after the
  // click (FR-057). As a menu item it is off through `aria-disabled`, not
  // `disabled`, so the arrow keys still reach it and its reason can be read.
  import { exportPhaseYaml } from '../../lib/process-yaml-ipc';

  interface Props {
    /** The Phase id to export, resolved from the effective catalog by the host. */
    phaseId: string;
    /** False when the row has no valid definition — see `disabledReason`. */
    resolves?: boolean;
    /** Stated reason shown when the control is disabled (FR-057). */
    disabledReason?: string;
    /**
     * T067 — a key unique across the rendered rows, used only to build the
     * reason element's id. A Phase id is not enough: the same id can appear in
     * two layers at once, and two elements sharing one id leave
     * `aria-describedby` pointing at whichever came first.
     */
    rowKey?: string;
    /**
     * Render as an item of a `role="menu"`, as the Phase editor's "More phase actions" offers it: no
     * wrapper, the item reads "Export…", and the reason sits inside the item, so it shows and hides
     * with the menu.
     */
    menuitem?: boolean;
  }

  const {
    phaseId,
    resolves = true,
    disabledReason = 'This Phase has errors, so there is nothing valid to export.',
    rowKey,
    menuitem = false
  }: Props = $props();

  const disabled = $derived(!resolves);
  const reasonId = $derived(`process-export-reason-${rowKey ?? phaseId}`);
  const title = $derived(disabled ? disabledReason : `Export ${phaseId} as a document`);

  function onClick(): void {
    if (disabled) return;
    exportPhaseYaml(phaseId);
  }
</script>

{#if menuitem}
  <button
    type="button"
    class="export-item"
    role="menuitem"
    data-testid="process-export-button"
    aria-disabled={disabled}
    {title}
    aria-label={`Export ${phaseId}`}
    aria-describedby={disabled ? reasonId : undefined}
    onclick={onClick}
  ><span class="export-word">Export…</span>{#if disabled}<span class="export-why" id={reasonId}
        data-testid="process-export-disabled-reason">{disabledReason}</span>{/if}</button>
{:else}
  <div class="export-control">
    <button
      type="button"
      class="export-button"
      data-testid="process-export-button"
      {disabled}
      {title}
      aria-label={`Export ${phaseId}`}
      aria-describedby={disabled ? reasonId : undefined}
      onclick={onClick}
    >Export</button>
    {#if disabled}
      <span class="export-reason" id={reasonId}
        data-testid="process-export-disabled-reason">{disabledReason}</span>
    {/if}
  </div>
{/if}

<style>
  /* The menu draws the item (sg-pages.css `.menu button`), off or on; the reason takes a line of its
     own under the word. When the item is off, only its word dims: the reason keeps its own colour,
     since it is what the operator needs to read.

     A grid rather than a wrapping flex row: the menu sizes itself to its widest item, and a flex
     row's widest size holds every item on one line, so the reason sat beside the word.
     `:global(.menu)` outranks sg-pages' `.menu button`, which makes every item a flex row. */
  :global(.menu) .export-item {
    display: grid;
    row-gap: var(--schegent-space-0-5);
  }
  .export-why {
    max-width: 32ch;
    white-space: normal;
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
  }
  .export-control {
    display: inline-flex;
    align-items: center;
    gap: var(--schegent-pad);
  }
  .export-button {
    min-height: 24px;
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    border: 1px solid transparent;
    border-radius: var(--schegent-radius);
    padding: 0 var(--schegent-pad);
    font: inherit;
    cursor: pointer;
  }
  .export-button:hover:not(:disabled) {
    background: var(--schegent-button-hover);
  }
  .export-button:focus-visible {
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 1px;
  }
  .export-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .export-reason {
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
</style>
