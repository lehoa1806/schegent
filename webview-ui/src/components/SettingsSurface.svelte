<script lang="ts">
  /**
   * Feature 012 T047 — Settings surface reduced to two sub-tabs.
   * Feature 030 (US3) — Removed the Queue sub-tab. FR-R3-145 (T1569): the
   * settings that sub-tab carried are configurable again as of Feature 092,
   * but from QueueConfigModal.svelte, not from here — the sub-tab did not
   * come back, which is why this surface is still two tabs.
   *
   * Phases / Pipelines moved to PipelineBuilder.svelte; Models moved to
   * PipelineBuilderEditors/ModelCatalogEditor.svelte, mounted under the
   * same PipelineBuilder.svelte. Sub-tabs: General, Fatal Signatures.
   */
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import '../lib/sg/sg-settings.css';
  import GeneralSettingsTab from './settings/GeneralSettingsTab.svelte';
  import FatalSignaturesTab from './settings/FatalSignaturesTab.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  type SettingsSubTab = 'general' | 'fatal-signatures';
  const SETTINGS_TABS = Object.freeze([
    { id: 'general', label: 'General' },
    { id: 'fatal-signatures', label: 'Fatal Signatures' }
  ] satisfies ReadonlyArray<{ id: SettingsSubTab; label: string }>);
  let activeTab = $state<SettingsSubTab>('general');

  function activate(tab: SettingsSubTab, focus = false): void {
    activeTab = tab;
    if (!focus) return;
    queueMicrotask(() => document.getElementById(`settings-tab-${tab}`)?.focus());
  }

  function onTabKeydown(event: KeyboardEvent): void {
    const current = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab);
    let next = current;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1) % SETTINGS_TABS.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = SETTINGS_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    activate(SETTINGS_TABS[next].id, true);
  }
</script>

<main class="settings-surface" data-testid="settings-surface-root">
  <div class="page">
    <div class="phead">
      <div>
        <h1>Settings</h1>
        <!--
          FR-R3-145 (T1569, FR-003) — the header names what the two tabs render and
          nothing else. It said "runners, safety controls, and retention": retention
          is here, "runners" is three CLI path fields with no runner selector, and no
          safety control (spend bounds, trust, confirmations, uncontained backends)
          is on this surface at all. Naming them is the claim, not the absence — the
          controls themselves belong to FR-R3-143 and FR-R3-144.
        -->
        <p class="purpose">Configure CLI paths, logging, run limits, retention, and fatal signatures.</p>
      </div>
    </div>
    <div class="set-layout">
      <div class="set-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
        <!--
          Feature 030 (US3) — Queue sub-tab removed, and not restored by
          Feature 092: the cap and the default queue are configured from
          QueueConfigModal.svelte instead, so this tablist stays at two
          (FR-R3-145, T1569).
        -->
        {#each SETTINGS_TABS as tab (tab.id)}
          <button
            id="settings-tab-{tab.id}"
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls="settings-panel-{tab.id}"
            tabindex={activeTab === tab.id ? 0 : -1}
            data-testid="settings-tab-{tab.id}"
            onclick={() => activate(tab.id)}
            onkeydown={onTabKeydown}
          >{tab.label}</button>
        {/each}
      </div>

      <div
        id="settings-panel-{activeTab}"
        class="set-body"
        role="tabpanel"
        aria-labelledby="settings-tab-{activeTab}"
        data-testid="settings-body"
      >
        {#if activeTab === 'general'}
          <GeneralSettingsTab {snapshot} />
        {:else if activeTab === 'fatal-signatures'}
          <FatalSignaturesTab {snapshot} />
        {/if}
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

  .purpose {
    margin-bottom: 0;
  }

  /* A grid item keeps its content's width as its minimum; a long path or note must wrap in the
     body column, not widen the page. */
  .set-body {
    min-width: 0;
  }
</style>
