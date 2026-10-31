<script lang="ts">
  // Feature 087 T055-T058 — the run composer's shell.
  //
  // It owns what the operator typed and nothing else decides anything about it.
  // The three child sections are projections plus change callbacks; their values
  // become the one `RunRequest` that goes on the wire, and this file renders
  // whatever the host says back. Feature 088 moved the assembly itself into
  // `lib/run-composition.ts` when the connected-run continuation grew a second
  // composer over the same four sections — one definition of what a composition
  // is, consumed by both.
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

  import { untrack } from 'svelte';
  import RunInputFields from './RunInputFields.svelte';
  import SupplementalInputs from './SupplementalInputs.svelte';
  import RunOutputTargets from './RunOutputTargets.svelte';
  import { OUTCOME_NOT_YET_KNOWN_TEXT, boundaryRefusalText } from '../../lib/boundary-refusal-text';
  import { launchPipeline, type NotYetKnown } from '../../lib/run-launcher-ipc';
  import { snapshotStore } from '../../lib/snapshot-store.svelte';
  import LaunchAuthorityNotice from '../Runs/LaunchAuthorityNotice.svelte';
  import {
    composeRunRequest,
    errorsByField as mapErrorsByField,
    operatorPorts,
    overwriteRequestedPorts,
    supplementalErrors as mapSupplementalErrors
  } from '../../lib/run-composition';
  import type { LaunchPipelineResult } from '../../lib/messages';
  import type { Launchable, PipelineDefinition } from '../../lib/snapshot-types';
  import type { RunRequestFieldError } from '../../../../src/contracts/run-request';

  // FR-R4-F05 (I7, O3) — the 30 s outer timer and its message are gone. The wait is the ledger's
  // 5 s, a timeout says the outcome is NOT YET KNOWN (never "Nothing was queued": the host may
  // still queue it), and the late outcome replaces that message once (O4).

  interface Props {
    readonly pipeline: PipelineDefinition;
    readonly onClose?: () => void;
    /**
     * Feature 103 (T066, FR-033) — what a caller already knows the operator
     * meant, seeded into the supplemental controls.
     *
     * Read once, at mount, and never again: it is a starting value, not a bound
     * one. A caller that pushed a new object into an open form would overwrite
     * what the operator has since typed, and History's re-run remounts the panel
     * per run anyway. Nothing else about the composition changes — the values are
     * ordinary typed values from here on, and the submit path is unchanged.
     */
    readonly initialSupplemental?: Record<string, string>;
    /**
     * Feature 103 (T068, FR-059) — which queue admits the run.
     *
     * Absent for a launch from Runs, which is how it has always been: the host
     * defaults it inside `scheduleOrEnqueue`, and this form has no opinion about
     * which queue is the default one. Only History's re-run names one, because
     * only it has a queue to be faithful to.
     */
    readonly queueId?: string;
  }

  const { pipeline, onClose, initialSupplemental, queueId }: Props = $props();

  // FR-R4-F06 (FR-007; D4) -- the launch notice for THIS Pipeline. `HistoryRerunPanel` mounts
  // this component too, so a History re-run is covered by the same read. The entry is found by
  // id in the snapshot's launch projection, which is where the host put the backends this
  // Pipeline would spawn; a Pipeline the projection does not offer shows no backend notice,
  // and a start of it is refused by the host regardless.
  const launchEntry = $derived.by(() => {
    const section = snapshotStore.snapshot?.launchables?.pipelines;
    return section?.state === 'entries'
      ? section.entries.find((entry) => entry.id === pipeline.id)
      : undefined;
  });
  const postures = $derived(snapshotStore.snapshot?.backendPostures ?? []);

  let inputValues = $state<Record<string, string>>({});
  // `untrack` states the intent the compiler otherwise warns about: this reads
  // the prop once, deliberately, and must not become a subscription. A form that
  // re-seeded whenever its caller re-rendered would discard what the operator
  // had typed on every host snapshot push.
  let supplementalValues = $state<Record<string, string>>(
    untrack(() => ({ ...initialSupplemental }))
  );
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

  // FR-R4-F07 (FR-021 to FR-025; contract D, D4) -- the settings the Run will use are the host's
  // `runSettings` on this Pipeline's launch entry, resolved by the functions execution calls. This
  // component words them and derives none of them. It does not read `executionDefaults` as settings
  // in force: nothing applies them, so they are disclosed on their own line as advisory. Present only
  // when the host sent settings for every Phase this form lists; otherwise the form says they are
  // resolved when the Run starts.
  type PhaseSettings = NonNullable<Launchable['runSettings']>['phases'][number];
  const runSettings = $derived.by(() => {
    const settings = launchEntry?.runSettings;
    return settings !== undefined && settings.phases.length === pipeline.phases.length
      ? settings
      : undefined;
  });
  const advisoryDefaults = $derived.by(() => {
    const defaults = pipeline.executionDefaults;
    if (!defaults) return null;
    const parts: string[] = [];
    if (defaults.runner) parts.push(`Runner ${defaults.runner}`);
    if (defaults.model) parts.push(`Model ${defaults.model}`);
    if (defaults.effort) parts.push(`Effort ${defaults.effort}`);
    if (defaults.timeoutSeconds !== undefined) parts.push(`Timeout ${defaults.timeoutSeconds}s`);
    return parts.length > 0 ? parts.join(' · ') : null;
  });
  const SECONDS_PER_HOUR = 3600;
  const SECONDS_PER_MINUTE = 60;
  /** "6 h", "90 min" or "45 s": the largest whole unit, so a figure never rounds. */
  function duration(seconds: number): string {
    if (seconds % SECONDS_PER_HOUR === 0) return `${seconds / SECONDS_PER_HOUR} h`;
    if (seconds % SECONDS_PER_MINUTE === 0) return `${seconds / SECONDS_PER_MINUTE} min`;
    return `${seconds} s`;
  }
  const backendName = (kind: string): string => kind.charAt(0).toUpperCase() + kind.slice(1);
  function phaseLine(settings: PhaseSettings): string {
    const model = settings.model.kind === 'value' ? settings.model.value : 'backend default';
    const effort = settings.effort.kind === 'value' ? settings.effort.value : 'backend default';
    return `${backendName(settings.backend)} · model: ${model} · effort: ${effort} · idle limit ${duration(settings.idleTimeoutSeconds.value)}`;
  }

  function applyResult(result: LaunchPipelineResult | NotYetKnown): void {
    if (result.outcome === 'not-yet-known') {
      fieldErrors = [];
      statusMessage = OUTCOME_NOT_YET_KNOWN_TEXT;
      return;
    }
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
    // FR-R4-F05 (O1) — neither the code `queue-refused` nor the guard's detail is shown raw.
    statusMessage = result.detail
      ? `The queue refused this run. ${boundaryRefusalText(result.detail)}`
      : 'The queue refused this run.';
  }

  // FR-R4-F05 (I8) — the in-flight submission's signal, aborted when this component goes: the
  // wait's timer and late callback are removed, and the ledger keeps the identity for a retry.
  let submission: AbortController | null = null;
  $effect(() => () => submission?.abort());

  async function submitRequest(): Promise<void> {
    if (pending) return;
    const { request, supplementalKeys } = composition;
    pending = true;
    fieldErrors = [];
    statusMessage = null;
    submittedSupplementalKeys = supplementalKeys;

    const controller = new AbortController();
    submission = controller;
    try {
      const result = await launchPipeline(request, queueId, {
        signal: controller.signal,
        // O4 — the outcome of a send whose wait ran out, shown once through the same text path.
        onLateOutcome: (late) => applyResult(late)
      });
      if (controller.signal.aborted) return;
      applyResult(result);
    } finally {
      if (!controller.signal.aborted) pending = false;
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
    <div class="settings-block" data-testid="run-launcher-preview-settings">
      <ol class="phase-order" data-testid="run-launcher-preview-phases">
        {#each pipeline.phases as phaseId, index (`${index}-${phaseId}`)}
          <li>
            {phaseId}
            {#if runSettings}
              <span class="phase-settings">{phaseLine(runSettings.phases[index]!)}</span>
            {/if}
          </li>
        {/each}
      </ol>
      {#if runSettings}
        <p class="preview-line">Run time limit {duration(runSettings.maxDurationSeconds.value)}</p>
      {:else}
        <p class="preview-line">Settings are resolved when the Run starts</p>
      {/if}
    </div>
    {#if advisoryDefaults}
      <p class="preview-line" data-testid="run-launcher-preview-advisory">
        Authored defaults (advisory, not applied): {advisoryDefaults}
      </p>
    {/if}
    <pre class="request-preview" data-testid="run-launcher-preview-request">{JSON.stringify(
        composition.request,
        null,
        2
      )}</pre>
  </section>

  <LaunchAuthorityNotice
    backends={launchEntry?.backends ?? []}
    {postures}
    capabilityNotices={launchEntry?.capabilityNotices ?? []}
  />

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
      <p class="status-line" data-testid="run-launcher-status" role="status">{statusMessage}</p>
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
  .phase-settings {
    display: block;
    opacity: 0.8;
    font-size: 0.9em;
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
