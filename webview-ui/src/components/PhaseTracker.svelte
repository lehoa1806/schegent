<script lang="ts">
  import { onMount } from 'svelte';
  import PhaseTile from './PhaseTile.svelte';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { CMD_RETRY_PHASE_NOW } from '../lib/messages';
  import { postCommand } from '../lib/vscode-api';
  import { useConfirm } from '../lib/use-confirm';
  import { formatPhaseLabel } from '../lib/format';

  const phases = $derived(snapshotStore.phases);
  const delayedRetry = $derived(snapshotStore.delayedRetry);
  const activePhase = $derived(phases.find((p) => p.state === 'active') ?? null);

  // Feature 011 — tick a clock every 1s so the countdown re-renders.
  // Stopped while no retry is pending so we don't burn rAF cycles when
  // the active phase is healthy.
  let nowMs = $state(Date.now());
  let pendingCorrelationId = $state<string | null>(null);
  const retryPending = $derived(
    pendingCorrelationId !== null && snapshotStore.isPending(pendingCorrelationId)
  );

  onMount(() => {
    const interval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(interval);
  });

  async function handleRetryNow(event: MouseEvent): Promise<void> {
    // Feature 063 (T037) — gate retry-phase-now behind the universal
    // confirmation. The active phase's display label surfaces in the
    // body so the operator can confirm which phase will be retried.
    const phaseName = activePhase
      ? formatPhaseLabel(activePhase.name, activePhase.displayName)
      : 'active phase';
    const ok = await useConfirm('run.retry-phase-now', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { phaseName }
    });
    if (!ok) return;
    const { correlationId } = postCommand(CMD_RETRY_PHASE_NOW);
    snapshotStore.markPending(correlationId);
    pendingCorrelationId = correlationId;
  }
</script>

<section aria-label="Phase tracker" class="tracker" data-testid="phase-tracker">
  <ol>
    {#each phases as tile (tile.name)}
      <PhaseTile
        {tile}
        pendingRetry={delayedRetry}
        {nowMs}
        onRetryNow={handleRetryNow}
        retryDisabled={retryPending}
      />
    {/each}
  </ol>
</section>

<style>
  .tracker {
    padding: var(--schegent-pad);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
