<script lang="ts">
  // FR-R4-F02 (spec 240, US6; contract W6 G18; TA3) — what the operator sees about a Run that is
  // paused for credits: that Schegent gave up polling, or that the status check cannot be reached.
  //
  // After 24 hours the watchdog stops polling and leaves the Run paused (FR-020). Before this
  // notice existed that was invisible: the Run read as paused, the same as one waiting on its next
  // poll, and nothing said that no poll was coming. The one action here is the existing Resume
  // control, dispatched through the run-controls helper (hard rules 11 and 12), so there is no
  // inline `postCommand` and no new command. A resume runs no status check and starts no window.
  //
  // Fixed text only. The snapshot carries a state and an end time and nothing the CLI said, so this
  // component has no account text to render and renders none.

  import { resumePhase } from '../../lib/phase-control';
  import { lifecycleMessage, lifecycleWait } from '../../lib/lifecycle-control-ipc';
  import type { CreditPollingProjection } from '../../lib/snapshot-types';

  interface Props {
    /** The queue whose Run this is; scopes every test id and addresses the Resume. */
    queueId: string;
    creditPolling: CreditPollingProjection;
  }

  const { queueId, creditPolling }: Props = $props();

  let pending = $state(false);
  let refusal = $state<string | null>(null);
  // FR-R4-F05 (O4, FR-024, FR-026) — a late answer replaces the interim text; unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  const wait = lifecycleWait(lifetime.signal, (message) => (refusal = message));

  async function resume(): Promise<void> {
    pending = true;
    refusal = null;
    refusal = lifecycleMessage(await resumePhase(queueId, undefined, wait));
    pending = false;
  }
</script>

<!-- Drawn as the redesign's warning banner (`.attn.warn` in `sg-core.css`), as the queue's own
     notices are: the icon, what stopped, and the one action at the end. A refused Resume is said
     under the headline, inside the banner it answers. -->
{#if creditPolling.state === 'stopped'}
  <div class="attn warn" role="status" data-testid="credit-polling-stopped-{queueId}">
    <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
    <span class="body">
      <b>Credit polling stopped</b>
      {#if refusal !== null}
        <span class="refusal" role="alert" data-testid="credit-polling-refusal-{queueId}">{refusal}</span>
      {/if}
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="credit-polling-resume-{queueId}"
      disabled={pending}
      onclick={resume}
    >Resume</button>
  </div>
{:else if creditPolling.state === 'unreachable'}
  <div class="attn warn" role="status" data-testid="credit-polling-unreachable-{queueId}">
    <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
    <span class="body"><b>Status unreachable</b></span>
  </div>
{/if}

<style>
  /* In error text, as the queue's own refusals read. */
  .refusal {
    display: block;
    color: var(--schegent-error-text);
  }
</style>
