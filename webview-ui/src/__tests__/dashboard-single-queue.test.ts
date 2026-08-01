// Feature 030 (US3, T037) — assert that Dashboard.svelte under the
// single-queue mode renders:
//   - NO element with role 'tab' (no "Queue" tab-bar navigation)
//   - NO element with role 'button' labelled "Rename queue", "Delete queue",
//     or "New queue" / "Add queue"
//   - the unified queue list IS rendered inline (data-testid
//     `dashboard-queue-list` is present and houses the ordered queue items)
//
// Mounts Dashboard with a synthetic v6 snapshot whose `queue.queues`
// projection has exactly one entry (`id: 'default'`). The test is
// written BEFORE the implementation strips the queue tab markup, so
// the initial run is expected to fail until T039-T045 land.
//
// The Dashboard.test.ts pattern (postCommand mock + phase-log mock) is
// reused so the mount succeeds without a real VS Code bridge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Dashboard from '../components/Dashboard.svelte';
import type {
  CliMonitorState,
  GeneralSettings,
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  QueueSummary,
  PhaseDefinition,
  BackendRunnerKind,
  WorkflowSnapshot
} from '../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn(
  (..._args: readonly unknown[]) => ({ correlationId: `corr-${++nextCorrelationId}` })
);
vi.mock('../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../lib/phase-log-ipc', () => ({
  readPhaseLog: vi.fn().mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries: Object.freeze([]),
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: { kind: 'enabled-with-sessions' },
      isInFlight: false
    }
  }),
  startPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'single-queue-test-tail',
    mechanism: 'poll'
  }),
  stopPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'single-queue-test-tail'
  }),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: vi.fn(() => () => {})
}));

beforeEach(() => {
  postCommandSpy.mockReset();
  nextCorrelationId = 0;
  postCommandSpy.mockImplementation(
    (..._args: readonly unknown[]) => ({ correlationId: `corr-${++nextCorrelationId}` })
  );
});
afterEach(() => cleanup());

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

function buildQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return Object.freeze({
    id: 'task-1',
    label: 'build a thing',
    enqueuedAt: '2026-05-15T12:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-15T12:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    queueId: 'default',
    position: 0,
    ...overrides
  });
}

function buildDefaultQueueSummary(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return Object.freeze({
    id: 'default',
    name: 'Default queue',
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0,
    ...overrides
  });
}

function buildQueue(overrides: Partial<QueueProjection> = {}): QueueProjection {
  // Feature 065 BUG-009 T077 (FR-029) — derive `orderedItems` from the
  // legacy bucket overrides so tests that pass `pending`/`inFlight`/
  // `recent` without an explicit projection still mount queue rows in
  // the host-emitted order.
  const base = {
    inFlight: null as QueueItem | null,
    pending: Object.freeze([]) as readonly QueueItem[],
    recent: Object.freeze([]) as readonly QueueItem[],
    orderedItems: Object.freeze([]) as readonly QueueItem[],
    paused: false,
    queues: Object.freeze([buildDefaultQueueSummary()]) as readonly QueueSummary[],
    ...overrides
  };
  if (!('orderedItems' in overrides) || overrides.orderedItems === undefined) {
    const ordered: QueueItem[] = [];
    if (base.inFlight !== null) ordered.push(base.inFlight);
    ordered.push(...[...base.pending].sort((a, b) => a.position - b.position));
    ordered.push(...base.recent);
    return Object.freeze({
      ...base,
      orderedItems: Object.freeze(ordered) as readonly QueueItem[]
    });
  }
  return Object.freeze(base);
}

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const phases: readonly PhaseTile[] = Object.freeze([
    buildPhase('speckit-specify', 1, 'not-started'),
    buildPhase('speckit-plan', 2, 'not-started'),
    buildPhase('speckit-implement', 3, 'not-started')
  ]);
  const generalSettings: GeneralSettings = Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    defaultPipelineId: 'standard'
  });
  const base: WorkflowSnapshot = Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases,
    queue: buildQueue(),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: 'idle',
      category: 'phase-transition' as const,
      lastEventAt: '2026-05-15T12:00:00.000Z',
      freshness: 'live' as const,
      staleSeconds: 0
    }),
    workflowElapsedMs: 0,
    monitor: null as CliMonitorState | null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-15T12:00:30.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({
        id: 'standard',
        name: 'Standard',
        phases: Object.freeze(['speckit-specify', 'speckit-plan']) as readonly string[]
      }) as PipelineDefinition
    ]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude']) as readonly BackendRunnerKind[],
    generalSettings
  });
  return Object.freeze({ ...base, ...overrides });
}

