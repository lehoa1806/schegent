<script lang="ts">
  // Feature 020 T036 — iteration stepper for loopable phases. Hidden
  // when the manifest reports ≤ 1 iteration. "Iteration N of total" label,
  // prev/next buttons clamped to the available iterations (which arrive
  // newest-first from the host).

  interface Props {
    readonly iterations: readonly number[];
    readonly currentN: number | null;
    readonly onChange: (n: number) => void;
  }

  let { iterations, currentN, onChange }: Props = $props();

  const visible = $derived(iterations.length > 1);

  // The iterations list arrives newest-first; the stepper's "prev"
  // semantically means "older" (lower N) and "next" means "newer".
  const sortedAsc = $derived([...iterations].sort((a, b) => a - b));
  const idx = $derived(currentN === null ? -1 : sortedAsc.indexOf(currentN));
  const total = $derived(iterations.length);

  const canPrev = $derived(idx > 0);
  const canNext = $derived(idx >= 0 && idx < sortedAsc.length - 1);

  function goPrev(): void {
    if (canPrev) onChange(sortedAsc[idx - 1]);
  }

  function goNext(): void {
    if (canNext) onChange(sortedAsc[idx + 1]);
  }
</script>

<!-- Drawn as the redesign's segmented control (`.seg`), the group its log uses to pick an
     attempt: older, the iteration shown, newer. -->
{#if visible}
  <div class="seg stepper" role="group" aria-label="Iteration" data-testid="phase-log-iter-stepper">
    <button
      type="button"
      data-testid="phase-log-iter-prev"
      onclick={goPrev}
      disabled={!canPrev}
      aria-label="Older iteration"
    >
      <svg class="i" aria-hidden="true"><use href="#i-collapse"></use></svg>
    </button>
    <span class="label" data-testid="phase-log-iter-label">
      Iteration {currentN ?? '—'} of {total}
    </span>
    <button
      type="button"
      data-testid="phase-log-iter-next"
      onclick={goNext}
      disabled={!canNext}
      aria-label="Newer iteration"
    >
      <svg class="i" aria-hidden="true"><use href="#i-right"></use></svg>
    </button>
  </div>
{/if}

<style>
  /* At the start of the log's toolbar row, at its own width, in secondary text. */
  .stepper {
    flex: none;
    font-size: var(--schegent-text-secondary);
  }
  .stepper button {
    display: inline-flex;
    align-items: center;
    padding: 3px var(--schegent-space-1-5);
  }
  .stepper button:hover:not(:disabled) {
    background: var(--schegent-list-hover);
  }
  .stepper button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .label {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--schegent-space-2-5);
    border-inline: 1px solid var(--schegent-border);
    color: var(--schegent-muted-fg);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
