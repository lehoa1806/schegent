<script lang="ts">
  // Feature 085 T070 — the results table, split out of ProcessImportPreflight.
  //
  // The counterpart to the plan table: what the commit DID, rather than what a
  // commit would do. It is a separate component because it answers a separate
  // question and appears at a separate time, not merely because the two are
  // both tables — the surface renders the plan long before this exists, and the
  // two must not be able to drift into rendering each other's rows.
  //
  // The whole-commit outcome sits above the rows because `partial` is not
  // readable off a list of rows without counting them. No compensating action
  // is offered here, because there is none to offer: what landed stays landed
  // (FR-042b/c), and the sentence — composed in `process-import-state.ts`, not
  // in this markup — is what says so.
  //
  // Feature 086 T055 — with a third layer, `partial` has two shapes: a refused
  // Pipeline write after a Phase write, and a refused Workflow write after both
  // (FR-051). "Part of this document" no longer tells the operator where to
  // look, so the sentence names the layers that landed — and it names them from
  // the layer ACKS, which is why this component now takes them. It still
  // composes nothing: the naming lives in `commitOutcomeStatement`, so the
  // markup cannot come to disagree with what the commit actually sent.
  //
  // Rendering discipline (FR-050, FR-062) is inherited unchanged: the detail
  // column can carry host-sanitized, document-derived text, and is rendered by
  // text interpolation only.
  //
  // Feature 099 (T494a, FR-043) — `committedScope` is gone. It held the scope the
  // completed commit wrote to so the summary could not drift from it; with one
  // catalog there is nothing for the summary to drift against, and the layer
  // names the sentence still carries are KINDS (Phases, Pipelines, Workflows),
  // not tiers.
  import {
    commitOutcomeStatement,
    modelCatalogCommitOutcomeStatement,
    type ImportCommitOutcome,
    type ImportLayerResult,
    type ImportResultRow,
    type ModelCatalogCommitOutcome
  } from './process-import-state';

  interface Props {
    /** One result per plan row (FR-042), including rows the commit never reached. */
    results: readonly ImportResultRow[];
    /**
     * The acks the commit actually collected, in the order it sent them. Passed
     * through untouched — the outcome sentence reads them to name which layers
     * landed, and a layer the sequence never reached has no entry here at all.
     * Always empty for a Model Catalog commit — it is one write, not layers.
     */
    layerResults: readonly ImportLayerResult[];
    /** Set with `results`, and only with them. Never inferred from the rows. */
    outcome: ImportCommitOutcome | null;
    /**
     * Feature 096 T024 — set instead of (never alongside, in practice)
     * `outcome` when the result set came from a Model Catalog commit, which is
     * one write and so has no layers to name. A separate field rather than a
     * fourth arm of `ImportCommitOutcome`: `partial` is unreachable for a single
     * write, and the Model Catalog is not in the store at all (FR-056).
     */
    modelCatalogOutcome?: ModelCatalogCommitOutcome | null;
  }

  const { results, layerResults, outcome, modelCatalogOutcome = null }: Props = $props();
</script>

{#if modelCatalogOutcome !== null}
  <!-- FR-042a for Model Catalog: same announcement discipline as the layered
       outcome below, with no layer to name. -->
  <p
    class="preflight-note"
    data-testid="process-import-outcome"
    data-outcome={modelCatalogOutcome}
    role="status"
    aria-live="polite"
  >
    {modelCatalogCommitOutcomeStatement(modelCatalogOutcome)}
  </p>
{:else if outcome !== null}
  <!-- FR-042a — the whole-commit outcome, above the per-row table. It is
       announced: an operator who clicked Confirm and got a partial write needs
       to hear that before they read anything else. -->
  <p
    class="preflight-note"
    data-testid="process-import-outcome"
    data-outcome={outcome}
    role="status"
    aria-live="polite"
  >
    {commitOutcomeStatement(outcome, layerResults)}
  </p>
{/if}
<!-- FR-042 — one result per plan row, so a row the commit never addressed still
     says what happened to it and why. -->
<table class="preflight-table" data-testid="process-import-results" aria-label="Import results">
  <thead>
    <tr>
      <th scope="col">Resource</th>
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
