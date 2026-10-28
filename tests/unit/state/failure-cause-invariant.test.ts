// FR-R4-F14 (spec 242, contract W2.2 and W4.1, TA6; hard rule 28) — a failure cause exists only on a
// failed Run, and the store refuses every other shape.
//
// `failureCause !== undefined` requires `status === 'failed'`. The invariant is checked on both write
// paths (`setRun` and `updateRun`), through a real `WorkspaceStateStore` over an in-memory `Memento`,
// and a refusal leaves the persisted JSON byte-equal: a writer that leaves `failed` and forgets the
// code throws instead of persisting a record two readers would disagree about. A failed Run without a
// code is legal, because every Run persisted before the feature is one.
//
// The two patch builders no other unit file covers (`resumeAdmissionPatch`, `canceledRunPatch`) are
// driven here, through `updateRun`, so the removal of the key is the store's own.
import { describe, expect, it } from 'vitest';
import { resumeAdmissionPatch, type ResumeAdmissionFields } from '../../../src/controller/resume-pause-fields';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { canceledRunPatch, type RunPatch, type WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

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
const RUN_ID = 'run-failure-cause';
const FAILED_WITH_CAUSE: RunPatch = { status: 'failed', failureCause: 'cap_exhausted' };
const NOT_FAILED_STATUSES = ['running', 'paused', 'completed', 'canceled'] as const;
const ALL_STATUSES = ['running', 'paused', 'failed'] as const;
const INVARIANT_MESSAGE = (status: string): string =>
  `WorkflowRun invariant violation: failureCause requires status 'failed' (got '${status}')`;

async function openStore(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento };
}

function runWith(patch: RunPatch): WorkflowRun {
  return { ...buildWorkflowRun({ id: RUN_ID, status: 'running' }), ...patch } as WorkflowRun;
}

const persisted = (memento: FakeMemento): string => JSON.stringify(memento.get(KEYS.run) ?? null);

async function openWithFailedRun(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
  const opened = await openStore();
  await opened.store.setRun(DEFAULT_QUEUE_ID, runWith(FAILED_WITH_CAUSE), CLAIM);
  return opened;
}

const NO_PLAN_FIELDS: ResumeAdmissionFields = {
  pipeline: undefined,
  defaultRunnerKind: undefined,
  mutationPlan: undefined,
  envelope: undefined,
  gitApprovalReceipt: undefined
};

describe('FR-R4-F14 — the failureCause invariant on setRun', () => {
  it('accepts a failed Run carrying a cause, and reads it back', async () => {
    const { store } = await openStore();
    await store.setRun(DEFAULT_QUEUE_ID, runWith(FAILED_WITH_CAUSE), CLAIM);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('cap_exhausted');
  });

  it('accepts a failed Run whose cause is a member this build does not know (W2.1: membership is not checked)', async () => {
    const { store } = await openStore();
    await expect(
      store.setRun(
        DEFAULT_QUEUE_ID,
        runWith({ status: 'failed', failureCause: 'a_member_a_newer_build_appended' as never }),
        CLAIM
      )
    ).resolves.toBeUndefined();
    expect(store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('a_member_a_newer_build_appended');
  });

  it('accepts a failed Run with no cause (every Run persisted before the feature)', async () => {
    const { store } = await openStore();
    await expect(
      store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'failed' }), CLAIM)
    ).resolves.toBeUndefined();
    expect(store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBeUndefined();
  });

  for (const status of NOT_FAILED_STATUSES) {
    it(`refuses a cause beside a ${status} Run and leaves the persisted JSON byte-equal`, async () => {
      const { store, memento } = await openStore();
      await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'running' }), CLAIM);
      const before = persisted(memento);

      await expect(
        (async () =>
          store.setRun(DEFAULT_QUEUE_ID, runWith({ status, failureCause: 'phase_failed' }), CLAIM))()
      ).rejects.toThrow(INVARIANT_MESSAGE(status));
      expect(persisted(memento)).toBe(before);
    });
  }
});

