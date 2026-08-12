import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Dashboard from '../Dashboard.svelte';
import {
  CMD_START,
  CMD_START_QUEUE,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_CLEAR_ALL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED
} from '../../lib/messages';
import type {
  CliMonitorState,
  GeneralSettings,
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  QueueSummary,
  WorkflowSnapshot,
  BackendRunnerKind
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

// Feature 017 — BUG-003 / T124. The Dashboard submit flow now captures the
// correlationId returned from `postCommand` and registers a one-shot ACK
// listener via `snapshotStore.onceAck(correlationId, …)`. The textarea is
// cleared ONLY on an accepted ACK whose `result.outcome === 'enqueued'`.
// The webview tests stub `postCommand` to return a synthetic correlationId
// and inject ACKs through the REAL `snapshotStore.apply(CMD_ACK)` public
// API so downstream components (`QueueItemActions`, `QueueList`, …) still
// see the genuine accessors they depend on.
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

// Feature 063 — all destructive controls in Dashboard.svelte route through
// `useConfirm(...)`. These wiring tests assert the post-confirm IPC path,
// so the mock auto-confirms; suppression and dialog rendering are tested
// elsewhere (use-confirm.test.ts, ConfirmDialog.test.ts).
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { CMD_ACK } from '../../lib/messages';
import { readPhaseLog } from '../../lib/phase-log-ipc';

function fireAck(
  correlationId: string,
  status: 'accepted' | 'rejected',
  payload?: { reason?: string; result?: unknown }
): void {
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId,
    status,
    ...(payload?.reason !== undefined ? { reason: payload.reason } : {}),
    ...(payload?.result !== undefined ? { result: payload.result } : {})
  } as never);
}

vi.mock('../../lib/phase-log-ipc', () => ({
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
    sessionId: 'dashboard-test-tail',
    mechanism: 'poll'
  }),
  stopPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'dashboard-test-tail'
  }),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: vi.fn(() => () => {})
}));

beforeEach(() => {
  postCommandSpy.mockReset();
  vi.mocked(readPhaseLog).mockClear();
  // Restore the default `{ correlationId: 'corr-N' }` shape after `mockReset()`
  // strips the implementation. Without this, the destructure
  // `const { correlationId } = postCommand(…)` in Dashboard.onSubmit would
  // throw on the next render.
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

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const phases: readonly PhaseTile[] = Object.freeze([
    buildPhase('speckit-specify', 1, 'completed'),
    buildPhase('speckit-clarify', 2, 'completed'),
    buildPhase('speckit-plan', 3, 'active'),
    buildPhase('speckit-tasks', 4, 'not-started'),
    buildPhase('speckit-analyze', 5, 'not-started'),
    buildPhase('speckit-implement', 6, 'not-started'),
    buildPhase('finalize', 7, 'not-started')
  ]);
  const base: WorkflowSnapshot = Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'running',
    activeFeature: {
      id: 'f-active',
      label: 'feature in progress',
      startedAt: '2026-05-10T12:00:00.000Z'
    },
    phases,
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      paused: false
    }),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: 'plan-iteration-2',
      category: 'phase-transition' as const,
      lastEventAt: '2026-05-10T12:00:30.000Z',
      freshness: 'live' as const,
      staleSeconds: 0
    }),
    workflowElapsedMs: 30_000,
    monitor: null as CliMonitorState | null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-10T12:00:30.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({
        id: 'standard',
        name: 'Standard',
        phases: Object.freeze(['speckit-specify', 'speckit-plan']) as readonly string[]
      })
    ]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude']) as readonly BackendRunnerKind[],
  });
  return Object.freeze({ ...base, ...overrides });
}

function buildQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return Object.freeze({
    id: 'q-1',
    label: 'feature one',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T11:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  });
}

function buildQueue(overrides: Partial<QueueProjection> = {}): QueueProjection {
  // Feature 065 BUG-009 T077 (FR-029) — `orderedItems` is the canonical
  // flat projection consumed by `QueueListView`. Tests that pass
  // `inFlight`/`pending`/`recent` overrides without supplying their own
  // `orderedItems` get a derived projection in the host-emitted order
  // (in-flight first, then pending sorted by position, then recent).
  const base = {
    inFlight: null as QueueItem | null,
    pending: Object.freeze([]) as readonly QueueItem[],
    recent: Object.freeze([]) as readonly QueueItem[],
    orderedItems: Object.freeze([]) as readonly QueueItem[],
    paused: false,
    ...overrides
  };
  if (!('orderedItems' in overrides) || overrides.orderedItems === undefined) {
    const ordered: QueueItem[] = [];
    if (base.inFlight !== null) ordered.push(base.inFlight);
    const pendingSorted = [...base.pending].sort((a, b) => a.position - b.position);
    ordered.push(...pendingSorted);
    ordered.push(...base.recent);
    return Object.freeze({
      ...base,
      orderedItems: Object.freeze(ordered) as readonly QueueItem[]
    });
  }
  return Object.freeze(base);
}

