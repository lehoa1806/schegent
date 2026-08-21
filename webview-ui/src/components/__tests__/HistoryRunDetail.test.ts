// Feature 103 (T046, T047, T048, T091 — US4, FR-024, FR-026, FR-027, FR-053)
// — one run, understood in full.
//
// The detail joins two sources that fail independently. The recorded fields
// come from the row the list already holds, so they are present whenever the
// row is. Cost and phase counts come from a run-scoped metrics read that can
// answer three different ways, and T091 exists because the obvious
// implementation collapses them into two: a run with no rollup record and a
// read that never landed both leave the same `undefined` in hand, and both
// then render as "not reported" — which tells an operator the run was free
// when the truth is that nobody looked.
//
// So the states are pinned by `data-state` rather than by copy. The words may
// be rewritten; what may not change is that three causes stay three answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import HistoryRunDetail from '../HistoryRunDetail.svelte';
import type { HistoryRow } from '../../lib/history-rows';
import type { RunSummaryResult } from '../../lib/metrics-ipc';
import type { MetricsRunSummary } from '../../lib/messages';

const readRunSummary = vi.fn<(runId: string) => Promise<RunSummaryResult>>();

vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: (runId: string) => readRunSummary(runId)
}));

// The evidence panel resolves a pointer of its own on mount and is tested next
// door. Held at arm's length here so a detail assertion never turns on it.
vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: vi.fn(async () => ({ outcome: 'no-evidence-recorded', runId: 'run-1' }))
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-run-detail-test' }))
}));

const FULL_DESCRIPTION_LENGTH = 4182;

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return Object.freeze({
    runId: 'run-1',
    queueId: 'alpha',
    queueName: 'Alpha',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-deploy',
    catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'Ship the release candidate to staging',
    descriptionLength: 37,
    orderingKey: '2026-08-12T00:01:00.000Z',
    startedAt: '2026-08-12T00:00:00.000Z',
    completedAt: '2026-08-12T00:01:00.000Z',
    durationMs: 60_000,
    ...overrides
  }) as HistoryRow;
}

function summary(overrides: Partial<MetricsRunSummary> = {}): MetricsRunSummary {
  return Object.freeze({
    runId: 'run-1',
    terminalStatus: 'completed',
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:01:00.000Z',
    durationMs: 60_000,
    phasesTotal: 7,
    phasesCompleted: 6,
    phasesSkipped: 1,
    backendInvocations: 9,
    costUsd: 1.25,
    ...overrides
  }) as MetricsRunSummary;
}

function mount(props: { row?: HistoryRow } = {}) {
  return render(HistoryRunDetail, {
    props: { row: props.row ?? row(), onBack: () => undefined }
  });
}

beforeEach(() => {
  readRunSummary.mockReset();
  readRunSummary.mockResolvedValue({ outcome: 'read', summary: summary() });
});

afterEach(() => cleanup());

describe('what the detail states from the record it already has (T046, FR-024)', () => {
  it('shows definition, version, kind, queue, status, start, end and duration', async () => {
    const { findByTestId, getByTestId } = mount();

    // Awaited on the first field so the metrics join has settled before the
    // rest are read; every assertion below is against one committed render.
    expect((await findByTestId('history-detail-definition')).textContent).toContain('pipe-deploy');
    expect(getByTestId('history-detail-version').textContent).toContain('ver-3');
    expect(getByTestId('history-detail-origin').textContent).toBeTruthy();
    expect(getByTestId('history-detail-queue').textContent).toContain('Alpha');
    expect(getByTestId('history-detail-status').textContent).toContain('Completed');
    expect(getByTestId('history-detail-started').textContent).toBeTruthy();
    expect(getByTestId('history-detail-ended').textContent).toBeTruthy();
    expect(getByTestId('history-detail-duration').textContent).toContain('1m');
  });

  it('states the absence of a version rather than leaving the field blank', async () => {
    const { findByTestId } = mount({ row: row({ catalogVersion: null, definitionId: null }) });

    const version = await findByTestId('history-detail-version');
    // FR-012 — the same stated absence the row uses, so drilling in does not
    // change what a run is understood to have recorded.
    expect(version.textContent?.trim()).not.toBe('');
    expect(version.textContent).not.toContain('ver-');
  });

  it('states no queued time, because nothing in the system records one', async () => {
    const { findByTestId, container } = mount();
    await findByTestId('history-detail-definition');

    // FR-024 lists start, end and duration and stops there. `queuedAt` lives on
    // the live queue item and dies with it; neither `HistoryEntry` nor the
    // rollup carries one. A "queued" figure here could only be reconstructed,
    // and a reconstructed timestamp presented beside recorded ones is a lie
    // that looks exactly like a fact.
    expect(container.querySelector('[data-testid*="queued"]')).toBeNull();
    expect(container.textContent).not.toMatch(/queued/i);
  });
});

