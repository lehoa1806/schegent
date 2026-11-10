// Feature 020 T044 — PhaseLogFeed container behavior under tail.
//
// Verifies the three observable contracts the US2 implementation
// (T051 + T053) must deliver:
//   1. When the selection resolves to (latest iteration, in-flight
//      task, active phase), the container auto-attaches a tail via
//      `startPhaseLogTail` and registers a `subscribePhaseLogBatch`
//      listener (T053; FR-R6-F07 replaced the per-entry push).
//   2. Push messages whose `tailSessionId` matches the active session
//      are appended to the entries list; mismatched ids are dropped
//      (T051 push handler).
//   3. A push whose entry kind is `tail-ended` clears the LIVE
//      indicator (the store's `tailSessionId` resets to null on the
//      synthetic terminator).
//
// All three behaviors fail until T051/T053 land — that is the
// intended TDD state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type {
  BackendRunnerKind,
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import type {
  PhaseLogDisplayEntry,
  PhaseLogReadResult,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from '../../../../../src/services/phase-log/types';
import {
  buildQueueRuntime,
  foldLegacyRun,
  type LegacyRunFields
} from '../../../lib/__tests__/queue-runtime-fixture';

// --- module mocks ------------------------------------------------------

// `phase-log-ipc` is mocked so the test can both observe what the
// container asks for and drive the push listener it registers.
const startSpy = vi.fn<(req: unknown) => Promise<PhaseLogTailStartResult>>();
const stopSpy = vi.fn<(req: unknown) => Promise<PhaseLogTailStopResult>>();
const readSpy = vi.fn<(req: unknown) => Promise<PhaseLogReadResult>>();
const subscribeSpy = vi.fn<(cb: (payload: unknown) => void) => () => void>();
let capturedBatchListener: ((payload: unknown) => void) | null = null;

// FR-R6-F07 — the entry the host would push, as the one-entry batch that now carries it. Each
// case delivers one batch after the start, so it is batch 1.
function capturedPushListener(push: {
  tailSessionId: string;
  entrySeq: number;
  entry: PhaseLogDisplayEntry;
}): void {
  capturedBatchListener?.({
    protocol: 1,
    tailSessionId: push.tailSessionId,
    batchSeq: 1,
    generation: 'g-1',
    mode: 'continue',
    toCursor: null,
    entries: [{ at: push.entrySeq, n: 0, entry: push.entry }]
  });
}

vi.mock('../../../lib/phase-log-ipc', () => ({
  readPhaseLog: (req: unknown) => readSpy(req),
  startPhaseLogTail: (req: unknown) => startSpy(req),
  stopPhaseLogTail: (req: unknown) => stopSpy(req),
  openVerboseSetting: vi.fn(),
  ackPhaseLogTail: vi.fn(),
  subscribePhaseLogBatch: (cb: (payload: unknown) => void) => {
    capturedBatchListener = cb;
    return subscribeSpy(cb);
  }
}));

// `vscode-api` post calls are inert in this test surface.
const postCommandSpy = vi.fn();
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

// Late import after the vi.mocks above so the component picks up the
// mocked phase-log-ipc surface.
import PhaseLogFeed from '../PhaseLogFeed.svelte';
import { createPhaseLogStore } from '../../../lib/phase-log-store.svelte';

// --- fixtures ----------------------------------------------------------

function buildPhase(
  name: PhaseTile['name'],
  order: PhaseTile['order'],
  state: PhaseTile['state']
): PhaseTile {
  return Object.freeze({
    name,
    order,
    state,
    iteration: 1,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  });
}

// BUG-002 (T076) — the host lists every queue's rows in that queue's runtime
// `tasks`, and the pane reads in-flight Runs from there (FR-021, FR-022). Only
// the in-flight row is copied: `foldLegacyRun` files its runtime under
// `default`, not the `q-1` these rows name, and a cold-start case below adds
// its own `q-1` runtime for the phase strip.
function withInFlightRuntime(
  queues: WorkflowSnapshot['queues'],
  queue: QueueProjection
): WorkflowSnapshot['queues'] {
  const row = queue.inFlight;
  if (row === null) return queues;
  const queueId = row.queueId ?? 'default';
  const owner = queues.find((runtime) => runtime.queueId === queueId);
  const runtime =
    owner === undefined
      ? buildQueueRuntime({ queueId, tasks: Object.freeze([row]) })
      : Object.freeze({ ...owner, tasks: Object.freeze([row]) });
  return Object.freeze([...queues.filter((candidate) => candidate !== owner), runtime]);
}

function buildSnapshot(overrides: Partial<WorkflowSnapshot> & LegacyRunFields = {}): WorkflowSnapshot {
  const { status, activeFeature, phases, liveActivity, workflowElapsedMs, ...rest } = overrides;
  const defaultPhases: readonly PhaseTile[] = Object.freeze([
    buildPhase('speckit-specify', 1, 'completed'),
    buildPhase('speckit-plan', 2, 'active'),
    buildPhase('speckit-tasks', 3, 'not-started')
  ]);
  const inFlight: QueueItem = Object.freeze({
    id: 'run-1',
    label: 'feature one',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: '2026-05-10T11:30:00.000Z',
    updatedAt: '2026-05-10T11:30:00.000Z',
    completedAt: null,
    status: 'in-flight',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: 'speckit-plan',
    position: 0,
    queueId: 'q-1',
    currentPipelineId: 'standard'
  } as QueueItem);
  const queue: QueueProjection = Object.freeze({ orderedItems: [],
    inFlight,
    pending: Object.freeze([]) as readonly QueueItem[],
    recent: Object.freeze([]) as readonly QueueItem[],
    paused: false,
    queues: Object.freeze([
      Object.freeze({
        id: 'q-1',
        name: 'Default',
        position: 0,
        state: 'active' as const,
        pauseSource: null,
        schedule: null,
        taskCount: 1,
        failurePolicy: 'halt-on-failure' as const,
        failurePolicyOverride: null
      })
    ])
  } as QueueProjection);
  const pipelines: readonly PipelineDefinition[] = Object.freeze([
    Object.freeze({
      id: 'standard',
      name: 'Standard',
      phases: Object.freeze(['speckit-specify', 'speckit-plan', 'speckit-tasks']) as readonly string[]
    }) as PipelineDefinition
  ]);
  const base: WorkflowSnapshot = Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: status ?? 'running',
      activeFeature: activeFeature ?? null,
      phases: phases ?? defaultPhases,
      liveActivity: liveActivity ?? (Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle' as const,
      staleSeconds: 0
      })),
      workflowElapsedMs: workflowElapsedMs ?? 0
    }),
    queue,
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-10T12:00:00.000Z',
    availablePipelines: pipelines,
    availablePhases: Object.freeze([
      Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-plan', name: 'Plan', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-tasks', name: 'Tasks', instruction: '', loopable: false })
    ]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude']) as readonly BackendRunnerKind[]
  } as WorkflowSnapshot);
  const merged: WorkflowSnapshot = Object.freeze({ ...base, ...rest });
  return Object.freeze({ ...merged, queues: withInFlightRuntime(merged.queues, merged.queue) });
}

