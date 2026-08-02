// Feature 082 (T028) — the `savePipelines` case moved to
// `save-pipelines.test.ts` when the helper adopted the scoped, revisioned
// envelope. That suite covers the same envelope/markPending/accepted-ack
// behavior against the current contract, so keeping a copy here would only pin
// the superseded `{ pipelines }` payload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_SAVE_MODELS, CMD_SAVE_PHASES } from '../messages';
import { saveModels } from '../save-models';
import { savePhases, type SavePhasesRequest } from '../save-phases';

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
  it('savePhases preserves an explicit isRequired: false payload', async () => {
    const posted: unknown[] = [];
    const phases = [
      {
        id: 'optional-audit',
        name: 'Optional Audit',
        version: 2,
        instruction: 'Audit without blocking.',
        isRequired: false
      }
    ];
    const request: SavePhasesRequest = {
      scope: 'workspace',
      expectedRevision: 'workspace-revision',
      mutation: { kind: 'edit', phaseId: 'optional-audit' },
      phases
    };
    const promise = savePhases(request, (msg) => posted.push(msg));
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };

    expect(env.type).toBe(CMD_SAVE_PHASES);
    expect(env.payload).toEqual(request);
    fireAck(env.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('saveModels posts CMD_SAVE_MODELS and forwards rejection reasons', async () => {
    const posted: unknown[] = [];
    const promise = saveModels({ claude: ['claude-sonnet-4-6'] }, (msg) => posted.push(msg));
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_MODELS);
    expect(env.payload).toEqual({ models: { claude: ['claude-sonnet-4-6'] } });
    fireAck(env.correlationId, 'rejected', 'models-validation');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'models-validation'
    });
  });

  it('times out saves that never receive an ack', async () => {
    const promise = saveModels({ claude: ['claude-sonnet-4-6'] }, vi.fn());
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });
});
