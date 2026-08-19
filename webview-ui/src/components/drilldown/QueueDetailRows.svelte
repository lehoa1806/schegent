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
  // Feature 097 redesign: the visual rendering of each standalone task row was
  // extracted into `QueueTaskRow.svelte` to keep both files under the 500-line
  // budget. This file retains the container layout, the table header, the
  // connected-run rows, and all drag-and-drop / reorder / move orchestration.
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
  import { nowFine } from '../../lib/tick-store';
  import QueueTaskRow from './QueueTaskRow.svelte';
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

  // ---------- Status display (connected-run rows only) ----------
  function statusDisplayLabel(status: string): string {
    if (status === 'completed') return 'DONE';
    if (status === 'in-flight') return 'RUNNING';
    return status.toUpperCase();
  }

  // ---------- IPC handlers ----------
  async function moveTaskTo(taskId: string, event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const targetQueueId = select.value;
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
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectRow(row);
  }

  // US2/T034 (feature 030) reorder, ported onto the FR-047 collapsed-row list.
  let dragArmedTaskId = $state<string | null>(null);

  function onHandleMouseDown(taskId: string): void { dragArmedTaskId = taskId; }
  function onHandleMouseUp(): void { dragArmedTaskId = null; }

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

  function onDragEnd(): void { dragArmedTaskId = null; }

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
    <!-- Table header -->
    <div class="table-header" role="row" aria-hidden="true">
      <span class="th th-position">#</span>
      <span class="th th-prompt">PROMPT</span>
      <span class="th th-process">PROCESS</span>
      <span class="th th-progress">PROGRESS</span>
      <span class="th th-time">TIME</span>
      <span class="th th-status">STATUS</span>
      <span class="th th-chevron"></span>
    </div>

    {#each rows as row, rowIndex (row.key)}
      {#if row.kind === 'run'}
        <!-- Connected-run row -->
        <button
          type="button"
          class="table-row status-{row.run.status}"
          data-row-key={row.key}
          data-testid="queue-run-row-{row.run.connectedRunId}"
          data-selected={row.run.connectedRunId === selectedRunId ? 'true' : 'false'}
          aria-label="Open connected run {row.run.label}"
          onclick={() => selectRow(row)}
          onkeydown={(event) => onRowKeyDown(event, row)}
        >
          <span class="cell cell-position">{rowIndex + 1}</span>
          <span class="cell cell-prompt">
            <span class="prompt-label">{row.run.label}</span>
            <span class="prompt-id">{row.run.connectedRunId}</span>
            <span class="workflow-badge">WORKFLOW · {row.run.memberTaskIds.length} TASKS COLLAPSED</span>
          </span>
          <span class="cell cell-process">
            <span class="process-name">Workflow</span>
            <span class="process-id">workflow · {row.run.workflowId}</span>
          </span>
          <span class="cell cell-progress">
            <span class="progress-bar">
              {#each Array(row.run.nodeCount) as _, i}
                <span
                  class="phase-seg"
                  class:seg-completed={i < row.run.completedNodeCount}
                  class:seg-future={i >= row.run.completedNodeCount}
                ></span>
              {/each}
            </span>
            <span class="progress-text">
              {row.run.completedNodeCount} of {row.run.nodeCount} nodes
            </span>
          </span>
          <span class="cell cell-time"><span class="time-primary">&mdash;</span></span>
          <span class="cell cell-status">
            <span class="status-badge badge-{row.run.status}">{statusDisplayLabel(row.run.status)}</span>
          </span>
          <span class="cell cell-chevron" aria-hidden="true">›</span>
        </button>
      {:else}
        <!-- Standalone task row with drag-and-drop wrapper -->
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
                <circle cx="6" cy="3" r="1.2" /><circle cx="6" cy="7" r="1.2" />
                <circle cx="6" cy="11" r="1.2" /><circle cx="6" cy="15" r="1.2" />
                <circle cx="10" cy="3" r="1.2" /><circle cx="10" cy="7" r="1.2" />
                <circle cx="10" cy="11" r="1.2" /><circle cx="10" cy="15" r="1.2" />
              </svg>
            </button>
          {/if}
          <QueueTaskRow
            task={row.task}
            {rowIndex}
            {pipeline}
            {pipelineName}
            {progress}
            {timing}
            isSelected={row.task.id === selectedRunId}
            onSelect={() => selectRow(row)}
            onKeyDown={(event) => onRowKeyDown(event, row)}
          />
          {#if canReorder}
            <button type="button" class="reorder-btn" data-testid="queue-task-reorder-up-{row.task.id}"
              title="Move up" aria-label="Move {row.task.label} up"
              onclick={() => onMoveUp(row.task.id)}>&#9650;</button>
            <button type="button" class="reorder-btn" data-testid="queue-task-reorder-down-{row.task.id}"
              title="Move down" aria-label="Move {row.task.label} down"
              onclick={() => onMoveDown(row.task.id)}>&#9660;</button>
          {/if}
          {#if canReorder && moveTargets.length > 0}
            <select class="move" data-testid="queue-task-move-{row.task.id}"
              aria-label="Move {row.task.label} to another queue"
              onchange={(event) => moveTaskTo(row.task.id, event)}>
              <option value="">Move to&hellip;</option>
              {#each moveTargets as target (target.id)}<option value={target.id}>{target.name}</option>{/each}
            </select>
          {/if}
        </div>
      {/if}
    {/each}

    <p class="ordering-note">
      Ordered by <strong>position</strong>, ascending — the order the queue will work,
      which starts as added order. Statuses interleave on purpose: there is no grouping.
    </p>
  {/if}
</div>

<style>
  .rows { display: flex; flex-direction: column; gap: 0; padding: 0 20px; }
  .empty { margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }

  /* 7-column grid shared by header and connected-run rows */
  .table-header,
  .table-row {
    display: grid;
    grid-template-columns: 36px 2fr 1fr 1.5fr auto auto 28px;
    gap: 12px;
    align-items: start;
    text-align: left;
    padding: 8px 12px;
  }

  .table-header {
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
    padding-top: 4px;
    padding-bottom: 6px;
  }

  .th {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); user-select: none;
  }

  /* Connected-run row */
  .table-row {
    font: inherit; color: var(--vscode-foreground); cursor: pointer;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border, transparent) 40%, transparent);
    border-radius: 0; background: transparent; transition: background-color 120ms ease-out;
  }
  .table-row:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 5%, transparent)); }
  .table-row[data-selected='true'] { background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background)); }
  .table-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  .cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cell-position { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-descriptionForeground); justify-content: center; align-items: center; padding-top: 2px; }
  .cell-prompt { gap: 3px; }
  .prompt-label { font-weight: 500; color: var(--vscode-editor-foreground); white-space: pre-wrap; word-break: break-word; line-height: 1.35; }
  .prompt-id { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.75; }

  .workflow-badge {
    display: inline-flex; align-self: flex-start; padding: 2px 8px; margin-top: 2px;
    background: color-mix(in srgb, var(--schegent-color-active) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--schegent-color-active) 30%, transparent);
    border-radius: 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
    color: var(--schegent-color-active); text-transform: uppercase;
  }

  .cell-process { gap: 2px; }
  .process-name { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); }
  .process-id { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; }
  .cell-progress { gap: 4px; }
  .progress-bar { display: flex; gap: 2px; align-items: center; height: 8px; }
  .phase-seg { flex: 1; height: 100%; border-radius: 2px; min-width: 6px; }
  .seg-completed { background: var(--schegent-color-active); }
  .seg-future { background: var(--schegent-muted-fg); opacity: 0.2; }
  .progress-text { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .cell-time { gap: 2px; white-space: nowrap; align-items: flex-end; }
  .time-primary { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; font-weight: 500; color: var(--vscode-foreground); }
  .cell-status { align-items: center; justify-content: center; padding-top: 2px; }

  .status-badge {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 2px 10px; border-radius: 4px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.05em; text-transform: uppercase; white-space: nowrap;
  }
  .badge-in-flight { background: color-mix(in srgb, var(--schegent-color-active) 18%, transparent); color: var(--schegent-color-active); border: 1px solid color-mix(in srgb, var(--schegent-color-active) 35%, transparent); }
  .badge-completed { background: color-mix(in srgb, var(--schegent-color-completed) 18%, transparent); color: var(--schegent-color-completed); border: 1px solid color-mix(in srgb, var(--schegent-color-completed) 35%, transparent); }
  .badge-failed { background: color-mix(in srgb, var(--schegent-color-error) 18%, transparent); color: var(--schegent-color-error); border: 1px solid color-mix(in srgb, var(--schegent-color-error) 35%, transparent); }
  .badge-pending { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, transparent); }
  .badge-paused { background: color-mix(in srgb, var(--schegent-color-warning) 18%, transparent); color: var(--schegent-color-warning); border: 1px solid color-mix(in srgb, var(--schegent-color-warning) 35%, transparent); }
  .badge-canceled { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, transparent); opacity: 0.7; }

  .cell-chevron { font-size: 16px; color: var(--vscode-descriptionForeground); opacity: 0.4; align-items: center; justify-content: center; padding-top: 2px; transition: opacity 120ms ease-out; }
  .table-row:hover .cell-chevron { opacity: 1; }

  /* Row wrapper for drag-and-drop + reorder controls */
  .row-wrap { display: flex; gap: 4px; align-items: start; }
  .row-wrap :global(.table-row) { flex: 1; min-width: 0; }

  .move { font: inherit; font-size: 11px; padding: 4px 6px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; margin-top: 8px; }

  .drag-handle { display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; width: 16px; min-width: 16px; min-height: 20px; padding: 0; margin-top: 10px; color: var(--vscode-descriptionForeground); cursor: grab; user-select: none; flex-shrink: 0; }
  .drag-handle:hover { color: var(--vscode-foreground); }
  .drag-handle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .drag-handle-icon { width: 12px; height: 16px; fill: currentColor; }
  .row-wrap[draggable='true']:active .drag-handle { cursor: grabbing; }

  .reorder-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; flex-shrink: 0; padding: 0 4px; font: inherit; line-height: 1; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; cursor: pointer; margin-top: 8px; }
  .reorder-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .reorder-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .ordering-note { margin: 12px 0 0; padding: 8px 0; font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.6; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border, transparent) 30%, transparent); }
</style>
