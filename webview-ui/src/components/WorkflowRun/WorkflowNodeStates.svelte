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
    ConnectedForEachNodeProjection,
    ConnectedNodeAction,
    ConnectedNodeProjection,
    ConnectedRepeatNodeProjection,
    ControlCandidateProjection,
    ControlProjection,
    QueueItem
  } from '../../lib/snapshot-types';

  interface Props {
    readonly nodes: readonly ConnectedNodeProjection[];
    /** The queue rows a node's latest attempt is looked up in (FR-056). */
    readonly queueItems: readonly QueueItem[];
    readonly controlProjection?: ControlProjection;
    /** True while a submission is in flight; the host, not the view, decides legality. */
    readonly disabled?: boolean;
    readonly onAct?: (node: ConnectedNodeProjection, action: ConnectedNodeAction) => void;
    /** Feature 265 BUG-001 (FR-009): opens the node's latest attempt Task. */
    readonly onOpenTask?: (queueItemId: string, returnKey: string) => void;
  }

  const { nodes, queueItems, controlProjection, disabled = false, onAct, onOpenTask }: Props = $props();

  const ACTION_LABELS: Record<ConnectedNodeAction, string> = {
    start: 'Start',
    restart: 'Run again'
  };

  function attemptOf(node: ConnectedNodeProjection): QueueItem | undefined {
    if (node.latestQueueItemId === undefined) return undefined;
    return queueItems.find((item) => item.id === node.latestQueueItemId);
  }

  function candidateOf(node: ConnectedNodeProjection): ControlCandidateProjection | undefined {
    return controlProjection?.candidates?.find((c) => c.nodeId === node.nodeId);
  }

  function repeatOf(node: ConnectedNodeProjection): ConnectedRepeatNodeProjection | undefined {
    return node.repeatProjection ?? (controlProjection?.nodeId === node.nodeId ? controlProjection.repeatProjection : undefined);
  }

  function forEachOf(node: ConnectedNodeProjection): ConnectedForEachNodeProjection | undefined {
    return node.forEachProjection ?? (controlProjection?.nodeId === node.nodeId ? controlProjection.forEachProjection : undefined);
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
        {#if node.nodeKind}
          <span class="node-kind-badge" data-testid={`workflow-node-kind-${node.nodeId}`}>{node.nodeKind}</span> ·
        {/if}
        {#if node.label}
          <span class="node-label">{node.label}</span> ({node.pipelineId})
        {:else}
          {node.pipelineId}
        {/if}
        {#if node.frozenVersionId}
          · <span class="node-version" data-testid={`workflow-node-version-${node.nodeId}`}>{node.frozenVersionId}</span>
        {/if}
        · {node.attemptCount}
        {node.attemptCount === 1 ? 'attempt' : 'attempts'}
        {#if candidateOf(node)}
          {@const cand = candidateOf(node)}
          {#if cand}
            · <span class="node-candidate-badge" data-testid={`workflow-node-candidate-state-${node.nodeId}`}>
              Candidate {cand.candidateId}: {cand.eligibility} ({cand.attemptsUsed}/{cand.maxAttempts})
            </span>
          {/if}
        {/if}
      </p>

      {#if repeatOf(node)}
        {@const rep = repeatOf(node)}
        {#if rep}
          <div class="node-repeat-panel" data-testid={`repeat-node-projection-${node.nodeId}`}>
            <div class="repeat-row">
              <span class="repeat-pass-counter" data-testid={`repeat-pass-counter-${node.nodeId}`}>
                Pass {rep.iteration} of {rep.maxIterations}
              </span>
              ·
              <span class="repeat-leaf-attempts" data-testid={`repeat-leaf-attempts-${node.nodeId}`}>
                {rep.leafAttemptCount} {rep.leafAttemptCount === 1 ? 'leaf attempt' : 'leaf attempts'}
              </span>
              ·
              <span class="repeat-condition-result" data-testid={`repeat-condition-result-${node.nodeId}`}>
                Until: {rep.conditionResult}
              </span>
              ·
              <span class="repeat-on-exhausted" data-testid={`repeat-on-exhausted-${node.nodeId}`}>
                onExhausted: {rep.onExhausted}
              </span>
            </div>
            {#if rep.currentChildInvocationId}
              <div class="repeat-row" data-testid={`repeat-current-child-${node.nodeId}`}>
                Active child: {rep.currentChildInvocationId}
              </div>
            {/if}
            {#if rep.carryEnvelopeRef}
              <div class="repeat-row" data-testid={`repeat-carry-ref-${node.nodeId}`}>
                Carry envelope: {rep.carryEnvelopeRef}
              </div>
            {/if}
            {#if rep.exhaustionReason}
              <div class="repeat-exhaustion" data-testid={`repeat-exhaustion-reason-${node.nodeId}`}>
                Exhaustion: {rep.exhaustionReason} ({rep.onExhausted === 'pause' ? 'Paused — resume cannot extend maxIterations' : 'Failed'})
              </div>
            {/if}
            {#if rep.completedPasses.length > 0}
              <div class="repeat-passes" data-testid={`repeat-completed-passes-${node.nodeId}`}>
                {#each rep.completedPasses as passEntry (passEntry.iteration)}
                  <span class="repeat-pass-chip" data-testid={`repeat-pass-chip-${node.nodeId}-${passEntry.iteration}`}>
                    #{passEntry.iteration}: {passEntry.status}
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/if}

      {#if forEachOf(node)}
        {@const fe = forEachOf(node)}
        {#if fe}
          <div class="node-repeat-panel" data-testid={`foreach-node-projection-${node.nodeId}`}>
            <div class="repeat-row">
              <span class="repeat-pass-counter" data-testid={`foreach-item-counter-${node.nodeId}`}>
                {fe.itemCount === 0
                  ? '0 items (empty collection)'
                  : `Item ${Math.min(fe.currentIndex + 1, fe.itemCount)} of ${fe.itemCount}`}
              </span>
              ·
              <span class="repeat-leaf-attempts" data-testid={`foreach-leaf-attempts-${node.nodeId}`}>
                {fe.leafAttemptCount} {fe.leafAttemptCount === 1 ? 'leaf attempt' : 'leaf attempts'}
              </span>
              ·
              <span class="repeat-on-exhausted" data-testid={`foreach-on-item-error-${node.nodeId}`}>
                onItemError: {fe.onItemError}
              </span>
            </div>
            {#if fe.collectionRef}
              <div class="repeat-row" data-testid={`foreach-collection-ref-${node.nodeId}`}>
                Collection: {fe.collectionRef}
              </div>
            {/if}
            {#if fe.resultIndexRef}
              <div class="repeat-row" data-testid={`foreach-result-index-ref-${node.nodeId}`}>
                Result index: {fe.resultIndexRef}
              </div>
            {/if}
            {#if fe.hasErrors}
              <div
                class="repeat-exhaustion"
                role="status"
                aria-live="polite"
                data-testid={`foreach-error-summary-${node.nodeId}`}
              >
                Completed with {fe.errorCount} item {fe.errorCount === 1 ? 'error' : 'errors'} (hasErrors: true)
              </div>
            {/if}
            {#if fe.refusalCode}
              <div class="repeat-exhaustion" data-testid={`foreach-refusal-code-${node.nodeId}`}>
                Refusal: {fe.refusalCode}
              </div>
            {/if}
            {#if fe.slots.length > 0}
              <div class="repeat-passes" data-testid={`foreach-slots-${node.nodeId}`}>
                {#each fe.slots as slot (slot.index)}
                  <span class="repeat-pass-chip" data-testid={`foreach-slot-${node.nodeId}-${slot.index}`}>
                    #{slot.index} ({slot.itemKey}): {slot.state}{slot.error ? ` — ${slot.error.code}: ${slot.error.message}` : ''}
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/if}

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
          <ul class="attempt-row" data-testid={`workflow-node-attempt-${node.nodeId}`} data-return-key={`node:${node.nodeId}`}>
            <QueueItemRow
              item={attempt}
              testIdPrefix="workflow-node-run"
              onSelect={onOpenTask === undefined ? undefined : () => onOpenTask(attempt.id, `node:${node.nodeId}`)}
            />
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
  .node-repeat-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border-left: 2px solid var(--vscode-focusBorder, currentColor);
    font-size: 0.85em;
  }
  .repeat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .repeat-pass-counter {
    font-weight: 600;
  }
  .repeat-exhaustion {
    font-weight: 600;
  }
  .repeat-passes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .repeat-pass-chip {
    padding: 1px 6px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
  }
</style>
