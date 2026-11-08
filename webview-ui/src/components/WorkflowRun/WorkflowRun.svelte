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
  import CandidateBlockInspector from './CandidateBlockInspector.svelte';
  import { continueWorkflow } from '../../lib/workflow-run-ipc';
  import type { ContinueWorkflowResult, WorkflowControlAction } from '../../lib/messages';
  import {
    describeBranchDisposition,
    describeExitReason,
    type ConnectedInvocationProjection,
    type ConnectedNodeProjection,
    type ConnectedRunProjection,
    type PipelineDefinition,
    type QueueItem
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
    readonly isPrimary?: boolean;
  }

  const { run, queueItems = [], pipelines = [], prefillFor, isPrimary = true }: Props = $props();

  let openNodeId = $state<string | null>(null);
  let runStatus = $state<string | null>(null);
  let controlPending = $state(false);
  let collapsedInvocations = $state<Record<string, boolean>>({});

  const CONTROL_LABELS: Record<WorkflowControlAction, string> = {
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    'retry-phase': 'Retry Phase',
    'retry-invocation': 'Retry Workflow',
    'continue-handoff': 'Continue Handoff'
  };

  function toggleInvocation(invocationId: string): void {
    collapsedInvocations = {
      ...collapsedInvocations,
      [invocationId]: !collapsedInvocations[invocationId]
    };
  }

  function hasCollapsedAncestor(inv: ConnectedInvocationProjection): boolean {
    const all = run.invocations ?? [];
    let parentId = inv.parentInvocationId;
    const visited: string[] = [];
    while (parentId !== null && !visited.includes(parentId)) {
      visited.push(parentId);
      if (collapsedInvocations[parentId] === true) return true;
      const parent = all.find((item) => item.invocationId === parentId);
      parentId = parent?.parentInvocationId ?? null;
    }
    return false;
  }

  async function onControlInvocation(
    inv: ConnectedInvocationProjection,
    action: WorkflowControlAction
  ): Promise<void> {
    if (controlPending) return;
    controlPending = true;
    runStatus = null;
    const nodeId = inv.currentNodeId ?? 'root';
    try {
      const outcome = await continueWorkflow({
        connectedRunId: run.connectedRunId,
        expectedRevision: run.revision,
        nodeId,
        invocationId: inv.invocationId,
        operation: action,
        commandId: `${run.connectedRunId}:${inv.invocationId}:${action}:${run.revision}`,
        request: {
          pipelineId: nodeId,
          inputs: [],
          supplemental: [],
          outputs: []
        }
      });
      if (outcome.outcome === 'started') {
        runStatus = `Applied ${action} on ${inv.nodePath} (revision ${outcome.revision}).`;
      } else if (outcome.outcome === 'rejected-stale') {
        runStatus = `Action ${action} refused: run moved to revision ${outcome.projection.revision}.`;
      } else if (outcome.outcome === 'rejected-state') {
        runStatus = `Action ${action} refused (${outcome.reason}).`;
      } else if (outcome.outcome === 'not-yet-known') {
        runStatus = `Action ${action} is still awaiting host confirmation.`;
      } else {
        runStatus = `Action ${action} could not be completed.`;
      }
    } finally {
      controlPending = false;
    }
  }

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
    <div class="run-badges">
      {#if run.queueId}
        <span class="run-badge" data-testid="workflow-run-queue">Queue: {run.queueId}</span>
      {/if}
      {#if run.status}
        <span class="run-badge" data-testid="workflow-run-overall-status">{run.status}</span>
      {/if}
      <span class="run-id" data-testid="workflow-run-id">{run.connectedRunId}</span>
    </div>
  </header>

  {#if run.hydrating}
    <p class="hydrating" data-testid="workflow-run-hydrating">
      Loading this run's nodes and their attempts…
    </p>
  {:else}
    {#if run.recoveryDisposition}
      <div class="recovery-banner" data-testid="workflow-run-recovery-disposition" role="status">
        <strong>Recovery ({run.recoveryDisposition.status}):</strong>
        <span>{run.recoveryDisposition.reason}</span>
        <span>(target: {run.recoveryDisposition.targetInvocationId})</span>
      </div>
    {/if}

    {#if run.invocations && run.invocations.length > 0}
      <ul class="invocation-tree" data-testid="workflow-invocation-tree">
        {#each run.invocations as inv (inv.invocationId)}
          {#if !hasCollapsedAncestor(inv)}
          {@const isCollapsed = collapsedInvocations[inv.invocationId] === true}
          <li
            class="invocation-item invocation-depth-{Math.min(inv.depth, 5)}"
            data-testid={`workflow-invocation-${inv.invocationId}`}
          >
            <div class="invocation-head">
              <button
                type="button"
                class="invocation-toggle"
                data-testid={`workflow-invocation-toggle-${inv.invocationId}`}
                aria-expanded={!isCollapsed}
                onclick={() => toggleInvocation(inv.invocationId)}
              >
                {isCollapsed ? '▸' : '▾'} {inv.workflowName ?? inv.workflowId}
              </button>
              <span
                class="invocation-path"
                data-testid={`workflow-invocation-path-${inv.invocationId}`}
              >
                {inv.nodePath}
              </span>
              <span
                class="invocation-id"
                data-testid={`workflow-invocation-id-${inv.invocationId}`}
              >
                {inv.invocationId}
              </span>
              {#if inv.frozenVersionId}
                <span
                  class="invocation-version"
                  data-testid={`workflow-invocation-version-${inv.invocationId}`}
                >
                  {inv.frozenVersionId}
                </span>
              {/if}
              <span
                class="invocation-status"
                data-testid={`workflow-invocation-status-${inv.invocationId}`}
              >
                {inv.status}
              </span>
            </div>

            {#if inv.waitingReason || inv.pauseCause || inv.failureReason}
              <p
                class="invocation-diagnostic"
                data-testid={`workflow-invocation-diagnostic-${inv.invocationId}`}
              >
                {#if inv.waitingReason}Waiting: {inv.waitingReason}{/if}
                {#if inv.pauseCause} · Paused: {inv.pauseCause}{/if}
                {#if inv.failureReason} · Failed: {inv.failureReason}{/if}
              </p>
              {#if inv.pauseExplanation || inv.pauseGuidance || inv.pauseCause === 'recovery-uncertain-effect'}
                <p
                  class="invocation-diagnostic"
                  data-testid={`workflow-invocation-pause-guidance-${inv.invocationId}`}
                >
                  {inv.pauseExplanation ??
                    (inv.pauseCause === 'recovery-uncertain-effect'
                      ? 'Paused during restart recovery because the active Phase attempt had no live queue task or verified settlement evidence.'
                      : '')}
                  {inv.pauseGuidance ??
                    (inv.pauseCause === 'recovery-uncertain-effect'
                      ? ' Inspect workspace outputs, then choose Resume (reconciles evidence before re-dispatching), Retry Phase, or Cancel.'
                      : '')}
                </p>
              {/if}
            {/if}

            {#if !isCollapsed}
              {#if inv.pendingHandoff}
                <p
                  class="invocation-diagnostic"
                  data-testid={`workflow-invocation-handoff-${inv.invocationId}`}
                >
                  Handoff: {inv.pendingHandoff.fromNodeId} &rarr; {inv.pendingHandoff.toNodeId ?? 'return'}
                  {#if inv.pendingHandoff.boundInputPortIds.length > 0}
                    ({inv.pendingHandoff.boundInputPortIds.join(', ')})
                  {/if}
                </p>
              {/if}
              {#if inv.outputPortIds.length > 0}
                <p
                  class="invocation-outputs"
                  data-testid={`workflow-invocation-outputs-${inv.invocationId}`}
                >
                  Outputs: {inv.outputPortIds.join(', ')}
                </p>
              {/if}

              {#if inv.attempts.length > 0}
                <ul
                  class="invocation-attempts"
                  data-testid={`workflow-invocation-attempts-${inv.invocationId}`}
                >
                  {#each inv.attempts as att (att.attemptId)}
                    <li
                      class="invocation-attempt-row"
                      data-testid={`workflow-invocation-attempt-${att.attemptId}`}
                    >
                      <span>#{att.attemptIndex} {att.nodeId} ({att.nodeKind})</span>
                      <span>{att.status}</span>
                      {#if att.failureCode}
                        <span>({att.failureCode})</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}

              {#if inv.controlProjection}
                <CandidateBlockInspector
                  projection={inv.controlProjection}
                  {isPrimary}
                />
              {/if}

              {#if isPrimary && inv.allowedActions.length > 0}
                <div
                  class="invocation-actions"
                  data-testid={`workflow-invocation-actions-${inv.invocationId}`}
                >
                  {#each inv.allowedActions as action (action)}
                    <button
                      type="button"
                      class="invocation-action-btn"
                      data-testid={`workflow-invocation-action-${inv.invocationId}-${action}`}
                      disabled={controlPending}
                      onclick={() => onControlInvocation(inv, action)}
                    >
                      {CONTROL_LABELS[action]}
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </li>
          {/if}
        {/each}
      </ul>
    {/if}

    {#if run.controlProjection && !(run.invocations ?? []).some((inv) => inv.controlProjection?.invocationId === run.controlProjection?.invocationId)}
      <CandidateBlockInspector
        projection={run.controlProjection}
        {isPrimary}
      />
    {/if}

    <WorkflowNodeStates
      nodes={run.nodes}
      {queueItems}
      controlProjection={run.controlProjection}
      disabled={openNode !== undefined}
      onAct={(node) => onAct(node)}
    />

    {#if run.decisionObservations && run.decisionObservations.length > 0}
      <ul class="invocation-attempts" data-testid="workflow-decision-observations">
        {#each run.decisionObservations as obs (obs.decisionId)}
          <li
            class="invocation-attempt-row"
            data-testid={`workflow-decision-observation-${obs.nodeId}`}
          >
            <span>{obs.nodeId} (#{obs.iteration}/{obs.maxIterations})</span>
            <span>{obs.retryCondition} · {describeExitReason(obs.exitReason)} (cap: {obs.capOutcome})</span>
            {#each obs.branches as branch (branch.connectionIndex)}
              <span
                class="run-badge"
                data-testid={`workflow-decision-branch-${obs.nodeId}-${branch.connectionIndex}`}
              >
                {branch.summary}: {describeBranchDisposition(branch.disposition)}
              </span>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}

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
  .run-badges,
  .invocation-head, .invocation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .run-badge, .invocation-version, .invocation-status, .invocation-path { font-size: 0.78em; opacity: 0.85; }
  .invocation-id { font-size: 0.75em; opacity: 0.7; }
  .recovery-banner { padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); font-size: 0.82em; display: flex; gap: 6px; flex-wrap: wrap; }
  .invocation-tree, .invocation-attempts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .invocation-item { border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  .invocation-depth-1 { margin-left: 14px; }
  .invocation-depth-2 { margin-left: 28px; }
  .invocation-depth-3 { margin-left: 42px; }
  .invocation-depth-4 { margin-left: 56px; }
  .invocation-depth-5 { margin-left: 70px; }
  .invocation-toggle { background: transparent; border: none; color: inherit; cursor: pointer; font-weight: 600; padding: 0; text-align: left; }
  .invocation-diagnostic, .invocation-outputs, .invocation-attempt-row { margin: 0; font-size: 0.8em; display: flex; gap: 6px; flex-wrap: wrap; }
  .invocation-action-btn { padding: 3px 8px; font-size: 0.8em; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); cursor: pointer; }
</style>
