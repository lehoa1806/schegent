// Feature 103 (T014, T017) — the History route, composing rather than listing.
//
// The dashboard now takes the whole snapshot and folds `history` together with
// `queues` (FR-001, FR-003). Two of these cases are about what the list does
// when it has nothing ordinary to show: a run whose queue is gone must still be
// listed and named (FR-006), and an untouched workspace must say that nothing
// has been recorded rather than that a filter matched nothing (FR-007).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HistoryDashboard from '../HistoryDashboard.svelte';
import type { HistoryEntry, QueueRuntime, WorkflowSnapshot } from '../../lib/snapshot-types';
import { UNATTRIBUTED_QUEUE_LABEL, VERSION_NOT_RECORDED_LABEL } from '../../lib/history-rows';
import {
  buildInFlightRun,
  buildQueueRuntime
} from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-dashboard-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

// Feature 103 (T088) — the detail reads on open. Both reads are covered next
// door; stubbed here so the drill-down case turns on navigation alone and does
// not leave a correlated request waiting out its ack timeout.
vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: vi.fn(async () => ({ outcome: 'read', summary: null }))
}));

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: vi.fn(async (runId: string) => ({
    outcome: 'no-evidence-recorded',
    runId
  }))
}));

afterEach(() => cleanup());

function entry(
  runId: string,
  descriptionPreview: string,
  terminalStatus: HistoryEntry['terminalStatus'],
  queueId = 'default',
  provenance: Partial<HistoryEntry> = {}
): HistoryEntry {
  return Object.freeze({
    runId,
    featureId: `feature-${runId}`,
    descriptionPreview,
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

// Only the three fields the surface reads are meaningful here. The cast keeps
// the fixture to those rather than restating a forty-field projection whose
// other members this component never touches — the same arrangement
// `AuditTail.filter.test.ts` uses.
function snapshotWith(
  history: readonly HistoryEntry[],
  queues: readonly QueueRuntime[] = [buildQueueRuntime({ queueId: 'default', name: 'Default' })]
): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues,
    history,
    producedAt: '2026-08-12T00:02:00.000Z'
  }) as unknown as WorkflowSnapshot;
}

