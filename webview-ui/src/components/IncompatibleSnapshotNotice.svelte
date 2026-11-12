<script lang="ts">
  // Review gap GC-16 (2026-11-12) — the view got a snapshot it cannot read. It keeps its last
  // readable state, so without this the screen looks live while it no longer moves.
  import { snapshotStore } from '../lib/snapshot-store.svelte';

  //
  // The sidebar mounts this at startup, so it counts against the sidebar's SC-010 size cap
  // (tests/unit/ui/sidebar/bundle-size.test.ts). The cause is one text expression, not an
  // `{#if}/{:else}` pair, because each branch compiles to its own template function.
  const incompatible = $derived(snapshotStore.incompatibleSnapshot);
  const cause = $derived(
    incompatible?.reason === 'unknown-schema'
      ? `state format ${incompatible.schemaVersion}, which this view does not know.`
      : 'state whose queue list is malformed.'
  );
</script>

{#if incompatible}
  <div class="incompatible" data-testid="incompatible-snapshot" role="alert">
    <strong>This view cannot read the workspace state.</strong>
    <span>
      The extension sent {cause} What is shown may be out of date. Reload the window (Developer: Reload
      Window) so the view and the extension come from the same build.
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
