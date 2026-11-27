<script lang="ts">
  // Feature 097 — individual task row for the Queue Detail table.
  //
  // Extracted from QueueDetailRows.svelte to stay within the repository's
  // 500-line Svelte component LOC budget. This component owns the five cells of
  // a standalone task's row: its run-order number; the task (label with
  // truncation + show more/less, workflow, id and any error); phase progress;
  // the status chip; and timing. The grid those cells sit on, the row's hover
  // and selection, its menu and its drag and move controls belong to
  // QueueDetailRows, which lays a connected run's row out on the same columns.
  // It receives all derived data as props; it performs no IPC and holds no
  // snapshot-level state.

  import type {
    QueueItem,
    PipelineDefinition,
    TaskPhaseProgressProjection
  } from '../../lib/snapshot-types';
  import type { TaskTimingLabel } from '../../lib/task-row-view';
  import { formatDuration } from '../../lib/format-duration';
  import { isHistoricalError, PREVIOUS_FAILURE_LABEL } from '../../lib/last-error-label';
  import { formatTimeOfDay } from '../../lib/format-time-of-day';
  import { queueRowStatusChip } from '../../lib/queue-row-status';

  // Joins the parts of a line that are drawn only sometimes. It is written into
  // the markup as an expression because Svelte drops the space at the start of
  // an element or block, which would leave the dot against the word before it.
  const SEPARATOR = ' · ';

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

  // FR-R3-157 (T043, FR-009) — an absent key and an empty list are the same
  // answer, NOT degraded, so they are collapsed once here rather than in the
  // markup. Two spellings of nothing reaching two renderings is exactly the
  // distinction FR-009 says nothing may draw.
  const degraded = $derived(task.degradedPhases ?? []);

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

  // ---------- Status chip ----------
  const chip = $derived(queueRowStatusChip(task.status));

  // ---------- Timing ----------
  const timingPrimary = $derived(
    timing.kind === 'waiting' ? `waiting ${formatDuration(timing.value)}` : formatDuration(timing.value)
  );

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

  // A pending task has started no phase, so it draws no bar; the figure beside
  // where the bar would be still says how many phases it holds.
  const showBar = $derived(task.status !== 'pending' && segments.length > 0);

  // The phase in flight is drawn in the task's own state: failed and paused
  // tasks mark it in their colour, every other task in the active one. A planned
  // phase takes the bar's plain segment.
  function segmentClass(segment: PhaseSegment): string {
    if (segment.state === 'planned') return '';
    if (task.status === 'failed') return 'f';
    if (task.status === 'paused') return 'w';
    return 'r';
  }
</script>

<button
  type="button"
  class="qrow status-{task.status}"
  data-row-key="task:{task.id}"
  data-testid="queue-task-row-{task.id}"
  data-selected={isSelected ? 'true' : 'false'}
  aria-label="Open run {task.label}"
  onclick={onSelect}
  onkeydown={onKeyDown}