describe('HistoryDashboard', () => {
  const history = Object.freeze([
    entry('run-1', 'Phase catalog management', 'completed'),
    entry('run-2', 'Pipeline validation', 'failed')
  ]);

  it('renders the ledger and filters by search text', async () => {
    const { container, getByPlaceholderText } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(history) }
    });

    expect(container.querySelector('[data-testid="history-entry-run-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).not.toBeNull();

    await fireEvent.input(getByPlaceholderText('Search by run ID, queue, or description'), {
      target: { value: 'catalog' }
    });

    expect(container.querySelector('[data-testid="history-entry-run-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).toBeNull();
  });

  it('filters by outcome and exposes the no-results state', async () => {
    const { container, getByLabelText } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith(history) }
    });

    await fireEvent.change(getByLabelText('Outcome'), { target: { value: 'failed' } });
    expect(container.querySelector('[data-testid="history-entry-run-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).not.toBeNull();

    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'no such run' } });
    expect(container.querySelector('[data-testid="history-filtered-empty"]')).not.toBeNull();
    expect(container.textContent).toContain('No matching runs');
  });

  it('lists a run whose queue can no longer be attributed, naming the partition (FR-006)', () => {
    const { container, getByTestId } = render(HistoryDashboard, {
      props: {
        snapshot: snapshotWith([
          entry('run-1', 'Phase catalog management', 'completed'),
          entry('run-orphan', 'Migrated from a pre-queue workspace', 'completed', '__unattributed__')
        ])
      }
    });

    // Listed, not dropped: no registered queue carries that id, and a run the
    // surface silently omits is indistinguishable from one that was lost.
    const row = container.querySelector('[data-testid="history-entry-run-orphan"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-history-queue')).toBe('__unattributed__');
    expect(getByTestId('history-item-run-orphan-queue').textContent?.trim()).toBe(
      UNATTRIBUTED_QUEUE_LABEL
    );
    // The internal partition key never reaches the operator.
    expect(getByTestId('history-item-run-orphan-queue').textContent).not.toContain('__');
  });

  it('names the owning queue on a row whose queue is still registered (FR-002)', () => {
    const { getByTestId } = render(HistoryDashboard, {
      props: {
        snapshot: snapshotWith(
          [entry('run-1', 'Phase catalog management', 'completed', 'queue-beta')],
          [buildQueueRuntime({ queueId: 'queue-beta', name: 'Release train' })]
        )
      }
    });

    expect(getByTestId('history-item-run-1-queue').textContent?.trim()).toBe('Release train');
  });

  it('says nothing has been recorded on a fresh workspace (FR-007)', () => {
    const { container, getByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshotWith([]) }
    });

    // The "no matching runs" state is for a filter that excluded everything.
    // Showing it here would send an operator hunting for a filter they never
    // set, so the two states are distinct elements with distinct copy.
    expect(container.querySelector('[data-testid="history-filtered-empty"]')).toBeNull();
    const empty = getByTestId('history-empty');
    expect(empty.textContent).toContain('No runs recorded yet');
    expect(getByTestId('history-render-count').textContent).toContain('0 of 0');
  });

  it('lists a run that is still going alongside the recorded ones (FR-003)', () => {
    const { container, getByTestId } = render(HistoryDashboard, {
      props: {
        snapshot: snapshotWith(history, [
          buildQueueRuntime({ queueId: 'default', name: 'Default' }),
          buildQueueRuntime({
            queueId: 'queue-live',
            name: 'Hotfixes',
            inFlightRun: buildInFlightRun({
              runId: 'run-live',
              status: 'running',
              feature: { id: 'feat-live', label: 'Add caching', startedAt: '2026-08-12T00:03:00.000Z' }
            })
          })
        ])
      }
    });

    const live = container.querySelector('[data-testid="history-entry-run-live"]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute('data-history-source')).toBe('in-flight');
    expect(getByTestId('history-item-run-live-status').textContent).toContain('running');
    // FR-004 — a run with no durable record has nothing to re-run from.
    expect(getByTestId('history-item-rerun-run-live').getAttribute('aria-disabled')).toBe('true');
  });

  // Feature 103 (T026, US2) — FR-011, FR-012, FR-014.
  //
  // Provenance is the answer to "what produced this result", and a blank cell
  // answers it wrongly in the most expensive direction: it reads as "nothing
  // special", so an operator comparing two rows silently assumes they ran the
  // same thing. An absence has to be said out loud, and it must never be said
  // in a way that could be mistaken for a version.
  describe('provenance on the row (US2)', () => {
    const FROZEN = { kind: 'pipeline' as const, id: 'pipe-deploy', versionId: 'ver-12' };

    it('names the definition and the version a run froze (FR-011)', () => {
      const { getByTestId } = render(HistoryDashboard, {
        props: {
          snapshot: snapshotWith([
            entry('run-v', 'Deploy the thing', 'completed', 'default', {
              catalogVersion: FROZEN,
              origin: { kind: 'standalone' }
            } as Partial<HistoryEntry>)
          ])
        }
      });

      // No catalog is resolvable in this fixture, so FR-021's fallback applies
      // and the id stands in for the display name. What must not happen is a
      // row that shows neither.
      expect(getByTestId('history-item-run-v-definition').textContent).toContain('pipe-deploy');
      expect(getByTestId('history-item-run-v-version').textContent).toContain('ver-12');
    });

    it('states the absence when a run recorded no version (FR-012)', () => {
      const { getByTestId } = render(HistoryDashboard, {
        props: { snapshot: snapshotWith([entry('run-nov', 'An older run', 'completed')]) }
      });

      const cell = getByTestId('history-item-run-nov-version');
      expect(cell.textContent?.trim()).toBe(VERSION_NOT_RECORDED_LABEL);
      // Never blank, and never something a reader could take for a version.
      expect(cell.textContent?.trim()).not.toBe('');
      expect(cell.textContent).not.toMatch(/\bver-|\bv\d/);
    });

    it('shows a Workflow member as a member whose body is a Pipeline (FR-014)', () => {
      // R2, on screen: `catalogVersion.kind` is 'pipeline' and `origin.kind` is
      // 'workflow-member' on the same row, and both are true. A surface that
      // rendered one from the other would have to drop one of these.
      const { getByTestId } = render(HistoryDashboard, {
        props: {
          snapshot: snapshotWith([
            entry('run-m', 'Deploy the thing', 'completed', 'default', {
              catalogVersion: FROZEN,
              origin: { kind: 'workflow-member', workflowId: 'wf-release' }
            } as Partial<HistoryEntry>)
          ])
        }
      });

      expect(getByTestId('history-item-run-m-origin').textContent).toContain('wf-release');
      expect(getByTestId('history-item-run-m-definition').textContent).toContain('pipe-deploy');
      expect(getByTestId('history-item-run-m-version').textContent).toContain('ver-12');
    });

    it('does not claim a Workflow for a run that started on its own (FR-013)', () => {
      const { getByTestId } = render(HistoryDashboard, {
        props: {
          snapshot: snapshotWith([
            entry('run-s', 'Deploy the thing', 'completed', 'default', {
              catalogVersion: FROZEN,
              origin: { kind: 'standalone' }
            } as Partial<HistoryEntry>)
          ])
        }
      });

      const origin = getByTestId('history-item-run-s-origin');
      expect(origin.textContent?.toLowerCase()).not.toContain('workflow');
      expect(origin.textContent?.trim()).not.toBe('');
    });
  });

  // Feature 103 (T088 — US3, FR-020, SC-005, US3 AS3) — drilling in and back.
  //
  // `HistoryLocation` was built to hold the filter set across a drill-down and
  // nothing asserted that it does. A detail that reset the list on return would
  // pass every other test in the filtering phase: the filters work, the empty
  // states are right, the version control appears. What breaks is only visible
  // across a navigation, and it breaks the one workflow filtering exists for —
  // narrow to the failures, open one, come back, open the next.
  describe('drilling into a run and returning (T088)', () => {
    const NARROWED = Object.freeze([
      entry('run-ok', 'A run that finished', 'completed', 'default'),
      entry('run-bad', 'A run that did not', 'failed', 'default')
    ]);

    it('comes back to the same narrowed list, with the filter set intact', async () => {
      const { getByTestId, queryByTestId, findByTestId } = render(HistoryDashboard, {
        props: { snapshot: snapshotWith(NARROWED) }
      });

      await fireEvent.change(getByTestId('history-filter-status'), { target: { value: 'failed' } });
      expect(queryByTestId('history-entry-run-ok')).toBeNull();

      await fireEvent.click(getByTestId('history-item-open-details-run-bad'));
      await findByTestId('history-run-detail');
      // The detail replaces the list rather than sitting beside it: FR-008 wants
      // one run understood in full, and a half-width column is not that.
      expect(queryByTestId('history-entry-run-bad')).toBeNull();

      await fireEvent.click(getByTestId('history-detail-back'));

      expect((getByTestId('history-filter-status') as HTMLSelectElement).value).toBe('failed');
      expect(getByTestId('history-entry-run-bad')).toBeTruthy();
      expect(queryByTestId('history-entry-run-ok')).toBeNull();
    });

    it('carries the free-text search back as well as the six filters', async () => {
      const { getByTestId, queryByTestId, findByTestId, getByPlaceholderText } = render(
        HistoryDashboard,
        { props: { snapshot: snapshotWith(NARROWED) } }
      );

      const search = getByPlaceholderText('Search by run ID, queue, or description');
      await fireEvent.input(search, { target: { value: 'did not' } });
      expect(queryByTestId('history-entry-run-ok')).toBeNull();

      await fireEvent.click(getByTestId('history-item-open-details-run-bad'));
      await findByTestId('history-run-detail');
      await fireEvent.click(getByTestId('history-detail-back'));

      // The search box composes with the filters and is part of what the
      // operator narrowed to. Restoring one and dropping the other returns them
      // to a list they never chose.
      expect(
        (getByPlaceholderText('Search by run ID, queue, or description') as HTMLInputElement).value
      ).toBe('did not');
      expect(queryByTestId('history-entry-run-ok')).toBeNull();
    });
  });
});
