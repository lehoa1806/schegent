<script lang="ts" module>
  export const RUN_TABS = ['log', 'outputs', 'context'] as const;
  export type RunTab = (typeof RUN_TABS)[number];
</script>

<script lang="ts">
  // The Run Detail tier's tab bar, extracted from `RunDetailTier.svelte` (Feature
  // 265 BUG-001) to keep that tier under its line budget. Behaviour unchanged.
  //
  // FR-R4-F08 (K1 to K3) — the tabs follow the roving contract the Builder, System and
  // Settings tab bars use: one tab is in the Tab order, the arrow keys, Home and End move
  // between the three, and every tab names the one panel it controls. The handler sits on each
  // tab, as in those bars, and indexes this list, so the streaming badge is never a stop.

  interface Props {
    activeTab: RunTab;
    /** True while this Run is the one executing; shows the streaming badge. */
    isExecuting: boolean;
  }

  let { activeTab = $bindable(), isExecuting }: Props = $props();

  function onTabKeydown(event: KeyboardEvent): void {
    const current = RUN_TABS.indexOf(activeTab);
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % RUN_TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + RUN_TABS.length) % RUN_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = RUN_TABS.length - 1;
    else return;
    const name = RUN_TABS.at(next);
    if (name === undefined) return;
    event.preventDefault();
    activeTab = name;
    queueMicrotask(() => document.getElementById(`run-tab-${name}`)?.focus());
  }
</script>

<!-- Drawn as the redesign's tabs (`.tabs` and `.tab` in `sg-pages.css`), which mark the selected
     tab by `aria-selected`. The labels stay the product's own, the names the docs use, without the
     glyphs that led them. The streaming badge is a status chip at the bar's end, worded as the
     redesign words its chips. -->
<div class="tabs" role="tablist" aria-label="Run detail views">
  <button
    type="button"
    role="tab"
    id="run-tab-log"
    class="tab"
    aria-selected={activeTab === 'log'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'log' ? 0 : -1}
    data-testid="run-tab-log"
    onkeydown={onTabKeydown}
    onclick={() => activeTab = 'log'}
  >Phase log</button>
  <button
    type="button"
    role="tab"
    id="run-tab-outputs"
    class="tab"
    aria-selected={activeTab === 'outputs'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'outputs' ? 0 : -1}
    data-testid="run-tab-outputs"
    onkeydown={onTabKeydown}
    onclick={() => activeTab = 'outputs'}
  >Run outputs</button>
  <button
    type="button"
    role="tab"
    id="run-tab-context"
    class="tab"
    aria-selected={activeTab === 'context'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'context' ? 0 : -1}
    data-testid="run-tab-context"
    onkeydown={onTabKeydown}
    onclick={() => activeTab = 'context'}
  >Context</button>

  {#if isExecuting}
    <span class="chip s-run push" data-testid="run-streaming-badge"><span class="dot" aria-hidden="true"></span>Streaming</span>
  {/if}
</div>

<style>
  /* The bar keeps its height while the panel under it scrolls. */
  .tabs { flex-shrink: 0; align-items: center; }
  .tab:hover { color: var(--schegent-fg); }
</style>