function makePushEntry(
  seq: number,
  text: string,
  kind: PhaseLogDisplayEntry['kind'] = 'assistant-text'
): PhaseLogDisplayEntry {
  return Object.freeze({
    seq,
    kind,
    ts: null,
    body:
      kind === 'tail-ended'
        ? ({ reason: 'phase-complete' as const })
        : { text },
    bodyTruncated: null
  });
}

async function selectTuple(
  store: ReturnType<typeof createPhaseLogStore>,
  queueId: string,
  taskId: string,
  phaseId: string
): Promise<void> {
  store.setSelection({
    queueId,
    taskId,
    pipelineId: 'standard',
    phaseId,
    iterationN: null
  });
  // Drain: setSelection fires loadIfComplete() (async read), then the
  // read resolves and patches iterationN, then the Svelte $effect chain
  // re-derives tailFingerprint and potentially calls startTail.
  // 4 ticks covers the full chain: microtask for read → state patch →
  // derived re-evaluation → effect scheduling.
  await tick();
  await tick();
  await tick();
  await tick();
}

// --- tests -------------------------------------------------------------

beforeEach(() => {
  startSpy.mockReset();
  stopSpy.mockReset();
  readSpy.mockReset();
  subscribeSpy.mockReset();
  postCommandSpy.mockReset();
  capturedBatchListener = null;

  // Default: manifest read returns success with one initial entry and
  // `isInFlight: true` so the container can decide to auto-attach.
  readSpy.mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries: [makePushEntry(1, 'historical-init', 'system')],
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: { kind: 'entries-present' },
      isInFlight: true
    }
  });
  startSpy.mockResolvedValue({
    outcome: 'success',
    sessionId: 'sess-A',
    mechanism: 'fs.watch',
    snapshotCutoff: 'cut-0',
    nextCursor: 'c-0',
    cursorStatus: 'none'
  });
  stopSpy.mockResolvedValue({
    outcome: 'success',
    sessionId: 'sess-A'
  });
  subscribeSpy.mockReturnValue(() => {});
});

afterEach(() => cleanup());

