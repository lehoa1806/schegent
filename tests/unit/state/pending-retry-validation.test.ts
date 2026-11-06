// FR-R5-F19 (spec 278, T19.2, FR-010; task T026) — a delayed-retry countdown belongs to a paused Run only.
//
// `pendingRetryAt` / `pendingRetryCause` are written by one place, the delayed-retry scheduler, on a Run it
// has just set to `paused`. A Run in any other status that still carries them reads, in every row and menu
// that asks "is a retry armed", as a countdown nothing is running. Three promises:
//   - a NEW write pairing the fields with a status other than `paused` is refused, through both write paths,
//     and the persisted JSON stays byte-equal;
//   - a record already stored in that shape (legacy) loads, and a write that leaves it as it was is accepted,
//     so no later patch strands the Run and no load rejects the queue;
//   - a legacy Run is never unattended-eligible: the wakeup rule reads `status` before the fields.
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { decideUnattendedEligibility } from '../../../src/services/unattended-eligibility';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { RunPatch, WorkflowRun } from '../../../src/state/workflow-run';
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
const RUN_ID = 'run-pending-retry';
const DEADLINE = 1_000;
const NOW = DEADLINE + 5_000;
const ARMED: RunPatch = { pendingRetryAt: DEADLINE, pendingRetryCause: 'rate_limit' };
const NOT_PAUSED = ['running', 'completed', 'canceled', 'failed'] as const;
// A stored `running` Run whose Task row is gone is ended by the load-time orphan reconciler, which clears
// the pair; that repair is its own tested behavior, so the load cases use the three terminal statuses.
const TERMINAL = ['completed', 'canceled', 'failed'] as const;
const ALL_STATUSES = ['running', 'paused', 'completed', 'canceled', 'failed'] as const;
const REFUSAL = /WorkflowRun invariant violation: pendingRetryAt .* require status 'paused'/;

function runWith(patch: RunPatch): WorkflowRun {
  return { ...buildWorkflowRun({ id: RUN_ID, status: 'running' }), ...patch } as WorkflowRun;
}

async function openStore(memento = new FakeMemento()): Promise<{ store: WorkspaceStateStore; memento: FakeMemento }> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento };
}

const persisted = (memento: FakeMemento): string => JSON.stringify(memento.get(KEYS.run) ?? null);

describe('a new write pairing a retry countdown with a status other than paused is refused', () => {
  it('control: the same fields on a paused Run are accepted and read back', async () => {
    const { store } = await openStore();
    await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'paused', ...ARMED }), CLAIM);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.pendingRetryAt).toBe(DEADLINE);
  });

  it.each(NOT_PAUSED)('setRun refuses the fields beside a %s Run and writes nothing', async (status) => {
    const { store, memento } = await openStore();
    await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'running' }), CLAIM);
    const before = persisted(memento);

    // `setRun` validates before it returns a promise, so the refusal is a synchronous throw; the wrapper
    // makes both shapes read the same way (the failure-cause invariant test does likewise).
    await expect(
      (async () => store.setRun(DEFAULT_QUEUE_ID, runWith({ status, ...ARMED }), CLAIM))()
    ).rejects.toThrow(REFUSAL);
    expect(persisted(memento)).toBe(before);
  });

  it.each(['completed', 'canceled', 'failed'] as const)(
    'updateRun refuses a patch that leaves the countdown armed on a %s Run',
    async (status) => {
      const { store, memento } = await openStore();
      await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'paused', ...ARMED }), CLAIM);
      const before = persisted(memento);

      await expect(
        store.updateRun(
          DEFAULT_QUEUE_ID,
          { runId: RUN_ID, allowedStatuses: ALL_STATUSES, label: 'driver-transition', patch: () => ({ status }) },
          CLAIM
        )
      ).rejects.toThrow(REFUSAL);
      expect(persisted(memento)).toBe(before);
    }
  );

  it('updateRun accepts the same transition when the patch clears the countdown', async () => {
    const { store } = await openStore();
    await store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'paused', ...ARMED }), CLAIM);
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: RUN_ID,
        allowedStatuses: ALL_STATUSES,
        label: 'driver-transition',
        patch: () => ({ status: 'completed', pendingRetryAt: null, pendingRetryCause: null })
      },
      CLAIM
    );
    expect(written.status).toBe('completed');
    expect(written.pendingRetryAt).toBeNull();
  });
});

describe('a stored legacy combination loads and is not stranded', () => {
  async function openOverLegacy(status: (typeof TERMINAL)[number]): Promise<WorkspaceStateStore> {
    const first = await openStore();
    await first.store.setRun(DEFAULT_QUEUE_ID, runWith({ status: 'paused', ...ARMED }), CLAIM);
    const stored = first.memento.get<Record<string, WorkflowRun>>(KEYS.run) ?? {};
    const legacy = { ...stored, [DEFAULT_QUEUE_ID]: { ...(stored[DEFAULT_QUEUE_ID] as WorkflowRun), status } };
    await first.memento.update(KEYS.run, legacy);
    return (await openStore(first.memento)).store;
  }

  it.each(TERMINAL)('a %s Run holding the fields loads without rejecting the queue', async (status) => {
    const store = await openOverLegacy(status);
    const run = store.getRun(DEFAULT_QUEUE_ID);
    expect(run).not.toBeNull();
    expect(run?.pendingRetryAt).toBe(DEADLINE);
  });

  it('a write that leaves the legacy fields exactly as they were is accepted', async () => {
    const store = await openOverLegacy('completed');
    const written = await store.updateRun(
      DEFAULT_QUEUE_ID,
      { runId: RUN_ID, allowedStatuses: ALL_STATUSES, label: 'driver-transition', patch: () => ({ lastTransitionAt: 42 }) },
      CLAIM
    );
    expect(written.lastTransitionAt).toBe(42);
    expect(written.pendingRetryAt).toBe(DEADLINE);
  });
});

describe('a legacy Run is never unattended-eligible', () => {
  it.each(NOT_PAUSED)('a %s Run holding the fields is refused both wakeups as not-paused', (status) => {
    const run = runWith({ status, ...ARMED });
    const backoff = decideUnattendedEligibility(
      run,
      { cause: 'backoff-elapsed', queueId: DEFAULT_QUEUE_ID, deadline: DEADLINE },
      NOW
    );
    const credits = decideUnattendedEligibility(
      run,
      { cause: 'credits-restored', queueId: DEFAULT_QUEUE_ID, evidenceAt: NOW },
      NOW
    );
    expect(backoff).toEqual({ eligible: false, reason: 'not-paused' });
    expect(credits).toEqual({ eligible: false, reason: 'not-paused' });
  });

  it('control: the same fields on a paused Run with the deadline reached are eligible', () => {
    const run = runWith({ status: 'paused', ...ARMED });
    expect(
      decideUnattendedEligibility(run, { cause: 'backoff-elapsed', queueId: DEFAULT_QUEUE_ID, deadline: DEADLINE }, NOW)
    ).toEqual({ eligible: true });
  });
});
