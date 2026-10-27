// FR-R4-F01 (spec 239, US5, T041, FR-024, SC-008, decision D5, research R7) — the ownership
// timing probes P1 to P5.
//
// **This file is a SIMULATED filesystem. It is never cross-process proof (D5).** The `ProbeFs`
// below is an in-memory `OwnershipFs` whose interleavings the test chooses, so each probe is a
// deterministic reading of what the code does at ONE chosen interleaving. It says nothing about
// two OS processes on a real mount; Q1 to Q3 in `docs/operations/platform-observation-record.md`
// are the procedures that would, and they are `Unrun here`.
//
// The probes come FIRST and the fixes after (FR-024, contract C6 G16): this file is run, and its
// observations recorded in `measurements.md`, before `lock.ts` tick scheduling, `ownership-fs.ts`
// publication or temp cleanup changes. Each probe asserts the SC-008 invariant for its scenario
// (no two current owners; no duplicate primacy-gain or loss notice for one transition) and
// prints one `PROBE <id> {...}` line with what the table in research R7 says it records.

import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager, type ExecutionLease } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { alreadyExistsError, type OwnershipFs } from '../../../src/state/ownership-fs';
import { PRIMACY_RESOURCE, queueResource } from '../../../src/state/ownership-registry';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import {
  FakeMemento,
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR
} from '../../fixtures/state/ownership-harness';

/** An in-memory `OwnershipFs` with the three interleavings the probes need: park, tear, park. */
class ProbeFs implements OwnershipFs {
  public readonly files = new Map<string, string>();
  /** Runs once, after a creator has listed and before it creates (P1). */
  public beforeCreate: ((file: string) => Promise<void>) | null = null;
  /** The next create exposes an EMPTY file and writes its body only when this opens (P5). */
  public tearNextCreate: Promise<void> | null = null;
  /** The next `replace` waits for this before it writes (P2). */
  public parkNextReplace: Promise<void> | null = null;
  public replaceCalls: string[] = [];

  async ensureDir(): Promise<void> {}

  async list(dir: string): Promise<readonly string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map((file) => file.slice(prefix.length));
  }

  async read(file: string): Promise<string | null> {
    return this.files.get(file) ?? null;
  }

  async createExclusive(file: string, data: string): Promise<void> {
    const hook = this.beforeCreate;
    if (hook !== null) {
      this.beforeCreate = null;
      await hook(file);
    }
    if (this.files.has(file)) throw alreadyExistsError(file);
    const gate = this.tearNextCreate;
    if (gate !== null) {
      this.tearNextCreate = null;
      this.files.set(file, '');
      await gate;
    }
    this.files.set(file, data);
  }

  async replace(file: string, data: string): Promise<void> {
    this.replaceCalls.push(file);
    const gate = this.parkNextReplace;
    if (gate !== null) {
      this.parkNextReplace = null;
      await gate;
    }
    this.files.set(file, data);
  }

  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }
}

/** A gate the test opens by hand. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const flush = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** A record lookup can miss; `getExecutionLeases()` types its index as present. */
const mirrorOwnerOf = (queueId: string): string | null =>
  (storeA.getExecutionLeases() as Record<string, ExecutionLease | undefined>)[queueId]?.ownerId ??
  null;

const observe = (probe: string, observation: Record<string, unknown>): void => {
  console.log(`PROBE ${probe} ${JSON.stringify(observation)}`);
};

let fs: ProbeFs;
let clock: ManualClock;
let storeA: WorkspaceStateStore;
let storeB: WorkspaceStateStore;
let schedulerA: ManualScheduler;
let schedulerB: ManualScheduler;

async function host(): Promise<WorkspaceStateStore> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  store.useOwnershipStorage(fs, OWNERSHIP_DIR);
  return store;
}

beforeEach(async () => {
  fs = new ProbeFs();
  clock = new ManualClock();
  schedulerA = new ManualScheduler();
  schedulerB = new ManualScheduler();
  storeA = await host();
  storeB = await host();
});

describe('P1 — two primacy ticks overlap, the first parked inside acquire', () => {
  it('produces one primacy-gain notice for one transition', async () => {
    const a = new WorkspaceLockManager(storeA, 'window-a', clock, schedulerA);
    const b = new WorkspaceLockManager(storeB, 'window-b', clock, schedulerB);
    expect((await a.tryAcquire()).acquired).toBe(true);
    // B asks once at activation, loses correctly, and arms its own contest interval.
    expect((await b.tryAcquire()).acquired).toBe(false);
    let notices = 0;
    b.onPrimacyGained(() => {
      notices += 1;
    });
    // A "dies": no further beats. Its lease reads fresh until the threshold passes.
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    const parked = gate();
    fs.beforeCreate = async () => {
      await parked.wait;
    };
    const interval = schedulerB.intervals[0]!.fn;
    interval(); // tick 1: lists generation 1, finds A stale, parks before creating generation 2
    await flush();
    interval(); // tick 2, while tick 1 is still in flight: creates generation 2 and wins
    await flush();
    parked.open();
    await flush(16);

    const record = await storeB.ownership.read(PRIMACY_RESOURCE);
    observe('P1', {
      gainNotices: notices,
      holder: record?.holder?.ownerId,
      fence: record?.fence,
      replaceCallsAfterContest: fs.replaceCalls.length
    });
    // One window, one transition (not primary -> primary): one notice, and one current owner.
    expect(record?.holder?.ownerId).toBe('window-b');
    expect(notices, 'a duplicate primacy-gain notice for one transition (SC-008)').toBe(1);
    expect(await a.hasPrimacy()).toBe(false);
    expect(await b.hasPrimacy()).toBe(true);
  });
});

