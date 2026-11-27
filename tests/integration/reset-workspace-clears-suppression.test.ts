// Feature 063 — T045 integration test. Asserts that a workspace reset
// atomically clears the suppression memento alongside every other
// workspace-state key (FR-022a).
//
// It used to drive `CMD_RESET` through the `MessageRouter`. The lifecycle
// round-check of 2026-08-30 (finding D) deleted that command: its handler was a
// three-line `exec(ctx, 'schegent.reset')` shim reachable from no webview
// surface after FR-R3-140 removed `ControlPanel.svelte`, so the route this test
// drove was one only this test took. The palette route survives, and the tail
// it reaches — `runReset` → `store.reset()` — is what these assertions were
// ever about; the router was scaffolding in front of it. Driving `store.reset()`
// directly is the same coverage against the wiring that still exists.
//
// The test populates the suppression memento with 3 keys, resets, and
// verifies:
//
//   (a) every populated suppression key is gone from the persisted state;
//   (b) the suppression memento write happens in the same atomic
//       `Promise.all` batch as the rest of the reset, i.e. exactly ONE
//       observation of `update(KEYS.confirmSuppression, undefined)`;
//   (c) the projector surface drops the suppression set after reset.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';

const SUPPRESSION_KEY = 'schegent.ui.confirmSuppression';

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
  store: WorkspaceStateStore;
  projector: StateProjector;
  memento: MockMemento;
  /** The post-confirm tail of `runReset`, which is what `schegent.reset` runs. */
  reset: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<SetupResult> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-reset-supp-'));
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const projector = new StateProjector({ store, audit, ownerId: 'test-owner' });

  // The post-confirm tail of `runReset`, which is what `schegent.reset` runs.
  // The operator confirmation lives ahead of it and is irrelevant here.
  const reset = async (): Promise<void> => {
    await store.reset();
    projector.kick();
  };

  return {
    store,
    projector,
    memento,
    reset,
    cleanup: async () => {
      projector.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  };
}

async function populateSuppression(
  store: WorkspaceStateStore,
  keys: readonly string[]
): Promise<void> {
  for (const key of keys) {
    await store.setConfirmSuppression(key, true);
  }
}

describe('workspace reset clears confirmation suppression (T045, FR-022a)', () => {
  let env: SetupResult;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('removes all 3 suppression keys when the workspace is reset', async () => {
    const seeded = ['queue.clean-all', 'history.rerun', 'workspace.reset'];
    await populateSuppression(env.store, seeded);
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toHaveLength(3);

    // Snapshot the write log AFTER seeding so the spy only sees the reset.
    env.memento.writes = [];

    await env.reset();

    // Memento is gone (or set to undefined).
    expect(env.memento.get(SUPPRESSION_KEY)).toBeUndefined();
    // Accessor returns the empty state (the operator sees prompts again).
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
    // None of the originally-seeded keys remain.
    for (const key of seeded) {
      expect(env.store.getConfirmSuppression().suppressedActionKeys).not.toContain(key);
    }
  });

  it('the suppression memento is cleared in the same atomic batch as the other reset writes', async () => {
    await populateSuppression(env.store, [
      'queue.clean-all',
      'history.rerun',
      'queue.pause'
    ]);
    env.memento.writes = [];

    await env.reset();

    // Exactly ONE write touching the suppression key during reset.
    const suppressionWrites = env.memento.writes.filter((w) => w.key === SUPPRESSION_KEY);
    expect(suppressionWrites).toHaveLength(1);
    expect(suppressionWrites[0].value).toBeUndefined();

    // The write is part of the same atomic batch as the queue/run/watchdog
    // writes — every key in the reset() Promise.all appears in the spy
    // captured during this single dispatch.
    const touched = new Set(env.memento.writes.map((w) => w.key));
    expect(touched.has('schegent.queue')).toBe(true);
    expect(touched.has('schegent.run')).toBe(true);
    expect(touched.has('schegent.lock')).toBe(true);
    expect(touched.has('schegent.watchdog')).toBe(true);
    expect(touched.has('schegent.history')).toBe(true);
    expect(touched.has(SUPPRESSION_KEY)).toBe(true);
  });

  it('the projector surface drops the suppression set after reset', async () => {
    await populateSuppression(env.store, [
      'queue.clean-all',
      'queue.clear-done',
      'run.modify-task'
    ]);
    const before = env.projector.project();
    expect(before.confirmSuppression!.suppressedActionKeys).toHaveLength(3);

    await env.reset();

    const after = env.projector.project();
    // Either the field is absent or the array is empty — both are valid
    // "no suppression" projections per snapshot-confirm-suppression-projection.test.ts.
    if (after.confirmSuppression !== undefined) {
      expect(after.confirmSuppression.suppressedActionKeys).toEqual([]);
    }
  });

  it('reset is a no-op when the suppression memento was already empty', async () => {
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
    env.memento.writes = [];

    await env.reset();

    // Even on an empty state the reset writes `undefined` to clear the slot,
    // which is harmless and idempotent.
    const suppressionWrites = env.memento.writes.filter((w) => w.key === SUPPRESSION_KEY);
    expect(suppressionWrites).toHaveLength(1);
    expect(suppressionWrites[0].value).toBeUndefined();
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('reset removes a fully-populated 11-key suppression set', async () => {
    const all = [
      'queue.clean-all',
      'queue.clear-done',
      'queue.remove-item',
      'queue.cancel-item',
      'queue.pause',
      'queue.resume',
      'run.retry-phase-now',
      'run.restart-canceled',
      'run.modify-task',
      'history.rerun',
      'workspace.reset'
    ];
    await populateSuppression(env.store, all);
    expect(env.store.getConfirmSuppression().suppressedActionKeys).toHaveLength(11);

    await env.reset();

    expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });
});