describe('Feature 030 (US3, T037) — Dashboard single-queue UI', () => {
  it('renders only the history/queue toggle tabs, no multi-queue tab-bar', () => {
    const snap = buildSnapshot();
    const { container } = render(Dashboard, { props: { snapshot: snap } });
    const tabs = container.querySelectorAll('[role="tab"]');
    // We now have two tabs for the Queue / History toggle, but no multi-queue tabs.
    expect(
      tabs.length,
      `Expected 2 role="tab" elements (Queue/History toggle), found ${tabs.length}`
    ).toBe(2);
    const tablist = container.querySelectorAll('[role="tablist"]');
    expect(
      tablist.length,
      `Expected zero role="tablist" elements, found ${tablist.length}`
    ).toBe(0);
  });

  it('renders no button labelled "Rename queue"', () => {
    const snap = buildSnapshot();
    const { container } = render(Dashboard, { props: { snapshot: snap } });
    const buttons = Array.from(container.querySelectorAll('button'));
    const offenders = buttons.filter((btn) => {
      const aria = btn.getAttribute('aria-label') ?? '';
      const text = btn.textContent ?? '';
      return /\brename queue\b/i.test(aria) || /\brename queue\b/i.test(text);
    });
    expect(
      offenders.length,
      `Expected no "Rename queue" buttons, found ${offenders.length}`
    ).toBe(0);
  });

  it('renders no button labelled "Delete queue"', () => {
    const snap = buildSnapshot();
    const { container } = render(Dashboard, { props: { snapshot: snap } });
    const buttons = Array.from(container.querySelectorAll('button'));
    const offenders = buttons.filter((btn) => {
      const aria = btn.getAttribute('aria-label') ?? '';
      const text = btn.textContent ?? '';
      return /\bdelete queue\b/i.test(aria) || /\bdelete queue\b/i.test(text);
    });
    expect(
      offenders.length,
      `Expected no "Delete queue" buttons, found ${offenders.length}`
    ).toBe(0);
  });

  it('renders no button labelled "New queue" / "Add queue" / "Create queue"', () => {
    const snap = buildSnapshot();
    const { container } = render(Dashboard, { props: { snapshot: snap } });
    const buttons = Array.from(container.querySelectorAll('button'));
    const offenders = buttons.filter((btn) => {
      const aria = btn.getAttribute('aria-label') ?? '';
      const text = btn.textContent ?? '';
      const combined = `${aria} ${text}`;
      return /\b(new|add|create)\s+queue\b/i.test(combined);
    });
    expect(
      offenders.length,
      `Expected no New/Add/Create queue buttons, found ${offenders.length}`
    ).toBe(0);
  });

  it('renders the unified queue list inline (data-testid="dashboard-queue-list")', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([
          buildQueueItem({ id: 'task-a', label: 'task a', position: 0 }),
          buildQueueItem({ id: 'task-b', label: 'task b', position: 1 })
        ]) as readonly QueueItem[],
        queues: Object.freeze([
          buildDefaultQueueSummary({ taskCount: 2 })
        ]) as readonly QueueSummary[]
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const queueList = getByTestId('dashboard-queue-list');
    expect(queueList).not.toBeNull();
    // Each pending task should be rendered inline as a queue item row.
    expect(queueList.querySelector('[data-testid="dashboard-queue-item-task-a"]')).not.toBeNull();
    expect(queueList.querySelector('[data-testid="dashboard-queue-item-task-b"]')).not.toBeNull();
  });

  it('does not render the QueueManagementPanel tab-bar (it has been removed)', () => {
    const snap = buildSnapshot();
    const { queryByTestId } = render(Dashboard, { props: { snapshot: snap } });
    // QueueManagementPanel.svelte was deleted in T040. Its root testid is
    // `queue-management-panel`; assert no element carries it.
    const panel = queryByTestId('queue-management-panel');
    expect(panel).toBeNull();
  });
});
