<script lang="ts">
  // Feature 065 (T040) — Scheduled-start indicator. Renders the countdown
  // for an `idle-pending` queue with `scheduledStartAt` set, and exposes
  // three FR-015 affordances: Cancel, Change, Start now.
  //
  // Cadence: subscribes to `nowFine` (1s tick) when `collapsed === false`,
  // `nowCoarse` (1min tick) otherwise. Both stores are derived from a
  // single host interval so SC-007 (max-60s lag) holds without a second
  // timer.
  //
  // Action routing (per T041):
  //   - Cancel    → CMD_START_QUEUE { startIntent: { cancel-schedule, operator-restart } }
  //   - Change    → opens an inline StartModeChooser in idle-pending-restart mode
  //   - Start now → CMD_START_QUEUE { startIntent: { now, operator-restart } }
  //
  // The component does NOT mount when `scheduledStartAt` is `null` or
  // `undefined` (e.g. the chooser committed `Start in 00:00` which collapses
  // to `startMode: 'now'` and never arms a timer; per Edge Cases line 121,
  // the indicator MUST NOT flash for a single render tick on that path).

  import { nowFine, nowCoarse } from '../lib/tick-store';
  import { postCommand } from '../lib/vscode-api';
  import { CMD_START_QUEUE } from '../lib/messages';
  import StartModeChooser, { type StartQueueIntent } from './StartModeChooser.svelte';
  import { findQueueRuntime } from '../lib/queue-runtime-view';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { remoteLifecycleChangeStore } from '../lib/remote-lifecycle-change-store.svelte';

  interface Props {
    /** The queue whose schedule this is — named on every dispatch, so the host
     *  does not fall back to the default queue (hard rule 56). */
    readonly queueId: string;
    readonly scheduledStartAt: number;
    readonly collapsed?: boolean;
  }

  const { queueId, scheduledStartAt, collapsed = false }: Props = $props();

  // Subscribe to the appropriate tick stream. Svelte stores are auto-subscribed
  // by referencing `$nowFine` / `$nowCoarse` in derived state.
  const nowMs = $derived(collapsed ? $nowCoarse : $nowFine);

  const remainingMs = $derived(Math.max(0, scheduledStartAt - nowMs));

  const countdownText = $derived(formatCountdown(remainingMs, scheduledStartAt, nowMs));

  const resolvedFireTime = $derived(formatResolvedFireTime(scheduledStartAt));

  let showChooser = $state(false);

  // FR-019a — if the chooser is mounted (operator pressed Change) and this
  // queue's lifecycle transitions OUT of `idle-pending` (e.g. another window
  // committed a state change), silently unmount the chooser and surface the
  // "queue state changed elsewhere" notice. We don't dispatch any IPC.
  //
  // Read against `queueId`: `snapshot.queue` is the default queue's projection,
  // so on any other queue's panel this effect used to fire on a lifecycle the
  // operator was not looking at and pull the chooser out from under them.
  const queueLifecycleForChooser = $derived(
    findQueueRuntime(snapshotStore.snapshot, queueId)?.lifecycle ?? null
  );
  $effect(() => {
    if (
      showChooser &&
      queueLifecycleForChooser !== null &&
      queueLifecycleForChooser !== 'idle-pending'
    ) {
      showChooser = false;
      remoteLifecycleChangeStore.notifyChangedElsewhere();
    }
  });

  function pad(n: number): string {
    return n.toString().padStart(2, '0');
  }

  function formatCountdown(remaining: number, target: number, now: number): string {
    // Within an hour: show HH:MM:SS countdown (or MM:SS when collapsed).
    // Beyond an hour: show "starts at HH:MM today/tomorrow".
    if (remaining < 60 * 60 * 1000) {
      const totalSec = Math.floor(remaining / 1000);
      const hh = Math.floor(totalSec / 3600);
      const mm = Math.floor((totalSec % 3600) / 60);
      const ss = totalSec % 60;
      return `starts in ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    }
    const targetDate = new Date(target);
    const nowDate = new Date(now);
    const isToday =
      targetDate.getFullYear() === nowDate.getFullYear() &&
      targetDate.getMonth() === nowDate.getMonth() &&
      targetDate.getDate() === nowDate.getDate();
    const dayWord = isToday ? 'today' : 'tomorrow';
    return `starts at ${pad(targetDate.getHours())}:${pad(targetDate.getMinutes())} ${dayWord}`;
  }

  function formatResolvedFireTime(target: number): string {
    const d = new Date(target);
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    return `${yyyy}-${mm}-${dd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function onCancel(): void {
    postCommand(CMD_START_QUEUE, {
      queueId,
      startIntent: {
        startMode: 'cancel-schedule',
        source: 'operator-restart'
      }
    } as never);
  }

  function onStartNow(): void {
    postCommand(CMD_START_QUEUE, {
      queueId,
      startIntent: {
        startMode: 'now',
        source: 'operator-restart'
      }
    } as never);
  }

  function onChange(): void {
    showChooser = true;
  }

  function onChooserCommit(intent: StartQueueIntent | null): void {
    showChooser = false;
    if (intent === null) return;
    // Chooser already emits a `StartQueueIntent` with
    // `source: 'operator-restart'` (T027 simplification — Feature 065).
    postCommand(CMD_START_QUEUE, { queueId, startIntent: intent } as never);
  }
</script>

<div class="scheduled-start-indicator" title={resolvedFireTime}>
  <span class="countdown" data-testid="scheduled-start-countdown">{countdownText}</span>
  <span class="resolved-fire-time" data-testid="scheduled-start-fire-time">
    {resolvedFireTime}
  </span>
  <div class="actions">
    <button
      type="button"
      class="btn btn-cancel"
      data-testid="scheduled-start-cancel"
      onclick={onCancel}
    >
      Cancel
    </button>
    <button
      type="button"
      class="btn btn-change"
      data-testid="scheduled-start-change"
      onclick={onChange}
    >
      Change
    </button>
    <button
      type="button"
      class="btn btn-start-now"
      data-testid="scheduled-start-now"
      onclick={onStartNow}
    >
      Start now
    </button>
  </div>

  {#if showChooser}
    <div class="chooser-host" data-testid="scheduled-start-chooser-host">
      <StartModeChooser onCommit={onChooserCommit} />
    </div>
  {/if}
</div>

<style>
  .scheduled-start-indicator {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
  }
  .countdown {
    font-weight: 600;
  }
  .resolved-fire-time {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .btn {
    padding: 0.25rem 0.75rem;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0;
    border-radius: 2px;
    cursor: pointer;
  }
  .btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .chooser-host {
    margin-top: 0.5rem;
  }
</style>
