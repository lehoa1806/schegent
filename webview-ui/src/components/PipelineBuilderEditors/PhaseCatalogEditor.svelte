<script lang="ts">
  import type { BuilderLifecycle, PhaseDefinition, WorkflowSnapshot } from '../../lib/snapshot-types';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import ProcessExportButton from '../ProcessImport/ProcessExportButton.svelte';
  import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';
  import {
    importDisabledReason,
    phaseExportAvailability,
    storedWritableLayers
  } from '../ProcessImport/process-exchange-entry';
  import RawJsonPhaseEditor from '../settings/RawJsonPhaseEditor.svelte';
  import RetryConditionEditor from '../settings/RetryConditionEditor.svelte';
  import TrustBanner from '../TrustBanner.svelte';
  import { mergeDetectedModels } from './model-catalog-state';
  import type { MutablePhase, PhaseEditState } from './types';

  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const RUNNER_KINDS = ['claude', 'codex', 'agy'] as const;
  // Feature 098 T018 — this file used to mirror the host's
  // `GIT_METADATA_WRITE_PHASE_IDS` and grey out the Inherit and Codex runner
  // options for a built-in Phase on that list. Both halves of the condition are
  // gone: the host rule now keys on the Phase's declared `sideEffects === 'git'`
  // (FR-007) and FR-008 permits **no replacement id list** anywhere, webview
  // copies included. `MutablePhase` carries no declared containment class, so
  // this surface cannot answer the re-keyed question and does not guess at it —
  // the host's lifecycle save gate and the launch assertion in `phase-runner.ts`
  // are the authoritative refusals, and a save that violates the rule comes back
  // as a field error on `runner`.

  interface Props {
    snapshot: WorkflowSnapshot;
    phases: MutablePhase[];
    editStateById: Record<string, PhaseEditState>;
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    retryConditionsTrusted: boolean;
    showTrustBanner: boolean;
    showRetryTrustBanner: boolean;
    saveError: string | null;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onphasechange: (index: number, patch: Partial<MutablePhase>) => void;
    onmoveup: (index: number) => void;
    onmovedown: (index: number) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    ontoggleraw: (phaseId: string) => void;
    onrawsave: (index: number, parsed: Record<string, unknown>) => void;
    ontoggleretry: (index: number) => void;
    onretrychange: (index: number, event: { source: string; valid: boolean }) => void;
    onduplicate: (index: number) => void;
  }

  const {
    snapshot,
    phases,
    editStateById,
    selectedIndex,
    historyIndex,
    historyLength,
    trusted,
    retryConditionsTrusted,
    showTrustBanner,
    showRetryTrustBanner,
    saveError,
    savePending,
    mutationActive,
    editableSourceKey,
    onselect,
    onadd,
    onremove,
    onreset,
    onphasechange,
    onmoveup,
    onmovedown,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    ontoggleraw,
    onrawsave,
    ontoggleretry,
    onretrychange,
    onduplicate
  }: Props = $props();

  const selectedPhase = $derived(selectedIndex !== null ? phases[selectedIndex] : null);
  const selectedEditState = $derived(
    selectedPhase ? editStateById[selectedPhase.sourceKey] ?? { rawJsonMode: false } : null
  );

  // Feature 099 (T488/T494a, FR-041/FR-043) — no scope. There is one layer, so
  // no read-only `built-in` tier, no target-scope picker, no scope badge, and no
  // precedence badge: precedence was the answer to "which layer won", and one
  // layer answers it by existing.
  const selectedReadOnly = $derived(
    !trusted || savePending ||
      (editableSourceKey !== null && selectedPhase?.sourceKey !== editableSourceKey)
  );

  function directiveKind(phase: MutablePhase): 'instruction' | 'skill' {
    return typeof phase.skill === 'string' ? 'skill' : 'instruction';
  }

  function changeDirectiveKind(index: number, kind: 'instruction' | 'skill'): void {
    if (kind === 'skill') {
      onphasechange(index, { instruction: undefined, skill: '' });
    } else {
      onphasechange(index, { instruction: '', skill: undefined });
    }
  }

  function authoredPhase(phase: MutablePhase): Record<string, unknown> {
    const { sourceKey: _sourceKey, sourceStatus: _status,
      sourceErrors: _errors, modelAvailable: _modelAvailable,
      persisted: _persisted, ...authored } = phase;
    return authored;
  }

  function isRetryEnabled(phase: MutablePhase): boolean {
    return typeof phase.retryCondition === 'string';
  }

  /**
   * What this phase's backend can be pointed at: the operator's own catalog
   * (`schegent.models`) followed by whatever the CLI reported, deduped.
   *
   * This read `availableModels` alone until Claude and Codex started
   * reporting no models — neither CLI can enumerate them — which left those
   * phases with nothing to select but Inherit, the imported ids included.
   * Configured comes first because it is the operator's list; detection only
   * adds to it.
   */
  function modelsFor(phase: MutablePhase): readonly string[] {
    const runner = phase.runner || snapshot.defaultRunnerKind || 'claude';
    return mergeDetectedModels(
      snapshot.configuredModels?.[runner] ?? [],
      snapshot.availableModels?.[runner] ?? []
    );
  }

  function configuredModelUnavailable(phase: MutablePhase): boolean {
    return !!phase.model && !modelsFor(phase).includes(phase.model);
  }

  function effortOptionDisabled(phase: MutablePhase, effort: string): boolean {
    const runner = phase.runner || snapshot.defaultRunnerKind || 'claude';
    return runner === 'agy' && (effort === 'xhigh' || effort === 'max');
  }

  function phaseErrorId(phase: MutablePhase): string | undefined {
    return phase.sourceErrors.length > 0 ? `phase-errors-${phase.id}` : undefined;
  }

  /**
   * T066 — the exchange entry points (FR-052, FR-053).
   *
   * Both live inside the `phaseCatalog.state === 'ready'` arm below, so the layers
   * an import appends to are the authoritative ones by construction rather than by
   * a check: an empty projection taken while the catalog was still loading would
   * make a commit erase the layer it wrote to.
   */
  const importLayers = $derived(
    // Feature 085 T048 / 086 T054 — all three catalogs, because a confirmed
    // package writes all three and each write sends its whole layer. The
    // Pipeline and Workflow records come off the same snapshot for the same
    // reason the Phase records do: it is the one the host resolved, so the layer
    // an import appends to is authoritative by construction rather than by a
    // check.
    storedWritableLayers(
      snapshot.phaseCatalog?.records ?? [],
      snapshot.pipelineCatalog?.records ?? [],
      snapshot.workflowCatalog?.records ?? []
    )
  );
  const importUnavailable = $derived(
    importDisabledReason({ trusted, savePending, mutationActive })
  );

  /**
   * Feature 101 (US1, T037, FR-013) — lifecycle facts, keyed by the projection
   * record they came from.
   *
   * Read off the record and never carried on `MutablePhase`. The mutable row is
   * the editable copy, and every field on it has to be stripped before a save
   * body goes out; a lifecycle field there would be one more strip to remember,
   * and the one that got missed would send a projected view field back to the
   * host — exactly what FR-010 forbids. Off the record, it cannot reach a write.
   */
  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (snapshot.phaseCatalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );
