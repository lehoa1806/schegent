<script lang="ts">
  // Feature 092 (T112, T113, T115, FR-058..FR-062, FR-065) — the `operations`
  // route's owner, and the only thing that holds a `DashboardLocation`.
  //
  // `App.svelte` still routes to exactly one component here; which of the three
  // tiers that component shows is a location, and the location lives in this
  // file. Keeping it here rather than in `App.svelte` is what lets
  // `DashboardRoute` stay the seven flat siblings it has always been (FR-061):
  // the tiers are sub-locations beneath `operations`, not nav peers of Settings,
  // and `runs` remains a peer of tier 1 rather than becoming a fourth tier
  // (FR-063).
  //
  // Two things are owned here and nowhere else:
  //
  //   * **Resolution** (FR-062). A location is operator state and the snapshot
  //     is host state, so a destination can stop existing between one snapshot
  //     and the next — a queue deleted, a Run swept from history. Rather than
  //     mutating the location when that happens, the rendered tier is *derived*
  //     from both: `resolveLocation` walks up to the nearest surviving tier and
  //     says why. Deriving rather than correcting means there is no
  //     write-during-update, and a destination that comes back — a snapshot that
  //     briefly omitted a queue — resolves again on its own.
  //
  //   * **Position** (FR-060, SC-007). One scroll container for all three tiers,
  //     with the offset remembered per location key, so walking back lands where
  //     the operator was rather than at the top. The selection they left behind
  //     is passed back down the same way; the tiers reflect it and store none of
  //     it themselves.
  //
  // Every tier is handed `isPrimary` from the snapshot root (FR-065) and offers
  // no mutating control without it. Travel stays available in a non-primary
  // window — reading is not a mutation.

  import QueuesTier from './drilldown/QueuesTier.svelte';
  import { findQueueRuntime } from '../lib/queue-runtime-view';
  import {
    DEFAULT_DASHBOARD_LOCATION,
    parentLocation,
    queueDetailLocation,
    runDetailLocation,
    type DashboardLocation
  } from '../dashboard/routes';
  import type { WorkflowSnapshot } from '../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
  }

  const { snapshot }: Props = $props();

  // Tier 1 is what `operations` lands on, and `operations` is the one route
  // `App.svelte` does not lazy-load — so anything tier 2 and tier 3 import would
  // otherwise sit in the startup graph for an operator who never descends.
  // Between them they pull in tier 2's own row-list and controls machinery and
  // the `WorkflowRun` topology view tier 3 mounts, which is most of this
  // surface's weight; loading them on descent keeps the startup cost to the
  // tier actually shown, the same bargain `routeLoaders` in `App.svelte` makes
  // for the non-default routes. The promises are cached per tier so
  // re-rendering a location does not remount it.
  type QueueDetailTierComponent = typeof import('./drilldown/QueueDetailTier.svelte').default;
  type RunDetailTierComponent = typeof import('./drilldown/RunDetailTier.svelte').default;

  let queueDetailTier: Promise<QueueDetailTierComponent> | null = null;
  let runDetailTier: Promise<RunDetailTierComponent> | null = null;

  function loadQueueDetailTier(): Promise<QueueDetailTierComponent> {
    queueDetailTier ??= import('./drilldown/QueueDetailTier.svelte').then((m) => m.default);
    return queueDetailTier;
  }

  function loadRunDetailTier(): Promise<RunDetailTierComponent> {
    runDetailTier ??= import('./drilldown/RunDetailTier.svelte').then((m) => m.default);
    return runDetailTier;
  }

  interface ResolvedLocation {
    readonly location: DashboardLocation;
    /** Why the operator is not where they asked to be, or null when they are. */
    readonly notice: string | null;
  }

  function resolveLocation(
    current: DashboardLocation,
    state: WorkflowSnapshot
  ): ResolvedLocation {
    if (current.route === 'queues') return { location: current, notice: null };

    const runtime = findQueueRuntime(state, current.queueId);
    if (runtime === null) {
      return {
        location: DEFAULT_DASHBOARD_LOCATION,
        notice: 'That queue is no longer available.'
      };
    }
    if (current.route === 'queue-detail') return { location: current, notice: null };

    // A Run is addressed either as a connected run's aggregate or as one of the
    // queue's own Tasks — the same two things tier 3 renders from, asked here so
    // the fallback happens before the tier has to report an empty view.
    const exists =
      runtime.tasks.some((task) => task.id === current.runId) ||
      (state.connectedRuns ?? []).some((run) => run.connectedRunId === current.runId);
    return exists
      ? { location: current, notice: null }
      : {
          location: queueDetailLocation(current.queueId),
          notice: `That run is no longer on ${runtime.name}.`
        };
  }

  let location = $state<DashboardLocation>(DEFAULT_DASHBOARD_LOCATION);
  const resolved = $derived(resolveLocation(location, snapshot));

  // The selection each tier is showing, remembered across a descent so the tier
  // still marks it when the operator walks back up.
  let selectedQueueId = $state<string | null>(null);
  let selectedRunId = $state<string | null>(null);

  let scroller = $state<HTMLElement | undefined>(undefined);
  // Deliberately not reactive: the offsets are read only when a location changes
  // and a scroll event that re-rendered every tier would be its own defect.
  const offsets = new Map<string, number>();

  function locationKey(value: DashboardLocation): string {
    switch (value.route) {
      case 'queues':
        return 'queues';
      case 'queue-detail':
        return `queue-detail:${value.queueId}`;
      case 'run-detail':
        return `run-detail:${value.queueId}:${value.runId}`;
    }
  }

  function rememberOffset(): void {
    if (scroller === undefined) return;
    offsets.set(locationKey(resolved.location), scroller.scrollTop);
  }

  $effect(() => {
    // Runs after the new tier is in the DOM. A tier never visited restores to the
    // top, which is also where it would have started.
    const key = locationKey(resolved.location);
    if (scroller !== undefined) scroller.scrollTop = offsets.get(key) ?? 0;
  });

  function openQueue(queueId: string): void {
    selectedQueueId = queueId;
    location = queueDetailLocation(queueId);
  }

  function openRun(runId: string): void {
    if (resolved.location.route !== 'queue-detail') return;
    selectedRunId = runId;
    location = runDetailLocation(resolved.location.queueId, runId);
  }

  function goBack(): void {
    location = parentLocation(resolved.location);
  }
