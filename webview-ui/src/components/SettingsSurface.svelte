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
  let activeTab = $state<SettingsSubTab>('general');
</script>

<main class="settings-surface" data-testid="settings-surface-root">
  <header class="settings-header">
    <h1 class="settings-title">Schegent Settings</h1>
    <nav class="settings-tabs" aria-label="Settings sections">
      <button
        type="button"
        class="tab-btn {activeTab === 'general' ? 'active' : ''}"
        data-testid="settings-tab-general"
        onclick={() => (activeTab = 'general')}
      >General</button>
      <button
        type="button"
        class="tab-btn {activeTab === 'fatal-signatures' ? 'active' : ''}"
        data-testid="settings-tab-fatal-signatures"
        onclick={() => (activeTab = 'fatal-signatures')}
      >Fatal Signatures</button>
      <!--
        Feature 030 (US3) — Queue sub-tab removed. Multi-queue settings
        (cap, default queue) are no longer configurable; the unified
        single queue is hard-coded at id='default', position=0,
        schedule=null.
      -->
      <button
        type="button"
        class="tab-btn {activeTab === 'wakeup' ? 'active' : ''}"
        data-testid="settings-tab-wakeup"
        onclick={() => (activeTab = 'wakeup')}
      >Wake up</button>
    </nav>
  </header>

  <section class="settings-body" data-testid="settings-body">
    {#if activeTab === 'general'}
      <GeneralSettingsTab {snapshot} />
    {:else if activeTab === 'fatal-signatures'}
      <FatalSignaturesTab {snapshot} />
    {:else if activeTab === 'wakeup'}
      <WakeUpTab {snapshot} />
    {/if}
  </section>
</main>

<style>
  .settings-surface {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    box-sizing: border-box;
    padding: var(--schegent-pad);
    color: var(--schegent-fg);
    background: transparent;
    overflow: hidden;
  }
  .settings-header {
    margin-bottom: var(--schegent-pad);
  }
  .settings-title {
    font-size: 1.5em;
    font-weight: 600;
    margin: 0 0 16px 0;
    background: var(--sch-accent-gradient);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .settings-tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--schegent-divider);
    padding-bottom: 8px;
    flex-wrap: wrap;
  }
  .tab-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--schegent-muted-fg);
    padding: 6px 16px;
    cursor: pointer;
    font-weight: 500;
    transition: border-bottom-color 0.2s, color 0.2s;
  }
  .tab-btn:hover {
    color: var(--schegent-fg);
  }
  .tab-btn.active {
    color: var(--schegent-fg);
    border-bottom: 2px solid var(--vscode-charts-blue);
  }
  .settings-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
