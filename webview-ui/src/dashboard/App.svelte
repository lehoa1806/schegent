<script lang="ts">
  import MetricsDashboard from '../components/MetricsDashboard/MetricsDashboard.svelte';
  import Dashboard from '../components/Dashboard.svelte';
  import PipelineBuilder from '../components/PipelineBuilder.svelte';
  import SystemTab from '../components/SystemTab.svelte';
  import SettingsSurface from '../components/SettingsSurface.svelte';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import {
    DASHBOARD_ROUTES,
    DASHBOARD_ROUTE_LABELS,
    DEFAULT_DASHBOARD_ROUTE,
    type DashboardRoute
  } from './routes';

  const ready = $derived(snapshotStore.isReady);
  const snapshot = $derived(snapshotStore.snapshot);

  // Feature 012 — flat three-route top-level nav. Replaces the legacy
  // `'operations' | 'settings'` shape; the inner two-tier `Operations |
  // Pipeline Builder` pair under `Dashboard.svelte` is gone (T033).
  let route = $state<DashboardRoute>(DEFAULT_DASHBOARD_ROUTE);
</script>

<main class="dashboard-root" data-testid="dashboard-app-root">
  {#if ready && snapshot}
    <nav class="dashboard-nav" aria-label="Primary">
      {#each DASHBOARD_ROUTES as r (r)}
        <button
          type="button"
          class="nav-btn {route === r ? 'active' : ''}"
          data-testid="dashboard-route-{r}"
          onclick={() => (route = r)}
        >{DASHBOARD_ROUTE_LABELS[r]}</button>
      {/each}
    </nav>
    <div class="dashboard-route" data-testid="dashboard-route">
      {#if route === 'metrics'}
        <MetricsDashboard active={true} />
      {:else if route === 'operations'}
        <Dashboard {snapshot} />
      {:else if route === 'pipeline-builder'}
        <PipelineBuilder {snapshot} />
      {:else if route === 'system'}
        <SystemTab />
      {:else if route === 'settings'}
        <SettingsSurface {snapshot} />
      {/if}
    </div>
  {:else}
    <div class="empty" data-testid="dashboard-empty-state">Waiting for state…</div>
  {/if}
</main>

<style>
  .dashboard-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    color: var(--schegent-fg);
    background: var(--schegent-bg);
  }
  .dashboard-nav {
    display: flex;
    gap: 4px;
    padding: 8px 16px 0 16px;
    border-bottom: 1px solid var(--schegent-divider);
    background: var(--schegent-bg);
  }
  .nav-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--schegent-muted-fg);
    padding: 8px 16px;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.95em;
  }
  .nav-btn:hover { color: var(--schegent-fg); }
  .nav-btn.active {
    color: var(--schegent-fg);
    border-bottom-color: var(--vscode-charts-blue);
  }
  .dashboard-route {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .empty {
    padding: var(--schegent-pad);
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
</style>