function buildQueueSummary(overrides: Partial<QueueSummary> = {}): QueueSummary {
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

describe('Dashboard FR-033..FR-038 layout (T058)', () => {
  describe('FR-033 zone ordering', () => {
    it('renders the five layout zones in top-to-bottom order', () => {
      const snap = buildSnapshot();
      const { container } = render(Dashboard, { props: { snapshot: snap } });
      const zoneIds = [
        'dashboard-queue-input',
        'dashboard-queue-management',
        'dashboard-queue-list',
        'dashboard-phase-progression',
        'dashboard-activity-audit-feed'
      ];
      const found = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid]')
      )
        .map((el) => el.getAttribute('data-testid'))
        .filter((id): id is string => id !== null && zoneIds.includes(id));
      expect(found).toEqual(zoneIds);
    });
  });

  describe('FR-034 Queue Input', () => {
    it('contains a textarea and a Submit button', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      expect(zone.querySelector('textarea')).not.toBeNull();
      expect(
        zone.querySelector('button[data-testid="dashboard-queue-input-submit"]')
      ).not.toBeNull();
    });

    it('makes backend network dependence visible before a task is submitted', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const note = getByTestId('dashboard-network-dependence-note');
      expect(note.textContent).toContain('Local-first, not offline');
      expect(note.textContent).toContain('configured backend providers');
    });

    it('textarea has maxlength="4096"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      const ta = zone.querySelector('textarea');
      expect(ta).not.toBeNull();
      expect(ta!.getAttribute('maxlength')).toBe('4096');
    });

    it('Submit is disabled when textarea is empty', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('Submit is disabled when textarea is whitespace-only', async () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      const ta = zone.querySelector('textarea')!;
      const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
      await fireEvent.input(ta, { target: { value: '   \n\t  ' } });
      await tick();
      expect(btn.disabled).toBe(true);
    });

    it('submitting a non-empty trimmed value calls postCommand(CMD_START, { description }) once and clears the textarea once the host acks `enqueued`', async () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      const ta = zone.querySelector<HTMLTextAreaElement>('textarea')!;
      const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
      await fireEvent.input(ta, { target: { value: '  build foo  ' } });
      await tick();
      expect(btn.disabled).toBe(false);
      await fireEvent.click(btn);
      await tick();
      expect(postCommandSpy).toHaveBeenCalledTimes(1);
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_START, { description: 'build foo' });
      // BUG-003 — the description must persist until the ACK arrives so a
      // rejection lets the operator retry without retyping.
      expect(ta.value).toBe('  build foo  ');
      fireAck('corr-1', 'accepted', { result: { outcome: 'enqueued', queueName: 'Default queue' } });
      await tick();
      expect(ta.value).toBe('');
    });
  });

  // T021c (US2, FR-014 UI smoke) — pipeline selector in the new-task form.
  describe('FR-014 pipeline selector (T021c, US2)', () => {
    function buildSnapshotWithPipelines(
      pipelines: readonly PipelineDefinition[],
      defaultPipelineId: string
    ): WorkflowSnapshot {
      const base = buildSnapshot();
      const generalSettings: GeneralSettings = Object.freeze({
        ...IDLE_GENERAL_SETTINGS,
        defaultPipelineId
      });
      return Object.freeze({
        ...base,
        availablePipelines: pipelines,
        generalSettings
      });
    }

    const SPECKIT_NEW_FEATURE: PipelineDefinition = Object.freeze({
      id: 'speckit-new-feature',
      name: 'Spec-kit New Feature',
      phases: Object.freeze([
        'speckit-specify',
        'speckit-clarify',
        'speckit-plan'
      ]) as readonly string[]
    });
    const SPECKIT_BUGFIX: PipelineDefinition = Object.freeze({
      id: 'speckit-bugfix',
      name: 'Spec-kit Bugfix',
      phases: Object.freeze([
        'bugfix-report',
        'bugfix-patch',
        'bugfix-verify-pre',
        'bugfix-implement',
        'bugfix-verify-post'
      ]) as readonly string[]
    });

    it('(a) renders the pipeline selector with one option per merged-catalog pipeline when >= 2 pipelines are advertised', () => {
      const snap = buildSnapshotWithPipelines(
        [SPECKIT_NEW_FEATURE, SPECKIT_BUGFIX],
        'speckit-new-feature'
      );
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      const select = zone.querySelector<HTMLSelectElement>('select.pipeline-select');
      expect(select).not.toBeNull();
      expect(select!.disabled).toBe(false);
      const optionIds = Array.from(select!.options).map((o) => o.value);
      expect(optionIds).toEqual(['speckit-new-feature', 'speckit-bugfix']);
    });

    it('(b) default selection is BUILT_IN_PIPELINE_ID ("speckit-new-feature") and adding speckit-bugfix does NOT change it (FR-010 default-preservation)', async () => {
      const snap = buildSnapshotWithPipelines(
        [SPECKIT_NEW_FEATURE, SPECKIT_BUGFIX],
        'speckit-new-feature'
      );
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await tick();
      const zone = getByTestId('dashboard-queue-input');
      const select = zone.querySelector<HTMLSelectElement>('select.pipeline-select')!;
      expect(select.value).toBe('speckit-new-feature');
    });

    it('(c) choosing speckit-bugfix and submitting posts CMD_START with pipelineId: "speckit-bugfix"', async () => {
      const snap = buildSnapshotWithPipelines(
        [SPECKIT_NEW_FEATURE, SPECKIT_BUGFIX],
        'speckit-new-feature'
      );
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await tick();
      const zone = getByTestId('dashboard-queue-input');
      const select = zone.querySelector<HTMLSelectElement>('select.pipeline-select')!;
      const ta = zone.querySelector<HTMLTextAreaElement>('textarea')!;
      const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
      await fireEvent.change(select, { target: { value: 'speckit-bugfix' } });
      await tick();
      await fireEvent.input(ta, { target: { value: 'fix the login bug' } });
      await tick();
      await fireEvent.click(btn);
      await tick();
      expect(postCommandSpy).toHaveBeenCalledTimes(1);
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_START, {
        description: 'fix the login bug',
        pipelineId: 'speckit-bugfix'
      });
    });

    it('(d) when only one pipeline is advertised the selector remains visible but offers only that single option (single-pipeline case is not visually noisy)', () => {
      const snap = buildSnapshotWithPipelines(
        [SPECKIT_NEW_FEATURE],
        'speckit-new-feature'
      );
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-input');
      const select = zone.querySelector<HTMLSelectElement>('select.pipeline-select')!;
      expect(select).not.toBeNull();
      // With exactly one pipeline available the operator cannot select a different one
      // — the selector is functionally trivial (the single-option degenerate case satisfies
      // "not visually noisy" without requiring DOM removal).
      expect(select.options).toHaveLength(1);
      expect(select.options[0].value).toBe('speckit-new-feature');
    });
  });

  describe('FR-035 Queue Management Controls', () => {
    it('contains contextual action button plus Clear Done and Clean', () => {
      // BUG-003 / FR-012a — the separate Resume + Pause buttons were
      // consolidated into a single contextual button. When the default
      // snapshot has no in-flight and no pending, the action button is
      // hidden (idle state).
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-fly', status: 'in-flight' })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-management');
      expect(zone.querySelector('[data-testid="dashboard-queue-action"]')).not.toBeNull();
      expect(zone.querySelector('[data-testid="dashboard-queue-clear-done"]')).not.toBeNull();
      expect(zone.querySelector('[data-testid="dashboard-queue-clean"]')).not.toBeNull();
    });

    it('contextual button shows Resume when paused, Pause when in-flight, Start when pending+idle', () => {
      // Paused -> Resume
      const snapPaused = buildSnapshot({ queue: buildQueue({ paused: true }) });
      const { getByTestId, unmount } = render(Dashboard, {
        props: { snapshot: snapPaused }
      });
      const resumeBtn = getByTestId('dashboard-queue-action') as HTMLButtonElement;
      expect(resumeBtn.textContent?.trim()).toBe('Resume');
      expect(resumeBtn.disabled).toBe(false);
      unmount();

      // In-flight -> Pause
      const snapInFlight = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-fly', status: 'in-flight' })
        })
      });
      const { getByTestId: get2, unmount: unmount2 } = render(Dashboard, {
        props: { snapshot: snapInFlight }
      });
      const pauseBtn = get2('dashboard-queue-action') as HTMLButtonElement;
      expect(pauseBtn.textContent?.trim()).toBe('Pause');
      expect(pauseBtn.disabled).toBe(false);
      unmount2();

      // Pending + idle -> Start
      const snapPending = buildSnapshot({
        queue: buildQueue({
          pending: Object.freeze([
            buildQueueItem({ id: 'q-p', status: 'pending', position: 0 })
          ])
        })
      });
      const { getByTestId: get3 } = render(Dashboard, {
        props: { snapshot: snapPending }
      });
      const startBtn = get3('dashboard-queue-action') as HTMLButtonElement;
      expect(startBtn.textContent?.trim()).toBe('Start Queue');
      expect(startBtn.disabled).toBe(false);
    });

    it('action button hidden when idle (no pending, no in-flight, not paused)', () => {
      const snap = buildSnapshot();
      const { queryByTestId } = render(Dashboard, { props: { snapshot: snap } });
      expect(queryByTestId('dashboard-queue-action')).toBeNull();
    });

    it('Resume click fires CMD_RESUME_QUEUE', async () => {
      const snap = buildSnapshot({ queue: buildQueue({ paused: true }) });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await fireEvent.click(getByTestId('dashboard-queue-action'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_QUEUE);
    });

    it('Pause click fires CMD_PAUSE_QUEUE', async () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-fly', status: 'in-flight' })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await fireEvent.click(getByTestId('dashboard-queue-action'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_QUEUE);
    });

    it('Start click fires CMD_START_QUEUE', async () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          pending: Object.freeze([
            buildQueueItem({ id: 'q-p', status: 'pending', position: 0 })
          ])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await fireEvent.click(getByTestId('dashboard-queue-action'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_START_QUEUE);
    });

    it('Clear Done click fires CMD_CLEAR_COMPLETED', async () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          recent: Object.freeze([
            buildQueueItem({
              id: 'q-done',
              status: 'completed',
              completedAt: '2026-05-10T11:00:00.000Z'
            })
          ])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await fireEvent.click(getByTestId('dashboard-queue-clear-done'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_COMPLETED);
    });

    // Feature 063 (T023): the Clean button is now "Clean All" and posts
    // a single `CMD_CLEAR_ALL` after operator confirmation, never the
    // legacy compound CMD_CLEAR_COMPLETED + CMD_CLEAR_FAILED pair.
    it('Clean All click posts CMD_CLEAR_ALL exactly once and does not post the legacy pair', async () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          recent: Object.freeze([
            buildQueueItem({
              id: 'q-d',
              status: 'completed',
              completedAt: '2026-05-10T11:00:00.000Z'
            }),
            buildQueueItem({ id: 'q-f', status: 'failed' })
          ])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      await fireEvent.click(getByTestId('dashboard-queue-clean'));
      const calls = postCommandSpy.mock.calls.map((c) => c[0]);
      expect(calls).toContain(CMD_CLEAR_ALL);
      expect(calls).not.toContain(CMD_CLEAR_COMPLETED);
      expect(calls).not.toContain(CMD_CLEAR_FAILED);
    });
  });

  describe('FR-036 Active & Pending Queue', () => {
    it('renders items in inFlight → pending → recent order with numbered prefixes', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({
            id: 'q-flight',
            label: 'in flight item',
            status: 'in-flight'
          }),
          pending: Object.freeze([
            buildQueueItem({
              id: 'q-p1',
              label: 'pending one',
              status: 'pending',
              position: 0
            }),
            buildQueueItem({
              id: 'q-p2',
              label: 'pending two',
              status: 'pending',
              position: 1
            })
          ]),
          recent: Object.freeze([
            buildQueueItem({ id: 'q-fail', label: 'failed item', status: 'failed' })
          ])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-queue-list');
      const rows = Array.from(
        zone.querySelectorAll<HTMLElement>('li[data-testid^="dashboard-queue-item-"]')
      );
      expect(rows.length).toBe(4);
      expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
        'dashboard-queue-item-q-flight',
        'dashboard-queue-item-q-p1',
        'dashboard-queue-item-q-p2',
        'dashboard-queue-item-q-fail'
      ]);
      expect(rows[0].getAttribute('data-testid')).toBe('dashboard-queue-item-q-flight');
      expect(rows[1].getAttribute('data-testid')).toBe('dashboard-queue-item-q-p1');
      expect(rows[2].getAttribute('data-testid')).toBe('dashboard-queue-item-q-p2');
      expect(rows[3].getAttribute('data-testid')).toBe('dashboard-queue-item-q-fail');
    });

    it('status badges use the canonical "in-flight" literal', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({
            id: 'q-flight',
            label: 'in flight',
            status: 'in-flight'
          })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const badge = getByTestId('queue-item-status-q-flight');
      expect(badge.textContent?.trim()).toBe('in-flight');
    });

    it('per-status action sets (022): all rows expose Delete plus status-specific controls', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-flight', status: 'in-flight' }),
          pending: Object.freeze([
            buildQueueItem({ id: 'q-p1', status: 'pending', position: 0 }),
            buildQueueItem({ id: 'q-p2', status: 'pending', position: 1 })
          ]),
          recent: Object.freeze([
            buildQueueItem({ id: 'q-fail', status: 'failed' }),
            buildQueueItem({ id: 'q-done', status: 'completed' }),
            buildQueueItem({ id: 'q-can', status: 'canceled' })
          ])
        })
      });
      const { queryByTestId, getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      // in-flight -> Cancel plus Delete
      expect(queryByTestId('queue-item-cancel-q-flight')).not.toBeNull();
      expect(queryByTestId('queue-item-remove-q-flight')).not.toBeNull();
      // pending -> Remove. Feature 030 (US2, T034) moved the up/down
      // arrows into `QueueItem.svelte` (the sidebar queue list), which
      // the Dashboard does NOT render — the Dashboard's inline queue
      // rows use only `<QueueItemActions>`. The reorder glyphs are
      // exercised by `QueueItem.reorder.test.ts` against the actual
      // surface that owns them.
      expect(queryByTestId('queue-item-remove-q-p1')).not.toBeNull();
      expect(queryByTestId('queue-item-cancel-q-p1')).toBeNull();
      // failed -> Retry plus Delete
      expect(queryByTestId('queue-item-retry-q-fail')).not.toBeNull();
      expect(queryByTestId('queue-item-remove-q-fail')).not.toBeNull();
      // completed rows render Delete
      const doneRow = getByTestId('dashboard-queue-item-q-done');
      expect(doneRow.querySelectorAll('.actions-slot button').length).toBe(1);
      expect(queryByTestId('queue-item-remove-q-done')).not.toBeNull();
      // canceled rows expose Restart plus Delete
      const canRow = getByTestId('dashboard-queue-item-q-can');
      expect(canRow.querySelectorAll('.actions-slot button').length).toBe(2);
      expect(queryByTestId('queue-item-restart-q-can')).not.toBeNull();
      expect(queryByTestId('queue-item-remove-q-can')).not.toBeNull();
    });
  });

  describe('FR-037 Phase Progression', () => {
    it('renders all seven phases', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-phase-progression');
      const phaseEls = Array.from(
        zone.querySelectorAll<HTMLElement>(
          '[data-testid^="phase-progression-"]:not([data-testid="phase-progression-arrow"]):not([data-testid="phase-progression-list"])'
        )
      );
      expect(phaseEls.length).toBe(7);
    });

    it('marks the active phase with aria-current="step"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      expect(getByTestId('phase-progression-speckit-plan').getAttribute('aria-current')).toBe('step');
      expect(getByTestId('phase-progression-speckit-specify').getAttribute('aria-current')).toBeNull();
    });
  });

  describe('FR-038 Activity Feed (phase-log replacement — feature 020)', () => {
    it('mounts the PhaseLogFeed wrapper inside the Activity Feed zone (audit-tail rows removed)', () => {
      // Feature 020 T040 — the audit-tail per-row rendering was
      // replaced by `<PhaseLogFeed/>`. The zone still carries
      // `dashboard-activity-audit-feed` and the "Activity Feed"
      // header for visual continuity, but the per-entry rows are
      // gone. PhaseLogFeed-internal markers
      // (`phase-log-feed`, `phase-log-selectors`, …) carry their
      // own dedicated unit tests under PhaseLogFeed/__tests__/.
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const feed = getByTestId('dashboard-activity-audit-feed');
      expect(feed.querySelector('[data-testid="phase-log-feed"]')).not.toBeNull();
      expect(
        feed.querySelectorAll<HTMLElement>('[data-testid^="activity-feed-row-"]').length
      ).toBe(0);
    });

    it('does NOT render a separate Monitor pane', () => {
      const snap = buildSnapshot();
      const { queryByTestId } = render(Dashboard, { props: { snapshot: snap } });
      expect(queryByTestId('dashboard-monitor-stream')).toBeNull();
      expect(queryByTestId('dashboard-monitor-pane')).toBeNull();
    });
  });

  describe('Dashboard render is side-effect free', () => {
    it('does not post any commands on mount', () => {
      const snap = buildSnapshot();
      render(Dashboard, { props: { snapshot: snap } });
      expect(postCommandSpy).not.toHaveBeenCalled();
    });
  });
});

