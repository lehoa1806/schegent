<script lang="ts">
  // Feature 092 (T107, FR-055, FR-056, FR-065) — tier 1 of the drill-down.
  //
  // Tier 1 is the existing `operations` route, already labelled 'Queues'. Nothing
  // is added to `DashboardRoute` for it: the tiers are sub-locations addressed by
  // `DashboardLocation`, and `OperationsSurface.svelte` owns that location.
  //
  // Every queue's name is a `<button>`, not a clickable row: FR-059 requires the
  // tiers be operable from the keyboard, and a button is focusable, Enter/Space
  // activated and announced as an action without a single `tabindex` or `role`.
  //
  // This component owns the surface's one `<main>` landmark, so the operations
  // route keeps exactly one however deep the operator has drilled.
  //
  // Mockup: docs/mockup/schegent_redesign_surfaces.html, Queues list. The page is the mockup's
  // table; the `.sg` sheets draw it, and the few rules below only place the tier's own pieces.

  // Feature 095 (T027, US3) — the workspace queue settings open from this tier,
  // because both values are workspace-scoped. They are deliberately not folded
  // into `QueueDetailTier`'s per-queue Settings affordance, which renames the one
  // queue in front of the operator. The redesign moved them from a dialog into the
  // Settings page's Queues section, so "Queue defaults" asks the dashboard shell to
  // open that page there (`dashboard/navigation-context.ts`), as the mockup's does.
  // Opening a page changes nothing, so a secondary window offers it too; the page
  // itself says the window is read-only.

  import { getContext } from 'svelte';

  import { DASHBOARD_NAVIGATION, type DashboardNavigation } from '../../dashboard/navigation-context';
  import { postCommand } from '../../lib/vscode-api';
  import { CMD_CREATE_QUEUE } from '../../lib/messages';
  import { sendCreateQueueIntent, type CreateQueueOutcome } from '../../lib/queue-create-ipc';
  import { queueRuntimeLabel, queueRuntimeTone } from '../../lib/queue-lifecycle-label';
  import { haltedStartFailure, isWorkingARun } from '../../lib/queue-runtime-view';
  import { snapshotStore } from '../../lib/snapshot-store.svelte';
  import type { QueueItem, QueueRuntime } from '../../lib/snapshot-types';

  interface Props {
    /** Every registered queue's runtime, as the v4 snapshot publishes them. */
    queues: readonly QueueRuntime[];
    /** FR-065 — a non-primary window reads every tier but mutates nothing. */
    isPrimary: boolean;
    /**
     * FR-060 — the card the operator last drilled into, so walking back lands on
     * a tier that still shows where they were. The surface remembers it; this
     * tier only reflects it, and holds no selection state of its own.
     */
    selectedQueueId?: string | null;
    /** Reported, not acted on: the surface owns navigation (FR-060). */
    onSelectQueue?: (queueId: string) => void;
  }

  const {
    queues,
    isPrimary,
    selectedQueueId = null,
    onSelectQueue = () => {}
  }: Props = $props();

  // Position is the registry's contiguous order, and it is the order the
  // operator arranged. Sorting here rather than trusting array order means a
  // caller that filters or concatenates cannot reshuffle the tier.
  const ordered = $derived([...queues].sort((a, b) => a.position - b.position));
  // Workspace-scoped, and set in Settings, Queues.
  const defaultQueueId = $derived(snapshotStore.queueSettings.defaultQueueId);
  // FR-R3-124 — the count only. A line naming the concurrency cap would make this list a surface
  // that owes the shared-tree disclosure; Settings, Queues, where the cap is chosen, states both.
  const countLine = $derived(`${ordered.length} ${ordered.length === 1 ? 'queue' : 'queues'}`);
  // The purpose line's second sentence: what opening a queue is for. A secondary window opens a
  // queue and reads its tasks but adds and manages none (FR-065), so its line offers the reading.
  const purposeNextStep = $derived(
    isPrimary ? 'Open a queue to add or manage tasks.' : 'Open a queue to see its tasks.'
  );

  // Absent outside the dashboard, and then "Queue defaults" is not rendered.
  const navigation = getContext<DashboardNavigation | undefined>(DASHBOARD_NAVIGATION);

  let creating = $state(false);
  let draftName = $state('');
  let createPending = $state(false);
  let createError = $state<string | null>(null);
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());

  function openCreate(): void {
    creating = true;
    draftName = '';
    createError = null;
    createPending = false;
  }

  function cancelCreate(): void {
    creating = false;
    draftName = '';
    createError = null;
    createPending = false;
  }

  function applyCreateOutcome(outcome: CreateQueueOutcome): void {
    if (outcome.status === 'accepted') {
      cancelCreate();
    } else if (outcome.status === 'refused') {
      createError = outcome.message;
    }
  }

  async function submitCreate(): Promise<void> {
    // The host owns every bound and the uniqueness rule; the webview only
    // refuses the one input it can judge without a catalog read.
    if (createPending) return;
    const name = draftName.trim();
    if (name.length === 0) return;
    createError = null;
    createPending = true;
    const outcome = await sendCreateQueueIntent({
      type: CMD_CREATE_QUEUE,
      name,
      post: (correlationId, payload) => {
        postCommand(CMD_CREATE_QUEUE, payload, { correlationId });
      },
      signal: lifetime.signal,
      onLateOutcome: applyCreateOutcome
    });
    createPending = false;
    applyCreateOutcome(outcome);
  }

  function onCardKeyDown(event: KeyboardEvent, queueId: string): void {
    // A `<button>` already fires click on Enter and Space in a browser; jsdom
    // does not synthesise that, and an explicit handler also covers hosts where
    // the card is re-rendered as something else.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectQueue(queueId);
  }

  // The "Current run" cell names the Run the queue is working, paused or not. A queue keeps the
  // record of its last Run after the Run ends, and the status chip then reads the queue as no
  // longer working, so an ended Run gets the dash here. The queue's page lists the finished
  // tasks the queue still holds.
  function runLabel(runtime: QueueRuntime): string | null {
    if (!isWorkingARun(runtime)) return null;
    return runtime.inFlightRun?.feature?.label ?? null;
  }

  // A fold over the queue's own rows, as the queue detail counts its throughput.
  function countTasks(runtime: QueueRuntime, status: QueueItem['status']): number {
    return runtime.tasks.filter((task) => task.status === status).length;
  }
