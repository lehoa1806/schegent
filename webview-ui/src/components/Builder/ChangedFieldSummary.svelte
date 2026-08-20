<script lang="ts">
  // Feature 101 (US5, T060, FR-008 – FR-011, FR-026) — what publishing would change.
  //
  // It renders; it does not compute (FR-011). The host projects the summary
  // eagerly, and the difference matters at exactly one arm: `no-prior-version`.
  // A component that diffed locally has nothing to diff against on a first
  // publish, so it would render every field of the draft as an addition (FR-009)
  // — a forty-line "review this" beside a publish where there is nothing to
  // review. What is done here is grouping and joining, which is presentation.
  //
  // It is not a gate (FR-026). No button, no dismissal, nothing to close: the
  // operator reads it or does not, and Publish stays one click either way.
  //
  // Text interpolation only, never Svelte's raw-HTML directive (FR-038): field
  // names and collection entry ids come from operator-authored documents.
  import type { ChangedField, ChangedFieldSummary } from '../../lib/snapshot-types';

  interface Props {
    /** The row's handle, so a tab full of rows has one summary per definition. */
    definitionId: string;
    summary: ChangedFieldSummary;
  }

  const { definitionId, summary }: Props = $props();

  interface Bucket {
    readonly label: string;
    readonly items: readonly string[];
  }

  interface FieldView {
    readonly field: string;
    /** Set when there is nothing to enumerate — a scalar, or an in-place edit. */
    readonly note: string | null;
    readonly buckets: readonly Bucket[];
  }

  const BUCKET_LABELS = Object.freeze([
    ['added', 'Added'],
    ['removed', 'Removed'],
    ['reordered', 'Reordered']
  ] as const);

  function viewOf(field: ChangedField): FieldView {
    if (field.change === 'differs') {
      return { field: field.field, note: 'differs', buckets: [] };
    }
    // An empty bucket is not information. "0 removed" beside "1 added" reads as
    // a measurement, and the operator then wonders what was measured.
    const buckets = BUCKET_LABELS.map(([key, label]) => ({ label, items: field[key] })).filter(
      (bucket) => bucket.items.length > 0
    );
    return {
      field: field.field,
      // All three empty means an entry was edited rather than moved. Saying so
      // is the point: naming a field and then saying nothing about it is worse
      // than not naming it.
      note: buckets.length === 0 ? 'entries changed in place' : null,
      buckets
    };
  }

  const fields = $derived<readonly FieldView[]>(
    summary.kind === 'changed' ? summary.fields.map(viewOf) : []
  );
</script>

<div class="changed-field-summary" data-testid="changed-field-summary-{definitionId}">
  {#if summary.kind === 'changed'}
    {#if fields.length === 0}
      <!-- `changed` with no fields is a real projection, not a host bug:
           `compareForPublish` returns it when neither body is an object and the
           two differ, which the store permits because it never validates a body
           (099 FR-010). Rendering nothing would leave a row reading "Active with
           draft" beside a blank panel — the same indistinguishable blank FR-012b
           refuses on the history panel. The honest report is that it differs. -->
      <p class="summary-headline">
        Publishing would change this definition. No field-level account is available for it.
      </p>
    {:else}
      <p class="summary-headline">Publishing would change:</p>
      <ul class="summary-fields">
        {#each fields as view, index (view.field + index)}
          <li
            class="summary-field"
            data-testid="changed-field-{definitionId}-{view.field}"
            data-field={view.field}
          >
            <span class="field-name">{view.field}</span>
            {#if view.note !== null}
              <span class="field-note">{view.note}</span>
            {/if}
            {#if view.buckets.length > 0}
              <ul class="field-buckets">
                {#each view.buckets as bucket (bucket.label)}
                  <li data-testid="changed-field-{bucket.label.toLowerCase()}-{definitionId}-{view.field}">
                    <span class="bucket-label">{bucket.label}</span>: {bucket.items.join(', ')}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if summary.kind === 'no-prior-version'}
    <p class="summary-headline">
      This would be the first published version. There is nothing to compare it against.
    </p>
  {:else}
    <p class="summary-headline">No changes. This draft matches the active version.</p>
  {/if}
</div>

<style>
  .changed-field-summary {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  .summary-headline {
    margin: 0;
  }

  .summary-fields {
    margin: 2px 0 0;
    padding-left: 18px;
  }

  .summary-field {
    color: var(--vscode-foreground);
  }

  .field-name {
    font-weight: 600;
  }

  .field-note {
    color: var(--vscode-descriptionForeground);
  }

  .field-buckets {
    margin: 0;
    padding-left: 14px;
  }

  .bucket-label {
    color: var(--vscode-descriptionForeground);
  }
</style>