describe('Dashboard Activity Feed click-to-navigate (021)', () => {
  function buildActivityFeedSnapshot(): WorkflowSnapshot {
    const phases = Object.freeze([
      buildPhase('speckit-specify', 1, 'completed'),
      buildPhase('speckit-plan', 2, 'active'),
      buildPhase('speckit-tasks', 3, 'not-started')
    ]);
    return buildSnapshot({
      phases,
      activePipeline: Object.freeze({ id: 'standard', name: 'Standard' , phases: []}),
      availablePhases: Object.freeze([
        Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '', loopable: false }),
        Object.freeze({ id: 'speckit-plan', name: 'Plan', instruction: '', loopable: false }),
        Object.freeze({ id: 'speckit-tasks', name: 'Tasks', instruction: '', loopable: false })
      ]),
      queue: buildQueue({
        queues: Object.freeze([
          buildQueueSummary({ id: 'default', name: 'Default queue', taskCount: 1 }),
          buildQueueSummary({ id: 'work', name: 'Work queue', taskCount: 2 })
        ]),
        inFlight: buildQueueItem({
          id: 'run-active',
          label: 'active feature',
          status: 'in-flight',
          queueId: 'work',
          currentPhase: 'speckit-plan',
          currentPipelineId: 'standard',
          startedAt: '2026-05-10T11:30:00.000Z',
          updatedAt: '2026-05-10T11:35:00.000Z'
        }),
        pending: Object.freeze([
          buildQueueItem({
            id: 'run-pending',
            label: 'pending feature',
            status: 'pending',
            queueId: 'work',
            currentPipelineId: 'standard',
            position: 0
          })
        ]),
        recent: Object.freeze([
          buildQueueItem({
            id: 'run-recent',
            label: 'recent feature',
            status: 'completed',
            queueId: 'default',
            currentPipelineId: 'standard',
            completedAt: '2026-05-10T12:00:00.000Z',
            updatedAt: '2026-05-10T12:00:00.000Z'
          })
        ])
      })
    });
  }

  // Feature 030 (US3, T046) — the "clicking a queue card cascades" test
  // was deleted. The per-queue card and its `queue-select-{queueId}`
  // testid were removed with the single-queue migration: there is only
  // one queue, so a queue selector is meaningless. Task-row cascade is
  // still exercised by the surviving sibling test in this block.

  it('clicking a task row cascades the Activity Feed to that task and best phase', async () => {
    const { getByTestId } = render(Dashboard, { props: { snapshot: buildActivityFeedSnapshot() } });

    await fireEvent.click(getByTestId('dashboard-queue-item-select-run-recent'));
    await tick();

    // Breadcrumb should show the task label
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('recent feature');
    // Task row highlight should be set
    expect(getByTestId('dashboard-queue-item-run-recent').className).toContain('activity-selected');
  });

  it('clicking a phase step selects that exact Activity Feed phase', async () => {
    const { getByTestId } = render(Dashboard, { props: { snapshot: buildActivityFeedSnapshot() } });

    await fireEvent.click(getByTestId('phase-progression-speckit-specify'));
    await tick();

    // Breadcrumb should show the phase name
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('Specify');
    expect(getByTestId('phase-progression-speckit-specify').getAttribute('aria-pressed')).toBe('true');
  });

  // Feature 030 (US3, T046) — the "panel selection highlights update
  // with queue and phase clicks" test was deleted: it gated on the
  // removed `queue-select-{queueId}` card. Phase-step selection
  // highlighting is exercised by the sibling "clicking a phase step
  // selects that exact Activity Feed phase" test above.
});

