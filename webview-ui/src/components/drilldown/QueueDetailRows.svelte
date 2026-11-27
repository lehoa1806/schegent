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
  // budget, and a connected run's row is drawn by `QueueRunRow.svelte` on the
  // same terms. This file retains the container layout, the search and status
  // filter above the rows, the column header, each row's menu, the grid every
  // row shares, and all drag-and-drop / reorder / move orchestration.
  //
  // A row is one button on that grid rather than a table row (BUG-003): the
  // button opens the row's run, and the controls that act on a Task — the drag
  // handle, the move select and the row menu — sit beside it, never inside it.
  //
  // Refusals travel back up rather than rendering here: the tier shows one
  // refusal line for every control it owns, and a second line inside the row
  // list would put two different refusals on screen with no way to tell which
  // control answered.

  import { moveTask, refusalText } from '../../lib/queue-control-ipc';
  import { postMoveItemDown, postMoveItemUp, postReorderTask } from '../../lib/reorder-task';
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
  import { buildQueueRunRows, type ConnectedRunRow } from '../../lib/queue-run-rows';
  import { QUEUE_ROW_VIEWS, queueRowVisible, type QueueRowFacts, type QueueRowView } from '../../lib/queue-row-filter';
  import { findTaskPipeline, resolveTaskPipelineName } from '../../lib/resolve-pipeline-name';
  import { deriveTaskTiming } from '../../lib/task-row-view';
  import { nowFine } from '../../lib/tick-store';
  import SgMenu from '../sg/SgMenu.svelte';
  import QueueRunRow from './QueueRunRow.svelte';
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

  // ---------- Search and status filter ----------
  // The filter narrows what is drawn and nothing else: each row keeps its
  // number in the whole queue's order, and a drop still posts the target's own
  // position, so a hidden row changes no reorder.
  let view = $state<QueueRowView>('all');
  let query = $state('');

  function rowFacts(row: Row): QueueRowFacts {
    return row.kind === 'run'
      ? { status: row.run.status, label: row.run.label, id: row.run.connectedRunId }
      : { status: row.task.status, label: row.task.label, id: row.task.id };
  }

  const numberedRows = $derived(rows.map((row, index) => ({ row, index })));
  const visibleRows = $derived(
    numberedRows.filter(({ row }) => queueRowVisible(rowFacts(row), view, query))
  );

  // The move select's column is widened only while a row on screen draws one.
  const anyMove = $derived(
    isPrimary &&
      moveTargets.length > 0 &&
      visibleRows.some(({ row }) => row.kind === 'task' && row.task.status === 'pending')
  );

  function showEverything(): void {
    view = 'all';
    query = '';
  }

  // ---------- IPC handlers ----------
  // FR-R4-F05 (I6, I8, FR-024) — one text path for an on-time and a late answer, so a late one
  // replaces the not-yet-known text; unmounting aborts the waits.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showResult(result: { readonly status: 'accepted' | 'rejected'; readonly reason?: string }): void {
    onRefusal(result.status === 'rejected' ? refusalText(result.reason ?? 'rejected') : null);
  }
  const wait = { signal: lifetime.signal, onLateOutcome: showResult };

  async function moveTaskTo(taskId: string, event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const targetQueueId = select.value;
    select.value = '';
    if (targetQueueId.length === 0) return;
    onRefusal(null);
    showResult(await moveTask(taskId, targetQueueId, wait));
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
    showResult(await postReorderTask(sourceId, targetPosition, wait));
  }

  function onDragEnd(): void { dragArmedTaskId = null; }

  async function onMoveUp(taskId: string): Promise<void> {
    onRefusal(null);
    showResult(await postMoveItemUp(taskId, wait));
  }

  async function onMoveDown(taskId: string): Promise<void> {
    onRefusal(null);
    showResult(await postMoveItemDown(taskId, wait));
  }
</script>

