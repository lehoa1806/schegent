<script lang="ts">
  // Feature 082 (US1, T030) — Pipeline Library and form.
  //
  // Rows come from the authoritative `pipelineCatalog` projection, never from
  // `snapshot.availablePipelines` — that list keeps its runtime-selection
  // meaning. Every mutating control stays unavailable until the projection
  // arrives (FR-028) and while trust, an in-flight save, or another row's
  // mutation says otherwise (FR-029). Built-in rows are read-only (FR-024) and
  // a persisted `pipelineId` is immutable — duplicating is the way to a new
  // identity (FR-007).
  //
  // Feature 099 (T494a, FR-043/FR-046) — no scope. There is one layer, so no
  // read-only `built-in` tier, no target-scope picker, and no per-capability
  // trust banner: the Pipelines tab is gated by Workspace Trust alone, and the
  // Builder reports that gate itself rather than rendering an empty list
  // (T493c, FR-052).
  //
  // Feature 101 (T006) — the error, aria, export and port derivations are pure
  // functions in `pipeline-catalog-state`; what stays here is the selection,
  // the runes, and the wiring.
  import type { BuilderLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { exportPipelineYaml } from '../../lib/process-yaml-ipc';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import PipelineFieldErrors from './PipelineFieldErrors.svelte';
  import PipelinePortsEditor from './PipelinePortsEditor.svelte';
  import {
    pipelineAnchoredErrors,
    pipelineConsumingWorkflows,
    pipelineErrorDescribedBy,
    pipelineErrorInvalidFlag,
    pipelineErrorRegionId,
    pipelineErrorsAt,
    pipelineExportDisabledReason,
    pipelineExportInclusionId,
    pipelineExportReasonId,
    pipelinePortAppended,
    pipelinePortPatched,
    pipelinePortRemoved,
    pipelineSequenceStatus,
    validatePipelineDraft,
    type PipelineDraftError,
    type PipelineErrorAnchor
  } from './pipeline-catalog-state';
  import type { MutablePhase, MutablePipeline, PipelinePortPatch } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    pipelines: MutablePipeline[];
    phases: MutablePhase[];
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    newPhaseId: string;
    trusted: boolean;
    saveError: string | null;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    getPhaseTooltip: (phaseId: string) => string;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onduplicate: (index: number) => void;
    onpipelinechange: (index: number, patch: Partial<MutablePipeline>) => void;
    onphasechange: (pipelineIndex: number, phaseIndex: number, phaseId: string) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    onnewphaseidchange: (value: string) => void;
    onaddphase: () => void;
    onremovephase: (index: number) => void;
    onmovephaseup: (index: number) => void;
    onmovephasedown: (index: number) => void;
  }

  const {
    snapshot,
    pipelines,
    phases,
    selectedIndex,
    historyIndex,
    historyLength,
    newPhaseId,
    trusted,
    saveError,
    savePending,
    mutationActive,
    editableSourceKey,
    getPhaseTooltip,
    onselect,
    onadd,
    onremove,
    onreset,
    onduplicate,
    onpipelinechange,
    onphasechange,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    onnewphaseidchange,
    onaddphase,
    onremovephase,
    onmovephaseup,
    onmovephasedown
  }: Props = $props();

  const selectedPipeline = $derived(selectedIndex !== null ? pipelines[selectedIndex] : null);

  /**
   * FR-034 — a Pipeline is an ordered sequence of Phases, so with no effective
   * Phase there is nothing a Pipeline could be composed of. The Builder still
   * opens and still renders existing rows; what it withdraws is every control
   * that would author a draft nothing can satisfy. The reason is stated as text
   * so the state is legible, not just a row of disabled buttons (SC-007).
   */
  const noEffectivePhase = $derived(phases.length === 0);

  const selectedReadOnly = $derived(
    !trusted ||
      savePending ||
      (editableSourceKey !== null && selectedPipeline?.sourceKey !== editableSourceKey)
  );

  // Advisory pre-flight validation over the authorable rows. The host still
  // re-validates every save; this only keeps an obviously invalid draft from
  // consuming a round trip, and blocks the save button while it stands.
  const draftErrors = $derived(
    pipelines.flatMap((pipeline) =>
      validatePipelineDraft(pipeline, pipelines).map((error) => ({
        ...error,
        sourceKey: pipeline.sourceKey
      }))
    )
  );

  // Only draft errors gate the save. `sourceErrors` describe the record as last
  // persisted and do not clear until the host reprojects, so blocking on them
  // would trap the operator inside the very row they opened to repair.
  const saveDisabled = $derived(
    !trusted || savePending || noEffectivePhase || draftErrors.length > 0
  );

  const anchoredErrors = $derived(pipelineAnchoredErrors(selectedPipeline, draftErrors));

  const errorsAt = (match: (anchor: PipelineErrorAnchor) => boolean): PipelineDraftError[] =>
    pipelineErrorsAt(anchoredErrors, match);

  const fieldErrorsOf = (field: string): PipelineDraftError[] =>
    errorsAt((anchor) => anchor.kind === 'field' && anchor.field === field);
  const phaseErrorsAt = (position: number): PipelineDraftError[] =>
    errorsAt((anchor) => anchor.kind === 'phase' && anchor.position === position);
  const sequenceErrors = $derived(errorsAt((anchor) => anchor.kind === 'sequence'));
  const portErrors = $derived(errorsAt((anchor) => anchor.kind === 'port'));
  /** Names no rendered control — shown at the card level rather than dropped. */
  const pipelineErrors = $derived(errorsAt((anchor) => anchor.kind === 'pipeline'));

  const nameErrors = $derived(fieldErrorsOf('name'));
  const idErrors = $derived(fieldErrorsOf('pipelineId'));
  const versionErrors = $derived(fieldErrorsOf('version'));
  const descriptionErrors = $derived(fieldErrorsOf('description'));

  function addPort(kind: 'inputs' | 'outputs'): void {
    if (selectedIndex === null || !selectedPipeline) return;
    onpipelinechange(selectedIndex, pipelinePortAppended(selectedPipeline, kind));
  }

  function removePort(kind: 'inputs' | 'outputs', index: number): void {
    if (selectedIndex === null || !selectedPipeline) return;
    onpipelinechange(selectedIndex, pipelinePortRemoved(selectedPipeline, kind, index));
  }

  function changePort(kind: 'inputs' | 'outputs', index: number, patch: PipelinePortPatch): void {
    if (selectedIndex === null || !selectedPipeline) return;
    onpipelinechange(selectedIndex, pipelinePortPatched(selectedPipeline, kind, index, patch));
  }

  const consumingWorkflows = (pipeline: MutablePipeline): readonly string[] =>
    pipelineConsumingWorkflows(snapshot, pipeline);

  const exportDisabledReason = $derived(pipelineExportDisabledReason(selectedPipeline));

  /**
   * Feature 085 T027 (FR-012) — the inclusion choice, made BEFORE the document
   * is produced rather than discovered in the save dialog after it.
   *
   * A property of how this operator is handing the definition over, not of the
   * Pipeline, so it survives changing the selection instead of resetting under
   * someone exporting several rows in a row. Nothing is persisted: it describes
   * one session's exports, and the default is the smaller document (FR-013).
   */
  let includeReferencedPhases = $state(false);

  /**
   * FR-013 / FR-015 — references only unless the operator asked for the
   * definitions. Either way `phaseIds` is what the Pipeline runs and in what
   * order; inclusion only adds a section (FR-019).
   *
   * Whether every referenced Phase actually resolves is the host's call
   * (FR-017): only it reads the effective catalog, and only it can tell a
   * missing reference from a structural defect. Pre-checking here would refuse
   * exports the host would have allowed and would need a second copy of the
   * resolution rule to do it.
   *
   * No location is named here and none comes back: the host opens its own save
   * dialog (FR-019, FR-021).
   */
  function onExport(pipeline: MutablePipeline): void {
    if (exportDisabledReason !== null) return;
    exportPipelineYaml(
      pipeline.id,
      includeReferencedPhases ? 'include-referenced' : 'references-only'
    );
  }

  /**
   * Feature 101 (US1, T037, FR-013) — lifecycle facts, keyed by projection
   * record. Read off the record rather than carried on `MutablePipeline`: the
   * mutable row is the editable copy every save body is stripped out of, and a
   * projected view field there is one strip away from being sent back to the
   * host (FR-010). Off the record, it cannot reach a write.
   */
  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (snapshot.pipelineCatalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );
