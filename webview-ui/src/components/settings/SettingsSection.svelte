<script lang="ts">
  /**
   * One section of the Settings page, as the redesign's section navigation shows them: on screen
   * while it is the page's section, hidden otherwise but still mounted, so the edits it holds are
   * still counted, saved and reverted.
   *
   * A visually hidden h2 names the section, as the redesign names its Backends section, so the
   * headings run h1 for the page, h2 for the section and h3 for a part of it.
   *
   * While the page's search is on, every section that holds a matching setting is on screen, so
   * each shows its name, in the look of a group label. The name takes the place of the section's
   * group heading, which is hidden meanwhile: two headings in a row would read as two levels. The
   * section is also the search scope of everything inside it (`settings-search.svelte.ts`).
   */
  import type { Snippet } from 'svelte';
  import {
    settingsSectionLabel,
    type SettingsPage,
    type SettingsSectionId
  } from './settings-page.svelte';
  import { provideSettingsSearch } from './settings-search.svelte';

  interface Props {
    readonly page: SettingsPage;
    readonly id: SettingsSectionId;
    readonly children: Snippet;
  }

  const { page, id, children }: Props = $props();

  provideSettingsSearch(() => ({
    search: page.search,
    section: id,
    name: settingsSectionLabel(id),
    show: () => page.select(id)
  }));

  const searching = $derived(page.search.active);
</script>

<section
  id="settings-section-{id}"
  class="set-section"
  class:found={searching}
  data-testid="settings-section-{id}"
  aria-labelledby="settings-section-{id}-heading"
  hidden={!page.shows(id)}
>
  <h2 id="settings-section-{id}-heading" class:sr-only={!searching}>{settingsSectionLabel(id)}</h2>
  {@render children()}
</section>

<style>
  /* Sections found by a search stand one under another. They have different parents, so each
     carries its own space below; a sibling rule could not reach from one to the next. The space
     is wider than the one between the parts of a section, so each name stands nearer to its own
     settings than to the section above it. */
  .found {
    margin-bottom: var(--schegent-space-6);
  }

  /* The name is the label of a group of results, in the look the product gives a group's label
     elsewhere (the sidebar's sections, the builder's palette). The headings inside a section
     keep the look of a group heading, so a name set that way would read as one more of them.
     What follows the name brings space of its own (a row's padding), so the name adds little. */
  .found > h2 {
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--schegent-muted-fg);
    margin-bottom: var(--schegent-space-1);
  }

  /* The section's name stands where the group heading stood. */
  .found :global(details.settings-group) {
    margin-top: 0;
  }

  .found :global(details.settings-group > summary) {
    display: none;
  }

  /* A list's last row draws no line under it (`.srow:last-child`), and so does a table's. While
     a search hides what follows a row, the row with nothing left under it is the one that ends
     the list. A status line that holds no text yet is not something under it. */
  .found :global(.srow:not(:has(~ :not([hidden]):not(:empty)))) {
    border-bottom: 0;
  }

  .found :global(.t tr:nth-last-child(1 of :not([hidden])) td) {
    border-bottom: 0;
  }
</style>
