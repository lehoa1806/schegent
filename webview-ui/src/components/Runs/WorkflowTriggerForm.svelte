<script lang="ts">
  // Feature 102 (T027, US3 — FR-012, FR-016, FR-017, FR-041, FR-043) & FR-R5-F36 (F36-T03, F36-T05):
  // Workflow start form with Instructions promoted to the primary field, empty contract/output
  // sections omitted, optional attachments collapsed by default, and sequential batch submission
  // when Instructions contain two or more `---schegent-task---`-separated segments.

  import { OUTCOME_NOT_YET_KNOWN_TEXT, boundaryRefusalText, refusalTextFrom } from "../../lib/boundary-refusal-text";
  import RunInputFields from "../RunLauncher/RunInputFields.svelte";
  import SupplementalInputs from "../RunLauncher/SupplementalInputs.svelte";
  import RunOutputTargets from "../RunLauncher/RunOutputTargets.svelte";
  import { launchWorkflow, type NotYetKnown } from "../../lib/workflow-run-ipc";
  import {
    composeRunRequest,
    errorsByField as mapErrorsByField,
    operatorPorts,
    overwriteRequestedPorts,
    supplementalErrors as mapSupplementalErrors,
  } from "../../lib/run-composition";
  import {
    formatBatchHaltStatus,
    formatBatchTimeoutStatus,
    remainingAfter,
    splitTaskInstructions,
    submitButtonLabel,
    type BatchSubmissionState,
  } from "../../lib/task-batch";
  import type { LaunchWorkflowResult } from "../../lib/messages";
  import type { Launchable, PipelineDefinition, PortableWorkflowDefinition, WorkflowNode } from "../../lib/snapshot-types";
  import type { RunRequestFieldError } from "../../../../src/contracts/run-request";

  const DEFINITION_REFUSALS: Record<string, string> = {
    "workflow-not-found":
      "This Workflow is no longer in the catalog. Close the form and reopen Add work to see what is published now.",
    'workflow-invalid':
      "This Workflow could not be read as a graph. Open it in the Builder, fix what it reports there, and publish it again.",
    "node-not-startable":
      "This is not a node the Workflow begins at. Pick a different one above and try again.",
    "pipeline-mismatch":
      "This node names a different Pipeline than the one that was sent. Close the form and open it again to pick up the current graph.",
    "no-workspace-root":
      "No folder is open, so a declared output has nowhere to be written. Open the workspace folder and start again.",
  };

  interface Props {
    /** The projection entry being started. Its `kind` is `workflow`. */
    readonly entry: Launchable;
    /** The active graph, from `workflowCatalog.effective`. Absent until resolved. */
    readonly graph: PortableWorkflowDefinition | undefined;
    /** The effective Pipeline catalog, read for the start node's output ports. */
    readonly pipelines: readonly PipelineDefinition[];
    readonly onClose?: () => void;
    readonly queueId?: string;
    readonly onBatchStateChange?: (state: BatchSubmissionState) => void;
  }

  const { entry, graph, pipelines, onClose, queueId, onBatchStateChange }: Props = $props();

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

  const startNodes = $derived.by<readonly WorkflowNode[]>(() => {
    if (graph === undefined) return [];
    const found: WorkflowNode[] = [];
    for (const nodeId of entry.startNodeIds ?? []) {
      const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node !== undefined) found.push(node);
    }
    return found;
  });

  const showStartNodePicker = $derived(
    startNodes.length > 1 && graph?.control?.kind !== 'candidate-block',
  );

  const startNodeId = $derived.by<string | null>(() => {
    if (startNodes.length === 1) return startNodes.at(0)?.nodeId ?? null;
    if (graph?.control?.kind === 'candidate-block') {
      return startNodes.at(0)?.nodeId ?? null;
    }
    return startNodes.some((node) => node.nodeId === chosenStartNodeId)
      ? chosenStartNodeId
      : null;
  });

  const startNode = $derived(
    startNodes.find((node) => node.nodeId === startNodeId),
  );

  const contractPorts = $derived(
    startNodeId === null
      ? []
      : operatorPorts(
          entry.inputs.filter(
            (port) =>
              port.nodeId === startNodeId ||
              (graph?.inputs?.some((declared) => declared.portId === port.portId) ?? false),
          ),
        ),
  );

  const startPipeline = $derived(
    startNode === undefined
      ? undefined
      : pipelines.find((pipeline) => pipeline.id === startNode.pipelineId),
  );
  const outputPorts = $derived(
    startPipeline?.outputs ?? graph?.outputs ?? [],
  );

  const composition = $derived(
    composeRunRequest({
      pipelineId:
        startNode?.pipelineId ??
        startNode?.phaseId ??
        startNode?.workflowId ??
        entry.id,
      inputPorts: contractPorts,
      outputPorts,
      inputValues,
      supplementalValues,
      outputTargets,
      sideEffectConfirmed,
      overwriteConfirmed,
    }),
  );

  const errorsByField = $derived(mapErrorsByField(fieldErrors));
  const supplementalErrors = $derived(
    mapSupplementalErrors(fieldErrors, submittedSupplementalKeys),
  );
  const overwriteRequested = $derived(overwriteRequestedPorts(fieldErrors));
  const segments = $derived(splitTaskInstructions(supplementalValues["instruction"]));
  const buttonLabel = $derived(
    submitButtonLabel({ pending, queueId, segmentCount: segments.length }),
  );

  function startNodeName(node: WorkflowNode): string {
    return node.label !== undefined && node.label !== ""
      ? `${node.label} (${node.nodeId})`
      : node.nodeId;
  }

  function pipelineNameOf(node: WorkflowNode): string {
    return (
      pipelines.find((pipeline) => pipeline.id === node.pipelineId)?.name ??
      node.pipelineId ??
      node.phaseId ??
      node.workflowId ??
      node.nodeId
    );
  }

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
    if (!showStartNodePicker || nodeId === startNodeId) return;
    chosenStartNodeId = nodeId;
    forget();
  }

  $effect(() => {
    if (startNodeId === null && chosenStartNodeId !== null) {
      chosenStartNodeId = null;
      forget();
    }
  });

  function refusalDetail(result: Exclude<LaunchWorkflowResult, { outcome: "started" }>): string {
    if (result.outcome === 'rejected-validation') {
      return "This Workflow was not started. Each field below states what to change.";
    }
    if (result.outcome === "rejected-definition") {
      return refusalTextFrom(DEFINITION_REFUSALS, result.reason);
    }
    return result.detail
      ? `The queue refused this run. ${boundaryRefusalText(result.detail)}`
      : "The queue refused this run.";
  }

  function applyResult(result: LaunchWorkflowResult | NotYetKnown): void {
    if (result.outcome === "not-yet-known") {
      fieldErrors = [];
      statusMessage = OUTCOME_NOT_YET_KNOWN_TEXT;
      return;
    }
    if (result.outcome === "started") {
      fieldErrors = [];
      statusMessage = queueId === undefined
        ? `Started connected run ${result.connectedRunId}.`
        : `Added task to queue. Run ${result.connectedRunId}.`;
      return;
    }
    fieldErrors = result.outcome === 'rejected-validation' ? result.errors : [];
    statusMessage = refusalDetail(result);
  }

  function applyBatchLateOutcome(
    batchSegments: readonly string[],
    acceptedBeforeTimeout: number,
    total: number,
    late: LaunchWorkflowResult | NotYetKnown,
  ): void {
    if (late.outcome === "not-yet-known") return;
    if (late.outcome === "started") {
      const nextAccepted = acceptedBeforeTimeout + 1;
      supplementalValues = {
        ...supplementalValues,
        instruction: remainingAfter(batchSegments, nextAccepted),
      };
      fieldErrors = [];
      statusMessage =
        nextAccepted < total
          ? `Added ${nextAccepted} of ${total} tasks. Submit the remaining tasks to continue.`
          : `Added ${total} of ${total} tasks to queue.`;
      return;
    }
    fieldErrors = late.outcome === 'rejected-validation' ? late.errors : [];
    statusMessage = formatBatchHaltStatus(acceptedBeforeTimeout, total, refusalDetail(late));
  }

  let submission: AbortController | null = null;
  $effect(() => () => submission?.abort());

  async function submitRequest(): Promise<void> {
    if (pending) return;
    const node = startNode;
    if (node === undefined) return;
    const { request, supplementalKeys } = composition;
    const batchSegments = [...segments];
    pending = true;
    fieldErrors = [];
    statusMessage = null;
    submittedSupplementalKeys = supplementalKeys;

    const controller = new AbortController();
    submission = controller;
    try {
      if (batchSegments.length < 2) {
        onBatchStateChange?.({ inFlight: false, halted: false, accepted: 0, total: 1 });
        const result = await launchWorkflow(
          {
            workflowId: entry.id,
            startNodeId: node.nodeId,
            request,
            ...(queueId === undefined ? {} : { queueId })
          },
          {
            signal: controller.signal,
            onLateOutcome: (late) => applyResult(late),
          },
        );
        if (controller.signal.aborted) return;
        applyResult(result);
        return;
      }

      const total = batchSegments.length;
      let accepted = 0;
      onBatchStateChange?.({ inFlight: true, halted: false, accepted: 0, total });

      for (const segment of batchSegments) {
        const segmentIndex = accepted;
        const result = await launchWorkflow(
          {
            workflowId: entry.id,
            startNodeId: node.nodeId,
            request: { ...request, instructions: segment },
            ...(queueId === undefined ? {} : { queueId })
          },
          {
            signal: controller.signal,
            onLateOutcome: (late) =>
              applyBatchLateOutcome(batchSegments, segmentIndex, total, late),
          },
        );
        if (controller.signal.aborted) return;

        if (result.outcome !== "started") {
          supplementalValues = {
            ...supplementalValues,
            instruction: remainingAfter(batchSegments, accepted),
          };
          if (result.outcome === "not-yet-known") {
            fieldErrors = [];
            statusMessage = formatBatchTimeoutStatus(
              accepted,
              total,
              OUTCOME_NOT_YET_KNOWN_TEXT,
            );
          } else {
            fieldErrors = result.outcome === 'rejected-validation' ? result.errors : [];
            statusMessage = formatBatchHaltStatus(accepted, total, refusalDetail(result));
          }
          onBatchStateChange?.({ inFlight: false, halted: true, accepted, total });
          return;
        }

        accepted += 1;
      }

      supplementalValues = { ...supplementalValues, instruction: "" };
      fieldErrors = [];
      statusMessage =
        queueId === undefined
          ? `Started ${total} of ${total} runs.`
          : `Added ${total} of ${total} tasks to queue.`;
      onBatchStateChange?.({ inFlight: false, halted: false, accepted: total, total });
    } finally {
      if (!controller.signal.aborted) pending = false;
    }
  }

  function onOverwriteConfirmed(portId: string): void {
    overwriteConfirmed = { ...overwriteConfirmed, [portId]: true };
    void submitRequest();
  }
