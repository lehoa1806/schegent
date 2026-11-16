<script lang="ts">
  /**
   * One section of the Settings page, as the redesign's section navigation shows them: on screen
   * while it is the page's section, hidden otherwise but still mounted, so the edits it holds are
   * still counted, saved and reverted.
   *
   * A visually hidden h2 names the section, as the redesign names its Backends section, so the
   * headings run h1 for the page, h2 for the section and h3 for a part of it.
   */
  import type { Snippet } from 'svelte';
  import {
    settingsSectionLabel,
    type SettingsPage,
    type SettingsSectionId
  } from './settings-page.svelte';

  interface Props {
    readonly page: SettingsPage;
    readonly id: SettingsSectionId;
    readonly children: Snippet;
  }

  const { page, id, children }: Props = $props();
</script>

<section
  id="settings-section-{id}"
  class="set-section"
  data-testid="settings-section-{id}"
  aria-labelledby="settings-section-{id}-heading"
  hidden={!page.shows(id)}
>
  <h2 id="settings-section-{id}-heading" class="sr-only">{settingsSectionLabel(id)}</h2>
  {@render children()}
</section>
