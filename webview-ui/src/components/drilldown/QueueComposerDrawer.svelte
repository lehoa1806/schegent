<script lang="ts">
  // What the redesign's add-task drawer holds: a heading naming the queue, where
  // the new task will wait, the composer, and the ways out. QueueDetailTier owns
  // the drawer itself — when it opens, and where focus goes when it closes.

  import QueueTaskComposer from '../QueueTaskComposer.svelte';
  import type { BatchSubmissionState } from '../../lib/task-batch';
  import type { WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    queueId: string;
    queueName: string;
    /** This queue's pending tasks, which a new task waits behind. */
    pendingCount: number;
    onBatchStateChange: (next: BatchSubmissionState) => void;
    onClose: () => void;
  }

  const { snapshot, queueId, queueName, pendingCount, onBatchStateChange, onClose }: Props = $props();

  const position = $derived(
    pendingCount === 0
      ? 'No pending tasks ahead of it.'
      : `Runs after the ${pendingCount} pending task${pendingCount === 1 ? '' : 's'}.`
  );
</script>

<div class="dh">
  <div class="heading">
    <h2 id="queue-composer-heading" tabindex="-1">Add task to {queueName}</h2>
    <div class="small muted" data-testid="queue-composer-position">{position}</div>
  </div>
  <button type="button" class="icon-btn" aria-label="Close" data-testid="queue-composer-close" onclick={onClose}>
    <svg class="i" aria-hidden="true"><use href="#i-x"></use></svg>
  </button>
</div>
<div class="db">
  <QueueTaskComposer {snapshot} {queueId} {onBatchStateChange} />
</div>
<div class="df">
  <button type="button" class="btn btn-secondary" data-testid="queue-composer-cancel" onclick={onClose}>Cancel</button>
</div>

<style>
  .heading {
    flex: 1;
    min-width: 0;
  }
</style>