</script>

<!--
  FR-R3-143 (T040) — the deciding step is read off the projection this editor
  already holds, not threaded down as two more props. `showTrustBanner` answers
  "is it denied"; `resolvedScope` answers "by whom", and both come from the same
  snapshot, so a separate prop pair could only ever go out of step with the flag
  beside it. `undefined` reaches the banner as `undefined` and it names no layer.
-->
{#if showTrustBanner}
  <TrustBanner variant="phases" decidedBy={snapshot.resolvedScope?.phases} />
{/if}
{#if showRetryTrustBanner}
  <TrustBanner
    variant="retry-conditions"
    decidedBy={snapshot.resolvedScope?.retryConditions}
  />
{/if}
{#if !snapshot.phaseCatalog}
  <div class="catalog-state" role="status" aria-live="polite" aria-busy="true" data-testid="phase-catalog-loading">
    Loading authoritative Phase catalog…
  </div>
{:else if snapshot.phaseCatalog.state === 'error'}
  <div class="catalog-state catalog-error" role="alert" data-testid="phase-catalog-error">
    {snapshot.phaseCatalog.error?.message ?? 'The Phase catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else}
<div class="toolbar">
  <button class="btn btn-primary" data-testid="phases-add" onclick={onadd} disabled={!trusted || savePending || mutationActive}>Add Phase</button>
  <button class="btn" disabled={!trusted || savePending || mutationActive || historyIndex <= 0} onclick={onundo}>Undo</button>
  <button class="btn" disabled={!trusted || savePending || mutationActive || historyIndex >= historyLength - 1} onclick={onredo}>Redo</button>
  <button class="btn btn-secondary" data-testid="phases-save-all" style="margin-left:auto" onclick={onsave} disabled={!trusted || savePending || !mutationActive}>{savePending ? 'Saving…' : 'Save Phase'}</button>
</div>
{#if snapshot.phaseCatalog.warnings.length > 0}
  <div class="catalog-warning" role="status" aria-live="polite">
    {#each snapshot.phaseCatalog.warnings as warning}
      <div>{warning.message}</div>
    {/each}
  </div>
{/if}
{#if saveError}
  <div class="save-error-banner" data-testid="save-error-banner" role="alert">
    <span class="save-error-icon">⚠</span>
    <span class="save-error-text">Save rejected: {saveError}</span>
    <button class="save-error-dismiss" aria-label="Dismiss Phase save error" onclick={ondismisssaveerror}>✕</button>
  </div>
{/if}
<!-- Feature 101 (US6, T065, FR-032/FR-033) — the front door, and it brings its
     own import region. Ordered after the trust check by construction: an
     untrusted workspace never renders this editor at all (PipelineBuilder gates
     the three definition tabs), so guidance can never point at an action that
     cannot succeed. It self-guards on the count, so the condition for showing it
     is stated once, in the component that owns it. -->
<CatalogEmptyState kind="phase" count={phases.length} disabledReason={importUnavailable} />
{#if phases.length > 0}
  <!-- FR-053 — the import entry point. Its own region rather than a toolbar button,
       because the preflight it opens renders in place: the plan, the scope choice,
       and the per-row result all belong to this landmark. Withheld while the
       catalog is empty because the empty state above already offers one, and two
       import regions on one screen is two answers to one question. -->
  <ProcessImportPreflight layers={importLayers} disabledReason={importUnavailable} />
{/if}
<div class="split-pane">
  <div class="pane-left">
    <div class="phase-list">
      {#each phases as phase, index (phase.sourceKey)}
        <div class="phase-list-row">
          <div class="phase-list-main">
            <button class="phase-list-item {selectedIndex === index ? 'selected' : ''}" data-testid="phases-list-item-{phase.id}" aria-current={selectedIndex === index ? 'true' : undefined} onclick={() => onselect(index)}>
              <div class="phase-list-title">{phase.name || 'Untitled Phase'}</div>
              <div class="phase-list-id">{phase.id}</div>
              <!-- Feature 099 (T494a, FR-043) — no scope badge. A badge that can
                   only ever read one value is not a badge.
                   Feature 101 (T037) — the validity badge left with the lifecycle
                   chrome below. Model availability is a runtime fact about the
                   backend, not a lifecycle state, so it stayed. -->
              {#if phase.modelAvailable === false}
                <div class="phase-badges"><span class="status-badge">model unavailable</span></div>
              {/if}
            </button>
            <div class="phase-list-actions">
              <!-- Feature 099 (T494a, FR-043) — the two guards these lost asked
                   whether the row or its neighbour sat in a different layer. One
                   layer, so every row is reorderable against every other. -->
              <button class="icon-btn" aria-label="Move {phase.name} up" data-testid="phases-move-up-{phase.id}" disabled={!trusted || savePending || mutationActive || index === 0} onclick={() => onmoveup(index)}>↑</button>
              <button class="icon-btn" aria-label="Move {phase.name} down" data-testid="phases-move-down-{phase.id}" disabled={!trusted || savePending || mutationActive || index === phases.length - 1} onclick={() => onmovedown(index)}>↓</button>
            </div>
          </div>
          <!-- Outside the selection button, not inside it: T042 hung the
               lifecycle actions off this row, and a control nested in a button is
               invalid markup and unreachable by keyboard.
               `definitionName` falls back the same way the title above does: the
               confirmations name what the operator sees, and an untitled row shows
               that placeholder, not an empty string. -->
          <DefinitionLifecycleRow
            kind="phase"
            definitionId={phase.id}
            definitionName={phase.name || 'Untitled Phase'}
            lifecycle={lifecycleByKey.get(phase.sourceKey)}
            validity={phase.sourceStatus}
            defects={phase.sourceErrors}
          />
        </div>
      {/each}
    </div>
  </div>
  <div class="pane-right">
    {#if selectedPhase && selectedIndex !== null && selectedEditState}
      {@const phase = selectedPhase}
      {@const index = selectedIndex}
      {@const exportable = phaseExportAvailability(phase)}
      <div class="editor-card full-height" data-testid="phases-editor-{phase.id}">
        <div class="card-header-complex">
          <input class="title-input" data-testid="phases-name-{phase.id}" aria-label="Phase name" value={phase.name} readonly={selectedReadOnly} oninput={(event) => onphasechange(index, { name: event.currentTarget.value })} placeholder="Phase Name" />
          <div class="header-actions">
            {#if !selectedReadOnly}
              <button class="btn btn-ghost" data-testid="phases-raw-json-toggle" disabled={selectedReadOnly} onclick={() => ontoggleraw(phase.sourceKey)}>
                {selectedEditState.rawJsonMode ? 'Form view' : 'Edit as Raw JSON'}
              </button>
            {/if}
            <button class="btn btn-ghost" onclick={() => onselect(null)}>Cancel</button>
            <button class="btn btn-ghost" disabled={selectedReadOnly} onclick={() => onreset(index)}>Discard Draft</button>
            <button class="btn btn-ghost" data-testid="phases-duplicate" disabled={!trusted || savePending || mutationActive} onclick={() => onduplicate(index)}>Duplicate Phase</button>
            <!-- FR-052 — Export is per phase, writes a file the operator names
                 and changes no catalog state; shown here in the editor header
                 rather than the sidebar to reduce visual clutter. -->
            <ProcessExportButton
              phaseId={phase.id}
              rowKey={phase.sourceKey}
              resolves={exportable.resolves}
              disabledReason={exportable.disabledReason}
            />
            {#if !selectedReadOnly}<button class="btn btn-secondary" disabled={!trusted || savePending} onclick={onsave}>Save Phase</button>{/if}
            {#if !selectedReadOnly}<button class="btn btn-destructive" data-testid="phases-remove" disabled={!trusted || savePending} onclick={(event) => onremove(index, event.currentTarget)}>Delete Phase</button>{/if}
          </div>
        </div>

        {#if selectedEditState.rawJsonMode}
          <RawJsonPhaseEditor
            phase={authoredPhase(phase)}
            onsave={(parsed) => onrawsave(index, parsed as Record<string, unknown>)}
          />
        {:else}
          <div class="form-grid">
            <label class="form-field">
              <span class="form-label">Name</span>
              <input class="text-input" data-testid="phases-name-field-{phase.id}" value={phase.name} readonly={selectedReadOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'name') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { name: event.currentTarget.value })} placeholder="Phase display name" />
            </label>
            <label class="form-field">
              <span class="form-label">ID</span>
              <input class="text-input" value={phase.id} readonly={phase.persisted} aria-invalid={phase.sourceErrors.some((error) => error.field === 'phaseId') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { id: event.currentTarget.value })} placeholder="phase-id" />
              {#if phase.persisted}<span class="field-help">Duplicate this Phase to create a new identity.</span>{/if}
            </label>
            <!-- Feature 099 (T494a, FR-043) — no target-scope picker. A save has
                 one destination, so there was nothing left for this control to
                 choose between. -->
            <label class="form-field">
              <span class="form-label">Version</span>
              <input class="text-input" value={phase.version} readonly />
            </label>
            <label class="form-field full-width">
              <span class="form-label">Description</span>
              <textarea class="text-area" rows="2" value={phase.description ?? ''} readonly={selectedReadOnly} oninput={(event) => onphasechange(index, { description: event.currentTarget.value || undefined })} placeholder="Optional Phase description"></textarea>
            </label>
            <label class="form-field">
              <span class="form-label">Directive</span>
              <select class="select-input" value={directiveKind(phase)} disabled={selectedReadOnly} onchange={(event) => changeDirectiveKind(index, event.currentTarget.value as 'instruction' | 'skill')}>
                <option value="instruction">Instruction</option>
                <option value="skill">Skill reference</option>
              </select>
            </label>
            {#if directiveKind(phase) === 'instruction'}
              <label class="form-field full-width">
                <span class="form-label">Instruction</span>
                <textarea class="text-area" rows="6" value={phase.instruction ?? ''} readonly={selectedReadOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'instruction' || error.field === 'directive') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { instruction: event.currentTarget.value })} placeholder="Phase instructions..."></textarea>
              </label>
            {:else}
              <label class="form-field full-width">
                <span class="form-label">Skill reference</span>
                <input class="text-input" value={phase.skill ?? ''} readonly={selectedReadOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'skill' || error.field === 'directive') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { skill: event.currentTarget.value })} placeholder="skill-name" />
              </label>
            {/if}
            <label class="form-field" style="flex: 1">
              <span class="form-label">Model</span>
              <select class="select-input" data-testid="phases-model-{phase.id}" value={phase.model ?? ''} disabled={selectedReadOnly} onchange={(event) => onphasechange(index, { model: event.currentTarget.value || undefined })}>
                <option value="">[Inherit / Default Backend Model]</option>
                {#if configuredModelUnavailable(phase)}
                  <option value={phase.model}>{phase.model} (Unavailable)</option>
                {/if}
                {#each modelsFor(phase) as model}
                  <option value={model}>{model}</option>
                {/each}
              </select>
            </label>
            <label class="form-field" style="flex: 1">
              <span class="form-label">Effort</span>
              <select class="select-input" data-testid="phases-effort-{phase.id}" value={phase.effort ?? ''} disabled={selectedReadOnly} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { effort: value ? (value as PhaseDefinition['effort']) : undefined }); }}>
                <option value="">[Inherit]</option>
                {#each EFFORT_LEVELS as effort}
                  <option value={effort} disabled={effortOptionDisabled(phase, effort)}>{effort}</option>
                {/each}
              </select>
            </label>
            <label class="form-field" style="flex: 1">
              <!-- Feature 099 (T488, FR-041) — no precedence badge. It named the
                   layer whose `runner` won; precedence is the answer to "which
                   layer won", and one layer answers it by existing. -->
              <span class="form-label">Runner</span>
              <select class="select-input" data-testid="phases-runner-{phase.id}" value={phase.runner ?? ''} disabled={selectedReadOnly} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { runner: value ? (value as PhaseDefinition['runner']) : undefined }); }}>
                <option value="">[Inherit / Default]</option>
                {#each RUNNER_KINDS as runner}
                  <option value={runner}>{runner}{!snapshot.availableBackends.includes(runner) ? ' (Unavailable)' : ''}</option>
                {/each}
              </select>
            </label>
            <label class="form-field">
              <span class="form-label">Timeout seconds</span>
              <input class="text-input" type="number" min="1" max="3600" value={phase.timeoutSeconds ?? ''} readonly={selectedReadOnly} oninput={(event) => onphasechange(index, { timeoutSeconds: event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value) })} />
            </label>
            <label class="form-field checkbox-field">
              <input type="checkbox" checked={phase.loopable === true} disabled={selectedReadOnly} onchange={(event) => onphasechange(index, { loopable: event.currentTarget.checked })} />
              <span class="form-label">Loopable</span>
            </label>
            <label class="form-field checkbox-field">
              <input
                type="checkbox"
                data-testid="phases-required-{phase.id}"
                checked={phase.isRequired !== false}
                disabled={selectedReadOnly}
                onchange={(event) => onphasechange(index, { isRequired: event.currentTarget.checked })}
              />
              <span class="form-label">Required</span>
            </label>
            <label class="form-field checkbox-field">
              <input type="checkbox" data-testid="phases-retry-toggle" checked={isRetryEnabled(phase)} onchange={() => ontoggleretry(index)} disabled={!retryConditionsTrusted || selectedReadOnly} />
              <span class="form-label">Retry Condition</span>
            </label>
            {#if isRetryEnabled(phase)}
              <div class="form-field full-width retry-condition-row">
                <RetryConditionEditor
                  source={phase.retryCondition ?? ''}
                  instruction={phase.instruction ?? ''}
                  onchange={(event) => onretrychange(index, event)}
                  readonly={!retryConditionsTrusted || selectedReadOnly}
                />
              </div>
            {/if}
            {#if phase.sourceErrors.length > 0}
              <div class="field-errors full-width" id={phaseErrorId(phase)} role="alert">
                {#each phase.sourceErrors as error}
                  <div><strong>{error.field}:</strong> {error.message}</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="empty-selection">Select a phase to edit or add a new one.</div>
    {/if}
  </div>
</div>
{/if}
