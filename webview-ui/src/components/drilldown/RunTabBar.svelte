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
  // between the three, and every tab names the one panel it controls. The handler indexes
  // this list, so the streaming badge after the tabs is never a stop.

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

<div class="tab-bar" role="tablist" onkeydown={onTabKeydown}>
  <button
    type="button"
    role="tab"
    id="run-tab-log"
    class="tab-btn"
    class:active={activeTab === 'log'}
    aria-selected={activeTab === 'log'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'log' ? 0 : -1}
    data-testid="run-tab-log"
    onclick={() => activeTab = 'log'}
  >&Sigma; Phase log</button>
  <button
    type="button"
    role="tab"
    id="run-tab-outputs"
    class="tab-btn"
    class:active={activeTab === 'outputs'}
    aria-selected={activeTab === 'outputs'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'outputs' ? 0 : -1}
    data-testid="run-tab-outputs"
    onclick={() => activeTab = 'outputs'}
  >&#128196; Run outputs</button>
  <button
    type="button"
    role="tab"
    id="run-tab-context"
    class="tab-btn"
    class:active={activeTab === 'context'}
    aria-selected={activeTab === 'context'}
    aria-controls="run-detail-panel"
    tabindex={activeTab === 'context' ? 0 : -1}
    data-testid="run-tab-context"
    onclick={() => activeTab = 'context'}
  >&#128196; Context</button>

  {#if isExecuting}
    <span class="streaming-badge" data-testid="run-streaming-badge">
      <span class="streaming-dot"></span>
      STREAMING
    </span>
  {/if}
</div>

<style>
  .tab-bar { display: flex; align-items: center; gap: 0; border-bottom: 1px solid var(--schegent-divider, color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent)); padding-left: 14px; flex-shrink: 0; }
  .tab-btn { font: inherit; font-size: 12px; padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; white-space: nowrap; }
  .tab-btn:hover { color: var(--vscode-editor-foreground); }
  .tab-btn.active { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-focusBorder); }

  .streaming-badge { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--schegent-color-active); padding-right: 8px; }
  .streaming-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--schegent-color-active); animation: pulse-stream 1.8s ease-in-out infinite; }
  @keyframes pulse-stream {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.3); }
  }
</style>
