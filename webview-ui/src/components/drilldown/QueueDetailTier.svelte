<script lang="ts">
  // Feature 092 (T108, FR-057, FR-064, FR-047, FR-065) — tier 2 of the drill-down.
  //
  // The tier's own chrome is thin on purpose. Everything the operations route
  // already renders for a queue — the pause/resume control, the composer, the
  // active/history tabs, the phase progression — is reused by embedding
  // `Dashboard` scoped to this queue via its one optional `queueId` prop, so this
  // component adds only what is genuinely new: the queue's identity, a throughput
  // reading, a configuration affordance, the row list, and the back step out.
  //
  // Embedding rather than replacing also keeps `Dashboard.svelte` mounted, which
  // `tests/lint/svelte-surface-reachability.test.ts` requires; and the embedded
  // pane owns the surface's single `<main>` landmark, so this component renders a
  // `<section>` and never a second one.
  //
  // Mockup: docs/mockup/schegent_mockup.html `view-queue-detail` and
  // `modal-queue-config`.

  // Feature 095 (US1, US2, US4) — the tier gains the three per-queue controls
  // feature 092 registered commands for and never wired up: delete the queue,
  // arm/disarm its scheduled start, and move a pending Task off it. All three
  // post through `queue-control-ipc.ts` and none of them reaches for a `CMD_`
  // constant; the workspace-scoped settings live a tier up, in `QueuesTier`.
  //
  // The third of those, the per-Task move, lives with the row list in
  // `QueueDetailRows.svelte` — it acts on a Task, not on the queue — and the
  // list went with it (T040). This file kept the queue-level controls and the
  // one refusal line they share; the child reports its refusals up to it.

  import Dashboard from '../Dashboard.svelte';
  import QueueDetailRows from './QueueDetailRows.svelte';
  import { postCommand } from '../../lib/vscode-api';
  import { CMD_RENAME_QUEUE } from '../../lib/messages';
  import { queueLifecycleLabel } from '../../lib/queue-lifecycle-label';
  import { defaultQueueId, findQueueRuntime } from '../../lib/queue-runtime-view';
  import {
    clearQueueSchedule,
    confirmAndDeleteQueue,
    refusalText,
    setQueueSchedule
  } from '../../lib/queue-control-ipc';
  import { formatScheduleTarget, queueSchedule } from '../../lib/queue-schedule-view';
  import type { WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The queue this tier is showing, as its `DashboardLocation` carries it. */
    queueId: string;
    /** FR-065 — a non-primary window reads every tier but mutates nothing. */
    isPrimary: boolean;
    /**
     * FR-060 — the row the operator last drilled into. The surface remembers it
     * so walking back lands on a tier that still shows where they were; this tier
     * only reflects it and holds no selection state of its own.
     */
    selectedRunId?: string | null;
    /** Reported, not acted on: the surface owns navigation (FR-060, FR-061). */
    onBack: () => void;
    onSelectRun?: (runId: string) => void;
  }

  const {
    snapshot,
    queueId,
    isPrimary,
    selectedRunId = null,
    onBack,
    onSelectRun = () => {}
  }: Props = $props();

  const runtime = $derived(findQueueRuntime(snapshot, queueId));
  const tasks = $derived(runtime?.tasks ?? []);
  const queueName = $derived(runtime?.name ?? queueId);

  // Throughput as this queue's own rows report it. Derived rather than published:
  // the counts are a fold over `QueueRuntime.tasks`, and a published total would
  // be a second source of truth for something the rows already say.
  const completedCount = $derived(tasks.filter((task) => task.status === 'completed').length);
  const failedCount = $derived(tasks.filter((task) => task.status === 'failed').length);
  const pendingCount = $derived(runtime?.pendingCount ?? 0);

  // US2 — the queue's registry schedule, read through the one seam. NOT gated on
  // lifecycle: a queue that is actively draining can be armed, and the target
  // must still read. The lifecycle-paired `scheduledStartAt` that
  // `ScheduledStartIndicator` shows is a different mechanism and is left where
  // it is (plan §R4).
  const schedule = $derived(queueSchedule(snapshot, queueId));

  // US1 — the default queue is not deletable. Resolved from the projection the
  // operator can actually change, never from the `'default'` literal.
  const isDefaultQueue = $derived(queueId === defaultQueueId(snapshot));

  let configuring = $state(false);
  let draftName = $state('');
  let draftSchedule = $state('');
  let refusal = $state<string | null>(null);
  let busy = $state(false);

  function openConfig(): void {
    configuring = true;
    draftName = queueName;
    draftSchedule = '';
    refusal = null;
  }

  function closeConfig(): void {
    configuring = false;
    draftName = '';
    draftSchedule = '';
    refusal = null;
  }

  function submitRename(): void {
    // The host owns the uniqueness rule and every bound; the webview refuses only
    // the one input it can judge without reading the registry.
    const name = draftName.trim();
    if (name.length === 0) return;
    postCommand(CMD_RENAME_QUEUE, { queueId, name });
    closeConfig();
  }

  async function deleteThisQueue(event: MouseEvent): Promise<void> {
    refusal = null;
    busy = true;
    try {
      const outcome = await confirmAndDeleteQueue(
        queueId,
        queueName,
        event.currentTarget as HTMLElement
      );
      if (outcome.status === 'deleted') {
        // The queue this tier is showing no longer exists; there is nothing left
        // to render here (FR-005).
        onBack();
        return;
      }
      if (outcome.status === 'refused') refusal = refusalText(outcome.reason);
    } finally {
      busy = false;
    }
  }

  async function armSchedule(): Promise<void> {
    // Verbatim (FR-007). The webview trims the operator's stray whitespace and
    // otherwise neither parses the expression nor computes a target instant —
    // `parseSchedule()` on the host owns the grammar and the arithmetic.
    const expression = draftSchedule.trim();
    if (expression.length === 0) return;
    refusal = null;
    busy = true;
    try {
      const result = await setQueueSchedule(queueId, expression);
      if (result.status === 'rejected') refusal = refusalText(result.reason);
      else draftSchedule = '';
    } finally {
      busy = false;
    }
  }

  async function disarmSchedule(): Promise<void> {
    refusal = null;
    busy = true;
    try {
      const result = await clearQueueSchedule(queueId);
      if (result.status === 'rejected') refusal = refusalText(result.reason);
    } finally {
      busy = false;
    }
  }
