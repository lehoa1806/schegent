<script lang="ts">
  // Feature 084 T035 & Feature 326 — the import preflight surface (FR-053..FR-058).
  //
  // Renders inside `BuilderImportModal.svelte` (modalMode=true) as the single
  // Builder-wide import flow, or standalone in unit tests (modalMode=false).
  // All buttons inherit from `.sg .btn` (`.preflight-button` retired). Every
  // document-derived string is rendered via text interpolation only (no `{@html}`).
  import { onMount } from 'svelte';
  import './process-import-shared.css';
  import type { DocumentRefusal, ImportPlan, PreflightProcessYamlResult } from '../../lib/messages';
  import { preflightProcessYaml } from '../../lib/process-yaml-ipc';
  import ProcessImportPlanTable from './ProcessImportPlanTable.svelte';
  import ProcessImportResultsTable from './ProcessImportResultsTable.svelte';
  import { saveModelsImport } from '../../lib/save-models';
  import { publishDefinitionPackage } from '../../lib/catalog-lifecycle';
  import {
    commitStatement,
    confirmBlockedReason,
    isModelCatalogPlan,
    lateImportCommitReport,
    modelCatalogCommitReport,
    modelCatalogCommitStatement,
    refusalHeadline,
    runImportCommit,
    runModelCatalogImportCommit,
    type ImportCommitOutcome,
    type ImportLayerResult,
    type ImportResultRow,
    type ImportTargetGate,
    type ImportTargetLayers
  } from './process-import-state';

  interface Props {
    /** Retained for backward-compatible callers; commit sends only the document's own rows. */
    layers?: ImportTargetLayers;
    /** Why an import cannot start right now (e.g. secondary window), or `null`. */
    disabledReason?: string | null;
    /** Target-kind-aware trust and cleanliness signals evaluated at Confirm. */
    targetGate?: ImportTargetGate;
    /** True when hosted inside `BuilderImportModal` (uses footer controls & heading). */
    modalMode?: boolean;
    /** Automatically start `preflightProcessYaml` once on mount (modal entry). */
    autoInspect?: boolean;
    /** Closes the hosting modal (disabled while committing). */
    onclose?: () => void;
    /** Notifies the hosting modal when commit in-flight state toggles. */
    oncommittingchange?: (active: boolean) => void;
    /** Called when OS picker is canceled with no prior plan loaded. */
    oncancelwithoutplan?: () => void;
  }

  const {
    disabledReason = null,
    layers: _layers,
    targetGate,
    modalMode = false,
    autoInspect = false,
    onclose,
    oncommittingchange,
    oncancelwithoutplan
  }: Props = $props();

  type PreflightSurface =
    | { readonly kind: 'idle' }
    | { readonly kind: 'validating' }
    | { readonly kind: 'canceled' }
    | { readonly kind: 'refused'; readonly refusal: DocumentRefusal }
    | { readonly kind: 'failed'; readonly message: string }
    | { readonly kind: 'planned'; readonly plan: ImportPlan };

  let surface = $state<PreflightSurface>({ kind: 'idle' });
  let retainedCanceledNotice = $state(false);
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  let committing = $state(false);
  let results = $state<readonly ImportResultRow[] | null>(null);
  let layerResults = $state<readonly ImportLayerResult[]>([]);
  let outcome = $state<ImportCommitOutcome | null>(null);

  $effect(() => {
    oncommittingchange?.(committing);
  });

  onMount(() => {
    if (autoInspect && disabledReason === null) {
      void onInspect();
    }
  });

  const validating = $derived(surface.kind === 'validating');
  const plan = $derived(surface.kind === 'planned' ? surface.plan : null);
  const blockedReason = $derived(
    confirmBlockedReason({
      state: committing ? 'committing' : surface.kind,
      plan,
      targetGate
    })
  );
  const modelCatalogOutcome = $derived(
    plan !== null &&
      isModelCatalogPlan(plan) &&
      (outcome === 'imported' || outcome === 'failed' || outcome === 'unknown')
      ? outcome
      : null
  );

  async function onInspect(): Promise<void> {
    if (validating || committing) return;
    if (disabledReason !== null) return;
    const priorPlan = plan;
    const priorResults = results;
    const priorLayerResults = layerResults;
    const priorOutcome = outcome;
    retainedCanceledNotice = false;
    results = null;
    layerResults = [];
    outcome = null;
    surface = { kind: 'validating' };
    const result = await preflightProcessYaml({
      signal: lifetime.signal,
      onLateOutcome: (late) => {
        if (lifetime.signal.aborted) return;
        if (surface.kind === 'failed') showPreflight(late, null, null, [], null);
      }
    });
    if (lifetime.signal.aborted) return;
    showPreflight(result, priorPlan, priorResults, priorLayerResults, priorOutcome);
  }

  function showPreflight(
    result: PreflightProcessYamlResult,
    priorPlan: ImportPlan | null,
    priorResults: readonly ImportResultRow[] | null,
    priorLayerResults: readonly ImportLayerResult[],
    priorOutcome: ImportCommitOutcome | null
  ): void {
    if (result.outcome === 'planned') {
      surface = { kind: 'planned', plan: result.plan };
      return;
    }
    if (result.outcome === 'refused') {
      surface = { kind: 'refused', refusal: result.refusal };
      return;
    }
    if (result.outcome === 'failed') {
      surface = { kind: 'failed', message: result.message };
      return;
    }
    // Canceled: if the operator already had a plan loaded and canceled from
    // "Choose another file…", keep the previous preview intact with a quiet note.
    // Otherwise close cleanly via `oncancelwithoutplan` (when hosted in a modal).
    if (priorPlan !== null) {
      surface = { kind: 'planned', plan: priorPlan };
      results = priorResults;
      layerResults = priorLayerResults;
      outcome = priorOutcome;
      retainedCanceledNotice = true;
      return;
    }
    surface = { kind: 'canceled' };
    oncancelwithoutplan?.();
  }

  async function onConfirm(): Promise<void> {
    if (blockedReason !== null || plan === null) return;
    const outbound = $state.snapshot(plan);
    retainedCanceledNotice = false;
    if (isModelCatalogPlan(outbound)) {
      committing = true;
      oncommittingchange?.(true);
      try {
        const report = await runModelCatalogImportCommit(outbound, {
          saveModels: (request) =>
            saveModelsImport(request, undefined, {
              signal: lifetime.signal,
              onLateOutcome: (late) => {
                if (lifetime.signal.aborted || outcome !== 'unknown') return;
                const next = modelCatalogCommitReport(outbound, late);
                outcome = next.outcome;
                results = next.rows;
              }
            })
        });
        if (lifetime.signal.aborted) return;
        outcome = report.outcome;
        layerResults = [];
        results = report.rows;
      } finally {
        committing = false;
        oncommittingchange?.(false);
      }
      return;
    }
    committing = true;
    oncommittingchange?.(true);
    try {
      const report = await runImportCommit(outbound, {
        publishPackage: (request) =>
          publishDefinitionPackage(request, undefined, {
            signal: lifetime.signal,
            onLateOutcome: (late) => {
              if (lifetime.signal.aborted || outcome !== 'unknown') return;
              const next = lateImportCommitReport(outbound, late);
              outcome = next.outcome;
              layerResults = next.results;
              results = next.rows;
            }
          })
      });
      if (lifetime.signal.aborted) return;
      outcome = report.outcome;
      layerResults = report.results;
      results = report.rows;
    } finally {
      committing = false;
      oncommittingchange?.(false);
    }
  }