describe('Dashboard History to Activity Feed integration (069)', () => {
  const historyEntry: HistoryEntry = Object.freeze({
    runId: 'run-history-only',
    featureId: 'feature-history-only',
    descriptionPreview: 'historical feature evidence',
    terminalStatus: 'completed',
    startedAt: '2026-05-09T10:00:00.000Z',
    completedAt: '2026-05-09T10:05:00.000Z',
    durationMs: 300_000,
    lastErrorSummary: null,
    auditLogPointer: '.schegent/audit.log'
  });

  function buildHistoryOnlySnapshot(): WorkflowSnapshot {
    return buildSnapshot({
      activeFeature: null,
      activeRunId: null,
      queue: buildQueue({
        inFlight: null,
        pending: Object.freeze([]),
        recent: Object.freeze([]),
        queues: Object.freeze([
          buildQueueSummary({ id: 'default', name: 'Default queue', taskCount: 0 })
        ])
      }),
      history: Object.freeze([historyEntry]),
      activePipeline: Object.freeze({ id: 'standard', name: 'Standard', phases: [] }),
      availablePhases: Object.freeze([
        Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '' }),
        Object.freeze({ id: 'speckit-plan', name: 'Plan', instruction: '' })
      ])
    });
  }

  it('loads the selected history-only run into the Activity Feed', async () => {
    const { getByTestId } = render(Dashboard, {
      props: { snapshot: buildHistoryOnlySnapshot() }
    });

    await fireEvent.click(getByTestId('dashboard-queue-tab-history'));
    await fireEvent.click(getByTestId('history-item-select-run-history-only'));
    await tick();

    await vi.waitFor(() => {
      expect(readPhaseLog).toHaveBeenCalledWith({
        selection: {
          queueId: 'default',
          taskId: 'run-history-only',
          pipelineId: 'standard',
          phaseId: 'speckit-plan',
          iterationN: null
        }
      });
    });
    expect(getByTestId('history-entry-run-history-only').classList.contains('selected')).toBe(true);
    expect(getByTestId('phase-log-breadcrumb').textContent).toContain('historical feature evidence');
    expect(getByTestId('phase-log-breadcrumb').textContent).toContain('Plan');
  });

  it('shows the no-log state when the selected historical session has no retained log', async () => {
    vi.mocked(readPhaseLog).mockResolvedValueOnce({
      outcome: 'success',
      manifest: {
        iterations: [],
        selectedIteration: null,
        entries: Object.freeze([]),
        skippedLines: 0,
        truncatedCount: 0,
        verboseDiagnosticsState: { kind: 'enabled-no-sessions-for-tuple' },
        isInFlight: false
      }
    });
    const { getByTestId } = render(Dashboard, {
      props: { snapshot: buildHistoryOnlySnapshot() }
    });

    await fireEvent.click(getByTestId('dashboard-queue-tab-history'));
    await fireEvent.click(getByTestId('history-item-select-run-history-only'));

    await vi.waitFor(() => {
      expect(getByTestId('phase-log-empty-no-log').textContent).toContain('No log for this phase yet');
    });
    expect(getByTestId('phase-log-breadcrumb').textContent).toContain('historical feature evidence');
  });
});

