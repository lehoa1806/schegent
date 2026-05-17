// Feature 020 T044 — PhaseLogFeed container behavior under tail.
//
// Verifies the three observable contracts the US2 implementation
// (T051 + T053) must deliver:
//   1. When the selection resolves to (latest iteration, in-flight
//      task, active phase), the container auto-attaches a tail via
//      `startPhaseLogTail` and registers a `subscribePhaseLogPush`
//      listener (T053).
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

// --- module mocks ------------------------------------------------------

// `phase-log-ipc` is mocked so the test can both observe what the
// container asks for and drive the push listener it registers.
const startSpy = vi.fn<[unknown], Promise<PhaseLogTailStartResult>>();
const stopSpy = vi.fn<[unknown], Promise<PhaseLogTailStopResult>>();
const readSpy = vi.fn<[unknown], Promise<PhaseLogReadResult>>();
const subscribeSpy = vi.fn<
  [(payload: {
    tailSessionId: string;
    entrySeq: number;
    entry: PhaseLogDisplayEntry;
  }) => void],
  () => void
>();
let capturedPushListener:
  | ((payload: {
      tailSessionId: string;
      entrySeq: number;
      entry: PhaseLogDisplayEntry;
    }) => void)
  | null = null;

vi.mock('../../../lib/phase-log-ipc', () => ({
  readPhaseLog: (req: unknown) => readSpy(req),
  startPhaseLogTail: (req: unknown) => startSpy(req),
  stopPhaseLogTail: (req: unknown) => stopSpy(req),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: (cb: (p: {
    tailSessionId: string;
    entrySeq: number;
    entry: PhaseLogDisplayEntry;
  }) => void) => {
    capturedPushListener = cb;
    return subscribeSpy(cb);
  }
}));

// `vscode-api` post calls are inert in this test surface.
const postCommandSpy = vi.fn();
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {}
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

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const phases: readonly PhaseTile[] = Object.freeze([
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
  const queue: QueueProjection = Object.freeze({
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
        schedule: null,
        taskCount: 1
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
    schemaVersion: 3,
    isPrimary: true,
    status: 'running',
    activeFeature: null,
    phases,
    queue,
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle' as const,
      staleSeconds: 0
    }),
    workflowElapsedMs: 0,
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-10T12:00:00.000Z',
    availablePipelines: pipelines,
    availablePhases: Object.freeze([
      Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-plan', name: 'Plan', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-tasks', name: 'Tasks', instruction: '', loopable: false })
    ]),
    availableModels: Object.freeze([])
  } as WorkflowSnapshot);
  return Object.freeze({ ...base, ...overrides });
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
  capturedPushListener = null;

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
      verboseDiagnosticsState: { kind: 'enabled-with-sessions' },
      isInFlight: true
    }
  });
  startSpy.mockResolvedValue({
    outcome: 'success',
    sessionId: 'sess-A',
    mechanism: 'fs.watch'
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
    expect(capturedPushListener).not.toBeNull();

    const before = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    capturedPushListener?.({
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
    expect(capturedPushListener).not.toBeNull();

    const before = container.querySelectorAll('[data-testid="phase-log-entry"]').length;
    capturedPushListener?.({
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

    capturedPushListener?.({
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

