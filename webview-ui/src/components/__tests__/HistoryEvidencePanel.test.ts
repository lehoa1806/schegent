// Feature 103 (T049, T050 — US4, FR-028, FR-029, FR-030, FR-031, FR-032) —
// what the detail says about a run's evidence.
//
// The host's pointer resolution answers with a five-arm union whose failure arm
// carries its own reason, so seven answers in total and six that an operator
// must be able to tell apart. FR-028 bans the shortcut: a three-word sink grade
// — healthy, degraded, unavailable — reads like the same kind of fact and is
// not. It grades a *writer*, workspace-wide, over time. A row has no writer; it
// has one pointer, and "the log was rotated away" and "this run recorded
// nothing" are the same grade under that vocabulary while being opposite facts
// about the run. FR-029 and FR-030 exist to forbid exactly that collapse.
//
// The arms are therefore pinned structurally, by the outcome the panel commits
// to, and the copy is pinned only for being pairwise distinct. Rewording is
// allowed; merging two answers into one is not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HistoryEvidencePanel from '../HistoryEvidencePanel.svelte';
import HistoryDashboard from '../HistoryDashboard.svelte';
import type { HistoryEntry, QueueRuntime, WorkflowSnapshot } from '../../lib/snapshot-types';
import type { ResolveAuditPointerResult } from '../../lib/history-evidence-ipc';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';

const resolveAuditPointer = vi.fn<(runId: string) => Promise<ResolveAuditPointerResult>>();

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: (runId: string) => resolveAuditPointer(runId)
}));

vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: vi.fn(async () => ({ outcome: 'read', summary: null }))
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-evidence-panel-test' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

/** The sink-health enumeration, which grades a writer and not a run (FR-028). */
const SINK_GRADE_WORDS = /\b(healthy|degraded)\b/i;

type ResolvedArm = Extract<ResolveAuditPointerResult, { outcome: 'resolved' }>;

const RESOLVED: ResolvedArm = {
  outcome: 'resolved',
  runId: 'run-1',
  entries: [
    {
      id: 'e-1',
      timestamp: '2026-08-12T00:00:00.000Z',
      eventType: 'task-execution-started',
      phase: 'speckit-specify',
      iteration: 0,
      outcome: 'info'
    }
  ],
  truncated: false,
  parseWarnings: 0
};

/** Each arm the union can take, keyed by the outcome the panel must commit to. */
const ARMS: [string, ResolveAuditPointerResult][] = [
  ['resolved', RESOLVED],
  ['evidence-expired', { outcome: 'evidence-expired', runId: 'run-1' }],
  ['no-evidence-recorded', { outcome: 'no-evidence-recorded', runId: 'run-1' }],
  ['unaddressable', { outcome: 'unaddressable' }],
  ['unknown-run', { outcome: 'failure', reason: 'unknown-run' }],
  ['corpus-unreadable', { outcome: 'failure', reason: 'corpus-unreadable' }],
  ['internal-error', { outcome: 'failure', reason: 'internal-error' }]
];

beforeEach(() => {
  resolveAuditPointer.mockReset();
  resolveAuditPointer.mockResolvedValue(RESOLVED);
});

afterEach(() => cleanup());

function mountPanel(runId = 'run-1') {
  return render(HistoryEvidencePanel, { props: { runId } });
}

