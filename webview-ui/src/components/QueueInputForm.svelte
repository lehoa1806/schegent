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
    /**
     * Feature 092 (T108, FR-057) — the queue the Task is enqueued onto. Absent on
     * the unscoped reading; the host then resolves the default queue exactly as
     * it did before the Queue Detail tier could name one.
     */
    queueId?: string;
  }

  // Feature 065 (T028, revised per BUG-001 / 2026-05-23) — enqueue and
  // start are orthogonal at the UI level. Submitting a task ALWAYS
  // dispatches `CMD_START` without `startIntent`; the host appends to
  // the queue and, when the prior lifecycle was `active-empty`, lands
  // the queue in `idle-pending` with `scheduledStartAt = null`. The
  // start-mode chooser is no longer presented at submit-time; it is
  // reachable exclusively via the queue-level "Start queue" affordance,
  // now `QueueIdlePendingPanel` (FR-018).
  const { availablePipelines, defaultPipelineId, pendingCount, queueId }: Props = $props();

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

  // Feature 098 (T049, FR-033a) — `defaultPipelineId` is the empty string when
  // no default is set, which is what a fresh install ships now that no Pipeline
  // is built in. The membership test already answers that correctly: `''` names
  // no Pipeline, so the first available one is preselected rather than an id
  // the operator cannot see in the list. Recorded rather than changed, so a
  // later edit does not "simplify" the test into a truthiness check.
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

  function dispatchStart(draft: { description: string; pipelineId?: string }): void {
    const payload: Record<string, unknown> = { description: draft.description };
    if (draft.pipelineId !== undefined && draft.pipelineId !== 'standard') {
      payload['pipelineId'] = draft.pipelineId;
    }
    if (queueId !== undefined) payload['queueId'] = queueId;
    const { correlationId } = postCommand(CMD_START, payload as never);
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

  function onSubmit(event: Event): void {
    event.preventDefault();
    if (submitDisabled) return;
    dispatchStart({
      description: trimmedDescription,
      pipelineId: selectedPipelineId
    });
  }
</script>

<section class="zone queue-input glass-card" data-testid="dashboard-queue-input" aria-label="Queue input">
  <form class="compose-box" onsubmit={onSubmit}>
    <label class="compose-label" for="dashboard-queue-input-textarea">Add work to queue</label>
    <textarea
      id="dashboard-queue-input-textarea"
      data-testid="dashboard-queue-input-textarea"
      bind:this={textareaEl}
      bind:value={description}
      maxlength="4096"
      rows="1"
      placeholder="Describe the work to enqueue"
      title="Enter a feature description to enqueue"
    ></textarea>
    <div class="compose-toolbar">
      <div class="compose-selectors">
        <div class="pipeline-selector">
          {#if availablePipelines.length === 0}
            <select class="pipeline-select" aria-label="Pipeline" title="Select Pipeline" disabled>
              <option value="" disabled selected>N/A</option>
            </select>
          {:else}
            <select
              aria-label="Pipeline"
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
        title="Add task to queue"
      >
        Add task
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

  <p class="network-notice" data-testid="dashboard-network-dependence-note">
    Local-first, not offline: running this queue may contact configured backend providers.
  </p>

</section>

<style>
  .zone.queue-input { flex-shrink: 0; }
  .glass-card {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-2);
  }
  .compose-box {
    display: flex;
    flex-direction: column;
    background: transparent;
    border: 0;
    border-radius: var(--schegent-radius);
    padding: 0;
    gap: var(--schegent-space-2);
  }
  .compose-box:focus-within {
    background: transparent;
  }
  .compose-label {
    color: var(--schegent-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 650;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }
  .compose-box textarea {
    width: 100%;
    min-height: 56px;
    background: var(--schegent-input-bg);
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    color: var(--schegent-fg);
    font: inherit;
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    padding: 8px 9px;
    resize: none;
    overflow-y: auto;
    box-sizing: border-box;
  }
  .compose-box textarea:focus-visible {
    border-color: var(--schegent-focus-border);
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 0;
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
    min-height: var(--schegent-control-height-compact);
    max-width: 170px;
    background: var(--schegent-input-bg);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    border-radius: var(--schegent-radius-sm);
    padding: 3px 26px 3px 8px;
    font-size: var(--schegent-text-caption);
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
    border-radius: var(--schegent-radius-sm);
    min-height: var(--schegent-control-height-compact);
    padding: 0 10px;
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .submit-button:disabled {
    background: var(--schegent-disabled-fg);
    opacity: 0.5;
    cursor: not-allowed;
  }
  .submit-button:active:not(:disabled) {
    transform: translateY(1px);
    opacity: 0.9;
  }
  .network-notice {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.35;
  }
  .submit-feedback {
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .submit-feedback-accepted { color: var(--schegent-color-completed); }
  .submit-feedback-rejected { color: var(--schegent-error-text); }
</style>
