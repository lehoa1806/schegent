<script lang="ts">
  // Feature 101 (US1, T036, FR-013) — the lifecycle chrome of one definition row.
  //
  // Feature 186 (US1, T003, D-1) — slimmed to badges only. Everything else this
  // row used to own — the cells, the changed-field summary, the defect list, the
  // four actions, and History — moved to `DefinitionLifecyclePanel.svelte`, which
  // mounts on the surface that shows the *open* definition rather than on every
  // row in a list. What is left here is what every row still needs regardless of
  // whether it is open: the state badge and the validity badge.
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import { deriveDefinitionRowView, type DefinitionValidity } from './definition-row-state';

  interface Props {
    /** The definition's own id — the row's test handle. */
    definitionId: string;
    /** Absent on a host with no catalog store wired; the state badge goes with it. */
    lifecycle?: BuilderLifecycle;
    validity: DefinitionValidity;
  }

  const { definitionId, lifecycle, validity }: Props = $props();

  const view = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);
</script>

<div class="definition-lifecycle-row" data-testid="definition-row-{definitionId}">
  <div class="row-badges">
    {#if lifecycle && view}
      <span
        class="status-badge state-badge state-{lifecycle.state}"
        data-testid="definition-row-state-{definitionId}">{view.stateBadge}</span
      >
    {/if}
    <!-- Feature 099 (T494a, FR-043) — no scope badge; one layer leaves it one
         value to read, which is not a badge. Validity is the badge that stayed,
         and FR-015 keeps it reading exactly as it did. -->
    <span
      class="status-badge status-{validity}"
      data-testid="definition-row-validity-{definitionId}">{validity}</span
    >
  </div>
</div>

<style>
  .definition-lifecycle-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 8px 6px;
  }

  .row-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