</script>

<div
  class="operations-surface"
  data-testid="operations-scroll"
  bind:this={scroller}
  onscroll={rememberOffset}
>
  {#if resolved.notice !== null}
    <p class="fallback-notice" data-testid="operations-fallback-notice" role="status">
      {resolved.notice}
    </p>
  {/if}

  {#if resolved.location.route === 'queues'}
    <QueuesTier
      queues={snapshot.queues ?? []}
      isPrimary={snapshot.isPrimary}
      {selectedQueueId}
      onSelectQueue={openQueue}
    />
  {:else if resolved.location.route === 'queue-detail'}
    {@const queueId = resolved.location.queueId}
    {#await loadQueueDetailTier()}
      <p class="tier-loading" data-testid="operations-tier-loading" role="status">Opening…</p>
    {:then QueueDetailTier}
      <QueueDetailTier
        {snapshot}
        {queueId}
        isPrimary={snapshot.isPrimary}
        {selectedRunId}
        onBack={goBack}
        onSelectRun={openRun}
      />
    {:catch}
      <p class="tier-error" data-testid="operations-tier-error" role="alert">
        That view could not be loaded. Reload the dashboard to try again.
      </p>
    {/await}
  {:else}
    {@const queueId = resolved.location.queueId}
    {@const runId = resolved.location.runId}
    {#await loadRunDetailTier()}
      <p class="tier-loading" data-testid="operations-tier-loading" role="status">Opening…</p>
    {:then RunDetailTier}
      <RunDetailTier
        {snapshot}
        {queueId}
        {runId}
        isPrimary={snapshot.isPrimary}
        onBack={goBack}
      />
    {:catch}
      <p class="tier-error" data-testid="operations-tier-error" role="alert">
        That view could not be loaded. Reload the dashboard to try again.
      </p>
    {/await}
  {/if}
</div>

<style>
  .operations-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
  }

  .fallback-notice {
    margin: 0;
    padding: 8px 20px;
    font-size: 12px;
    color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-descriptionForeground));
    background: var(--vscode-editorWidget-background);
  }

  .tier-loading,
  .tier-error {
    margin: 0;
    padding: 16px 20px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .tier-error {
    color: var(--vscode-errorForeground);
  }
</style>
