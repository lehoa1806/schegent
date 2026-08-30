<script lang="ts">
  // Feature 092 (T108, FR-057, FR-064, FR-047, FR-065) — tier 2 of the drill-down.
  //
  // Feature 097 gave this tier its own `<main>` landmark and retired the
  // `Dashboard` embed it used to reuse the operations route's chrome through:
  // that embed duplicated the Task list already extracted into
  // `QueueDetailRows.svelte`, kept a composer permanently open, and showed a
  // "recent runs" tab scoped to the wrong queue. This file now owns
  // everything the queue detail view renders directly — identity, a
  // throughput reading, the configuration affordance, and the row list.
  //
  // Mockup: docs/mockup/schegent_mockup.html `view-queue-detail` and
  // `modal-queue-config`.

  // Feature 095 (US1, US2, US4) — the tier gained three per-queue controls
  // feature 092 registered commands for and never wired up: delete the queue,
  // arm/disarm its scheduled start, and move a pending Task off it. All three
  // posted through `queue-control-ipc.ts` and none of them reached for a `CMD_`
  // constant; the workspace-scoped settings live a tier up, in `QueuesTier`.
  //
  // Feature 097 removes the second of those, the scheduled-start control,
  // along with its command handlers and validators. The third, the per-Task
  // move, lives with the row list in `QueueDetailRows.svelte` — it acts on a
  // Task, not on the queue — and the list went with it (T040). This file
  // kept the one remaining queue-level control (delete) and the refusal line
  // it shares with the child, which reports its own refusals up to it.

  import QueueDetailRows from './QueueDetailRows.svelte';
  import QueueInputForm from '../QueueInputForm.svelte';
  import QueueControls from '../QueueControls.svelte';
  import QueueIdlePendingPanel from './QueueIdlePendingPanel.svelte';
  import { postCommand } from '../../lib/vscode-api';
  import {
    CMD_RENAME_QUEUE,
    CMD_PAUSE_QUEUE,
    CMD_RESUME_QUEUE,
    CMD_CLEAR_COMPLETED,
    CMD_CLEAR_ALL
  } from '../../lib/messages';
  import { queueLifecycleLabel } from '../../lib/queue-lifecycle-label';
  import { defaultQueueId, findQueueRuntime } from '../../lib/queue-runtime-view';
  import { confirmAndDeleteQueue, refusalText } from '../../lib/queue-control-ipc';
  import { useConfirm } from '../../lib/use-confirm';
  import { deriveCleanAllContext } from '../../lib/queue-derived';
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
  const canceledCount = $derived(tasks.filter((task) => task.status === 'canceled').length);
  const pendingCount = $derived(runtime?.pendingCount ?? 0);

  // T012a (FR-017) — `QueueControls`' own props, read from this tier's own
  // `runtime` rather than `Dashboard.svelte`'s removed `QueueProjection`.
  // `paused` reads `runtime.lifecycle` rather than `runtime.manualPause`:
  // `manualPause` is Run-scoped (`queue-runtime-composer.ts`) and stays
  // `null` for a queue that is operator-paused but owns no in-flight Run,
  // whereas `lifecycle` and the legacy `QueueProjection.paused` are written
  // atomically together on every pause/resume transition
  // (`queue-manager.ts`).
  const hasInFlight = $derived((runtime?.inFlightRun ?? null) !== null);
  const paused = $derived(runtime?.lifecycle === 'operator-paused');
  const clearDoneDisabled = $derived(completedCount === 0);
  const cleanDisabled = $derived(
    pendingCount === 0 &&
      completedCount === 0 &&
      failedCount === 0 &&
      canceledCount === 0 &&
      !hasInFlight &&
      !paused
  );

  // T008 (FR-009, data-model.md `ComposerVisibility`) — the add-work
  // composer's own prop sources, mirroring `Dashboard.svelte`'s prior
  // derivation byte-for-byte (research.md R3).
  const availablePipelines = $derived(snapshot.availablePipelines ?? []);
  const defaultPipelineId = $derived(snapshot.generalSettings?.defaultPipelineId ?? '');

  // US1 — the default queue is not deletable. Resolved from the projection the
  // operator can actually change, never from the `'default'` literal.
  const isDefaultQueue = $derived(queueId === defaultQueueId(snapshot));

  let configuring = $state(false);
  let draftName = $state('');
  let refusal = $state<string | null>(null);
  let busy = $state(false);

  // T008 (FR-009) — closed by default, opened on demand. `QueueInputForm`
  // posts its own submission command internally and exposes no
  // event-handler props (research.md R3): it is mounted unmodified, so
  // "successful submission" is observed the only way the parent can — a rise
  // in this queue's own pending count while the composer is open, which is
  // exactly what a newly-enqueued Task produces.
  let composerOpen = $state(false);
  // The lowest pending count observed since open, not a frozen open-time
  // snapshot: this queue's own pending count falls on its own whenever a
  // pending Task starts executing, independent of the composer. Comparing
  // only against the value at open time would let that fall mask a real
  // submission's rise (open at 3, drain to 2, submit back to 3 — 3 > 3 is
  // false). Tracking the lowest point seen and closing on any rise above it
  // catches the submission regardless of how much unrelated queue activity
  // happened while the composer was open.
  let minPendingCountSinceOpen = 0;

  function openComposer(): void {
    minPendingCountSinceOpen = pendingCount;
    composerOpen = true;
  }

  function closeComposer(): void {
    composerOpen = false;
  }

  $effect(() => {
    if (!composerOpen) return;
    if (pendingCount < minPendingCountSinceOpen) {
      minPendingCountSinceOpen = pendingCount;
      return;
    }
    if (pendingCount > minPendingCountSinceOpen) composerOpen = false;
  });

  function openConfig(): void {
    configuring = true;
    draftName = queueName;
    refusal = null;
  }

  function closeConfig(): void {
    configuring = false;
    draftName = '';
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

  // T012a (FR-017) — relocated from `Dashboard.svelte`'s `onPause`/`onResume`/
  // `onClearDone`/`onClean`, unmodified in logic. That file was replaced by the
  // task-first operations surface in `ea391673`, so this is the only copy left.
  // `Dashboard.svelte`'s `postQueueCommand()` wrapper branched on an optional
  // `queueId` prop; this tier's `queueId` is required, so that branch is dead
  // here and the calls are inlined directly.
  async function onPause(event: MouseEvent): Promise<void> {
    const ok = await useConfirm('queue.pause', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postCommand(CMD_PAUSE_QUEUE, { queueId });
  }

  async function onResume(event: MouseEvent): Promise<void> {
    const ok = await useConfirm('queue.resume', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postCommand(CMD_RESUME_QUEUE, { queueId });
  }

  async function onClearDone(event: MouseEvent): Promise<void> {
    if (clearDoneDisabled) return;
    const ok = await useConfirm('queue.clear-done', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { completedCount }
    });
    if (!ok) return;
    // CMD_CLEAR_COMPLETED carries no queueId — it is workspace-global by
    // contract (sidebar-ipc.ts), exactly as Dashboard.svelte posted it.
    postCommand(CMD_CLEAR_COMPLETED);
  }

  async function onClean(event: MouseEvent): Promise<void> {
    if (cleanDisabled) return;
    const ok = await useConfirm('queue.clean-all', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: deriveCleanAllContext(snapshot)
    });
    if (!ok) return;
    // CMD_CLEAR_ALL carries no queueId — it is workspace-global by contract
    // (sidebar-ipc.ts), exactly as Dashboard.svelte posted it.
    postCommand(CMD_CLEAR_ALL);
  }
</script>

<main class="queue-detail-tier" data-testid="queue-detail-tier" aria-label="Queue detail">
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
          <span class="count-completed">{completedCount} completed</span>
          <span class="sep">&middot;</span>
          <span class="count-failed">{failedCount} failed</span>
          <span class="sep">&middot;</span>
          <span class="count-pending">{pendingCount} pending</span>
        </span>
      </p>
    </div>
    {#if isPrimary}
      <div class="actions">
        <div class="action-group action-group--primary">
          {#if !composerOpen}
            <button
              type="button"
              class="primary"
              data-testid="queue-composer-open"
              aria-label="Add work"
              onclick={openComposer}
            >Add work</button>
          {/if}
          {#if !configuring}
            <button
              type="button"
              data-testid="queue-config-open"
              aria-label="Queue settings"
              onclick={openConfig}
            >Settings</button>
          {/if}
        </div>
        <div class="action-group action-group--controls">
          <QueueControls
            {isPrimary}
            {paused}
            {pendingCount}
            {hasInFlight}
            {clearDoneDisabled}
            {cleanDisabled}
            queueLifecycle={runtime?.lifecycle ?? null}
            {onResume}
            {onPause}
            {onClearDone}
            {onClean}
          />
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
    <QueueIdlePendingPanel {snapshot} />
  {/if}

  {#if isPrimary && composerOpen}
    <div class="composer-row" data-testid="queue-composer">
      <QueueInputForm {availablePipelines} {defaultPipelineId} {pendingCount} {queueId} />
      <button type="button" data-testid="queue-composer-cancel" onclick={closeComposer}>
        Cancel
      </button>
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
</main>

<style>
  .queue-detail-tier {
    display: flex; flex-direction: column; gap: 12px;
    min-height: 0; overflow-y: auto;
  }
  .tier-header {
    display: grid;
    grid-template-areas: 'back back' 'identity action';
    grid-template-columns: 1fr auto;
    gap: 8px; align-items: end; padding: 16px 20px 0;
  }
  .back {
    grid-area: back; justify-self: start; padding: 2px 0;
    border: 0; background: transparent;
    color: var(--vscode-descriptionForeground);
  }
  .identity { grid-area: identity; }
  .tier-header h1 {
    margin: 0 0 4px; font-size: 20px; font-weight: 600;
    color: var(--vscode-editor-foreground);
  }
  .meta {
    display: flex; gap: 12px; margin: 0; font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .lifecycle { color: var(--vscode-textLink-foreground); }

  /* Throughput status colors — each count uses its semantic color */
  .throughput { display: inline-flex; align-items: center; gap: 6px; }
  .count-completed { color: var(--schegent-color-completed); }
  .count-failed { color: var(--schegent-color-error); }
  .count-pending { color: var(--schegent-color-active); }
  .sep { color: var(--schegent-muted-fg); user-select: none; }

  button {
    font: inherit; color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px; padding: 6px 12px; cursor: pointer;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  /* Primary actions (left) | separator | queue-state / destructive (right) */
  .actions { grid-area: action; display: flex; gap: 8px; align-items: center; }
  .action-group { display: flex; gap: 6px; align-items: center; }
  .action-group--controls {
    display: flex; gap: 6px; align-items: center;
    border-left: 1px solid var(--schegent-divider);
    padding-left: 8px;
  }

  button.danger {
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-widget-border, transparent));
  }
  button:disabled { opacity: 0.5; cursor: default; }

  .hint, .refusal { margin: 0; padding: 0 20px; font-size: 12px; }
  .hint { color: var(--vscode-descriptionForeground); }
  .refusal { color: var(--vscode-errorForeground); }

  .config-row { display: flex; gap: 8px; align-items: center; padding: 0 20px; }
  .config-row input {
    flex: 1; font: inherit; padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  .composer-row {
    display: flex; flex-direction: column;
    align-items: stretch; gap: 8px; padding: 0 20px;
  }
</style>

