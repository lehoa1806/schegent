// Feature 020 — phase-log selection + entries store (Svelte 5 $state
// runes). NOT persisted across dashboard re-mount; all fields default
// to null/empty on construction. Tail-session lifecycle and
// auto-attach land in US2 (T051/T056); this module currently exposes
// only the read surface (load a manifest, cascade selectors, iteration
// stepper).
//
// The store has no awareness of the host snapshot beyond the
// `setSelection` callback path. Consumers (PhaseLogFeed.svelte +
// PhaseLogSelectors.svelte) read the snapshot from `snapshotStore`
// and drive the cascade through this store's `setQueue`, `setTask`,
// `setPhase`, `setIteration` methods.
//
// Cascade-clear discipline (FR-009..FR-013): changing queue clears
// task/pipeline/phase/iteration; changing task clears pipeline/phase/
// iteration; changing phase clears iteration. The store enforces this
// regardless of caller-supplied values.

import type {
  PhaseLogDisplayEntry,
  PhaseLogReadResult,
  PhaseLogSelection,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult,
  VerboseDiagnosticsBanner
} from '../../../src/services/phase-log/types';
import {
  readPhaseLog,
  startPhaseLogTail,
  stopPhaseLogTail,
  subscribePhaseLogPush,
  type PhaseLogEntryPushPayload,
  type StartPhaseLogTailRequest,
  type StopPhaseLogTailRequest
} from './phase-log-ipc';

export type PhaseLogSelectionDraft = {
  readonly queueId: string | null;
  readonly taskId: string | null;
  readonly pipelineId: string | null;
  readonly phaseId: string | null;
  readonly iterationN: number | null;
};

export interface PhaseLogStoreState {
  readonly selection: PhaseLogSelectionDraft;
  readonly tailSessionId: string | null;
  readonly entries: readonly PhaseLogDisplayEntry[];
  readonly iterations: readonly number[];
  readonly verboseDiagnosticsState: VerboseDiagnosticsBanner | null;
  readonly isInFlight: boolean;
  readonly skippedLines: number;
  readonly truncatedCount: number;
  readonly loading: boolean;
  readonly errorReason: string | null;
}

export interface JumpToCurrentSnapshot {
  readonly queue: {
    readonly inFlight: {
      readonly id: string;
      readonly queueId?: string;
      readonly currentPipelineId?: string | null;
      readonly currentPhase: string | null;
    } | null;
  };
}

export interface PhaseLogStore {
  readonly state: PhaseLogStoreState;
  setSelection(selection: PhaseLogSelectionDraft): void;
  setQueue(queueId: string | null): void;
  setTask(taskId: string | null, pipelineId: string | null): void;
  setPhase(phaseId: string | null): void;
  setIteration(iterationN: number | null): void;
  reload(): Promise<void>;
  reset(): void;
  // Feature 020 T051 — tail lifecycle. `startTail` posts
  // CMD_START_PHASE_LOG_TAIL and registers a push listener;
  // `stopTail` posts CMD_STOP_PHASE_LOG_TAIL and tears down the
  // listener. Both are idempotent: a duplicate start replaces the
  // prior session (the host's cap-of-1 invariant matches), and stop
  // is a no-op when no session is active.
  startTail(req: StartPhaseLogTailRequest): Promise<PhaseLogTailStartResult>;
  stopTail(): Promise<PhaseLogTailStopResult | null>;
  // Feature 020 T056 — atomic "Jump to current phase" cascade.
  // Reads `snapshot.queue.inFlight` and, if present, sets all five
  // selection fields in a single setState (so the dependent
  // PhaseLogFeed `$effect` sees the tuple resolved on the first
  // re-run, NOT mid-cascade as five sequential `set*` calls would).
  // Returns the resolved selection on success or null when there is
  // no in-flight task.
  jumpToCurrent(snapshot: JumpToCurrentSnapshot): Promise<PhaseLogSelectionDraft | null>;
}

const IDLE_STATE: PhaseLogStoreState = Object.freeze({
  selection: Object.freeze({
    queueId: null,
    taskId: null,
    pipelineId: null,
    phaseId: null,
    iterationN: null
  }),
  tailSessionId: null,
  entries: Object.freeze([]),
  iterations: Object.freeze([]),
  verboseDiagnosticsState: null,
  isInFlight: false,
  skippedLines: 0,
  truncatedCount: 0,
  loading: false,
  errorReason: null
});

