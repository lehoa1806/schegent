<script lang="ts">
  // Feature 092 (T108, FR-057, FR-064, FR-047, FR-065) — tier 2 of the drill-down.
  //
  // The tier's own chrome is thin on purpose. Everything the operations route
  // already renders for a queue — the pause/resume control, the composer, the
  // active/history tabs, the phase progression — is reused by embedding
  // `Dashboard` scoped to this queue via its one optional `queueId` prop, so this
  // component adds only what is genuinely new: the queue's identity, a throughput
  // reading, a configuration affordance, the FR-047 row collapse, and the back
  // step out.
  //
  // Embedding rather than replacing also keeps `Dashboard.svelte` mounted, which
  // `tests/lint/svelte-surface-reachability.test.ts` requires; and the embedded
  // pane owns the surface's single `<main>` landmark, so this component renders a
  // `<section>` and never a second one.
  //
  // Mockup: docs/mockup/schegent_mockup.html `view-queue-detail` and
  // `modal-queue-config`.

  import Dashboard from '../Dashboard.svelte';
  import { postCommand } from '../../lib/vscode-api';
  import { CMD_RENAME_QUEUE } from '../../lib/messages';
  import { queueLifecycleLabel } from '../../lib/queue-lifecycle-label';
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
  import { buildQueueRunRows, type ConnectedRunRow } from '../../lib/queue-run-rows';
  import type { QueueItem, WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The queue this tier is showing, as its `DashboardLocation` carries it. */
    queueId: string;
    /** FR-065 — a non-primary window reads every tier but mutates nothing. */
    isPrimary: boolean;
    /**
     * FR-060 — the row the operator last drilled into. The surface remembers it
     * so walking back lands on a tier that still shows where they were; this tier
     * only reflects it and holds no selection state of its own.
     */
    selectedRunId?: string | null;
    /** Reported, not acted on: the surface owns navigation (FR-060, FR-061). */
    onBack: () => void;
    onSelectRun?: (runId: string) => void;
  }

  const {
    snapshot,
    queueId,
    isPrimary,
    selectedRunId = null,
    onBack,
    onSelectRun = () => {}
  }: Props = $props();

  const runtime = $derived(findQueueRuntime(snapshot, queueId));
  const tasks = $derived(runtime?.tasks ?? []);
  const queueName = $derived(runtime?.name ?? queueId);

  // FR-047 — a connected run is ONE row. The collapse is derived from the
  // aggregate's node projections, so the wire carries nothing extra for it.
  const runRows = $derived(buildQueueRunRows(tasks, snapshot.connectedRuns));

  type Row =
    | { readonly kind: 'run'; readonly key: string; readonly position: number; readonly run: ConnectedRunRow }
    | { readonly kind: 'task'; readonly key: string; readonly position: number; readonly task: QueueItem };

  // Collapsed runs and standalone Tasks share one ordered list: a run sorts by
  // its earliest member's position, so the operator reads the queue in the order
  // the queue will work it rather than as two disjoint sections.
  const rows = $derived<readonly Row[]>(
    [
      ...runRows.rows.map(
        (run): Row => ({ kind: 'run', key: `run:${run.connectedRunId}`, position: run.position, run })
      ),
      ...runRows.standaloneTasks.map(
        (task): Row => ({ kind: 'task', key: `task:${task.id}`, position: task.position, task })
      )
    ].sort((a, b) => a.position - b.position)
  );

  // Throughput as this queue's own rows report it. Derived rather than published:
  // the counts are a fold over `QueueRuntime.tasks`, and a published total would
  // be a second source of truth for something the rows already say.
  const completedCount = $derived(tasks.filter((task) => task.status === 'completed').length);
  const failedCount = $derived(tasks.filter((task) => task.status === 'failed').length);
  const pendingCount = $derived(runtime?.pendingCount ?? 0);

  let configuring = $state(false);
  let draftName = $state('');

  function openConfig(): void {
    configuring = true;
    draftName = queueName;
  }

  function closeConfig(): void {
    configuring = false;
    draftName = '';
  }

  function submitRename(): void {
    // The host owns the uniqueness rule and every bound; the webview refuses only
    // the one input it can judge without reading the registry.
    const name = draftName.trim();
    if (name.length === 0) return;
    postCommand(CMD_RENAME_QUEUE, { queueId, name });
    closeConfig();
  }

  function selectRow(row: Row): void {
    onSelectRun(row.kind === 'run' ? row.run.connectedRunId : row.task.id);
  }

  function onRowKeyDown(event: KeyboardEvent, row: Row): void {
    // A `<button>` fires click on Enter and Space in a browser; jsdom does not
    // synthesise that, so FR-059's keyboard path is handled explicitly.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectRow(row);
  }
