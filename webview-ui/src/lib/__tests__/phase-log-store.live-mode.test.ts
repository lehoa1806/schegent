// Feature 067 T010 — phase-log-store Live Mode behaviour tests.
//
// Validates the store-level contract defined in
// `specs/067-live-mode-rework/contracts/phase-log-store-live-mode.md`:
//   * `setLiveMode` / `isLiveMode` round-trip and persistence
//   * `applyInFlightIdentityChange` short-circuits on identity-stable
//     snapshots, on Live Mode OFF, and on `inFlight === null`
//   * `applyInFlightIdentityChange` cascades through `jumpToCurrent`
//     exactly once when identity changes AND Live Mode is ON
//   * `jumpToCurrent({ setLiveModeOn })` semantics, including the
//     `inFlight === null` no-cascade-but-still-set-intent case
//   * `setSelection` (default and explicit `'manual'`) flips Live Mode
//     OFF; `setSelection({ origin: 'cascade' })` does NOT touch it
//   * Persistence on construction reads `vscode.getState()?.isLiveMode`
//
// All assertions exercise the public surface of `createPhaseLogStore`.
// The vscode-api module is mocked via `vi.mock` so each test can
// drive `getState` / `setState` independently.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vscode-api mock — must be hoisted above the store import below.
const getWebviewStateMock = vi.fn<() => unknown>();
const setWebviewStateMock = vi.fn<(state: unknown) => void>();

vi.mock('../vscode-api', () => ({
  getWebviewState: (...args: unknown[]) => getWebviewStateMock(...(args as [])),
  setWebviewState: (state: unknown) => setWebviewStateMock(state),
  postCommand: vi.fn(),
  onHostMessage: () => () => {}
}));

// phase-log-ipc mock — store uses these helpers as defaults. We never
// invoke them from these tests (all assertions are state-shape based),
// but the mocks ensure the module can be imported under jsdom without
// a global `acquireVsCodeApi` shim.
vi.mock('../phase-log-ipc', () => ({
  readPhaseLog: vi.fn().mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries: [],
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: null,
      isInFlight: false
    }
  }),
  startPhaseLogTail: vi.fn(),
  stopPhaseLogTail: vi.fn(),
  subscribePhaseLogPush: () => () => {}
}));

// Late import so the mocks above bind before the store module
// evaluates its top-level `getWebviewState` read inside
// `createPhaseLogStore`.
import {
  __resetLiveModeForTests,
  createPhaseLogStore,
  projectInFlightIdentity,
  type JumpToCurrentSnapshot,
  type PhaseLogSelectionDraft
} from '../phase-log-store.svelte';

type InFlight = NonNullable<JumpToCurrentSnapshot['queue']['inFlight']>;

function makeSnapshot(inFlight: InFlight | null): JumpToCurrentSnapshot {
  return Object.freeze({
    queue: Object.freeze({ inFlight }) as JumpToCurrentSnapshot['queue']
  });
}

function makeInFlight(overrides: Partial<InFlight> = {}): InFlight {
  return Object.freeze({
    id: 'run-1',
    queueId: 'q-1',
    currentPipelineId: 'standard',
    currentPhase: 'speckit-plan',
    ...overrides
  } as InFlight);
}