describe('Feature 020 T044 — PhaseLogFeed auto-attach (T053 contract)', () => {
  it('calls startPhaseLogTail once the user picks a tuple matching latest+in-flight+active-phase', async () => {
    const store = createPhaseLogStore();
    render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    // Allow microtask drain for the auto-attach to fire after the
    // manifest resolves.
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalled();
    expect(subscribeSpy).toHaveBeenCalled();
  });

  it('asks for the tuple the operator actually selected', async () => {
    // The assertion the test above is missing: `startPhaseLogTail` being
    // called says nothing about *which* phase log it attached to. The
    // request has to carry the selected tuple whole — a host that receives
    // a mangled one cannot report the mistake, it just tails nothing and
    // the feed sits silent with a LIVE badge on it.
    //
    // Worth its own test because the container round-trips the tuple
    // through `tailFingerprint`, a single string joined and re-split on a
    // U+0001 separator. That separator does not render: in a file read, a
    // grep hit, or a diff, the join looks like a bare concatenation and the
    // split looks like `split('')`. Anything that strips control characters
    // from this file — an editor, a formatter, a copy-paste through a tool
    // that sanitizes — silently turns the decode into a per-character one
    // and every field lands wrong. This test fails loudly if that happens.
    const store = createPhaseLogStore();
    render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      }
    });
  });

  it('does NOT auto-attach when the selected phase is not the active phase', async () => {
    const store = createPhaseLogStore();
    render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-specify');
    await tick();
    await tick();
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('Feature 020 T044 — push routing (T051 contract)', () => {
  it('appends entries whose tailSessionId matches the active session', async () => {
    const store = createPhaseLogStore();
    const { container } = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(capturedBatchListener).not.toBeNull();

    const before = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    capturedPushListener({
      tailSessionId: 'sess-A',
      entrySeq: 2,
      entry: makePushEntry(2, 'live-streamed-line')
    });
    await tick();
    await tick();
    const after = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    expect(after).toBeGreaterThan(before);
  });

  it('drops push messages whose tailSessionId does NOT match the active session', async () => {
    const store = createPhaseLogStore();
    const { container } = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(capturedBatchListener).not.toBeNull();

    const before = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    capturedPushListener({
      tailSessionId: 'sess-DIFFERENT',
      entrySeq: 9,
      entry: makePushEntry(9, 'should-be-dropped')
    });
    await tick();
    await tick();
    const after = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    expect(after).toBe(before);
  });

  it('clears the LIVE indicator on a tail-ended entry from the active session', async () => {
    const store = createPhaseLogStore();
    const { queryByTestId } = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();

    // While tailing, LIVE indicator is visible.
    expect(queryByTestId('phase-log-live-indicator')).not.toBeNull();

    capturedPushListener({
      tailSessionId: 'sess-A',
      entrySeq: 99,
      entry: makePushEntry(99, '', 'tail-ended')
    });
    await tick();
    await tick();

    // After tail-ended, LIVE indicator is gone.
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();
  });
});

describe('Feature 021 — shared Activity Feed selection callbacks', () => {
  it('routes queue, task, and phase selector changes through injected callbacks', async () => {
    const store = createPhaseLogStore();
    store.setSelection({
      queueId: 'q-1',
      taskId: 'run-1',
      pipelineId: 'standard',
      phaseId: 'speckit-plan',
      iterationN: 1
    });
    const onSelectQueue = vi.fn();
    const onSelectTask = vi.fn();
    const onSelectPhase = vi.fn();
    const onJumpToCurrent = vi.fn();

    const { getByTestId } = render(PhaseLogFeed, {
      props: {
        snapshot: buildSnapshot(),
        store,
        onSelectQueue,
        onSelectTask,
        onSelectPhase,
        onJumpToCurrent
      }
    });

    // Verify the breadcrumb reflects the selection
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('Default');
    expect(breadcrumb.textContent).toContain('feature one');
    expect(breadcrumb.textContent).toContain('Plan');

    // Verify jump button is rendered and functional
    const jumpBtn = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    expect(jumpBtn.disabled).toBe(false);
    await fireEvent.click(jumpBtn);
    expect(onJumpToCurrent).toHaveBeenCalledTimes(1);
  });
});

describe('Feature 074 — selected runner attribution', () => {
  it('maps the selected in-flight task id to the active workflow run id', async () => {
    const base = buildSnapshot();
    const inFlight = Object.freeze({
      ...base.queue.inFlight!,
      id: 'task-1'
    } as QueueItem);
    const snapshot = Object.freeze({
      ...base,
      // Feature 092 (T094) — attribution resolves the run id through the queue
      // whose Run owns the selected task, so the fixture states that ownership
      // instead of a workspace-wide `activeRunId`.
      queues: foldLegacyRun({
        status: 'running',
        activeRunId: 'workflow-run-1',
        activeFeature: {
          id: 'task-1',
          label: 'feature one',
          startedAt: '2026-05-10T11:30:00.000Z'
        }
      }),
      queue: Object.freeze({ ...base.queue, inFlight } as QueueProjection),
      auditTail: Object.freeze([
        Object.freeze({
          id: 'audit-runner-1',
          timestamp: '2026-05-10T12:00:00.000Z',
          phase: 'speckit-plan' as const,
          category: 'phase-transition' as const,
          summary: 'phase-start: speckit-plan',
          runId: 'workflow-run-1',
          scope: 'task' as const,
          taskId: 'task-1',
          phaseId: 'speckit-plan',
          outcome: 'pending' as const,
          runner: 'agy'
        })
      ])
    } as WorkflowSnapshot);
    const store = createPhaseLogStore();
    const { getByTitle } = render(PhaseLogFeed, {
      props: { snapshot, store }
    });

    await selectTuple(store, 'q-1', 'task-1', 'speckit-plan');
    await tick();

    expect(getByTitle('Executing on agy').textContent).toBe('agy');
  });

  it('compares attribution against the effective default backend', async () => {
    const base = buildSnapshot();
    const inFlight = Object.freeze({ ...base.queue.inFlight!, id: 'task-1' } as QueueItem);
    const event = {
      id: 'audit-runner-default',
      timestamp: '2026-05-10T12:00:00.000Z',
      phase: 'speckit-plan' as const,
      category: 'phase-transition' as const,
      summary: 'phase-start: speckit-plan',
      runId: 'workflow-run-1',
      scope: 'task' as const,
      taskId: 'task-1',
      phaseId: 'speckit-plan',
      outcome: 'pending' as const,
      runner: 'agy'
    };
    const snapshot = Object.freeze({
      ...base,
      // Feature 092 (T094) — attribution resolves the run id through the queue
      // whose Run owns the selected task, so the fixture states that ownership
      // instead of a workspace-wide `activeRunId`.
      queues: foldLegacyRun({
        status: 'running',
        activeRunId: 'workflow-run-1',
        activeFeature: {
          id: 'task-1',
          label: 'feature one',
          startedAt: '2026-05-10T11:30:00.000Z'
        }
      }),
      defaultRunnerKind: 'agy' as const,
      queue: Object.freeze({ ...base.queue, inFlight } as QueueProjection),
      auditTail: Object.freeze([Object.freeze(event)])
    } as WorkflowSnapshot);
    const store = createPhaseLogStore();
    const view = render(PhaseLogFeed, { props: { snapshot, store } });

    await selectTuple(store, 'q-1', 'task-1', 'speckit-plan');
    await tick();
    expect(view.queryByTitle('Executing on agy')).toBeNull();

    await view.rerender({
      snapshot: Object.freeze({
        ...snapshot,
        auditTail: Object.freeze([Object.freeze({ ...event, runner: 'claude' })])
      } as WorkflowSnapshot),
      store
    });
    await tick();
    expect(view.getByTitle('Executing on claude').textContent).toBe('claude');
  });
});

// Feature 021 T046 (BUG-001 Defect A) — cold-start cascade.
//
// At dashboard mount, when `queue.inFlight === null` but `queue.recent`
// contains tasks with on-disk phase-log iterations, the component must
// (a) probe each candidate via `readPhaseLog`, (b) commit the first
// candidate whose probe returns `iterations.length > 0` through the
// store's `setSelection` path. When `queue.recent` is empty, the
// existing "No selection" empty state must remain (preserves SC-007).

function buildRecentItem(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return Object.freeze({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    enqueuedAt: overrides.enqueuedAt ?? '2026-05-10T10:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-05-10T10:05:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-10T11:00:00.000Z',
    completedAt: overrides.completedAt ?? '2026-05-10T11:00:00.000Z',
    status: overrides.status ?? 'completed',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: overrides.currentPhase ?? 'speckit-plan',
    position: 0,
    queueId: overrides.queueId ?? 'q-1',
    currentPipelineId: overrides.currentPipelineId ?? 'standard'
  } as QueueItem);
}

function snapshotWithRecent(recent: readonly QueueItem[]): WorkflowSnapshot {
  const base = buildSnapshot();
  return buildSnapshot({
    queue: Object.freeze({
      ...base.queue,
      inFlight: null,
      recent
    } as QueueProjection)
  });
}

describe('Feature 021 T046 (BUG-001 Defect A) — cold-start cascade', () => {
  it('commits the resolved selection via setSelection when inFlight is null and a recent task has on-disk iterations', async () => {
    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    render(PhaseLogFeed, {
      props: {
        snapshot: snapshotWithRecent([buildRecentItem({ id: 'run-recent-A' })]),
        store
      }
    });
    // Allow the mount-time $effect to fire and the speculative
    // readPhaseLog probe to resolve.
    await tick();
    await tick();
    await tick();
    await tick();
    expect(setSelectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: 'q-1',
        taskId: 'run-recent-A',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: null
      }),
      { origin: 'cascade' }
    );
  });

  it('does not call setSelection on mount when queue.recent is empty (preserves SC-007 empty state)', async () => {
    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    render(PhaseLogFeed, {
      props: {
        snapshot: snapshotWithRecent([]),
        store
      }
    });
    await tick();
    await tick();
    await tick();
    expect(setSelectionSpy).not.toHaveBeenCalled();
  });

  it('skips the fallback when queue.inFlight is non-null (live-following cascade is unchanged)', async () => {
    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    // buildSnapshot() returns an inFlight task by default.
    render(PhaseLogFeed, {
      props: {
        snapshot: buildSnapshot(),
        store
      }
    });
    await tick();
    await tick();
    await tick();
    expect(setSelectionSpy).not.toHaveBeenCalled();
  });

  it('skips candidates whose probe returns no iterations and falls through to the next', async () => {
    // First probe: no iterations. Second probe: one iteration.
    readSpy.mockReset();
    readSpy
      .mockResolvedValueOnce({
        outcome: 'success',
        manifest: {
          iterations: [],
          selectedIteration: null,
          entries: [],
          skippedLines: 0,
          truncatedCount: 0,
          verboseDiagnosticsState: { kind: 'phase-not-recorded' },
          isInFlight: false
        }
      })
      .mockResolvedValue({
        outcome: 'success',
        manifest: {
          iterations: [1],
          selectedIteration: 1,
          entries: [makePushEntry(1, 'recent-log', 'system')],
          skippedLines: 0,
          truncatedCount: 0,
          verboseDiagnosticsState: { kind: 'entries-present' },
          isInFlight: false
        }
      });
    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    render(PhaseLogFeed, {
      props: {
        snapshot: snapshotWithRecent([
          buildRecentItem({
            id: 'run-empty',
            updatedAt: '2026-05-10T12:00:00.000Z',
            completedAt: '2026-05-10T12:00:00.000Z'
          }),
          buildRecentItem({
            id: 'run-with-logs',
            updatedAt: '2026-05-10T11:30:00.000Z',
            completedAt: '2026-05-10T11:30:00.000Z'
          })
        ]),
        store
      }
    });
    // Two probes; allow more ticks to drain the cascade.
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    expect(setSelectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'run-with-logs' }),
      { origin: 'cascade' }
    );
  });

  // Feature 067 T016 — cold-start MUST pass { origin: 'cascade' } so a
  // programmatic selection at mount does NOT flip Live Mode OFF when
  // no operator action has occurred.
  it('cold-start setSelection passes { origin: "cascade" } (Feature 067 FR-014)', async () => {
    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    render(PhaseLogFeed, {
      props: {
        snapshot: snapshotWithRecent([buildRecentItem({ id: 'run-recent-A' })]),
        store
      }
    });
    await tick();
    await tick();
    await tick();
    await tick();
    expect(setSelectionSpy).toHaveBeenCalled();
    const callArgs = setSelectionSpy.mock.calls[0];
    expect(callArgs?.[1]).toEqual({ origin: 'cascade' });
    // Cold-start should NOT flip Live Mode OFF.
    expect(store.isLiveMode()).toBe(true);
  });
});

