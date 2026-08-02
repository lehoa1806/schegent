// Feature 082 (US1, T021) — savePipelines helper behavior.
//
// Contract: specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md
// § "Webview helper" — "structurally identical to `savePhases`: UUIDv4
// correlation, `snapshotStore.markPending`, one-shot `onceAck`, 5-second
// timeout, no cross-resolution between concurrent saves."
//
// The pre-082 helper posted `{ pipelines }` and dropped every authored
// contract field on the floor. These tests pin the scoped envelope
// (`{ scope, expectedRevision, mutation, pipelines }`) as forwarded
// verbatim, so a Pipeline's ports, bindings, and execution defaults reach
// the host handler unmodified.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePipelines, type SavePipelinesRequest } from '../save-pipelines';
import { CMD_SAVE_PIPELINES } from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingSet.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

function fireAck(
  id: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason, result });
}

// A fully authored row: id/name/version plus every optional contract field.
// If the helper ever reshapes the payload, the deep-equality assertion in the
// first test fails rather than silently shipping a lossy save.
const AUTHORED_ROW = {
  id: 'custom-flow',
  name: 'Custom Flow',
  description: 'Specify, then finalize.',
  version: 3,
  phases: ['speckit-specify', 'speckit-plan', 'finalize'],
  inputs: [{ portId: 'brief', label: 'Feature brief', type: 'text' as const }],
  outputs: [{ portId: 'spec', label: 'Spec document', type: 'markdown' as const }],
  bindings: [
    {
      kind: 'input' as const,
      phaseIndex: 0,
      inputKey: 'notes',
      source: { from: 'pipeline-input' as const, portId: 'brief' }
    },
    {
      kind: 'output' as const,
      phaseIndex: 2,
      portId: 'spec',
      outputKey: 'document'
    }
  ],
  executionDefaults: { runner: 'claude', effort: 'high' as const },
  recommendedNext: ['release']
};

const SAMPLE_REQUEST: SavePipelinesRequest = {
  scope: 'workspace',
  expectedRevision: 'a'.repeat(64),
  mutation: { kind: 'edit', pipelineId: 'custom-flow' },
  pipelines: [AUTHORED_ROW]
};

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 082 T021 — savePipelines helper', () => {
  it('posts exactly one CMD_SAVE_PIPELINES envelope carrying the scoped request verbatim', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);

    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_PIPELINES);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    // Deep equality, not a subset check: ports, bindings, executionDefaults,
    // and recommendedNext must survive the trip to the host.
    expect(env.payload).toEqual(SAMPLE_REQUEST);

    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('marks the correlation id pending so the snapshot store can gate the UI', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(pendingSet.has(env.correlationId)).toBe(true);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('resolves accepted and preserves the { scope, revision, mutation } ack result', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = { scope: 'workspace', revision: 'b'.repeat(64), mutation: 'edit' };
    fireAck(env.correlationId, 'accepted', undefined, result);
    await expect(promise).resolves.toEqual({ status: 'accepted', result });
  });

  it('resolves rejected with the reason from a matching rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(env.correlationId, 'rejected', 'pipeline-validation');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'pipeline-validation'
    });
  });

  it('preserves structured recovery details from a stale-catalog rejection', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = {
      currentRevision: 'c'.repeat(64),
      current: [{ pipelineId: 'custom-flow', version: 4 }]
    };
    fireAck(env.correlationId, 'rejected', 'stale-catalog', result);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-catalog',
      result
    });
  });

  it('resolves { status: rejected, reason: timeout } after 5 seconds without an ack', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('does NOT cross-resolve mismatched correlation ids when two saves are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = savePipelines(SAMPLE_REQUEST, postMessage);
    const p2 = savePipelines(
      { ...SAMPLE_REQUEST, scope: 'user', mutation: { kind: 'remove', pipelineId: 'custom-flow' } },
      postMessage
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as { correlationId: string };
    const env2 = postMessage.mock.calls[1][0] as { correlationId: string };
    expect(env1.correlationId).not.toBe(env2.correlationId);

    // Ack out of order — the second save must not settle the first.
    fireAck(env2.correlationId, 'rejected', 'pipeline-remove-blocked');
    await expect(p2).resolves.toEqual({
      status: 'rejected',
      reason: 'pipeline-remove-blocked'
    });
    fireAck(env1.correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });
  });

  it('ignores a late ack after the timeout has already settled the promise', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    // The one-shot listener is unsubscribed on settle, so no listener remains
    // to deliver a stale accepted ack into a resolved promise.
    expect(ackListeners.has(env.correlationId)).toBe(false);
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = savePipelines(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  const MUTATIONS: readonly SavePipelinesRequest['mutation'][] = [
    { kind: 'create', pipelineId: 'custom-flow' },
    { kind: 'edit', pipelineId: 'custom-flow' },
    {
      kind: 'duplicate',
      sourceScope: 'built-in',
      sourcePipelineId: 'speckit-new-feature',
      pipelineId: 'custom-flow'
    },
    { kind: 'remove', pipelineId: 'custom-flow' },
    { kind: 'reset' }
  ];

  it.each(MUTATIONS.map((mutation) => [mutation.kind, mutation] as const))(
    'forwards a %s mutation unchanged',
    async (_kind, mutation) => {
      const postMessage = vi.fn();
      const request: SavePipelinesRequest = {
        ...SAMPLE_REQUEST,
        mutation,
        pipelines: mutation.kind === 'reset' ? [] : SAMPLE_REQUEST.pipelines
      };
      const promise = savePipelines(request, postMessage);
      const env = postMessage.mock.calls[0][0] as { payload: SavePipelinesRequest; correlationId: string };
      expect(env.payload.mutation).toEqual(mutation);
      expect(env.payload.pipelines).toEqual(request.pipelines);
      fireAck(env.correlationId, 'accepted');
      await promise;
    }
  );
});
