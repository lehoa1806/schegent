<script lang="ts">
  /**
   * The Settings page header, as the redesign draws it: the title and the page's purpose, then
   * the count of unsaved changes, Revert and Save. These are the page's only save controls; every
   * part of the page drafts its edits and saves through them (`settings-page.svelte.ts`).
   */
  import type { SettingsPage } from './settings-page.svelte';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { SETTINGS_PAGE_HEADER_DESCRIPTIONS } from './SettingsPageHeader.descriptions';

  interface Props {
    page: SettingsPage;
  }
  const { page }: Props = $props();

  const changed = $derived(page.changedCount);
  const changedText = $derived(changed === 1 ? '1 unsaved change' : `${changed} unsaved changes`);
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
    {#if changed > 0}
      <span class="chip s-warn" data-testid="settings-unsaved">{changedText}</span>
    {/if}
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="settings-revert"
      disabled={changed === 0}
      onclick={() => page.revert()}
      use:hoverTextAnchor={{ controlId: 'revert', description: SETTINGS_PAGE_HEADER_DESCRIPTIONS.revert }}
    >Revert</button>
    <button
      type="button"
      class="btn btn-primary"
      data-testid="settings-save"
      disabled={!page.canSave}
      onclick={() => void page.save()}
      use:hoverTextAnchor={{ controlId: 'save', description: SETTINGS_PAGE_HEADER_DESCRIPTIONS.save }}
    >Save</button>
  </div>
</div>

<style>
  .purpose {
    margin-bottom: 0;
  }
</style>
