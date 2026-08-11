<script lang="ts">
  // Feature 088 T044 — the nodes of a connected run, each in the state the host
  // folded it into.
  //
  // FR-055 names four states the view must distinguish — completed, available,
  // blocked, unvisited — and FR-055a adds that a node whose most recent attempt
  // is terminal stays in that terminal state rather than returning to
  // `available`. That is why the badge below renders `node.state` verbatim
  // instead of collapsing the seven values into four: `failed` and `canceled`
  // are the terminal readings FR-055a is about, and showing a failed node as
  // "available" because it *could* be restarted is exactly the misreading it
  // forbids. Whether a repeat start is offered is an action, not a fifth state.
  //
  // Controls come from `node.actions` and from nothing else (FR-057). The view
  // never derives what is legal — a node with a non-terminal child carries no
  // actions, so no start control renders for it, and a view rendered from a
  // superseded revision offers only what that revision allowed. The host's
  // compare-and-set is what makes that safe rather than optimistic.
  //
  // The current Pipeline, current Phase, and logs of an attempt are NOT
  // re-implemented here (FR-056). A node that has attempted renders the
  // existing `QueueItem` row for its latest attempt, which is the surface the
  // rest of the sidebar already uses for exactly this — a second implementation
  // would be a second thing to keep true as those surfaces evolve.
  //
  // Every string on this surface is interpolated with `{}`, which escapes
  // (FR-059). Node and Pipeline identifiers are operator-authored; nothing here
  // uses `{@html}`, and nothing should.

  import QueueItemRow from '../QueueItem.svelte';
  import type {
    ConnectedNodeAction,
    ConnectedNodeProjection,
    QueueItem
  } from '../../lib/snapshot-types';

  interface Props {
    readonly nodes: readonly ConnectedNodeProjection[];
    /** The queue rows a node's latest attempt is looked up in (FR-056). */
    readonly queueItems: readonly QueueItem[];
    /** True while a submission is in flight; the host, not the view, decides legality. */
    readonly disabled?: boolean;
    readonly onAct?: (node: ConnectedNodeProjection, action: ConnectedNodeAction) => void;
  }

  const { nodes, queueItems, disabled = false, onAct }: Props = $props();

  const ACTION_LABELS: Record<ConnectedNodeAction, string> = {
    start: 'Start',
    restart: 'Run again'
  };

  function attemptOf(node: ConnectedNodeProjection): QueueItem | undefined {
    if (node.latestQueueItemId === undefined) return undefined;
    return queueItems.find((item) => item.id === node.latestQueueItemId);
  }
</script>

<ul class="node-list" data-testid="workflow-node-states">
  {#each nodes as node (node.nodeId)}
    <li class="node-row" data-testid={`workflow-node-${node.nodeId}`}>
      <div class="node-head">
        <span class="node-id" data-testid={`workflow-node-id-${node.nodeId}`}>{node.nodeId}</span>
        <span class="node-state" data-testid={`workflow-node-state-${node.nodeId}`}>
          {node.state}
        </span>
      </div>
      <p class="node-meta" data-testid={`workflow-node-meta-${node.nodeId}`}>
        {node.pipelineId} · {node.attemptCount}
        {node.attemptCount === 1 ? 'attempt' : 'attempts'}
      </p>

      {#if node.actions.length > 0}
        <div class="node-actions">
          {#each node.actions as action (action)}
            <button
              type="button"
              class="node-action"
              data-testid={`workflow-node-action-${node.nodeId}-${action}`}
              {disabled}
              onclick={() => onAct?.(node, action)}
            >
              {ACTION_LABELS[action]}
            </button>
          {/each}
        </div>
      {/if}

      {#if node.latestQueueItemId !== undefined}
        {@const attempt = attemptOf(node)}
        {#if attempt}
          <ul class="attempt-row" data-testid={`workflow-node-attempt-${node.nodeId}`}>
            <QueueItemRow item={attempt} testIdPrefix="workflow-node-run" />
          </ul>
        {:else}
          <!-- The projection references an attempt the queue projection has not
               caught up with. Say so rather than render nothing, so a missing
               row reads as "still arriving" and not as "no attempt". -->
          <p class="attempt-pending" data-testid={`workflow-node-attempt-pending-${node.nodeId}`}>
            Loading this attempt's details…
          </p>
        {/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  .node-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .node-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--schegent-radius);
  }
  .node-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .node-id {
    font-weight: 600;
    word-break: break-word;
  }
  .node-state {
    flex: none;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
  }
  .node-meta {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.85;
    word-break: break-word;
  }
  .node-actions {
    display: flex;
    gap: 6px;
  }
  .node-action {
    padding: 4px 10px;
    background: var(--sch-accent-gradient);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: var(--schegent-radius);
    cursor: pointer;
  }
  .node-action:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .attempt-row {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .attempt-pending {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
</style>
