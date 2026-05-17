<script lang="ts">
  // Feature 020 T036 — iteration stepper for loopable phases. Hidden
  // when the manifest reports ≤ 1 iteration. "iter N / total" label,
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

{#if visible}
  <div class="stepper" data-testid="phase-log-iter-stepper">
    <button
      type="button"
      data-testid="phase-log-iter-prev"
      onclick={goPrev}
      disabled={!canPrev}
      aria-label="Older iteration"
    >
      ‹
    </button>
    <span class="label" data-testid="phase-log-iter-label">
      iter {currentN ?? '—'} / {total}
    </span>
    <button
      type="button"
      data-testid="phase-log-iter-next"
      onclick={goNext}
      disabled={!canNext}
      aria-label="Newer iteration"
    >
      ›
    </button>
  </div>
{/if}

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8rem;
  }
  button {
    min-width: 1.5rem;
  }
  button[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .label {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
</style>
