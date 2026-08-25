// Feature FR-R3-003 (T306) — two extension hosts, one workspace, real storage.
//
// The unit suites (T303–T305) drive the race deterministically through an
// in-memory `OwnershipFs` whose interleaving is injected. That proves the
// mechanism's logic and deliberately does not exercise the one platform property
// the whole design rests on: that `open(2)` with `O_CREAT|O_EXCL` — Node's
// `writeFile` with flag `'wx'` — either creates the file or fails `EEXIST`, and
// cannot do both. This file runs the election against a real directory so that
// property is genuinely under test.
//
// Two hosts are two `WorkspaceStateStore` instances over **separate mementos**,
// both pointed at one `.schegent/ownership` directory through the same
// `useOwnershipStorage()` seam activation uses. Separate mementos are the point:
// a `Memento` is a per-extension-host cache, so the shared directory is the only
// thing both hosts can see, and a test that shared a memento would let a mirror
// write stand in for arbitration.
//
// What this file still cannot do is run two OS processes — vitest workers are one
// process, and the promises below interleave on one event loop's IO callbacks.
// That is a weaker interleaving than two hosts on two cores, and it is why the
// mechanism is designed so the *filesystem* decides rather than the scheduler:
// `createExclusive` is the only step that has to be atomic, and it is atomic in
// the kernel.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import {
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  WorkspaceLockManager
} from '../../../src/state/lock';
import { createDiskOwnershipFs } from '../../../src/state/ownership-fs';
import { PRIMACY_RESOURCE, queueResource } from '../../../src/state/ownership-registry';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import {
  FakeMemento,
  ManualClock,
  ManualScheduler
} from '../../fixtures/state/ownership-harness';

let workspaceRoot: string;
let ownershipDir: string;
let clock: ManualClock;
let scheduler: ManualScheduler;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-ownership-election-'));
  ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** One host: its own memento, the shared ownership directory. */
async function host(): Promise<WorkspaceStateStore> {
  const memento: Memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
  return store;
}

async function hosts(count: number): Promise<readonly WorkspaceStateStore[]> {
  const stores: WorkspaceStateStore[] = [];
  for (let index = 0; index < count; index += 1) stores.push(await host());
  return stores;
}