</script>

<section
  class="preflight"
  data-testid="process-import-preflight"
  aria-labelledby="process-import-title"
>
  <header class="preflight-header">
    {#if modalMode}
      <h2 class="preflight-title" id="process-import-title">
        Import a Phase, Workflow, or Model Catalog document
      </h2>
    {:else}
      <h3 class="preflight-title" id="process-import-title">
        Import a Phase, Workflow, or Model Catalog document
      </h3>
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="process-import-inspect"
        disabled={validating || committing || disabledReason !== null}
        title={disabledReason ??
          (validating ? 'Reading the document you chose.' : 'Choose a document to inspect')}
        aria-describedby={disabledReason !== null ? 'process-import-unavailable' : undefined}
        onclick={onInspect}
      >Import…</button>
    {/if}
  </header>

  {#if disabledReason !== null}
    <p class="preflight-note" id="process-import-unavailable"
      data-testid="process-import-unavailable">{disabledReason}</p>
  {/if}

  {#if surface.kind === 'validating'}
    <p class="preflight-progress" data-testid="process-import-validating" role="status">
      Reading and validating the document…
    </p>
  {:else if surface.kind === 'canceled'}
    <p class="preflight-note" data-testid="process-import-canceled">
      No document was chosen, so there is nothing to show.
    </p>
  {:else if surface.kind === 'failed'}
    <p class="preflight-problem" data-testid="process-import-failed" role="alert">
      {surface.message}
    </p>
  {:else if surface.kind === 'refused'}
    <div class="preflight-problem" data-testid="process-import-refused" role="alert">
      <strong class="preflight-refusal-title" data-testid="process-import-refusal-title">
        This document was refused, so nothing was imported.
      </strong>
      <span data-testid="process-import-refusal-headline"
        >{refusalHeadline(surface.refusal.code)}</span
      >
      <span data-testid="process-import-refusal-message">{surface.refusal.message}</span>
      <span class="preflight-refusal-code" data-testid="process-import-refusal-code"
        >{surface.refusal.code}</span
      >
    </div>
  {:else if plan !== null}
    {#if retainedCanceledNotice}
      <p class="preflight-note" data-testid="process-import-canceled" role="status">
        No new document was chosen; your previous preview is unchanged.
      </p>
    {/if}

    {#if plan.rows.length === 0}
      <p class="preflight-note" data-testid="process-import-empty-plan">
        This document declares nothing to import.
      </p>
    {:else}
      <ProcessImportPlanTable {plan} />

      {#if results === null}
        <p class="preflight-note" data-testid="process-import-commit-statement">
          {isModelCatalogPlan(plan) ? modelCatalogCommitStatement(plan) : commitStatement(plan)}
        </p>

        {#if !modalMode}
          <div class="preflight-commit">
            <button
              type="button"
              class="btn btn-primary"
              data-testid="process-import-confirm"
              disabled={blockedReason !== null}
              title={blockedReason ??
                (isModelCatalogPlan(plan)
                  ? 'Import these models into the catalog'
                  : 'Import this document into the catalog')}
              aria-describedby={blockedReason !== null
                ? 'process-import-confirm-reason'
                : undefined}
              onclick={onConfirm}
            >Confirm import</button>

            {#if blockedReason !== null}
              <p
                class="preflight-note"
                id="process-import-confirm-reason"
                data-testid="process-import-confirm-blocked"
                role="status"
                aria-live="polite"
              >
                {blockedReason}
              </p>
            {/if}
          </div>
        {/if}
      {/if}
    {/if}

    {#if results !== null}
      <ProcessImportResultsTable
        {results}
        {layerResults}
        {outcome}
        {modelCatalogOutcome}
      />
    {/if}
  {/if}

  {#if modalMode}
    <footer class="preflight-footer">
      {#if plan !== null && plan.rows.length > 0 && results === null && blockedReason !== null}
        <p
          class="preflight-note preflight-footer-reason"
          id="process-import-confirm-reason"
          data-testid="process-import-confirm-blocked"
          role="status"
          aria-live="polite"
        >
          {blockedReason}
        </p>
      {/if}
      <div class="preflight-footer-actions">
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="process-import-inspect"
          disabled={validating || committing || disabledReason !== null}
          title={disabledReason ??
            (validating ? 'Reading the document you chose.' : 'Choose another document to inspect')}
          aria-describedby={disabledReason !== null ? 'process-import-unavailable' : undefined}
          onclick={onInspect}
        >Choose another file…</button>
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="builder-import-close"
          disabled={committing}
          onclick={() => { if (!committing) onclose?.(); }}
        >Close</button>
        {#if plan !== null && plan.rows.length > 0 && results === null}
          <button
            type="button"
            class="btn btn-primary"
            data-testid="process-import-confirm"
            disabled={blockedReason !== null}
            title={blockedReason ??
              (isModelCatalogPlan(plan)
                ? 'Import these models into the catalog'
                : 'Import this document into the catalog')}
            aria-describedby={blockedReason !== null
              ? 'process-import-confirm-reason'
              : undefined}
            onclick={onConfirm}
          >{committing ? 'Importing…' : 'Confirm import'}</button>
        {/if}
      </div>
    </footer>
  {/if}
</section>

<style>
  .preflight {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-pad);
  }
  .preflight-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--schegent-pad);
  }
  .preflight-title {
    margin: 0;
    font-size: 1em;
  }
  .preflight-progress {
    margin: 0;
    color: var(--schegent-muted-fg);
  }
  .preflight-problem {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }
  .preflight-refusal-title {
    font-weight: 600;
  }
  .preflight-refusal-code {
    font-family: var(--schegent-mono-font);
    color: var(--schegent-muted-fg);
  }
  .preflight-commit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--schegent-pad);
  }
  .preflight-footer {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-2);
    padding-top: var(--schegent-space-2);
    border-top: 1px solid var(--schegent-border);
  }
  .preflight-footer-reason {
    margin: 0;
  }
  .preflight-footer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--schegent-space-2);
  }
</style>
