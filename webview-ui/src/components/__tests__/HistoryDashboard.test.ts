import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HistoryDashboard from '../HistoryDashboard.svelte';
import type { HistoryEntry } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-dashboard-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

afterEach(() => cleanup());

function entry(
  runId: string,
  descriptionPreview: string,
  terminalStatus: HistoryEntry['terminalStatus']
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
    auditLogPointer: `runId:${runId}`
  });
}

describe('HistoryDashboard', () => {
  const history = Object.freeze([
    entry('run-1', 'Phase catalog management', 'completed'),
    entry('run-2', 'Pipeline validation', 'failed')
  ]);

  it('renders the ledger and filters by search text', async () => {
    const { container, getByPlaceholderText } = render(HistoryDashboard, {
      props: { history, isPrimary: true }
    });

    expect(container.querySelector('[data-testid="history-entry-run-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).not.toBeNull();

    await fireEvent.input(getByPlaceholderText('Search by run ID, feature, or description'), {
      target: { value: 'catalog' }
    });

    expect(container.querySelector('[data-testid="history-entry-run-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).toBeNull();
  });

  it('filters by outcome and exposes the no-results state', async () => {
    const { container, getByLabelText } = render(HistoryDashboard, {
      props: { history, isPrimary: true }
    });

    await fireEvent.change(getByLabelText('Outcome'), { target: { value: 'failed' } });
    expect(container.querySelector('[data-testid="history-entry-run-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-entry-run-2"]')).not.toBeNull();

    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'no such run' } });
    expect(container.textContent).toContain('No matching runs');
  });
});
