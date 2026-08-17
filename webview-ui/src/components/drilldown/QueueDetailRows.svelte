<script lang="ts">
  // Feature 095 (T040) — the Queue Detail tier's row list, extracted.
  //
  // This is one concern and it is not the same as the tier's: the tier owns the
  // queue's identity and the controls that act on the *queue*, while this owns
  // the FR-047 collapse — how a connected run and its member Tasks become one
  // row — and the one control that acts on a single *Task*, the move select.
  // Feature 095 added enough queue-level control to the tier that the two no
  // longer fit one file inside `svelte-component-loc-budget`'s 500 lines, and
  // this was the seam already there.
  //
  // Refusals travel back up rather than rendering here: the tier shows one
  // refusal line for every control it owns, and a second line inside the row
  // list would put two different refusals on screen with no way to tell which
  // control answered.

  import { moveTask, refusalText } from '../../lib/queue-control-ipc';
  import { postMoveItemDown, postMoveItemUp, postReorderTask } from '../../lib/reorder-task';
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
  import { buildQueueRunRows, type ConnectedRunRow } from '../../lib/queue-run-rows';
  import { findTaskPipeline, resolveTaskPipelineName } from '../../lib/resolve-pipeline-name';
  import { deriveTaskPhaseProgress, deriveTaskTiming } from '../../lib/task-row-view';
  import { formatDuration } from '../../lib/format-duration';
  import { nowFine } from '../../lib/tick-store';
  import type { QueueItem, WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    queueId: string;
    /** FR-065 — a non-primary window reads every row but moves nothing. */
    isPrimary: boolean;
    /** FR-060 — reflected only; this component holds no selection state. */
    selectedRunId?: string | null;
    onSelectRun?: (runId: string) => void;
    /** `null` clears the tier's refusal line; a string replaces it. */
    onRefusal?: (text: string | null) => void;
  }

  const {
    snapshot,
    queueId,
    isPrimary,
    selectedRunId = null,
    onSelectRun = () => {},
    onRefusal = () => {}
  }: Props = $props();

  const tasks = $derived(findQueueRuntime(snapshot, queueId)?.tasks ?? []);

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

  // US4 — a Task can only move somewhere else that exists.
  const moveTargets = $derived(
    (snapshot.queue.queues ?? []).filter((summary) => summary.id !== queueId)
  );

  async function moveTaskTo(taskId: string, event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const targetQueueId = select.value;
    // Reset first: the row is about to leave this queue on success, and on a
    // refusal the operator should re-pick rather than see a stale selection.
    select.value = '';
    if (targetQueueId.length === 0) return;
    onRefusal(null);
    const result = await moveTask(taskId, targetQueueId);
    if (result.status === 'rejected') onRefusal(refusalText(result.reason));
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

  // US2/T034 (feature 030) reorder, ported onto the FR-047 collapsed-row list.
  // One shared id (not a per-row boolean) tracks which handle is pressed,
  // since every row here is rendered by this single component instance
  // rather than one `QueueItem` instance per row.
  let dragArmedTaskId = $state<string | null>(null);

  function onHandleMouseDown(taskId: string): void {
    dragArmedTaskId = taskId;
  }

  function onHandleMouseUp(): void {
    dragArmedTaskId = null;
  }

  function onDragStart(event: DragEvent, taskId: string): void {
    if (dragArmedTaskId !== taskId) return;
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', taskId);
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  async function onDrop(
    event: DragEvent,
    targetTaskId: string,
    targetPosition: number
  ): Promise<void> {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') ?? '';
    if (sourceId.length === 0 || sourceId === targetTaskId) return;
    onRefusal(null);
    const result = await postReorderTask(sourceId, targetPosition);
    if (result.status === 'rejected') onRefusal(refusalText(result.reason));
  }

  function onDragEnd(): void {
    dragArmedTaskId = null;
  }

  async function onMoveUp(taskId: string): Promise<void> {
    onRefusal(null);
    const result = await postMoveItemUp(taskId);
    if (result.status === 'rejected') onRefusal(refusalText(result.reason));
  }

  async function onMoveDown(taskId: string): Promise<void> {
    onRefusal(null);
    const result = await postMoveItemDown(taskId);
    if (result.status === 'rejected') onRefusal(refusalText(result.reason));
  }
</script>

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
        {@const pipeline = findTaskPipeline(row.task, snapshot.availablePipelines)}
        {@const pipelineName = resolveTaskPipelineName(row.task, snapshot.availablePipelines)}
        {@const progress = deriveTaskPhaseProgress(row.task, pipeline)}
        {@const timing = deriveTaskTiming(row.task, $nowFine)}
        {@const canReorder = isPrimary && row.task.status === 'pending'}
        <div
          class="row-wrap"
          role="group"
          aria-label="{row.task.label} row"
          draggable={canReorder && dragArmedTaskId === row.task.id}
          ondragstart={(event) => onDragStart(event, row.task.id)}
          ondragover={canReorder ? onDragOver : undefined}
          ondrop={canReorder ? (event) => onDrop(event, row.task.id, row.task.position) : undefined}
          ondragend={onDragEnd}
        >
          {#if canReorder}
            <button
              type="button"
              class="drag-handle"
              data-testid="queue-task-drag-handle-{row.task.id}"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              onmousedown={() => onHandleMouseDown(row.task.id)}
              onmouseup={onHandleMouseUp}
            >
              <svg class="drag-handle-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle cx="6" cy="3" r="1.2" />
                <circle cx="6" cy="7" r="1.2" />
                <circle cx="6" cy="11" r="1.2" />
                <circle cx="6" cy="15" r="1.2" />
                <circle cx="10" cy="3" r="1.2" />
                <circle cx="10" cy="7" r="1.2" />
                <circle cx="10" cy="11" r="1.2" />
                <circle cx="10" cy="15" r="1.2" />
              </svg>
            </button>
          {/if}
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
            <span class="row-kind" data-testid="queue-task-pipeline-{row.task.id}">
              {pipelineName}
            </span>
            <span class="row-progress" data-testid="queue-task-progress-{row.task.id}">
              {row.task.currentPhase ?? '—'} ({progress.completed}/{progress.total})
            </span>
            <span class="row-status">{row.task.status}</span>
            <span class="row-timing" data-testid="queue-task-timing-{row.task.id}">
              {timing.kind === 'waiting'
                ? `Waiting ${formatDuration(timing.value)}`
                : `${formatDuration(timing.value)} elapsed`}
            </span>
            {#if row.task.retryCount > 0}
              <span class="row-retry" data-testid="queue-task-retry-{row.task.id}">
                Retried {row.task.retryCount}&times;
              </span>
            {/if}
            {#if row.task.lastErrorSummary !== null}
              <span class="row-error" data-testid="queue-task-error-{row.task.id}">
                {row.task.lastErrorSummary}
              </span>
            {/if}
          </button>
          <!--
            FR-015 / US2 (feature 030) — only a pending Task moves or reorders.
            A Task that has started is executing against this queue's lease,
            and a Task that has finished is a record. These controls sit
            beside the row rather than inside it: the row is a `<button>`,
            and interactive content does not nest.
          -->
          {#if canReorder}
            <button
              type="button"
              class="reorder-btn"
              data-testid="queue-task-reorder-up-{row.task.id}"
              title="Move up"
              aria-label="Move {row.task.label} up"
              onclick={() => onMoveUp(row.task.id)}
            >&#9650;</button>
            <button
              type="button"
              class="reorder-btn"
              data-testid="queue-task-reorder-down-{row.task.id}"
              title="Move down"
              aria-label="Move {row.task.label} down"
              onclick={() => onMoveDown(row.task.id)}
            >&#9660;</button>
          {/if}
          {#if canReorder && moveTargets.length > 0}
            <select
              class="move"
              data-testid="queue-task-move-{row.task.id}"
              aria-label="Move {row.task.label} to another queue"
              onchange={(event) => moveTaskTo(row.task.id, event)}
            >
              <option value="">Move to&hellip;</option>
              {#each moveTargets as target (target.id)}
                <option value={target.id}>{target.name}</option>
              {/each}
            </select>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
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

  .row-wrap {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .row-wrap .row {
    flex: 1;
    min-width: 0;
  }

  .move {
    font: inherit;
    font-size: 11px;
    padding: 4px 6px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 4px;
  }

  .drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    width: 16px;
    min-width: 16px;
    min-height: 20px;
    padding: 0;
    color: var(--vscode-descriptionForeground);
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }

  .drag-handle:hover {
    color: var(--vscode-foreground);
  }

  .drag-handle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .drag-handle-icon {
    width: 12px;
    height: 16px;
    fill: currentColor;
  }

  .row-wrap[draggable='true']:active .drag-handle {
    cursor: grabbing;
  }

  .reorder-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    flex-shrink: 0;
    padding: 0 4px;
    font: inherit;
    line-height: 1;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    cursor: pointer;
  }

  .reorder-btn:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground);
  }

  .reorder-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  /*
    The tier's generic `button` rule does not reach here — Svelte scopes styles
    per component — so the row reproduces it inline. These declarations are that
    rule's, not new ones; only `border-radius`, `background` and the grid are
    the row's own, exactly as they overrode it before the extraction.
  */
  .row {
    display: grid;
    grid-template-columns: 2fr auto 1fr auto;
    gap: 12px;
    align-items: center;
    text-align: left;
    font: inherit;
    color: var(--vscode-foreground);
    padding: 6px 12px;
    cursor: pointer;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 0;
    background: var(--vscode-editorWidget-background);
  }

  .row[data-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background));
  }

  .row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
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

  .row-timing,
  .row-retry,
  .row-error {
    grid-column: 1 / -1;
    text-align: left;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .row-retry {
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  }

  .row-error {
    color: var(--vscode-errorForeground);
    overflow-wrap: anywhere;
  }
</style>
