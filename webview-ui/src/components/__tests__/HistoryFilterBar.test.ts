// Feature 103 (T039, US3 — FR-016, FR-018, FR-021, FR-022, FR-057) — the
// filter bar as an operator meets it.
//
// The unit tests next door pin what `applyFilters` computes. These pin what the
// surface does with it: which controls exist, what History opens with, and what
// it says when the filters exclude everything. That last one is the case worth
// a test of its own — an empty list has two causes, and confusing them tells an
// operator with a filter applied that their workspace lost its runs.
//
// Rendered through `HistoryDashboard` rather than by mounting the bar with
// hand-made props, because every claim here is about the composition: the bar
// alone cannot show that History opens unfiltered or that clearing brings the
// rows back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HistoryDashboard from '../HistoryDashboard.svelte';
import type { HistoryEntry, QueueRuntime, WorkflowSnapshot } from '../../lib/snapshot-types';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-filter-bar-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

afterEach(() => cleanup());

function entry(
  runId: string,
  terminalStatus: HistoryEntry['terminalStatus'],
  queueId: string,
  provenance: Partial<HistoryEntry> = {}
): HistoryEntry {
  return Object.freeze({
    runId,
    featureId: `feature-${runId}`,
    descriptionPreview: `Run ${runId}`,
    terminalStatus,
    startedAt: '2026-08-12T00:00:00.000Z',
    completedAt: '2026-08-12T00:01:00.000Z',
    durationMs: 60_000,
    lastErrorSummary: null,
    auditLogPointer: `runId:${runId}`,
    queueId,
    ...provenance
  }) as HistoryEntry;
}

function snapshotWith(
  history: readonly HistoryEntry[],
  queues: readonly QueueRuntime[] = [
    buildQueueRuntime({ queueId: 'alpha', name: 'Alpha' }),
    buildQueueRuntime({ queueId: 'beta', name: 'Beta' })
  ]
): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues,
    history,
    producedAt: '2026-08-12T00:02:00.000Z'
  }) as unknown as WorkflowSnapshot;
}

const DEPLOY_V3 = { kind: 'pipeline' as const, id: 'pipe-deploy', versionId: 'ver-3' };
const DEPLOY_V4 = { kind: 'pipeline' as const, id: 'pipe-deploy', versionId: 'ver-4' };

const HISTORY = Object.freeze([
  entry('run-a', 'completed', 'alpha', {
    catalogVersion: DEPLOY_V3,
    origin: { kind: 'standalone' }
  } as Partial<HistoryEntry>),
  entry('run-b', 'failed', 'beta', {
    catalogVersion: DEPLOY_V4,
    origin: { kind: 'workflow-member', workflowId: 'wf-release' }
  } as Partial<HistoryEntry>),
  entry('run-c', 'completed', 'beta')
]);

describe('the filter bar offers the six filters (T039, FR-016)', () => {
  it('presents kind, definition, status, queue and time range, and no version yet', () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    for (const control of ['origin', 'definition', 'status', 'queue', 'range']) {
      expect(getByTestId(`history-filter-${control}`)).toBeTruthy();
    }
    // FR-018 — the sixth is conditional, and no definition is selected yet.
    expect(queryByTestId('history-filter-version')).toBeNull();
  });

  it('reveals the version filter once a single definition is selected (FR-018)', async () => {
    const { getByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-definition'), {
      target: { value: 'pipe-deploy' }
    });

    const version = getByTestId('history-filter-version') as HTMLSelectElement;
    // Scoped to that definition: both of its versions, and nothing else.
    expect([...version.options].map((option) => option.value)).toEqual(['', 'ver-3', 'ver-4']);
  });

  it('narrows the list to the runs that match every active filter (FR-017)', async () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'beta' } });
    await fireEvent.change(getByTestId('history-filter-status'), { target: { value: 'failed' } });

    expect(getByTestId('history-entry-run-b')).toBeTruthy();
    expect(queryByTestId('history-entry-run-a')).toBeNull();
    expect(queryByTestId('history-entry-run-c')).toBeNull();
  });
});

