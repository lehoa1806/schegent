<script lang="ts">
  // Queue detail owns its task composer, scheduling, controls and row list.
  // Published Workflows use the same validated composition forms as before;
  // every submitted task explicitly targets this Queue.

  import { tick, untrack, type Snippet } from 'svelte';
  import QueueDetailRows from './QueueDetailRows.svelte';
  import QueueComposerDrawer from './QueueComposerDrawer.svelte';
  import QueueControls from '../QueueControls.svelte';
  import QueueIdlePendingPanel from './QueueIdlePendingPanel.svelte';
  import QueueStartFailureNotice from './QueueStartFailureNotice.svelte';
  import SgMenu from '../sg/SgMenu.svelte';
  import { postCommand } from '../../lib/vscode-api';
  import { CMD_RENAME_QUEUE, CMD_PAUSE_QUEUE, CMD_RESUME_QUEUE } from '../../lib/messages';
  import { queueRuntimeLabel, queueRuntimeTone } from '../../lib/queue-lifecycle-label';
  import {
    defaultQueueId, findQueueRuntime, haltedStartFailure,
    isWorkingARun, ownsRun
  } from '../../lib/queue-runtime-view';
  import { clearCompleted, clearQueue, confirmAndDeleteQueue, refusalText, type ClearQueueOutcome, type DeleteQueueOutcome } from '../../lib/queue-control-ipc';
  import { useConfirm } from '../../lib/use-confirm';
  import { deriveCleanAllContext, deriveClearDoneContext } from '../../lib/queue-derived';
  import type { BatchSubmissionState } from '../../lib/task-batch';
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
  //
  // Bug "there is no way to start a pending task" (2026-09-02) — these were one
  // derivation answering two questions, and the wrong one for both. `inFlightRun`
  // is `null` iff the queue owns no Run, so a Run that ended still projects; read
  // as liveness it reported every queue with a stale record as permanently busy,
  // and `QueueControls` offered Pause where Start Queue belonged. See
  // `isWorkingARun` for the whole reading.
  const hasInFlight = $derived(isWorkingARun(runtime));
  const paused = $derived(runtime?.lifecycle === 'operator-paused');
  const haltedFailure = $derived(runtime === null ? null : haltedStartFailure(runtime)); // T031
  const haltedTask = $derived(haltedFailure === null ? null : (tasks.find((t) => t.id === haltedFailure.taskId) ?? null));
  const clearDoneDisabled = $derived(completedCount === 0);
  // Code-review finding (LC-Q-05) — an armed scheduled start is itself
  // something Clean All clears (`QueueManager.clearQueue` reports
  // `wasNoop: false` for a schedule-only queue); the gate below used to omit
  // it, so a queue whose only leftover state was a schedule showed a
  // permanently disabled button with no way to reach the reset that closes
  // LC-Q-05.
  //
  // Code-review finding — computed once here via `deriveCleanAllContext`
  // (below), not a second, independent `runtime?.lifecycle ===
  // 'idle-pending'` read: that context function is also what `onClean`
  // passes to `useConfirm`, so the button-gating predicate and the
  // confirmation copy can never read "armed schedule" two different ways.
  // `QueueSummary.schedule` (`snapshot.queue.queues[].schedule`) is not it —
  // that's the registry-level schedule mechanism `queue-manager.ts`'s own
  // header comment documents as dead in practice (Feature 097 removed its
  // only non-null writer). The armed schedule `QueueManager.clearQueue`
  // actually resets is `QueueState`'s `scheduledStartAt`, and that value IS
  // projected per queue as `QueueRuntime.scheduledStartAt` (FR-R3-152) —
  // which is what `deriveCleanAllContext` reads. An earlier revision of this
  // comment claimed otherwise and inferred the schedule from `lifecycle ===
  // 'idle-pending'`; that was wrong in tree, and `lib/queue-derived.ts`
  // records why.
  const cleanAllContext = $derived(deriveCleanAllContext(snapshot, queueId));
  const cleanDisabled = $derived(
    pendingCount === 0 &&
      completedCount === 0 &&
      failedCount === 0 &&
      canceledCount === 0 &&
      // `ownsRun`, not `hasInFlight`: Clean All clears the active Run record, so a
      // Run that has ended is still something there is to clean.
      !ownsRun(runtime) &&
      !paused &&
      !cleanAllContext.hasSchedule
  );

  // US1 — the default queue is not deletable. Resolved from the projection the
  // operator can actually change, never from the `'default'` literal.
  const isDefaultQueue = $derived(queueId === defaultQueueId(snapshot));

  let renaming = $state(false);
  let draftName = $state('');
  let refusal = $state<string | null>(null);
  let busy = $state(false);
  // FR-R4-F05 (I6, I8, FR-024) — a late answer replaces the not-yet-known text; unmount aborts.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showOutcome(outcome: DeleteQueueOutcome | ClearQueueOutcome): void {
    if (outcome.status === 'deleted') onBack();
    else refusal = outcome.status === 'refused' ? refusalText(outcome.reason) : null;
  }
  const wait = { signal: lifetime.signal, onLateOutcome: showOutcome };

  // T008 (FR-009) & FR-R5-F36 (F36-T06) — closed by default, opened on demand.
  // Single-task submissions auto-close on the first rise above `minPendingCountSinceOpen`.
  // Multi-task batch submissions defer auto-close while `batchState.inFlight` is true,
  // close once the batch finishes with all tasks accepted and a rise observed, and keep
  // the composer open when a batch halts so the operator can inspect and resubmit.
  let composerOpen = $state(false);
  let batchState = $state<BatchSubmissionState>({
    inFlight: false,
    halted: false,
    accepted: 0,
    total: 0
  });
  let minPendingCountSinceOpen = 0;
  let pendingRiseObserved = $state(false);
  // The composer opens in a drawer beside the page (design rule 7). Focus moves
  // into it and comes back to Add work when it closes (rule 10).
  const drawerOpen = $derived(isPrimary && composerOpen);
  let tierRoot = $state<HTMLElement | null>(null);
  let drawer = $state<HTMLElement | null>(null);
  let addTaskButton = $state<HTMLButtonElement | null>(null);

  async function openComposer(): Promise<void> {
    minPendingCountSinceOpen = pendingCount;
    pendingRiseObserved = false;
    batchState = { inFlight: false, halted: false, accepted: 0, total: 0 };
    composerOpen = true;
    await tick();
    (drawer?.querySelector('textarea') ?? drawer?.querySelector('h2'))?.focus();
  }

  // Focus comes back only when the drawer had it: one that closes on its own after a
  // snapshot leaves alone focus the operator has since moved, or a window not in use.
  function closeComposer(): void {
    const active = document.activeElement;
    const focusLeftBehind =
      document.hasFocus() && (active === document.body || drawer?.contains(active) === true);
    composerOpen = false;
    if (focusLeftBehind) void tick().then(() => addTaskButton?.focus());
  }

  // Escape closes the drawer, unless something nearer already answered it — an open
  // menu or a confirmation dialog — or it was pressed outside this page.
  function closeComposerOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !composerOpen) return;
    const target = event.target;
    if (target === document.body || (target instanceof Node && tierRoot?.contains(target) === true)) {
      closeComposer();
    }
  }

  function onBatchStateChange(next: BatchSubmissionState): void {
    if (next.accepted === 0 && !next.halted) {
      minPendingCountSinceOpen = pendingCount;
      pendingRiseObserved = false;
    }
    batchState = next;
  }

  $effect(() => {
    if (!composerOpen) return;
    if (pendingCount < minPendingCountSinceOpen) {
      minPendingCountSinceOpen = pendingCount;
      return;
    }
    if (pendingCount > minPendingCountSinceOpen) {
      pendingRiseObserved = true;
    }
    if (pendingRiseObserved && !batchState.inFlight && !batchState.halted) {
      // Untracked: closing reads which element has focus, which is not this effect's input.
      untrack(closeComposer);
    }
  });

  // Rename… opens a field under the header and puts the cursor in it; closing the field
  // returns focus to the menu it came from.
  let renameRow = $state<HTMLElement | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);
  let actionBar = $state<HTMLElement | null>(null);

  async function openRename(): Promise<void> {
    renaming = true;
    draftName = queueName;
    refusal = null;
    await tick();
    renameInput?.focus();
  }

  function closeRename(): void {
    const focusLeftBehind = renameRow?.contains(document.activeElement) === true;
    renaming = false;
    draftName = '';
    refusal = null;
    if (focusLeftBehind) {
      void tick().then(() => actionBar?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus());
    }
  }

  function submitRename(): void {
    // The host owns the uniqueness rule and every bound; the webview refuses only
    // the one input it can judge without reading the registry.
    const name = draftName.trim();
    if (name.length === 0) return;
    postCommand(CMD_RENAME_QUEUE, { queueId, name });
    closeRename();
  }

  async function deleteThisQueue(event: MouseEvent): Promise<void> {
    refusal = null;
    busy = true;
    try {
      // A deleted queue leaves this tier nothing to render (FR-005): `showOutcome` goes back.
      showOutcome(
        await confirmAndDeleteQueue(queueId, queueName, event.currentTarget as HTMLElement, wait)
      );
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
    // FR-R3-150 (T1621b) — required, addressed to this tier's own queue.
    // Was workspace-global by contract (always cleared Default); the
    // sidebar route no longer relies on that fallback.
    //
    // Code-review finding (iteration 4, FR-011) — confirm+post+correlate now
    // live in `clearCompleted` (mirrors `confirmAndDeleteQueue` above), so a
    // between-confirm `unknown-queue-id` refusal reaches this line, not the void.
    refusal = null;
    const outcome = await clearCompleted(
      queueId,
      deriveClearDoneContext(snapshot, queueId),
      event.currentTarget as HTMLElement,
      wait
    );
    showOutcome(outcome);
  }

  async function onClean(event: MouseEvent): Promise<void> {
    if (cleanDisabled) return;
    // FR-R3-150 (T1618/T1622d) — CMD_CLEAR_QUEUE, addressed to this tier's
    // own queue. Replaces CMD_CLEAR_ALL, which was workspace-global by
    // contract and reset every queue regardless of which one was open
    // (LC-Q-01) — the workspace-wide reset survives only as the Command
    // Palette's separate `schegent.clearAll` (FR-009).
    // Code-review finding (iteration 4, FR-011) — see `onClearDone` above: same fix, via
    // `clearQueue`.
    refusal = null;
    const outcome = await clearQueue(queueId, cleanAllContext, event.currentTarget as HTMLElement, wait);
    showOutcome(outcome);
  }
</script>

<svelte:document onkeydown={closeComposerOnEscape} />

<!-- The header's actions after Start or Pause (design rules 4 and 5): Add work, the page's one
     primary action, then every other queue action in one menu, the destructive ones last. The
     mockup's label is "Add task"; "Add work" is the name the `schegent.schedule` message, the
     default-Workflow setting and the docs send the operator to. -->
{#snippet headerActions(clearItems: Snippet)}
  {#if !composerOpen}
    <button
      type="button"
      class="btn btn-primary"
      data-testid="queue-composer-open"
      bind:this={addTaskButton}
      onclick={openComposer}
    ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>Add work</button>
  {/if}
  <SgMenu label="More queue actions">
    {#if !renaming}
      <button type="button" role="menuitem" data-testid="queue-rename-open" onclick={openRename}>Rename…</button>
      <hr />
    {/if}
    {@render clearItems()}
    <!--
      FR-003 — the default queue is the one every unrouted Task lands on, so
      deleting it has no coherent outcome. The item stays in the menu, disabled,
      with its reason shown under the header, rather than disappearing: an absent
      control is the shape this whole feature exists to fix. It is off through
      `aria-disabled`, which keeps it in reach of the arrow keys, and the menu
      refuses a click on it.
    -->
    <button
      type="button"
      role="menuitem"
      class="danger"
      data-testid="queue-delete"
      aria-disabled={isDefaultQueue || busy}
      aria-describedby={isDefaultQueue ? 'queue-delete-reason' : undefined}
      onclick={deleteThisQueue}
    >Delete queue…</button>
  </SgMenu>
{/snippet}

<main
  class="queue-detail-tier"
  class:page-split={drawerOpen}
  data-testid="queue-detail-tier"
  aria-label="Queue detail"
  bind:this={tierRoot}
>
  <div class="tier-page" class:page={drawerOpen}>
    <!-- Design rule 4: where you are, what this queue is and its state, then what you can do.
         A div, not a header: the dashboard counts the icons its headers draw. -->
    <div class="phead">
      <div>
        <nav class="crumbs" aria-label="Breadcrumb">
          <button type="button" class="linkbtn" data-testid="queue-detail-back" onclick={onBack}>Queues</button>
          <span class="muted" aria-hidden="true">/</span>
        </nav>
        <div class="titlerow">
          <h1 data-testid="queue-detail-title">{queueName}</h1>
          <span class="chip {runtime === null ? 's-idle' : queueRuntimeTone(runtime)}" data-testid="queue-detail-lifecycle">
            {#if paused}<svg class="i" aria-hidden="true"><use href="#i-pause"></use></svg>{:else}<span class="dot" aria-hidden="true"></span>{/if}{runtime === null ? 'Unknown' : queueRuntimeLabel(runtime)}
          </span>
          {#if haltedFailure !== null}
            <span class="chip s-err" data-testid="queue-detail-halted"><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>Halted</span>
          {/if}
          {#if isDefaultQueue}<span class="tag">Default queue</span>{/if}
        </div>
        <div class="meta" data-testid="queue-detail-throughput">
          {completedCount} completed · {failedCount} failed · {pendingCount} pending
        </div>
      </div>
      {#if isPrimary}
        <div class="actions" bind:this={actionBar}>
          <QueueControls
            {isPrimary}
            {queueId}
            {paused}
            {pendingCount}
            {hasInFlight}
            {clearDoneDisabled}
            {cleanDisabled}
            queueLifecycle={runtime?.lifecycle ?? null}
            {haltedTask}
            {onResume}
            {onPause}
            {onClearDone}
            {onClean}
            actions={headerActions}
          />
        </div>
      {/if}
    </div>

    {#if isPrimary && isDefaultQueue}
      <p class="hint" id="queue-delete-reason" data-testid="queue-delete-disabled-reason">
        The default queue cannot be deleted. Make another queue the default first.
      </p>
    {/if}

    <!-- Design rule 6: a refused action is a problem, so it shows in an attention banner. -->
    {#if refusal !== null}
      <div class="attn" role="alert" data-testid="queue-control-refusal">
        <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg><span class="body">{refusal}</span>
      </div>
    {/if}

    {#if renaming}
      <div class="rename-row" bind:this={renameRow}>
        <input
          type="text"
          class="input"
          data-testid="queue-rename-name"
          aria-label="Queue name"
          bind:value={draftName}
          bind:this={renameInput}
        />
        <button type="button" class="btn btn-primary" data-testid="queue-rename-submit" onclick={submitRename}>Rename</button>
        <button type="button" class="btn btn-secondary" data-testid="queue-rename-cancel" onclick={closeRename}>Cancel</button>
      </div>
    {/if}

    <!-- Feature 187 (FR-001) — above the idle-pending panel, because the two say
         opposite things about the same queue and only one of them is news: "this
         queue is waiting for you to start it" reads as normal, and "the last start
         already failed" is why it is still waiting. Ungated by `isPrimary`, unlike
         the panel below, which owns a Start a secondary window may not dispatch. -->
    <QueueStartFailureNotice {queueId} startFailure={runtime?.startFailure ?? null} />

    {#if isPrimary}
      <QueueIdlePendingPanel {snapshot} {queueId} />
    {/if}

    <QueueDetailRows
      {snapshot}
      {queueId}
      {isPrimary}
      {selectedRunId}
      {onSelectRun}
      onRefusal={(text) => (refusal = text)}
    />
  </div>

  {#if drawerOpen}
    <!-- Design rule 7: a form that adds something opens in a drawer beside the page, so the
         queue it adds to stays in view. Feature 285 (OD-2, FR-002): always the composer. Its
         sections render their own loading arm until the catalogs resolve; the Pipeline-listing
         form is retired. -->
    <aside class="drawer" aria-labelledby="queue-composer-heading" data-testid="queue-composer" bind:this={drawer}>
      <QueueComposerDrawer {snapshot} {queueId} {queueName} {pendingCount} {onBatchStateChange} onClose={closeComposer} />
    </aside>
  {/if}
</main>

<style>
  /* A plain block on the operations page until the add-task drawer opens. Then the tier
     splits into its page and the drawer, each scrolling on its own; narrower than 860px,
     where the redesign hides its drawers, the drawer takes the whole width instead. */
  .queue-detail-tier { min-height: 0; }
  .page-split { display: flex; flex: 1; }
  .hint { margin: 0 0 var(--schegent-space-3); }
  .rename-row {
    display: flex; gap: var(--schegent-space-1-5); align-items: center;
    margin-bottom: var(--schegent-space-3);
  }
  .rename-row .input { flex: 1; min-width: 0; }
  @media (max-width: 860px) {
    .page-split > .tier-page { display: none; }
    .page-split > .drawer { flex: 1; width: auto; border-left: 0; }
  }
</style>

