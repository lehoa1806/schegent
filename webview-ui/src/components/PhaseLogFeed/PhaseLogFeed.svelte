<script lang="ts">
  // Feature 020 T039 + T053 — top-level Activity Feed wrapper. Composes
  // the selectors, iteration stepper, empty-state cards, and reading
  // pane, and wires them to the per-instance phase-log store.
  //
  // Tail lifecycle (T053): when the user's selection resolves to
  //   (a) iteration === the latest known iteration for the tuple, AND
  //   (b) the selected task is the snapshot's in-flight task, AND
  //   (c) the selected phase matches the in-flight task's
  //       `currentPhase`,
  // the container auto-attaches a tail by calling `store.startTail`.
  // The `$effect` watches the derived `tailTarget`; on cleanup (target
  // change to null, selection re-cascade, or component unmount) it
  // calls `store.stopTail()`. Push messages are routed through the
  // store's `handlePush` internals — this component is intentionally
  // unaware of the wire format beyond the start/stop calls.

  import type { WorkflowSnapshot } from '../../lib/snapshot-types';
  import { createPhaseLogStore, type PhaseLogStore } from '../../lib/phase-log-store.svelte';
  import PhaseLogSelectors from './PhaseLogSelectors.svelte';
  import PhaseLogIterationStepper from './PhaseLogIterationStepper.svelte';
  import PhaseLogReadingPane from './PhaseLogReadingPane.svelte';
  import PhaseLogEmptyStates from './PhaseLogEmptyStates.svelte';
  import { phaseLogEntriesToText } from '../../lib/activity-feed/phase-log-text-export';
  import {
    resolveLiveSelection,
    getPhaseOptions,
    queueIdForItem
  } from '../../lib/activity-feed-selection.svelte';
  import { readPhaseLog } from '../../lib/phase-log-ipc';

  interface Props {
    readonly snapshot: WorkflowSnapshot;
    readonly store?: PhaseLogStore;
    /**
     * Feature 097 — when `false`, this instance never runs its own
     * Live-Mode in-flight-follow or cold-start-fallback cascades; the
     * caller owns the store's selection exclusively. Defaults to `true`
     * so the workspace-wide auto-follow behavior (Feature 067) is
     * unchanged for every other embed. `RunDetailTier` is the one caller
     * that sets this `false`: its `store` is pinned to one Run, and
     * without this flag the store's own `applyInFlightIdentityChange`
     * effect would silently redirect that pin to whichever task is
     * in-flight on the *default* queue whenever Live Mode is on — the
     * cross-queue bleed FR-051/FR-052 forbid, just reached through this
     * store's own cascade instead of a workspace-wide read.
     */
    readonly autoFollow?: boolean;
    readonly onSelectQueue?: (queueId: string | null) => void;
    readonly onSelectTask?: (taskId: string | null, pipelineId: string | null) => void;
    readonly onSelectPhase?: (phaseId: string | null) => void;
    readonly onJumpToCurrent?: () => void;
  }

  let {
    snapshot,
    store = createPhaseLogStore(),
    autoFollow = true,
    onSelectQueue,
    onSelectTask,
    onSelectPhase,
    onJumpToCurrent
  }: Props = $props();

  const state = $derived(store.state);

  const availablePhases = $derived(snapshot.availablePhases ?? []);
  const hasNoEntries = $derived(
    !state.loading && state.entries.length === 0
  );
  // When the host returns a banner (`enabled-no-sessions-for-tuple` or
  // `disabled-no-sessions`) AND the reading pane has no rows, show the
  // empty-state card in place of the reading pane. The "enabled with
  // sessions" banner is informational only — the pane renders normally.
  const showEmptyCard = $derived(
    hasNoEntries &&
      state.verboseDiagnosticsState !== null &&
      state.verboseDiagnosticsState.kind !== 'enabled-with-sessions'
  );

  const selectedRunner = $derived.by(() => {
    if (!state.selection.taskId || !state.selection.phaseId) return null;
    const taskId = state.selection.taskId;
    // Queue selections are keyed by FeatureRequest id, while audit entries
    // are keyed by WorkflowRun id. Resolve that boundary explicitly for the
    // active run and for historical tasks; falling back to taskId preserves
    // compatibility with older snapshots where both identifiers matched.
    //
    // Feature 092 (T094, FR-052) — the run id comes from the queue whose Run is
    // executing *this* task, not from a workspace-wide "active" run. A Run
    // starting in another queue changes no runtime but its own, so a tail
    // already attached here keeps resolving to the Run it attached to.
    const owningRun =
      snapshot.queues.find((runtime) => runtime.inFlightRun?.feature?.id === taskId)
        ?.inFlightRun ?? null;
    const runId =
      owningRun !== null
        ? owningRun.runId
        : snapshot.history.find(
            (entry) => entry.featureId === taskId || entry.runId === taskId
          )?.runId ?? taskId;
    const phaseId = state.selection.phaseId;
    const entries = snapshot.auditTail ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (
        e.runId === runId &&
        (e.phaseId === phaseId || e.phase === phaseId) &&
        e.category === 'phase-transition' &&
        e.summary.startsWith('phase-start')
      ) {
        if (e.runner && e.runner !== (snapshot.defaultRunnerKind ?? 'claude')) {
          return e.runner;
        }
      }
    }
    return null;
  });

  // T053 — derived tail fingerprint. Encodes the (queueId, taskId,
  // pipelineId, phaseId, iterationN) tuple as a single string when
  // the selection resolves to (a) iteration === latest known iteration
  // AND (b) selected task is the in-flight task AND (c) selected phase
  // === in-flight task's currentPhase. Returns the empty string when
  // any condition fails. A string fingerprint (rather than a fresh
  // object literal) gives the downstream `$effect` a stable identity
  // so unrelated state changes (e.g., tailSessionId, new entries) do
  // NOT trip the effect's cleanup and inadvertently call `stopTail`.
  const tailFingerprint = $derived.by(() => {
    const sel = state.selection;
    if (
      sel.queueId === null ||
      sel.taskId === null ||
      sel.pipelineId === null ||
      sel.phaseId === null ||
      sel.iterationN === null
    ) {
      return '';
    }
    const inFlight = snapshot.queue.inFlight;
    if (inFlight === null) return '';
    if (inFlight.id !== sel.taskId) return '';
    if (inFlight.currentPhase !== sel.phaseId) return '';
    const iters = state.iterations;
    if (iters.length === 0) return '';
    const latest = iters[iters.length - 1];
    if (latest !== sel.iterationN) return '';
    return `${sel.queueId}${sel.taskId}${sel.pipelineId}${sel.phaseId}${sel.iterationN}`;
  });

  // Feature 067 — snapshot observer effect. The store de-duplicates
  // identity-stable snapshots, so this call is safe on every
  // re-render. When Live Mode is ON AND the in-flight identity tuple
  // has changed, the store internally cascades through
  // `jumpToCurrent({ setLiveModeOn: false, origin: 'cascade' })`. When
  // Live Mode is OFF or the tuple is stable, the call is a no-op.
  $effect(() => {
    if (!autoFollow) return;
    store.applyInFlightIdentityChange(snapshot);
  });

  // Manually-tracked tail lifecycle. The $effect body re-runs on
  // any reactive read inside `tailFingerprint`, but most of those
  // re-runs see no actual change to the tuple — we compare against
  // `activeTailFingerprint` (kept in untracked module-local state
  // via the closure on a regular `let`) and only act on a true
  // transition. The $effect cleanup is reserved for component
  // unmount, where it always tears down any active tail.
  let activeTailFingerprint = '';
  $effect(() => {
    const fp = tailFingerprint;
    if (fp === activeTailFingerprint) return;
    if (activeTailFingerprint !== '') {
      void store.stopTail();
    }
    activeTailFingerprint = fp;
    if (fp === '') return;
    const parts = fp.split('');
    void store.startTail({
      selection: {
        queueId: parts[0],
        taskId: parts[1],
        pipelineId: parts[2],
        phaseId: parts[3],
        iterationN: Number(parts[4])
      }
    });
  });

  $effect(() => {
    return () => {
      if (activeTailFingerprint !== '') {
        void store.stopTail();
        activeTailFingerprint = '';
      }
    };
  });

  // Feature 021 T044 (BUG-001 Defect A) — cold-start fallback wiring.
  //
  // After VSCode restart, the Activity Feed selection store is empty
  // and `snapshot.queue.inFlight === null`, so `resolveLiveSelection`
  // returns null and the operator sees "No selection" even when recent
  // tasks have on-disk phase logs. This effect runs at most once per
  // mount: when the first snapshot arrives, if the live selection is
  // null AND the store still holds the empty selection, walk
  // `snapshot.queue.recent` in (updatedAt desc, enqueuedAt desc) order,
  // probe each candidate with `readPhaseLog`, and commit the first
  // tuple that yields a non-empty iteration list via `setSelection`.
  //
  // Any subsequent operator action (queue/task/phase pick) leaves the
  // store's selection non-empty, so the guard below prevents the
  // effect from overriding their choice on a later re-run.
  let coldStartAttempted = false;
  $effect(() => {
    if (coldStartAttempted) return;
    if (
      state.selection.queueId !== null ||
      state.selection.taskId !== null ||
      state.selection.phaseId !== null
    ) {
      // Operator already navigated, OR a prior effect cycle resolved
      // the fallback — either way, do not re-fire.
      coldStartAttempted = true;
      return;
    }
    if (resolveLiveSelection(snapshot) !== null) {
      // Live in-flight task is present; the existing follow-mode
      // path will resolve the selection — fallback not needed.
      coldStartAttempted = true;
      return;
    }
    if (snapshot.queue.recent.length === 0) {
      // Empty queue — preserve the "No selection" empty state.
      coldStartAttempted = true;
      return;
    }
    coldStartAttempted = true;
    void attemptColdStartFallback();
  });

  async function attemptColdStartFallback(): Promise<void> {
    const ranked = [...snapshot.queue.recent].sort((a, b) => {
      const at = coldStartTime(a);
      const bt = coldStartTime(b);
      if (at !== bt) return bt - at;
      const ae = Date.parse(a.enqueuedAt);
      const be = Date.parse(b.enqueuedAt);
      const aev = Number.isFinite(ae) ? ae : 0;
      const bev = Number.isFinite(be) ? be : 0;
      return bev - aev;
    });
    for (const item of ranked) {
      const queueId = queueIdForItem(item);
      const pipelineId = item.currentPipelineId ?? snapshot.availablePipelines?.[0]?.id ?? null;
      if (pipelineId === null) continue;
      const candidatePhase = pickCandidatePhase(item);
      if (candidatePhase === null) continue;
      const probe = await readPhaseLog({
        selection: {
          queueId,
          taskId: item.id,
          pipelineId,
          phaseId: candidatePhase,
          iterationN: null
        }
      });
      if (probe.outcome !== 'success') continue;
      if (probe.manifest.iterations.length === 0) continue;
      // Found a recent task with on-disk iterations. Bail out if the
      // operator navigated while the probe was inflight.
      if (
        state.selection.queueId !== null ||
        state.selection.taskId !== null ||
        state.selection.phaseId !== null
      ) {
        return;
      }
      // Feature 067 FR-014 — cold-start is a programmatic cascade,
      // NOT an operator action. Pass { origin: 'cascade' } so the
      // store does NOT flip Live Mode OFF when no operator click has
      // occurred.
      store.setSelection({
        queueId,
        taskId: item.id,
        pipelineId,
        phaseId: candidatePhase,
        iterationN: null
      }, { origin: 'cascade' });
      return;
    }
  }

  function pickCandidatePhase(item: WorkflowSnapshot['queue']['recent'][number]): string | null {
    if (item.currentPhase !== null) return item.currentPhase;
    const phases = getPhaseOptions(snapshot, {
      id: item.id,
      label: item.label,
      queueId: queueIdForItem(item),
      pipelineId: item.currentPipelineId ?? null,
      currentPhase: null,
      status: item.status,
      updatedAt: item.completedAt ?? item.updatedAt ?? item.startedAt ?? item.enqueuedAt
    });
    const completed = [...phases]
      .filter((phase) => phase.state === 'completed')
      .sort((a, b) => b.order - a.order)[0];
    return completed?.id ?? phases[phases.length - 1]?.id ?? phases[0]?.id ?? null;
  }

  function coldStartTime(item: WorkflowSnapshot['queue']['recent'][number]): number {
    const value = item.completedAt ?? item.updatedAt ?? item.startedAt ?? item.enqueuedAt;
    if (value === null) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function handleSelectQueue(queueId: string | null): void {
    if (onSelectQueue) {
      onSelectQueue(queueId);
      return;
    }
    store.setQueue(queueId);
  }

  function handleSelectTask(
    taskId: string | null,
    pipelineId: string | null
  ): void {
    if (onSelectTask) {
      onSelectTask(taskId, pipelineId);
      return;
    }
    store.setTask(taskId, pipelineId);
  }

  function handleSelectPhase(phaseId: string | null): void {
    if (onSelectPhase) {
      onSelectPhase(phaseId);
      return;
    }
    store.setPhase(phaseId);
  }

  function handleSelectIteration(n: number): void {
    store.setIteration(n);
  }

  // T056 — atomic cascade to the currently-in-flight task / phase /
  // latest iteration. Delegated to the store so the five fields are
  // written in a single setState, avoiding the intermediate fingerprint
  // values the dependent `$effect` would otherwise observe.
  //
  // Feature 067 T030 (FR-007, FR-008, FR-010) — the explicit
  // `setLiveModeOn: true` matches the store's default but documents the
  // re-engage intent at the call site: clicking Live always flips Live
  // Mode ON, even when there is no in-flight task to cascade to.
  function handleJumpToCurrent(): void {
    if (onJumpToCurrent) {
      onJumpToCurrent();
      return;
    }
    void store.jumpToCurrent(snapshot, { setLiveModeOn: true });
  }
  async function handleCopyAll(): Promise<void> {
    const entries = state.entries;
    if (entries.length === 0) return;
    const text = phaseLogEntriesToText(entries);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard write can fail in restricted contexts — non-fatal.
    }
  }
