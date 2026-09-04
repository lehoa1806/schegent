<script lang="ts">
  // Feature 097 — individual task row for the Queue Detail table.
  //
  // Extracted from QueueDetailRows.svelte to stay within the repository's
  // 500-line Svelte component LOC budget. This component owns the 7-column
  // grid rendering for a standalone task: prompt (with truncation + show
  // more/less), process, phase progress bar, timing, colorized status badge,
  // and drill-down chevron. It receives all derived data as props; it
  // performs no IPC and holds no snapshot-level state.

  import type {
    QueueItem,
    PipelineDefinition,
    TaskPhaseProgressProjection
  } from '../../lib/snapshot-types';
  import type { TaskTimingLabel } from '../../lib/task-row-view';
  import { formatDuration } from '../../lib/format-duration';
  import { formatTimeOfDay } from '../../lib/format-time-of-day';

  // ---------- Phase bar segment ----------
  //
  // FR-R3-158 (T023, SC-007) — `completed` is gone from this union, and with it
  // the `indexOf` that produced it. SC-007 admits no lookup of a phase's position
  // within the pipeline's phase list anywhere in the rendering path, and shading
  // the phases before the current one was exactly that lookup — the same
  // inference `deriveTaskPhaseProgress` made, drawn instead of counted, and wrong
  // in the same ways: it read a plan the surface resolved itself rather than the
  // one the run froze, so an overridden phase still occupied a segment, and a
  // `currentPhase` absent from that plan greyed the whole bar.
  //
  // What is left is what the surface can know without ordering: which phases the
  // pipeline holds, and which one is in flight now. How many have settled is the
  // figure beside the bar, which is the run's own answer rather than a redrawing
  // of it.
  interface PhaseSegment {
    readonly name: string;
    readonly state: 'current' | 'planned';
  }

  interface Props {
    readonly task: QueueItem;
    readonly rowIndex: number;
    readonly pipeline: PipelineDefinition | undefined;
    readonly pipelineName: string;
    /**
     * FR-R3-158 (T023, FR-014) — the host's settled-phase pair, rendered as it
     * arrives. `null` is unknown, not zero, and is shown as no figure at all: a
     * task record predating the feature has no answer to give, and `0 of 0` would
     * read as a finished run of nothing.
     */
    readonly progress: TaskPhaseProgressProjection | null;
    readonly timing: TaskTimingLabel;
    readonly isSelected: boolean;
    readonly onSelect: () => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
  }

  const {
    task,
    rowIndex,
    pipeline,
    pipelineName,
    progress,
    timing,
    isSelected,
    onSelect,
    onKeyDown
  }: Props = $props();

  // ---------- Label truncation ----------
  const LABEL_MAX_CHARS = 256;
  let expanded = $state(false);

  const isLabelLong = $derived(task.label.length > LABEL_MAX_CHARS);
  const displayLabel = $derived(
    expanded || !isLabelLong
      ? task.label
      : task.label.slice(0, LABEL_MAX_CHARS) + '…'
  );

  function toggleExpand(event: MouseEvent | KeyboardEvent): void {
    event.stopPropagation();
    expanded = !expanded;
  }

  function onToggleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleExpand(event);
    }
  }

  // ---------- Status display ----------
  function statusDisplayLabel(status: string): string {
    if (status === 'completed') return 'DONE';
    if (status === 'in-flight') return 'RUNNING';
    return status.toUpperCase();
  }

  // ---------- Timing secondary label ----------
  const timingSecondary = $derived.by((): string => {
    if (task.status === 'in-flight' && task.startedAt !== null) {
      return `started ${formatTimeOfDay(task.startedAt)}`;
    }
    if (task.status === 'failed') {
      const ts = task.completedAt ?? task.updatedAt;
      return `failed ${formatTimeOfDay(ts)}`;
    }
    if (task.status === 'completed' && task.completedAt !== null) {
      return `done ${formatTimeOfDay(task.completedAt)}`;
    }
    return `added ${formatTimeOfDay(task.enqueuedAt)}`;
  });

  // ---------- Phase segments ----------
  const segments = $derived.by((): readonly PhaseSegment[] => {
    if (pipeline === undefined || pipeline.phases.length === 0) return [];
    // Name equality, not position: a membership test asks whether this segment is
    // the phase now in flight and needs no ordering to answer. The index argument
    // is deliberately not taken, so there is nothing here to compare against a
    // count or a length.
    return pipeline.phases.map((phaseName): PhaseSegment => ({
      name: phaseName,
      state: phaseName === task.currentPhase ? 'current' : 'planned'
    }));
  });
