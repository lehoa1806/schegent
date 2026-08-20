<script lang="ts">
  // Feature 102 (T027, US3 — FR-012, FR-016, FR-017, FR-041, FR-043) — the form
  // that starts a Workflow.
  //
  // Sibling of `WorkflowRun/WorkflowContinuation.svelte`, and deliberately the
  // same shape: the same four sections, the same assembly out of
  // `lib/run-composition.ts`, one different command. What differs is only what a
  // *launch* has to decide that a continuation does not — which node to begin
  // from, and which Pipeline that node names.
  //
  // **Two sources, joined here.** The launch projection says which nodes the
  // Workflow starts from and what each unsatisfied port is; it carries no
  // node-to-Pipeline map, on purpose — a copy of the graph beside the graph is
  // two graphs. The Pipeline a node names lives in the active graph, which is
  // `workflowCatalog.effective`, the same field the Builder reads. So the
  // projection stays the authority for *which nodes are start nodes* and the
  // graph for *what a node is*. That is a join, not a second derivation.
  //
  // Getting it wrong is not cosmetic: `LaunchWorkflowPayload.request` names one
  // `pipelineId`, and the host refuses `pipeline-mismatch` when it is not the
  // one the node names — a refusal no operator can act on.
  //
  // **One node's ports, and only that node's** (FR-016). Downstream nodes are
  // asked for as the run reaches them, along the continuation path that already
  // exists. Collecting their answers here would mean holding them between nodes,
  // which FR-018 forbids.
  //
  // **The set is read every render, never remembered** (FR-017). A connection
  // landing on a port removes it from the derived set, and a form open across
  // that change stops asking for it rather than sending a value the graph now
  // supplies twice.
  //
  // **Nothing here judges a submission** (FR-010, FR-011). No field is
  // re-checked, an empty form is submittable, and the refusal that comes back is
  // the feedback. The control is barred only while a request is in flight, where
  // a second press would open a second connected run.
  //
  // Path ports go through `RunInputFields` like every other port (FR-041): the
  // operator's own string reaches the host verbatim, and the host resolves it
  // against the workspace. This form names no location of its own.

  import RunInputFields from '../RunLauncher/RunInputFields.svelte';
  import SupplementalInputs from '../RunLauncher/SupplementalInputs.svelte';
  import RunOutputTargets from '../RunLauncher/RunOutputTargets.svelte';
  import { launchWorkflow } from '../../lib/workflow-run-ipc';
  import {
    composeRunRequest,
    errorsByField as mapErrorsByField,
    operatorPorts,
    overwriteRequestedPorts,
    supplementalErrors as mapSupplementalErrors
  } from '../../lib/run-composition';
  import type { LaunchWorkflowResult } from '../../lib/messages';
  import type {
    Launchable,
    PipelineDefinition,
    PortableWorkflowDefinition,
    WorkflowNode
  } from '../../lib/snapshot-types';
  import type { RunRequestFieldError } from '../../../../src/contracts/run-request';

  /** The outer bound on a submission, as on both sibling composers. */
  const SUBMIT_TIMEOUT_MS = 30_000;

  const TIMEOUT_MESSAGE =
    'The host did not answer within 30 seconds. Nothing was started; your composition is unchanged.';

  /**
   * The host's refusal vocabulary, said in words an operator can act on.
   *
   * Each entry names the reason and the next move. The reason itself is the
   * host's — this map translates it, it does not decide it — and an arm the host
   * adds later falls through to the raw reason rather than to silence.
   */
  const DEFINITION_REFUSALS: Record<string, string> = {
    'workflow-not-found':
      'This Workflow is no longer in the catalog. Close the form and reopen Runs to see what is published now.',
    'workflow-invalid':
      'This Workflow could not be read as a graph. Open it in the Builder, fix what it reports there, and publish it again.',
    'node-not-startable':
      'This is not a node the Workflow begins at. Pick a different one above and try again.',
    'pipeline-mismatch':
      'This node names a different Pipeline than the one that was sent. Close the form and open it again to pick up the current graph.',
    'no-workspace-root':
      'No folder is open, so a declared output has nowhere to be written. Open the workspace folder and start again.'
  };

  interface Props {
    /** The projection entry being started. Its `kind` is `workflow`. */
    readonly entry: Launchable;
    /** The active graph, from `workflowCatalog.effective`. Absent until resolved. */
    readonly graph: PortableWorkflowDefinition | undefined;
    /** The effective Pipeline catalog, read for the start node's output ports. */
    readonly pipelines: readonly PipelineDefinition[];
    readonly onClose?: () => void;
  }

  const { entry, graph, pipelines, onClose }: Props = $props();

  let chosenStartNodeId = $state<string | null>(null);
  let inputValues = $state<Record<string, string>>({});
  let supplementalValues = $state<Record<string, string>>({});
  let outputTargets = $state<Record<string, string>>({});
  let sideEffectConfirmed = $state<Record<string, boolean>>({});
  let overwriteConfirmed = $state<Record<string, boolean>>({});
  let fieldErrors = $state<readonly RunRequestFieldError[]>([]);
  let statusMessage = $state<string | null>(null);
  let pending = $state(false);
  /** Which control produced each supplemental entry of the LAST submission. */
  let submittedSupplementalKeys = $state<readonly string[]>([]);

  /**
   * The join. A start node the graph does not carry is dropped rather than
   * guessed at: without a node there is no Pipeline to name, and an entry in the
   * list that cannot be started is worse than one that is not offered.
   */
  const startNodes = $derived.by<readonly WorkflowNode[]>(() => {
    if (graph === undefined) return [];
    const found: WorkflowNode[] = [];
    for (const nodeId of entry.startNodeIds ?? []) {
      const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node !== undefined) found.push(node);
    }
    return found;
  });

  /**
   * One start node is not a choice, so it is not asked about (FR-043). More than
   * one is unanswered until the operator answers it, and an answer the graph has
   * since dropped is no answer at all.
   */
  const startNodeId = $derived.by<string | null>(() => {
    if (startNodes.length === 1) return startNodes[0]!.nodeId;
    return startNodes.some((node) => node.nodeId === chosenStartNodeId) ? chosenStartNodeId : null;
  });

  const startNode = $derived(startNodes.find((node) => node.nodeId === startNodeId));

  /**
   * The chosen node's unsatisfied ports (FR-016), read out of the projection on
   * every render (FR-017). `operatorPorts` drops the ports an earlier Phase of
   * the node's own Pipeline feeds, as both sibling composers do.
   */
  const contractPorts = $derived(
    startNodeId === null
      ? []
      : operatorPorts(entry.inputs.filter((port) => port.nodeId === startNodeId))
  );

  const startPipeline = $derived(
    startNode === undefined
      ? undefined
      : pipelines.find((pipeline) => pipeline.id === startNode.pipelineId)
  );
  const outputPorts = $derived(startPipeline?.outputs ?? []);

  const composition = $derived(
    composeRunRequest({
      pipelineId: startNode?.pipelineId ?? '',
      inputPorts: contractPorts,
      outputPorts,
      inputValues,
      supplementalValues,
      outputTargets,
      sideEffectConfirmed,
      overwriteConfirmed
    })
  );

  const errorsByField = $derived(mapErrorsByField(fieldErrors));
  const supplementalErrors = $derived(
    mapSupplementalErrors(fieldErrors, submittedSupplementalKeys)
  );
  const overwriteRequested = $derived(overwriteRequestedPorts(fieldErrors));

  /**
   * A node's id always tells it apart from another's; its label may be absent,
   * and two nodes on one Pipeline may share one. So the id is always shown and
   * the label, when authored, leads.
   */
  function startNodeName(node: WorkflowNode): string {
    return node.label !== undefined && node.label !== '' ? `${node.label} (${node.nodeId})` : node.nodeId;
  }

  function pipelineNameOf(node: WorkflowNode): string {
    return pipelines.find((pipeline) => pipeline.id === node.pipelineId)?.name ?? node.pipelineId;
  }

  /**
   * Everything typed was typed against the node being left behind, so none of it
   * carries over. Keeping it would send one node's answers to another's ports.
   */
  function forget(): void {
    inputValues = {};
    supplementalValues = {};
    outputTargets = {};
    sideEffectConfirmed = {};
    overwriteConfirmed = {};
    fieldErrors = [];
    statusMessage = null;
    submittedSupplementalKeys = [];
  }

  function chooseStart(nodeId: string): void {
    if (nodeId === startNodeId) return;
    chosenStartNodeId = nodeId;
    forget();
  }

  $effect(() => {
    // The graph moved and took the answered question with it. `startNodeId` has
    // already read as null; this drops what was composed against the node that
    // is gone, so the next choice starts from nothing.
    if (startNodeId === null && chosenStartNodeId !== null) {
      chosenStartNodeId = null;
      forget();
    }
  });

  function applyResult(result: LaunchWorkflowResult): void {
    if (result.outcome === 'started') {
      fieldErrors = [];
      statusMessage = `Started connected run ${result.connectedRunId}.`;
      return;
    }
    if (result.outcome === 'rejected-validation') {
      fieldErrors = result.errors;
      statusMessage = 'This Workflow was not started. Each field below states what to change.';
      return;
    }
    fieldErrors = [];
    if (result.outcome === 'rejected-definition') {
      statusMessage =
        DEFINITION_REFUSALS[result.reason] ?? `This Workflow was not started: ${result.reason}.`;
      return;
    }
    statusMessage = result.detail
      ? `The queue refused this run: ${result.reason} (${result.detail}).`
      : `The queue refused this run: ${result.reason}.`;
  }

  async function submitRequest(): Promise<void> {
    if (pending) return;
    const node = startNode;
    if (node === undefined) return;
    const { request, supplementalKeys } = composition;
    pending = true;
    fieldErrors = [];
    statusMessage = null;
    submittedSupplementalKeys = supplementalKeys;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      pending = false;
      statusMessage = TIMEOUT_MESSAGE;
    }, SUBMIT_TIMEOUT_MS);

    try {
      const result = await launchWorkflow({
        workflowId: entry.id,
        startNodeId: node.nodeId,
        request
      });
      // The outer bound already restored the form and said so; a late answer
      // must not overwrite that with a verdict the operator can no longer act on.
      if (timedOut) return;
      applyResult(result);
    } finally {
      clearTimeout(timer);
      if (!timedOut) pending = false;
    }
  }

  function onOverwriteConfirmed(portId: string): void {
    overwriteConfirmed = { ...overwriteConfirmed, [portId]: true };
    void submitRequest();
  }
