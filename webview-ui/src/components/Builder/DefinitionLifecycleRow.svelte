<script lang="ts">
  // Feature 101 (US1, T036, FR-013) — the lifecycle chrome of one definition row.
  //
  // Feature 186 (US1, T003, D-1) — slimmed to badges only. Everything else this
  // row used to own — the cells, the changed-field summary, the defect list, the
  // four actions, and History — moved to `DefinitionLifecyclePanel.svelte`, which
  // mounts on the surface that shows the *open* definition rather than on every
  // row in a list. What is left here is what every row still needs regardless of
  // whether it is open: the state badge and the validity badge.
  //
  // Both badges are the status chip every surface shares (sg-core's `.chip`): a
  // dot or an icon beside the word, so colour is never the only signal.
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import {
    deriveDefinitionRowView,
    STATE_TONE_CLASSES,
    type DefinitionValidity
  } from './definition-row-state';

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
  {#if lifecycle && view}
    <span
      class="chip state-badge {STATE_TONE_CLASSES[lifecycle.state]}"
      data-testid="definition-row-state-{definitionId}"
      ><span class="dot" aria-hidden="true"></span>{view.stateBadge}</span
    >
  {/if}
  <!-- Feature 099 (T494a, FR-043) — no scope badge; one layer leaves it one
       value to read, which is not a badge. Validity is the badge that stayed,
       and FR-015 keeps it reading exactly as it did: the lowercase word, which
       is why no style capitalises it the way the state chip's word is. -->
  <span
    class="chip status-{validity} {validity === 'invalid' ? 's-err' : 's-idle'}"
    data-testid="definition-row-validity-{definitionId}"
    ><svg class="i" aria-hidden="true"><use href={validity === 'invalid' ? '#i-warn' : '#i-check'}></use></svg>{validity}</span
  >
</div>

<style>
  .definition-lifecycle-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-space-1);
  }
</style>
