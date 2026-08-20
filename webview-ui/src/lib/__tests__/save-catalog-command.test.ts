// Feature 082 (T028) — the `savePipelines` case moved to `save-pipelines.test.ts`
// when the helper adopted the revisioned envelope.
//
// Feature 100 (FR-R3-016) T509b — the `savePhases` case followed it out, for a
// different reason. It asserted that an explicit `isRequired: false` survived the
// payload, against `CMD_SAVE_PHASES`; that command is retired, and the same claim
// belonged where the translation lives, because the row has become a definition
// *body* rather than an element of a layer array.
//
// Feature 101 (T030) — both destinations were deleted with the three `save-*`
// transports they tested. The claims they carried live in
// `catalog-lifecycle.test.ts` and in the per-editor suites that assert the body
// each save sends.
//
// What is left is the Model Catalog, which `save-catalog-command.ts` still serves:
// it is the one catalog that did NOT move into the versioned store (099, out of
// scope), so it keeps the generic correlate/pend/ack/timeout helper. That makes
// this file the only remaining coverage of `saveCatalogCommand` itself, and the
// reason `tests/lint/no-inline-save-catalog.test.ts` still allowlists it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_SAVE_MODELS } from '../messages';
import { saveModels } from '../save-models';

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
  it('saveModels posts CMD_SAVE_MODELS and forwards rejection reasons', async () => {
    const posted: unknown[] = [];
    const promise = saveModels({ claude: ['claude-sonnet-4-6'] }, (msg) => posted.push(msg));
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_MODELS);
    expect(env.payload).toEqual({ models: { claude: ['claude-sonnet-4-6'] } });
    expect(pendingSet.has(env.correlationId)).toBe(true);
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