describe('FR-R4-F14 — the failureCause invariant on updateRun', () => {
  async function openWithRunningRun(): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
    const opened = await openStore();
    await opened.store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'running' }), CLAIM);
    return opened;
  }

  it('accepts a patch that fails the Run with a cause in the same write', async () => {
    const { store } = await openWithRunningRun();
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      { runId: RUN_ID, allowedStatuses: ALL_STATUSES, label: 'driver-transition', patch: () => FAILED_WITH_CAUSE },
      CLAIM
    );
    expect(written.status).toBe('failed');
    expect(written.failureCause).toBe('cap_exhausted');
  });

  for (const status of ['running', 'paused'] as const) {
    it(`refuses a patch that puts a cause beside a ${status} Run, writing nothing`, async () => {
      const { store, memento } = await openWithRunningRun();
      const before = persisted(memento);

      await expect(
        store.updateRun(
          DEFAULT_QUEUE_ID,
          {
            runId: RUN_ID,
            allowedStatuses: ALL_STATUSES,
            label: 'driver-transition',
            patch: () => ({ status, failureCause: 'phase_failed' })
          },
          CLAIM
        )
      ).rejects.toThrow(INVARIANT_MESSAGE(status));
      expect(persisted(memento)).toBe(before);
    });
  }

  it('refuses a patch that leaves the cause behind when the Run leaves failed', async () => {
    const { store, memento } = await openWithFailedRun();
    const before = persisted(memento);

    await expect(
      store.updateRun(
        DEFAULT_QUEUE_ID,
        { runId: RUN_ID, allowedStatuses: ALL_STATUSES, label: 'resume', patch: () => ({ status: 'running' }) },
        CLAIM
      )
    ).rejects.toThrow(INVARIANT_MESSAGE('running'));
    expect(persisted(memento)).toBe(before);
  });

  it('removes the key when a patch writes `failureCause: undefined`', async () => {
    const { store } = await openWithFailedRun();
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: RUN_ID,
        allowedStatuses: ALL_STATUSES,
        label: 'resume',
        patch: () => ({ status: 'running', failureCause: undefined })
      },
      CLAIM
    );
    expect(written.status).toBe('running');
    expect('failureCause' in written).toBe(false);
    expect('failureCause' in (store.getRun(DEFAULT_QUEUE_ID) as WorkflowRun)).toBe(false);
  });
});

describe('FR-R4-F14 — writers that leave failed drop the cause (contract W4.1)', () => {
  it('resumeAdmissionPatch resumes a failed Run without the key', async () => {
    const { store } = await openWithFailedRun();
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: RUN_ID,
        allowedStatuses: ALL_STATUSES,
        label: 'resume-admission',
        patch: (current) => resumeAdmissionPatch(current, NO_PLAN_FIELDS)
      },
      CLAIM
    );
    expect(written.status).toBe('running');
    expect('failureCause' in written).toBe(false);
  });

  it('canceledRunPatch cancels a failed Run without the key', async () => {
    const { store } = await openWithFailedRun();
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: RUN_ID,
        allowedStatuses: ALL_STATUSES,
        label: 'cancel',
        patch: () => canceledRunPatch(Date.now())
      },
      CLAIM
    );
    expect(written.status).toBe('canceled');
    expect('failureCause' in written).toBe(false);
  });
});

// FR-R4-F14 (spec 242, data-model §9, US4) — every Run persisted before the feature is a failed Run with no
// cause, and the store must keep accepting and returning it as it is.
describe('FR-R4-F14 — a persisted failed Run without a cause stays legal', () => {
  it('loads through the store and reads back with no failureCause key', async () => {
    const memento = new FakeMemento();
    const legacy = {
      ...buildWorkflowRun({ id: RUN_ID, status: 'failed' }),
      lastError: { code: 'invocation-failed', message: 'phase failed', phase: 'speckit-plan', iteration: 1, at: 1 }
    };
    // A Run map as an earlier build wrote it: keyed by queue, no `failureCause` anywhere.
    await memento.update(KEYS.run, { [DEFAULT_QUEUE_ID]: legacy });

    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    const loaded = store.getRun(DEFAULT_QUEUE_ID);
    expect(loaded?.status).toBe('failed');
    expect(loaded !== null && 'failureCause' in loaded).toBe(false);
    // And an ordinary write over it is not refused.
    await expect(
      store.updateRun(
        DEFAULT_QUEUE_ID,
        { runId: RUN_ID, allowedStatuses: ALL_STATUSES, label: 'liveness', patch: () => ({ lastTransitionAt: 2 }) },
        CLAIM
      )
    ).resolves.toMatchObject({ status: 'failed' });
  });
});
