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
    /**
     * Feature 092 (T108, FR-057) — the queue new work is enqueued onto. Absent on
     * the unscoped reading, where the host defaults to the default queue.
     */
    queueId?: string;
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
    queueId,
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
  <header class="explorer-header">
    <span class="explorer-title">
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h16"></path>
        <circle cx="8" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="11" cy="19" r="1"></circle>
      </svg>
      Task explorer
    </span>
    <span class="explorer-count" aria-label={`${orderedItems.length} tasks`}>{orderedItems.length}</span>
  </header>
  <div class="left-panel-scroll">
    <div class="queue-composer">
      <QueueInputForm {availablePipelines} {defaultPipelineId} {queueId} {pendingCount} />
    </div>

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
    width: 336px;
    min-width: 280px;
    max-width: 42%;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--schegent-divider);
    background: var(--schegent-shell-bg);
    transition: opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .left-panel.collapsed {
    width: 0;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
    border-right-color: transparent;
  }
  .explorer-header {
    display: flex;
    min-height: 42px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: var(--schegent-space-2);
    padding: 0 var(--schegent-space-3);
    border-bottom: 1px solid var(--schegent-divider);
    color: var(--schegent-muted-fg);
  }
  .explorer-title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--schegent-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 650;
    letter-spacing: 0.055em;
    text-transform: uppercase;
  }
  .explorer-count {
    display: inline-flex;
    min-width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--schegent-surface-raised);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-variant-numeric: tabular-nums;
  }
  .left-panel-scroll {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .queue-management {
    order: 1;
    flex: 1 1 auto;
  }
  .queue-composer { order: 2; }
  .queue-list-section {
    min-height: 60px;
    overflow: hidden;
    padding: 0;
  }
  .queue-tabs {
    display: flex;
    gap: 0;
    margin: 0;
    border-bottom: 1px solid var(--schegent-divider, var(--sch-glass-border));
  }
  .queue-tab {
    flex: 1;
    min-height: 36px;
    padding: 7px 12px;
    font-size: var(--schegent-text-secondary);
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
    color: var(--schegent-color-active);
    border-bottom-color: var(--schegent-color-active);
    background: var(--schegent-surface-active);
  }
  .queue-tab-panel {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    padding: var(--schegent-space-2);
  }
  .glass-card {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
  }
  .queue-composer {
    flex: 0 0 auto;
    max-height: 42%;
    overflow-y: auto;
    padding: var(--schegent-space-3);
    border-top: 1px solid var(--schegent-divider);
    background: var(--schegent-shell-bg);
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
      border-right: 0;
      border-bottom: 1px solid var(--schegent-divider);
    }
    .left-panel-scroll {
      overflow: visible;
    }
    .queue-list-section {
      min-height: 240px;
      max-height: 460px;
    }
    .queue-composer {
      max-height: none;
    }
  }
</style>
