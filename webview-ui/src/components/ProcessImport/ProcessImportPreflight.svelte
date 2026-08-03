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
  // handler that is already pinned by tests. Every decision around it —
  // offerable scopes, why Confirm is unavailable, what the save carries, and how
  // its ack becomes a per-row result — lives in `process-import-state.ts` so it
  // is testable without rendering, and so the plan table and the result table
  // cannot disagree about why a row was skipped.
  //
  // T067 — the accessibility conventions this surface follows, and why. Both
  // tables name themselves and put the Phase id in a row header, because an
  // outcome read on its own ("skip — already present") does not say which Phase
  // it belongs to, and the two tables' column headers are otherwise
  // indistinguishable. Confirm stays genuinely `disabled` rather than
  // `aria-disabled`: a commit in flight must not be re-activatable at all, which
  // is stronger than a handler that declines. That costs the control its focus
  // stop, so its reason is a live region — announced when it changes and while
  // reading the region — and the scope select, which IS focusable, carries the
  // same reason as its description.
  import type { DocumentRefusal, ImportPlan, ImportPlanRow } from '../../lib/messages';
  import { preflightProcessYaml } from '../../lib/process-yaml-ipc';
  import { savePhases } from '../../lib/save-phases';
  import type { SavePhaseRow } from '../../lib/save-phases';
  import type { WritablePhaseDefinitionScope } from '../../lib/snapshot-types';
  import {
    IMPORT_TARGET_SCOPES,
    buildImportSave,
    confirmBlockedReason,
    outcomeLabel,
    projectSaveAck,
    reasonLines,
    refusalHeadline,
    type ImportResultRow
  } from './process-import-state';

  interface Props {
    /**
     * The two writable layers as the catalog currently holds them, projected the
     * same way the Phase manager projects them for a save. The parent owns the
     * projection because it owns the snapshot; this component only appends to it.
     */
    layers?: Readonly<Record<WritablePhaseDefinitionScope, readonly SavePhaseRow[]>>;
    /**
     * T066 — why the surrounding manager cannot start an import right now, or
     * `null` when it can. Stated rather than merely applied (FR-057), and owned by
     * the parent because the conditions are the manager's: workspace trust, a save
     * in flight, an outstanding local edit.
     */
    disabledReason?: string | null;
  }

  const { layers = { user: [], workspace: [] }, disabledReason = null }: Props = $props();

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
  /** No default. An unchosen scope never resolves to the workspace (FR-056). */
  let scope = $state<WritablePhaseDefinitionScope | null>(null);

  const validating = $derived(surface.kind === 'validating');
  const plan = $derived(surface.kind === 'planned' ? surface.plan : null);
  const blockedReason = $derived(
    confirmBlockedReason({
      state: committing ? 'committing' : surface.kind,
      plan,
      scope
    })
  );

  async function onInspect(): Promise<void> {
    // One inspection at a time: a second request would race two acks onto one
    // surface, and the operator has no way to tell which document won.
    if (validating || committing) return;
    // Re-read rather than trust the disabled attribute: the parent's conditions
    // can change between render and click.
    if (disabledReason !== null) return;
    // A new document invalidates the previous plan's result, and the scope
    // choice with it — FR-056 forbids carrying a target the operator picked for
    // some other document.
    results = null;
    scope = null;
    surface = { kind: 'validating' };
    const result = await preflightProcessYaml('phase');
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
    if (blockedReason !== null || plan === null || scope === null) return;
    const request = buildImportSave(plan, scope, layers[scope]);
    if (request === null) return;
    committing = true;
    const ack = await savePhases(request);
    committing = false;
    results = projectSaveAck(plan, ack, scope);
  }

  function onScopeChange(event: Event): void {
    const chosen = (event.currentTarget as HTMLSelectElement).value;
    scope = IMPORT_TARGET_SCOPES.find((candidate) => candidate === chosen) ?? null;
  }

  function rowKey(row: ImportPlanRow, index: number): string {
    return `${index}:${row.outcome}:${row.resourceId ?? ''}`;
  }
</script>

<section
  class="preflight"
  data-testid="process-import-preflight"
  aria-labelledby="process-import-title"