describe('Dashboard visible-text contract (T064 / SC-011 / BUG-004)', () => {
  describe('FR-033 zone headers render visible text per the canonical design', () => {
    it('Queue Management zone header reads "Active queue"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const tab = getByTestId('dashboard-queue-tab-queue');
      expect(tab).not.toBeNull();
      expect(tab.textContent?.trim()).toBe('Active queue');
    });

    it('Phase Progression zone header reads "Phase Progression (Active: <id>)" when queue.inFlight is set (FR-017, 016)', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'req-active', label: 'in-flight prompt', status: 'in-flight' })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const header = getByTestId('dashboard-phase-progression-header');
      expect(header.textContent?.trim()).toBe('Phase Progression (Active: req-active)');
    });

    it('Phase Progression zone header reads bare "Phase Progression" when queue.inFlight is null (FR-020, 016)', () => {
      const snap = buildSnapshot({ activeFeature: null });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const header = getByTestId('dashboard-phase-progression-header');
      expect(header.textContent?.trim()).toBe('Phase Progression');
    });

    it('Live Activity zone header reads "Activity Feed"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const zone = getByTestId('dashboard-activity-audit-feed');
      const header = zone.querySelector('header');
      expect(header).not.toBeNull();
      expect(header!.textContent?.trim()).toBe('Activity Feed');
    });
  });

  describe('FR-035 Queue Management buttons render text label', () => {
    it('contextual button renders "Resume" when paused', () => {
      const snap = buildSnapshot({ queue: buildQueue({ paused: true }) });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-action');
      expect(btn.textContent?.trim()).toBe('Resume');
    });

    it('contextual button renders "Pause" when in-flight', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-fly', status: 'in-flight' })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-action');
      expect(btn.textContent?.trim()).toBe('Pause');
    });

    it('contextual button renders "Start Queue" when pending + idle', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          pending: Object.freeze([
            buildQueueItem({ id: 'q-p', status: 'pending', position: 0 })
          ])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-action');
      expect(btn.textContent?.trim()).toBe('Start Queue');
    });

    it('Clear Done button renders "Clear Done" as visible content', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          recent: Object.freeze([buildQueueItem({ id: 'q-d', status: 'completed' })])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-clear-done');
      expect(btn.textContent?.trim()).toBe('Clear Done');
    });

    it('Clean All button renders "Clean All" as visible content', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          recent: Object.freeze([buildQueueItem({ id: 'q-f', status: 'failed' })])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('dashboard-queue-clean');
      expect(btn.textContent?.trim()).toBe('Clean All');
    });
  });

  describe('FR-036 per-row action buttons render glyphs as visible content', () => {
    // Feature 030 (US2/US3, T046) — the "pending row Up/Down button
    // renders glyph" Dashboard tests were deleted. The Dashboard's
    // inline queue rows render only the select-button identity chips
    // plus `<QueueItemActions>`; the up/down arrows live exclusively
    // on `QueueItem.svelte` (the sidebar list), which is exercised by
    // `QueueItem.reorder.test.ts` and the visible-glyph contract that
    // file pins. Testing the reorder glyphs against the Dashboard
    // would assert a surface the Dashboard never owned.

    it('pending row Remove button renders ✖ glyph as visible content (NOT text "Remove" or "Cancel")', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          pending: Object.freeze([buildQueueItem({ id: 'q-p1', status: 'pending', position: 0 })])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('queue-item-remove-q-p1');
      expect(btn.textContent?.trim()).toBe('✖');
    });

    it('failed row Retry button renders ↻ glyph as visible content', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          recent: Object.freeze([buildQueueItem({ id: 'q-fail', status: 'failed' })])
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('queue-item-retry-q-fail');
      expect(btn.textContent?.trim()).toBe('↻');
    });

    it('in-flight row Cancel button renders ⏹ glyph as visible content', () => {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: buildQueueItem({ id: 'q-flight', status: 'in-flight' })
        })
      });
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const btn = getByTestId('queue-item-cancel-q-flight');
      expect(btn.textContent?.trim()).toBe('⏹');
    });
  });

  describe('FR-037 active phase chip renders name', () => {
    it('the active phase chip text matches name', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const activeChip = getByTestId('phase-progression-speckit-plan');
      const labelEl = activeChip.querySelector<HTMLElement>('.phase-name');
      expect(labelEl).not.toBeNull();
      expect(labelEl!.textContent?.trim()).toBe('speckit-plan');
    });

    it('non-active phase chips render lowercase phase names', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const completedChip = getByTestId('phase-progression-speckit-specify');
      const completedLabel = completedChip.querySelector<HTMLElement>('.phase-name');
      expect(completedLabel!.textContent?.trim()).toBe('speckit-specify');
      expect(completedLabel!.textContent).not.toMatch(/⏳/);

      const notStartedChip = getByTestId('phase-progression-speckit-tasks');
      const notStartedLabel = notStartedChip.querySelector<HTMLElement>('.phase-name');
      expect(notStartedLabel!.textContent?.trim()).toBe('speckit-tasks');
      expect(notStartedLabel!.textContent).not.toMatch(/⏳/);
    });
  });
});

