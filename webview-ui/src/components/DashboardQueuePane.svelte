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
</script>

<div class="left-panel" class:collapsed data-testid="dashboard-left-panel">
  <div class="left-panel-scroll">
    <QueueInputForm {availablePipelines} {defaultPipelineId} {pendingCount} />

    <section
      class="zone queue-management glass-card queue-list-section"
      data-testid="dashboard-queue-management"
    >
      <div class="queue-tabs" data-testid="dashboard-queue-tabs">
        <button
          type="button"
          class="queue-tab"
          class:active={queueTab === 'queue'}
          data-testid="dashboard-queue-tab-queue"
          onclick={() => onQueueTabChange('queue')}
          aria-selected={queueTab === 'queue'}
          role="tab"
        >Active queue</button>
        <button
          type="button"
          class="queue-tab"
          class:active={queueTab === 'history'}
          data-testid="dashboard-queue-tab-history"
          onclick={() => onQueueTabChange('history')}
          aria-selected={queueTab === 'history'}
          role="tab"
        >Recent runs</button>
      </div>
      {#if queueTab === 'queue'}
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
      {:else}
        <HistorySection {history} {isPrimary} {selectedTaskId} {onTaskSelect} />
      {/if}
    </section>
  </div>
</div>

<style>
  .left-panel {
    width: 420px;
    min-width: 320px;
    max-width: 50%;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                opacity 0.25s ease;
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
  }
  .queue-tabs {
    display: flex;
    gap: 0;
    margin-bottom: var(--schegent-gap);
    border-bottom: 1px solid var(--schegent-divider, var(--sch-glass-border));
  }
  .queue-tab {
    flex: 1;
    padding: 6px 12px;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
    text-align: center;
  }
  .queue-tab:hover { color: var(--schegent-fg); }
  .queue-tab.active {
    color: var(--schegent-fg);
    border-bottom-color: var(--schegent-color-active);
  }
  .glass-card {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
  }
</style>
