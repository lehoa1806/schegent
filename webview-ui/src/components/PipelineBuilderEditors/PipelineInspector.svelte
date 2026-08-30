<script lang="ts">
  // Feature 184 (FR-R3-141, T020/T022/T024) — the inspector pane.
  //
  // Everything the canvas is not: the Pipeline's identity, its ports, what
  // consumes it, and the errors that name no card. All of it renders at rest
  // (FR-045); selecting a card *adds* that position's Phase `<select>` (FR-046)
  // rather than replacing the pane, so the operator never has to deselect to get
  // back to the Name field.
  //
  // The `<select>` is the one control that moved pane rather than changing shape.
  // It keeps `pipelines-phase-select-{i}`, its `aria-label` and its
  // `aria-describedby`, so the assertions that addressed it on the row still
  // address it here (mapping #29).
  //
  // One `anchoredErrors` prop rather than six pre-sliced lists. The anchoring rule
  // lives in `pipelineErrorAnchor`, and a parent that sliced the errors itself
  // would be a second place that decides what belongs beside what (FR-048).
  //
  // The ID field is read-only when the row is `persisted` — and on nothing else.
  // Not on `readonly`: those are different claims. `readonly` is transient (a save
  // in flight, another row being edited); `persisted` is permanent, because an id
  // is an identity and changing it would rename a stored definition rather than
  // edit it. That is why the help text says to duplicate.
  import {
    pipelineErrorDescribedBy,
    pipelineErrorInvalidFlag,
    pipelineErrorRegionId,
    pipelineErrorsAt,
    type AnchoredPipelineError
  } from './pipeline-catalog-state';
  import PipelineFieldErrors from './PipelineFieldErrors.svelte';
  import PipelinePortsEditor from './PipelinePortsEditor.svelte';
  import type { PipelineFlowSelection } from './pipeline-flow-view';
  import type { MutablePhase, MutablePipeline, PipelinePortPatch } from './types';

  interface Props {
    pipeline: MutablePipeline;
    phases: readonly MutablePhase[];
    selection: PipelineFlowSelection | null;
    readonly: boolean;
    anchoredErrors: readonly AnchoredPipelineError[];
    consumingWorkflows: readonly string[];
    onpipelinechange: (patch: Partial<MutablePipeline>) => void;
    onphasechange: (position: number, phaseId: string) => void;
    onaddport: (kind: 'inputs' | 'outputs') => void;
    onremoveport: (kind: 'inputs' | 'outputs', index: number) => void;
    onportchange: (kind: 'inputs' | 'outputs', index: number, patch: PipelinePortPatch) => void;
  }

  const {
    pipeline,
    phases,
    selection,
    readonly,
    anchoredErrors,
    consumingWorkflows,
    onpipelinechange,
    onphasechange,
    onaddport,
    onremoveport,
    onportchange
  }: Props = $props();

  const fieldErrorsOf = (field: string) =>
    pipelineErrorsAt(anchoredErrors, (anchor) => anchor.kind === 'field' && anchor.field === field);

  const nameErrors = $derived(fieldErrorsOf('name'));
  const idErrors = $derived(fieldErrorsOf('pipelineId'));
  const versionErrors = $derived(fieldErrorsOf('version'));
  const descriptionErrors = $derived(fieldErrorsOf('description'));
  const portErrors = $derived(pipelineErrorsAt(anchoredErrors, (anchor) => anchor.kind === 'port'));
  const pipelineErrors = $derived(
    pipelineErrorsAt(anchoredErrors, (anchor) => anchor.kind === 'pipeline')
  );

  const position = $derived(selection?.kind === 'phase' ? selection.position : null);
  const phaseErrors = $derived(
    position === null
      ? []
      : pipelineErrorsAt(
          anchoredErrors,
          (anchor) => anchor.kind === 'phase' && anchor.position === position
        )
  );
</script>