</script>

{#if !snapshot.pipelineCatalog}
  <div class="catalog-state" role="status" aria-live="polite" aria-busy="true" data-testid="pipeline-catalog-loading">
    Loading authoritative Pipeline catalog…
  </div>
{:else if snapshot.pipelineCatalog.state === 'error'}
  <div class="catalog-state catalog-error" role="alert" data-testid="pipeline-catalog-error">
    {snapshot.pipelineCatalog.error?.message ?? 'The Pipeline catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else}
<div class="toolbar">
  <button class="btn btn-primary" data-testid="pipelines-add" onclick={onadd} disabled={!trusted || savePending || mutationActive || noEffectivePhase}>Add Pipeline</button>
  <button class="btn" disabled={!trusted || savePending || historyIndex <= 0} onclick={onundo}>Undo</button>
  <button class="btn" disabled={!trusted || savePending || historyIndex >= historyLength - 1} onclick={onredo}>Redo</button>
  <button class="btn btn-secondary" data-testid="pipelines-save-all" style="margin-left:auto" onclick={onsave} disabled={saveDisabled}>{savePending ? 'Saving…' : 'Save Pipeline'}</button>
</div>
{#if noEffectivePhase}
  <div class="catalog-state" role="status" aria-live="polite" data-testid="pipelines-no-phases">
    No effective Phase is available. A Pipeline is an ordered sequence of Phases, so add or restore at least one Phase in the Phase Library before creating or saving a Pipeline.
  </div>
{/if}
{#if snapshot.pipelineCatalog.warnings.length > 0}
  <div class="catalog-warning" role="status" aria-live="polite" data-testid="pipeline-catalog-warnings">
    {#each snapshot.pipelineCatalog.warnings as warning (warning.code + warning.message)}
      <div>{warning.message}</div>
    {/each}
  </div>
{/if}
{#if saveError}
  <div class="save-error-banner" data-testid="save-error-banner" role="alert">
    <span class="save-error-icon">⚠</span>
    <span class="save-error-text">Save rejected: {saveError}</span>
    <button class="save-error-dismiss" aria-label="Dismiss Pipeline save error" onclick={ondismisssaveerror}>✕</button>
  </div>
{/if}
<!-- Feature 101 (US6, T065, FR-032/FR-033) — the front door, and this tab's only
     import entry: the Pipelines tab never grew a standalone preflight region.
     Ordered after the trust check by construction — PipelineBuilder gates the
     three definition tabs, so an untrusted workspace never reaches here and the
     guidance can never point at an action that cannot succeed. -->
<CatalogEmptyState kind="pipeline" count={pipelines.length} />
<div class="split-pane">
  <div class="pane-left">
    <div class="phase-list">
      {#each pipelines as pipeline, index (pipeline.sourceKey)}
        <div class="phase-list-row">
          <div class="phase-list-main">
            <button class="phase-list-item {selectedIndex === index ? 'selected' : ''}" data-testid="pipelines-list-item-{pipeline.id}" aria-current={selectedIndex === index ? 'true' : undefined} onclick={() => onselect(index)}>
              <div class="phase-list-title">{pipeline.name || 'Untitled Pipeline'}</div>
              <div class="phase-list-id">{pipeline.id}</div>
            </button>
          </div>
          <!-- Feature 101 (US1, T037) — the state, timestamps, active version,
               and the validity badge that used to sit inside the button above.
               Outside it, because T042 hangs the lifecycle actions off this row. -->
          <DefinitionLifecycleRow
            kind="pipeline"
            definitionId={pipeline.id}
            definitionName={pipeline.name || 'Untitled Pipeline'}
            lifecycle={lifecycleByKey.get(pipeline.sourceKey)}
            validity={pipeline.sourceStatus}
            defects={pipeline.sourceErrors}
          />
        </div>
      {/each}
    </div>
  </div>
  <div class="pane-right">
    {#if selectedPipeline && selectedIndex !== null}
      {@const pipeline = selectedPipeline}
      {@const index = selectedIndex}
      <div class="editor-card full-height" data-testid="pipelines-editor-{pipeline.id}">
        <div class="card-header-complex">
          <!-- FR-038 — a placeholder is not an accessible name; this control
               edits the same value as the Name field below, so it says so. -->
          <input class="title-input" data-testid="pipelines-title-{pipeline.id}" aria-label="Pipeline name" value={pipeline.name} readonly={selectedReadOnly} oninput={(event) => onpipelinechange(index, { name: event.currentTarget.value })} placeholder="Pipeline Name" />
          <div class="header-actions">
            <button class="btn btn-ghost" onclick={() => onselect(null)}>Cancel</button>
            <button class="btn btn-ghost" data-testid="pipelines-discard" disabled={selectedReadOnly} onclick={() => onreset(index)}>Discard Draft</button>
            <button class="btn btn-ghost" data-testid="pipelines-duplicate" disabled={!trusted || savePending || mutationActive || noEffectivePhase} onclick={() => onduplicate(index)}>Duplicate Pipeline</button>
            <!-- FR-012 — the choice sits beside the control it changes, so it is
                 made before the document is produced rather than after. -->
            <label class="form-field checkbox-field" for={pipelineExportInclusionId(pipeline)}>
              <input type="checkbox" id={pipelineExportInclusionId(pipeline)} data-testid="pipelines-export-inclusion" disabled={exportDisabledReason !== null} checked={includeReferencedPhases} onchange={(event) => (includeReferencedPhases = event.currentTarget.checked)} />
              <span class="form-label" title="Carry a complete definition of every Phase this Pipeline references, so it opens on a catalog that does not have them">Include Phase definitions</span>
            </label>
            <!-- Export is read-only: it needs neither trust nor an idle save,
                 because it writes nothing this extension owns. -->
            <button class="btn btn-ghost" data-testid="pipelines-export" disabled={exportDisabledReason !== null} title={exportDisabledReason ?? `Export ${pipeline.id} as a document`} aria-label={`Export ${pipeline.id}`} aria-describedby={exportDisabledReason !== null ? pipelineExportReasonId(pipeline) : undefined} onclick={() => onExport(pipeline)}>Export Pipeline</button>
            {#if exportDisabledReason !== null}
              <span class="field-help" id={pipelineExportReasonId(pipeline)} data-testid="pipelines-export-disabled-reason">{exportDisabledReason}</span>
            {/if}
            {#if !selectedReadOnly}<button class="btn btn-secondary" disabled={saveDisabled} onclick={onsave}>Save Pipeline</button>{/if}
            {#if !selectedReadOnly}<button class="btn btn-destructive" data-testid="pipelines-remove" disabled={!trusted || savePending} onclick={(event) => onremove(index, event.currentTarget)}>Delete Pipeline</button>{/if}
          </div>
        </div>
        <div class="card-body">
          <div class="form-grid">
            <label class="form-field">
              <span class="form-label">Name</span>
              <input class="text-input" data-testid="pipelines-name-field-{pipeline.id}" value={pipeline.name} readonly={selectedReadOnly} aria-invalid={pipelineErrorInvalidFlag(nameErrors)} aria-describedby={pipelineErrorDescribedBy(pipeline, 'name', nameErrors)} oninput={(event) => onpipelinechange(index, { name: event.currentTarget.value })} placeholder="Pipeline display name" />
            </label>
            <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'name')} errors={nameErrors} />
            <label class="form-field">
              <span class="form-label">ID</span>
              <input class="text-input" data-testid="pipelines-id-field-{pipeline.id}" value={pipeline.id} readonly={pipeline.persisted} aria-invalid={pipelineErrorInvalidFlag(idErrors)} aria-describedby={pipelineErrorDescribedBy(pipeline, 'pipelineId', idErrors)} oninput={(event) => onpipelinechange(index, { id: event.currentTarget.value })} placeholder="pipeline-id" />
              {#if pipeline.persisted}<span class="field-help">Duplicate this Pipeline to create a new identity.</span>{/if}
            </label>
            <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'pipelineId')} errors={idErrors} />
            <!-- Feature 099 (T494a, FR-043) — no target-scope picker. A save has
                 one destination, so there was nothing left for this control to
                 choose between. -->
            <label class="form-field">
              <span class="form-label">Version</span>
              <input class="text-input" data-testid="pipelines-version-{pipeline.id}" value={pipeline.version} readonly aria-invalid={pipelineErrorInvalidFlag(versionErrors)} aria-describedby={pipelineErrorDescribedBy(pipeline, 'version', versionErrors)} />
            </label>
            <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'version')} errors={versionErrors} />
            <label class="form-field full-width">
              <span class="form-label">Description</span>
              <textarea class="text-area" rows="2" data-testid="pipelines-description-{pipeline.id}" value={pipeline.description ?? ''} readonly={selectedReadOnly} aria-invalid={pipelineErrorInvalidFlag(descriptionErrors)} aria-describedby={pipelineErrorDescribedBy(pipeline, 'description', descriptionErrors)} oninput={(event) => onpipelinechange(index, { description: event.currentTarget.value || undefined })} placeholder="Optional Pipeline description"></textarea>
            </label>
            <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'description')} errors={descriptionErrors} />
          </div>
          <div class="phases-sequence-editor">
            <div class="sequence-label" id="pipeline-phases-label-{pipeline.id}">Phase sequence</div>
            <!-- FR-038 — reordering is announced as text, not by visual position alone. -->
            <div class="sequence-status" data-testid="pipelines-sequence-status" role="status" aria-live="polite">{pipelineSequenceStatus(pipeline)}</div>
            <div class="sequence-list" role="list" aria-labelledby="pipeline-phases-label-{pipeline.id}" aria-describedby={pipelineErrorDescribedBy(pipeline, 'sequence', sequenceErrors)}>
              {#if pipeline.phases.length === 0}
                <div class="empty-selection">No Phases in this Pipeline. Add one below.</div>
              {/if}
              {#each pipeline.phases as phaseId, phaseIndex (phaseIndex)}
                {@const phaseErrors = phaseErrorsAt(phaseIndex)}
                <div class="sequence-item" role="listitem">
                  <div class="custom-tooltip">{getPhaseTooltip(phaseId)}</div>
                  <div class="sequence-number">{phaseIndex + 1}</div>
                  <select class="select-input sequence-select" data-testid="pipelines-phase-select-{phaseIndex}" aria-label="Phase {phaseIndex + 1} of {pipeline.name}" value={phaseId} disabled={selectedReadOnly} aria-invalid={pipelineErrorInvalidFlag(phaseErrors)} aria-describedby={pipelineErrorDescribedBy(pipeline, `phase-${phaseIndex}`, phaseErrors)} onchange={(event) => onphasechange(index, phaseIndex, event.currentTarget.value)}>
                    {#each phases as availablePhase (availablePhase.sourceKey)}
                      <option value={availablePhase.id}>{availablePhase.name} ({availablePhase.id})</option>
                    {/each}
                    {#if !phases.some((phase) => phase.id === phaseId)}
                      <option value={phaseId}>{phaseId} (Unknown)</option>
                    {/if}
                  </select>
                  <div class="sequence-actions">
                    <button class="icon-btn" data-testid="pipelines-move-phase-up-{phaseIndex}" aria-label="Move Phase {phaseIndex + 1} up" disabled={selectedReadOnly || phaseIndex === 0} onclick={() => onmovephaseup(phaseIndex)}>↑</button>
                    <button class="icon-btn" data-testid="pipelines-move-phase-down-{phaseIndex}" aria-label="Move Phase {phaseIndex + 1} down" disabled={selectedReadOnly || phaseIndex === pipeline.phases.length - 1} onclick={() => onmovephasedown(phaseIndex)}>↓</button>
                    <button class="icon-btn destructive-icon" data-testid="pipelines-remove-phase-{phaseIndex}" aria-label="Remove Phase {phaseIndex + 1}" disabled={selectedReadOnly} onclick={() => onremovephase(phaseIndex)}>✕</button>
                  </div>
                  <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, `phase-${phaseIndex}`)} errors={phaseErrors} />
                </div>
              {/each}
            </div>
            <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'sequence')} errors={sequenceErrors} />
            {#if !selectedReadOnly}
              <div class="add-phase-row">
                <select class="select-input flex-1" data-testid="pipelines-new-phase" aria-label="Phase to append" value={newPhaseId} disabled={noEffectivePhase} onchange={(event) => onnewphaseidchange(event.currentTarget.value)}>
                  <option value="">{noEffectivePhase ? 'No Phases available to add' : '-- Select a Phase to add --'}</option>
                  {#each phases as availablePhase (availablePhase.sourceKey)}
                    <option value={availablePhase.id}>{availablePhase.name} ({availablePhase.id})</option>
                  {/each}
                </select>
                <button class="btn btn-primary" data-testid="pipelines-add-phase" disabled={!newPhaseId || noEffectivePhase} onclick={onaddphase}>Add Phase</button>
              </div>
            {/if}
          </div>
          <PipelinePortsEditor
            pipelineId={pipeline.id}
            inputs={pipeline.inputs}
            outputs={pipeline.outputs}
            readonly={selectedReadOnly}
            errors={portErrors}
            onaddport={addPort}
            onremoveport={removePort}
            onportchange={changePort}
          />
          <div class="consuming-workflows" data-testid="pipelines-consuming-workflows-{pipeline.id}">
            <div class="sequence-label" id="pipeline-consumers-label-{pipeline.id}">Consuming Workflows</div>
            <ul aria-labelledby="pipeline-consumers-label-{pipeline.id}">
              {#each consumingWorkflows(pipeline) as workflowId (workflowId)}
                <li>{workflowId}</li>
              {/each}
            </ul>
          </div>
          <!-- Errors that name no rendered control still have to be seen. -->
          <PipelineFieldErrors id={pipelineErrorRegionId(pipeline, 'pipeline')} errors={pipelineErrors} withField testId="pipelines-pipeline-errors" />
        </div>
      </div>
    {:else}
      <div class="empty-selection">Select a Pipeline to edit or add a new one.</div>
    {/if}
  </div>
</div>
{/if}