<div class="rows" data-testid="queue-detail-rows">
  {#if rows.length === 0}
    <p class="empty" data-testid="queue-detail-empty">This queue has no work yet.</p>
  {:else}
    <div class="toolbar">
      <div class="search">
        <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
        <input
          class="input"
          type="search"
          placeholder="Search tasks"
          aria-label="Search tasks"
          data-testid="queue-detail-search"
          bind:value={query}
        />
      </div>
      <div class="seg" role="group" aria-label="Show">
        {#each QUEUE_ROW_VIEWS as option (option.id)}
          <button
            type="button"
            aria-pressed={view === option.id}
            data-testid="queue-detail-show-{option.id}"
            onclick={() => (view = option.id)}
          >{option.label}</button>
        {/each}
      </div>
    </div>

    <div class="table-wrap">
      <div class="qgrid" class:has-move={anyMove}>
        <div class="qhead" aria-hidden="true">
          <span>#</span><span>Task</span><span>Progress</span><span>Status</span><span>Time</span><span></span>
        </div>

        {#each visibleRows as { row, index } (row.key)}
          {#if row.kind === 'run'}
            <div
              class="row-wrap"
              class:sel={row.run.connectedRunId === selectedRunId}
              role="group"
              aria-label="{row.run.label} row"
            >
              <QueueRunRow
                run={row.run}
                rowIndex={index}
                isSelected={row.run.connectedRunId === selectedRunId}
                onSelect={() => selectRow(row)}
                onKeyDown={(event) => onRowKeyDown(event, row)}
              />
              <div class="c-acts">
                <SgMenu label="Actions for {row.run.label}" testid="queue-run-menu-{row.run.connectedRunId}">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="queue-run-open-{row.run.connectedRunId}"
                    onclick={() => selectRow(row)}
                  ><svg class="i" aria-hidden="true"><use href="#i-open"></use></svg>Open</button>
                </SgMenu>
              </div>
            </div>
          {:else}
            {@const pipeline = findTaskPipeline(row.task, snapshot.availablePipelines)}
            {@const pipelineName = resolveTaskPipelineName(row.task, snapshot.availablePipelines)}
            <!--
              FR-R3-158 (T023) — the host's figure, passed through. The row derives
              nothing: `phaseProgress` arrives already paired with the total it was
              counted against, and `null` means the host could not resolve one, which
              the row renders as no figure rather than as a zero.

              T024 — `pipeline` above stays. It is not the progress lookup any more;
              `QueueTaskRow` still needs the definition for the phase-segment bar and
              the process-id line, neither of which counts anything.
            -->
            {@const progress = row.task.phaseProgress}
            {@const timing = deriveTaskTiming(row.task, $nowFine)}
            {@const canReorder = isPrimary && row.task.status === 'pending'}
            <div
              class="row-wrap"
              class:sel={row.task.id === selectedRunId}
              class:has-grip={canReorder}
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
                  title="Drag to reorder, or use the row menu"
                  onmousedown={() => onHandleMouseDown(row.task.id)}
                  onmouseup={onHandleMouseUp}
                ><svg class="i" aria-hidden="true"><use href="#i-grip"></use></svg></button>
              {/if}
              <QueueTaskRow
                task={row.task}
                rowIndex={index}
                {pipeline}
                {pipelineName}
                {progress}
                {timing}
                isSelected={row.task.id === selectedRunId}
                onSelect={() => selectRow(row)}
                onKeyDown={(event) => onRowKeyDown(event, row)}
              />
              <div class="c-acts">
                {#if canReorder && moveTargets.length > 0}
                  <select class="input move" data-testid="queue-task-move-{row.task.id}"
                    aria-label="Move {row.task.label} to another queue"
                    onchange={(event) => moveTaskTo(row.task.id, event)}>
                    <option value="">Move to&hellip;</option>
                    {#each moveTargets as target (target.id)}<option value={target.id}>{target.name}</option>{/each}
                  </select>
                {/if}
                <SgMenu label="Actions for {row.task.label}" testid="queue-task-menu-{row.task.id}">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="queue-task-open-{row.task.id}"
                    onclick={() => selectRow(row)}
                  ><svg class="i" aria-hidden="true"><use href="#i-open"></use></svg>Open</button>
                  {#if canReorder}
                    <hr />
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="queue-task-reorder-up-{row.task.id}"
                      onclick={() => onMoveUp(row.task.id)}
                    ><svg class="i" aria-hidden="true"><use href="#i-up"></use></svg>Move up</button>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="queue-task-reorder-down-{row.task.id}"
                      onclick={() => onMoveDown(row.task.id)}
                    ><svg class="i" aria-hidden="true"><use href="#i-down"></use></svg>Move down</button>
                  {/if}
                </SgMenu>
              </div>
            </div>
          {/if}
        {/each}

        {#if visibleRows.length === 0}
          <p class="empty" data-testid="queue-detail-no-match">
            No tasks match. <button
              type="button"
              class="linkbtn"
              data-testid="queue-detail-show-everything"
              onclick={showEverything}
            >Show all tasks</button>
          </p>
        {/if}
      </div>
    </div>

    <p class="countline" data-testid="queue-detail-countline">{isPrimary
        ? 'Tasks run top to bottom. Drag a pending task, or use its menu, to change the order.'
        : 'Tasks run top to bottom.'}</p>
  {/if}
</div>

<style>
  /* The columns every row shares: the run-order number, the task, its progress,
     its status and its time, then the row's own controls. A row's button spans
     the first five and lays its cells out on the same widths; its controls take
     the sixth, outside the button (BUG-003). */
  .rows {
    --q-num: 56px;
    --q-prog: 176px;
    --q-status: 120px;
    --q-time: 124px;
    --q-acts: 48px;
    --q-cells: var(--q-num) minmax(200px, 1fr) var(--q-prog) var(--q-status) var(--q-time);
  }

  .qgrid {
    min-width: calc(var(--q-num) + 200px + var(--q-prog) + var(--q-status) + var(--q-time) + var(--q-acts));
  }

  .qgrid.has-move { --q-acts: 168px; }

  .qhead,
  .row-wrap {
    display: grid;
    grid-template-columns: var(--q-cells) var(--q-acts);
  }

  .qhead {
    background: var(--schegent-shell-bg);
    border-bottom: 1px solid var(--schegent-border);
  }

  .qhead span {
    padding: 7px var(--schegent-space-3);
    font-size: var(--schegent-text-secondary);
    font-weight: 600;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
  }

  .row-wrap {
    position: relative;
    border-bottom: 1px solid var(--schegent-border);
  }

  .row-wrap:last-child { border-bottom: 0; }
  .row-wrap:not(.sel):hover { background: var(--schegent-list-hover); }

  /* The ring is transparent until a high contrast theme sets it, where the fill alone does not
     show (theme.css). */
  .row-wrap.sel {
    background: var(--schegent-selection-bg);
    color: var(--schegent-selection-fg);
    box-shadow: inset 0 0 0 1px var(--schegent-selection-outline);
  }

  .row-wrap.sel :global(:is(.rowname, .sub, .muted, .small)) { color: inherit; }
  .row-wrap.sel :global(.chip) { color: inherit; --sg-status-color: currentColor; }

  /* Every row's button: a task's (QueueTaskRow) and a connected run's (QueueRunRow). */
  .rows :global(.qrow) {
    grid-column: 1 / 6;
    grid-row: 1;
    display: grid;
    grid-template-columns: var(--q-cells);
    align-items: start;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* The row does not shift on press: it is the whole width of the table, and
     the hover fill already answers the pointer. */
  .rows :global(.qrow:active) { transform: none; }
  .rows :global(.qrow:focus-visible) { outline-offset: -2px; }

  .rows :global(.qrow > .cell) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    padding: var(--schegent-space-2) var(--schegent-space-3);
  }

  .row-wrap.has-grip :global(.c-num) { padding-left: 32px; }

  .drag-handle {
    position: absolute;
    top: var(--schegent-space-2);
    left: var(--schegent-space-3);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 20px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.55;
    cursor: grab;
  }

  .drag-handle:hover { opacity: 1; }
  .row-wrap[draggable='true']:active .drag-handle { cursor: grabbing; }

  .c-acts {
    grid-column: 6;
    grid-row: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    gap: var(--schegent-space-1-5);
    padding: var(--schegent-space-1) var(--schegent-space-2);
  }

  .move {
    width: auto;
    font-size: var(--schegent-text-secondary);
  }

  /* A coarse pointer makes the handle and every button 44px square (theme.css),
     so the number moves right of the larger handle and the controls' column
     grows to hold the larger menu button. */
  @media (pointer: coarse) {
    .rows { --q-num: 84px; --q-acts: 64px; }
    .qgrid.has-move { --q-acts: 184px; }
    .row-wrap.has-grip :global(.c-num) { padding-left: 52px; }
    .drag-handle { top: 0; left: var(--schegent-space-1); }
  }
</style>