</script>

<section
  class="phase-log-feed"
  data-testid="phase-log-feed"
  aria-label="Activity Feed"
>
  <PhaseLogSelectors
    snapshot={{ queue: snapshot.queue, history: snapshot.history }}
    selection={state.selection}
    iterations={state.iterations}
    {availablePhases}
    {selectedRunner}
    entryCount={state.entries.length}
    onSelectQueue={handleSelectQueue}
    onSelectTask={handleSelectTask}
    onSelectPhase={handleSelectPhase}
    onJumpToCurrent={handleJumpToCurrent}
    onCopyAll={handleCopyAll}
  />

  <PhaseLogIterationStepper
    iterations={state.iterations}
    currentN={state.selection.iterationN}
    onChange={handleSelectIteration}
  />

  {#if showEmptyCard}
    <PhaseLogEmptyStates banner={state.verboseDiagnosticsState} />
  {:else}
    <PhaseLogReadingPane
      entries={state.entries}
      loading={state.loading}
      skippedLines={state.skippedLines}
      truncatedCount={state.truncatedCount}
      isLive={state.tailSessionId !== null}
    />
  {/if}

  {#if state.errorReason !== null}
    <p class="error" data-testid="phase-log-error">
      Could not load logs: {state.errorReason}
    </p>
  {/if}
</section>

<style>
  .phase-log-feed {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .error {
    margin: 0;
    color: var(--schegent-error-text);
    font-size: 0.85rem;
  }
</style>
