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
  import { lifecycleMessage } from '../../lib/lifecycle-control-ipc';
  import type { CreditPollingProjection } from '../../lib/snapshot-types';

  interface Props {
    /** The queue whose Run this is; scopes every test id and addresses the Resume. */
    queueId: string;
    creditPolling: CreditPollingProjection;
  }

  const { queueId, creditPolling }: Props = $props();

  let pending = $state(false);
  let refusal = $state<string | null>(null);

  async function resume(): Promise<void> {
    pending = true;
    refusal = null;
    refusal = lifecycleMessage(await resumePhase(queueId));
    pending = false;
  }
</script>

{#if creditPolling.state === 'stopped'}
  <div class="credit-polling stopped" role="status" data-testid="credit-polling-stopped-{queueId}">
    <span class="headline">Credit polling stopped</span>
    <button
      type="button"
      class="resume"
      data-testid="credit-polling-resume-{queueId}"
      disabled={pending}
      onclick={resume}
    >Resume</button>
    {#if refusal !== null}
      <span class="refusal" role="alert" data-testid="credit-polling-refusal-{queueId}">{refusal}</span>
    {/if}
  </div>
{:else if creditPolling.state === 'unreachable'}
  <div class="credit-polling unreachable" role="status" data-testid="credit-polling-unreachable-{queueId}">
    <span class="headline">Status unreachable</span>
  </div>
{/if}

<style>
  .credit-polling {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--vscode-editorWarning-foreground, currentColor);
    border-radius: 4px;
  }
  .headline {
    font-weight: 600;
  }
  .refusal {
    color: var(--vscode-errorForeground, currentColor);
  }
</style>