// Bug "the phase log that asked for a phase named done" (2026-09-02) — the
// cold-start fallback probed the terminal sentinel and gave up.
//
// Every case above builds its recent item with `currentPhase: 'speckit-plan'`,
// a real phase. A *completed* Run does not have one: `'done'` is a terminal
// state of the phase state machine, not a Phase definition, and until this fix
// `queue-projector.ts` put it on the finished Run's own row. `pickCandidatePhase`
// returns `item.currentPhase` on its first line and so never reached the
// last-completed-phase fallback written directly below it for exactly this case.
//
// The host refuses such a tuple with `unknown-tuple` — `'done'` is in neither
// `availablePhases` nor the frozen Pipeline — so the probe failed, the loop
// `continue`d through every remaining candidate, and no selection was ever
// committed. What the operator saw was an Activity Feed stuck on its empty
// state after any restart with nothing in flight, which is where the report
// "phase log stopped working" came from. `.schegent/audit.log` carries the
// refusals: `phase-log-read failure reason=unknown-tuple phaseId=done`.
//
// `readSpy` is given the host's real refusal here rather than the permissive
// default, so the assertion is that the feed RECOVERS, not merely that it asked
// politely. A test that let the probe succeed would pass against the defect.
describe('cold-start fallback — a completed Run has no current phase', () => {
  function refuseTheSentinel(): void {
    readSpy.mockReset();
    readSpy.mockImplementation(async (req: unknown) => {
      const phaseId = (req as { selection: { phaseId: string } }).selection.phaseId;
      if (phaseId === 'done') {
        // Exactly what `validateSelection` returns for a phase the catalog
        // does not list on a task that is not in flight.
        return { outcome: 'failure', reason: 'unknown-tuple' } as PhaseLogReadResult;
      }
      return {
        outcome: 'success',
        manifest: {
          iterations: [1],
          selectedIteration: 1,
          entries: [makePushEntry(1, 'historical-init', 'system')],
          skippedLines: 0,
          truncatedCount: 0,
          verboseDiagnosticsState: { kind: 'entries-present' },
          isInFlight: false
        }
      } as PhaseLogReadResult;
    });
  }

  it('falls back to the newest completed phase instead of probing `done`', async () => {
    refuseTheSentinel();
    // `getPhaseOptions` reads tile state from the runtime of the queue that
    // owns the task, and `buildSnapshot` folds its legacy run under `default`
    // rather than the `q-1` these recent items name — so the strip is published
    // here explicitly. Without it every option's state is null, the fallback
    // cannot tell a completed phase from a not-started one, and the assertion
    // below would be about list order rather than about run progress.
    const withStrip = snapshotWithRecent([
      buildRecentItem({ id: 'run-finished', currentPhase: 'done' })
    ]);
    const snapshot = Object.freeze({
      ...withStrip,
      queues: Object.freeze([
        ...withStrip.queues,
        buildQueueRuntime({
          queueId: 'q-1',
          inFlightRun: null,
          phases: Object.freeze([
            buildPhase('speckit-specify', 1, 'completed'),
            buildPhase('speckit-plan', 2, 'completed'),
            buildPhase('speckit-tasks', 3, 'not-started')
          ])
        })
      ])
    }) as WorkflowSnapshot;

    const store = createPhaseLogStore();
    const setSelectionSpy = vi.spyOn(store, 'setSelection');
    render(PhaseLogFeed, { props: { snapshot, store } });
    await tick();
    await tick();
    await tick();
    await tick();

    // `speckit-plan` is the highest-ordered completed phase — the last one the
    // Run actually executed, and the log an operator opening a finished Run
    // wants to read. Not `speckit-tasks`, which never ran.
    expect(setSelectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: 'q-1',
        taskId: 'run-finished',
        pipelineId: 'standard',
        phaseId: 'speckit-plan'
      }),
      { origin: 'cascade' }
    );
  });

  it('never asks the host for a phase named `done`', async () => {
    refuseTheSentinel();
    const store = createPhaseLogStore();
    render(PhaseLogFeed, {
      props: {
        snapshot: snapshotWithRecent([
          buildRecentItem({ id: 'run-finished', currentPhase: 'done' })
        ]),
        store
      }
    });
    await tick();
    await tick();
    await tick();
    await tick();

    const probedPhases = readSpy.mock.calls.map(
      (call) => (call[0] as { selection: { phaseId: string } }).selection.phaseId
    );
    expect(probedPhases).not.toContain('done');
    expect(probedPhases.length).toBeGreaterThan(0);
  });
});