</script>

<section class="queue-detail-tier" data-testid="queue-detail-tier">
  <header class="tier-header">
    <button type="button" class="back" data-testid="queue-detail-back" onclick={onBack}>
      &larr; Queues
    </button>
    <div class="identity">
      <h1 data-testid="queue-detail-title">{queueName}</h1>
      <p class="meta">
        <span class="lifecycle" data-testid="queue-detail-lifecycle">
          {runtime === null ? 'Unknown' : queueLifecycleLabel(runtime.lifecycle)}
        </span>
        <span class="throughput" data-testid="queue-detail-throughput">
          {completedCount} completed &middot; {failedCount} failed &middot; {pendingCount} pending
        </span>
      </p>
    </div>
    {#if isPrimary}
      <div class="actions">
        {#if !configuring}
          <button
            type="button"
            data-testid="queue-config-open"
            aria-label="Queue settings"
            onclick={openConfig}
          >Settings</button>
        {/if}
        <!--
          FR-003 — the default queue is the one every unrouted Task lands on, so
          deleting it has no coherent outcome. The control stays visible and
          disabled with the reason attached, rather than disappearing: an absent
          button is the shape this whole feature exists to fix.
        -->
        <button
          type="button"
          class="danger"
          data-testid="queue-delete"
          aria-label="Delete queue"
          disabled={isDefaultQueue || busy}
          aria-describedby={isDefaultQueue ? 'queue-delete-reason' : undefined}
          onclick={deleteThisQueue}
        >Delete Queue</button>
      </div>
    {/if}
  </header>

  {#if isPrimary && isDefaultQueue}
    <p class="hint" id="queue-delete-reason" data-testid="queue-delete-disabled-reason">
      The default queue cannot be deleted. Make another queue the default first.
    </p>
  {/if}

  {#if refusal !== null}
    <p class="refusal" role="alert" data-testid="queue-control-refusal">{refusal}</p>
  {/if}

  {#if configuring}
    <div class="config-row">
      <input
        type="text"
        data-testid="queue-rename-name"
        aria-label="Queue name"
        bind:value={draftName}
      />
      <button type="button" class="primary" data-testid="queue-rename-submit" onclick={submitRename}>
        Rename
      </button>
      <button type="button" data-testid="queue-rename-cancel" onclick={closeConfig}>Cancel</button>
    </div>
  {/if}

  {#if isPrimary}
    <!--
      US2 — the queue's registry schedule (FR-006 to FR-009). The armed reading
      comes from `QueueSummary.schedule`, which the host computed; the expression
      goes back out untouched.
    -->
    <div class="schedule-row" data-testid="queue-schedule">
      {#if schedule !== null}
        <p class="armed" data-testid="queue-schedule-armed">
          <span class="armed-expression">{schedule.expression}</span>
          <span class="armed-target" data-testid="queue-schedule-target">
            starts {formatScheduleTarget(schedule.targetAt)}
          </span>
        </p>
        <button
          type="button"
          data-testid="queue-schedule-disarm"
          disabled={busy}
          onclick={disarmSchedule}
        >Disarm</button>
      {/if}
      <input
        type="text"
        data-testid="queue-schedule-expression"
        aria-label="Schedule expression"
        placeholder="in 30m"
        bind:value={draftSchedule}
      />
      <button
        type="button"
        class="primary"
        data-testid="queue-schedule-arm"
        disabled={busy}
        onclick={armSchedule}
      >{schedule === null ? 'Arm' : 'Re-arm'}</button>
    </div>
  {/if}

  <QueueDetailRows
    {snapshot}
    {queueId}
    {isPrimary}
    {selectedRunId}
    {onSelectRun}
    onRefusal={(text) => (refusal = text)}
  />

  <Dashboard {snapshot} {queueId} />
</section>

<style>
  .queue-detail-tier {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow-y: auto;
  }

  .tier-header {
    display: grid;
    grid-template-areas: 'back back' 'identity action';
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: end;
    padding: 16px 20px 0;
  }

  .back {
    grid-area: back;
    justify-self: start;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
  }

  .identity {
    grid-area: identity;
  }

  .tier-header h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .meta {
    display: flex;
    gap: 12px;
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .lifecycle {
    color: var(--vscode-textLink-foreground);
  }

  button {
    font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
  }

  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }

  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .actions {
    grid-area: action;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  button.danger {
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-widget-border, transparent));
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hint,
  .refusal {
    margin: 0;
    padding: 0 20px;
    font-size: 12px;
  }

  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .refusal {
    color: var(--vscode-errorForeground);
  }

  .config-row,
  .schedule-row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 0 20px;
  }

  .config-row input,
  .schedule-row input {
    flex: 1;
    font: inherit;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .armed {
    display: flex;
    gap: 8px;
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .armed-expression {
    color: var(--vscode-editor-foreground);
  }

</style>
