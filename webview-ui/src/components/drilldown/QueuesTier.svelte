<script lang="ts">
  // Feature 092 (T107, FR-055, FR-056, FR-065) — tier 1 of the drill-down.
  //
  // Tier 1 is the existing `operations` route, already labelled 'Queues'. Nothing
  // is added to `DashboardRoute` for it: the tiers are sub-locations addressed by
  // `DashboardLocation`, and `OperationsSurface.svelte` owns that location.
  //
  // Every card is a `<button>`, not a clickable `<div>`: FR-059 requires the
  // tiers be operable from the keyboard, and a button is focusable, Enter/Space
  // activated and announced as an action without a single `tabindex` or `role`.
  //
  // This component owns the surface's one `<main>` landmark, so the operations
  // route keeps exactly one however deep the operator has drilled.
  //
  // Mockup: docs/mockup/schegent_mockup.html `view-active-queue`.

  // Feature 095 (T027, US3) — the workspace queue settings open from this tier,
  // because both values are workspace-scoped. They are deliberately not folded
  // into `QueueDetailTier`'s per-queue Settings affordance, which renames the one
  // queue in front of the operator.

  import { postCommand } from '../../lib/vscode-api';
  import { CMD_CREATE_QUEUE } from '../../lib/messages';
  import { queueLifecycleLabel } from '../../lib/queue-lifecycle-label';
  import { snapshotStore } from '../../lib/snapshot-store.svelte';
  import QueueConfigModal from '../QueueConfigModal.svelte';
  import type { QueueRuntime } from '../../lib/snapshot-types';

  interface Props {
    /** Every registered queue's runtime, as the v4 snapshot publishes them. */
    queues: readonly QueueRuntime[];
    /** FR-065 — a non-primary window reads every tier but mutates nothing. */
    isPrimary: boolean;
    /**
     * FR-060 — the card the operator last drilled into, so walking back lands on
     * a tier that still shows where they were. The surface remembers it; this
     * tier only reflects it, and holds no selection state of its own.
     */
    selectedQueueId?: string | null;
    /** Reported, not acted on: the surface owns navigation (FR-060). */
    onSelectQueue?: (queueId: string) => void;
  }

  const {
    queues,
    isPrimary,
    selectedQueueId = null,
    onSelectQueue = () => {}
  }: Props = $props();

  // Position is the registry's contiguous order, and it is the order the
  // operator arranged. Sorting here rather than trusting array order means a
  // caller that filters or concatenates cannot reshuffle the tier.
  const ordered = $derived([...queues].sort((a, b) => a.position - b.position));

  let creating = $state(false);
  let draftName = $state('');
  let configuring = $state(false);
  let configOpener: HTMLElement | null = $state(null);

  function openConfig(event: MouseEvent): void {
    configOpener = event.currentTarget as HTMLElement;
    configuring = true;
  }

  function closeConfig(): void {
    configuring = false;
  }

  function openCreate(): void {
    creating = true;
    draftName = '';
  }

  function cancelCreate(): void {
    creating = false;
    draftName = '';
  }

  function submitCreate(): void {
    // The host owns every bound and the uniqueness rule; the webview only
    // refuses the one input it can judge without a catalog read.
    const name = draftName.trim();
    if (name.length === 0) return;
    postCommand(CMD_CREATE_QUEUE, { name });
    cancelCreate();
  }

  function onCardKeyDown(event: KeyboardEvent, queueId: string): void {
    // A `<button>` already fires click on Enter and Space in a browser; jsdom
    // does not synthesise that, and an explicit handler also covers hosts where
    // the card is re-rendered as something else.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectQueue(queueId);
  }

  function runLabel(runtime: QueueRuntime): string | null {
    return runtime.inFlightRun?.feature?.label ?? null;
  }
</script>

<main class="queues-tier" data-testid="queues-tier" aria-label="Queues">
  <header class="tier-header">
    <div>
      <h1>Queues</h1>
      <p>Monitor and manage parallel execution queues and lifecycles.</p>
    </div>
    {#if isPrimary}
      <div class="header-actions">
        <button type="button" data-testid="queue-settings-open" onclick={openConfig}>
          Queue Settings
        </button>
        {#if !creating}
          <button type="button" class="primary" data-testid="queue-create" onclick={openCreate}>
            New Queue
          </button>
        {/if}
      </div>
    {/if}
  </header>

  {#if configuring}
    <!-- FR-R3-130 (T1495) — the machine's memory, so the dialog can say what the
         cap will cost at the moment it is typed. -->
    <QueueConfigModal
      generalSettings={snapshotStore.generalSettings}
      {queues}
      machineMemoryBytes={snapshotStore.snapshot?.streamPressure?.machineMemoryBytes ?? 0}
      onClose={closeConfig}
      originatingElement={configOpener}
    />
  {/if}

  {#if creating}
    <div class="create-row">
      <input
        type="text"
        data-testid="queue-create-name"
        placeholder="Queue name"
        aria-label="New queue name"
        bind:value={draftName}
      />
      <button type="button" class="primary" data-testid="queue-create-submit" onclick={submitCreate}>
        Create
      </button>
      <button type="button" data-testid="queue-create-cancel" onclick={cancelCreate}>Cancel</button>
    </div>
  {/if}

  {#if ordered.length === 0}
    <p class="empty" data-testid="queues-empty">No queues have been registered yet.</p>
  {:else}
    <div class="queue-grid">
      {#each ordered as runtime (runtime.queueId)}
        <button
          type="button"
          class="queue-card"
          data-testid="queue-card-{runtime.queueId}"
          data-selected={runtime.queueId === selectedQueueId ? 'true' : 'false'}
          aria-label="Open queue {runtime.name}"
          onclick={() => onSelectQueue(runtime.queueId)}
          onkeydown={(event) => onCardKeyDown(event, runtime.queueId)}
        >
          <span class="card-head">
            <span class="queue-name">{runtime.name}</span>
            <span class="lifecycle" data-testid="queue-lifecycle-{runtime.queueId}">
              {queueLifecycleLabel(runtime.lifecycle)}
            </span>
          </span>
          <span class="card-body">
            {#if runLabel(runtime) !== null}
              <span class="active-run" data-testid="queue-active-run-{runtime.queueId}">
                {runLabel(runtime)}
              </span>
            {/if}
            <span class="pending" data-testid="queue-pending-{runtime.queueId}">
              {runtime.pendingCount} pending
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</main>

<style>
  .queues-tier {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    overflow-y: auto;
  }

  .tier-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }

  .tier-header h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .tier-header p {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  button {
    font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
  }

  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }

  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .create-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .create-row input {
    flex: 1;
    font: inherit;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .queue-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }

  .queue-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    text-align: left;
    background: var(--vscode-editorWidget-background);
    border-top: 2px solid var(--vscode-focusBorder);
  }

  .queue-card[data-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background));
  }

  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .queue-name {
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .lifecycle {
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .active-run {
    color: var(--vscode-editor-foreground);
  }
</style>
