// Feature 103 (T051 — US4, research R8, SC-001) — what the surface reads, and
// when.
//
// The detail needs two things the list does not have: a run-scoped metrics read
// and a pointer resolution. Both are per-run, and both are cheap exactly once.
// The failure this guards is the one that never looks like a bug in review — a
// row component that resolves its own evidence on mount, or a dashboard that
// pre-fetches summaries "so the detail opens instantly". Either turns opening
// History into N host round trips, and the render bound is 200.
//
// Recorded task path deviation: T051 names `repo/tests/perf/`. The host suite
// has no Svelte plugin and cannot mount a component, and the claim here is
// about what mounting does. It is asserted where it can be asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HistoryDashboard from '../HistoryDashboard.svelte';
import type { HistoryEntry, QueueRuntime, WorkflowSnapshot } from '../../lib/snapshot-types';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';

const readRunSummary = vi.fn(async (_runId: string) => ({
  outcome: 'read' as const,
  summary: null
}));
const resolveAuditPointer = vi.fn(async (runId: string) => ({
  outcome: 'no-evidence-recorded' as const,
  runId
}));

vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: (runId: string) => readRunSummary(runId)
}));

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: (runId: string) => resolveAuditPointer(runId)
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-detail-reads-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

const ROW_COUNT = 25;

function entry(index: number): HistoryEntry {
  const runId = `run-${String(index).padStart(2, '0')}`;
  return Object.freeze({
    runId,
    featureId: `feature-${runId}`,
    descriptionPreview: `Run ${runId}`,
    terminalStatus: 'completed',
    startedAt: '2026-08-12T00:00:00.000Z',
    completedAt: `2026-08-12T00:${String(index).padStart(2, '0')}:00.000Z`,
    durationMs: 60_000,
    lastErrorSummary: null,
    auditLogPointer: `runId:${runId}`,
    queueId: 'alpha'
  }) as HistoryEntry;
}

function snapshot(): WorkflowSnapshot {
  const queues: readonly QueueRuntime[] = [buildQueueRuntime({ queueId: 'alpha', name: 'Alpha' })];
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues,
    history: Object.freeze(Array.from({ length: ROW_COUNT }, (_, index) => entry(index))),
    producedAt: '2026-08-12T00:30:00.000Z'
  }) as unknown as WorkflowSnapshot;
}

beforeEach(() => {
  readRunSummary.mockClear();
  resolveAuditPointer.mockClear();
});

afterEach(() => cleanup());

describe('the list reads nothing per row (T051, SC-001)', () => {
  it('renders every row without a metrics read or a pointer resolution', async () => {
    const { getByTestId } = render(HistoryDashboard, { props: { snapshot: snapshot() } });

    expect(getByTestId('history-entry-run-00')).toBeTruthy();
    expect(getByTestId(`history-entry-run-${ROW_COUNT - 1}`)).toBeTruthy();
    expect(readRunSummary).not.toHaveBeenCalled();
    expect(resolveAuditPointer).not.toHaveBeenCalled();
  });

  it('reads nothing while the operator narrows the list either', async () => {
    const { getByTestId } = render(HistoryDashboard, { props: { snapshot: snapshot() } });

    await fireEvent.change(getByTestId('history-filter-status'), { target: { value: 'completed' } });
    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'alpha' } });

    // Filtering is local (FR-019) and re-renders the whole list. A read
    // attached to a row's lifecycle would fire again on every keystroke.
    expect(readRunSummary).not.toHaveBeenCalled();
    expect(resolveAuditPointer).not.toHaveBeenCalled();
  });
});

describe('opening one detail reads once (T051, research R8)', () => {
  it('performs exactly one run-scoped metrics read and one pointer resolution', async () => {
    const { getByTestId, findByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshot() }
    });

    await fireEvent.click(getByTestId('history-item-open-details-run-07'));
    await findByTestId('history-run-detail');

    await vi.waitFor(() => expect(readRunSummary).toHaveBeenCalledTimes(1));
    expect(readRunSummary).toHaveBeenCalledWith('run-07');
    await vi.waitFor(() => expect(resolveAuditPointer).toHaveBeenCalledTimes(1));
    expect(resolveAuditPointer).toHaveBeenCalledWith('run-07');
  });

  it('does not re-read when the snapshot ticks underneath an open detail', async () => {
    const { getByTestId, findByTestId, rerender } = render(HistoryDashboard, {
      props: { snapshot: snapshot() }
    });

    await fireEvent.click(getByTestId('history-item-open-details-run-07'));
    await findByTestId('history-run-detail');
    await vi.waitFor(() => expect(readRunSummary).toHaveBeenCalledTimes(1));

    // The snapshot is pushed on a timer. A read wired to a `$derived` of it
    // would fire once a second for as long as the detail stays open — the same
    // cost as the per-row case, spread over time where nobody notices it.
    await rerender({ snapshot: snapshot() });

    expect(readRunSummary).toHaveBeenCalledTimes(1);
    expect(resolveAuditPointer).toHaveBeenCalledTimes(1);
  });
});
