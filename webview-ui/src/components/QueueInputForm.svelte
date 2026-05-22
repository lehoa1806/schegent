<script lang="ts">
  import type { PipelineDefinition } from '../lib/snapshot-types';
  import { postCommand } from '../lib/vscode-api';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { CMD_START } from '../lib/messages';

  const MAX_TEXTAREA_LINES = 12;

  interface Props {
    availablePipelines: readonly PipelineDefinition[];
    defaultPipelineId: string;
    pendingCount: number;
  }

  const { availablePipelines, defaultPipelineId, pendingCount }: Props = $props();

  let description = $state('');
  let selectedPipelineId = $state<string | undefined>(undefined);
  let operatorTouchedPipeline = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | undefined>(undefined);

  let submitInFlightId = $state<string | null>(null);
  let submitFeedback = $state<
    | { kind: 'accepted'; queueName: string | null }
    | { kind: 'rejected'; reason: string }
    | null
  >(null);


  const defaultSelectedPipelineId = $derived<string | undefined>(
    availablePipelines.length === 0
      ? undefined
      : availablePipelines.some((p) => p.id === defaultPipelineId)
        ? defaultPipelineId
        : availablePipelines[0].id
  );

  $effect(() => {
    if (operatorTouchedPipeline) return;
    selectedPipelineId = defaultSelectedPipelineId;
  });

  $effect(() => {
    description;
    if (!textareaEl) return;
    const lineHeightPx = parseFloat(getComputedStyle(textareaEl).lineHeight) || 18;
    textareaEl.style.height = 'auto';
    const maxHeight = MAX_TEXTAREA_LINES * lineHeightPx;
    const next = Math.min(textareaEl.scrollHeight, maxHeight);
    textareaEl.style.height = `${next}px`;
  });

  const trimmedDescription = $derived(description.trim());
  const submitDisabled = $derived(
    trimmedDescription.length === 0 ||
      availablePipelines.length === 0 ||
      submitInFlightId !== null
  );

  function onPipelineChange(): void {
    operatorTouchedPipeline = true;
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    if (submitDisabled) return;
    const { correlationId } = postCommand(CMD_START, {
      description: trimmedDescription,
      ...(selectedPipelineId === 'standard'
        ? {}
        : { pipelineId: selectedPipelineId })
    });
    submitInFlightId = correlationId;
    submitFeedback = null;
    snapshotStore.onceAck(correlationId, (ack) => {
      submitInFlightId = null;
      if (ack.status === 'accepted') {
        const result = ack.result as
          | { outcome?: string; queueName?: string | null }
          | undefined;
        if (result?.outcome === 'enqueued') {
          description = '';
          submitFeedback = { kind: 'accepted', queueName: result.queueName ?? null };
        }
        return;
      }
      submitFeedback = { kind: 'rejected', reason: ack.reason ?? 'rejected' };
    });
  }
</script>

<section class="zone queue-input glass-card" data-testid="dashboard-queue-input" aria-label="Queue input">
  <form class="compose-box" onsubmit={onSubmit}>
    <textarea
      id="dashboard-queue-input-textarea"
      data-testid="dashboard-queue-input-textarea"
      bind:this={textareaEl}
      bind:value={description}
      maxlength="4096"
      rows="1"
      placeholder="What would you like to build?"
      title="Enter a feature description to enqueue"
    ></textarea>
    <div class="compose-toolbar">
      <div class="compose-selectors">
        <div class="pipeline-selector">
          {#if availablePipelines.length === 0}
            <select class="pipeline-select" title="Select Pipeline" disabled>
              <option value="" disabled selected>N/A</option>
            </select>
          {:else}
            <select
              bind:value={selectedPipelineId}
              onchange={onPipelineChange}
              class="pipeline-select"
              title="Select Pipeline"
            >
              {#each availablePipelines as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          {/if}
        </div>
      </div>
      <button
        type="submit"
        class="submit-button"
        data-testid="dashboard-queue-input-submit"
        disabled={submitDisabled}
        title="Enqueue Feature"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      </button>
    </div>
    {#if submitFeedback}
      <div
        class="submit-feedback submit-feedback-{submitFeedback.kind}"
        role="status"
        data-testid="dashboard-queue-input-feedback"
      >
        {#if submitFeedback.kind === 'accepted'}
          Enqueued to {submitFeedback.queueName ?? 'queue'}
        {:else}
          Rejected: {submitFeedback.reason}
        {/if}
      </div>
    {/if}
  </form>
</section>

<style>
  .zone.queue-input { flex-shrink: 0; }
  .glass-card {
    background: var(--sch-glass-bg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: var(--schegent-pad);
    box-shadow: var(--sch-card-shadow);
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
  }
  .compose-box {
    display: flex;
    flex-direction: column;
    background: var(--vscode-list-hoverBackground);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 8px;
    gap: 8px;
    transition: box-shadow 0.2s, border-color 0.2s;
  }
  .compose-box:focus-within {
    border-color: var(--schegent-focus-border);
    box-shadow: var(--sch-glow-active);
  }
  .compose-box textarea {
    width: 100%;
    min-height: 100px;
    background: transparent;
    border: none;
    color: var(--schegent-fg);
    font: inherit;
    font-size: 1.05rem;
    padding: 8px;
    resize: none;
    outline: none;
    overflow-y: auto;
    box-sizing: border-box;
  }
  .compose-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .compose-selectors {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pipeline-select {
    background: var(--vscode-list-hoverBackground);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    border-radius: var(--schegent-radius);
    padding: 4px 8px;
    font-size: 0.85em;
    outline: none;
    cursor: pointer;
  }
  .pipeline-select:focus { border-color: var(--schegent-focus-border); }
  .pipeline-select option {
    background: var(--sch-glass-bg);
    color: var(--schegent-fg);
  }
  .submit-button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sch-accent-gradient);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    cursor: pointer;
  }
  .submit-button:disabled {
    background: var(--schegent-disabled-fg);
    opacity: 0.5;
    cursor: not-allowed;
  }
  .submit-button:active:not(:disabled) {
    transform: scale(0.9);
    opacity: 0.85;
  }
</style>