describe('P2 — two execution-lease beats overlap', () => {
  it('leaves a released queue released, with a single holder throughout', async () => {
    const a = new ExecutionLeaseManager(storeA, 'window-a', clock, schedulerA);
    expect((await a.tryAcquire('q')).acquired).toBe(true);
    const beat = schedulerA.intervals[0]!.fn;
    const writesBefore = fs.replaceCalls.length;

    const parked = gate();
    fs.parkNextReplace = parked.wait;
    beat(); // beat 1: valid, parks inside its registry write
    await flush();
    beat(); // beat 2, while beat 1 is parked: writes through
    await flush();
    // The queue is given back while beat 1 is still parked. `release` settles an in-flight beat
    // before it releases, so it waits for beat 1: the storage call it shares is let go below.
    const released = a.release('q');
    await flush();
    const holderAtRelease = (await storeA.ownership.read(queueResource('q')))?.holder?.ownerId;
    parked.open();
    await released;
    await flush(16);

    const record = await storeA.ownership.read(queueResource('q'));
    observe('P2', {
      registryWritesDuringOverlap: fs.replaceCalls.length - writesBefore,
      holderWhileReleasePending: holderAtRelease ?? null,
      holderAfterSettle: record?.holder?.ownerId ?? null,
      mirrorHolder: mirrorOwnerOf('q'),
      tenure: a.tenureOf('q').state
    });
    expect(record?.holder?.ownerId, 'a released queue is not resurrected by an older beat').toBeUndefined();
    expect(storeA.getExecutionLeases()['q']).toBeUndefined();
    expect(a.tenureOf('q').state).toBe('released');
  });
});

describe('P3 and P4 — suspend and wake', () => {
  async function twoWindows() {
    const lockA = new WorkspaceLockManager(storeA, 'window-a', clock, schedulerA);
    const lockB = new WorkspaceLockManager(storeB, 'window-b', clock, schedulerB);
    const leaseA = new ExecutionLeaseManager(storeA, 'window-a', clock, schedulerA);
    const leaseB = new ExecutionLeaseManager(storeB, 'window-b', clock, schedulerB);
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    expect((await leaseA.tryAcquire('q')).acquired).toBe(true);
    expect((await lockB.tryAcquire()).acquired).toBe(false);
    let gained = 0;
    let lost = 0;
    lockB.onPrimacyGained(() => {
      gained += 1;
    });
    lockA.onFenceLost(() => {
      lost += 1;
    });
    // Both hosts sleep through more than the staleness threshold: no timer ran on either.
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const valid = async () => ({
      primacy: [await lockA.hasPrimacy(), await lockB.hasPrimacy()],
      queue: [await leaseA.hasLease('q'), await leaseB.hasLease('q')]
    });
    return { lockA, lockB, leaseA, leaseB, valid, counts: () => ({ gained, lost }) };
  }

  const atMostOne = (flags: readonly boolean[]): boolean => flags.filter(Boolean).length <= 1;

  it('P3: the holder wakes first and keeps both claims; the rival stays out', async () => {
    const { lockA, lockB, valid, counts } = await twoWindows();
    const steps: unknown[] = [await valid()];

    await lockA.tick(); // the holder's beat finds its own record, still the current generation
    steps.push(await valid());
    await lockB.tick(); // the rival's contest finds a fresh heartbeat
    steps.push(await valid());

    observe('P3', { steps, ...counts() });
    for (const step of steps as Array<Awaited<ReturnType<typeof valid>>>) {
      expect(atMostOne(step.primacy) && atMostOne(step.queue), JSON.stringify(step)).toBe(true);
    }
    const last = steps[steps.length - 1] as Awaited<ReturnType<typeof valid>>;
    expect(last.primacy).toEqual([true, false]);
    expect(counts()).toEqual({ gained: 0, lost: 0 });
  });

  it('P4: the rival wakes first and takes over; the old holder then learns it lost, once', async () => {
    const { lockA, lockB, valid, counts } = await twoWindows();
    const steps: unknown[] = [await valid()];

    await lockB.tick(); // the rival reclaims the stale generation
    steps.push(await valid());
    await lockA.tick(); // the old holder's beat is rejected and its re-acquisition refused
    steps.push(await valid());

    observe('P4', { steps, ...counts() });
    for (const step of steps as Array<Awaited<ReturnType<typeof valid>>>) {
      expect(atMostOne(step.primacy), JSON.stringify(step)).toBe(true);
    }
    const last = steps[steps.length - 1] as Awaited<ReturnType<typeof valid>>;
    expect(last.primacy).toEqual([false, true]);
    expect(counts(), 'one gain and one loss for one transition (SC-008)').toEqual({
      gained: 1,
      lost: 1
    });
  });
});

describe('P5 — generation N+1 created, its body not yet written', () => {
  it('never has the old holder and the new creator both current', async () => {
    const lockA = new WorkspaceLockManager(storeA, 'window-a', clock, schedulerA);
    const lockB = new WorkspaceLockManager(storeB, 'window-b', clock, schedulerB);
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    const torn = gate();
    fs.tearNextCreate = torn.wait;
    const acquiring = lockB.tryAcquire(); // creates generation 2 empty, parks before writing the body
    await flush();
    const during = [await lockA.hasPrimacy(), await lockB.hasPrimacy()];
    torn.open();
    await acquiring;
    await flush();
    const after = [await lockA.hasPrimacy(), await lockB.hasPrimacy()];

    observe('P5', { during, after });
    expect(during.filter(Boolean).length, 'while the body is missing').toBeLessThanOrEqual(1);
    expect(after.filter(Boolean).length, 'once the body lands').toBe(1);
    expect(after).toEqual([false, true]);
  });
});