// Feature 067 — User Story 1: Live Mode follows phase transitions
// automatically. With Live Mode ON, snapshot pushes that change the
// in-flight identity tuple MUST cascade the selection via
// `store.applyInFlightIdentityChange` → `jumpToCurrent`. Identity-stable
// pushes MUST NOT re-fire the cascade.

function snapshotWithInFlight(item: Partial<QueueItem> & { id: string }): WorkflowSnapshot {
  const base = buildSnapshot();
  const inFlight: QueueItem = Object.freeze({
    ...base.queue.inFlight!,
    ...item
  } as QueueItem);
  return buildSnapshot({
    queue: Object.freeze({
      ...base.queue,
      inFlight
    } as QueueProjection)
  });
}

describe('Feature 067 US1 — Live Mode follows phase transitions automatically', () => {
  it('SC-001: cascades selection to the new phase when inFlight.currentPhase changes', async () => {
    const store = createPhaseLogStore();
    // Seed selection to T1/clarify so the cascade is observable.
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-specify'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Push a new snapshot with currentPhase changed.
    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();
    await tick();
    await tick();

    expect(jumpSpy).toHaveBeenCalled();
    expect(jumpSpy).toHaveBeenLastCalledWith(
      expect.any(Object),
      { setLiveModeOn: false, origin: 'cascade' }
    );
    // Selection should have cascaded to the new phase.
    expect(store.state.selection.phaseId).toBe('speckit-plan');
  });

  it('SC-003: identity-stable pushes do NOT re-fire jumpToCurrent', async () => {
    const store = createPhaseLogStore();
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const snap = buildSnapshot();
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: snap, store }
    });
    await tick();
    await tick();

    const callsAfterMount = jumpSpy.mock.calls.length;

    // Re-render with a snapshot whose inFlight identity tuple is
    // identical but updatedAt has changed.
    const heartbeat = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan',
      updatedAt: '2026-05-10T11:30:01.000Z'
    });
    await rerender({ snapshot: heartbeat, store });
    await tick();
    await tick();

    expect(jumpSpy.mock.calls.length).toBe(callsAfterMount);
  });

  it('cascades on task hand-off (T1 → T2)', async () => {
    const store = createPhaseLogStore();
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-specify'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    const handoff = snapshotWithInFlight({
      id: 'run-2',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-specify'
    });
    await rerender({ snapshot: handoff, store });
    await tick();
    await tick();
    await tick();
    await tick();

    expect(jumpSpy).toHaveBeenCalled();
    expect(store.state.selection.taskId).toBe('run-2');
  });

  it('does NOT cascade when Live Mode is OFF', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-specify'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();

    expect(jumpSpy).not.toHaveBeenCalled();
  });
});

// Feature 067 — User Story 2: Manual navigation pins the feed and
// disables Live Mode. Each operator-driven setter (queue/task/phase/
// iteration) MUST flip `isLiveMode` to false, and subsequent snapshot
// pushes whose in-flight identity tuple has changed MUST NOT cascade
// the selection. The "manual click on the row that already matches
// inFlight" edge case still flips Live Mode OFF per FR-005.

describe('Feature 067 US2 — Manual navigation pins the feed and disables Live Mode', () => {
  it('T018: queue click flips Live Mode OFF; subsequent identity-changing pushes do NOT cascade', async () => {
    const store = createPhaseLogStore();
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-specify'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Operator clicks a queue (manual default → flips Live Mode OFF).
    // Bracket notation avoids matching the repo-level legacy-setPaused
    // lint scanner, which scans the literal queue-setter substring used
    // by the unrelated `QueueManager.setPaused` host API; the phase-log
    // store's selection setter is per-instance and unrelated.
    store['setQueue']('q-1');
    expect(store.isLiveMode()).toBe(false);
    const callsBeforePush = jumpSpy.mock.calls.length;

    // Push a snapshot whose in-flight identity tuple has advanced.
    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();

    // Live Mode is OFF → observer must not cascade.
    expect(jumpSpy.mock.calls.length).toBe(callsBeforePush);
  });

  it('T019: task click flips Live Mode OFF; subsequent identity-changing pushes do NOT cascade', async () => {
    const store = createPhaseLogStore();
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Operator clicks a different task in the queue UI.
    store.setTask('run-pinned', 'standard');
    expect(store.isLiveMode()).toBe(false);
    const callsBeforePush = jumpSpy.mock.calls.length;

    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-tasks'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();

    expect(jumpSpy.mock.calls.length).toBe(callsBeforePush);
  });

  it('T019: phase click flips Live Mode OFF; subsequent identity-changing pushes do NOT cascade', async () => {
    const store = createPhaseLogStore();
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Operator clicks a different phase tile.
    store.setPhase('speckit-specify');
    expect(store.isLiveMode()).toBe(false);
    const callsBeforePush = jumpSpy.mock.calls.length;

    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-tasks'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();

    expect(jumpSpy.mock.calls.length).toBe(callsBeforePush);
  });

  it('T020: iteration step flips Live Mode OFF; the chosen iteration stays pinned across new pushes', async () => {
    const store = createPhaseLogStore();
    // Seed at the latest iteration (mock readSpy returns [1] by default).
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Operator steps to a prior iteration (manual default).
    store.setIteration(1);
    expect(store.isLiveMode()).toBe(false);
    expect(store.state.selection.iterationN).toBe(1);
    const callsBeforePush = jumpSpy.mock.calls.length;

    // A new snapshot arrives whose identity has advanced — pinned
    // iteration MUST be preserved and observer MUST not cascade.
    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-tasks'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();

    expect(jumpSpy.mock.calls.length).toBe(callsBeforePush);
    expect(store.state.selection.iterationN).toBe(1);
  });

  it('T021: manual click on the row that already matches inFlight STILL flips Live Mode OFF (FR-005)', async () => {
    const store = createPhaseLogStore();
    // Seed selection matching inFlight already (cascade origin keeps
    // Live Mode ON so we can verify the flip happens on the click).
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    // Operator clicks the SAME task that's already in-flight.
    store.setTask('run-1', 'standard');
    // FR-005: manual click is decisive — Live Mode flips OFF even
    // when the click does not change the visible selection.
    expect(store.isLiveMode()).toBe(false);
  });
});

