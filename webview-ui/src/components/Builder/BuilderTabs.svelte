<script lang="ts">
  // Feature 101 (T004, Phase 1) — the Builder's tab strip, moved off
  // `PipelineBuilder.svelte`. Pure extraction: the same markup, the same ids,
  // the same roving-tabindex keyboard contract.
  //
  // The strip owns `activateTab` because it owns the ids the focus call names.
  // The shell owns `activeTab` — it is what the panel below the strip switches
  // on — so the strip reads it as a prop and reports a change back rather than
  // holding a second copy.
  import type { BuilderTab } from '../PipelineBuilderEditors/types';
  interface Props {
    activeTab: BuilderTab;
    onactivate: (tab: BuilderTab) => void;
  }
  const { activeTab, onactivate }: Props = $props();
  const BUILDER_TABS = Object.freeze([
    { id: 'pipelines', label: 'Pipelines' },
    { id: 'phases', label: 'Phases' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'models', label: 'Models' }
  ] satisfies ReadonlyArray<{ id: BuilderTab; label: string }>);
  function activateTab(tab: BuilderTab, focus = false): void {
    onactivate(tab);
    if (!focus) return;
    queueMicrotask(() => document.getElementById(`builder-tab-${tab}`)?.focus());
  }
  function onBuilderTabKeydown(event: KeyboardEvent): void {
    const current = BUILDER_TABS.findIndex((tab) => tab.id === activeTab);
    let next = current;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + BUILDER_TABS.length) % BUILDER_TABS.length;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1) % BUILDER_TABS.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = BUILDER_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    activateTab(BUILDER_TABS[next].id, true);
  }
</script>
<!-- The accessible name is the strip's label, so FR-002 reaches it. This one
     carried the retired surface name through the Phase 1 extraction — the old
     term surviving in the one place a sighted reader never looks.
     `tests/lint/no-legacy-surface-name.test.ts` is why it cannot come back, and
     why this comment does not spell it out. -->
<div class="builder-tabs" role="tablist" aria-label="Builder catalogs">
  {#each BUILDER_TABS as tab (tab.id)}
    <button
      id="builder-tab-{tab.id}"
      type="button"
      class="tab-btn {activeTab === tab.id ? 'active' : ''}"
      role="tab"
      aria-selected={activeTab === tab.id}
      aria-controls="builder-panel-{tab.id}"
      tabindex={activeTab === tab.id ? 0 : -1}
      onclick={() => activateTab(tab.id)}
      onkeydown={onBuilderTabKeydown}
    >{tab.label}</button>
  {/each}
</div>
