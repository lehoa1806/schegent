import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import HistorySection from '../HistorySection.svelte';
import type { HistoryEntry } from '../../lib/snapshot-types';

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

import {
  CMD_RERUN_FROM_HISTORY,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_HISTORY_ITEM_DETAILS
} from '../../lib/messages';

beforeEach(() => {
  postCommandSpy.mockReset();
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
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RERUN_FROM_HISTORY, { runId: 'r-99' });
  });

  it('clicking Rerun when aria-disabled does NOT post', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry({ runId: 'r-77' })], isPrimary: false }
    });
    await fireEvent.click(getByTestId('history-item-rerun-r-77'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('clicking Open Audit Log emits CMD_OPEN_AUDIT_LOG (no payload)', async () => {
    const { getByTestId } = render(HistorySection, {
      props: { history: [entry()], isPrimary: true }
    });
    await fireEvent.click(getByTestId('history-item-open-audit-r-1'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_OPEN_AUDIT_LOG);
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
});