</script>

<section class="workflow-trigger" data-testid="workflow-trigger">
  <header class="trigger-header">
    <h4 class="trigger-title" data-testid="workflow-trigger-title">Run {entry.name}</h4>
    {#if onClose}
      <button
        type="button"
        class="close-button"
        data-testid="workflow-trigger-close"
        onclick={() => onClose()}
      >
        Close
      </button>
    {/if}
  </header>

  {#if startNodes.length === 0}
    <p class="trigger-note" data-testid="workflow-trigger-unresolved">
      This Workflow's graph has not resolved in this window, so its starting nodes cannot be named
      yet. Reopen Runs once the catalog has loaded.
    </p>
  {:else}
    {#if startNodes.length > 1}
      <fieldset class="start-question" data-testid="workflow-trigger-start-question">
        <legend class="start-legend">Which node should this run begin at?</legend>
        <ul class="start-list">
          {#each startNodes as node (node.nodeId)}
            <li>
              <button
                type="button"
                class="start-choice"
                class:chosen={node.nodeId === startNodeId}
                data-testid="workflow-trigger-start-{node.nodeId}"
                aria-pressed={node.nodeId === startNodeId}
                disabled={pending}
                onclick={() => chooseStart(node.nodeId)}
              >
                <span class="choice-name">{startNodeName(node)}</span>
                <span class="choice-pipeline">{pipelineNameOf(node)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </fieldset>
    {/if}

    {#if startNode}
      {#if contractPorts.length > 0}
        <RunInputFields
          ports={contractPorts}
          values={inputValues}
          errors={errorsByField}
          disabled={pending}
          onChange={(portId, value) => (inputValues = { ...inputValues, [portId]: value })}
        />
      {:else}
        <p class="trigger-note" data-testid="workflow-trigger-no-inputs">
          Every input this node takes is supplied by the graph, so there is nothing to fill in. It
          can be started as it is.
        </p>
      {/if}

      <SupplementalInputs
        values={supplementalValues}
        errors={supplementalErrors}
        disabled={pending}
        onChange={(key, value) => (supplementalValues = { ...supplementalValues, [key]: value })}
      />

      <RunOutputTargets
        ports={outputPorts}
        targets={outputTargets}
        {sideEffectConfirmed}
        errors={errorsByField}
        {overwriteRequested}
        disabled={pending}
        onTargetChange={(portId, value) => (outputTargets = { ...outputTargets, [portId]: value })}
        onSideEffectChange={(portId, confirmed) =>
          (sideEffectConfirmed = { ...sideEffectConfirmed, [portId]: confirmed })}
        {onOverwriteConfirmed}
      />

      <footer class="trigger-footer">
        <button
          type="button"
          class="submit-button"
          data-testid="workflow-trigger-submit"
          disabled={pending}
          onclick={() => submitRequest()}
        >
          {pending ? 'Starting…' : 'Run Workflow'}
        </button>
        {#if statusMessage}
          <p class="status-line" data-testid="workflow-trigger-status" role="status">
            {statusMessage}
          </p>
        {/if}
      </footer>
    {/if}
  {/if}
</section>

<style>
  .workflow-trigger {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--schegent-radius);
  }
  .trigger-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .trigger-title {
    margin: 0;
    font-size: 0.95em;
    word-break: break-word;
  }
  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: underline;
  }
  .trigger-note {
    margin: 0;
    font-size: 0.9em;
    opacity: 0.85;
  }
  .start-question {
    border: none;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .start-legend {
    padding: 0;
    font-size: 0.9em;
    font-weight: 600;
  }
  .start-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  .start-choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--schegent-radius);
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .start-choice.chosen {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground);
  }
  .start-choice:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .choice-name {
    font-size: 0.9em;
    word-break: break-word;
  }
  .choice-pipeline {
    font-size: 0.8em;
    opacity: 0.8;
    word-break: break-word;
  }
  .trigger-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .submit-button {
    align-self: flex-start;
    padding: 6px 12px;
    background: var(--sch-accent-gradient);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: var(--schegent-radius);
    cursor: pointer;
  }
  .submit-button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .status-line {
    margin: 0;
    font-size: 0.85em;
  }
</style>