</script>

<!-- Drawn in the redesign's add-task drawer: the step headings are bold and small, the
     fields are its inputs, and the hint about splitting sits under the box it is about. -->
<section class="workflow-trigger" data-testid="workflow-trigger">
  <header class="trigger-header">
    <h4 class="trigger-title" data-testid="workflow-trigger-title">
      {queueId === undefined ? "Run" : "Add task:"} {entry.name}
    </h4>
    {#if onClose}
      <button
        type="button"
        class="linkbtn"
        data-testid="workflow-trigger-close"
        onclick={() => onClose()}
      >
        Close
      </button>
    {/if}
  </header>

  {#if startNodes.length === 0}
    <p class="hint" data-testid="workflow-trigger-unresolved">
      This Workflow's graph has not resolved in this window, so its starting
      nodes cannot be named yet. Reopen Add work once the catalog has loaded.
    </p>
  {:else}
    {#if showStartNodePicker}
      <fieldset class="start-question" data-testid="workflow-trigger-start-question">
        <legend class="step">Which node should this run begin at?</legend>
        <ul class="start-list">
          {#each startNodes as node (node.nodeId)}
            <li>
              <button
                type="button"
                class="pick start-choice"
                data-testid="workflow-trigger-start-{node.nodeId}"
                aria-pressed={node.nodeId === startNodeId}
                disabled={pending}
                onclick={() => chooseStart(node.nodeId)}
              >
                <span class="choice-text">
                  <span class="t">{startNodeName(node)}</span>
                  <span class="d">{pipelineNameOf(node)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </fieldset>
    {/if}

    {#if startNode}
      <div class="instruction-row">
        <label class="step" for="run-supplemental-instruction">Instructions</label>
        <textarea
          id="run-supplemental-instruction"
          data-testid="run-supplemental-instruction"
          class="input"
          rows="5"
          placeholder="Describe the work. Be specific about the outcome."
          disabled={pending}
          value={supplementalValues["instruction"] ?? ""}
          oninput={(event) => (supplementalValues = { ...supplementalValues, instruction: event.currentTarget.value })}
        ></textarea>
        {#if supplementalErrors.has("instruction")}
          <p class="field-error" data-testid="run-launcher-error-supplemental-instruction">
            {supplementalErrors.get("instruction")}
          </p>
        {/if}
        <span class="hint" data-testid="run-supplemental-instruction-hint">
          Free-form direction for this run. Place <code class="mono">---schegent-task---</code>
          on its own line to split into sequential tasks (declared inputs,
          attachments, and output targets are shared across tasks).
        </span>
      </div>

      {#if contractPorts.length > 0}
        <RunInputFields
          ports={contractPorts}
          values={inputValues}
          errors={errorsByField}
          disabled={pending}
          onChange={(portId, value) => (inputValues = { ...inputValues, [portId]: value })}
        />
      {/if}

      <SupplementalInputs
        values={supplementalValues}
        errors={supplementalErrors}
        disabled={pending}
        omitInstruction={true}
        collapsible={true}
        onChange={(key, value) => (supplementalValues = { ...supplementalValues, [key]: value })}
      />

      {#if outputPorts.length > 0}
        <RunOutputTargets
          ports={outputPorts}
          targets={outputTargets}
          {sideEffectConfirmed}
          errors={errorsByField}
          {overwriteRequested}
          disabled={pending}
          onTargetChange={(portId, value) => (outputTargets = { ...outputTargets, [portId]: value })}
          onSideEffectChange={(portId, confirmed) => (sideEffectConfirmed = { ...sideEffectConfirmed, [portId]: confirmed })}
          {onOverwriteConfirmed}
        />
      {/if}

      <footer class="trigger-footer">
        <button
          type="button"
          class="btn btn-primary"
          data-testid="workflow-trigger-submit"
          disabled={pending}
          onclick={() => submitRequest()}
        >
          {buttonLabel}
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
  .workflow-trigger { display: flex; flex-direction: column; gap: var(--schegent-space-3); min-width: 0; }
  .trigger-header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--schegent-space-2); }
  .trigger-title { margin: 0; font-size: var(--schegent-text-body); word-break: break-word; }
  .hint, .field-error, .status-line { margin: 0; }
  .start-list { list-style: none; margin: 0; padding: 0; }
  .start-choice:disabled { cursor: default; opacity: 0.4; }
  .choice-text { min-width: 0; word-break: break-word; }
  .instruction-row { display: flex; flex-direction: column; gap: var(--schegent-space-1-5); }
  .step { font-size: var(--schegent-text-secondary); font-weight: 600; }
  .input { resize: vertical; }
  .field-error { font-size: var(--schegent-text-caption); color: var(--schegent-error-text); }
  /* The redesign's drawer footer: the action at the right, what became of it underneath. */
  .trigger-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--schegent-space-2); }
  .status-line { flex-basis: 100%; font-size: var(--schegent-text-secondary); }
</style>