beforeEach(() => {
  __resetLiveModeForTests();
  getWebviewStateMock.mockReset();
  setWebviewStateMock.mockReset();
  getWebviewStateMock.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('projectInFlightIdentity', () => {
  it('returns null for null snapshot', () => {
    expect(projectInFlightIdentity(null)).toBeNull();
  });

  it('returns null when queue.inFlight is null', () => {
    expect(projectInFlightIdentity(makeSnapshot(null))).toBeNull();
  });

  it('returns the queueId|taskId|pipelineId|phaseId tuple as a string', () => {
    expect(
      projectInFlightIdentity(
        makeSnapshot(
          makeInFlight({
            id: 'task-7',
            queueId: 'q-A',
            currentPipelineId: 'pipe-X',
            currentPhase: 'speckit-tasks'
          })
        )
      )
    ).toBe('q-A|task-7|pipe-X|speckit-tasks');
  });

  it('substitutes the literal "default" for a missing queueId', () => {
    const inFlight = Object.freeze({
      id: 'task-7',
      currentPipelineId: 'pipe-X',
      currentPhase: 'speckit-tasks'
    }) as InFlight;
    expect(projectInFlightIdentity(makeSnapshot(inFlight))).toBe(
      'default|task-7|pipe-X|speckit-tasks'
    );
  });

  it('substitutes empty strings for missing pipeline/phase', () => {
    const inFlight = Object.freeze({
      id: 'task-7',
      queueId: 'q-1',
      currentPhase: null
    }) as InFlight;
    expect(projectInFlightIdentity(makeSnapshot(inFlight))).toBe(
      'q-1|task-7||'
    );
  });
});

describe('Live Mode persistence + accessors', () => {
  it('defaults isLiveMode to true when no persisted state exists', () => {
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(true);
    expect(store.state.isLiveMode).toBe(true);
  });

  it('reads persisted isLiveMode = false at construction', () => {
    getWebviewStateMock.mockReturnValue({ isLiveMode: false });
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(false);
    expect(store.state.isLiveMode).toBe(false);
  });

  it('reads persisted isLiveMode = true at construction', () => {
    getWebviewStateMock.mockReturnValue({ isLiveMode: true });
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(true);
  });

  it('falls back to true when persisted value is not a boolean', () => {
    getWebviewStateMock.mockReturnValue({ isLiveMode: 'yes' as unknown });
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(true);
  });

  it('setLiveMode(false) round-trips and persists via setWebviewState', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    expect(store.isLiveMode()).toBe(false);
    expect(setWebviewStateMock).toHaveBeenCalled();
    const lastCall = setWebviewStateMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ isLiveMode: false });
  });

  it('setLiveMode(true) after false round-trips back to true', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    store.setLiveMode(true);
    expect(store.isLiveMode()).toBe(true);
    const lastCall = setWebviewStateMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ isLiveMode: true });
  });

  it('setLiveMode merges with any prior persisted state object', () => {
    getWebviewStateMock.mockReturnValue({ otherKey: 'preserve-me' });
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    const lastCall = setWebviewStateMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({
      otherKey: 'preserve-me',
      isLiveMode: false
    });
  });
});

describe('applyInFlightIdentityChange', () => {
  it('is a no-op on identity-stable snapshots', () => {
    const store = createPhaseLogStore();
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    const snap = makeSnapshot(makeInFlight());
    store.applyInFlightIdentityChange(snap);
    // Second call with identical identity tuple
    store.applyInFlightIdentityChange(snap);
    expect(jumpSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when isLiveMode === false', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    store.applyInFlightIdentityChange(makeSnapshot(makeInFlight()));
    expect(jumpSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when snapshot.queue.inFlight === null', () => {
    const store = createPhaseLogStore();
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    store.applyInFlightIdentityChange(makeSnapshot(null));
    expect(jumpSpy).not.toHaveBeenCalled();
  });

  it('cascades exactly once with { setLiveModeOn: false, origin: "cascade" } when identity changes AND Live Mode is ON', () => {
    const store = createPhaseLogStore();
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    store.applyInFlightIdentityChange(
      makeSnapshot(makeInFlight({ currentPhase: 'speckit-clarify' }))
    );
    expect(jumpSpy).toHaveBeenCalledTimes(1);
    expect(jumpSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queue: expect.objectContaining({
          inFlight: expect.objectContaining({ currentPhase: 'speckit-clarify' })
        })
      }),
      { setLiveModeOn: false, origin: 'cascade' }
    );
  });

  it('updates the module-level identity tracker even when isLiveMode is OFF (so a later ON does not double-fire)', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    store.applyInFlightIdentityChange(makeSnapshot(makeInFlight()));
    // Now flip ON; an identity-stable snapshot must not cascade.
    store.setLiveMode(true);
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    store.applyInFlightIdentityChange(makeSnapshot(makeInFlight()));
    expect(jumpSpy).not.toHaveBeenCalled();
  });

  it('does not throw on null snapshot', () => {
    const store = createPhaseLogStore();
    expect(() => store.applyInFlightIdentityChange(null)).not.toThrow();
  });

  it('cascades on each distinct identity transition', () => {
    const store = createPhaseLogStore();
    const jumpSpy = vi.spyOn(store, 'jumpToCurrent');
    store.applyInFlightIdentityChange(
      makeSnapshot(makeInFlight({ currentPhase: 'speckit-clarify' }))
    );
    store.applyInFlightIdentityChange(
      makeSnapshot(makeInFlight({ currentPhase: 'speckit-plan' }))
    );
    store.applyInFlightIdentityChange(
      makeSnapshot(makeInFlight({ currentPhase: 'speckit-tasks' }))
    );
    expect(jumpSpy).toHaveBeenCalledTimes(3);
  });
});

