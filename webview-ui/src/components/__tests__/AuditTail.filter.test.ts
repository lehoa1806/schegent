// Feature 064 — T009 (US1) — Activity Feed filter contract.
//
// AuditTail.svelte renders only entries that satisfy BOTH:
//   1. `entry.scope === 'task'` (or `entry.scope` is `undefined` — legacy
//      tolerance per contracts/audit-tail-entry.md §Backward compatibility);
//   2. `entry.runId` is reachable in the current snapshot reference set:
//      `activeRunId`, `queue.inFlight.id`, `queue.pending[*].id`,
//      `queue.recent[*].id`, `history[*].runId`.
//
// `scope === 'system'` entries are never shown in the Activity Feed.
// When the post-filter list is empty, the empty-state copy
// "No active task activity. System events appear in the System tab."
// is rendered.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import AuditTail from '../AuditTail.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  AuditTailEntry,
  HistoryEntry,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

afterEach(() => cleanup());

function buildEntry(
  overrides: Partial<AuditTailEntry> & { runId: string; scope?: 'task' | 'system' }
): AuditTailEntry {
  const scope = overrides.scope ?? ('task' as const);
  return Object.freeze({
    id: `e-${overrides.runId}-${scope}`,
    timestamp: '2026-05-22T12:00:00.000Z',
    phase: 'speckit-plan',
    category: 'cli-invocation' as const,
    summary: `summary for ${overrides.runId}`,
    ...overrides,
    scope
  });
}

function buildQueueItem(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return Object.freeze({
    label: `task ${overrides.id}`,
    enqueuedAt: '2026-05-22T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-22T11:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  } as QueueItem);
}

function buildHistory(runId: string): HistoryEntry {
  return Object.freeze({
    runId,
    featureId: `f-${runId}`,
    descriptionPreview: 'old run',
    terminalStatus: 'completed' as const,
    startedAt: '2026-05-20T00:00:00.000Z',
    completedAt: '2026-05-20T01:00:00.000Z',
    durationMs: 3_600_000,
    lastErrorSummary: null,
    auditLogPointer: ''
  });
}

function buildSnapshot(opts: {
  activeRunId?: string | null;
  inFlightId?: string;
  pendingIds?: readonly string[];
  recentIds?: readonly string[];
  historyRunIds?: readonly string[];
  auditTail: readonly AuditTailEntry[];
}): WorkflowSnapshot {
  const queue: QueueProjection = Object.freeze({ orderedItems: [],
    inFlight: opts.inFlightId ? buildQueueItem({ id: opts.inFlightId, status: 'in-flight' }) : null,
    pending: Object.freeze((opts.pendingIds ?? []).map((id) => buildQueueItem({ id }))),
    recent: Object.freeze((opts.recentIds ?? []).map((id) => buildQueueItem({ id }))),
    paused: false
  });
  const history: readonly HistoryEntry[] = Object.freeze(
    (opts.historyRunIds ?? []).map((rid) => buildHistory(rid))
  );
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      }),
      workflowElapsedMs: null,
      activeRunId: opts.activeRunId ?? null
    }),
    queue,
    auditTail: opts.auditTail,
    monitor: null,
    history,
    producedAt: '2026-05-22T12:00:01.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as unknown as WorkflowSnapshot;
}

function applySnapshot(s: WorkflowSnapshot): void {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: s
  } as unknown as Parameters<typeof snapshotStore.apply>[0]);
}

