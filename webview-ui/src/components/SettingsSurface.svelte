<script lang="ts">
  /**
   * The Settings page, as the redesign draws it: the page header, then a navigation of the page's
   * sections beside the one section on screen (`settings/settings-page.svelte.ts` lists them).
   * A button shows its section and marks itself current; focus stays on it. A section that holds
   * an unsaved edit carries the redesign's dot.
   *
   * The general settings fill five sections and the failure signatures the sixth. Every section
   * stays mounted, the ones not shown hidden, so an edit made in one is still counted, saved and
   * reverted while another is shown: the page header holds the only Revert and Save.
   *
   * Feature 012 T047 moved Phases and Pipelines to PipelineBuilder.svelte and Models to
   * PipelineBuilderEditors/ModelCatalogEditor.svelte. Feature 030 (US3) removed the Queue sub-tab;
   * the cap and the default queue are set from QueueConfigModal.svelte (FR-R3-145, T1569).
   */
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import '../lib/sg/sg-settings.css';
  import GeneralSettingsTab from './settings/GeneralSettingsTab.svelte';
  import FatalSignaturesTab from './settings/FatalSignaturesTab.svelte';
  import SettingsPageHeader from './settings/SettingsPageHeader.svelte';
  import SettingsSection from './settings/SettingsSection.svelte';
  import { SETTINGS_SECTIONS, SettingsPage } from './settings/settings-page.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  const page = new SettingsPage();
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
            aria-current={page.section === section.id ? 'true' : undefined}
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
        <GeneralSettingsTab {snapshot} {page} />
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