// Feature 067 — User Story 3: The Live button re-enables auto-following.
// Click MUST: (a) flip isLiveMode ON, (b) cascade selection to inFlight
// when present, (c) be a graceful no-op (intent only) when inFlight is
// null. The button MUST be enabled whenever inFlight !== null regardless
// of current Live Mode state, and even when visually disabled it MUST
// allow the click handler to record the intent.

describe('Feature 067 US3 — Live button re-enables auto-following', () => {
  it('T025 (SC-005): Live button click flips Live Mode ON and cascades selection to inFlight; subsequent identity-changing pushes auto-cascade', async () => {
    const store = createPhaseLogStore();
    // Start in Live Mode OFF with a pinned selection that has drifted
    // from the current in-flight task.
    store.setLiveMode(false);
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-old',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: null
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(false);

    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    const { getByTestId, rerender } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    const jumpBtn = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    await fireEvent.click(jumpBtn);
    await tick();
    await tick();
    await tick();
    await tick();

    // jumpToCurrent invoked (default setLiveModeOn: true).
    expect(jumpSpy).toHaveBeenCalled();
    // Live Mode flipped back ON.
    expect(store.isLiveMode()).toBe(true);
    // Selection cascaded to inFlight tuple.
    expect(store.state.selection.taskId).toBe('run-1');
    expect(store.state.selection.phaseId).toBe('speckit-plan');

    // A subsequent identity-changing push must auto-cascade.
    const callsAfterClick = jumpSpy.mock.calls.length;
    const next = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-tasks'
    });
    await rerender({ snapshot: next, store });
    await tick();
    await tick();
    await tick();

    expect(jumpSpy.mock.calls.length).toBeGreaterThan(callsAfterClick);
    expect(store.state.selection.phaseId).toBe('speckit-tasks');
  });

  it('T026 (FR-008): Live button click with no inFlight is a graceful no-op — intent set ON, selection unchanged', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    store.setSelection(
      {
        queueId: 'q-pinned',
        taskId: 'run-pinned',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: 2
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(false);

    // Snapshot with no in-flight task; preserve queue.queues so the
    // breadcrumb has a queue list to render.
    const base = buildSnapshot();
    const noInFlight: WorkflowSnapshot = buildSnapshot({
      queue: Object.freeze({
        ...base.queue,
        inFlight: null
      } as QueueProjection)
    });
    const { getByTestId } = render(PhaseLogFeed, {
      props: { snapshot: noInFlight, store }
    });
    await tick();
    await tick();

    const selectionBefore = { ...store.state.selection };

    const jumpBtn = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    await fireEvent.click(jumpBtn);
    await tick();
    await tick();

    // FR-008: intent set ON, ready for the next non-null inFlight push.
    expect(store.isLiveMode()).toBe(true);
    // Selection is preserved — no cascade happened because inFlight was null.
    expect(store.state.selection).toEqual(selectionBefore);
  });

  it('T027 (FR-010): Live button click while already ON resnaps to inFlight without error (idempotence)', async () => {
    const store = createPhaseLogStore();
    // Live Mode is ON by default. Seed a stale selection that has drifted
    // from inFlight so we can observe the resnap.
    store.setSelection(
      {
        queueId: 'q-1',
        taskId: 'run-old',
        pipelineId: 'standard',
        phaseId: 'speckit-specify',
        iterationN: null
      },
      { origin: 'cascade' }
    );
    expect(store.isLiveMode()).toBe(true);

    const initial = snapshotWithInFlight({
      id: 'run-1',
      queueId: 'q-1',
      currentPipelineId: 'standard',
      currentPhase: 'speckit-plan'
    });
    const { getByTestId } = render(PhaseLogFeed, {
      props: { snapshot: initial, store }
    });
    await tick();
    await tick();

    const jumpBtn = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    await fireEvent.click(jumpBtn);
    await tick();
    await tick();
    await tick();

    // Live Mode still ON; selection resnapped to current in-flight tuple.
    expect(store.isLiveMode()).toBe(true);
    expect(store.state.selection.taskId).toBe('run-1');
    expect(store.state.selection.phaseId).toBe('speckit-plan');
  });
});

// Feature 020 BUG-002 (T076) — with no `liveTarget`, the pane read the default
// queue's in-flight row for everything live, so a Run on any other queue left
// the Live button disabled and never attached a tail. Live and the cascade
// follow the cross-queue chooser (FR-021); a tail reads the in-flight row of the
// queue the selection names (FR-022). A `liveTarget` keeps both on its Run.

function queueBInFlight(startedAt: string): QueueItem {
  const row: QueueItem = {
    id: 'b-live',
    label: 'feature b',
    enqueuedAt: '2026-05-10T10:30:00.000Z',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    status: 'in-flight',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: 'speckit-plan',
    position: 0,
    queueId: 'q-b',
    currentPipelineId: 'standard',
    phaseProgress: null
  };
  return Object.freeze(row);
}

function withQueueB(snapshot: WorkflowSnapshot, row: QueueItem): WorkflowSnapshot {
  return Object.freeze({
    ...snapshot,
    queues: Object.freeze([
      ...snapshot.queues,
      buildQueueRuntime({ queueId: 'q-b', name: 'Queue B', position: 1, tasks: Object.freeze([row]) })
    ])
  });
}

const QUEUE_B_TUPLE = Object.freeze({
  queueId: 'q-b',
  taskId: 'b-live',
  pipelineId: 'standard',
  phaseId: 'speckit-plan'
});

