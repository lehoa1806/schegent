import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { QueueMutationRejected } from '../../../src/state/workspace-state';
import { isSupersededRun, type WorkflowRun } from '../../../src/state/workflow-run';
import { queueResource } from '../../../src/state/ownership-registry';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';

/**
 * FR-R3-055 (H-06) — a Run that loses its lease mid-work must not commit its next
 * state mutation.
 *
 * This is the third of the item's three acceptance interleavings, and until now
 * there was nothing for it to gate: admission-time ownership was the only check,
 * so a Run whose lease had been reclaimed went on writing state that another
 * window's Run would then act on.
 *
 * The protocol chosen is (b), fence-stamped snapshots. Two halves, both asserted
 * here: the commit-point check refuses the write it can see, and the stamp lets a
 * reader disbelieve one that slipped past.
 */
let fs: SharedOwnershipFs;
let hosts: readonly Host[];
let clock: ManualClock;
let scheduler: ManualScheduler;

beforeEach(async () => {
  fs = new SharedOwnershipFs();
  hosts = await createHosts(2, fs);
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

/** A Run that satisfies `validateRunInvariants`; the fence is what varies. */
const run = (id: string): WorkflowRun =>
  ({
    id,
    featureId: 'feat-1',
    featureDir: 'specs/001-x',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  }) as unknown as WorkflowRun;

describe('a Run mutation carries its fence to the commit point', () => {
  it('commits while the lease is still held', async () => {
    // The mechanism must not refuse a legitimate write, or it is indistinguishable
    // from breaking Run persistence.
    const host = hosts[0]!;
    const lease = new ExecutionLeaseManager(host.store, 'window-a', clock, scheduler);
    expect((await lease.tryAcquire('default')).acquired).toBe(true);
    const fence = lease.fenceOfRecord('default')!;

    await host.store.setRun('default', run('run-1'), {
      resource: queueResource('default'),
      ownerId: 'window-a',
      fence
    });
    expect(host.store.getRun('default')?.id).toBe('run-1');
  });

  it('refuses the mutation once the lease has been reclaimed', async () => {
    // The interleaving, forced rather than raced: window-a acquires, window-b
    // takes the queue over after the staleness threshold, and window-a then tries
    // to commit under the fence it still holds.
    const a = hosts[0]!;
    const b = hosts[1]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    expect((await leaseA.tryAcquire('default')).acquired).toBe(true);
    const staleFence = leaseA.fenceOfRecord('default')!;

    // window-b reclaims: the generation moves on, and window-a's fence is history.
    clock.advance(10 * 60 * 1000);
    const leaseB = new ExecutionLeaseManager(b.store, 'window-b', clock, scheduler);
    expect((await leaseB.tryAcquire('default')).acquired).toBe(true);

    await expect(
      a.store.setRun('default', run('run-1'), {
        resource: queueResource('default'),
        ownerId: 'window-a',
        fence: staleFence
      })
    ).rejects.toThrow(QueueMutationRejected);
  });

  it('names the cause, so the record explains itself', async () => {
    const a = hosts[0]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    await leaseA.tryAcquire('default');
    const staleFence = leaseA.fenceOfRecord('default')!;
    clock.advance(10 * 60 * 1000);
    const leaseB = new ExecutionLeaseManager(hosts[1]!.store, 'window-b', clock, scheduler);
    await leaseB.tryAcquire('default');

    try {
      await a.store.setRun('default', run('run-1'), {
        resource: queueResource('default'),
        ownerId: 'window-a',
        fence: staleFence
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as QueueMutationRejected).reason).toBe('fence-superseded');
    }
  });

  it('writes nothing when it refuses', async () => {
    // FR-R3-001 envelope discipline: a rejected mutation mutates nothing.
    const a = hosts[0]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    await leaseA.tryAcquire('default');
    const heldFence = leaseA.fenceOfRecord('default')!;
    await a.store.setRun('default', run('original'), {
      resource: queueResource('default'),
      ownerId: 'window-a',
      fence: heldFence
    });

    clock.advance(10 * 60 * 1000);
    await new ExecutionLeaseManager(hosts[1]!.store, 'window-b', clock, scheduler)
      .tryAcquire('default');

    await a.store
      .setRun('default', run('overwrite'), {
        resource: queueResource('default'),
        ownerId: 'window-a',
        fence: heldFence
      })
      .catch(() => undefined);
    expect(a.store.getRun('default')?.id).toBe('original');
  });

  it('leaves an unclaimed mutation exactly as it was', async () => {
    // Every existing caller passes no claim, and none of them may change
    // behaviour. The stamp is also absent, so nothing reads as superseded.
    const host = hosts[0]!;
    await host.store.setRun('default', run('unclaimed'));
    const stored = host.store.getRun('default');
    expect(stored?.id).toBe('unclaimed');
    expect(stored?.writtenAtFence).toBeUndefined();
  });
});

describe('a stamped record lets a reader disbelieve a superseded write', () => {
  it('reports a record stamped below the live generation as superseded', () => {
    expect(isSupersededRun({ ...run('r'), writtenAtFence: 3 }, 4)).toBe(true);
  });

  it('does not report a record at the live generation', () => {
    expect(isSupersededRun({ ...run('r'), writtenAtFence: 4 }, 4)).toBe(false);
  });

  it('treats an unstamped record as NOT superseded', () => {
    // Deliberate. Records predating the field, and every write made without a
    // claim, carry no generation to compare; reading "no stamp" as guilt would
    // reject the entire existing corpus.
    expect(isSupersededRun(run('r'), 99)).toBe(false);
  });
});