describe('the stored description (T046, FR-053 detail half)', () => {
  it('renders the retained text, and states how much of the original it is', async () => {
    const { findByTestId } = mount({
      row: row({ descriptionPreview: 'Ship the release', descriptionLength: FULL_DESCRIPTION_LENGTH })
    });

    expect((await findByTestId('history-detail-description')).textContent).toContain(
      'Ship the release'
    );
    // The retained preview is bounded and the original was not. Showing the
    // preview alone would read as the whole description; the extent line is
    // what keeps a truncation from looking like a complete record.
    const extent = await findByTestId('history-detail-description-extent');
    expect(extent.textContent).toContain('16');
    expect(extent.textContent).toContain('4,182');
  });

  it('renders the text alone when the retained preview is the whole description', async () => {
    const { findByTestId, queryByTestId } = mount({
      row: row({ descriptionPreview: 'Ship it', descriptionLength: 7 })
    });

    expect((await findByTestId('history-detail-description')).textContent).toContain('Ship it');
    expect(queryByTestId('history-detail-description-extent')).toBeNull();
  });

  it('states the absence once retention has removed it, rather than an empty field', async () => {
    const { findByTestId, queryByTestId } = mount({
      row: row({ descriptionPreview: '', descriptionLength: null })
    });

    const absent = await findByTestId('history-detail-description-absent');
    expect(absent.textContent?.trim().length).toBeGreaterThan(0);
    expect(queryByTestId('history-detail-description')).toBeNull();
  });
});

describe('cost and phase counts have three answers, not two (T047, T091, FR-026)', () => {
  it('reads "not reported" — never zero — when the run has no rollup record', async () => {
    readRunSummary.mockResolvedValue({ outcome: 'read', summary: null });
    const { findByTestId, getByTestId } = mount();

    const cost = await findByTestId('history-detail-cost');
    expect(cost.getAttribute('data-state')).toBe('not-reported');
    // The trap: `undefined` formatted through a currency helper, or a `?? 0`
    // guard, both put a zero on screen. A run that reported nothing is not a
    // run that cost nothing, and an operator quoting the figure cannot tell.
    expect(cost.textContent).not.toMatch(/\d/);

    const phases = getByTestId('history-detail-phases');
    expect(phases.getAttribute('data-state')).toBe('not-reported');
    expect(phases.textContent).not.toMatch(/\d/);
  });

  it('reads "not reported" for cost alone when the record omits costUsd', async () => {
    // The writer omits the field rather than writing a zero precisely so this
    // case stays distinguishable, and the detail has to honour that by
    // branching on presence.
    readRunSummary.mockResolvedValue({
      outcome: 'read',
      summary: summary({ costUsd: undefined })
    });
    const { findByTestId, getByTestId } = mount();

    const cost = await findByTestId('history-detail-cost');
    expect(cost.getAttribute('data-state')).toBe('not-reported');
    expect(cost.textContent).not.toMatch(/\d/);

    // Phase counts came from the same record and are unaffected: one missing
    // field is not a missing run.
    const phases = getByTestId('history-detail-phases');
    expect(phases.getAttribute('data-state')).toBe('reported');
    expect(phases.textContent).toContain('7');
  });

  it('reads "could not be read" when the read was refused or failed', async () => {
    readRunSummary.mockResolvedValue({ outcome: 'unavailable' });
    const { findByTestId, getByTestId } = mount();

    // A refusal is a fact about the window, not about the run. Rendering it as
    // "not reported" would attribute the host's silence to the run itself.
    const cost = await findByTestId('history-detail-cost');
    expect(cost.getAttribute('data-state')).toBe('unreadable');
    expect(cost.textContent).not.toMatch(/\d/);
    expect(getByTestId('history-detail-phases').getAttribute('data-state')).toBe('unreadable');
  });

  it('renders the recorded figures when the record carries them', async () => {
    const { findByTestId, getByTestId } = mount();

    const cost = await findByTestId('history-detail-cost');
    expect(cost.getAttribute('data-state')).toBe('reported');
    expect(cost.textContent).toContain('1.25');
    expect(getByTestId('history-detail-phases').getAttribute('data-state')).toBe('reported');
  });

  it('asks only for the run it is showing', async () => {
    mount({ row: row({ runId: 'run-42' }) });
    // Scoped, not filtered client-side from a corpus-wide read: FR-023 forbids
    // the new store a whole-history read would need to stay affordable.
    await vi.waitFor(() => expect(readRunSummary).toHaveBeenCalledWith('run-42'));
  });
});

describe('phase counts are three totals and nothing more (T048, FR-027)', () => {
  it('renders total, completed and skipped, with no per-phase breakdown', async () => {
    const { findByTestId, container } = mount();

    const phases = await findByTestId('history-detail-phases');
    expect(phases.textContent).toContain('7');
    expect(phases.textContent).toContain('6');
    expect(phases.textContent).toContain('1');

    // Nothing in the system records a per-phase outcome for a finished run —
    // the rollup holds three integers and the audit corpus rotates away. A
    // breakdown here could only be invented, and an invented one would be
    // indistinguishable from a recorded one.
    expect(container.querySelector('[data-testid="history-detail-phase-breakdown"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="history-detail-phase-outcome"]')).toHaveLength(
      0
    );
  });
});