describe('BUG-002 — Live and the tail read in-flight Runs on every queue (FR-021, FR-022)', () => {
  it('enables Live for a Run on another queue and jumps to it', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    const { getByTestId } = render(PhaseLogFeed, {
      props: {
        snapshot: withQueueB(snapshotWithRecent([]), queueBInFlight('2026-05-10T11:00:00.000Z')),
        store
      }
    });
    await tick();
    await tick();

    const jumpBtn = getByTestId('phase-log-jump-current');
    expect(jumpBtn.getAttribute('aria-disabled')).toBe('false');

    await fireEvent.click(jumpBtn);
    await tick();
    await tick();
    await tick();
    await tick();

    expect(store.state.selection).toMatchObject(QUEUE_B_TUPLE);
  });

  it('asks for a tail on the selected queue-B Run while a later Run on q-1 is the Live target', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    // run-1 on q-1 started at 11:30, after the 11:00 start of the Run on B, so
    // Live points at run-1 while the tail follows the selection to B.
    const { getByTestId } = render(PhaseLogFeed, {
      props: {
        snapshot: withQueueB(buildSnapshot(), queueBInFlight('2026-05-10T11:00:00.000Z')),
        store
      }
    });

    await selectTuple(store, 'q-b', 'b-live', 'speckit-plan');
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledWith({ selection: { ...QUEUE_B_TUPLE, iterationN: 1 } });

    await fireEvent.click(getByTestId('phase-log-jump-current'));
    await tick();
    await tick();
    await tick();
    await tick();

    expect(store.state.selection).toMatchObject({ queueId: 'q-1', taskId: 'run-1', phaseId: 'speckit-plan' });
  });

  it('keeps Live and the tail on the liveTarget Run', async () => {
    const bLive = queueBInFlight('2026-05-10T11:00:00.000Z');
    const store = createPhaseLogStore();
    const { getByTestId } = render(PhaseLogFeed, {
      props: {
        snapshot: withQueueB(buildSnapshot(), bLive),
        store,
        autoFollow: false,
        liveTarget: { inFlight: bLive }
      }
    });

    // run-1 is in flight on q-1, but this instance is pinned to the Run on B,
    // so selecting run-1 reads its log without attaching a tail to it.
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(startSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ selection: expect.objectContaining({ taskId: 'run-1' }) })
    );

    await fireEvent.click(getByTestId('phase-log-jump-current'));
    await tick();
    await tick();
    await tick();
    await tick();

    expect(store.state.selection).toMatchObject(QUEUE_B_TUPLE);
    expect(startSpy).toHaveBeenCalledWith({ selection: { ...QUEUE_B_TUPLE, iterationN: 1 } });
  });
});

// Feature 020 BUG-002 (T079, FR-028a) — the host refuses a selection it cannot
// resolve with `unknown-tuple`. Neither of `readPhaseLog`'s ack paths gives that
// reason refusal text, by design: it is the module's own reason, not a gate's.
// So the store fell back to the bare code and the pane printed "Could not load
// logs: unknown-tuple", which names nothing an operator can act on.
describe('BUG-002 — an unknown-tuple refusal reads as operator text (FR-028a)', () => {
  it('says the selection matches nothing the host knows, never the reason code', async () => {
    readSpy.mockResolvedValue({ outcome: 'failure', reason: 'unknown-tuple' });
    const store = createPhaseLogStore();
    const { getByTestId } = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');

    const text = getByTestId('phase-log-error').textContent;
    expect(text).not.toContain('unknown-tuple');
    expect(text).toContain('does not match a Task, pipeline or phase the host knows');
    expect(text).toContain('Choose again');
  });
});

