// Feature 063 — T026 BUG-002 closure pin.
//
// This test asserts that a *post-Clean-All* snapshot (run=null, queue
// empty, pause=null, activeRunId=null, phases all `not-started`)
// renders an idle Dashboard:
//
//   (1) Phase Progression header reads "Phase Progression" only — no
//       `(Active: ...)` suffix (FR-005 closure: WorkflowRun cleared).
//   (2) Phase Progression list contains zero `active` tiles. Tiles are
//       either absent (snapshot.phases === []) or every tile carries
//       state="not-started".
//   (3) The Activity Feed section renders. We do not assert the inner
//       reading-pane contents (that's owned by PhaseLogFeed's own
//       tests); we assert the dashboard-level container is mounted
//       and that no `Active:` text leaks into the feed header.
//
// Pins BUG-002 from
// specs/063-clean-all-confirmations/bugs/BUG-002.md — pre-063 the
// "Clean" button left `WorkflowRun` intact, so the projector still
// produced phases with `state="active"` and the header still named
// the cleared task. After Clean All ships, the snapshot the host
// pushes after a successful clear MUST produce the idle projection
// asserted below.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Dashboard from '../Dashboard.svelte';
import type {
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn(
  (..._args: readonly unknown[]) => ({ correlationId: `corr-${++nextCorrelationId}` })
);
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../../lib/phase-log-ipc', () => ({
  readPhaseLog: vi.fn().mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [],
      selectedIteration: null,
      entries: Object.freeze([]),
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: { kind: 'enabled-with-sessions' },
      isInFlight: false
    }
  }),
  startPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'idle-projection-tail',
    mechanism: 'poll'
  }),
  stopPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'idle-projection-tail'
  }),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: vi.fn(() => () => {})
}));

function buildQueue(
  overrides: Partial<QueueProjection> & { inFlight?: QueueItem | null } = {}
): QueueProjection {
  return {
    inFlight: null,
    pending: Object.freeze([]),
    recent: Object.freeze([]),
    paused: false,
    pausedReason: null,
    queues: [],
    ...overrides
  } as unknown as QueueProjection;
}

function buildIdleSnapshot(): WorkflowSnapshot {
  return {
    status: 'idle',
    isPrimary: true,
    queue: buildQueue(),
    phases: Object.freeze([]) as readonly PhaseTile[],
    monitor: null,
    activeRunId: null,
    activeFeature: null,
    activePipeline: null,
    availablePhases: [],
    availablePipelines: Object.freeze([]) as readonly PipelineDefinition[],
    history: Object.freeze([]) as readonly HistoryEntry[],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseOverrides: [],
    generalSettings: IDLE_GENERAL_SETTINGS
  } as unknown as unknown as WorkflowSnapshot;
}

beforeEach(() => {
  postCommandSpy.mockClear();
  nextCorrelationId = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Dashboard idle projection after Clean All (T026 / BUG-002)', () => {
  it('(1) Phase Progression header reads "Phase Progression" with no "(Active: …)" suffix', () => {
    const snap = buildIdleSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const header = getByTestId('dashboard-phase-progression-header');
    const text = header.textContent?.trim() ?? '';
    expect(text).toBe('Phase Progression');
    expect(text).not.toContain('Active:');
  });

  it('(2a) Phase Progression list contains no tiles when snapshot.phases is empty', () => {
    const snap = buildIdleSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const list = getByTestId('phase-progression-list');
    // Zero phase-progression-* buttons inside the stepper container.
    const tiles = list.querySelectorAll('[data-testid^="phase-progression-"]');
    expect(tiles.length).toBe(0);
  });

  it('(2b) when phases are present, every tile carries state="not-started" (no active leak)', () => {
    const phases: readonly PhaseTile[] = Object.freeze([
      { name: 'speckit-specify', state: 'not-started' } as PhaseTile,
      { name: 'speckit-clarify', state: 'not-started' } as PhaseTile,
      { name: 'speckit-plan', state: 'not-started' } as PhaseTile,
      { name: 'speckit-tasks', state: 'not-started' } as PhaseTile,
      { name: 'speckit-analyze', state: 'not-started' } as PhaseTile,
      { name: 'speckit-implement', state: 'not-started' } as PhaseTile
    ]);
    const snap = { ...buildIdleSnapshot(), phases } as unknown as unknown as WorkflowSnapshot;
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const list = getByTestId('phase-progression-list');
    const tiles = Array.from(
      list.querySelectorAll<HTMLElement>('[data-testid^="phase-progression-"]')
    );
    expect(tiles.length).toBe(6);
    for (const tile of tiles) {
      expect(tile.getAttribute('data-state')).toBe('not-started');
      // Defensive: no tile should advertise aria-current="step".
      expect(tile.getAttribute('aria-current')).not.toBe('step');
    }
  });

  it('(3) Activity Feed section mounts and its header does not leak an "Active:" tag', () => {
    const snap = buildIdleSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const feed = getByTestId('dashboard-activity-audit-feed');
    expect(feed).toBeTruthy();
    // The Activity Feed's own header says "Activity Feed"; ensure no
    // "Active:" run identifier has leaked into the panel from a stale
    // WorkflowRun projection.
    const feedText = feed.textContent ?? '';
    expect(feedText).not.toContain('Active:');
  });

  it('Clean-All button is DISABLED in the idle projection (FR-008 lower bound)', () => {
    // FR-008 says Clean All is enabled when ANY of the five surfaces
    // (queue items, in-flight, pause, active run, watchdog backoff) is
    // non-empty. An idle snapshot — the post-Clean-All steady state —
    // must therefore disable the button. This is the closure of the
    // BUG-002 idle gate, complementary to (1)/(2)/(3) which cover the
    // header/phases/feed surfaces.
    const snap = buildIdleSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('header reverts from active to idle when in-flight/activeRunId/phases are cleared', () => {
    // Sanity: a snapshot with an in-flight task and active run shows
    // "(Active: …)"; the same shape with both cleared reverts to bare
    // "Phase Progression". This pins that the header derivation in
    // PhaseProgression.svelte is correctly driven by snapshot inputs
    // the Clean All path mutates (FR-005). The header text reads from
    // `effectiveTaskId` which falls back to `queue.inFlight?.id` —
    // mutating `inFlight` is therefore sufficient to drive the change.
    const inFlightId = 'a2a4bc0b-5639-40c4-9ccc-b33711c2196f';
    const inFlight = {
      id: inFlightId,
      label: 'speckit-implement',
      status: 'in-flight',
      position: 0,
      enqueuedAt: '2026-05-22T10:00:00.000Z',
      runId: inFlightId,
      completedAt: null,
      isLastBlockingItem: false,
      currentPhase: 'speckit-implement'
    } as unknown as QueueItem;
    const active = {
      ...buildIdleSnapshot(),
      queue: buildQueue({ inFlight }),
      activeRunId: inFlightId,
      phases: Object.freeze([
        { name: 'speckit-implement', state: 'active' } as PhaseTile
      ])
    } as unknown as unknown as WorkflowSnapshot;
    const { getByTestId, unmount } = render(Dashboard, { props: { snapshot: active } });
    const activeHeader = getByTestId('dashboard-phase-progression-header');
    expect(activeHeader.textContent ?? '').toContain('Active:');
    unmount();

    const idle = buildIdleSnapshot();
    const { getByTestId: getByTestIdIdle } = render(Dashboard, { props: { snapshot: idle } });
    const idleHeader = getByTestIdIdle('dashboard-phase-progression-header');
    expect((idleHeader.textContent ?? '').trim()).toBe('Phase Progression');
  });
});
