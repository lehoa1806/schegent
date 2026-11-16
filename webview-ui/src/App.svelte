<script lang="ts">
  import StatusBar from './components/StatusBar.svelte';
  import StatsStrip from './components/StatsStrip.svelte';
  import CurrentTask from './components/CurrentTask.svelte';
  import DashboardLink from './components/DashboardLink.svelte';
  import IncompatibleSnapshotNotice from './components/IncompatibleSnapshotNotice.svelte';
  import { snapshotStore } from './lib/snapshot-store.svelte';

  const ready = $derived(snapshotStore.isReady);
  const connection = $derived(ready ? 'Connected' : 'Connecting');
</script>

<!-- The sidebar's look is the shared sheet's (`lib/sg/sg-sidebar.css`). The logo is drawn here
     rather than taken from the dashboard's icon sprite, which the sidebar does not load. The
     button to the dashboard sits outside the readiness branch, so it keeps focus when the first
     state arrives. -->
<main class="sg sidebar" data-testid="app-root">
  <div class="sb-head">
    <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="m4 11 8 4 8-4" /><path d="m4 15 8 4 8-4" /></svg>
    Schegent
    <span class="conn" class:off={!ready} role="img" aria-label={connection} title={connection}></span>
  </div>
  <IncompatibleSnapshotNotice />
  {#if ready}
    <StatusBar />
    <StatsStrip />
    <CurrentTask />
  {:else}
    <div class="sb-sec empty" data-testid="empty-state" role="status">
      <strong>Connecting</strong>
      <span>Waiting for workspace state.</span>
      <span class="loading-rule" aria-hidden="true"></span>
    </div>
  {/if}
  <div class="sb-foot"><DashboardLink /></div>
</main>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1);
    color: var(--schegent-muted-fg);
  }
  .empty strong {
    color: var(--schegent-fg);
  }
  .loading-rule {
    display: block;
    width: 72%;
    height: 2px;
    margin-top: var(--schegent-space-2);
    overflow: hidden;
    background: var(--schegent-border);
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
</style>
