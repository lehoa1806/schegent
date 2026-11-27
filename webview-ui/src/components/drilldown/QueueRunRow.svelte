<script lang="ts">
  // The five cells of a connected run's row on the Queue Detail grid. FR-047
  // draws a connected run as ONE row for all of its member Tasks, so the row
  // names the run, the workflow it runs and how many Tasks it holds, and its bar
  // counts the run's nodes rather than one Task's phases.
  //
  // It is QueueTaskRow's counterpart and splits the same way: the grid these
  // cells sit on, the row's hover and selection, and its menu belong to
  // QueueDetailRows. It receives the collapsed row as a prop; it performs no IPC
  // and holds no state.

  import { queueRowStatusChip } from '../../lib/queue-row-status';
  import type { ConnectedRunRow } from '../../lib/queue-run-rows';

  interface Props {
    readonly run: ConnectedRunRow;
    readonly rowIndex: number;
    readonly isSelected: boolean;
    readonly onSelect: () => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
  }

  const { run, rowIndex, isSelected, onSelect, onKeyDown }: Props = $props();

  const chip = $derived(queueRowStatusChip(run.status));
  const members = $derived(run.memberTaskIds.length);
</script>

<button
  type="button"
  class="qrow status-{run.status}"
  data-row-key="run:{run.connectedRunId}"
  data-testid="queue-run-row-{run.connectedRunId}"
  data-selected={isSelected ? 'true' : 'false'}
  aria-label="Open connected run {run.label}"
  onclick={onSelect}
  onkeydown={onKeyDown}
>
  <span class="cell c-num muted">{rowIndex + 1}</span>

  <span class="cell c-task">
    <span class="rowname">{run.label}</span>
    <span class="sub"><svg class="i" aria-hidden="true"><use href="#i-workflow"></use></svg>
      <span class="mono">{run.workflowId}</span> · {members} {members === 1 ? 'task' : 'tasks'} ·
      <span class="mono">{run.connectedRunId}</span></span>
  </span>

  <span class="cell c-prog">
    <span class="bar" aria-hidden="true">
      {#each Array(run.nodeCount) as _, i}
        <span class:d={i < run.completedNodeCount}></span>
      {/each}
    </span>
    <span class="small">{run.completedNodeCount} of {run.nodeCount} nodes</span>
  </span>

  <span class="cell c-status">
    <span class="chip {chip.tone}" data-testid="queue-run-status-{run.connectedRunId}">{#if chip.icon === null}<span class="dot" aria-hidden="true"></span>{:else}<svg class="i" aria-hidden="true"><use href={chip.icon}></use></svg>{/if}{chip.label}</span>
  </span>

  <span class="cell c-time small muted">&mdash;</span>
</button>
