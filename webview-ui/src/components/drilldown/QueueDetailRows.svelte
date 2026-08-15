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
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
  import { buildQueueRunRows, type ConnectedRunRow } from '../../lib/queue-run-rows';
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
        <div class="row-wrap">
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
          <!--
            FR-015 — only a pending Task moves. A Task that has started is
            executing against this queue's lease, and a Task that has finished
            is a record. The select sits beside the row rather than inside it:
            the row is a `<button>`, and interactive content does not nest.
          -->
          {#if isPrimary && row.task.status === 'pending' && moveTargets.length > 0}
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
</style>
