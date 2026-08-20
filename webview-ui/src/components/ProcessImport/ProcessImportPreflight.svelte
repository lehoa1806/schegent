<script lang="ts">
  // Feature 084 T035 — the import preflight surface (FR-053, FR-054, FR-055).
  //
  // Nothing here writes. This component asks the host what an import WOULD do
  // and renders the answer; the commit is a separate, gated save added in
  // Phase 5. The request goes through `preflightProcessYaml`, the single call
  // site for the exchange family (FR-058), and names no location in either
  // direction — the host opens its own dialog (FR-020a).
  //
  // Rendering discipline (FR-050): every string below that came from the
  // document — the resource id, the name, refusal and defect messages — was
  // sanitized and length-bounded by the host before it crossed the boundary.
  // This component treats it as untrusted content it does not interpret: text
  // interpolation only, no `{@html}`, no parsing, and nothing document-derived
  // placed in an attribute a browser would resolve.
  //
  // FR-055 in two parts. "Non-committal progress" — the validating state names
  // no outcome and shows no row, because nothing is known yet. "Bounded" — the
  // helper resolves a `failed` outcome if the host goes quiet, so this state
  // always ends. "No plan until validation finishes" is structural: `plan` only
  // exists inside the `planned` arm of the surface union below.
  //
  // That union's holder is `surface`, not `state`: a rune-mode component whose
  // variable is named `state` makes `$state` read as a store subscription on it,
  // which svelte-check reports as the rune being shadowed.
  //
  // T037–T040 — the commit. It is the EXISTING `savePhases` helper, not a new
  // command (research R2): the revision gate, the gate ordering, the trust
  // gates, the primary-window check, and all-or-nothing are all inherited from a
  // handler that is already pinned by tests. Every decision around it — why
  // Confirm is unavailable, what the save carries, and how its ack becomes a
  // per-row result — lives in `process-import-state.ts` so it is testable
  // without rendering, and so the plan table and the result table cannot
  // disagree about why a row was skipped.
  //
  // T067 — the accessibility conventions this surface follows, and why. Both
  // tables name themselves and put the Phase id in a row header, because an
  // outcome read on its own ("skip — already present") does not say which Phase
  // it belongs to, and the two tables' column headers are otherwise
  // indistinguishable. Confirm stays genuinely `disabled` rather than
  // `aria-disabled`: a commit in flight must not be re-activatable at all, which
  // is stronger than a handler that declines. That costs the control its focus
  // stop, so its reason is a live region — announced when it changes and while
  // reading the region. (Feature 099 T494a — the reason was also attached as the
  // description of the scope select, which was focusable and could carry it;
  // that control is gone with the layer tier, so the live region is now the
  // whole announcement.)
  //
  // T049 — the commit is now two ordered writes, so this component gained one
  // fact and no new judgment: an outcome that can be `partial`. Everything that
  // decides — which writes, in what order, on which revision, and what each row
  // is then reported as — stays in `process-import-state.ts`; `runImportCommit`
  // is handed the two save helpers and returns the whole report. No compensating
  // action is offered here, because there is none to offer (FR-042c).
  //
  // Feature 086 T054/T055 — a third ordered write, and again no new judgment
  // here: one more save helper handed in, and the layer acks held alongside the
  // rows so the outcome sentence can name which layers landed (FR-051). What is
  // NOT added is a retry, a rollback, or any other compensating affordance —
  // whichever prefix of the three writes landed, stays landed, and re-inspecting
  // the same document is the whole recovery path (FR-042b).
  //
  // T070 — the two tables are child components. The split is presentational
  // only: this file keeps every decision (what to request, when a commit is
  // allowed, what the commit writes) and the children keep none. The styles
  // both tables share live in `process-import-shared.css` rather than being
  // copied into each, following `MetricsDashboard/metrics-shared.css`.
  import './process-import-shared.css';
  import type { DocumentRefusal, ImportPlan } from '../../lib/messages';
  import { preflightProcessYaml } from '../../lib/process-yaml-ipc';
  import ProcessImportPlanTable from './ProcessImportPlanTable.svelte';
  import ProcessImportResultsTable from './ProcessImportResultsTable.svelte';
  import { saveModelsImport } from '../../lib/save-models';
  import { savePhases } from '../../lib/save-phases';
  import { savePipelines } from '../../lib/save-pipelines';
  import { saveWorkflows } from '../../lib/save-workflows';
  //
  // Feature 085 T034 — one entry point, two kinds of document (FR-055a). The
  // operator no longer picks a per-kind action, so this surface can be handed a
  // Pipeline package it did not ask for and must describe it accurately: a kind
  // per row (FR-056), and a statement of what confirming writes (FR-058). Both
  // are read from `process-import-state.ts` rather than composed in the
  // template, for the same reason the reasons already are — a sentence built in
  // markup is a sentence no test can pin.
  //
  // Feature 099 (T494a, FR-043) — the statement no longer says "and where". One
  // catalog, so the destination stopped being a fact the operator chooses or
  // this surface reports.
  import {
    commitStatement,
    confirmBlockedReason,
    isModelCatalogPlan,
    modelCatalogCommitStatement,
    refusalHeadline,
    runImportCommit,
    runModelCatalogImportCommit,
    type ImportCommitOutcome,
    type ImportLayerResult,
    type ImportResultRow,
    type ImportTargetLayers
  } from './process-import-state';

  interface Props {
    /**
     * All three catalogs as the snapshot currently holds them, projected the same
     * way the managers project them for a save. The parent owns the projection
     * because it owns the snapshot; this component only appends to it.
     */
    layers?: ImportTargetLayers;
    /**
     * T066 — why the surrounding manager cannot start an import right now, or
     * `null` when it can. Stated rather than merely applied (FR-057), and owned by
     * the parent because the conditions are the manager's: workspace trust, a save
     * in flight, an outstanding local edit.
     */
    disabledReason?: string | null;
  }

  const EMPTY_LAYERS: ImportTargetLayers = { phases: [], pipelines: [], workflows: [] };
  const { layers = EMPTY_LAYERS, disabledReason = null }: Props = $props();

  type PreflightSurface =
    | { readonly kind: 'idle' }
    | { readonly kind: 'validating' }
    | { readonly kind: 'canceled' }
    | { readonly kind: 'refused'; readonly refusal: DocumentRefusal }
    | { readonly kind: 'failed'; readonly message: string }
    | { readonly kind: 'planned'; readonly plan: ImportPlan };

  let surface = $state<PreflightSurface>({ kind: 'idle' });
  let committing = $state(false);
  let results = $state<readonly ImportResultRow[] | null>(null);
  /**
   * The layer acks the commit collected, held so the outcome sentence can name
   * which layers landed (FR-051). Set with `results`, and never derived from
   * them: a row's outcome cannot distinguish "this layer was refused" from "the
   * sequence stopped before this layer".
   */
  let layerResults = $state<readonly ImportLayerResult[]>([]);
  /** Set with `results`, and only with them. Never inferred from the rows. */
  let outcome = $state<ImportCommitOutcome | null>(null);

  const validating = $derived(surface.kind === 'validating');
  const plan = $derived(surface.kind === 'planned' ? surface.plan : null);
  const blockedReason = $derived(
    confirmBlockedReason({
      state: committing ? 'committing' : surface.kind,
      plan
    })
  );
  /**
   * FR-042a for Model Catalog: `outcome` is shared with the Phase/Pipeline/
   * Workflow path (a superset type), so this re-derives, from `plan` itself,
   * whether the CURRENT result set came from a modelCatalog commit — the same
   * signal `onConfirm` reads to choose which commit function to call.
   */
  const modelCatalogOutcome = $derived(
    plan !== null && isModelCatalogPlan(plan) && (outcome === 'imported' || outcome === 'failed')
      ? outcome
      : null
  );

  async function onInspect(): Promise<void> {
    // One inspection at a time: a second request would race two acks onto one
    // surface, and the operator has no way to tell which document won.
    if (validating || committing) return;
    // Re-read rather than trust the disabled attribute: the parent's conditions
    // can change between render and click.
    if (disabledReason !== null) return;
    // A new document invalidates the previous plan's result.
    results = null;
    layerResults = [];
    outcome = null;
    surface = { kind: 'validating' };
    const result = await preflightProcessYaml();
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
    surface = { kind: 'canceled' };
  }

  async function onConfirm(): Promise<void> {
    // The gate is re-read here, not trusted from the rendered `disabled`: a
    // keyboard activation can arrive in the same tick the state changed.
    if (blockedReason !== null || plan === null) return;
    // Feature 096 T024 — the Model Catalog is not in the store (FR-056), so it
    // dispatches through its own, simpler single-write commit function
    // (Implementation Notes point 1) instead of `runImportCommit`.
    if (isModelCatalogPlan(plan)) {
      committing = true;
      const report = await runModelCatalogImportCommit(plan, { saveModels: saveModelsImport });
      committing = false;
      outcome = report.outcome;
      layerResults = [];
      results = report.rows;
      return;
    }
    committing = true;
    // The three writes, in dependency order, each gated on its own revision.
    // `runImportCommit` stops at the first rejection and reports what did land —
    // there is nothing to undo here and nothing offered (FR-042b/c, FR-051).
    const report = await runImportCommit(plan, layers, {
      savePhases,
      savePipelines,
      saveWorkflows
    });
    committing = false;
    outcome = report.outcome;
    layerResults = report.results;
    results = report.rows;
  }
