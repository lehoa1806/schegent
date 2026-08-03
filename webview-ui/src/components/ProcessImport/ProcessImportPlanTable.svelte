<script lang="ts">
  // Feature 085 T070 — the plan table, split out of ProcessImportPreflight.
  //
  // This is a presentational split, not a behavioral one: it renders what a
  // confirm WOULD do and decides nothing. Every judgment it displays — the
  // outcome label, the kind label, the reason lines — is read from
  // `process-import-state.ts`, so the plan table and the results table still
  // cannot disagree about why a row was skipped.
  //
  // Rendering discipline (FR-050, FR-062) is inherited unchanged and matters
  // more here than anywhere else on the surface, because the reason cell is
  // where document-derived text is most obviously operator-facing: the resource
  // id, the name, and the defect messages were sanitized and length-bounded by
  // the host before crossing the boundary, and this component treats them as
  // untrusted content it does not interpret — text interpolation only, no
  // `{@html}`, no parsing, and nothing document-derived placed in an attribute
  // a browser would resolve. `tests/integration/process-yaml/package-hygiene.ts`
  // scans this file for exactly that.
  import type { ImportPlan, ImportPlanRow } from '../../lib/messages';
  import { outcomeLabel, reasonLines, resourceKindLabel } from './process-import-state';

  interface Props {
    /** The whole plan: the counts are rendered as the table's description. */
    plan: ImportPlan;
  }

  const { plan }: Props = $props();

  function rowKey(row: ImportPlanRow, index: number): string {
    return `${index}:${row.outcome}:${row.resourceId ?? ''}`;
  }
</script>

<!-- Every count the plan carries, so the four sum to the row count as FR-028
     requires. Omitting one would show totals that do not add up on any document
     that reaches it — and `blocked` first becomes reachable with the package
     resolver. -->
<p class="preflight-counts" id="process-import-counts" data-testid="process-import-counts">
  {plan.counts.import} to import, {plan.counts.skip} skipped, {plan.counts.blocked} blocked,
  {plan.counts.invalid} invalid.
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
      <th scope="col">Resource</th>
      <th scope="col">Kind</th>
      <th scope="col">Outcome</th>
      <th scope="col">Reason</th>
    </tr>
  </thead>
  <tbody>
    {#each plan.rows as row, index (rowKey(row, index))}
      <tr
        data-testid="process-import-plan-row"
        data-outcome={row.outcome}
        data-kind={row.resourceKind}
      >
        <!-- T067 — the row's subject, so the kind, outcome, and reason cells are
             announced against the resource they describe. -->
        <th scope="row" data-testid="process-import-row-id">
          {#if row.resourceId === null}
            <span class="preflight-missing-id">no id declared</span>
          {:else}
            <span class="preflight-id">{row.resourceId}</span>
          {/if}
        </th>
        <!-- FR-056 — the kind is the row's, not the document's: one package
             declares both. -->
        <td data-testid="process-import-row-kind">{resourceKindLabel(row)}</td>
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
