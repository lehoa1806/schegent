<script lang="ts">
  // Feature 088 T043 — one connected run, and the gate in front of it.
  //
  // The gate is the whole point of this file (FR-058). Until the aggregate and
  // every child run it references have loaded, the host reports `hydrating` and
  // this view renders a loading state and **no controls at all** — not a
  // disabled control, not a control derived from a partial read. A speculative
  // action set is worse than no action set: it invites a submission the host
  // will refuse, at a revision the operator never actually saw.
  //
  // Once hydrated, every control comes from `node.actions` (FR-057), which the
  // host folded at the revision this view is rendering. The composer that opens
  // echoes that same `run.revision` back as `expectedRevision`, so a projection
  // that moved on refuses the submission rather than starting a second child.
  //
  // Operator-supplied strings — the Workflow, node, and Pipeline identifiers,
  // and everything inside the reused Run surfaces — are interpolated with `{}`,
  // which escapes (FR-059). Nothing here uses `{@html}`.

  import WorkflowNodeStates from './WorkflowNodeStates.svelte';
  import WorkflowContinuation from './WorkflowContinuation.svelte';
  import type { ContinueWorkflowResult } from '../../lib/messages';
  import type {
    ConnectedNodeProjection,
    ConnectedRunProjection,
    PipelineDefinition,
    QueueItem
  } from '../../lib/snapshot-types';

  interface Props {
    readonly run: ConnectedRunProjection;
    /** The queue rows the reused Run surfaces are looked up in (FR-056). */
    readonly queueItems?: readonly QueueItem[];
    /** The effective Pipeline catalog, for the composer's contract. */
    readonly pipelines?: readonly PipelineDefinition[];
    /**
     * Values the incoming connection's bindings carry for a node (FR-036).
     *
     * A function rather than a map because it is a seam: nothing records Run
     * outputs yet, so today it returns nothing for every node and the composer
     * opens empty. When recording lands, this is the one place that changes.
     */
    readonly prefillFor?: (node: ConnectedNodeProjection) => Record<string, string> | undefined;
  }

  const { run, queueItems = [], pipelines = [], prefillFor }: Props = $props();

  let openNodeId = $state<string | null>(null);
  let runStatus = $state<string | null>(null);

  /**
   * The composer is rendered only while its node still offers an action at the
   * current revision. A node that just started, or that a refreshed projection
   * no longer offers, closes itself — leaving it open would be a control the
   * host would refuse (FR-057).
   */
  const openNode = $derived(
    run.nodes.find((node) => node.nodeId === openNodeId && node.actions.length > 0)
  );
  const openPipeline = $derived(
    openNode ? pipelines.find((pipeline) => pipeline.id === openNode.pipelineId) : undefined
  );

  function onAct(node: ConnectedNodeProjection): void {
    runStatus = null;
    openNodeId = node.nodeId;
  }

  function onResult(result: ContinueWorkflowResult): void {
    if (result.outcome !== 'started') return;
    // The node leaves its action set on the next projection, which closes the
    // composer; the outcome outlives it here so the operator still sees it.
    runStatus = `Started ${openNodeId} as ${result.queueItemId}.`;
    openNodeId = null;
  }
</script>

<section class="workflow-run" data-testid="workflow-run">
  <header class="run-header">
    <h3 class="run-title" data-testid="workflow-run-title">{run.workflowId}</h3>
    <span class="run-id" data-testid="workflow-run-id">{run.connectedRunId}</span>
  </header>

  {#if run.hydrating}
    <p class="hydrating" data-testid="workflow-run-hydrating">
      Loading this run's nodes and their attempts…
    </p>
  {:else}
    <WorkflowNodeStates
      nodes={run.nodes}
      {queueItems}
      disabled={openNode !== undefined}
      onAct={(node) => onAct(node)}
    />

    {#if openNode}
      {#if openPipeline}
        <WorkflowContinuation
          connectedRunId={run.connectedRunId}
          expectedRevision={run.revision}
          node={openNode}
          pipeline={openPipeline}
          prefill={prefillFor?.(openNode)}
          onClose={() => (openNodeId = null)}
          {onResult}
        />
      {:else}
        <p class="unresolved-pipeline" data-testid="workflow-run-unresolved-pipeline">
          {openNode.pipelineId} is not in the current catalog, so there is nothing to compose.
        </p>
      {/if}
    {/if}

    {#if runStatus}
      <p class="run-status" data-testid="workflow-run-status">{runStatus}</p>
    {/if}
  {/if}
</section>

<style>
  .workflow-run {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
  }
  .run-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .run-title {
    margin: 0;
    font-size: 1em;
    word-break: break-word;
  }
  .run-id {
    flex: none;
    font-size: 0.8em;
    opacity: 0.8;
  }
  .hydrating,
  .unresolved-pipeline,
  .run-status {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.9;
    word-break: break-word;
  }
</style>