</script>

<button
  type="button"
  class="table-row status-{task.status}"
  data-row-key="task:{task.id}"
  data-testid="queue-task-row-{task.id}"
  data-selected={isSelected ? 'true' : 'false'}
  aria-label="Open run {task.label}"
  onclick={onSelect}
  onkeydown={onKeyDown}
>
  <!-- # -->
  <span class="cell cell-position">{rowIndex + 1}</span>

  <!-- PROMPT -->
  <span class="cell cell-prompt">
    <span class="prompt-label">{displayLabel}</span>
    {#if isLabelLong}
      <span
        class="toggle-label"
        role="link"
        tabindex="0"
        data-testid="queue-task-toggle-label-{task.id}"
        onclick={toggleExpand}
        onkeydown={onToggleKeyDown}
      >{expanded ? 'show less' : 'show more'}</span>
    {/if}
    <span class="prompt-id" data-testid="queue-task-id-{task.id}">{task.id}</span>
    {#if task.lastErrorSummary !== null}
      <span class="prompt-error" data-testid="queue-task-error-{task.id}">
        ⚠ {task.lastErrorSummary}
      </span>
    {/if}
  </span>

  <!-- PROCESS -->
  <span class="cell cell-process" data-testid="queue-task-pipeline-{task.id}">
    <span class="process-name">{pipelineName}</span>
    {#if pipeline !== undefined && task.currentPipelineId}
      <span class="process-id">pipeline · {task.currentPipelineId}</span>
    {/if}
  </span>

  <!-- PROGRESS -->
  <span class="cell cell-progress" data-testid="queue-task-progress-{task.id}">
    {#if segments.length > 0}
      <span class="progress-bar">
        {#each segments as seg}
          <span class="phase-seg seg-{seg.state}" title={seg.name}></span>
        {/each}
      </span>
    {/if}
    {#if progress !== null}
      <span class="progress-text" data-testid="queue-task-progress-text-{task.id}">
        {progress.settled} of {progress.total} phases{#if task.currentPhase}
          <span class="progress-current-phase"> · {task.currentPhase}</span>
        {/if}
      </span>
    {:else if task.currentPhase}
      <!--
        FR-R3-158 (T023, FR-014) — no pair, so no figure. The phase the task is in
        is a separate fact the row still knows, and suppressing it because a count
        is missing would hide something true. It renders without the leading
        separator that belongs to the figure.
      -->
      <span class="progress-text">
        <span class="progress-current-phase">{task.currentPhase}</span>
      </span>
    {/if}
    {#if task.retryCount > 0}
      <span class="progress-retry" data-testid="queue-task-retry-{task.id}">
        ↻ retried {task.retryCount}&times;
      </span>
    {/if}
  </span>

  <!-- TIME -->
  <span class="cell cell-time" data-testid="queue-task-timing-{task.id}">
    <span class="time-primary">
      {#if timing.kind === 'waiting'}waiting {formatDuration(timing.value)}{:else}{formatDuration(timing.value)}{/if}
    </span>
    <span class="time-secondary">{timingSecondary}</span>
  </span>

  <!-- STATUS -->
  <span class="cell cell-status">
    <span class="status-badge badge-{task.status}">{statusDisplayLabel(task.status)}</span>
  </span>

  <!-- Chevron -->
  <span class="cell cell-chevron" aria-hidden="true">›</span>
</button>

<style>
  /* ---- Data row ---- */
  .table-row {
    display: grid;
    grid-template-columns: 36px 2fr 1fr 1.5fr auto auto 28px;
    gap: 12px;
    align-items: start;
    text-align: left;
    padding: 8px 12px;
    font: inherit;
    color: var(--vscode-foreground);
    cursor: pointer;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border, transparent) 40%, transparent);
    border-radius: 0;
    background: transparent;
    transition: background-color 120ms ease-out;
    width: 100%;
  }

  .table-row:hover {
    background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 5%, transparent));
  }

  .table-row[data-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background));
  }

  .table-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* ---- Generic cell ---- */
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .cell-position {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    justify-content: center;
    align-items: center;
    padding-top: 2px;
  }

  /* ---- PROMPT ---- */
  .cell-prompt { gap: 3px; }

  .prompt-label {
    font-weight: 500;
    color: var(--vscode-editor-foreground);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.35;
  }

  .prompt-id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.75;
  }

  .toggle-label {
    all: unset;
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    align-self: flex-start;
  }

  .toggle-label:hover { text-decoration: underline; }

  .prompt-error {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    margin-top: 2px;
    background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 30%, transparent);
    border-radius: 4px;
    color: var(--vscode-errorForeground);
    font-size: 11px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  /* ---- PROCESS ---- */
  .cell-process { gap: 2px; }

  .process-name { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); }
  .process-id { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; }

  /* ---- PROGRESS ---- */
  .cell-progress { gap: 4px; }

  .progress-bar { display: flex; gap: 2px; align-items: center; height: 8px; }

  .phase-seg {
    flex: 1;
    height: 100%;
    border-radius: 2px;
    min-width: 6px;
    transition: opacity 120ms ease-out;
  }

  /* FR-R3-158 (T023) — `seg-completed` and `seg-future` went with the ordering
     that told them apart. The in-flight phase keeps its full-strength treatment,
     including the paused and failed variants; every other planned phase is drawn
     the way `seg-future` was, because "not the one in flight" is now all the bar
     claims to know. */
  .seg-current { background: var(--schegent-color-active); opacity: 0.7; }

  .status-paused .seg-current { background: var(--schegent-color-warning); opacity: 1; }
  .status-failed .seg-current { background: var(--schegent-color-error); opacity: 1; }

  .seg-planned { background: var(--schegent-muted-fg); opacity: 0.2; }

  .progress-text { font-size: 11px; color: var(--vscode-descriptionForeground); }

  .progress-current-phase {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    font-weight: 500;
  }

  .progress-retry {
    font-size: 10px;
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  }

  /* ---- TIME ---- */
  .cell-time { gap: 2px; white-space: nowrap; align-items: flex-end; }

  .time-primary {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }

  .time-secondary { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; }

  /* ---- STATUS ---- */
  .cell-status { align-items: center; justify-content: center; padding-top: 2px; }

  .status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 10px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .badge-in-flight {
    background: color-mix(in srgb, var(--schegent-color-active) 18%, transparent);
    color: var(--schegent-color-active);
    border: 1px solid color-mix(in srgb, var(--schegent-color-active) 35%, transparent);
  }

  .badge-completed {
    background: color-mix(in srgb, var(--schegent-color-completed) 18%, transparent);
    color: var(--schegent-color-completed);
    border: 1px solid color-mix(in srgb, var(--schegent-color-completed) 35%, transparent);
  }

  .badge-failed {
    background: color-mix(in srgb, var(--schegent-color-error) 18%, transparent);
    color: var(--schegent-color-error);
    border: 1px solid color-mix(in srgb, var(--schegent-color-error) 35%, transparent);
  }

  .badge-pending {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, transparent);
  }

  .badge-paused {
    background: color-mix(in srgb, var(--schegent-color-warning) 18%, transparent);
    color: var(--schegent-color-warning);
    border: 1px solid color-mix(in srgb, var(--schegent-color-warning) 35%, transparent);
  }

  .badge-canceled {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, transparent);
    opacity: 0.7;
  }

  /* ---- Chevron ---- */
  .cell-chevron {
    font-size: 16px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.4;
    align-items: center;
    justify-content: center;
    padding-top: 2px;
    transition: opacity 120ms ease-out;
  }

  .table-row:hover .cell-chevron { opacity: 1; }
</style>
