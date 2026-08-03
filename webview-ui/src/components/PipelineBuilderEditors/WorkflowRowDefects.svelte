<script lang="ts">
  // Feature 083 (US5, T056, FR-044) — the defect block a node or connection row
  // points its `aria-describedby` at.
  //
  // One component rather than a snippet in each editor so the two rows cannot
  // drift: the requirement is that the association is carried by a text cue in
  // addition to color, and a cue that exists on node rows but not connection
  // rows would satisfy no one. The word "Error" is the cue — a red border alone
  // reaches neither a screen-reader user nor a monochrome display.
  import type { WorkflowDraftError } from './workflow-catalog-state';

  interface Props {
    /** The row's own id, so the row can name this block as its description. */
    id: string;
    defects: readonly WorkflowDraftError[];
  }

  const { id, defects }: Props = $props();
</script>

{#if defects.length > 0}
  <div class="row-defects" {id}>
    <span class="row-defect-cue">Error</span>
    <ul class="row-defect-list">
      {#each defects as defect (defect.field + defect.code)}
        <li>{defect.field}: {defect.message}</li>
      {/each}
    </ul>
  </div>
{/if}