describe('FR-R5-F18 — multi-iteration live tail & bounded tail-start recovery (T18.1, T18.2)', () => {
  it('T18.1: starts live tail on iteration 3 when iterations are descending [3, 2, 1] and stops when stepping to 2 or 1', async () => {
    readSpy.mockImplementation(async (req: unknown) => {
      const sel = (req as { selection: { iterationN: number | null } }).selection;
      const chosen = sel.iterationN ?? 3;
      return {
        outcome: 'success',
        manifest: {
          iterations: [3, 2, 1],
          selectedIteration: chosen,
          entries: [makePushEntry(1, `iter-${chosen}`, 'system')],
          skippedLines: 0,
          truncatedCount: 0,
          verboseDiagnosticsState: { kind: 'entries-present' },
          isInFlight: chosen === 3
        }
      };
    });

    const store = createPhaseLogStore();
    render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 3
      }
    });

    // Step to historical iteration 2 -> stops tail and does NOT start a tail for 2.
    startSpy.mockClear();
    stopSpy.mockClear();
    store.setIteration(2);
    await tick();
    await tick();
    await tick();
    await tick();

    expect(stopSpy).toHaveBeenCalledWith({ sessionId: 'sess-A' });
    expect(startSpy).not.toHaveBeenCalled();

    // Step to oldest iteration 1 -> still does NOT start a tail (catches the old iters[iters.length - 1] bug).
    store.setIteration(1);
    await tick();
    await tick();
    await tick();
    await tick();

    expect(startSpy).not.toHaveBeenCalled();

    // Step back to newest iteration 3 -> starts tail again for 3.
    store.setIteration(3);
    await tick();
    await tick();
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 3
      }
    });
  });

  it('T18.1: switches tail once from iteration 1 to iteration 2 when a new iteration is added ([2, 1])', async () => {
    const store = createPhaseLogStore();
    const { getByTestId } = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenLastCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      }
    });

    // Host advances to iteration 2 ([2, 1] descending).
    readSpy.mockResolvedValue({
      outcome: 'success',
      manifest: {
        iterations: [2, 1],
        selectedIteration: 2,
        entries: [makePushEntry(1, 'iter-2-init', 'system')],
        skippedLines: 0,
        truncatedCount: 0,
        verboseDiagnosticsState: { kind: 'entries-present' },
        isInFlight: true
      }
    });
    startSpy.mockResolvedValue({
      outcome: 'success',
      sessionId: 'sess-B',
      mechanism: 'fs.watch',
      snapshotCutoff: 'cut-0',
      nextCursor: 'c-0',
      cursorStatus: 'none'
    });

    await fireEvent.click(getByTestId('phase-log-jump-current'));
    await tick();
    await tick();
    await tick();
    await tick();

    expect(stopSpy).toHaveBeenCalledWith({ sessionId: 'sess-A' });
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy).toHaveBeenLastCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 2
      }
    });
  });

  it('T18.1: tails iteration 3 of [3, 2, 1] across a non-default queue and two simultaneous queues', async () => {
    readSpy.mockResolvedValue({
      outcome: 'success',
      manifest: {
        iterations: [3, 2, 1],
        selectedIteration: 3,
        entries: [makePushEntry(1, 'multi-queue-iter-3', 'system')],
        skippedLines: 0,
        truncatedCount: 0,
        verboseDiagnosticsState: { kind: 'entries-present' },
        isInFlight: true
      }
    });

    const store = createPhaseLogStore();
    store.setLiveMode(false);
    render(PhaseLogFeed, {
      props: {
        snapshot: withQueueB(buildSnapshot(), queueBInFlight('2026-05-10T11:00:00.000Z')),
        store
      }
    });

    await selectTuple(store, 'q-b', 'b-live', 'speckit-plan');
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledWith({
      selection: { ...QUEUE_B_TUPLE, iterationN: 3 }
    });

    // Switch to q-1's simultaneous in-flight run also on [3, 2, 1].
    startSpy.mockClear();
    stopSpy.mockClear();
    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();

    expect(stopSpy).toHaveBeenCalledWith({ sessionId: 'sess-A' });
    expect(startSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 3
      }
    });
  });

  it('T18.2: recovers on the next snapshot after a transient not-in-flight start refusal and bounds retries to 2 attempts', async () => {
    startSpy
      .mockResolvedValueOnce({ outcome: 'failure', reason: 'not-in-flight' })
      .mockResolvedValueOnce({
        outcome: 'success',
        sessionId: 'sess-recovered',
        mechanism: 'fs.watch',
        snapshotCutoff: 'cut-0',
        nextCursor: 'c-0',
        cursorStatus: 'none'
      });

    const store = createPhaseLogStore();
    const snap = buildSnapshot();
    const { rerender, queryByTestId } = render(PhaseLogFeed, {
      props: { snapshot: snap, store }
    });

    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();

    // First attempt failed transiently -> LIVE indicator is not shown.
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(queryByTestId('phase-log-live-indicator')).toBeNull();

    // Subsequent snapshot update triggers bounded retry #2, which succeeds.
    await rerender({ snapshot: { ...snap, producedAt: '2026-05-10T12:00:01.000Z' }, store });
    await tick();
    await tick();
    await tick();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(queryByTestId('phase-log-live-indicator')).not.toBeNull();
  });

  it('T18.2: does not loop on permanent refusals or after exhausting 2 transient attempts until an explicit reload', async () => {
    startSpy.mockResolvedValue({ outcome: 'failure', reason: 'permission-denied' });

    const store = createPhaseLogStore();
    const snap = buildSnapshot();
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: snap, store }
    });

    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Duplicate snapshots must NOT auto-retry a permanent refusal.
    await rerender({ snapshot: { ...snap, producedAt: '2026-05-10T12:00:01.000Z' }, store });
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Explicit operator reload resets the refusal latch and allows a fresh attempt.
    startSpy.mockResolvedValueOnce({
      outcome: 'success',
      sessionId: 'sess-after-reload',
      mechanism: 'fs.watch',
      snapshotCutoff: 'cut-0',
      nextCursor: 'c-0',
      cursorStatus: 'none'
    });
    await store.reload();
    await tick();
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(store.state.tailSessionId).toBe('sess-after-reload');
  });

  it('T18.2: ignores late startTail resolution after selection changes and stops the superseded session', async () => {
    let resolvePendingStart: ((res: PhaseLogTailStartResult) => void) | null = null;
    startSpy.mockImplementationOnce(
      () =>
        new Promise<PhaseLogTailStartResult>((resolve) => {
          resolvePendingStart = resolve;
        })
    );

    const store = createPhaseLogStore();
    const snap = buildSnapshot();
    const { rerender } = render(PhaseLogFeed, {
      props: { snapshot: snap, store }
    });

    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Duplicate snapshot while startTail is still pending must not issue a second startTail.
    await rerender({ snapshot: { ...snap, producedAt: '2026-05-10T12:00:01.000Z' }, store });
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Operator switches to a historical phase while startTail is still pending.
    store.setPhase('speckit-specify');
    await tick();
    await tick();

    // Now the stale startTail resolves with a sessionId.
    resolvePendingStart!({
      outcome: 'success',
      sessionId: 'sess-stale',
      mechanism: 'fs.watch',
      snapshotCutoff: 'cut-0',
      nextCursor: 'c-0',
      cursorStatus: 'none'
    });
    await tick();
    await tick();

    // Stale session must NOT become active and must be stopped on the host.
    expect(store.state.tailSessionId).toBeNull();
    expect(stopSpy).toHaveBeenCalledWith({ sessionId: 'sess-stale' });
  });

  it('T18.2: stops a late-resolving pending startTail when the component unmounts mid-request', async () => {
    let resolvePendingStart: ((res: PhaseLogTailStartResult) => void) | null = null;
    startSpy.mockImplementationOnce(
      () =>
        new Promise<PhaseLogTailStartResult>((resolve) => {
          resolvePendingStart = resolve;
        })
    );

    const store = createPhaseLogStore();
    const view = render(PhaseLogFeed, {
      props: { snapshot: buildSnapshot(), store }
    });

    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    await tick();
    await tick();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Unmount while startTail is still pending.
    view.unmount();
    await tick();

    resolvePendingStart!({
      outcome: 'success',
      sessionId: 'sess-unmounted',
      mechanism: 'fs.watch',
      snapshotCutoff: 'cut-0',
      nextCursor: 'c-0',
      cursorStatus: 'none'
    });
    await tick();
    await tick();

    expect(store.state.tailSessionId).toBeNull();
    expect(stopSpy).toHaveBeenCalledWith({ sessionId: 'sess-unmounted' });
  });
});

describe('Feature 265 BUG-002 (FR-014) — live-log recovery from phase-running-no-output with zero iterations', () => {
  it('reloads the manifest and attaches the live tail when a new snapshot arrives after an initial phase-running-no-output read with empty iterations', async () => {
    readSpy.mockResolvedValueOnce({
      outcome: 'success',
      manifest: {
        iterations: [],
        selectedIteration: null,
        entries: [],
        skippedLines: 0,
        truncatedCount: 0,
        verboseDiagnosticsState: { kind: 'phase-running-no-output' },
        isInFlight: true
      }
    });

    const store = createPhaseLogStore();
    const snap = buildSnapshot();
    const { rerender } = render(PhaseLogFeed, {
      props: {
        snapshot: snap,
        store,
        autoFollow: false,
        liveTarget: { inFlight: snap.queue.inFlight }
      }
    });

    await selectTuple(store, 'q-1', 'run-1', 'speckit-plan');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(store.state.iterations).toEqual([]);
    expect(startSpy).not.toHaveBeenCalled();

    await rerender({
      snapshot: { ...snap, producedAt: '2026-05-10T12:00:05.000Z' },
      store,
      autoFollow: false,
      liveTarget: { inFlight: snap.queue.inFlight }
    });
    await tick();
    await tick();
    await tick();
    await tick();

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(store.state.iterations).toEqual([1]);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-1',
        taskId: 'run-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: 1
      }
    });
  });
});
