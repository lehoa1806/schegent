<script lang="ts">
  /**
   * Feature 012 T047 — Settings surface reduced to two sub-tabs.
   * Feature 014 T029 — Added the Wake up sub-tab alongside General /
   * Fatal Signatures.
   * Feature 030 (US3) — Removed the Queue sub-tab. Multi-queue settings
   * (global concurrency cap, default queue) are no longer configurable;
   * the unified single queue is hard-coded at cap=1 with id='default'.
   *
   * Phases / Pipelines moved to PipelineBuilder.svelte; Models moved to
   * Dashboard.svelte's Model Catalog section. Sub-tabs: General,
   * Fatal Signatures, Wake up.
   */
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import GeneralSettingsTab from './settings/GeneralSettingsTab.svelte';
  import FatalSignaturesTab from './settings/FatalSignaturesTab.svelte';
  import WakeUpTab from './settings/WakeUpTab.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  type SettingsSubTab = 'general' | 'fatal-signatures' | 'wakeup';
  const SETTINGS_TABS = Object.freeze([
    { id: 'general', label: 'General' },
    { id: 'fatal-signatures', label: 'Fatal Signatures' },
    { id: 'wakeup', label: 'Wake up' }
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
  <header class="settings-header">
    <h1 class="settings-title">Settings</h1>
    <p class="settings-description">Configure runners, safety controls, retention, and background wake-up.</p>
  </header>
  <div class="settings-layout">
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <!--
        Feature 030 (US3) — Queue sub-tab removed. Multi-queue settings
        (cap, default queue) are no longer configurable; the unified
        single queue is hard-coded at id='default', position=0,
        schedule=null.
      -->
      {#each SETTINGS_TABS as tab (tab.id)}
        <button
          id="settings-tab-{tab.id}"
          type="button"
          class="tab-btn {activeTab === tab.id ? 'active' : ''}"
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
      class="settings-body"
      role="tabpanel"
      aria-labelledby="settings-tab-{activeTab}"
      data-testid="settings-body"
    >
      {#if activeTab === 'general'}
        <GeneralSettingsTab {snapshot} />
      {:else if activeTab === 'fatal-signatures'}
        <FatalSignaturesTab {snapshot} />
      {:else if activeTab === 'wakeup'}
        <WakeUpTab {snapshot} />
      {/if}
    </div>
  </div>
</main>

<style>
  .settings-surface {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    box-sizing: border-box;
    padding: 20px 24px 24px;
    color: var(--schegent-fg);
    background: transparent;
    overflow: hidden;
  }
  .settings-header {
    margin-bottom: 20px;
  }
  .settings-title {
    margin: 0;
    color: var(--schegent-fg);
    font-size: 1.55rem;
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .settings-description {
    margin: 5px 0 0;
    color: var(--schegent-muted-fg);
    font-size: 0.84rem;
    line-height: 1.45;
  }
  .settings-layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 28px;
    flex: 1;
    min-height: 0;
  }
  .settings-tabs {
    display: flex;
    align-self: start;
    flex-direction: column;
    gap: 8px;
  }
  .tab-btn {
    min-height: 38px;
    background: var(--schegent-bg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    color: var(--schegent-muted-fg);
    padding: 8px 12px;
    cursor: pointer;
    font-weight: 500;
    text-align: left;
  }
  .tab-btn:hover {
    color: var(--schegent-fg);
    background: var(--schegent-surface-subtle);
  }
  .tab-btn.active {
    color: var(--schegent-fg);
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 10%, var(--schegent-bg));
  }
  .settings-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  @media (max-width: 780px) {
    .settings-surface {
      padding: 16px;
      overflow-y: auto;
    }
    .settings-layout {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .settings-tabs {
      width: 100%;
      flex-direction: row;
      overflow-x: auto;
    }
    .tab-btn {
      flex: 0 0 auto;
    }
    .settings-body {
      overflow: visible;
    }
  }
</style>
