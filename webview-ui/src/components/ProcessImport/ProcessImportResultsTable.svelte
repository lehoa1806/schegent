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
  // Rendering discipline (FR-050, FR-062) is inherited unchanged: the detail
  // column can carry host-sanitized, document-derived text, and is rendered by
  // text interpolation only.
  import type { WritablePhaseDefinitionScope } from '../../lib/snapshot-types';
  import {
    commitOutcomeStatement,
    type ImportCommitOutcome,
    type ImportResultRow
  } from './process-import-state';

  interface Props {
    /** One result per plan row (FR-042), including rows the commit never reached. */
    results: readonly ImportResultRow[];
    /** Set with `results`, and only with them. Never inferred from the rows. */
    outcome: ImportCommitOutcome | null;
    /** The scope the completed commit wrote to, so the summary cannot drift. */
    committedScope: WritablePhaseDefinitionScope | null;
  }

  const { results, outcome, committedScope }: Props = $props();
</script>

{#if outcome !== null && committedScope !== null}
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
    {commitOutcomeStatement(outcome, committedScope)}
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
