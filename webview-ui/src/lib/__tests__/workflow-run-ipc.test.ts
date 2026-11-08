// FR-R4-F05 (T17; contract I, I4 to I7; FR-019 to FR-024) — connected-run launch and continuation through the intent ledger.
//
// WHY. A launch that outlived the 5 s wait used to resolve as a QUEUE REFUSAL (`queue-refused`,
// detail `no-host-response`), which the views rendered as "the queue refused this run". The host may
// still start the run, so a timeout is now its own outcome, `not-yet-known`, and the retry reuses the
// identity (the continuation's `expectedRevision` is part of the payload, so a stale retry still fails).
// The host's answer is fired by hand and time is fake; nothing waits for real time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AckLike {
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
  readonly result?: unknown;
}
type AckListener = (ack: AckLike) => void;

const ackListeners = new Map<string, AckListener>();
const posted: Array<{ type: string; payload?: unknown; correlationId: string }> = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => {
        if (ackListeners.get(id) === fn) ackListeners.delete(id);
      };
    }
  }
}));

vi.mock('../vscode-api', () => ({
  // Honours the identity the intent ledger supplies, as the real `postCommand` does.
  postCommand(
    type: string,
    payload?: unknown,
    opts?: { correlationId?: string }
  ): { correlationId: string } {
    const correlationId = opts?.correlationId ?? `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  },
  onHostMessage: () => () => undefined
}));

const { disposeIntentLedger } = await import('../intent-ledger');

function fireAck(id: string, ack: AckLike): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!(ack);
}

beforeEach(() => {
  disposeIntentLedger();
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  disposeIntentLedger();
  vi.useRealTimers();
});

const { continueWorkflow, launchWorkflow, sendWorkflowControlCommand } = await import(
  '../workflow-run-ipc'
);

const REQUEST = { pipelineId: 'ship-flow', inputs: [], supplemental: [], outputs: [] };
const LAUNCH = { workflowId: 'release', startNodeId: 'n-triage', request: REQUEST };
const STARTED = { outcome: 'started', connectedRunId: 'cr-1', queueItemId: 'qi-1' };

describe('workflow run helpers (T17)', () => {
  it('resolves a wait that ran out as not-yet-known, never as a queue refusal', async () => {
    const waiting = launchWorkflow(LAUNCH);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await waiting;

    expect(result).toEqual({ outcome: 'not-yet-known' });
    expect(JSON.stringify(result)).not.toContain('queue-refused');
    expect(JSON.stringify(result)).not.toContain('no-host-response');
  });

  it('posts the same correlation id and payload for a retry after a timeout, and answers it with the ack', async () => {
    const first = launchWorkflow(LAUNCH);
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    const retry = launchWorkflow(LAUNCH);

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: STARTED });
    await expect(retry).resolves.toEqual(STARTED);
  });

  it('delivers the late outcome once, as the result the helper maps', async () => {
    const late = vi.fn();
    const waiting = launchWorkflow(LAUNCH, { onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(5000);
    await waiting;

    fireAck(posted[0]!.correlationId, { status: 'accepted', result: STARTED });

    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(STARTED);
  });

  it('reads an unusable ack as a refusal the view can render', async () => {
    const waiting = continueWorkflow({
      connectedRunId: 'cr-1',
      expectedRevision: 3,
      nodeId: 'n-ship',
      request: REQUEST
    });
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: { outcome: 'something-else' } });

    await expect(waiting).resolves.toMatchObject({ outcome: 'rejected-queue', detail: 'unusable-host-response' });
  });

  it('sends a continuation at a different revision as a different intent', () => {
    const base = { connectedRunId: 'cr-1', nodeId: 'n-ship', request: REQUEST };
    void continueWorkflow({ ...base, expectedRevision: 3 });
    void continueWorkflow({ ...base, expectedRevision: 4 });

    expect(posted[1]!.correlationId).not.toBe(posted[0]!.correlationId);
  });

  it('routes sendWorkflowControlCommand through the continuation wire command and resolves control-acknowledged (FR-R5-F31)', async () => {
    const command = {
      version: 1 as const,
      commandId: '11111111-1111-4111-8111-111111111111',
      rootRunId: 'cr-1',
      queueId: 'default',
      invocationId: '22222222-2222-4222-8222-222222222222',
      expectedGeneration: 4,
      action: {
        kind: 'select-candidate' as const,
        candidateId: 'cand-2'
      }
    };
    const waiting = sendWorkflowControlCommand(command);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.payload).toMatchObject({
      connectedRunId: 'cr-1',
      expectedRevision: 4,
      invocationId: '22222222-2222-4222-8222-222222222222',
      commandId: '11111111-1111-4111-8111-111111111111',
      controlCommand: command
    });

    const ackResult = {
      outcome: 'control-acknowledged' as const,
      acknowledgement: {
        version: 1 as const,
        commandId: command.commandId,
        outcome: 'accepted' as const,
        generation: 5
      }
    };
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: ackResult });

    await expect(waiting).resolves.toEqual(ackResult);
  });
});
