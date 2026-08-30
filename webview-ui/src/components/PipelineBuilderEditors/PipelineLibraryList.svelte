<script lang="ts">
  // Feature 184 (FR-R3-141, T015) — the Pipeline Library list, moved into the top
  // bar's picker.
  //
  // Lifted verbatim from `PipelineCatalogEditor.svelte:276-295`. The row carries
  // name and id and nothing else, exactly as it did there.
  //
  // That non-enrichment is a decision, not an oversight (C7-1). The Workflow
  // counterpart's row summarises purpose, node sequence, derived ports and a node
  // count, and the temptation on adopting its shell is to match it. But a richer
  // row is a claim about what an operator needs to tell two definitions apart,
  // and this feature is a relocation of the Pipeline surface — inventing a new
  // Pipeline row summary inside it would be a product change smuggled in as a
  // port, with no requirement behind it and no test that could have asked for it.
  //
  // `DefinitionLifecycleRow` stays OUTSIDE the selection button, as it already
  // was: a control nested in a button is invalid markup and unreachable by
  // keyboard. The Workflow picker already carries it in the same position, so the
  // popover is a proven parent for it.
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import type { MutablePipeline } from './types';

  interface Props {
    rows: readonly MutablePipeline[];
    selectedIndex: number | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    onselect: (index: number) => void;
  }

  const { rows, selectedIndex, lifecycleByKey, onselect }: Props = $props();
</script>

<div class="phase-list">
  {#each rows as pipeline, index (pipeline.sourceKey)}
    <div class="phase-list-row">
      <div class="phase-list-main">
        <button
          class="phase-list-item {selectedIndex === index ? 'selected' : ''}"
          data-testid="pipelines-list-item-{pipeline.id}"
          aria-current={selectedIndex === index ? 'true' : undefined}
          onclick={() => onselect(index)}
        >
          <div class="phase-list-title">{pipeline.name || 'Untitled Pipeline'}</div>
          <div class="phase-list-id">{pipeline.id}</div>
        </button>
      </div>
      <!-- Feature 101 (US1, T037) — the state, timestamps, active version, and
           the validity badge. Outside the button above, because T042 hangs the
           lifecycle actions off this row. -->
      <DefinitionLifecycleRow
        kind="pipeline"
        definitionId={pipeline.id}
        definitionName={pipeline.name || 'Untitled Pipeline'}
        lifecycle={lifecycleByKey.get(pipeline.sourceKey)}
        validity={pipeline.sourceStatus}
        defects={pipeline.sourceErrors}
      />
    </div>
  {/each}
  {#if rows.length === 0}
    <div class="catalog-state" data-testid="pipelines-empty">
      No Pipelines yet. Add one to compose Phases into a sequence.
    </div>
  {/if}
</div>
