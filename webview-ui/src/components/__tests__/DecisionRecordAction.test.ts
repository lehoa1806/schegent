// FR-R5-F19 (feature 278, T19.1, FR-003) — the row's "Open decision record" action: one request by row id,
// one specific sentence per outcome, a refusal through the shared refusal text, and a timeout that says the
// outcome is not known. The host's answer arrives on the ack, so the test stubs `postCommand` and the
// snapshot store's ack registry and delivers acks by hand (the seams `QueueItemError.test.ts` uses).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import DecisionRecordAction from '../DecisionRecordAction.svelte';
import { CMD_OPEN_DECISION_RECORD } from '../../lib/messages';
import { DECISION_RECORD_OUTCOMES } from '../../../../src/contracts/decision-record';
import { DECISION_RECORD_OUTCOME_TEXT } from '../../lib/decision-record-ipc';

type Ack = { status: 'accepted' | 'rejected'; reason?: string; result?: unknown };

const ackListeners = new Map<string, (ack: Ack) => void>();
const posted: Array<{ type: string; payload?: unknown; correlationId: string }> = [];
let nextId = 0;

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck(id: string, listener: (ack: Ack) => void): () => void {
      ackListeners.set(id, listener);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `open-${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const ROW = 'task-1';
const BUTTON = `queue-item-decision-record-${ROW}`;
const STATUS = `queue-item-decision-record-status-${ROW}`;

beforeEach(() => {
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function clickAndAnswer(ack: Ack) {
  const view = render(DecisionRecordAction, { rowId: ROW });
  await fireEvent.click(view.getByTestId(BUTTON));
  const listener = ackListeners.get(posted.at(0)?.correlationId ?? '');
  expect(listener).toBeDefined();
  listener?.(ack);
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  return view;
}

describe('the request', () => {
  it('names the row and nothing else', async () => {
    const view = render(DecisionRecordAction, { rowId: ROW });
    await fireEvent.click(view.getByTestId(BUTTON));
    expect(posted).toHaveLength(1);
    expect(posted.at(0)?.type).toBe(CMD_OPEN_DECISION_RECORD);
    expect(posted.at(0)?.payload).toEqual({ rowId: ROW });
  });

  it('asks once while an answer is pending', async () => {
    const view = render(DecisionRecordAction, { rowId: ROW });
    await fireEvent.click(view.getByTestId(BUTTON));
    await fireEvent.click(view.getByTestId(BUTTON));
    expect(posted).toHaveLength(1);
  });
});

describe('each outcome has its own sentence', () => {
  it('covers every outcome of the closed union, with no two sentences equal', () => {
    expect(Object.keys(DECISION_RECORD_OUTCOME_TEXT).sort()).toEqual([...DECISION_RECORD_OUTCOMES].sort());
    expect(new Set(Object.values(DECISION_RECORD_OUTCOME_TEXT)).size).toBe(DECISION_RECORD_OUTCOMES.length);
  });

  it.each(DECISION_RECORD_OUTCOMES.map((outcome) => [outcome]))('shows the sentence for %s', async (outcome) => {
    const view = await clickAndAnswer({ status: 'accepted', result: { outcome } });
    expect(view.getByTestId(STATUS).textContent).toBe(DECISION_RECORD_OUTCOME_TEXT[outcome]);
  });
});

describe('a refusal and a silence', () => {
  it('shows the shared untrusted-workspace sentence for the router gate', async () => {
    const view = await clickAndAnswer({ status: 'rejected', reason: 'untrusted-workspace' });
    expect(view.getByTestId(STATUS).textContent).toBe('The workspace is not trusted, so this action is unavailable.');
  });

  it('never shows free text from a refusal reason', async () => {
    const view = await clickAndAnswer({ status: 'rejected', reason: 'failed at /Users/someone/specs/x' });
    const text = view.getByTestId(STATUS).textContent;
    expect(text).toBe('The host refused this action.');
    expect(text).not.toContain('/Users');
  });

  it('reads an unrecognised result as unreadable, not as an outcome', async () => {
    const view = await clickAndAnswer({ status: 'accepted', result: { outcome: 'bogus' } });
    expect(view.getByTestId(STATUS).textContent).toContain('answered in a way this view could not read');
  });

  it('says the outcome is not known when no answer arrives in five seconds', async () => {
    const view = render(DecisionRecordAction, { rowId: ROW });
    await fireEvent.click(view.getByTestId(BUTTON));
    await vi.advanceTimersByTimeAsync(5000);
    flushSync();
    expect(view.getByTestId(STATUS).textContent).toContain('has not answered yet');
  });
});