describe('Dashboard rendered-text contract (T072 / SC-011 / BUG-005)', () => {
  function expectNoTextTransform(el: HTMLElement, label: string): void {
    const computed = getComputedStyle(el).textTransform;
    expect(
      computed === 'none' || computed === '',
      `${label} must not have CSS text-transform applied (got "${computed}"); ` +
        'BUG-005 — DOM textContent assertions are invalid when CSS visual transforms ' +
        'override the rendered case.'
    ).toBe(true);
  }

  describe('FR-033 zone headers must NOT have CSS text-transform applied', () => {
    it('Queue Management zone tab has computed textTransform of "none"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const tab = getByTestId('dashboard-queue-tab-queue');
      expect(tab).not.toBeNull();
      expectNoTextTransform(tab, 'Queue Management zone tab');
    });

    it('Phase Progression zone header has computed textTransform of "none"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const header = getByTestId('dashboard-phase-progression-header');
      expectNoTextTransform(header, 'Phase Progression zone header');
    });

    it('Live Activity zone header has computed textTransform of "none"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const header = getByTestId('dashboard-activity-audit-feed').querySelector<HTMLElement>('header');
      expect(header).not.toBeNull();
      expectNoTextTransform(header!, 'Live Activity zone header');
    });
  });

  describe('FR-037 active phase chip uppercase comes from JS, not CSS', () => {
    it('the active phase chip label has computed textTransform of "none"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      const activeChip = getByTestId('phase-progression-speckit-plan');
      const labelEl = activeChip.querySelector<HTMLElement>('.phase-name');
      expect(labelEl).not.toBeNull();
      expectNoTextTransform(
        labelEl!,
        'active phase chip label (UPPERCASE must come from JS toUpperCase, not CSS)'
      );
    });

    it('non-active phase chip labels have computed textTransform of "none"', () => {
      const snap = buildSnapshot();
      const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
      for (const phaseName of ['speckit-specify', 'speckit-clarify', 'speckit-tasks', 'speckit-analyze', 'speckit-implement', 'finalize']) {
        const chip = getByTestId(`phase-progression-${phaseName}`);
        const labelEl = chip.querySelector<HTMLElement>('.phase-name');
        expect(labelEl, `${phaseName} chip should have a .phase-name element`).not.toBeNull();
        expectNoTextTransform(labelEl!, `${phaseName} chip label`);
      }
    });
  });
});

// =============================================================================
// Feature 016 — Dashboard UI/UX Improvements
// =============================================================================

function buildPipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return Object.freeze({
    id: 'standard',
    name: 'Standard',
    phases: Object.freeze(['speckit-specify', 'speckit-plan']) as readonly string[],
    ...overrides
  });
}

function buildGeneralSettings(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    ...overrides
  }) as GeneralSettings;
}

