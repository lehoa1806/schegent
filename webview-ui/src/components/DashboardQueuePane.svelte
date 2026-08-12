<script lang="ts">
  import type {
    PipelineDefinition,
    QueueItem,
    QueueLifecycle,
    WorkflowSnapshot
  } from '../lib/snapshot-types';
  import QueueInputForm from './QueueInputForm.svelte';
  import QueueControls from './QueueControls.svelte';
  import QueueListView from './QueueListView.svelte';
  import HistorySection from './HistorySection.svelte';

  interface Props {
    collapsed: boolean;
    availablePipelines: readonly PipelineDefinition[];
    defaultPipelineId: string;
    pendingCount: number;
    queueTab: 'queue' | 'history';
    isPrimary: boolean;
    paused: boolean;
    hasInFlight: boolean;
    clearDoneDisabled: boolean;
    cleanDisabled: boolean;
    queueLifecycle: QueueLifecycle | null;
    orderedItems: readonly QueueItem[];
    selectedTaskId: string | null;
    history: WorkflowSnapshot['history'];
    onQueueTabChange: (tab: 'queue' | 'history') => void;
    onTaskSelect: (taskId: string) => void;
    onResume: (event: MouseEvent) => void;
    onPause: (event: MouseEvent) => void;
    onClearDone: (event: MouseEvent) => void;
    onClean: (event: MouseEvent) => void;
  }

  const {
    collapsed,
    availablePipelines,
    defaultPipelineId,
    pendingCount,
    queueTab,
    isPrimary,
    paused,
    hasInFlight,
    clearDoneDisabled,
    cleanDisabled,
    queueLifecycle,
    orderedItems,
    selectedTaskId,
    history,
    onQueueTabChange,
    onTaskSelect,
    onResume,
    onPause,
    onClearDone,
    onClean
  }: Props = $props();

  type QueueTab = 'queue' | 'history';
  const queueTabs: readonly QueueTab[] = ['queue', 'history'];

  function activateQueueTab(tab: QueueTab, focus = false): void {
    onQueueTabChange(tab);
    if (focus) {
      document.getElementById(`dashboard-queue-tab-${tab}`)?.focus();
    }
  }

  function onQueueTabKeydown(event: KeyboardEvent): void {
    const currentIndex = queueTabs.indexOf(queueTab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % queueTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + queueTabs.length) % queueTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = queueTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateQueueTab(queueTabs[nextIndex]!, true);
  }
</script>

<div class="left-panel" class:collapsed data-testid="dashboard-left-panel">
  <div class="left-panel-scroll">
    <QueueInputForm {availablePipelines} {defaultPipelineId} {pendingCount} />

    <section
      class="zone queue-management glass-card queue-list-section"
      data-testid="dashboard-queue-management"
    >
      <div
        class="queue-tabs"
        data-testid="dashboard-queue-tabs"
        role="tablist"
        aria-label="Queue views"
      >
        <button
          type="button"
          id="dashboard-queue-tab-queue"
          class="queue-tab"
          class:active={queueTab === 'queue'}
          data-testid="dashboard-queue-tab-queue"
          onclick={() => activateQueueTab('queue')}
          onkeydown={onQueueTabKeydown}
          aria-selected={queueTab === 'queue'}
          aria-controls="dashboard-queue-panel-queue"
          tabindex={queueTab === 'queue' ? 0 : -1}
          role="tab"
        >Active queue</button>
        <button
          type="button"
          id="dashboard-queue-tab-history"
          class="queue-tab"
          class:active={queueTab === 'history'}
          data-testid="dashboard-queue-tab-history"
          onclick={() => activateQueueTab('history')}
          onkeydown={onQueueTabKeydown}
          aria-selected={queueTab === 'history'}
          aria-controls="dashboard-queue-panel-history"
          tabindex={queueTab === 'history' ? 0 : -1}
          role="tab"
        >Recent runs</button>
      </div>
      {#if queueTab === 'queue'}
        <div
          class="queue-tab-panel"
          id="dashboard-queue-panel-queue"
          role="tabpanel"
          aria-labelledby="dashboard-queue-tab-queue"
        >
          <QueueControls
            {isPrimary}
            {paused}
            {pendingCount}
            {hasInFlight}
            {clearDoneDisabled}
            {cleanDisabled}
            {queueLifecycle}
            {onResume}
            {onPause}
            {onClearDone}
            {onClean}
          />
          <QueueListView
            {orderedItems}
            {isPrimary}
            {selectedTaskId}
            {onTaskSelect}
            testIdPrefix="dashboard-queue-item"
          />
        </div>
      {:else}
        <div
          class="queue-tab-panel"
          id="dashboard-queue-panel-history"
          role="tabpanel"
          aria-labelledby="dashboard-queue-tab-history"
        >
          <HistorySection {history} {isPrimary} {selectedTaskId} {onTaskSelect} />
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .left-panel {
    width: 390px;
    min-width: 320px;
    max-width: 46%;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .left-panel.collapsed {
    width: 0;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .left-panel-scroll {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-pad);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .queue-management { flex-shrink: 0; }
  .queue-list-section {
    flex: 1 1 auto;
    min-height: 60px;
    overflow: hidden;
    padding: 12px;
  }
  .queue-tabs {
    display: flex;
    gap: 0;
    margin: -4px -4px var(--schegent-gap);
    border-bottom: 1px solid var(--schegent-divider, var(--sch-glass-border));
  }
  .queue-tab {
    flex: 1;
    min-height: 36px;
    padding: 7px 12px;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
    text-align: left;
  }
  .queue-tab:hover { color: var(--schegent-fg); }
  .queue-tab.active {
    color: var(--schegent-fg);
    border-bottom-color: var(--schegent-color-active);
  }
  .queue-tab-panel {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }
  .glass-card {
    background: var(--schegent-surface);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    box-shadow: none;
    display: flex;
    flex-direction: column;
  }

  @media (max-width: 900px) {
    .left-panel,
    .left-panel.collapsed {
      width: 100%;
      min-width: 0;
      max-width: none;
      opacity: 1;
      pointer-events: auto;
      overflow: visible;
    }
    .left-panel-scroll {
      overflow: visible;
    }
    .queue-list-section {
      min-height: 240px;
      max-height: 460px;
    }
  }
</style>
