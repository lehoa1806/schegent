<script lang="ts">
  // Feature 087 T055-T058 — the run composer's shell.
  //
  // It owns the composition and nothing else decides anything about it. The three
  // child sections are projections plus change callbacks; this file assembles
  // their values into the one `RunRequest` that goes on the wire, and renders
  // whatever the host says back.
  //
  // Nothing here re-checks a field. `validateRunRequest()` host-side owns every
  // rule, and a webview pre-check would be a second oracle that disagrees with the
  // authoritative one the moment either moves — so an incomplete composition is
  // submittable, and the refusal that comes back is the feedback (FR-045). The
  // consequence worth stating: the submit control is never disabled for want of a
  // value, only while a submission is in flight (FR-044).
  //
  // Two bounds sit on a submission. The IPC helper resolves host silence after
  // five seconds; this component wraps the whole exchange in thirty (FR-046), so
  // even a helper that never settles cannot strand the operator in a form they
  // cannot edit. On either bound the composition is left exactly as typed.

  import RunInputFields from './RunInputFields.svelte';
  import SupplementalInputs from './SupplementalInputs.svelte';
  import RunOutputTargets from './RunOutputTargets.svelte';
  import { launchPipeline } from '../../lib/run-launcher-ipc';
  import type { LaunchPipelineResult } from '../../lib/messages';
  import type { PipelineDefinition } from '../../lib/snapshot-types';
  import type {
    RunInputValue,
    RunOutputTargetRequest,
    RunRequest,
    RunRequestFieldError,
    SupplementalInput
  } from '../../../../src/contracts/run-request';

  /** Declared by a port that an earlier Phase feeds, never the operator (FR-001a). */
  const PHASE_FED_PORT_TYPE = 'pipeline-output';

  /** The outer bound on a submission (FR-046, SC-012). */
  const SUBMIT_TIMEOUT_MS = 30_000;

  const TIMEOUT_MESSAGE =
    'The host did not answer within 30 seconds. Nothing was queued; your composition is unchanged.';

  interface Props {
    readonly pipeline: PipelineDefinition;
    readonly onClose?: () => void;
  }

  const { pipeline, onClose }: Props = $props();

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

  const contractPorts = $derived(
    (pipeline.inputs ?? []).filter((port) => port.type !== PHASE_FED_PORT_TYPE)
  );
  const outputPorts = $derived(pipeline.outputs ?? []);

  /** Whitespace-only is nothing typed; the raw value is what gets sent. */
  function filled(value: string | undefined): value is string {
    return value !== undefined && value.trim().length > 0;
  }

  interface Composition {
    readonly request: RunRequest;
    readonly supplementalKeys: readonly string[];
  }

  function compose(): Composition {
    const inputs: RunInputValue[] = contractPorts
      .filter((port) => filled(inputValues[port.portId]))
      .map((port) => ({ portId: port.portId, type: port.type, value: inputValues[port.portId]! }));

    const supplemental: SupplementalInput[] = [];
    const supplementalKeys: string[] = [];
    const add = (key: string, item: SupplementalInput): void => {
      supplemental.push(item);
      supplementalKeys.push(key);
    };

    const localFile = supplementalValues['local-file'];
    if (filled(localFile)) add('local-file', { kind: 'local-file', path: localFile });
    const localFolder = supplementalValues['local-folder'];
    if (filled(localFolder)) add('local-folder', { kind: 'local-folder', path: localFolder });
    const url = supplementalValues['url'];
    if (filled(url)) add('url', { kind: 'url', url });
    const text = supplementalValues['text'];
    if (filled(text)) add('text', { kind: 'text', text });
    const sourceRunId = supplementalValues['prior-run'];
    const outputName = supplementalValues['prior-output'];
    // Half a reference addresses nothing, so it is not sent: the operator is
    // mid-typing, not making a request the host should refuse.
    if (filled(sourceRunId) && filled(outputName)) {
      add('prior-output', { kind: 'prior-output', reference: { sourceRunId, outputName } });
    }

    const outputs: RunOutputTargetRequest[] = outputPorts
      .filter((port) => filled(outputTargets[port.portId]))
      .map((port) => ({
        portId: port.portId,
        target: outputTargets[port.portId]!,
        ...(overwriteConfirmed[port.portId] ? { overwriteConfirmed: true } : {}),
        ...(sideEffectConfirmed[port.portId] ? { externalSideEffectConfirmed: true } : {})
      }));

    const instructions = supplementalValues['instruction'];

    return {
      request: {
        pipelineId: pipeline.id,
        inputs,
        supplemental,
        outputs,
        ...(filled(instructions) ? { instructions } : {})
      },
      supplementalKeys
    };
  }

  const composition = $derived(compose());

  /** Port- and field-addressed refusals, rendered against their own control. */
  const errorsByField = $derived(
    new Map(fieldErrors.map((error) => [error.field, error.message] as const))
  );

  /**
   * Supplemental refusals arrive addressed by position — the entries have no port
   * to name them by — so they are mapped back to the control that produced each
   * one. The instruction limit rides along here: it is reported against the
   * request's own `instructions` field, and the control the operator used for it
   * lives in this section.
   */
  const supplementalErrors = $derived.by(() => {
    const mapped = new Map<string, string>();
    for (const error of fieldErrors) {
      if (error.field === 'instructions') {
        mapped.set('instruction', error.message);
        continue;
      }
      const match = /^supplemental\[(\d+)\]$/.exec(error.field);
      if (!match) continue;
      const key = submittedSupplementalKeys[Number(match[1])];
      if (key !== undefined) mapped.set(key, error.message);
    }
    return mapped;
  });

  /** Ports the host refused for want of an overwrite confirmation (FR-023). */
  const overwriteRequested = $derived(
    new Set(
      fieldErrors
        .filter((error) => error.code === 'output-overwrite-unconfirmed')
        .map((error) => error.field.slice('outputs.'.length))
    )
  );

  const effectiveSettings = $derived.by(() => {
    const defaults = pipeline.executionDefaults;
    if (!defaults) return 'Workspace defaults';
    const parts: string[] = [];
    if (defaults.runner) parts.push(`Runner ${defaults.runner}`);
    if (defaults.model) parts.push(`Model ${defaults.model}`);
    if (defaults.effort) parts.push(`Effort ${defaults.effort}`);
    if (defaults.timeoutSeconds !== undefined) parts.push(`Timeout ${defaults.timeoutSeconds}s`);
    return parts.length > 0 ? parts.join(' · ') : 'Workspace defaults';
  });

  function applyResult(result: LaunchPipelineResult): void {
    if (result.outcome === 'enqueued') {
      fieldErrors = [];
      statusMessage = `Queued as ${result.requestId}.`;
      return;
    }
    if (result.outcome === 'rejected-validation') {
      fieldErrors = result.errors;
      statusMessage = 'This run was not queued. Each field below states what to change.';
      return;
    }
    fieldErrors = [];
    if (result.outcome === 'rejected-definition') {
      statusMessage = `This Pipeline could not be resolved: ${result.reason}.`;
      return;
    }
    statusMessage = result.detail
      ? `The queue refused this run: ${result.reason} (${result.detail}).`
      : `The queue refused this run: ${result.reason}.`;
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
      const result = await launchPipeline(request);
      // The outer bound already restored the form and said so; a late answer must
      // not overwrite that with a verdict the operator can no longer act on.
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

<section class="run-launcher" data-testid="run-launcher">
  <header class="launcher-header">
    <h3 class="launcher-title">Run {pipeline.name}</h3>
    {#if onClose}
      <button type="button" class="close-button" data-testid="run-launcher-close" onclick={() => onClose()}>
        Close
      </button>
    {/if}
  </header>

  {#if contractPorts.length > 0}
    <RunInputFields
      ports={contractPorts}
      values={inputValues}
      errors={errorsByField}
      disabled={pending}
      onChange={(portId, value) => (inputValues = { ...inputValues, [portId]: value })}
    />
  {:else}
    <p class="no-contract" data-testid="run-launcher-no-contract">
      This Pipeline declares no inputs, so there is nothing to supply. It can be run as it is.
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

  <section class="preview-section" data-testid="run-launcher-preview">
    <h4 class="section-heading">Process preview</h4>
    <p class="preview-line" data-testid="run-launcher-preview-pipeline">
      {pipeline.name} ({pipeline.id})
    </p>
    <ol class="phase-order" data-testid="run-launcher-preview-phases">
      {#each pipeline.phases as phaseId, index (`${index}-${phaseId}`)}
        <li>{phaseId}</li>
      {/each}
    </ol>
    <p class="preview-line" data-testid="run-launcher-preview-settings">{effectiveSettings}</p>
    <pre class="request-preview" data-testid="run-launcher-preview-request">{JSON.stringify(
        composition.request,
        null,
        2
      )}</pre>
  </section>

  <footer class="launcher-footer">
    <button
      type="button"
      class="submit-button"
      data-testid="run-launcher-submit"
      disabled={pending}
      onclick={() => submitRequest()}
    >
      {pending ? 'Queueing…' : 'Run Pipeline'}
    </button>
    {#if statusMessage}
      <p class="status-line" data-testid="run-launcher-status">{statusMessage}</p>
    {/if}
  </footer>
</section>

<style>
  .run-launcher {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 12px;
  }
  .launcher-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .launcher-title {
    margin: 0;
    font-size: 1em;
  }
  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: underline;
  }
  .no-contract {
    margin: 0;
    font-size: 0.9em;
    opacity: 0.85;
  }
  .section-heading {
    margin: 0;
    font-size: 0.95em;
  }
  .preview-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .preview-line {
    margin: 0;
    font-size: 0.85em;
  }
  .phase-order {
    margin: 0;
    padding-left: 20px;
    font-size: 0.85em;
  }
  .request-preview {
    margin: 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    background: var(--vscode-textCodeBlock-background);
    border-radius: var(--schegent-radius);
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .launcher-footer {
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
