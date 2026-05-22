// Feature 063 — T044 integration test for the suppression round trip.
//
// Exercises the full host stack for `CMD_SET_CONFIRM_SUPPRESSION`:
//
//   1. Dispatch the command through `MessageRouter` with `suppressed: true`.
//   2. Read the memento directly via `store.getConfirmSuppression()` and
//      assert the action key is present.
//   3. Project the snapshot via `StateProjector` and assert
//      `confirmSuppression.suppressedActionKeys` reflects the change.
//   4. Dispatch the command again with `suppressed: false` and assert
//      absence in both the memento and the snapshot.
//
// Covers FR-021 (per-action suppression survives reload).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../src/ui/sidebar/message-router';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import {
  CMD_ACK,
  CMD_SET_CONFIRM_SUPPRESSION
} from '../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';

class MockMemento implements Memento {
  public writes: Array<{ key: string; value: unknown }> = [];
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writes.push({ key, value });
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

interface SetupResult {
  router: MessageRouter;
  store: WorkspaceStateStore;
  projector: StateProjector;
  memento: MockMemento;
  acks: CommandAckMessage[];
  postAck: (msg: CommandAckMessage) => Promise<boolean>;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<SetupResult> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-suppression-rt-'));
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const projector = new StateProjector({ store, audit, ownerId: 'test-owner' });

  const acks: CommandAckMessage[] = [];
  const postAck = vi.fn(async (msg: CommandAckMessage) => {
    acks.push(msg);
    return true;
  });

  const deps: RouterDeps = {
    executeCommand: vi.fn(async () => undefined as unknown) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    isPrimary: () => true,
    isTrusted: () => true,
    logger,
    setConfirmSuppression: async (actionKey, suppressed) => {
      await store.setConfirmSuppression(actionKey, suppressed);
      projector.kick();
    }
  };

  return {
    router: new MessageRouter(deps),
    store,
    projector,
    memento,
    acks,
    postAck,
    cleanup: async () => {
      projector.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  };
}

describe('CMD_SET_CONFIRM_SUPPRESSION — integration round trip (T044, FR-021)', () => {
  let env: SetupResult;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('persists `suppressed: true` to the memento, surfaces in snapshot, and ack accepted', async () => {
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-on',
        payload: { actionKey: 'queue.clean-all', suppressed: true }
      },
      env.postAck
    );

    expect(env.acks).toHaveLength(1);
    expect(env.acks[0].type).toBe(CMD_ACK);
    expect(env.acks[0].status).toBe('accepted');
    expect(env.acks[0].correlationId).toBe('c-on');

    const state = env.store.getConfirmSuppression();
    expect(state.version).toBe(1);
    expect(state.suppressedActionKeys).toContain('queue.clean-all');

    const snap = env.projector.project();
    expect(snap.confirmSuppression).toBeDefined();
    expect(snap.confirmSuppression!.suppressedActionKeys).toContain('queue.clean-all');
  });

  it('toggles back to `suppressed: false` and the key is removed from the memento + snapshot', async () => {
    // First write — add the key.
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: 'history.rerun', suppressed: true }
      },
      env.postAck
    );
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toContain('history.rerun');

    // Second write — remove the key.
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-2',
        payload: { actionKey: 'history.rerun', suppressed: false }
      },
      env.postAck
    );

    expect(env.acks[1].status).toBe('accepted');
    expect(env.store.getConfirmSuppression().suppressedActionKeys).not.toContain('history.rerun');
    const snap = env.projector.project();
    expect(snap.confirmSuppression!.suppressedActionKeys).not.toContain('history.rerun');
  });

  it('multiple distinct keys accumulate independently in the memento and snapshot', async () => {
    for (const key of ['queue.clear-done', 'queue.pause', 'run.modify-task']) {
      await env.router.dispatch(
        {
          type: CMD_SET_CONFIRM_SUPPRESSION,
          correlationId: `c-${key}`,
          payload: { actionKey: key, suppressed: true }
        },
        env.postAck
      );
    }

    const state = env.store.getConfirmSuppression();
    expect(state.suppressedActionKeys).toEqual(
      expect.arrayContaining(['queue.clear-done', 'queue.pause', 'run.modify-task'])
    );
    expect(state.suppressedActionKeys).toHaveLength(3);

    const snap = env.projector.project();
    expect(snap.confirmSuppression!.suppressedActionKeys).toEqual(
      expect.arrayContaining(['queue.clear-done', 'queue.pause', 'run.modify-task'])
    );
  });

  it('idempotent: setting `true` twice is a no-op for the suppressed set', async () => {
    for (let i = 0; i < 2; i++) {
      await env.router.dispatch(
        {
          type: CMD_SET_CONFIRM_SUPPRESSION,
          correlationId: `c-dup-${i}`,
          payload: { actionKey: 'workspace.reset', suppressed: true }
        },
        env.postAck
      );
    }
    // The set has at most one occurrence of the key (set semantics).
    const keys = env.store.getConfirmSuppression().suppressedActionKeys;
    expect(keys.filter((k) => k === 'workspace.reset')).toHaveLength(1);
    // Both acks accepted.
    expect(env.acks.every((a) => a.status === 'accepted')).toBe(true);
  });

  it('idempotent: setting `false` on an absent key is a no-op', async () => {
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-off',
        payload: { actionKey: 'queue.remove-item', suppressed: false }
      },
      env.postAck
    );
    expect(env.acks[0].status).toBe('accepted');
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('rejects an unknown action key without touching the memento', async () => {
    const writesBefore = env.memento.writes.length;
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-bad',
        payload: { actionKey: 'not.a.real.key', suppressed: true }
      },
      env.postAck
    );
    expect(env.acks[0].status).toBe('rejected');
    expect(env.acks[0].reason).toBe('unknown-action-key');
    expect(env.memento.writes.length).toBe(writesBefore);
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('memento write key is `schegent.ui.confirmSuppression` with the expected shape', async () => {
    await env.router.dispatch(
      {
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-shape',
        payload: { actionKey: 'queue.pause', suppressed: true }
      },
      env.postAck
    );
    const lastWrite = env.memento.writes.find(
      (w) => w.key === 'schegent.ui.confirmSuppression'
    );
    expect(lastWrite).toBeDefined();
    const value = lastWrite!.value as { version: number; suppressedActionKeys: string[] };
    expect(value.version).toBe(1);
    expect(value.suppressedActionKeys).toContain('queue.pause');
  });
});
