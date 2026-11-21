<script lang="ts">
  /**
   * The Settings page header, as the redesign draws it: the title and the page's purpose, then
   * the search field, the count of unsaved changes, Revert and Save. Revert and Save are the
   * page's only save controls; every part of the page drafts its edits and saves through them
   * (`settings-page.svelte.ts`).
   *
   * The redesign draws the search field and gives it no behaviour. Here it filters the page
   * (`settings-search.svelte.ts`), and a status line tells assistive technology how many settings
   * match. The line waits for a pause in typing, so a word typed quickly is announced once.
   */
  import type { SettingsPage } from './settings-page.svelte';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { SETTINGS_PAGE_HEADER_DESCRIPTIONS } from './SettingsPageHeader.descriptions';

  /** How long typing must pause before the status line says how many settings match. */
  const ANNOUNCE_DELAY_MS = 500;

  interface Props {
    page: SettingsPage;
  }
  const { page }: Props = $props();

  const changed = $derived(page.changedCount);
  const changedText = $derived(changed === 1 ? '1 unsaved change' : `${changed} unsaved changes`);
  const revertOff = $derived(changed === 0);
  const saveOff = $derived(!page.canSave);

  let announced = $state('');
  // Every key runs this again, also a key that leaves the count as it was, so the wait starts
  // again each time and the line speaks once, after the last key.
  $effect(() => {
    const next = page.search.summary;
    const timer = setTimeout(() => {
      announced = next;
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  });
</script>

<div class="phead">
  <div>
    <h1>Settings</h1>
    <!--
      FR-R3-145 (FR-003) — the purpose line claims nothing about what the page holds; the
      redesign's line says how saving works and where each setting applies, which every row then
      shows.
    -->
    <p class="purpose" data-testid="settings-purpose">
      Changes apply when you save. Each setting shows where it applies.
    </p>
  </div>
  <div class="actions">
    <div class="search">
      <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
      <input
        class="input"
        type="search"
        placeholder="Search settings"
        aria-label="Search settings"
        data-testid="settings-search"
        value={page.search.query}
        oninput={(event) => {
          page.search.query = event.currentTarget.value;
        }}
        use:hoverTextAnchor={{
          controlId: 'search',
          description: SETTINGS_PAGE_HEADER_DESCRIPTIONS.search,
          preferredPlacement: 'left'
        }}
      />
      <span class="sr-only" role="status" data-testid="settings-search-status">{announced}</span>
    </div>
    {#if changed > 0}
      <span class="chip s-warn" data-testid="settings-unsaved">{changedText}</span>
    {/if}
    <!-- Revert and Save turn themselves off on a press: Save while the host answers, Revert once
         nothing is left to revert. A button that turns `disabled` drops the focus to the page, so
         these are off by `aria-disabled`: the focus stays where the user pressed, the button is
         announced as unavailable, its description still opens on focus, and a press while it is
         off does nothing. -->
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="settings-revert"
      aria-disabled={revertOff ? 'true' : 'false'}
      onclick={() => {
        if (!revertOff) page.revert();
      }}
      use:hoverTextAnchor={{ controlId: 'revert', description: SETTINGS_PAGE_HEADER_DESCRIPTIONS.revert }}
    >Revert</button>
    <button
      type="button"
      class="btn btn-primary"
      data-testid="settings-save"
      aria-disabled={saveOff ? 'true' : 'false'}
      onclick={() => {
        if (!saveOff) void page.save();
      }}
      use:hoverTextAnchor={{ controlId: 'save', description: SETTINGS_PAGE_HEADER_DESCRIPTIONS.save }}
    >Save</button>
  </div>
</div>

<style>
  .purpose {
    margin-bottom: 0;
  }

  /* The row of actions claims a fixed share of the header: the field at its narrowest, a count
     of two digits and both buttons. Whether the row fits beside the title therefore never
     depends on the count, so the first edit cannot move the row to a line of its own and push
     the page down. The share follows the text size, as the count and the buttons do. */
  .actions {
    flex: 1 1 calc(160px + 20rem);
    justify-content: flex-end;
  }

  /* The field is the part that gives when the count appears. Where there is room it is as wide
     as a toolbar's search field (`.sg .toolbar .search`). A setting key longer than that scrolls
     inside the field, as text does in any input. */
  .search {
    flex: 0 1 260px;
    min-width: 160px;
  }

  /* On a narrow page the field takes a line of its own, above the count and the buttons. */
  @media (max-width: 560px) {
    .actions {
      flex-wrap: wrap;
    }

    .search {
      flex-basis: 100%;
    }
  }
</style>