describe('every resolution arm renders distinctly (T049, FR-028, FR-029, FR-030)', () => {
  it.each(ARMS)('commits to "%s" and says something of its own', async (outcome, result) => {
    resolveAuditPointer.mockResolvedValue(result);
    const { findByTestId } = mountPanel();

    const panel = await findByTestId('history-evidence-panel');
    await vi.waitFor(() => expect(panel.getAttribute('data-evidence-outcome')).toBe(outcome));
    expect(panel.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('gives the seven arms seven different sentences', async () => {
    const messages: string[] = [];
    for (const [, result] of ARMS) {
      resolveAuditPointer.mockResolvedValue(result);
      const { findByTestId } = mountPanel();
      const message = await findByTestId('history-evidence-message');
      await vi.waitFor(() => expect(message.textContent?.trim()).not.toBe(''));
      messages.push(message.textContent?.trim() ?? '');
      cleanup();
    }

    // The specific failure this guards: a `default:` branch, or a shared
    // "could not load evidence" string, that quietly serves two arms at once.
    expect(new Set(messages).size).toBe(ARMS.length);
  });

  it('never lets a pruned log read as a run that recorded nothing', async () => {
    const said: Record<string, string> = {};
    for (const arm of ['evidence-expired', 'no-evidence-recorded', 'unaddressable'] as const) {
      const result = ARMS.find(([key]) => key === arm)?.[1] as ResolveAuditPointerResult;
      resolveAuditPointer.mockResolvedValue(result);
      const { findByTestId } = mountPanel();
      const message = await findByTestId('history-evidence-message');
      await vi.waitFor(() => expect(message.textContent?.trim()).not.toBe(''));
      said[arm] = message.textContent?.trim() ?? '';
      cleanup();
    }

    // FR-029 and FR-030 name this pair specifically. The evidence for a pruned
    // run existed and was written; the operator's next move is the archives. The
    // run that recorded nothing has no next move at all.
    expect(said['evidence-expired']).not.toBe(said['no-evidence-recorded']);
    expect(said['evidence-expired']).not.toBe(said['unaddressable']);
    expect(said['no-evidence-recorded']).not.toBe(said['unaddressable']);
  });

  it('reports a failed resolution by its reason and never as a sink grade', async () => {
    for (const arm of ['unknown-run', 'corpus-unreadable', 'internal-error'] as const) {
      const result = ARMS.find(([key]) => key === arm)?.[1] as ResolveAuditPointerResult;
      resolveAuditPointer.mockResolvedValue(result);
      const { findByTestId } = mountPanel();

      const panel = await findByTestId('history-evidence-panel');
      // "unavailable" is the third word of the sink enumeration, and the arm
      // that would attract it is this one. It has to arrive as the reason the
      // resolution gave, carried on the outcome, not as a grade standing in
      // for one.
      await vi.waitFor(() => expect(panel.getAttribute('data-evidence-outcome')).toBe(arm));
      expect(panel.textContent).not.toMatch(SINK_GRADE_WORDS);
      cleanup();
    }
  });

  it('keeps the sink vocabulary out of every other arm too', async () => {
    for (const [, result] of ARMS) {
      resolveAuditPointer.mockResolvedValue(result);
      const { findByTestId } = mountPanel();
      const panel = await findByTestId('history-evidence-panel');
      await vi.waitFor(() =>
        expect(panel.getAttribute('data-evidence-outcome')).not.toBe('pending')
      );
      expect(panel.textContent).not.toMatch(SINK_GRADE_WORDS);
      cleanup();
    }
  });

  it('states truncation and parse warnings alongside a resolved result (T055)', async () => {
    resolveAuditPointer.mockResolvedValue({
      ...RESOLVED,
      truncated: true,
      parseWarnings: 3
    });
    const { findByTestId } = mountPanel();

    // A truncated read that says nothing looks like a complete one, and a
    // parse warning swallowed here is a record the operator never learns was
    // unreadable. Both are preserved and stated rather than dropped.
    expect((await findByTestId('history-evidence-truncated')).textContent?.trim()).not.toBe('');
    expect((await findByTestId('history-evidence-parse-warnings')).textContent).toContain('3');
  });

  it('preserves an audit entry whose event type it does not know (T055)', async () => {
    resolveAuditPointer.mockResolvedValue({
      ...RESOLVED,
      entries: [{ ...RESOLVED.entries[0], id: 'e-x', eventType: 'some-future-event' }],
      parseWarnings: 1
    });
    const { findByTestId } = mountPanel();

    // The host parser warns and preserves, which is only useful if the surface
    // does too. Filtering to a known set here would hide exactly the records a
    // newer writer produced.
    expect((await findByTestId('history-evidence-entry-e-x')).textContent).toContain(
      'some-future-event'
    );
  });
});

describe('what the surface offers on a run, and what it must not (T050)', () => {
  function entry(runId: string, queueId = 'alpha'): HistoryEntry {
    return Object.freeze({
      runId,
      featureId: `feature-${runId}`,
      descriptionPreview: `Run ${runId}`,
      terminalStatus: 'completed',
      startedAt: '2026-08-12T00:00:00.000Z',
      completedAt: '2026-08-12T00:01:00.000Z',
      durationMs: 60_000,
      lastErrorSummary: null,
      auditLogPointer: `runId:${runId}`,
      queueId
    }) as HistoryEntry;
  }

  function snapshot(history: readonly HistoryEntry[]): WorkflowSnapshot {
    const queues: readonly QueueRuntime[] = [
      buildQueueRuntime({ queueId: 'alpha', name: 'Alpha' })
    ];
    return Object.freeze({
      schemaVersion: 4,
      isPrimary: true,
      queues,
      history,
      producedAt: '2026-08-12T00:02:00.000Z'
    }) as unknown as WorkflowSnapshot;
  }

  it('offers a way to copy the run identifier (FR-031)', async () => {
    const { getByTestId, findByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshot([entry('run-a')]) }
    });

    await fireEvent.click(getByTestId('history-item-open-details-run-a'));

    // A run id is what an operator pastes into a log search or a bug report,
    // and re-typing one by hand is how the wrong run gets investigated.
    const copy = await findByTestId('history-detail-copy-run-id');
    expect(copy.tagName).toBe('BUTTON');
  });

  it('offers no delete action on any row or in any detail (FR-032)', async () => {
    const { container, getByTestId, findByTestId } = render(HistoryDashboard, {
      props: { snapshot: snapshot([entry('run-a'), entry('run-b')]) }
    });

    const noDeletion = (): void => {
      for (const control of container.querySelectorAll('button')) {
        const label = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`;
        expect(label).not.toMatch(/\b(delete|discard|purge|forget)\b/i);
        // "Clear filters" is a view control and stays; clearing *runs* is the
        // workspace reset's job and must not be duplicated onto a surface whose
        // whole purpose is that the record survived.
        expect(label).not.toMatch(/\bremove\b/i);
        expect(label).not.toMatch(/clear\s+(history|runs?|all)/i);
      }
    };

    noDeletion();
    await fireEvent.click(getByTestId('history-item-open-details-run-a'));
    await findByTestId('history-run-detail');
    noDeletion();
  });
});
