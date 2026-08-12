<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import SystemAuditLog from './SystemAuditLog.svelte';
  import SystemDebugLog from './SystemDebugLog.svelte';

  type SystemView = 'debug' | 'audit';

  let activeView = $state<SystemView>('debug');

  const debugEntries = $derived(snapshotStore.debugLogTail);
  const auditEntries = $derived(snapshotStore.auditTail);

  function activate(view: SystemView, focus = false): void {
    activeView = view;
    if (!focus) return;
    queueMicrotask(() => document.getElementById(`system-tab-${view}`)?.focus());
  }

  function onTabKeydown(event: KeyboardEvent): void {
    let next: SystemView | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = activeView === 'debug' ? 'audit' : 'debug';
    } else if (event.key === 'Home') {
      next = 'debug';
    } else if (event.key === 'End') {
      next = 'audit';
    }
    if (next === null) return;
    event.preventDefault();
    activate(next, true);
  }
</script>

<main class="system-shell" aria-label="System logs" data-testid="system-tab">
  <header class="system-header">
    <h1>System Log</h1>
    <p>Inspect runtime diagnostics and the append-only audit trail.</p>
  </header>
  <div class="system-tabs" role="tablist" aria-label="System log views">
    <button
      id="system-tab-debug"
      type="button"
      class:active={activeView === 'debug'}
      role="tab"
      aria-selected={activeView === 'debug'}
      aria-controls="system-panel-debug"
      tabindex={activeView === 'debug' ? 0 : -1}
      data-testid="system-view-debug"
      onclick={() => activate('debug')}
      onkeydown={onTabKeydown}
    >Debug log</button>
    <button
      id="system-tab-audit"
      type="button"
      class:active={activeView === 'audit'}
      role="tab"
      aria-selected={activeView === 'audit'}
      aria-controls="system-panel-audit"
      tabindex={activeView === 'audit' ? 0 : -1}
      data-testid="system-view-audit"
      onclick={() => activate('audit')}
      onkeydown={onTabKeydown}
    >Audit events</button>
  </div>

  {#if activeView === 'debug'}
    <div
      id="system-panel-debug"
      class="system-panel"
      role="tabpanel"
      aria-labelledby="system-tab-debug"
      data-testid="system-panel-debug"
    >
      <SystemDebugLog entries={debugEntries} />
    </div>
  {:else}
    <div
      id="system-panel-audit"
      class="system-panel"
      role="tabpanel"
      aria-labelledby="system-tab-audit"
      data-testid="system-panel-audit"
    >
      <SystemAuditLog entries={auditEntries} />
    </div>
  {/if}
</main>

<style>
  .system-shell {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    padding: 20px 24px 24px;
  }

  .system-header {
    flex: 0 0 auto;
    margin-bottom: 18px;
  }

  .system-header h1 {
    margin: 0;
    font-size: 1.55rem;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .system-header p {
    margin: 5px 0 0;
    color: var(--schegent-muted-fg);
    font-size: 0.84rem;
  }

  .system-tabs {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--schegent-divider);
  }

  .system-tabs button {
    padding: 7px var(--schegent-pad);
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--schegent-muted-fg);
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 600;
    transition: color 150ms ease-out, border-color 150ms ease-out;
  }

  .system-tabs button:hover {
    color: var(--schegent-fg);
  }

  .system-tabs button.active {
    border-bottom-color: var(--schegent-color-active);
    color: var(--schegent-fg);
  }

  .system-panel {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--schegent-border);
    border-top: 0;
    border-radius: 0 0 var(--schegent-radius) var(--schegent-radius);
    background: var(--schegent-surface);
  }

  @media (max-width: 780px) {
    .system-shell {
      padding: 16px;
    }
  }
</style>