</script>

<section
  class="preflight"
  data-testid="process-import-preflight"
  aria-labelledby="process-import-title"
>
  <header class="preflight-header">
    <!-- FR-055a — the operator does not classify the file; the host dispatches
         on what the document declares. The title names the readable kinds so it
         is clear what this accepts, not so a choice has to be made first. -->
    <h3 class="preflight-title" id="process-import-title">
      Import a Phase, Pipeline, Workflow, or Model Catalog document
    </h3>
    <button
      type="button"
      class="preflight-button"
      data-testid="process-import-inspect"
      disabled={validating || disabledReason !== null}
      title={disabledReason ??
        (validating ? 'Reading the document you chose.' : 'Choose a document to inspect')}
      aria-describedby={disabledReason !== null ? 'process-import-unavailable' : undefined}
      onclick={onInspect}
    >Import…</button>
  </header>

  {#if disabledReason !== null}
    <!-- FR-057 — a title alone is not a stated reason for anyone not hovering. -->
    <p class="preflight-note" id="process-import-unavailable"
      data-testid="process-import-unavailable">{disabledReason}</p>
  {/if}

  {#if surface.kind === 'validating'}
    <!-- No outcome, no count, no row: nothing is known yet (FR-055). -->
    <p class="preflight-progress" data-testid="process-import-validating" role="status">
      Reading and validating the document…
    </p>
  {:else if surface.kind === 'canceled'}
    <!-- T051 — a cancellation is the operator's own choice not to proceed, and it
         is deliberately quiet: a note, not an alert, and no reason, because there
         is no document to have a reason about. The refusal arm below is the
         contrast an operator has to be able to draw without reading closely. -->
    <p class="preflight-note" data-testid="process-import-canceled">
      No document was chosen, so there is nothing to show.
    </p>
  {:else if surface.kind === 'failed'}
    <p class="preflight-problem" data-testid="process-import-failed" role="alert">
      {surface.message}
    </p>
  {:else if surface.kind === 'refused'}
    <!-- A document-level refusal produces no plan at all (FR-027), so no table
         is rendered here — not an empty one.

         T051/FR-057 — three parts, in the order an operator needs them: that a
         document was refused, why in prose, and what specifically was wrong.
         The code stays visible for reporting but is no longer the whole reason. -->
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
    {#if plan.rows.length === 0}
      <p class="preflight-note" data-testid="process-import-empty-plan">
        This document declares nothing to import.
      </p>
    {:else}
      <ProcessImportPlanTable {plan} />

      {#if results === null}
        <!-- FR-058 — what Confirm does, said before it is pressed: only the
             eligible rows. Stated as visible prose next to the controls rather
             than wired into their descriptions, because it is true of the
             surface at all times and not a reason a particular control is
             unavailable. -->
        <p class="preflight-note" data-testid="process-import-commit-statement">
          {isModelCatalogPlan(plan) ? modelCatalogCommitStatement(plan) : commitStatement(plan)}
        </p>

        <div class="preflight-commit">
          <!--
            Feature 099 (T494a, FR-043) — the scope selector stood here. It made
            the operator choose between the two writable layers before Confirm
            would enable, and it existed because a write had somewhere else it
            could have gone. There is one catalog, so there is no choice to make
            and no placeholder to guard against.
          -->
          <!-- FR-036/FR-057 — unavailable confirmation always says why, next to
               the control, rather than leaving a dead button. -->
          <button
            type="button"
            class="preflight-button"
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
            <!-- T067 — a live region, because a `disabled` button takes no focus:
                 without this the reason is only available to someone reading the
                 region, and a change from blocked to available would pass
                 silently. -->
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

    {#if results !== null}
      <ProcessImportResultsTable
        {results}
        {layerResults}
        {outcome}
        {modelCatalogOutcome}
      />
    {/if}
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
  .preflight-button {
    min-height: 24px;
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    border: 1px solid transparent;
    border-radius: var(--schegent-radius);
    padding: 0 var(--schegent-pad);
    font: inherit;
    cursor: pointer;
  }
  .preflight-button:hover:not(:disabled) {
    background: var(--schegent-button-hover);
  }
  .preflight-button:focus-visible {
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 1px;
  }
  .preflight-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* `.preflight-note` and `.preflight-counts` are shared with the table
     components and live in process-import-shared.css. */
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
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--schegent-muted-fg);
  }
  .preflight-commit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--schegent-pad);
  }
</style>
