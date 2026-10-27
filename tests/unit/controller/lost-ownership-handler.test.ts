// FR-R4-F01 (spec 239, US1, T009a, FR-003, FR-004, contract C5 G15, decision TA3)
// — what the controller does when this window loses ONE queue's claim.
//
// The handler lives outside `workflow-controller.ts` (1,012 lines against a
// 1,040-line budget), so it can be driven with doubles: an injected
// `cancelActive`, a fake logger, and the set the drain path reads. It must act on
// the queue it is told about and on no other, and it must never release anything.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleClaimLost } from '../../../src/controller/lost-ownership-handler';
import { ExecutionLeaseManager, type ExecutionLease } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';
import { OwnershipRegistry } from '../../../src/state/ownership-registry';
import {
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR,
  SharedOwnershipFs
} from '../../fixtures/state/ownership-harness';

const OWNER_ID = 'window-a-owner-id';

function setup() {
  const cancelActive = vi.fn();
  const warn = vi.fn();
  const lostQueueIds = new Set<string>();
  const deps = { cancelActive, logger: { warn }, lostQueueIds };
  return { cancelActive, warn, lostQueueIds, deps };
}

describe('handleClaimLost (C5 G15)', () => {
  it('cancels the active runner of the lost queue once, and no other queue', () => {
    const { deps, cancelActive } = setup();

    handleClaimLost(deps, 'Q', 'rejected');

    expect(cancelActive).toHaveBeenCalledTimes(1);
    expect(cancelActive).toHaveBeenCalledWith('Q');
  });

  it('logs one metadata-only notice carrying the queue id and the reason', () => {
    const { deps, warn } = setup();

    handleClaimLost(deps, 'Q', 'superseded');

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toEqual({ queueId: 'Q', reason: 'superseded' });
    expect(message).not.toContain(OWNER_ID);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\/|\\|window-/);
  });

  it('records the queue, and only the queue, in the set the drain path reads', () => {
    const { deps, lostQueueIds } = setup();
    lostQueueIds.add('earlier');

    handleClaimLost(deps, 'Q', 'rejected');

    expect([...lostQueueIds].sort()).toEqual(['Q', 'earlier']);
  });

  it('records the loss before it cancels, so a throwing cancel cannot hide it', () => {
    const { deps, cancelActive, warn, lostQueueIds } = setup();
    cancelActive.mockImplementation(() => {
      throw new Error('runner already gone');
    });

    expect(() => handleClaimLost(deps, 'Q', 'rejected')).not.toThrow();

    expect(lostQueueIds.has('Q')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('is idempotent for a repeated loss of the same queue', () => {
    const { deps, lostQueueIds } = setup();

    handleClaimLost(deps, 'Q', 'rejected');
    handleClaimLost(deps, 'Q', 'rejected');

    expect([...lostQueueIds]).toEqual(['Q']);
  });
});

describe('subscribed to a real lease manager (FR-004, hard rule 4)', () => {
  class Store {
    private leases: Record<string, ExecutionLease> = {};
    public readonly ownership: OwnershipRegistry;
    constructor(fs: SharedOwnershipFs) {
      this.ownership = new OwnershipRegistry(fs, OWNERSHIP_DIR);
    }
    getExecutionLeases(): Record<string, ExecutionLease> {
      return this.leases;
    }
    async setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void> {
      const next = { ...this.leases };
      if (lease === null) delete next[queueId];
      else next[queueId] = lease;
      this.leases = next;
    }
  }

  let clock: ManualClock;
  let a: ExecutionLeaseManager;
  let b: ExecutionLeaseManager;

  beforeEach(() => {
    const store = new Store(new SharedOwnershipFs());
    clock = new ManualClock();
    const scheduler = new ManualScheduler();
    a = new ExecutionLeaseManager(store, 'window-a', clock, scheduler);
    b = new ExecutionLeaseManager(store, 'window-b', clock, scheduler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a loss of one queue cancels that queue only and releases nothing', async () => {
    const { deps, cancelActive, lostQueueIds } = setup();
    const release = vi.spyOn(a, 'release');
    const releaseAll = vi.spyOn(a, 'releaseAll');
    a.onClaimLost((queueId, reason) => handleClaimLost(deps, queueId, reason));
    await a.tryAcquire('docs');
    await a.tryAcquire('Q');
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    await b.tryAcquire('Q');

    await a.heartbeat();

    expect(cancelActive).toHaveBeenCalledTimes(1);
    expect(cancelActive).toHaveBeenCalledWith('Q');
    expect([...lostQueueIds]).toEqual(['Q']);
    expect(release).not.toHaveBeenCalled();
    expect(releaseAll).not.toHaveBeenCalled();
    expect(a.tenureOf('docs').state).toBe('held');
  });
});
