<script lang="ts">
  import StatusBar from './components/StatusBar.svelte';
  import StatsStrip from './components/StatsStrip.svelte';
  import CurrentTask from './components/CurrentTask.svelte';
  import DashboardLink from './components/DashboardLink.svelte';
  import { snapshotStore } from './lib/snapshot-store.svelte';

  const ready = $derived(snapshotStore.isReady);
</script>

<main class="root" data-testid="app-root">
  <header class="sidebar-brand" aria-label="Schegent">
    <span class="brand-mark" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <path d="m12 3 8 4-8 4-8-4 8-4Z"></path>
        <path d="m4 11 8 4 8-4"></path>
        <path d="m4 15 8 4 8-4"></path>
      </svg>
    </span>
    <span class="brand-name">Schegent</span>
    <span class="connection-state" class:connected={ready}>{ready ? 'Connected' : 'Connecting'}</span>
  </header>
  {#if ready}
    <StatusBar />
    <StatsStrip />
    <CurrentTask />
    <div class="dashboard-link-wrap">
      <DashboardLink />
    </div>
  {:else}
    <div class="empty" data-testid="empty-state" role="status">
      <strong>Connecting</strong>
      <span>Waiting for workspace state.</span>
    </div>
    <div class="dashboard-link-wrap">
      <DashboardLink />
    </div>
  {/if}
</main>

<style>
  .root {
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    min-width: 0;
    color: var(--schegent-fg);
    background: var(--schegent-shell-bg);
  }
  .sidebar-brand {
    display: flex;
    min-height: 42px;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid var(--schegent-border);
    background: var(--schegent-shell-bg);
  }
  .brand-mark {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
  }
  .brand-name {
    min-width: 0;
    color: var(--schegent-fg);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .connection-state {
    margin-left: auto;
    color: var(--schegent-muted-fg);
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .connection-state.connected {
    color: var(--schegent-color-completed);
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--schegent-pad);
    color: var(--schegent-muted-fg);
  }
  .empty strong {
    color: var(--schegent-fg);
    font-size: 0.9rem;
  }
  .dashboard-link-wrap {
    margin-top: auto;
    padding: 12px;
    border-top: 1px solid var(--schegent-divider);
    background: var(--schegent-shell-bg);
  }
</style>
