<script lang="ts">
  // Feature 187 (T022, FR-001, FR-002) — the queue's last failed start, on the
  // queue's own surface.
  //
  // Step 7 of the drain (`contracts/concurrent-drain-and-leases.md` §1) is the
  // only step that can throw, and the only one with no guaranteed in-session
  // re-ask: the other six refusals leave a Run in flight or a queue held, and
  // something later ends or releases. A step-7 throw starts nothing, so nothing
  // ends, and before this notice existed the whole event was one `logger.warn`
  // in a channel the operator has no reason to be reading. The queue then looked
  // exactly like a queue politely waiting its turn.
  //
  // Its own component rather than markup inside `QueueDetailTier.svelte` for the
  // reason recorded in the plan (D-5): that file measured 463 of the flat
  // 500-line `svelte-component-loc-budget` ceiling, which is the same forcing
  // function that split `QueueIdlePendingPanel.svelte` out of it under feature
  // 097 (T012a). The split is not a workaround for the budget — it is the budget
  // working.
  //
  // Read-only by intent. There is no Retry button here, and that is a decision:
  // the drain re-offers this queue on the next terminal Run's registry-wide
  // sweep, on an operator start, and on activation, so a button would add a
  // second way to ask for something that is already going to be asked. The
  // notice says so in words instead (SC-002).

  import { formatRelativeTime } from '../../lib/format';
  import type { QueueRuntime } from '../../lib/snapshot-types';

  interface Props {
    /** The queue this report belongs to; scopes every test id below. */
    queueId: string;
    startFailure: QueueRuntime['startFailure'];
    /** Injectable for tests only; production reads the wall clock. */
    nowMs?: number;
  }

  const { queueId, startFailure, nowMs }: Props = $props();

  // Operator words, not the host's method names. `admitResume` and `admitNew`
  // name two different attempts an operator can tell apart — picking up a
  // paused Run versus starting a queued one — and only one of them is theirs to
  // have asked for. Printing the identifiers would answer that only for someone
  // who has read the drain.
  const attempt = $derived(
    startFailure?.admission === 'admitResume' ? 'Resuming this queue' : 'Starting this queue'
  );
  const age = $derived(startFailure === null ? '' : formatRelativeTime(startFailure.at, nowMs));
</script>

{#if startFailure !== null}
  <div class="start-failure" role="status" data-testid="queue-start-failure-{queueId}">
    <div class="headline">
      <span class="attempt">{attempt} failed</span>
      <span class="age" data-testid="queue-start-failure-age-{queueId}">{age}</span>
    </div>
    <span class="summary" data-testid="queue-start-failure-summary-{queueId}">
      {#if startFailure.summary !== null}
        {startFailure.summary}
      {:else}
        The error carried no message.
      {/if}
    </span>
    <span class="retry-note">Schegent will offer this queue again when a run ends.</span>
  </div>
{/if}

<style>
  .start-failure {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    margin: 0 20px;
    background: color-mix(
      in srgb,
      var(--vscode-notificationsErrorIcon-foreground, var(--vscode-charts-red)) 12%,
      transparent
    );
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    color: var(--schegent-fg);
    font-size: 0.85em;
  }

  .headline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .attempt {
    font-weight: 600;
  }

  .age,
  .retry-note {
    opacity: 0.75;
    font-size: 0.9em;
  }

  .summary {
    /* An unbroken driver message must not widen the panel past the sidebar. */
    overflow-wrap: anywhere;
  }
</style>