describe('History opens unfiltered (T039, FR-057)', () => {
  it('shows every run on mount, with no filter preselected and nothing to clear', () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    for (const runId of ['run-a', 'run-b', 'run-c']) {
      expect(getByTestId(`history-entry-${runId}`)).toBeTruthy();
    }
    expect((getByTestId('history-filter-origin') as HTMLSelectElement).value).toBe('all');
    expect((getByTestId('history-filter-status') as HTMLSelectElement).value).toBe('all');
    expect((getByTestId('history-filter-queue') as HTMLSelectElement).value).toBe('');
    expect((getByTestId('history-filter-range') as HTMLSelectElement).value).toBe('all');
    // Nothing is set, so there is nothing to offer a way out of.
    expect(queryByTestId('history-filter-clear')).toBeNull();
  });

  it('opens unfiltered again after a previous visit narrowed the list', async () => {
    const first = render(HistoryDashboard, { props: { snapshot: snapshotWith(HISTORY) } });
    await fireEvent.change(first.getByTestId('history-filter-queue'), {
      target: { value: 'alpha' }
    });
    expect((first.getByTestId('history-filter-queue') as HTMLSelectElement).value).toBe('alpha');
    cleanup();

    // FR-057 — the filter set is carried for the duration of navigation and no
    // further. A surface that reopened narrowed would show a partial list and
    // state no reason why, and persisting it would add the durable state FR-023
    // refuses.
    const second = render(HistoryDashboard, { props: { snapshot: snapshotWith(HISTORY) } });
    expect((second.getByTestId('history-filter-queue') as HTMLSelectElement).value).toBe('');
    expect(second.getByTestId('history-entry-run-b')).toBeTruthy();
  });
});

describe('when the filters exclude everything (T039, FR-022)', () => {
  it('says so, distinguishably from the no-runs-recorded state', async () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'alpha' } });
    await fireEvent.change(getByTestId('history-filter-status'), { target: { value: 'failed' } });

    // Runs exist; none of them match. That is a different sentence from the one
    // an untouched workspace gets, and the two must never be swapped.
    expect(getByTestId('history-filtered-empty')).toBeTruthy();
    expect(queryByTestId('history-empty')).toBeNull();
  });

  it('shows the no-runs-recorded state instead when nothing has ever run', () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith([]) }
    });

    expect(getByTestId('history-empty')).toBeTruthy();
    expect(queryByTestId('history-filtered-empty')).toBeNull();
  });

  it('offers the way back, and taking it restores the whole list', async () => {
    const { getByTestId, queryByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'alpha' } });
    await fireEvent.change(getByTestId('history-filter-status'), { target: { value: 'failed' } });
    await fireEvent.click(getByTestId('history-filtered-empty-clear'));

    expect(queryByTestId('history-filtered-empty')).toBeNull();
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      expect(getByTestId(`history-entry-${runId}`)).toBeTruthy();
    }
  });

  it('offers the same way back from the bar itself, before the list runs dry', async () => {
    // FR-022 is satisfied by the empty state alone, but narrowing to nothing
    // should not be the only route back to the whole list.
    const { getByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'beta' } });
    await fireEvent.click(getByTestId('history-filter-clear'));

    expect((getByTestId('history-filter-queue') as HTMLSelectElement).value).toBe('');
    expect(getByTestId('history-entry-run-a')).toBeTruthy();
  });
});

describe('a value the rows no longer carry (T039, FR-021)', () => {
  it('stays in the list, marked, and the list it produces is empty rather than broken', async () => {
    const { getByTestId, queryByTestId, rerender } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(HISTORY) }
    });

    await fireEvent.change(getByTestId('history-filter-queue'), { target: { value: 'alpha' } });

    // The queue is deleted underneath the operator, and its run with it.
    await rerender({
      snapshot: snapshotWith(
        [HISTORY[1], HISTORY[2]],
        [buildQueueRuntime({ queueId: 'beta', name: 'Beta' })]
      )
    });

    const queue = getByTestId('history-filter-queue') as HTMLSelectElement;
    expect(queue.value).toBe('alpha');
    expect([...queue.options].map((option) => option.textContent?.trim())).toContain(
      'alpha (no longer present)'
    );
    // Matching nothing is the correct answer, and it is not the same as erroring
    // or as silently widening back to every queue.
    expect(getByTestId('history-filtered-empty')).toBeTruthy();
    expect(queryByTestId('history-entry-run-b')).toBeNull();
  });
});