describe('US1 — Pipeline dropdown reflects a sensible default (016)', () => {
  it('I-1.1 selects defaultPipelineId when the catalog contains that id', async () => {
    const snap = buildSnapshot({
      availablePipelines: Object.freeze([
        buildPipeline({ id: 'standard', name: 'Standard' , phases: []}),
        buildPipeline({ id: 'custom', name: 'Custom' , phases: []})
      ]),
      generalSettings: buildGeneralSettings({ defaultPipelineId: 'custom' })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await tick();
    const select = getByTestId('dashboard-queue-input').querySelector<HTMLSelectElement>(
      'select.pipeline-select'
    );
    expect(select).not.toBeNull();
    expect(select!.value).toBe('custom');
  });

  it('I-1.2 falls back to first catalog entry when default id is missing', async () => {
    const snap = buildSnapshot({
      availablePipelines: Object.freeze([
        buildPipeline({ id: 'first', name: 'First' , phases: []}),
        buildPipeline({ id: 'second', name: 'Second' , phases: []})
      ]),
      generalSettings: buildGeneralSettings({ defaultPipelineId: 'missing' })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await tick();
    const select = getByTestId('dashboard-queue-input').querySelector<HTMLSelectElement>(
      'select.pipeline-select'
    );
    expect(select).not.toBeNull();
    expect(select!.value).toBe('first');
  });

  it('I-1.3 renders only N/A and disables submit when the catalog is empty', async () => {
    const snap = buildSnapshot({
      availablePipelines: Object.freeze([]),
      generalSettings: buildGeneralSettings({ defaultPipelineId: 'standard' })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await tick();
    const zone = getByTestId('dashboard-queue-input');
    const select = zone.querySelector<HTMLSelectElement>('select.pipeline-select');
    expect(select).not.toBeNull();
    const opts = Array.from(select!.querySelectorAll<HTMLOptionElement>('option'));
    expect(opts.length).toBe(1);
    expect(opts[0].textContent?.trim()).toBe('N/A');
    expect(opts[0].disabled).toBe(true);
    const submit = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    const ta = zone.querySelector<HTMLTextAreaElement>('textarea')!;
    await fireEvent.input(ta, { target: { value: 'anything' } });
    await tick();
    expect(submit.disabled).toBe(true);
  });

  it('I-1.4 operator selection survives a snapshot push with a different defaultPipelineId', async () => {
    const initial = buildSnapshot({
      availablePipelines: Object.freeze([
        buildPipeline({ id: 'standard', name: 'Standard' , phases: []}),
        buildPipeline({ id: 'custom', name: 'Custom' , phases: []})
      ]),
      generalSettings: buildGeneralSettings({ defaultPipelineId: 'standard' })
    });
    const { getByTestId, rerender } = render(Dashboard, { props: { snapshot: initial } });
    await tick();
    const select = getByTestId('dashboard-queue-input').querySelector<HTMLSelectElement>(
      'select.pipeline-select'
    )!;
    expect(select.value).toBe('standard');
    await fireEvent.change(select, { target: { value: 'custom' } });
    await tick();
    expect(select.value).toBe('custom');
    const next = buildSnapshot({
      availablePipelines: Object.freeze([
        buildPipeline({ id: 'standard', name: 'Standard' , phases: []}),
        buildPipeline({ id: 'custom', name: 'Custom' , phases: []}),
        buildPipeline({ id: 'extra', name: 'Extra' , phases: []})
      ]),
      generalSettings: buildGeneralSettings({ defaultPipelineId: 'extra' })
    });
    await rerender({ snapshot: next });
    await tick();
    expect(select.value).toBe('custom');
  });
});

// Feature 030 (US3, T046) — the "US3 — New Task queue targeting (017)"
// describe block was deleted. It relied on the per-queue selector
// (`dashboard-queue-selector`) and the numeric insertion-position input
// (`dashboard-insertion-position`), both removed by the single-queue
// migration: there is exactly one queue and tasks always append to the
// tail. The submit path is exercised by the surviving New-Task suites
// in this file plus the single-queue regression at
// `webview-ui/src/__tests__/dashboard-single-queue.test.ts`.

describe('US2 — Active Queue items carry identity, time, and intent (016)', () => {
  it('I-3.1 renders a Task ID chip per queue row whose textContent contains the item id', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        inFlight: buildQueueItem({ id: 'q-flight', label: 'in-flight prompt', status: 'in-flight' }),
        pending: Object.freeze([
          buildQueueItem({ id: 'q-p1', label: 'pending one', status: 'pending', position: 0 })
        ]),
        recent: Object.freeze([
          buildQueueItem({ id: 'q-fail', label: 'failed prompt', status: 'failed' })
        ])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    for (const id of ['q-flight', 'q-p1', 'q-fail']) {
      const chip = getByTestId(`dashboard-queue-item-id-${id}`);
      expect(chip).not.toBeNull();
      expect(chip.textContent ?? '').toContain(id);
    }
  });

  it('I-3.2 renders a relative-time element per queue row', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([
          buildQueueItem({
            id: 'q-p1',
            label: 'a',
            status: 'pending',
            position: 0,
            enqueuedAt: fiveMinAgo
          })
        ])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const el = getByTestId('dashboard-queue-item-enqueued-q-p1');
    expect(el).not.toBeNull();
    const text = (el.textContent ?? '').trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text === 'just now' || /ago$/.test(text)).toBe(true);
  });

  it('I-3.3 renders the prompt label with full-text title and (no prompt) fallback', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([
          buildQueueItem({ id: 'q-full', label: 'do the thing', status: 'pending', position: 0 }),
          buildQueueItem({ id: 'q-empty', label: '', status: 'pending', position: 1 })
        ])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const full = getByTestId('dashboard-queue-item-label-q-full');
    expect(full.textContent?.trim()).toBe('do the thing');
    expect(full.getAttribute('title')).toBe('do the thing');
    const empty = getByTestId('dashboard-queue-item-label-q-empty');
    expect(empty.textContent?.trim()).toBe('(no prompt)');
  });

  it('I-3.4 all four metadata elements survive every non-terminal queue status', () => {
    const statuses: QueueItem['status'][] = [
      'pending',
      'in-flight',
      'paused',
      'completed',
      'failed',
      'canceled'
    ];
    for (const status of statuses) {
      const snap = buildSnapshot({
        queue: buildQueue({
          inFlight: status === 'in-flight' ? buildQueueItem({ id: `q-${status}`, label: `lbl-${status}`, status }) : null,
          pending: status === 'pending' || status === 'paused'
            ? Object.freeze([
                buildQueueItem({ id: `q-${status}`, label: `lbl-${status}`, status, position: 0 })
              ])
            : Object.freeze([]),
          recent: status === 'completed' || status === 'failed' || status === 'canceled'
            ? Object.freeze([
                buildQueueItem({
                  id: `q-${status}`,
                  label: `lbl-${status}`,
                  status,
                  completedAt: '2026-05-10T11:00:00.000Z'
                })
              ])
            : Object.freeze([])
        })
      });
      const { getByTestId, unmount } = render(Dashboard, { props: { snapshot: snap } });
      const id = `q-${status}`;
      expect(getByTestId(`dashboard-queue-item-id-${id}`), `id missing for ${status}`).not.toBeNull();
      expect(getByTestId(`dashboard-queue-item-enqueued-${id}`), `enqueued missing for ${status}`).not.toBeNull();
      expect(getByTestId(`dashboard-queue-item-label-${id}`), `label missing for ${status}`).not.toBeNull();
      expect(getByTestId(`queue-item-status-${id}`), `status pill missing for ${status}`).not.toBeNull();
      unmount();
    }
  });

  it('I-4.4 queue row id and Phase Progression header id are the same (by construction)', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        inFlight: buildQueueItem({ id: 'req-X', label: 'in-flight prompt', status: 'in-flight' })
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const idChip = getByTestId('dashboard-queue-item-id-req-X');
    expect(idChip.textContent ?? '').toContain('req-X');
    const header = getByTestId('dashboard-phase-progression-header');
    expect(header.textContent ?? '').toContain('(Active: req-X)');
  });
});

describe('US5 — Multi-line input expands comfortably (016)', () => {
  it('I-2.1 a single-line value keeps the textarea at the 1-line minimum', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    await fireEvent.input(ta, { target: { value: 'single line' } });
    await tick();
    expect(ta.scrollHeight).toBe(ta.clientHeight);
  });

  it('I-2.2 typing 5 lines grows the textarea past baseline without internal scroll', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const baselineH = ta.clientHeight;
    const fiveLines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    await fireEvent.input(ta, { target: { value: fiveLines } });
    await tick();
    expect(ta.clientHeight).toBeGreaterThanOrEqual(baselineH);
    expect(ta.scrollHeight).toBe(ta.clientHeight);
  });

  it('I-2.3 setting 20 lines clamps clientHeight and reveals internal scrollbar', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const lineHeightPx = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const twentyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    await fireEvent.input(ta, { target: { value: twentyLines } });
    await tick();
    expect(ta.clientHeight).toBeLessThanOrEqual(8 * lineHeightPx + 2);
    expect(ta.scrollHeight).toBeGreaterThanOrEqual(ta.clientHeight);
  });

  it('I-2.4 clearing returns the textarea to the 1-line minimum', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const baselineH = ta.clientHeight;
    const fiveLines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    await fireEvent.input(ta, { target: { value: fiveLines } });
    await tick();
    await fireEvent.input(ta, { target: { value: '' } });
    await tick();
    expect(ta.clientHeight).toBeLessThanOrEqual(baselineH + 1);
  });
});

// =============================================================================
// Feature 017 — BUG-003 / T124 / SC-011: Submit ACK round-trip contract
// =============================================================================
//
// The Dashboard Submit button no longer rejects when a controller is already
// running. CMD_START dispatches `schegent.enqueue` on the host, which routes
// through `GuardedRunService.scheduleOrEnqueue()` — pure enqueue semantics.
// The webview MUST:
//   (a) preserve the textarea content until the ACK arrives so a rejection
//       lets the operator retry without retyping;
//   (b) keep the Submit button disabled during the in-flight ACK round-trip
//       to prevent double-submission;
//   (c) surface an in-webview "Enqueued to <queueName>" affordance on
//       success — distinct from the host notifier;
//   (d) never branch on `rejected-already-running` (that arm is removed).
// =============================================================================