describe('jumpToCurrent({ setLiveModeOn })', () => {
  it('with { setLiveModeOn: true } after setLiveMode(false) flips Live Mode back to true', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    await store.jumpToCurrent(makeSnapshot(makeInFlight()), {
      setLiveModeOn: true
    });
    expect(store.isLiveMode()).toBe(true);
  });

  it('with { setLiveModeOn: false } after setLiveMode(true) keeps Live Mode true', async () => {
    const store = createPhaseLogStore();
    await store.jumpToCurrent(makeSnapshot(makeInFlight()), {
      setLiveModeOn: false
    });
    expect(store.isLiveMode()).toBe(true);
  });

  it('with { setLiveModeOn: false } after setLiveMode(false) keeps Live Mode false', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    await store.jumpToCurrent(makeSnapshot(makeInFlight()), {
      setLiveModeOn: false
    });
    expect(store.isLiveMode()).toBe(false);
  });

  it('returns null when snapshot.queue.inFlight === null, with no selection change', async () => {
    const store = createPhaseLogStore();
    const before = store.state.selection;
    const result = await store.jumpToCurrent(makeSnapshot(null), {
      setLiveModeOn: true
    });
    expect(result).toBeNull();
    expect(store.state.selection).toEqual(before);
  });

  it('with { setLiveModeOn: true } AND inFlight === null still calls setLiveMode(true) BEFORE the early-return (FR-008)', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    const result = await store.jumpToCurrent(makeSnapshot(null), {
      setLiveModeOn: true
    });
    expect(result).toBeNull();
    expect(store.isLiveMode()).toBe(true);
  });

  it('defaults { setLiveModeOn: true } when options is omitted', async () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    await store.jumpToCurrent(makeSnapshot(makeInFlight()));
    expect(store.isLiveMode()).toBe(true);
  });
});

describe('setSelection / set* origin discrimination', () => {
  const next: PhaseLogSelectionDraft = Object.freeze({
    queueId: 'q-1',
    taskId: 'run-1',
    pipelineId: 'standard',
    phaseId: 'speckit-plan',
    iterationN: 1
  });

  it('setSelection (no options) flips isLiveMode OFF when it was ON', () => {
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(true);
    store.setSelection(next);
    expect(store.isLiveMode()).toBe(false);
  });

  it('setSelection with explicit { origin: "manual" } flips isLiveMode OFF', () => {
    const store = createPhaseLogStore();
    store.setSelection(next, { origin: 'manual' });
    expect(store.isLiveMode()).toBe(false);
  });

  it('setSelection with { origin: "cascade" } leaves isLiveMode unchanged', () => {
    const store = createPhaseLogStore();
    expect(store.isLiveMode()).toBe(true);
    store.setSelection(next, { origin: 'cascade' });
    expect(store.isLiveMode()).toBe(true);
  });

  it('setQueue (no options) flips isLiveMode OFF', () => {
    const store = createPhaseLogStore();
    store.setQueue('q-1');
    expect(store.isLiveMode()).toBe(false);
  });

  it('setQueue with { origin: "cascade" } leaves isLiveMode unchanged', () => {
    const store = createPhaseLogStore();
    store.setQueue('q-1', { origin: 'cascade' });
    expect(store.isLiveMode()).toBe(true);
  });

  it('setTask (no options) flips isLiveMode OFF', () => {
    const store = createPhaseLogStore();
    store.setTask('run-1', 'standard');
    expect(store.isLiveMode()).toBe(false);
  });

  it('setTask with { origin: "cascade" } leaves isLiveMode unchanged', () => {
    const store = createPhaseLogStore();
    store.setTask('run-1', 'standard', { origin: 'cascade' });
    expect(store.isLiveMode()).toBe(true);
  });

  it('setPhase (no options) flips isLiveMode OFF', () => {
    const store = createPhaseLogStore();
    store.setPhase('speckit-plan');
    expect(store.isLiveMode()).toBe(false);
  });

  it('setPhase with { origin: "cascade" } leaves isLiveMode unchanged', () => {
    const store = createPhaseLogStore();
    store.setPhase('speckit-plan', { origin: 'cascade' });
    expect(store.isLiveMode()).toBe(true);
  });

  it('setIteration (no options) flips isLiveMode OFF', () => {
    const store = createPhaseLogStore();
    store.setIteration(2);
    expect(store.isLiveMode()).toBe(false);
  });

  it('setIteration with { origin: "cascade" } leaves isLiveMode unchanged', () => {
    const store = createPhaseLogStore();
    store.setIteration(2, { origin: 'cascade' });
    expect(store.isLiveMode()).toBe(true);
  });

  it('setSelection when Live Mode is already OFF does not re-persist (idempotent)', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    setWebviewStateMock.mockClear();
    store.setSelection(next);
    expect(setWebviewStateMock).not.toHaveBeenCalled();
  });
});

describe('reset() preserves isLiveMode (FR-015 persistence intent)', () => {
  it('reset() called after setLiveMode(false) keeps isLiveMode === false', () => {
    const store = createPhaseLogStore();
    store.setLiveMode(false);
    store.reset();
    expect(store.isLiveMode()).toBe(false);
  });

  it('reset() called with default Live Mode keeps isLiveMode === true', () => {
    const store = createPhaseLogStore();
    store.reset();
    expect(store.isLiveMode()).toBe(true);
  });
});
