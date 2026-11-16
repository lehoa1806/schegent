<script lang="ts">
  // T012 (FR-014, FR-016, research.md R5) — Mechanism A, relocated from the
  // deleted `QueueListView.svelte` (feature 065) unmodified in logic, then
  // split out of `QueueDetailTier.svelte` by T012a to keep that file under
  // the repository's 500-line component budget (SC-008).
  //
  // This is the FR-018 surface that owns starting an `idle-pending` queue —
  // `QueueControls` deliberately suppresses its own Start branch for that
  // lifecycle — and hard rule 31 forbids anything promoting such a queue
  // without an operator trigger. So the gate has to be the lifecycle of the
  // queue on screen: reading the default queue's projection (`snapshot.queue`,
  // which the composer pins to `DEFAULT_QUEUE_ID`) rendered nothing at all for
  // every other queue, leaving its pending work with no way to start.
  //
  // FR-R3-152 (T1633) — `scheduledStartAt` now has a per-queue equivalent on
  // the wire (`QueueRuntime.scheduledStartAt`/`scheduledStartSource`), so this
  // panel reads the selected queue's own runtime for it like every other
  // per-queue field above, default included: no queue may follow a different
  // code path than any other to reach this display. `migrationNotice` is
  // unchanged and stays the default queue's own one-time reading — it is a
  // one-time migration notice by design (Feature 065), not a per-queue
  // schedule, and is out of this filing's scope.
  //
  // Gated on `isPrimary` at the mount site in `QueueDetailTier.svelte`, not
  // internally: neither `ScheduledStartIndicator` nor `StartModeChooser`
  // carries its own primacy check, and this component follows the same
  // convention.

  import ScheduledStartIndicator from '../ScheduledStartIndicator.svelte';
  import StartModeChooser, { type StartQueueIntent } from '../StartModeChooser.svelte';
  import { postCommand } from '../../lib/vscode-api';
  import { correlatedLifecycle, lifecycleMessage, lifecycleWait } from '../../lib/lifecycle-control-ipc';
  import { CMD_START_QUEUE, CMD_DISMISS_MIGRATION_NOTICE } from '../../lib/messages';
  import { defaultQueueId, findQueueRuntime } from '../../lib/queue-runtime-view';
  import { remoteLifecycleChangeStore } from '../../lib/remote-lifecycle-change-store.svelte';
  import type { QueueLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The queue this panel is shown for — the one its Start dispatch names. */
    queueId: string;
  }

  const { snapshot, queueId }: Props = $props();

  const queueLifecycle = $derived<QueueLifecycle | null>(
    findQueueRuntime(snapshot, queueId)?.lifecycle ?? null
  );
  const isDefaultQueue = $derived(queueId === defaultQueueId(snapshot));
  const scheduledStartAt = $derived<number | null>(
    findQueueRuntime(snapshot, queueId)?.scheduledStartAt ?? null
  );
  const migrationNoticeState = $derived<'pending' | 'dismissed' | undefined>(
    isDefaultQueue ? snapshot.queue.migrationNotice : undefined
  );

  let showRestartChooser = $state(false);

  // FR-019a — if the restart chooser is mounted and this queue's lifecycle
  // leaves `idle-pending` (e.g. another window committed a state change),
  // silently unmount and surface the "queue state changed elsewhere" notice.
  $effect(() => {
    if (showRestartChooser && queueLifecycle !== null && queueLifecycle !== 'idle-pending') {
      showRestartChooser = false;
      remoteLifecycleChangeStore.notifyChangedElsewhere();
    }
  });

  function onStartQueueClick(): void {
    showRestartChooser = true;
  }

  // FR-R3-154 (T1646) — what the host answered about the last start, as one
  // sentence, or `null` when it committed. This panel is the FR-018 chooser's
  // sole dispatcher, so a `rejected-horizon` refusal of the operator's chosen
  // time surfaced nowhere at all: the chooser closed and the queue stayed idle.
  let startMessage = $state<string | null>(null);
  // FR-R4-F05 (O4, FR-024, FR-026) — a late answer replaces the interim text; unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  const wait = lifecycleWait(lifetime.signal, (message) => (startMessage = message));

  async function onRestartChooserCommit(intent: StartQueueIntent | null): Promise<void> {
    showRestartChooser = false;
    if (intent === null) return;
    startMessage = null;
    // Chooser already emits a `StartQueueIntent` with `source:'operator-restart'`.
    // Per FR-018 / Q6 the dispatch is once-to-the-queue — this queue, named, so
    // the host does not fall back to the default (hard rule 56).
    startMessage = lifecycleMessage(
      await correlatedLifecycle(
        CMD_START_QUEUE,
        { queueId, startIntent: intent },
        (correlationId, payload) => {
          postCommand(CMD_START_QUEUE, payload as never, { correlationId });
        },
        wait
      )
    );
  }

  function onMigrationNoticeDismiss(): void {
    postCommand(CMD_DISMISS_MIGRATION_NOTICE);
  }
</script>

{#if queueLifecycle === 'idle-pending'}
  {#if scheduledStartAt !== null}
    <div class="idle-pending-host" data-testid="idle-pending-scheduled-host">
      <ScheduledStartIndicator {queueId} {scheduledStartAt} />
    </div>
  {:else if !showRestartChooser}
    <!-- The action that resolves the queue's state, drawn as the redesign draws one: primary. -->
    <div class="idle-pending-host" data-testid="idle-pending-start-queue-host">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="idle-pending-start-queue-button"
        onclick={onStartQueueClick}
      ><svg class="i" aria-hidden="true"><use href="#i-play"></use></svg>Start queue</button>
    </div>
  {:else}
    <!-- The chooser draws no frame of its own; here it stands alone, so it gets a card. -->
    <div class="idle-pending-host card" data-testid="idle-pending-chooser-host">
      <StartModeChooser onCommit={onRestartChooserCommit} />
    </div>
  {/if}
  {#if startMessage !== null}
    <p class="start-message" role="alert" data-testid="idle-pending-start-message">{startMessage}</p>
  {/if}
{/if}
<!-- Both notices are drawn as the redesign's warning banner (`.attn.warn` in `sg-core.css`):
     each asks the operator to do something, and each is theirs to put away. -->
{#if remoteLifecycleChangeStore.active}
  <div
    class="attn warn"
    role="status"
    data-testid="queue-state-changed-elsewhere-notice"
  >
    <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
    <span class="body">Queue state changed elsewhere — refresh to continue.</span>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="queue-state-changed-elsewhere-dismiss"
      aria-label="Dismiss notice"
      onclick={() => remoteLifecycleChangeStore.dismiss()}
    >
      Dismiss
    </button>
  </div>
{/if}
{#if migrationNoticeState === 'pending'}
  <div class="attn warn" role="status" data-testid="migration-notice">
    <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
    <span class="body">
      Queue migrated from a previous version. Pending tasks were preserved;
      click "Start queue" when you're ready to resume.
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="migration-notice-dismiss"
      aria-label="Dismiss migration notice"
      onclick={onMigrationNoticeDismiss}
    >
      Dismiss
    </button>
  </div>
{/if}

<style>
  .idle-pending-host {
    margin-bottom: var(--schegent-space-3);
  }

  /* In error text, as the queue header's own start message reads: the same answer to the
     same command. */
  .start-message {
    margin: 0 0 var(--schegent-space-3);
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-error-text);
  }
</style>
