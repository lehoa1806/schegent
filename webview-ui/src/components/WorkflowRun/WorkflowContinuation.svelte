<script lang="ts">
  // Feature 088 T045 — the composer for one continuation.
  //
  // Same four sections as the independent launcher, same assembly
  // (`lib/run-composition.ts`), one different command. What is specific to a
  // continuation is what the operator starts from and what the host compares
  // against:
  //
  //   * **Prefill is a starting point, never a commitment** (FR-038, FR-039).
  //     Every prefilled value is editable within its port's contract, an
  //     optional binding can be replaced, and session information can be added.
  //     The host receives only what the operator submitted — it never sees the
  //     prefill and would not trust it if it did, which is why `prefill` is a
  //     prop here and is not carried on the wire.
  //   * **`expectedRevision` is read off the projection being rendered**
  //     (FR-046), never invented. It is the family's only idempotency
  //     mechanism: a guessed revision turns a duplicate submission into a second
  //     child run instead of the refusal it should be.
  //
  // The Pipeline rendered here comes from the *effective* catalog, while the
  // host validates against the Pipeline the run **froze**. They can differ if
  // the catalog moved mid-run. That is deliberate and not papered over: the
  // corrective is the host's field errors, which are authoritative and name
  // every failing field at once. A webview-side re-check would be a second
  // oracle, and a frozen copy on the wire would be document content the
  // contract forbids.
  //
  // Nothing here re-checks a field, so an incomplete composition is submittable
  // and the refusal is the feedback (FR-045). Every rendered string is
  // interpolated with `{}`, which escapes (FR-059).

  import RunInputFields from '../RunLauncher/RunInputFields.svelte';
  import SupplementalInputs from '../RunLauncher/SupplementalInputs.svelte';
  import RunOutputTargets from '../RunLauncher/RunOutputTargets.svelte';
  import { continueWorkflow } from '../../lib/workflow-run-ipc';
  import {
    composeRunRequest,
    errorsByField as mapErrorsByField,
    operatorPorts,
    overwriteRequestedPorts,
    supplementalErrors as mapSupplementalErrors
  } from '../../lib/run-composition';
  import type { ContinueWorkflowResult } from '../../lib/messages';
  import type { ConnectedNodeProjection, PipelineDefinition } from '../../lib/snapshot-types';
  import type { RunRequestFieldError } from '../../../../src/contracts/run-request';

  /** The outer bound on a submission, as on the independent launcher. */
  const SUBMIT_TIMEOUT_MS = 30_000;

  const TIMEOUT_MESSAGE =
    'The host did not answer within 30 seconds. Nothing was started; your composition is unchanged.';

  interface Props {
    readonly connectedRunId: string;
    /** The revision the view was rendered from (FR-046). */
    readonly expectedRevision: number;
    readonly node: ConnectedNodeProjection;
    /** The node's Pipeline, from the effective catalog — see the header. */
    readonly pipeline: PipelineDefinition;
    /**
     * Values carried by the incoming connection's bindings, by port id (FR-036).
     * A port with no entry starts empty; every entry is editable.
     */
    readonly prefill?: Record<string, string>;
    readonly onClose?: () => void;
    readonly onResult?: (result: ContinueWorkflowResult) => void;
  }

  const {
    connectedRunId,
    expectedRevision,
    node,
    pipeline,
    prefill,
    onClose,
    onResult
  }: Props = $props();

  // Seeded once from the prefill and owned by the operator from then on. It is
  // deliberately NOT `$derived` from the prop: re-deriving would discard an edit
  // the moment anything upstream changed, which is the opposite of FR-038. The
  // one-time read is the intent, so the local-reference warning is suppressed
  // here as `PipelineBuilder.svelte` does for the same seed-once shape (an
  // `untrack` wrapper emits it anyway — see `settings/RetryConditionEditor.svelte`).
  // svelte-ignore state_referenced_locally
  let inputValues = $state<Record<string, string>>({ ...(prefill ?? {}) });
  let supplementalValues = $state<Record<string, string>>({});
  let outputTargets = $state<Record<string, string>>({});
  let sideEffectConfirmed = $state<Record<string, boolean>>({});
  let overwriteConfirmed = $state<Record<string, boolean>>({});
  let fieldErrors = $state<readonly RunRequestFieldError[]>([]);
  let statusMessage = $state<string | null>(null);
  let pending = $state(false);
  /** Which control produced each supplemental entry of the LAST submission. */
  let submittedSupplementalKeys = $state<readonly string[]>([]);

  const contractPorts = $derived(operatorPorts(pipeline.inputs));
  const outputPorts = $derived(pipeline.outputs ?? []);

  const composition = $derived(
    composeRunRequest({
      pipelineId: pipeline.id,
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

  const STATE_REFUSAL_MESSAGES: Record<string, string> = {
    'child-not-terminal': 'Another node of this run is still working. It has to finish first.',
    'node-not-eligible': 'This node is not one the run offers right now.'
  };

  function applyResult(result: ContinueWorkflowResult): void {
    if (result.outcome === 'started') {
      fieldErrors = [];
      statusMessage = `Started as ${result.queueItemId}.`;
      return;
    }
    if (result.outcome === 'rejected-validation') {
      fieldErrors = result.errors;
      statusMessage = 'This node was not started. Each field below states what to change.';
      return;
    }
    fieldErrors = [];
    if (result.outcome === 'rejected-stale') {
      // The refusal carries the authoritative projection; the parent re-renders
      // from it, so the operator's next submission echoes the current revision.
      statusMessage =
        'This run moved on while you were composing. The refreshed state is shown above; review it and submit again.';
      return;
    }
    if (result.outcome === 'rejected-state') {
      statusMessage = STATE_REFUSAL_MESSAGES[result.reason] ?? `This node was not started: ${result.reason}.`;
      return;
    }
    if (result.outcome === 'rejected-run') {
      statusMessage = 'This connected run could not be found.';
      return;
    }
    if (result.outcome === 'rejected-definition') {
      statusMessage = `This node could not be started: ${result.reason}.`;
      return;
    }
    statusMessage = result.detail
      ? `The queue refused this node: ${result.reason} (${result.detail}).`
      : `The queue refused this node: ${result.reason}.`;
  }

  async function submitRequest(): Promise<void> {
    if (pending) return;
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
      const result = await continueWorkflow({
        connectedRunId,
        expectedRevision,
        nodeId: node.nodeId,
        request
      });
      // The outer bound already restored the form and said so; a late answer
      // must not overwrite that with a verdict the operator can no longer act on.
      if (timedOut) return;
      applyResult(result);
      onResult?.(result);
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

<section class="workflow-continuation" data-testid="workflow-continuation">
  <header class="continuation-header">
    <h4 class="continuation-title" data-testid="workflow-continuation-title">
      Continue at {node.nodeId}
    </h4>
    {#if onClose}
      <button
        type="button"
        class="close-button"
        data-testid="workflow-continuation-close"
        onclick={() => onClose()}
      >
        Close
      </button>
    {/if}
  </header>

  <p class="continuation-meta" data-testid="workflow-continuation-meta">
    {pipeline.name} ({pipeline.id}) · revision {expectedRevision}
  </p>

  {#if contractPorts.length > 0}
    <RunInputFields
      ports={contractPorts}
      values={inputValues}
      errors={errorsByField}
      disabled={pending}
      onChange={(portId, value) => (inputValues = { ...inputValues, [portId]: value })}
    />
  {:else}
    <p class="no-contract" data-testid="workflow-continuation-no-contract">
      This Pipeline declares no inputs, so there is nothing to supply. It can be started as it is.
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

  <footer class="continuation-footer">
    <button
      type="button"
      class="submit-button"
      data-testid="workflow-continuation-submit"
      disabled={pending}
      onclick={() => submitRequest()}
    >
      {pending ? 'Starting…' : 'Start node'}
    </button>
    {#if statusMessage}
      <p class="status-line" data-testid="workflow-continuation-status">{statusMessage}</p>
    {/if}
  </footer>
</section>

<style>
  .workflow-continuation {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--schegent-radius);
  }
  .continuation-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .continuation-title {
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
  .continuation-meta {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.85;
    word-break: break-word;
  }
  .no-contract {
    margin: 0;
    font-size: 0.9em;
    opacity: 0.85;
  }
  .continuation-footer {
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
