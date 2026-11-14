<!-- Two menus and a control outside them, for SgMenu.test.ts. -->
<script lang="ts">
  import SgMenu from '../SgMenu.svelte';

  interface Props {
    onPick?: (action: string) => void;
  }

  const { onPick = () => {} }: Props = $props();
</script>

<SgMenu label="Actions for Default" testid="menu-default">
  <button type="button" role="menuitem" onclick={() => onPick('open')}>Open</button>
  <!-- Disabled as the menus disable an item, with a handler of its own that the menu must refuse. -->
  <button type="button" role="menuitem" aria-disabled="true" onclick={() => onPick('make-default')}>
    Make default
  </button>
  <button type="button" role="menuitem" onclick={() => onPick('rename')}>Rename…</button>
  <hr />
  <button type="button" role="menuitem" class="danger" onclick={() => onPick('delete')}>
    Delete queue…
  </button>
</SgMenu>

<SgMenu label="Actions for Nightly" testid="menu-nightly">
  <button type="button" role="menuitem" onclick={() => onPick('open-nightly')}>Open</button>
</SgMenu>

<button type="button" data-testid="outside">Outside</button>