</script>

<main data-testid="queues-tier" aria-label="Queues">
  <div class="phead">
    <div>
      <h1>Queues</h1>
      <div class="purpose">Each queue runs its tasks in order. {purposeNextStep}</div>
    </div>
    {#if navigation !== undefined || isPrimary}
      <div class="actions">
        {#if navigation !== undefined}
          <button
            type="button"
            class="btn btn-secondary"
            data-testid="queue-settings-open"
            onclick={() => navigation.openQueueSettings()}
          >
            Queue defaults
          </button>
        {/if}
        {#if isPrimary && !creating}
          <button type="button" class="btn btn-primary" data-testid="queue-create" onclick={openCreate}>
            <svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>New queue
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if creating}
    <div class="toolbar">
      <input
        type="text"
        class="input create-name"
        data-testid="queue-create-name"
        placeholder="Queue name"
        aria-label="New queue name"
        disabled={createPending}
        bind:value={draftName}
      />
      <button
        type="button"
        class="btn btn-primary"
        data-testid="queue-create-submit"
        disabled={createPending}
        onclick={submitCreate}
      >
        {createPending ? 'Creating…' : 'Create'}
      </button>
      <button type="button" class="btn btn-secondary" data-testid="queue-create-cancel" onclick={cancelCreate}>
        Cancel
      </button>
    </div>
    {#if createError !== null}
      <p class="create-error small s-err" role="alert" data-testid="queue-create-error">{createError}</p>
    {/if}
  {/if}

  <!-- Feature 195 (FR-007, FR-008) — a halted queue says so above the list, with the task that
       stopped it, so the operator does not have to find it row by row. Reading it is not an
       action, so a secondary window shows it too. -->
  {#each ordered as runtime (runtime.queueId)}
    {@const halted = haltedStartFailure(runtime)}
    {#if halted !== null}
      <div class="attn" role="status" data-testid="queues-halted-notice-{runtime.queueId}">
        <span class="ic"><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg></span>
        <div class="body">
          <b>{runtime.name} is halted.</b> “{halted.taskName}” failed, so the queue stopped before the next task.
          <div class="acts">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="queues-halted-review-{runtime.queueId}"
              aria-label="Review the failure in {runtime.name}"
              onclick={() => onSelectQueue(runtime.queueId)}
            >
              Review the failure
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/each}

  {#if ordered.length === 0}
    <p class="empty" data-testid="queues-empty">No queues have been registered yet.</p>
  {:else}
    <div class="table-wrap">
      <table class="t">
        <caption class="sr-only">Queues</caption>
        <thead>
          <tr>
            <th scope="col">Queue</th>
            <th scope="col">Status</th>
            <th scope="col">Current run</th>
            <th scope="col" class="num">Pending</th>
            <th scope="col" class="num">Completed</th>
            <th scope="col" class="num">Failed</th>
          </tr>
        </thead>
        <tbody>
          {#each ordered as runtime (runtime.queueId)}
            {@const halted = haltedStartFailure(runtime)}
            {@const failedCount = countTasks(runtime, 'failed')}
            <tr class:sel={runtime.queueId === selectedQueueId}>
              <td>
                <button
                  type="button"
                  class="rowname"
                  data-testid="queue-card-{runtime.queueId}"
                  data-selected={runtime.queueId === selectedQueueId ? 'true' : 'false'}
                  aria-label="Open queue {runtime.name}"
                  onclick={() => onSelectQueue(runtime.queueId)}
                  onkeydown={(event) => onCardKeyDown(event, runtime.queueId)}
                >
                  {runtime.name}
                </button>
                {#if runtime.queueId === defaultQueueId}
                  <span class="tag" data-testid="queue-default-tag">Default</span>
                {/if}
              </td>
              <td>
                <span class="status">
                  <span class="chip {queueRuntimeTone(runtime)}" data-testid="queue-lifecycle-{runtime.queueId}">
                    {#if runtime.lifecycle === 'operator-paused'}
                      <svg class="i" aria-hidden="true"><use href="#i-pause"></use></svg>
                    {:else}
                      <span class="dot" aria-hidden="true"></span>
                    {/if}
                    {queueRuntimeLabel(runtime)}
                  </span>
                  <!-- Feature 187 (FR-004) — beside the badge, not instead of it. The
                       lifecycle is still true; the failed start is why the queue is
                       still in it. Compact by intent: this list distinguishes which
                       queue to look at, and the detail tier says what happened. -->
                  {#if halted !== null}
                    <!-- Feature 195 (T030, FR-007, FR-008) — named and distinct from a plain
                         "Start failed". The notice above the table names the task on screen;
                         the chip names it to a screen reader reading the row. -->
                    <span
                      class="chip s-err"
                      data-testid="queue-halted-{runtime.queueId}"
                      aria-label="Halted: {halted.taskName} failed"
                      title="Halted — {halted.taskName} failed. Retry or remove it to continue."
                    >
                      <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>Halted<span class="sr-only">: {halted.taskName}</span>
                    </span>
                  {:else if runtime.startFailure !== null}
                    <span
                      class="chip s-err"
                      data-testid="queue-start-failed-{runtime.queueId}"
                      aria-label="Last start attempt failed"
                      title="Last start attempt failed — open this queue for details"
                    >
                      <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>Start failed
                    </span>
                  {/if}
                </span>
              </td>
              <td>
                {#if runLabel(runtime) !== null}
                  <span data-testid="queue-active-run-{runtime.queueId}">{runLabel(runtime)}</span>
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td class="num" data-testid="queue-pending-{runtime.queueId}">{runtime.pendingCount}</td>
              <td class="num" data-testid="queue-completed-{runtime.queueId}">{countTasks(runtime, 'completed')}</td>
              <td class="num" class:s-err={failedCount > 0} data-testid="queue-failed-{runtime.queueId}">{failedCount}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="countline" data-testid="queues-countline">{countLine}</p>
  {/if}
</main>

<style>
  .create-name {
    width: 260px;
    max-width: 100%;
  }

  .create-error,
  .empty {
    margin: 0 0 var(--schegent-space-3);
  }

  .status {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--schegent-space-1);
  }
</style>
