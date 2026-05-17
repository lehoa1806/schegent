<script lang="ts">
  import StatusBar from './components/StatusBar.svelte';
  import StatsStrip from './components/StatsStrip.svelte';
  import CurrentTask from './components/CurrentTask.svelte';
  import DashboardLink from './components/DashboardLink.svelte';
  import { snapshotStore } from './lib/snapshot-store.svelte';

  const ready = $derived(snapshotStore.isReady);
</script>

<main class="root" data-testid="app-root">
  {#if ready}
    <StatusBar />
    <StatsStrip />
    <CurrentTask />
    <div class="dashboard-link-wrap">
      <DashboardLink />
    </div>
  {:else}
    <div class="empty" data-testid="empty-state">Waiting for state…</div>
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
  }
  .empty {
    padding: var(--schegent-pad);
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .dashboard-link-wrap {
    padding: var(--schegent-pad);
  }
</style>