</script>

<section class="queue-detail-tier" data-testid="queue-detail-tier">
  <header class="tier-header">
    <button type="button" class="back" data-testid="queue-detail-back" onclick={onBack}>
      &larr; Queues
    </button>
    <div class="identity">
      <h1 data-testid="queue-detail-title">{queueName}</h1>
      <p class="meta">
        <span class="lifecycle" data-testid="queue-detail-lifecycle">
          {runtime === null ? 'Unknown' : queueLifecycleLabel(runtime.lifecycle)}
        </span>
        <span class="throughput" data-testid="queue-detail-throughput">
          {completedCount} completed &middot; {failedCount} failed &middot; {pendingCount} pending
        </span>
      </p>
    </div>
    {#if isPrimary && !configuring}
      <button
        type="button"
        data-testid="queue-config-open"
        aria-label="Queue settings"
        onclick={openConfig}
      >Settings</button>
    {/if}
  </header>

  {#if configuring}
    <div class="config-row">
      <input
        type="text"
        data-testid="queue-rename-name"
        aria-label="Queue name"
        bind:value={draftName}
      />
      <button type="button" class="primary" data-testid="queue-rename-submit" onclick={submitRename}>
        Rename
      </button>
      <button type="button" data-testid="queue-rename-cancel" onclick={closeConfig}>Cancel</button>
    </div>
  {/if}

  <div class="rows" data-testid="queue-detail-rows">
    {#if rows.length === 0}
      <p class="empty" data-testid="queue-detail-empty">This queue has no work yet.</p>
    {:else}
      {#each rows as row (row.key)}
        {#if row.kind === 'run'}
          <button
            type="button"
            class="row"
            data-row-key={row.key}
            data-testid="queue-run-row-{row.run.connectedRunId}"
            data-selected={row.run.connectedRunId === selectedRunId ? 'true' : 'false'}
            aria-label="Open connected run {row.run.label}"
            onclick={() => selectRow(row)}
            onkeydown={(event) => onRowKeyDown(event, row)}
          >
            <span class="row-label">{row.run.label}</span>
            <span class="row-kind">Workflow</span>
            <span class="row-progress">
              {row.run.completedNodeCount} of {row.run.nodeCount} nodes
            </span>
            <span class="row-status">{row.run.status}</span>
          </button>
        {:else}
          <button
            type="button"
            class="row"
            data-row-key={row.key}
            data-testid="queue-task-row-{row.task.id}"
            data-selected={row.task.id === selectedRunId ? 'true' : 'false'}
            aria-label="Open run {row.task.label}"
            onclick={() => selectRow(row)}
            onkeydown={(event) => onRowKeyDown(event, row)}
          >
            <span class="row-label">{row.task.label}</span>
            <span class="row-kind">Pipeline</span>
            <span class="row-progress">{row.task.currentPhase ?? ''}</span>
            <span class="row-status">{row.task.status}</span>
          </button>
        {/if}
      {/each}
    {/if}
  </div>

  <Dashboard {snapshot} {queueId} />
</section>

<style>
  .queue-detail-tier {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow-y: auto;
  }

  .tier-header {
    display: grid;
    grid-template-areas: 'back back' 'identity action';
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: end;
    padding: 16px 20px 0;
  }

  .back {
    grid-area: back;
    justify-self: start;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
  }

  .identity {
    grid-area: identity;
  }

  .tier-header h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .meta {
    display: flex;
    gap: 12px;
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .lifecycle {
    color: var(--vscode-textLink-foreground);
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

  .config-row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 0 20px;
  }

  .config-row input {
    flex: 1;
    font: inherit;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 20px;
  }

  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .row {
    display: grid;
    grid-template-columns: 2fr auto 1fr auto;
    gap: 12px;
    align-items: center;
    text-align: left;
    border-radius: 0;
    background: var(--vscode-editorWidget-background);
  }

  .row[data-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background));
  }

  .row-label {
    font-weight: 500;
    color: var(--vscode-editor-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-kind,
  .row-progress,
  .row-status {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
</style>
