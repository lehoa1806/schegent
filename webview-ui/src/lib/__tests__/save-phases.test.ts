// Feature 026 T012 — savePhases helper behavior.
//
// Mirrors save-general-settings.test.ts. Asserts:
//   - Posts exactly one CMD_SAVE_PHASES envelope per call with shape
//     { type, correlationId, payload: { phases } }.
//   - Resolves `accepted` on a matching accepted ack.
//   - Resolves `rejected` with reason on a matching rejected ack.
//   - Resolves `{ status: 'rejected', reason: 'timeout' }` after 5 seconds.
//   - Concurrent calls never cross-resolve mismatched correlation ids.
//   - Correlation ids match the RFC 4122 v4 layout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePhases, type SavePhasesRequest } from '../save-phases';
import { CMD_SAVE_PHASES } from '../messages';

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

const SAMPLE_PHASES = [
  {
    id: 'speckit-plan',
    name: 'Plan',
    version: 2,
    instruction: 'Plan the work.',
    loopable: false,
    effort: 'high' as const
  }
];

const SAMPLE_REQUEST: SavePhasesRequest = {
  scope: 'workspace',
  expectedRevision: 'workspace-revision',
  mutation: { kind: 'edit', phaseId: 'speckit-plan' },
  phases: SAMPLE_PHASES
};

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 026 T012 — savePhases helper', () => {
  it('posts a single CMD_SAVE_PHASES envelope with { payload: { phases } }', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: { phases: unknown } };
    expect(env.type).toBe(CMD_SAVE_PHASES);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    expect(env.payload).toEqual(SAMPLE_REQUEST);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('resolves accepted when a matching accepted ack fires', async () => {
    const postMessage = vi.fn();
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    const envelope = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(envelope.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('resolves rejected with reason on a matching rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    const envelope = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(envelope.correlationId, 'rejected', 'phase-validation:speckit-plan:effort');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'phase-validation:speckit-plan:effort'
    });
  });

  it('preserves structured recovery details from a rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    const envelope = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = {
      code: 'phase-remove-blocked',
      dependentPipelineIds: ['release', 'standard'],
      legalActions: ['remove-dependencies', 'cancel']
    };
    fireAck(envelope.correlationId, 'rejected', 'phase-remove-blocked', result);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'phase-remove-blocked',
      result
    });
  });

  it('resolves { status: rejected, reason: timeout } after 5 seconds without ack', async () => {
    const postMessage = vi.fn();
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('does NOT cross-resolve mismatched correlation ids when two saves are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = savePhases(SAMPLE_REQUEST, postMessage);
    const p2 = savePhases(SAMPLE_REQUEST, postMessage);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as { correlationId: string };
    const env2 = postMessage.mock.calls[1][0] as { correlationId: string };
    expect(env1.correlationId).not.toBe(env2.correlationId);

    fireAck(env2.correlationId, 'rejected', 'phase-validation:speckit-plan:effort');
    await expect(p2).resolves.toEqual({
      status: 'rejected',
      reason: 'phase-validation:speckit-plan:effort'
    });
    fireAck(env1.correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = savePhases(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });
});
