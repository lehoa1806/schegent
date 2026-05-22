// Feature 064 — T012 (US2) — System tab contract.
//
// SystemTab.svelte renders only entries that satisfy:
//   `entry.scope === 'system'` (with legacy tolerance: a missing `scope`
//   is treated as `'task'` per FR-013, so it is NOT shown in System).
//
// Ordering is newest-first by snapshot order (reverse of the projection's
// oldest-first array). When the post-filter list is empty, the empty-state
// copy "No system events yet." is rendered.
//
// FR-015 cross-check: a synthetic `queue-cleared-all` projected entry whose
// `runId` matches the snapshot's `activeRunId` MUST appear here even though
// it would otherwise be reachable in the Activity Feed's reference set.
// Because it carries `scope === 'system'`, the Activity Feed filter rejects
// it. AuditTail.filter.test.ts pins the inverse half of this invariant.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SystemTab from '../SystemTab.svelte';
import AuditTail from '../AuditTail.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  AuditTailEntry,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

afterEach(() => cleanup());

function buildEntry(
  overrides: Partial<AuditTailEntry> & { runId: string; scope?: 'task' | 'system' }
): AuditTailEntry {
  const scope = overrides.scope ?? ('system' as const);
  return Object.freeze({
    id: `e-${overrides.runId}-${scope}`,
    timestamp: '2026-05-22T12:00:00.000Z',
    phase: 'speckit-plan',
    category: 'system' as const,
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

function buildSnapshot(opts: {
  activeRunId?: string | null;
  inFlightId?: string;
  auditTail: readonly AuditTailEntry[];
}): WorkflowSnapshot {
  const queue: QueueProjection = Object.freeze({
    inFlight: opts.inFlightId ? buildQueueItem({ id: opts.inFlightId, status: 'in-flight' }) : null,
    pending: Object.freeze([]),
    recent: Object.freeze([]),
    paused: false
  });
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue,
    auditTail: opts.auditTail,
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    }),
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-22T12:00:01.000Z',
    activeRunId: opts.activeRunId ?? null,
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

function applySnapshot(s: WorkflowSnapshot): void {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: s
  } as unknown as Parameters<typeof snapshotStore.apply>[0]);
}

describe('SystemTab.svelte — system-scope filter (Feature 064 T012)', () => {
  it("renders entries whose scope === 'system'", () => {
    const tail = [
      buildEntry({ id: 'sys-1', runId: 'run-a', scope: 'system' }),
      buildEntry({ id: 'sys-2', runId: 'run-b', scope: 'system' })
    ];
    applySnapshot(buildSnapshot({ auditTail: tail }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-sys-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="system-entry-sys-2"]')).not.toBeNull();
  });

  it("does NOT render entries whose scope === 'task', regardless of runId reachability", () => {
    const tail = [
      buildEntry({ id: 'task-active', runId: 'run-active', scope: 'task' }),
      buildEntry({ id: 'task-inflight', runId: 'run-in', scope: 'task' }),
      buildEntry({ id: 'task-orphan', runId: 'run-orphan', scope: 'task' })
    ];
    applySnapshot(
      buildSnapshot({
        activeRunId: 'run-active',
        inFlightId: 'run-in',
        auditTail: tail
      })
    );
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-task-active"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-inflight"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-orphan"]')).toBeNull();
  });

  it('renders newest-first (reverses snapshot order)', () => {
    const tail: AuditTailEntry[] = [
      Object.freeze({
        id: 's-old',
        timestamp: '2026-05-22T12:00:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'old',
        runId: 'run-x',
        scope: 'system' as const
      }),
      Object.freeze({
        id: 's-mid',
        timestamp: '2026-05-22T12:00:30.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'mid',
        runId: 'run-y',
        scope: 'system' as const
      }),
      Object.freeze({
        id: 's-new',
        timestamp: '2026-05-22T12:01:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'new',
        runId: 'run-z',
        scope: 'system' as const
      })
    ];
    applySnapshot(buildSnapshot({ auditTail: Object.freeze(tail) }));
    const { container } = render(SystemTab);
    const liElements = container.querySelectorAll('ol li');
    expect(liElements.length).toBe(3);
    expect(liElements[0]?.getAttribute('data-testid')).toBe('system-entry-s-new');
    expect(liElements[1]?.getAttribute('data-testid')).toBe('system-entry-s-mid');
    expect(liElements[2]?.getAttribute('data-testid')).toBe('system-entry-s-old');
  });

  it("renders empty-state copy 'No system events yet.' when no system entries exist", () => {
    const tail = [
      buildEntry({ id: 'task-only', runId: 'run-active', scope: 'task' })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: tail }));
    const { getByTestId } = render(SystemTab);
    const empty = getByTestId('system-empty');
    expect(empty.textContent).toBe('No system events yet.');
  });

  it('FR-015 cross-check: queue-cleared-all (system) appears in System tab and NOT in Activity Feed', () => {
    // The projector classifies `queue-cleared-all` as `scope === 'system'`.
    // Even if its runId is reachable (matches activeRunId), the Activity Feed
    // task-scope filter excludes it, and the System tab includes it.
    const clearedAll = buildEntry({
      id: 'cleared',
      runId: 'run-active',
      scope: 'system',
      summary: 'queue cleared'
    });
    applySnapshot(
      buildSnapshot({
        activeRunId: 'run-active',
        auditTail: Object.freeze([clearedAll])
      })
    );

    const system = render(SystemTab);
    expect(system.container.querySelector('[data-testid="system-entry-cleared"]')).not.toBeNull();
    cleanup();

    const audit = render(AuditTail);
    expect(audit.container.querySelector('[data-testid="audit-entry-cleared"]')).toBeNull();
    // Activity Feed shows the empty-state because the only entry is system-scoped.
    expect(audit.container.querySelector('[data-testid="audit-empty"]')).not.toBeNull();
  });

  it("legacy tolerance complement (FR-013): an entry whose `scope` is undefined is NOT shown in System", () => {
    const legacy: AuditTailEntry = {
      id: 'legacy',
      timestamp: '2026-05-22T12:00:00.000Z',
      phase: 'speckit-plan' as const,
      category: 'cli-invocation' as const,
      summary: 'pre-feature-064 entry',
      runId: 'run-active'
      // scope deliberately missing — simulates pre-Feature 064 host.
    } as unknown as AuditTailEntry;
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([legacy]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-legacy"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-empty"]')).not.toBeNull();
  });
});