describe('Dashboard submit ACK contract (T124 / BUG-003 / SC-011)', () => {
  it('(a) clears the textarea only after an accepted ACK and preserves it on a rejection', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    await fireEvent.input(ta, { target: { value: 'try once' } });
    await tick();
    await fireEvent.click(btn);
    await tick();
    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    // ACK has not arrived — value must be preserved verbatim.
    expect(ta.value).toBe('try once');
    fireAck('corr-1', 'rejected', { reason: 'queue-paused' });
    await tick();
    // Rejection — preserve so the operator can retry without retyping.
    expect(ta.value).toBe('try once');
    // A fresh submit reuses the surviving description and the next ACK
    // (accepted this time) actually clears it.
    await fireEvent.click(btn);
    await tick();
    expect(postCommandSpy).toHaveBeenCalledTimes(2);
    fireAck('corr-2', 'accepted', { result: { outcome: 'enqueued', queueName: 'Default queue' } });
    await tick();
    expect(ta.value).toBe('');
  });

  it('(b) keeps Submit disabled during the in-flight ACK round-trip and re-enables it once the ACK arrives', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    await fireEvent.input(ta, { target: { value: 'no double-submit' } });
    await tick();
    expect(btn.disabled).toBe(false);
    await fireEvent.click(btn);
    await tick();
    // Round-trip in flight — Submit MUST be gated to block a double-submit.
    expect(btn.disabled).toBe(true);
    // Operator clicks again while disabled — postCommand MUST NOT fire twice.
    await fireEvent.click(btn);
    await tick();
    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    fireAck('corr-1', 'accepted', { result: { outcome: 'enqueued', queueName: 'Default queue' } });
    await tick();
    // Textarea cleared on accepted — Submit returns to its empty-input disabled state.
    expect(ta.value).toBe('');
    expect(btn.disabled).toBe(true);
    // Typing again re-enables Submit.
    await fireEvent.input(ta, { target: { value: 'next task' } });
    await tick();
    expect(btn.disabled).toBe(false);
  });

  it('(c) renders the in-webview "Enqueued to <queueName>" affordance on an accepted ACK', async () => {
    const snap = buildSnapshot();
    const { getByTestId, queryByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    // Pre-submit — no feedback chip rendered.
    expect(queryByTestId('dashboard-queue-input-feedback')).toBeNull();
    await fireEvent.input(ta, { target: { value: 'enqueue me' } });
    await tick();
    await fireEvent.click(btn);
    await tick();
    fireAck('corr-1', 'accepted', { result: { outcome: 'enqueued', queueName: 'Default queue' } });
    await tick();
    const feedback = getByTestId('dashboard-queue-input-feedback');
    expect(feedback.textContent ?? '').toContain('Enqueued to Default queue');
    expect(feedback.className).toContain('submit-feedback-accepted');
  });

  it('(c-fallback) renders "Enqueued to queue" when the host omits the queueName from the ACK payload', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    await fireEvent.input(ta, { target: { value: 'no name in ack' } });
    await tick();
    await fireEvent.click(btn);
    await tick();
    fireAck('corr-1', 'accepted', { result: { outcome: 'enqueued' } });
    await tick();
    const feedback = getByTestId('dashboard-queue-input-feedback');
    // Defensive fallback when queueName is missing — never blank text.
    expect(feedback.textContent ?? '').toMatch(/Enqueued to (queue|null)/);
    expect(feedback.className).toContain('submit-feedback-accepted');
  });

  it('(d) surfaces the host reason on a rejected ACK and never branches on "rejected-already-running"', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    await fireEvent.input(ta, { target: { value: 'rejected path' } });
    await tick();
    await fireEvent.click(btn);
    await tick();
    fireAck('corr-1', 'rejected', { reason: 'queue-paused' });
    await tick();
    const feedback = getByTestId('dashboard-queue-input-feedback');
    expect(feedback.textContent ?? '').toContain('queue-paused');
    expect(feedback.className).toContain('submit-feedback-rejected');
    // BUG-003 — the `rejected-already-running` reason is unreachable on the
    // operator-input path; the Dashboard does not special-case it any more.
    expect(feedback.textContent ?? '').not.toContain('rejected-already-running');
  });

  it('(d-default) renders a generic "rejected" reason when the host omits the reason field', async () => {
    const snap = buildSnapshot();
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const ta = getByTestId('dashboard-queue-input').querySelector<HTMLTextAreaElement>('textarea')!;
    const btn = getByTestId('dashboard-queue-input-submit') as HTMLButtonElement;
    await fireEvent.input(ta, { target: { value: 'reasonless reject' } });
    await tick();
    await fireEvent.click(btn);
    await tick();
    fireAck('corr-1', 'rejected');
    await tick();
    const feedback = getByTestId('dashboard-queue-input-feedback');
    expect(feedback.textContent ?? '').toContain('Rejected: rejected');
    expect(feedback.className).toContain('submit-feedback-rejected');
  });
});

describe('Dashboard cold-start fallback (063 BUG-006 / T076)', () => {
  it('auto-resolves the Activity Feed selection to the most-recent task with on-disk logs when no task is in flight', async () => {
    const snap = buildSnapshot({
      activeFeature: null,
      queue: buildQueue({
        inFlight: null,
        pending: Object.freeze([]) as readonly QueueItem[],
        recent: Object.freeze([
          buildQueueItem({
            id: 'run-recent-logs',
            label: 'completed feature with logs',
            status: 'completed',
            completedAt: '2026-05-10T12:00:00.000Z',
            updatedAt: '2026-05-10T12:00:00.000Z',
            hasOnDiskLogs: true
          })
        ]) as readonly QueueItem[]
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await tick();
    await tick();

    expect(getByTestId('dashboard-queue-item-run-recent-logs').className).toContain('activity-selected');
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('completed feature with logs');
  });

  it('does NOT auto-select a recent task that lacks on-disk logs', async () => {
    const snap = buildSnapshot({
      activeFeature: null,
      queue: buildQueue({
        inFlight: null,
        pending: Object.freeze([]) as readonly QueueItem[],
        recent: Object.freeze([
          buildQueueItem({
            id: 'run-recent-nologs',
            label: 'completed feature without logs',
            status: 'completed',
            completedAt: '2026-05-10T12:00:00.000Z',
            updatedAt: '2026-05-10T12:00:00.000Z',
            hasOnDiskLogs: false
          })
        ]) as readonly QueueItem[]
      })
    });
    const { getByTestId, queryByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await tick();
    await tick();

    const row = queryByTestId('dashboard-queue-item-run-recent-nologs');
    if (row !== null) {
      expect(row.className).not.toContain('activity-selected');
    }
    // The empty-state path: feed is mounted but no task is bound.
    expect(getByTestId('dashboard-activity-audit-feed')).not.toBeNull();
  });
});