>
  <header class="preflight-header">
    <h3 class="preflight-title" id="process-import-title">Import a Phase document</h3>
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
      <p class="preflight-counts" id="process-import-counts" data-testid="process-import-counts">
        {plan.counts.import} to import, {plan.counts.skip} skipped, {plan.counts.invalid} invalid.
      </p>
      <!-- T067 — named, so the plan and the results are distinguishable, and
           described by the counts so the totals are heard before the rows. -->
      <table
        class="preflight-table"
        data-testid="process-import-plan"
        aria-label="Import plan"
        aria-describedby="process-import-counts"
      >
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Outcome</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {#each plan.rows as row, index (rowKey(row, index))}
            <tr data-testid="process-import-plan-row" data-outcome={row.outcome}>
              <!-- T067 — the row's subject, so the outcome and reason cells are
                   announced against the Phase they describe. -->
              <th scope="row" data-testid="process-import-row-id">
                {#if row.resourceId === null}
                  <span class="preflight-missing-id">no id declared</span>
                {:else}
                  <span class="preflight-id">{row.resourceId}</span>
                {/if}
              </th>
              <td data-testid="process-import-row-outcome">{outcomeLabel(row)}</td>
              <td data-testid="process-import-row-reason">
                {#each reasonLines(row) as line, lineIndex (lineIndex)}
                  <span class="preflight-reason-line">{line}</span>
                {/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if results === null}
        <div class="preflight-commit">
          <!-- FR-034/FR-035/FR-056 — an explicit choice between the two writable
               layers. The placeholder is the initial selection and is not a
               target, so an unchosen scope cannot resolve to the workspace. -->
          <label class="preflight-scope" for="process-import-scope">
            Import into
            <select
              id="process-import-scope"
              data-testid="process-import-scope"
              disabled={committing}
              value={scope ?? ''}
              aria-describedby={blockedReason !== null
                ? 'process-import-confirm-reason'
                : undefined}
              onchange={onScopeChange}
            >
              <option value="">Choose a scope…</option>
              {#each IMPORT_TARGET_SCOPES as candidate (candidate)}
                <option value={candidate}>{candidate}</option>
              {/each}
            </select>
          </label>

          <!-- FR-036/FR-057 — unavailable confirmation always says why, next to
               the control, rather than leaving a dead button. -->
          <button
            type="button"
            class="preflight-button"
            data-testid="process-import-confirm"
            disabled={blockedReason !== null}
            title={blockedReason ?? 'Import this Phase into the chosen scope'}
            aria-describedby={blockedReason !== null
              ? 'process-import-confirm-reason'
              : undefined}
            onclick={onConfirm}
          >Confirm import</button>

          {#if blockedReason !== null}
            <!-- T067 — a live region, because a `disabled` button takes no focus:
                 without this the reason is only available to someone reading the
                 region, and the change from "choose a scope" to available would
                 pass silently. -->
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
      <!-- FR-042 — one result per plan row, so a row the commit never addressed
           still says what happened to it and why. -->
      <table
        class="preflight-table"
        data-testid="process-import-results"
        aria-label="Import results"
      >
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {#each results as result, index (`${index}:${result.resourceId ?? ''}`)}
            <tr data-testid="process-import-result-row" data-outcome={result.outcome}>
              <th scope="row" data-testid="process-import-result-id">
                {#if result.resourceId === null}
                  <span class="preflight-missing-id">no id declared</span>
                {:else}
                  <span class="preflight-id">{result.resourceId}</span>
                {/if}
              </th>
              <td data-testid="process-import-result-outcome">{result.outcome}</td>
              <td data-testid="process-import-result-detail">{result.detail}</td>
            </tr>
          {/each}
        </tbody>
      </table>
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
  .preflight-progress,
  .preflight-note,
  .preflight-counts {
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
  .preflight-table {
    border-collapse: collapse;
    width: 100%;
    text-align: left;
  }
  .preflight-table th,
  .preflight-table td {
    border-bottom: 1px solid var(--schegent-focus-border);
    padding: 2px var(--schegent-pad);
    vertical-align: top;
  }
  /* The row headers added for T067 are structure, not emphasis: the column
     headers stay the only bold row. */
  .preflight-table tbody th {
    font-weight: normal;
  }
  .preflight-id {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .preflight-missing-id {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .preflight-reason-line {
    display: block;
  }
  .preflight-commit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--schegent-pad);
  }
  .preflight-scope {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .preflight-scope select {
    min-height: 24px;
    background: var(--schegent-input-bg);
    color: var(--schegent-input-fg);
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius);
    font: inherit;
  }
  .preflight-scope select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
