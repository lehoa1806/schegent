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
  // click (FR-057).
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
  }

  const {
    phaseId,
    resolves = true,
    disabledReason = 'This Phase has errors, so there is nothing valid to export.',
    rowKey
  }: Props = $props();

  const disabled = $derived(!resolves);
  const reasonId = $derived(`process-export-reason-${rowKey ?? phaseId}`);
  const title = $derived(disabled ? disabledReason : `Export ${phaseId} as a document`);

  function onClick(): void {
    if (disabled) return;
    exportPhaseYaml(phaseId);
  }
</script>

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

<style>
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