>
  <span class="cell c-num muted">{rowIndex + 1}</span>

  <span class="cell c-task">
    <span class="rowname label">{displayLabel}</span>
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
    <span class="sub">
      <span data-testid="queue-task-pipeline-{task.id}">{pipelineName}{#if pipeline !== undefined && task.currentPipelineId}{SEPARATOR}<span
            class="mono">{task.currentPipelineId}</span>{/if}</span>
      · <span class="mono" data-testid="queue-task-id-{task.id}">{task.id}</span>
    </span>
    {#if task.lastErrorSummary !== null}
      <span class="prompt-error" data-testid="queue-task-error-{task.id}">
        {#if isHistoricalError(task.status)}
          {PREVIOUS_FAILURE_LABEL}: {task.lastErrorSummary}
        {:else}
          ⚠ {task.lastErrorSummary}
        {/if}
      </span>
    {/if}
  </span>

  <span class="cell c-prog" data-testid="queue-task-progress-{task.id}">
    {#if showBar}
      <span class="bar" aria-hidden="true">
        <!-- Quoted, so the value is a plain string: a bare `class={call()}` sends it through
             Svelte's clsx, and that code lands in the chunk the sidebar loads at startup. -->
        {#each segments as seg}
          <span class="{segmentClass(seg)}" title={seg.name}></span>
        {/each}
      </span>
    {/if}
    {#if progress !== null}
      <span
        class="small"
        class:muted={task.status === 'pending'}
        data-testid="queue-task-progress-text-{task.id}"
      >{progress.settled} of {progress.total} phases{#if task.currentPhase}{SEPARATOR}<span class="mono">{task.currentPhase}</span>{/if}</span>
    {:else if task.currentPhase}
      <!--
        FR-R3-158 (T023, FR-014) — no pair, so no figure. The phase the task is in
        is a separate fact the row still knows, and suppressing it because a count
        is missing would hide something true. It renders without the leading
        separator that belongs to the figure.
      -->
      <span class="small"><span class="mono">{task.currentPhase}</span></span>
    {/if}
    {#if task.retryCount > 0}
      <span class="retry" data-testid="queue-task-retry-{task.id}">
        ↻ retried {task.retryCount}&times;
      </span>
    {/if}
    {#if degraded.length > 0}
      <!--
        FR-R3-157 (T043, C4.3) — named, never merely flagged. `phaseId` says which
        phase was let through and `condition` says what it did not satisfy. A mark
        carrying only the word "degraded" would leave the operator the same
        investigation they would have had with no mark at all (FR-010).

        Read straight off the row: the state is decided once on the host (C4.1),
        so there is nothing here to derive it from — no text scanned, no tag
        matched, no phase looked up in the pipeline, no cap rule re-applied.
      -->
      <span class="degraded" data-testid="queue-task-degraded-{task.id}">
        <!-- Keyed by position, not by `phaseId`: a loopable phase can reach its cap
             on more than one visit and append a second entry under the same id, so
             the id is not an identity here. The list is append-only and renders as
             plain text, so position IS the identity — nothing reorders and no node
             holds state that a wrong association could carry across. -->
        {#each degraded as entry, index (index)}
          <span class="degraded-phase">⚠ unverified · {entry.phaseId} · {entry.condition}</span>
        {/each}
      </span>
    {/if}
  </span>

  <span class="cell c-status">
    <span class="chip {chip.tone}" data-testid="queue-task-status-{task.id}">{#if chip.icon === null}<span class="dot" aria-hidden="true"></span>{:else}<svg class="i" aria-hidden="true"><use href={chip.icon}></use></svg>{/if}{chip.label}</span>
  </span>

  <span class="cell c-time" data-testid="queue-task-timing-{task.id}">
    <span class="small time">{timingPrimary}</span>
    <span class="small muted">{timingSecondary}</span>
  </span>
</button>

<style>
  /* The row's grid, its cells' padding, its hover and its selection belong to
     QueueDetailRows, which lays a connected run's row out on the same columns.
     What is here is this row's own content. */
  .label {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .toggle-label {
    all: unset;
    align-self: flex-start;
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-link-fg);
    cursor: pointer;
  }

  .toggle-label:hover { text-decoration: underline; }

  .toggle-label:focus-visible {
    outline: 2px solid var(--schegent-focus-border);
    outline-offset: 2px;
  }

  .prompt-error {
    margin-top: var(--schegent-space-1);
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-error-text);
    overflow-wrap: anywhere;
  }

  /* FR-R3-158 (T023) — the bar draws no settled phases: "done" shading went with
     the ordering that told the phases apart. The phase in flight keeps its
     full-strength mark, and a paused task marks it in the warning colour. */
  .bar .w { background: var(--schegent-color-warning); }

  .retry {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-status-warning-text);
  }

  /* Warning-toned, not error-toned: a degraded run COMPLETED, and borrowing the
     failure treatment would send an operator looking for a failure (C4.3). */
  .degraded { display: flex; flex-direction: column; gap: 1px; }

  .degraded-phase {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-status-warning-text);
    border-left: 2px solid var(--schegent-color-warning);
    padding-left: 5px;
    /* `condition` is operator-authored and rendered as authored (FR-009), up to
       PHASE_RETRY_CONDITION_MAX_LEN. The DSL admits identifiers with no break
       opportunity in them, and one long enough would widen this column and push
       the rest of the row grid out rather than wrapping. Same guard `.prompt-error`
       and `.label` carry above, for the same reason: the text is bounded by a
       validator, the column is not. */
    overflow-wrap: anywhere;
  }

  .time { font-variant-numeric: tabular-nums; }
</style>
