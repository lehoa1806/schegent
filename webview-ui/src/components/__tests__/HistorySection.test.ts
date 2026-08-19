import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import HistorySection from '../HistorySection.svelte';
import type { HistoryEntry } from '../../lib/snapshot-types';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
let nextCorrelationId = 0;

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => {
    postCommandSpy(...args);
    // The real `postCommand` returns the id it minted, and FR-R3-010's
    // `resolveAuditPointer` reads `.correlationId` off it synchronously. A spy
    // returning `undefined` throws inside a promise executor, which surfaces as
    // an unhandled rejection rather than as this file's failure.
    return { correlationId: `c${++nextCorrelationId}` };
  }
}));

// Only `history-evidence-ipc.ts` reaches for the store in this component tree,
// and only for these two methods, so the stub is the whole surface rather than a
// partial mock of a module the rest of the file also depends on.
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

// Feature 063 (T036) — Rerun now gates through the shared useConfirm
// helper. Tests treat the prompt as auto-accepted so the existing IPC
// dispatch assertions stay scoped to the post-confirm payload.
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

import {
  CMD_RERUN_FROM_HISTORY,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_RESOLVE_AUDIT_POINTER
} from '../../lib/messages';

beforeEach(() => {
  postCommandSpy.mockReset();
  ackListeners.clear();
  nextCorrelationId = 0;
});
afterEach(() => cleanup());

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return Object.freeze({
    runId: 'r-1',
    featureId: 'f-1',
    descriptionPreview: 'add feature X',
    terminalStatus: 'completed',
    startedAt: '2026-05-10T12:00:00.000Z',
    completedAt: '2026-05-10T12:00:42.000Z',
    durationMs: 42_000,
    lastErrorSummary: null,
    auditLogPointer: '.schegent/audit.log',
    ...overrides
  });
}

