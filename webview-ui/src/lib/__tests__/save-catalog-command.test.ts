import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_SAVE_MODELS, CMD_SAVE_PIPELINES } from '../messages';
import { saveModels } from '../save-models';
import { savePipelines } from '../save-pipelines';

type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string }) => void;

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

function fireAck(id: string, status: 'accepted' | 'rejected', reason?: string): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason });
}

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('save catalog helpers', () => {
  it('savePipelines posts CMD_SAVE_PIPELINES and resolves accepted on ack', async () => {
    const posted: unknown[] = [];
    const pipelines = [
      { id: 'custom', name: 'Custom', phases: ['speckit-specify', 'speckit-plan'] }
    ];
    const promise = savePipelines(pipelines, (msg) => posted.push(msg));
    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_PIPELINES);
    expect(env.payload).toEqual({ pipelines });
    expect(pendingSet.has(env.correlationId)).toBe(true);
    fireAck(env.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('saveModels posts CMD_SAVE_MODELS and forwards rejection reasons', async () => {
    const posted: unknown[] = [];
    const promise = saveModels(['claude-sonnet-4-6'], (msg) => posted.push(msg));
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_MODELS);
    expect(env.payload).toEqual({ models: ['claude-sonnet-4-6'] });
    fireAck(env.correlationId, 'rejected', 'models-validation');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'models-validation'
    });
  });

  it('times out saves that never receive an ack', async () => {
    const promise = saveModels(['claude-sonnet-4-6'], vi.fn());
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });
});
