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
      <span class="loading-rule" aria-hidden="true"></span>
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
    border-top: 2px solid var(--schegent-color-active);
  }
  .sidebar-brand {
    display: flex;
    min-height: 40px;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-bottom: 1px solid var(--schegent-border);
    background: var(--schegent-shell-bg);
  }
  .brand-mark {
    display: inline-flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--schegent-color-active);
  }
  .brand-name {
    min-width: 0;
    color: var(--schegent-fg);
    font-size: 0.76rem;
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
  .connection-state::before {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 5px;
    border-radius: 50%;
    background: currentColor;
    content: '';
  }
  .connection-state.connected {
    color: var(--schegent-color-completed);
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--schegent-space-4) var(--schegent-space-3);
    color: var(--schegent-muted-fg);
  }
  .empty strong {
    color: var(--schegent-fg);
    font-size: 0.9rem;
  }
  .loading-rule {
    display: block;
    width: 72%;
    height: 2px;
    margin-top: var(--schegent-space-2);
    overflow: hidden;
    background: var(--schegent-divider);
  }
  .loading-rule::after {
    display: block;
    width: 32%;
    height: 100%;
    background: var(--schegent-color-active);
    animation: loadingSweep 1.2s var(--schegent-ease-out) infinite alternate;
    content: '';
  }
  @keyframes loadingSweep {
    to { transform: translateX(210%); }
  }
  .dashboard-link-wrap {
    margin-top: auto;
    padding: 10px;
    border-top: 1px solid var(--schegent-divider);
    background: var(--schegent-shell-bg);
  }
</style>
