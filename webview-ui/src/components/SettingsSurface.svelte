<script lang="ts">
  /**
   * The Settings page, as the redesign draws it: the page header, then a navigation of the page's
   * sections beside the one section on screen (`settings/settings-page.svelte.ts` lists them).
   * A button shows its section and marks itself current; focus stays on it. A section that holds
   * an unsaved edit carries the redesign's dot.
   *
   * Five of the sections hold the general settings, one the queue settings and one the failure
   * signatures. Every section stays mounted, the ones not shown hidden, so an edit made in one is
   * still counted, saved and reverted while another is shown: the page header holds the only
   * Revert and Save.
   *
   * While the header's search field holds a word, the body shows every section that holds a
   * matching setting and the navigation marks none as current; a line says so when none matches.
   *
   * Feature 012 T047 moved Phases and Pipelines to PipelineBuilder.svelte and Models to
   * PipelineBuilderEditors/ModelCatalogEditor.svelte. Feature 030 (US3) removed the Queue sub-tab,
   * and FR-R3-145 (T1569) set the cap and the default queue from a dialog on the Queues list. The
   * redesign brings them back here as the Queues section (`settings/QueueDefaultsSection.svelte`),
   * which the list's "Queue defaults" opens.
   */
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import '../lib/sg/sg-settings.css';
  import GeneralSettingsTab from './settings/GeneralSettingsTab.svelte';
  import FatalSignaturesTab from './settings/FatalSignaturesTab.svelte';
  import QueueDefaultsSection from './settings/QueueDefaultsSection.svelte';
  import SettingsPageHeader from './settings/SettingsPageHeader.svelte';
  import SettingsSection from './settings/SettingsSection.svelte';
  import {
    SETTINGS_SECTIONS,
    SettingsPage,
    type SettingsSectionId
  } from './settings/settings-page.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The section the page opens on, Backends unless the opener names another. Read once. */
    section?: SettingsSectionId;
  }
  const { snapshot, section = 'backends' }: Props = $props();

  // Read through a function: the page takes the opening section once, at mount, and keeps the
  // section the operator chooses after that as its own state.
  const openingSection = (): SettingsSectionId => section;
  const page = new SettingsPage(openingSection());
</script>

<main class="settings-surface" data-testid="settings-surface-root">
  <div class="page">
    <SettingsPageHeader {page} />
    <div class="set-layout">
      <nav class="set-nav" aria-label="Settings sections">
        {#each SETTINGS_SECTIONS as section (section.id)}
          <button
            type="button"
            data-testid="settings-nav-{section.id}"
            aria-current={page.current === section.id ? 'true' : undefined}
            onclick={() => page.select(section.id)}
          >
            {section.label}
            {#if page.sectionChanged(section.id)}
              <span class="mod" role="img" aria-label="has unsaved changes"></span>
            {/if}
          </button>
        {/each}
      </nav>

      <div class="set-body" data-testid="settings-body">
        {#if page.search.active && page.search.count === 0}
          <!-- Plain text: the header's status line is the page's one live region for a search. -->
          <p class="empty" data-testid="settings-search-empty">
            No setting matches "{page.search.query.trim()}".
          </p>
        {/if}
        <GeneralSettingsTab {snapshot} {page}>
          {#snippet queues()}
            <SettingsSection {page} id="queues">
              <QueueDefaultsSection {snapshot} {page} />
            </SettingsSection>
          {/snippet}
        </GeneralSettingsTab>
        <SettingsSection {page} id="signatures">
          <FatalSignaturesTab {snapshot} {page} />
        </SettingsSection>
      </div>
    </div>
  </div>
</main>

<style>
  .settings-surface {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* A grid item keeps its content's width as its minimum; a long path or note must wrap in the
     body column, not widen the page. */
  .set-body {
    min-width: 0;
  }
</style>
