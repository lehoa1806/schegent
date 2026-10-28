// FR-R4-F02 (spec 240, data-model §3, contract W4 G14; hard rule 28) — a credit pause is ONE
// nullable object on the Run, and the store refuses every half state it could leave behind.
//
// `creditPause !== null` requires `status === 'paused'`, no delayed-retry pair and no manual-pause
// pair. The invariant is checked on both write paths (`setRun` and `updateRun`), through a real
// `WorkspaceStateStore` over an in-memory `Memento`, and a refusal leaves the persisted JSON
// byte-equal: a forgotten clearing site throws instead of persisting a record the next read would
// have to guess about.
import { describe, expect, it } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { RunPatch, WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { buildWorkflowRun, FIXTURE_NOW } from '../../fixtures/state/queue-fixtures';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const CLAIM = unfencedCommit('test-fixture');
const OPEN_CREDIT_PAUSE = { pausedAt: FIXTURE_NOW, windowStartedAt: null, stoppedAt: null } as const;

/** The patch every case below starts from: a paused Run holding an open credit pause. */
const PAUSED_WITH_CREDIT: RunPatch = { status: 'paused', creditPause: OPEN_CREDIT_PAUSE };

/** One refused shape, by the field that makes the credit pause a half state. */
const HALF_STATES: ReadonlyArray<{ name: string; patch: RunPatch }> = [
  { name: 'a running Run', patch: { status: 'running', creditPause: OPEN_CREDIT_PAUSE } },
  { name: 'a failed Run', patch: { status: 'failed', creditPause: OPEN_CREDIT_PAUSE } },
  { name: 'a completed Run', patch: { status: 'completed', creditPause: OPEN_CREDIT_PAUSE } },
  { name: 'a canceled Run', patch: { status: 'canceled', creditPause: OPEN_CREDIT_PAUSE } },
  {
    name: 'a pending delayed-retry pair',
    patch: {
      ...PAUSED_WITH_CREDIT,
      delayedRetryCount: 1,
      pendingRetryAt: FIXTURE_NOW + 60_000,
      pendingRetryCause: 'rate_limit'
    }
  },
  {
    name: 'a manual-pause pair',
    patch: { ...PAUSED_WITH_CREDIT, manualPauseAt: FIXTURE_NOW, manualPauseCause: 'operator-paused' }
  }
];

async function openStore(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento };
}

function runWith(patch: RunPatch): WorkflowRun {
  return { ...buildWorkflowRun({ id: 'run-credit', status: 'running' }), ...patch } as WorkflowRun;
}

const persisted = (memento: FakeMemento): string => JSON.stringify(memento.get(KEYS.run) ?? null);

describe('FR-R4-F02 — the creditPause invariant on setRun', () => {
  it('accepts a paused Run with an open credit pause and both pairs null', async () => {
    const { store } = await openStore();
    await store.setRun(DEFAULT_QUEUE_ID, runWith(PAUSED_WITH_CREDIT), CLAIM);
    expect((store.getRun(DEFAULT_QUEUE_ID) as unknown as { creditPause: unknown }).creditPause).toEqual(
      OPEN_CREDIT_PAUSE
    );
  });

  it.each([
    ['no window yet', OPEN_CREDIT_PAUSE],
    ['an open window', { pausedAt: FIXTURE_NOW, windowStartedAt: FIXTURE_NOW + 1, stoppedAt: null }],
    ['a stopped window', { pausedAt: FIXTURE_NOW, windowStartedAt: FIXTURE_NOW + 1, stoppedAt: FIXTURE_NOW + 2 }]
  ])('accepts %s', async (_name, creditPause) => {
    const { store } = await openStore();
    await expect(
      store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'paused', creditPause }), CLAIM)
    ).resolves.toBeUndefined();
  });

  it('accepts a null credit pause beside any pause shape', async () => {
    const { store } = await openStore();
    await expect(
      store.setRun(
        DEFAULT_QUEUE_ID,
        runWith({ status: 'paused', creditPause: null, manualPauseAt: FIXTURE_NOW, manualPauseCause: 'operator-paused' }),
        CLAIM
      )
    ).resolves.toBeUndefined();
  });

  for (const half of HALF_STATES) {
    it(`refuses a credit pause beside ${half.name} and leaves the persisted JSON byte-equal`, async () => {
      const { store, memento } = await openStore();
      await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'running', creditPause: null }), CLAIM);
      const before = persisted(memento);

      await expect(
        (async () => store.setRun(DEFAULT_QUEUE_ID, runWith(half.patch), CLAIM))()
      ).rejects.toThrow(/invariant/i);
      expect(persisted(memento)).toBe(before);
    });
  }
});

describe('FR-R4-F02 — the creditPause invariant on updateRun', () => {
  const ALL_STATUSES = ['running', 'paused'] as const;

  async function openWithRunningRun(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
    const opened = await openStore();
    await opened.store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'running', creditPause: null }), CLAIM);
    return opened;
  }

  it('accepts a patch that pauses the Run with an open credit pause and both pairs null', async () => {
    const { store } = await openWithRunningRun();
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      { runId: 'run-credit', allowedStatuses: ALL_STATUSES, label: 'pause', patch: () => PAUSED_WITH_CREDIT },
      CLAIM
    );
    expect((written as unknown as { creditPause: unknown }).creditPause).toEqual(OPEN_CREDIT_PAUSE);
  });

  for (const half of HALF_STATES) {
    // A terminal status is refused earlier by the status precondition, so the invariant is what
    // answers only where the status is one the update is allowed to start from. The terminal rows
    // still pin that the half state never persists, by whichever refusal comes first.
    it(`refuses a patch that leaves a credit pause beside ${half.name}, writing nothing`, async () => {
      const { store, memento } = await openWithRunningRun();
      const before = persisted(memento);

      await expect(
        store.updateRun(
          DEFAULT_QUEUE_ID,
          { runId: 'run-credit', allowedStatuses: ALL_STATUSES, label: 'pause', patch: () => half.patch },
          CLAIM
        )
      ).rejects.toThrow();
      expect(persisted(memento)).toBe(before);
    });
  }

  it('refuses a patch that leaves the credit pause behind when the Run resumes', async () => {
    const { store, memento } = await openWithRunningRun();
    await store.updateRun(
      DEFAULT_QUEUE_ID,
      { runId: 'run-credit', allowedStatuses: ALL_STATUSES, label: 'pause', patch: () => PAUSED_WITH_CREDIT },
      CLAIM
    );
    const before = persisted(memento);

    await expect(
      store.updateRun(
        DEFAULT_QUEUE_ID,
        { runId: 'run-credit', allowedStatuses: ALL_STATUSES, label: 'resume', patch: () => ({ status: 'running' }) },
        CLAIM
      )
    ).rejects.toThrow(/invariant/i);
    expect(persisted(memento)).toBe(before);
  });

  it('accepts the same resume when the patch clears the credit pause with it', async () => {
    const { store } = await openWithRunningRun();
    await store.updateRun(
      DEFAULT_QUEUE_ID,
      { runId: 'run-credit', allowedStatuses: ALL_STATUSES, label: 'pause', patch: () => PAUSED_WITH_CREDIT },
      CLAIM
    );
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: 'run-credit',
        allowedStatuses: ALL_STATUSES,
        label: 'resume',
        patch: () => ({ status: 'running', creditPause: null })
      },
      CLAIM
    );
    expect(written.status).toBe('running');
    expect((written as unknown as { creditPause: unknown }).creditPause).toBeNull();
  });
});
