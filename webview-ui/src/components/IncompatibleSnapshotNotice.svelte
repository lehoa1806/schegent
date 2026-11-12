<script lang="ts">
  // Review gap GC-16 (2026-11-12) — the view got a snapshot it cannot read. It keeps its last
  // readable state, so without this the screen looks live while it no longer moves.
  import { snapshotStore } from '../lib/snapshot-store.svelte';

  const incompatible = $derived(snapshotStore.incompatibleSnapshot);
</script>

{#if incompatible}
  <div class="incompatible" data-testid="incompatible-snapshot" role="alert">
    <strong>This view cannot read the workspace state.</strong>
    <span>
      {#if incompatible.reason === 'unknown-schema'}
        The extension sent state format {incompatible.schemaVersion}, which this view does not know.
      {:else}
        The extension sent state whose queue list is malformed.
      {/if}
      What is shown may be out of date. Reload the window (Developer: Reload Window) so the view and
      the extension come from the same build.
    </span>
  </div>
{/if}

<style>
  .incompatible {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 8px 10px;
    padding: 8px 10px;
    border: 1px solid var(--schegent-color-warning);
    border-radius: 4px;
    color: var(--schegent-fg);
    overflow-wrap: anywhere;
  }
</style>
