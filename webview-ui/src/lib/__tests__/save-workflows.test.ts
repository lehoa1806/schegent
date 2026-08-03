// Feature 083 (US1, T033) — saveWorkflows helper behavior.
//
// Contract: specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md
// § "Webview helper" — structurally identical to `savePipelines`: UUIDv4
// correlation, `snapshotStore.markPending`, one-shot `onceAck`, 5-second
// timeout, and no cross-resolution between concurrent saves.
//
// The graph fields are what make the verbatim-forwarding assertions load-bearing
// here: node and connection **authored order**, conditions, and selection rules
// all have to reach the host untouched, because the host validator is the only
// thing entitled to reject them (FR-049).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveWorkflows, type SaveWorkflowsRequest } from '../save-workflows';
import { CMD_SAVE_WORKFLOWS } from '../messages';

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

// A fully authored graph: two nodes, a conditional connection, a default
// connection, a selection rule, and an unrecognized-by-this-type field is
// deliberately absent — the row type is the authored surface, and the deep
// equality below fails if the helper reshapes any of it.
const AUTHORED_ROW = {
  workflowId: 'release-train',
  name: 'Release Train',
  description: 'Draft, then ship if the draft passed.',
  version: 2,
  nodes: [
    { nodeId: 'draft', pipelineId: 'spec-pipeline' },
    { nodeId: 'ship', pipelineId: 'release-pipeline' }
  ],
  connections: [
    {
      from: { nodeId: 'draft', portId: 'spec' },
      to: { nodeId: 'ship', portId: 'brief' },
      condition: {
        left: { source: 'node-status' as const, nodeId: 'draft' },
        operator: 'equals' as const,
        right: 'succeeded'
      },
      selection: 'first' as const
    },
    {
      from: { nodeId: 'draft', portId: 'notes' },
      to: { nodeId: 'ship', portId: 'notes' },
      isDefault: true
    }
  ],
  startNodeIds: ['draft']
};

const SAMPLE_REQUEST: SaveWorkflowsRequest = {
  scope: 'workspace',
  expectedRevision: 'a'.repeat(64),
  mutation: { kind: 'edit', workflowId: 'release-train' },
  workflows: [AUTHORED_ROW]
};

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 083 T033 — saveWorkflows helper', () => {
  it('posts exactly one CMD_SAVE_WORKFLOWS envelope carrying the scoped request verbatim', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);

    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_WORKFLOWS);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    // Deep equality, not a subset check: nodes, connections, conditions,
    // selection rules, and allowed starts must survive the trip to the host.
    expect(env.payload).toEqual(SAMPLE_REQUEST);

    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('preserves authored node and connection order (FR-049)', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { payload: SaveWorkflowsRequest; correlationId: string };
    expect(env.payload.workflows[0].nodes.map((node) => node.nodeId)).toEqual(['draft', 'ship']);
    expect(env.payload.workflows[0].connections.map((edge) => edge.from.portId)).toEqual([
      'spec',
      'notes'
    ]);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('marks the correlation id pending so the snapshot store can gate the UI', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(pendingSet.has(env.correlationId)).toBe(true);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('resolves accepted and preserves the { scope, revision, mutation } ack result', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = { scope: 'workspace', revision: 'b'.repeat(64), mutation: 'edit' };
    fireAck(env.correlationId, 'accepted', undefined, result);
    await expect(promise).resolves.toEqual({ status: 'accepted', result });
  });

  it('resolves rejected with the reason from a matching rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(env.correlationId, 'rejected', 'workflow-validation');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'workflow-validation'
    });
  });

  it('preserves structured recovery details from a stale-catalog rejection', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = {
      currentRevision: 'c'.repeat(64),
      current: [{ workflowId: 'release-train', version: 3 }]
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
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('does NOT cross-resolve mismatched correlation ids when two saves are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const p2 = saveWorkflows(
      { ...SAMPLE_REQUEST, scope: 'user', mutation: { kind: 'remove', workflowId: 'release-train' } },
      postMessage
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as { correlationId: string };
    const env2 = postMessage.mock.calls[1][0] as { correlationId: string };
    expect(env1.correlationId).not.toBe(env2.correlationId);

    // Ack out of order — the second save must not settle the first.
    fireAck(env2.correlationId, 'rejected', 'workflow-validation');
    await expect(p2).resolves.toEqual({
      status: 'rejected',
      reason: 'workflow-validation'
    });
    fireAck(env1.correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });
  });

  it('ignores a late ack after the timeout has already settled the promise', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    // The one-shot listener is unsubscribed on settle, so no listener remains
    // to deliver a stale accepted ack into a resolved promise.
    expect(ackListeners.has(env.correlationId)).toBe(false);
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = saveWorkflows(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  const MUTATIONS: readonly SaveWorkflowsRequest['mutation'][] = [
    { kind: 'create', workflowId: 'release-train' },
    { kind: 'edit', workflowId: 'release-train' },
    {
      kind: 'duplicate',
      sourceScope: 'user',
      sourceWorkflowId: 'release-train',
      workflowId: 'release-train-copy'
    },
    { kind: 'remove', workflowId: 'release-train' },
    { kind: 'reset' }
  ];

  it.each(MUTATIONS.map((mutation) => [mutation.kind, mutation] as const))(
    'forwards a %s mutation unchanged',
    async (_kind, mutation) => {
      const postMessage = vi.fn();
      const request: SaveWorkflowsRequest = {
        ...SAMPLE_REQUEST,
        mutation,
        workflows: mutation.kind === 'reset' ? [] : SAMPLE_REQUEST.workflows
      };
      const promise = saveWorkflows(request, postMessage);
      const env = postMessage.mock.calls[0][0] as {
        payload: SaveWorkflowsRequest;
        correlationId: string;
      };
      expect(env.payload.mutation).toEqual(mutation);
      expect(env.payload.workflows).toEqual(request.workflows);
      fireAck(env.correlationId, 'accepted');
      await promise;
    }
  );
});