<div class="wf-inspector" data-testid="pipelines-inspector">
  {#if position !== null}
    <div class="wf-inspector-section" data-testid="pipelines-inspector-phase">
      <div class="wf-inspector-sub">Phase {position + 1}</div>
      <label class="wf-field">
        <span class="form-label">Phase</span>
        <select
          class="select-input"
          data-testid="pipelines-phase-select-{position}"
          aria-label="Phase {position + 1} of {pipeline.name}"
          value={pipeline.phases[position] ?? ''}
          disabled={readonly}
          aria-invalid={pipelineErrorInvalidFlag(phaseErrors)}
          aria-describedby={pipelineErrorDescribedBy(pipeline, `phase-${position}`, phaseErrors)}
          onchange={(event) => onphasechange(position, event.currentTarget.value)}
        >
          {#each phases as availablePhase (availablePhase.sourceKey)}
            <option value={availablePhase.id}>{availablePhase.name} ({availablePhase.id})</option>
          {/each}
          <!-- A position naming a Phase the effective catalog no longer holds
               still has to be selectable, or opening the row would silently
               rewrite it to whichever option happened to be first. -->
          {#if !phases.some((phase) => phase.id === pipeline.phases[position])}
            <option value={pipeline.phases[position]}>
              {pipeline.phases[position]} (Unknown)
            </option>
          {/if}
        </select>
      </label>
    </div>
  {/if}

  <div class="wf-inspector-section" data-testid="pipelines-inspector-identity">
    <div class="wf-inspector-sub">Pipeline</div>
    <label class="wf-field">
      <span class="form-label">Name</span>
      <input
        class="text-input"
        data-testid="pipelines-name-field-{pipeline.id}"
        value={pipeline.name}
        readonly={readonly}
        aria-invalid={pipelineErrorInvalidFlag(nameErrors)}
        aria-describedby={pipelineErrorDescribedBy(pipeline, 'name', nameErrors)}
        oninput={(event) => onpipelinechange({ name: event.currentTarget.value })}
        placeholder="Pipeline display name"
      />
    </label>
    <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'name')} errors={nameErrors} />

    <label class="wf-field">
      <span class="form-label">ID</span>
      <input
        class="text-input"
        data-testid="pipelines-id-field-{pipeline.id}"
        value={pipeline.id}
        readonly={pipeline.persisted}
        aria-invalid={pipelineErrorInvalidFlag(idErrors)}
        aria-describedby={pipelineErrorDescribedBy(pipeline, 'pipelineId', idErrors)}
        oninput={(event) => onpipelinechange({ id: event.currentTarget.value })}
        placeholder="pipeline-id"
      />
      {#if pipeline.persisted}
        <span class="field-help">Duplicate this Pipeline to create a new identity.</span>
      {/if}
    </label>
    <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'pipelineId')} errors={idErrors} />

    <label class="wf-field">
      <span class="form-label">Version</span>
      <input
        class="text-input"
        data-testid="pipelines-version-{pipeline.id}"
        value={pipeline.version}
        readonly
        aria-invalid={pipelineErrorInvalidFlag(versionErrors)}
        aria-describedby={pipelineErrorDescribedBy(pipeline, 'version', versionErrors)}
      />
    </label>
    <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'version')} errors={versionErrors} />

    <label class="wf-field">
      <span class="form-label">Description</span>
      <textarea
        class="text-area"
        rows="2"
        data-testid="pipelines-description-{pipeline.id}"
        value={pipeline.description ?? ''}
        readonly={readonly}
        aria-invalid={pipelineErrorInvalidFlag(descriptionErrors)}
        aria-describedby={pipelineErrorDescribedBy(pipeline, 'description', descriptionErrors)}
        oninput={(event) =>
          onpipelinechange({ description: event.currentTarget.value || undefined })}
        placeholder="Optional Pipeline description"
      ></textarea>
    </label>
    <PipelineFieldErrors
      id={pipelineErrorRegionId(pipeline, 'description')}
      errors={descriptionErrors}
    />
  </div>

  <PipelinePortsEditor
    pipelineId={pipeline.id}
    inputs={pipeline.inputs}
    outputs={pipeline.outputs}
    {readonly}
    errors={portErrors}
    {onaddport}
    {onremoveport}
    {onportchange}
  />

  <div class="consuming-workflows" data-testid="pipelines-consuming-workflows-{pipeline.id}">
    <div class="wf-inspector-sub" id="pipeline-consumers-label-{pipeline.id}">
      Consuming Workflows
    </div>
    <ul aria-labelledby="pipeline-consumers-label-{pipeline.id}">
      {#each consumingWorkflows as workflowId (workflowId)}
        <li>{workflowId}</li>
      {/each}
    </ul>
  </div>

  <!-- The foot. Errors that name no rendered control still have to be seen, so
       they are shown with their field rather than dropped (FR-048). -->
  <PipelineFieldErrors
    id={pipelineErrorRegionId(pipeline, 'pipeline')}
    errors={pipelineErrors}
    withField
    testId="pipelines-pipeline-errors"
  />
</div>