describe('HistorySection', () => {
  it('renders empty-state placeholder when history.length === 0', () => {
    const { getByTestId } = render(HistorySection, { props: { history: [], isPrimary: true } });
    expect(getByTestId('history-empty')).not.toBeNull();
  });

  it('renders entries reverse-chronologically (preserves input order — store already sorts)', () => {
    const newest = entry({ runId: 'r-newest', completedAt: '2026-05-10T13:00:00.000Z' });
    const middle = entry({ runId: 'r-middle', completedAt: '2026-05-10T12:00:00.000Z' });
    const oldest = entry({ runId: 'r-oldest', completedAt: '2026-05-10T11:00:00.000Z' });
    const { container } = render(HistorySection, {
      props: { history: [newest, middle, oldest], isPrimary: true }
    });
    const ids = Array.from(container.querySelectorAll('[data-history-row]'))
      .map((el) => el.getAttribute('data-history-row') ?? '');
    expect(ids).toEqual(['r-newest', 'r-middle', 'r-oldest']);
  });

  it('renders status badge, duration, last-updated for each entry', () => {
    const e = entry({ durationMs: 65_000, terminalStatus: 'failed' });
    const { getByTestId } = render(HistorySection, { props: { history: [e], isPrimary: true } });
    expect(getByTestId('history-item-r-1-status').textContent).toContain('failed');
    expect(getByTestId('history-item-r-1-duration').textContent).toMatch(/1m\s+5s/);
    expect(getByTestId('history-item-r-1-completed-at')).not.toBeNull();
  });

  it('renders Rerun / Open Audit Log / Open Details buttons per entry', () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry()], isPrimary: true }
    });
    expect(getByTestId('history-item-rerun-r-1')).not.toBeNull();
    expect(getByTestId('history-item-open-audit-r-1')).not.toBeNull();
    expect(getByTestId('history-item-open-details-r-1')).not.toBeNull();
  });

  it('Rerun is aria-disabled when isPrimary === false; Open Audit Log / Open Details remain enabled', () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry()], isPrimary: false }
    });
    expect(getByTestId('history-item-rerun-r-1').getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId('history-item-open-audit-r-1').getAttribute('aria-disabled')).toBe('false');
    expect(getByTestId('history-item-open-details-r-1').getAttribute('aria-disabled')).toBe('false');
  });

  it('clicking Rerun emits CMD_RERUN_FROM_HISTORY with the runId', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry({ runId: 'r-99' })], isPrimary: true }
    });
    await fireEvent.click(getByTestId('history-item-rerun-r-99'));
    await tick();
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RERUN_FROM_HISTORY, { runId: 'r-99' });
  });

  it('clicking Rerun when aria-disabled does NOT post', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry({ runId: 'r-77' })], isPrimary: false }
    });
    await fireEvent.click(getByTestId('history-item-rerun-r-77'));
    await tick();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  // FR-R3-010 (T411) turned this button into two steps. It resolves the run's
  // audit pointer first and opens the log only when that resolves, because
  // opening it on an expired pointer drops the operator into a file that cannot
  // contain what they asked for, with nothing to say why. The three "no
  // evidence" outcomes are acked `accepted`, so the second step is gated on the
  // outcome rather than on the ack status.
  it('clicking Open Audit Log resolves the pointer first, then opens the log', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry()], isPrimary: true }
    });
    await fireEvent.click(getByTestId('history-item-open-audit-r-1'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESOLVE_AUDIT_POINTER, { runId: 'r-1' });
    expect(postCommandSpy).not.toHaveBeenCalledWith(CMD_OPEN_AUDIT_LOG);

    // Shaped to satisfy `isValidResolveAuditPointerResponse`. An under-specified
    // fixture is projected to `failure`/`internal-error`, which also does not
    // open the log — so a loose one would pass this test's negative half while
    // never exercising the positive branch at all.
    ackListeners.get('c1')?.({
      status: 'accepted',
      result: {
        outcome: 'resolved',
        runId: 'r-1',
        truncated: false,
        parseWarnings: 0,
        entries: [
          {
            id: 'e-1',
            timestamp: '2026-05-10T12:00:42.000Z',
            eventType: 'run-completed',
            phase: 'implement',
            iteration: 1,
            outcome: 'success'
          }
        ]
      }
    });
    await tick();

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_OPEN_AUDIT_LOG);
  });

  it('clicking Open Audit Log does NOT open the log when the pointer expired', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry()], isPrimary: true }
    });
    await fireEvent.click(getByTestId('history-item-open-audit-r-1'));

    ackListeners.get('c1')?.({
      status: 'accepted',
      result: { outcome: 'evidence-expired', runId: 'r-1' }
    });
    await tick();

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESOLVE_AUDIT_POINTER, { runId: 'r-1' });
    expect(postCommandSpy).not.toHaveBeenCalledWith(CMD_OPEN_AUDIT_LOG);
  });

  it('clicking Open Details emits CMD_OPEN_HISTORY_ITEM_DETAILS with the runId', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry({ runId: 'r-d' })], isPrimary: true }
    });
    await fireEvent.click(getByTestId('history-item-open-details-r-d'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_OPEN_HISTORY_ITEM_DETAILS, { id: 'r-d' });
  });

  it('renders the section root with data-testid="history-section"', () => {
    const { getByTestId } = render(HistorySection, { props: { history: [], isPrimary: true } });
    expect(getByTestId('history-section')).not.toBeNull();
  });

  it('formats canceled status correctly', () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry({ terminalStatus: 'canceled' })], isPrimary: true }
    });
    expect(getByTestId('history-item-r-1-status').textContent).toContain('canceled');
  });

  it('uses VS Code theme variables for status badges (no hardcoded hex/rgb)', async () => {
    const HistorySectionMod = await import('../HistorySection.svelte?raw');
    const src = HistorySectionMod.default ?? '';
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgb\(/);
    expect(src).not.toMatch(/rgba\(/);
  });

  it('selects an entry through its explicit, keyboard-native selection button', async () => {
    const e = entry({ runId: 'run-select-1' });
    const selectMock = vi.fn();
    const { getByTestId } = render(HistorySection, {
      props: { history: [e], isPrimary: true, onTaskSelect: selectMock }
    });

    const row = getByTestId('history-entry-run-select-1');
    const el = getByTestId('history-item-select-run-select-1');
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
    await fireEvent.click(el);

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledWith('run-select-1');
  });
});