describe('AuditTail.svelte — task-scope + reachable-runId filter (Feature 064 T009)', () => {
  it('shows task-scope entries whose runId matches activeRunId', () => {
    const tail = [
      buildEntry({ id: 'a', runId: 'run-active', scope: 'task' })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: tail }));
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-a"]')).not.toBeNull();
  });

  it('shows task-scope entries whose runId matches queue.inFlight.id / pending / recent', () => {
    const tail = [
      buildEntry({ id: 'inflight', runId: 'q-in', scope: 'task' }),
      buildEntry({ id: 'pending', runId: 'q-pend', scope: 'task' }),
      buildEntry({ id: 'recent', runId: 'q-recent', scope: 'task' })
    ];
    applySnapshot(
      buildSnapshot({
        inFlightId: 'q-in',
        pendingIds: ['q-pend'],
        recentIds: ['q-recent'],
        auditTail: tail
      })
    );
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-inflight"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="audit-entry-pending"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="audit-entry-recent"]')).not.toBeNull();
  });

  it('hides task-scope entries whose runId is not in the reference set', () => {
    const tail = [
      buildEntry({ id: 'orphan', runId: 'orphan-run', scope: 'task' })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: tail }));
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-orphan"]')).toBeNull();
  });

  it('hides system-scope entries regardless of runId reachability', () => {
    const tail = [
      buildEntry({ id: 'sys', runId: 'run-active', scope: 'system' })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: tail }));
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-sys"]')).toBeNull();
  });

  it("renders the empty-state copy when the post-filter list is empty", () => {
    const tail = [
      buildEntry({ id: 'sys', runId: 'irrelevant', scope: 'system' })
    ];
    applySnapshot(buildSnapshot({ auditTail: tail }));
    const { getByTestId } = render(AuditTail);
    const empty = getByTestId('audit-empty');
    expect(empty.textContent).toBe(
      'No active task activity. System events appear in the System tab.'
    );
  });

  it('history-eviction transition: entry visible while in history, hidden after eviction', async () => {
    const tail = [
      buildEntry({ id: 'hist', runId: 'old-run', scope: 'task' })
    ];
    // First snapshot: 'old-run' is in history.
    applySnapshot(
      buildSnapshot({
        historyRunIds: ['old-run'],
        auditTail: tail
      })
    );
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-hist"]')).not.toBeNull();

    // Follow-up snapshot: 'old-run' evicted from history and not in any
    // other reference set; the entry MUST become hidden.
    applySnapshot(
      buildSnapshot({
        historyRunIds: [],
        auditTail: tail
      })
    );
    await tick();
    expect(container.querySelector('[data-testid="audit-entry-hist"]')).toBeNull();
  });

  it("newest-first ordering survives the filter (FR-016)", () => {
    const tail: AuditTailEntry[] = [
      Object.freeze({
        id: 'e-old',
        timestamp: '2026-05-22T12:00:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'cli-invocation' as const,
        summary: 'old',
        runId: 'run-active',
        scope: 'task' as const
      }),
      Object.freeze({
        id: 'e-mid',
        timestamp: '2026-05-22T12:00:30.000Z',
        phase: 'speckit-plan' as const,
        category: 'cli-invocation' as const,
        summary: 'mid',
        runId: 'run-active',
        scope: 'task' as const
      }),
      Object.freeze({
        id: 'e-new',
        timestamp: '2026-05-22T12:01:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'cli-invocation' as const,
        summary: 'new',
        runId: 'run-active',
        scope: 'task' as const
      })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: Object.freeze(tail) }));
    const { container } = render(AuditTail);
    const liElements = container.querySelectorAll('ol li');
    expect(liElements.length).toBe(3);
    const first = liElements[0]?.getAttribute('data-testid');
    const second = liElements[1]?.getAttribute('data-testid');
    const third = liElements[2]?.getAttribute('data-testid');
    expect(first).toBe('audit-entry-e-new');
    expect(second).toBe('audit-entry-e-mid');
    expect(third).toBe('audit-entry-e-old');
  });

  it('legacy tolerance (FR-013): an entry whose `scope` is undefined is treated as task', () => {
    const legacy: AuditTailEntry = {
      id: 'legacy',
      timestamp: '2026-05-22T12:00:00.000Z',
      phase: 'speckit-plan' as const,
      category: 'cli-invocation' as const,
      summary: 'pre-feature-064 entry'
      // runId and scope deliberately missing — simulate older host.
    } as unknown as AuditTailEntry;
    // Inject runId via cast so we hit the legacy `scope === undefined` branch.
    const legacyEntry = Object.freeze({ ...legacy, runId: 'run-active' }) as AuditTailEntry;
    applySnapshot(
      buildSnapshot({ activeRunId: 'run-active', auditTail: Object.freeze([legacyEntry]) })
    );
    const { container } = render(AuditTail);
    expect(container.querySelector('[data-testid="audit-entry-legacy"]')).not.toBeNull();
  });
});