describe('two hosts electing one owner over real storage (T306)', () => {
  it('elects exactly one primary from a simultaneous activation', async () => {
    const [a, b] = await hosts(2);
    const managers = [
      new WorkspaceLockManager(a!, 'window-a', clock, scheduler),
      new WorkspaceLockManager(b!, 'window-b', clock, scheduler)
    ];

    // No injected interleaving: both acquisitions are in flight at once and the
    // filesystem decides.
    const results = await Promise.all(managers.map((manager) => manager.tryAcquire()));
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired)!.ownerId;
    expect(results.find((result) => !result.acquired)!.ownerId).toBe(winner);

    // And the record on disk agrees with whichever manager believes it won.
    const record = await a!.ownership.read(PRIMACY_RESOURCE);
    expect(record?.holder?.ownerId).toBe(winner);
    const holder = managers.find((manager) => manager.id === winner)!;
    expect(await holder.hasPrimacy()).toBe(true);
    const loser = managers.find((manager) => manager.id !== winner)!;
    expect(await loser.hasPrimacy()).toBe(false);
  });

  it('elects exactly one primary from eight contenders', async () => {
    // Eight is past `MAX_ACQUIRE_ATTEMPTS`, so some contenders exhaust their
    // budget and report `unavailable`. Every one of those must still read as a
    // refusal — an exhausted retry budget that resolved to a success would be the
    // fail-open the whole design forbids.
    const stores = await hosts(8);
    const managers = stores.map(
      (store, index) => new WorkspaceLockManager(store, `window-${index}`, clock, scheduler)
    );
    const results = await Promise.all(managers.map((manager) => manager.tryAcquire()));
    expect(results.filter((result) => result.acquired)).toHaveLength(1);

    const held = await Promise.all(managers.map((manager) => manager.hasPrimacy()));
    expect(held.filter(Boolean)).toHaveLength(1);
  });

  it('elects one owner per queue and still lets two hosts drain different queues', async () => {
    const [a, b] = await hosts(2);
    const leaseA = new ExecutionLeaseManager(a!, 'window-a', clock, scheduler);
    const leaseB = new ExecutionLeaseManager(b!, 'window-b', clock, scheduler);

    const contested = await Promise.all([
      leaseA.tryAcquire('queue-shared'),
      leaseB.tryAcquire('queue-shared')
    ]);
    expect(contested.filter((result) => result.acquired)).toHaveLength(1);

    // Different queues are not a contest: that is the cardinality difference
    // between this lease and primacy.
    const separate = await Promise.all([
      leaseA.tryAcquire('queue-a-only'),
      leaseB.tryAcquire('queue-b-only')
    ]);
    expect(separate.every((result) => result.acquired)).toBe(true);
    expect(await leaseA.hasLease('queue-a-only')).toBe(true);
    expect(await leaseB.hasLease('queue-b-only')).toBe(true);
  });

  it('reclaims both leases from a host that died holding them', async () => {
    // Crash recovery is unchanged by fencing, and this is the assertion that says
    // so: the dead host never releases anything, and 15 s later everything it held
    // is claimable.
    const [dead, alive] = await hosts(2);
    const deadLock = new WorkspaceLockManager(dead!, 'window-dead', clock, scheduler);
    const deadLease = new ExecutionLeaseManager(dead!, 'window-dead', clock, scheduler);
    await deadLock.tryAcquire();
    await deadLease.tryAcquire('queue-b');

    clock.advance(STALENESS_THRESHOLD_MS + 1);

    const aliveLock = new WorkspaceLockManager(alive!, 'window-alive', clock, scheduler);
    const aliveLease = new ExecutionLeaseManager(alive!, 'window-alive', clock, scheduler);
    expect((await aliveLock.tryAcquire()).acquired).toBe(true);
    expect((await aliveLease.tryAcquire('queue-b')).acquired).toBe(true);
    // Second generation for both, so the dead host's tokens are worthless if its
    // process ever comes back.
    expect(aliveLock.fenceOfRecord()).toBe(2);
    expect(aliveLease.fenceOfRecord('queue-b')).toBe(2);
    expect(await deadLock.hasPrimacy()).toBe(false);
    expect(await deadLease.hasLease('queue-b')).toBe(false);
  });

  it('keeps a live holder from being reclaimed while it beats', async () => {
    const [a, b] = await hosts(2);
    const holder = new WorkspaceLockManager(a!, 'window-a', clock, scheduler);
    await holder.tryAcquire();

    // Four beats at the production cadence carry the holder well past the
    // staleness threshold. Called directly rather than through the scheduler: the
    // armed callback is `() => { void this.heartbeat(); }`, so firing it returns
    // nothing to await, and a rival asserted against a beat still in flight would
    // be a flake. That the interval is armed at 5 s is asserted in the unit suite.
    for (let beat = 0; beat < 4; beat += 1) {
      clock.advance(HEARTBEAT_INTERVAL_MS);
      await holder.heartbeat();
    }
    expect(await holder.hasPrimacy()).toBe(true);
    expect(holder.fenceOfRecord()).toBe(1);

    const rival = new WorkspaceLockManager(b!, 'window-b', clock, scheduler);
    expect(await rival.tryAcquire()).toEqual({ acquired: false, ownerId: 'window-a' });
  });

  it('skips a generation whose winner died before writing its body', async () => {
    const [a] = await hosts(1);
    const manager = new WorkspaceLockManager(a!, 'window-a', clock, scheduler);
    await manager.tryAcquire();
    expect(manager.fenceOfRecord()).toBe(1);
    await manager.release();

    // Stand in for a host that won the create and died: an empty generation-2
    // file, with no body. It must not wedge the resource.
    const names = await fs.readdir(ownershipDir);
    const existing = names.find((name) => name.includes('.g000000001.json'))!;
    const aborted = existing.replace('.g000000001.', '.g000000002.');
    await fs.writeFile(path.join(ownershipDir, aborted), '', 'utf8');

    const next = new WorkspaceLockManager(a!, 'window-a2', clock, scheduler);
    expect((await next.tryAcquire()).acquired).toBe(true);
    expect(next.fenceOfRecord()).toBe(3);
  });

  it('writes records under .schegent/ with owner-only modes and no workspace path', async () => {
    const [a] = await hosts(1);
    const lock = new WorkspaceLockManager(a!, 'window-a', clock, scheduler);
    const lease = new ExecutionLeaseManager(a!, 'window-a', clock, scheduler);
    await lock.tryAcquire();
    await lease.tryAcquire('queue-b');

    const dirStat = await fs.stat(ownershipDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const names = await fs.readdir(ownershipDir);
    expect(names).toHaveLength(2);
    for (const name of names) {
      const file = path.join(ownershipDir, name);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      const raw = await fs.readFile(file, 'utf8');
      // A record carries owner ids and timestamps. Serializing the workspace root
      // into it would put a path where none is needed, in a file whose whole job
      // is to be read by a process that already knows where it is.
      expect(raw).not.toContain(workspaceRoot);
      expect(raw).not.toContain(os.tmpdir());
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
        'fence',
        'holder',
        'resource',
        'version'
      ]);
    }
    // Both resources, one directory, independent counters.
    expect(
      (await a!.ownership.read(PRIMACY_RESOURCE))?.fence
    ).toBe(1);
    expect(
      (await a!.ownership.read(queueResource('queue-b')))?.fence
    ).toBe(1);
  });

  it('refuses to elect anyone when the ownership directory cannot be written', async () => {
    const [a] = await hosts(1);
    // A file where the directory belongs: `mkdir` fails, so every acquisition
    // fails. The operator-visible consequence is that no window becomes primary
    // and work waits — never that two do.
    await fs.mkdir(path.dirname(ownershipDir), { recursive: true });
    await fs.writeFile(ownershipDir, 'not a directory', 'utf8');

    const manager = new WorkspaceLockManager(a!, 'window-a', clock, scheduler);
    const result = await manager.tryAcquire();
    expect(result.acquired).toBe(false);
    expect(await manager.hasPrimacy()).toBe(false);
  });
});
