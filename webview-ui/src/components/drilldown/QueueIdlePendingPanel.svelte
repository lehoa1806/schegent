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
  // `scheduledStartAt` and `migrationNotice` still have no per-queue equivalent
  // on the wire, so they stay what they have always been — the default queue's
  // reading — and are shown only on the default queue's own panel.
  //
  // Gated on `isPrimary` at the mount site in `QueueDetailTier.svelte`, not
  // internally: neither `ScheduledStartIndicator` nor `StartModeChooser`
  // carries its own primacy check, and this component follows the same
  // convention.

  import ScheduledStartIndicator from '../ScheduledStartIndicator.svelte';
  import StartModeChooser, { type StartQueueIntent } from '../StartModeChooser.svelte';
  import { postCommand } from '../../lib/vscode-api';
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
    isDefaultQueue ? snapshot.queue.scheduledStartAt ?? null : null
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

  function onRestartChooserCommit(intent: StartQueueIntent | null): void {
    showRestartChooser = false;
    if (intent === null) return;
    // Chooser already emits a `StartQueueIntent` with `source:'operator-restart'`.
    // Per FR-018 / Q6 the dispatch is once-to-the-queue — this queue, named, so
    // the host does not fall back to the default (hard rule 56).
    postCommand(CMD_START_QUEUE, { queueId, startIntent: intent } as never);
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
    <div class="idle-pending-host" data-testid="idle-pending-start-queue-host">
      <button
        type="button"
        class="start-queue-button"
        data-testid="idle-pending-start-queue-button"
        onclick={onStartQueueClick}
      >
        Start queue
      </button>
    </div>
  {:else}
    <div class="idle-pending-host" data-testid="idle-pending-chooser-host">
      <StartModeChooser onCommit={onRestartChooserCommit} />
    </div>
  {/if}
{/if}
{#if remoteLifecycleChangeStore.active}
  <div
    class="queue-state-changed-notice"
    role="status"
    data-testid="queue-state-changed-elsewhere-notice"
  >
    <span class="notice-text">Queue state changed elsewhere — refresh to continue.</span>
    <button
      type="button"
      class="notice-dismiss"
      data-testid="queue-state-changed-elsewhere-dismiss"
      aria-label="Dismiss notice"
      onclick={() => remoteLifecycleChangeStore.dismiss()}
    >
      Dismiss
    </button>
  </div>
{/if}
{#if migrationNoticeState === 'pending'}
  <div class="migration-notice" role="status" data-testid="migration-notice">
    <span class="notice-text">
      Queue migrated from a previous version. Pending tasks were preserved;
      click "Start queue" when you're ready to resume.
    </span>
    <button
      type="button"
      class="notice-dismiss"
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
    padding: 0 20px;
  }

  .start-queue-button {
    padding: 8px 14px;
    background: var(--sch-accent-gradient, var(--vscode-button-background));
    color: var(--vscode-button-foreground);
    border: 0;
    border-radius: var(--schegent-radius);
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
  }

  .start-queue-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .queue-state-changed-notice,
  .migration-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    margin: 0 20px;
    background: color-mix(
      in srgb,
      var(--vscode-notificationsInfoIcon-foreground, var(--vscode-charts-blue)) 12%,
      transparent
    );
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    color: var(--schegent-fg);
    font-size: 0.85em;
  }

  .notice-text {
    flex: 1 1 auto;
  }

  .notice-dismiss {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 0;
    cursor: pointer;
    padding: 2px 6px;
    font-size: 0.85em;
    text-decoration: underline;
  }
</style>