export function createPhaseLogStore(
  read: (req: {
    readonly selection: PhaseLogSelection;
  }) => Promise<PhaseLogReadResult> = readPhaseLog,
  // T051 — tail IPC seam. Defaults wire to the real IPC helpers; tests
  // overwrite via vi.mock on the underlying module. Keeping the
  // constructor surface stable so existing call sites
  // (`createPhaseLogStore()`) continue to work without arguments.
  tail: {
    readonly start: (
      req: StartPhaseLogTailRequest
    ) => Promise<PhaseLogTailStartResult>;
    readonly stop: (
      req: StopPhaseLogTailRequest
    ) => Promise<PhaseLogTailStopResult>;
    readonly subscribe: (
      cb: (payload: PhaseLogEntryPushPayload) => void
    ) => () => void;
  } = {
    start: startPhaseLogTail,
    stop: stopPhaseLogTail,
    subscribe: subscribePhaseLogPush
  }
): PhaseLogStore {
  // Box the state in a stable container so closures (notably
  // `handlePush`, registered with `tail.subscribe` from outside the
  // reactive system) always read the *current* value rather than a
  // stale snapshot of the variable binding at the time the closure
  // was created. Reassigning a local `let` declared with `$state(...)`
  // does not propagate through closures predictably across async
  // boundaries in Svelte 5 runes, so we mutate `ref.current` on a
  // single `$state` proxy instead.
  const ref = $state<{ current: PhaseLogStoreState }>({ current: IDLE_STATE });
  const getState = (): PhaseLogStoreState => ref.current;
  const setState = (next: PhaseLogStoreState): void => {
    ref.current = next;
  };
  // Monotonic token to defend against stale in-flight reads when the
  // user cascades the selection mid-await. Each `reload()` captures
  // the current token; on resolution it only applies if the token is
  // still the latest.
  let loadToken = 0;
  // T051 — push-listener handle. The subscription owns its own
  // lifecycle: dispose on `stopTail()`, dispose on a duplicate
  // `startTail()`, dispose on `reset()`.
  let pushUnsubscribe: (() => void) | null = null;

  function handlePush(payload: PhaseLogEntryPushPayload): void {
    // Defense against late delivery after navigate-away (T044
    // contract): drop pushes whose session does not match the
    // currently-active tail. The host's registry tears down the
    // previous session before allocating a new one, but the message
    // bus is not guaranteed to be quiesced — a stale envelope can
    // still arrive in flight.
    const cur = getState();
    if (cur.tailSessionId === null) return;
    if (payload.tailSessionId !== cur.tailSessionId) return;
    if (payload.entry.kind === 'tail-ended') {
      // Synthetic terminator — clears the LIVE indicator. The entry
      // itself is NOT appended to the visible log because it carries
      // no body the user cares about; the disappearance of the LIVE
      // badge is the observable cue.
      teardownPush();
      setState({ ...cur, tailSessionId: null });
      return;
    }
    setState({
      ...cur,
      entries: Object.freeze([...cur.entries, payload.entry])
    });
  }

  function teardownPush(): void {
    if (pushUnsubscribe === null) return;
    try {
      pushUnsubscribe();
    } catch {
      // listener errors must not leak out of teardown
    }
    pushUnsubscribe = null;
  }

  function patchSelection(next: Partial<PhaseLogSelectionDraft>): void {
    const cur = getState();
    setState({
      ...cur,
      selection: { ...cur.selection, ...next }
    });
  }

  function resetEntries(): void {
    const cur = getState();
    setState({
      ...cur,
      entries: [],
      iterations: [],
      verboseDiagnosticsState: null,
      isInFlight: false,
      skippedLines: 0,
      truncatedCount: 0,
      errorReason: null,
      tailSessionId: null
    });
  }

  async function loadIfComplete(): Promise<void> {
    const sel = getState().selection;
    if (
      sel.queueId === null ||
      sel.taskId === null ||
      sel.pipelineId === null ||
      sel.phaseId === null
    ) {
      resetEntries();
      return;
    }
    const token = ++loadToken;
    setState({ ...getState(), loading: true, errorReason: null });
    const result = await read({
      selection: {
        queueId: sel.queueId,
        taskId: sel.taskId,
        pipelineId: sel.pipelineId,
        phaseId: sel.phaseId,
        iterationN: sel.iterationN
      }
    });
    if (token !== loadToken) return; // stale
    if (result.outcome === 'success') {
      const manifest = result.manifest;
      const before = getState();
      setState({
        ...before,
        loading: false,
        entries: manifest.entries,
        iterations: manifest.iterations,
        verboseDiagnosticsState: manifest.verboseDiagnosticsState,
        isInFlight: manifest.isInFlight,
        skippedLines: manifest.skippedLines,
        truncatedCount: manifest.truncatedCount,
        errorReason: null,
        // When the host snapped to a specific iteration (because the
        // caller passed null), reflect that back into the selection so
        // the stepper renders the right label.
        selection:
          sel.iterationN === null && manifest.selectedIteration !== null
            ? { ...sel, iterationN: manifest.selectedIteration }
            : sel
      });
    } else {
      setState({
        ...getState(),
        loading: false,
        entries: [],
        iterations: [],
        verboseDiagnosticsState: null,
        isInFlight: false,
        skippedLines: 0,
        truncatedCount: 0,
        errorReason: result.reason
      });
    }
  }

  return {
    get state() {
      return ref.current;
    },
    setSelection(selection) {
      setState({
        ...getState(),
        selection,
        entries: [],
        iterations: [],
        verboseDiagnosticsState: null,
        isInFlight: false,
        skippedLines: 0,
        truncatedCount: 0,
        errorReason: null,
        tailSessionId: null
      });
      teardownPush();
      void loadIfComplete();
    },
    setQueue(queueId) {
      // Cascade-clear: pick a queue → wipe task/pipeline/phase/iter.
      patchSelection({
        queueId,
        taskId: null,
        pipelineId: null,
        phaseId: null,
        iterationN: null
      });
      resetEntries();
    },
    setTask(taskId, pipelineId) {
      // Cascade-clear: pick a task → wipe phase/iter (pipeline is
      // derived from the task, not user-selected).
      patchSelection({
        taskId,
        pipelineId,
        phaseId: null,
        iterationN: null
      });
      resetEntries();
    },
    setPhase(phaseId) {
      // Cascade-clear: pick a phase → wipe iter (latest-by-default
      // wins on next reload).
      patchSelection({ phaseId, iterationN: null });
      void loadIfComplete();
    },
    setIteration(iterationN) {
      patchSelection({ iterationN });
      void loadIfComplete();
    },
    reload() {
      return loadIfComplete();
    },
    reset() {
      loadToken++;
      teardownPush();
      setState(IDLE_STATE);
    },
    async startTail(req) {
      // Cap-of-1 mirror: tear down any existing subscription before
      // starting a new one. The host enforces the same invariant at
      // the registry; doing it here too keeps the LIVE indicator
      // accurate even if a stale push arrives between requests.
      teardownPush();
      const prior = getState().tailSessionId;
      if (prior !== null) {
        // Drop the prior session id eagerly so any in-flight push
        // for it is dropped by `handlePush`.
        setState({ ...getState(), tailSessionId: null });
      }
      const result = await tail.start(req);
      if (result.outcome === 'success') {
        setState({ ...getState(), tailSessionId: result.sessionId });
        pushUnsubscribe = tail.subscribe(handlePush);
      }
      return result;
    },
    async stopTail() {
      const sessionId = getState().tailSessionId;
      teardownPush();
      if (sessionId === null) return null;
      // Clear locally first so a late `tail-ended` push for this
      // session is also dropped (handlePush early-returns on
      // sessionId === null).
      setState({ ...getState(), tailSessionId: null });
      return tail.stop({ sessionId });
    },
    async jumpToCurrent(snapshot) {
      // T056 — atomic cascade. The in-flight QueueItem may have a
      // null `currentPhase` if the run is between phases; in that
      // case there is nothing meaningful to jump to.
      const inFlight = snapshot.queue.inFlight;
      if (inFlight === null) return null;
      if (inFlight.currentPhase === null) return null;
      const queueId = inFlight.queueId ?? null;
      const pipelineId = inFlight.currentPipelineId ?? null;
      if (queueId === null || pipelineId === null) return null;
      const next: PhaseLogSelectionDraft = {
        queueId,
        taskId: inFlight.id,
        pipelineId,
        phaseId: inFlight.currentPhase,
        // iterationN stays null — the read pass will snap to the
        // latest iteration the host reports.
        iterationN: null
      };
      // Atomic write so the dependent `$effect` in PhaseLogFeed sees
      // the fully-resolved tuple on its next re-run, instead of five
      // intermediate states from the discrete `set*` setters.
      setState({
        ...getState(),
        selection: next,
        // Also reset the per-iteration buffers — a fresh read is
        // about to repopulate them.
        entries: [],
        iterations: [],
        verboseDiagnosticsState: null,
        isInFlight: false,
        skippedLines: 0,
        truncatedCount: 0,
        errorReason: null,
        // Drop any stale tail session id; the auto-attach `$effect`
        // will re-attach once the read completes if conditions hold.
        tailSessionId: null
      });
      teardownPush();
      await loadIfComplete();
      return next;
    }
  };
}
