<script lang="ts">
  import { onMount } from 'svelte';
  import PhaseTile from './PhaseTile.svelte';
  import { emptyCatalogGuidance } from '../../../src/contracts/empty-catalog-guidance';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { CMD_RETRY_PHASE_NOW } from '../lib/messages';
  import { postCommand } from '../lib/vscode-api';
  import { useConfirm } from '../lib/use-confirm';
  import { formatPhaseLabel } from '../lib/format';

  interface Props {
    /**
     * Feature 093 (FR-018 / T080) — the queue whose Run this tracker shows.
     * Retry-now addresses it explicitly; the host refuses an unaddressed
     * control now that N Runs can be in flight at once.
     */
    queueId: string;
  }

  const { queueId }: Props = $props();

  const phases = $derived(snapshotStore.phases);
  const delayedRetry = $derived(snapshotStore.delayedRetry);
  const activePhase = $derived(phases.find((p) => p.state === 'active') ?? null);

  /**
   * Feature 098 (T056, FR-030 / FR-032) — what an operator sees before they
   * have imported anything.
   *
   * The projector answers an empty catalog with zero tiles (T055), which on its
   * own is a blank panel. The guidance comes from the shared source the launch
   * surface reads too, so the two cannot say different things, and it is
   * derived rather than stored: non-empty means absent, with no second rule to
   * keep in step.
   */
  const guidance = $derived(emptyCatalogGuidance(phases.length));

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
    const { correlationId } = postCommand(CMD_RETRY_PHASE_NOW, { queueId });
    snapshotStore.markPending(correlationId);
    pendingCorrelationId = correlationId;
  }
</script>

<section aria-label="Phase tracker" class="tracker" data-testid="phase-tracker">
  {#if guidance}
    <!-- Interpolated with `{}`, which escapes. The text is a shipped constant,
         but the escaping is the rule here rather than a judgement about this
         one string. -->
    <div class="empty-catalog" data-testid="phase-tracker-empty-catalog">
      <p class="empty-catalog-headline">{guidance.headline}</p>
      <p class="empty-catalog-body">{guidance.body}</p>
    </div>
  {:else}
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
  {/if}
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
  .empty-catalog {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .empty-catalog-headline {
    margin: 0;
    font-weight: 600;
  }
  .empty-catalog-body {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
</style>
