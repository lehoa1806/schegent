<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import SystemAuditLog from './SystemAuditLog.svelte';
  import SystemDebugLog from './SystemDebugLog.svelte';
  import TelemetryRuntimeHealthPanel from './TelemetryRuntimeHealthPanel.svelte';
  import './system-shared.css';

  type SystemView = 'debug' | 'audit' | 'telemetry';
  const SYSTEM_VIEWS: readonly SystemView[] = ['debug', 'audit', 'telemetry'];

  let activeView = $state<SystemView>('debug');

  const debugEntries = $derived(snapshotStore.debugLogTail);
  const auditEntries = $derived(snapshotStore.auditTail);

  function activate(view: SystemView, focus = false): void {
    activeView = view;
    if (!focus) return;
    queueMicrotask(() => document.getElementById(`system-tab-${view}`)?.focus());
  }

  function onTabKeydown(event: KeyboardEvent): void {
    const idx = SYSTEM_VIEWS.indexOf(activeView);
    let next: SystemView | null = null;
    if (event.key === 'ArrowRight') {
      next = SYSTEM_VIEWS[(idx + 1) % SYSTEM_VIEWS.length] ?? 'debug';
    } else if (event.key === 'ArrowLeft') {
      next = SYSTEM_VIEWS[(idx - 1 + SYSTEM_VIEWS.length) % SYSTEM_VIEWS.length] ?? 'debug';
    } else if (event.key === 'Home') {
      next = 'debug';
    } else if (event.key === 'End') {
      next = 'telemetry';
    }
    if (next === null) return;
    event.preventDefault();
    activate(next, true);
  }
</script>

<main class="system" aria-label="System logs" data-testid="system-tab">
  <div class="page">
    <div class="phead">
      <div>
        <h1>System Log</h1>
        <div class="purpose">Logs, the audit trail and the health of the runtime.</div>
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="System views">
      <button
        id="system-tab-debug"
        type="button"
        class="tab"
        role="tab"
        aria-selected={activeView === 'debug'}
        aria-controls="system-panel-debug"
        tabindex={activeView === 'debug' ? 0 : -1}
        data-testid="system-view-debug"
        onclick={() => activate('debug')}
        onkeydown={onTabKeydown}
      >Logs</button>
      <button
        id="system-tab-audit"
        type="button"
        class="tab"
        role="tab"
        aria-selected={activeView === 'audit'}
        aria-controls="system-panel-audit"
        tabindex={activeView === 'audit' ? 0 : -1}
        data-testid="system-view-audit"
        onclick={() => activate('audit')}
        onkeydown={onTabKeydown}
      >Audit events</button>
      <button
        id="system-tab-telemetry"
        type="button"
        class="tab"
        role="tab"
        aria-selected={activeView === 'telemetry'}
        aria-controls="system-panel-telemetry"
        tabindex={activeView === 'telemetry' ? 0 : -1}
        data-testid="system-view-telemetry"
        onclick={() => activate('telemetry')}
        onkeydown={onTabKeydown}
      >Runtime</button>
    </div>

    {#if activeView === 'debug'}
      <div
        id="system-panel-debug"
        role="tabpanel"
        aria-labelledby="system-tab-debug"
        data-testid="system-panel-debug"
      >
        <SystemDebugLog entries={debugEntries} />
      </div>
    {:else if activeView === 'audit'}
      <div
        id="system-panel-audit"
        role="tabpanel"
        aria-labelledby="system-tab-audit"
        data-testid="system-panel-audit"
      >
        <SystemAuditLog entries={auditEntries} />
      </div>
    {:else}
      <div
        id="system-panel-telemetry"
        role="tabpanel"
        aria-labelledby="system-tab-telemetry"
        data-testid="system-panel-telemetry"
      >
        <TelemetryRuntimeHealthPanel />
      </div>
    {/if}
  </div>
</main>

<style>
  .system {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .tabs {
    align-items: center;
  }

  .tab:hover {
    color: var(--schegent-fg);
  }
</style>
