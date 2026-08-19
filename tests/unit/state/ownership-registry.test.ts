// Feature FR-R3-003 — the fenced ownership registry's own contract.
//
// `lock-cas.test.ts` and `execution-lease-cas.test.ts` cover the two managers
// built on it; this file covers the primitive, including the cases neither
// manager can reach on its own: an aborted generation left by a winner that
// died mid-create, and a storage layer that cannot answer.

import { describe, expect, it } from 'vitest';
import { createMementoOwnershipFs, type OwnershipFs } from '../../../src/state/ownership-fs';
import {
  OwnershipRegistry,
  PRIMACY_RESOURCE,
  queueResource
} from '../../../src/state/ownership-registry';

class FakeMemento {
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

const DIR = '/ws/.schegent/ownership';
const STALENESS = 15_000;
const T0 = 1_000_000;

function registry(): { registry: OwnershipRegistry; fs: OwnershipFs } {
  const fs = createMementoOwnershipFs(new FakeMemento());
  return { registry: new OwnershipRegistry(fs, DIR), fs };
}

/** Two registries over one storage: the two-extension-host shape. */
function pair(): { a: OwnershipRegistry; b: OwnershipRegistry; fs: OwnershipFs } {
  const fs = createMementoOwnershipFs(new FakeMemento());
  return { a: new OwnershipRegistry(fs, DIR), b: new OwnershipRegistry(fs, DIR), fs };
}

describe('OwnershipRegistry', () => {
  it('issues fence 1 to the first acquisition', async () => {
    const { registry: reg } = registry();
    const result = await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    expect(result).toEqual({ outcome: 'acquired', fence: 1, acquiredAt: T0 });
  });

  it('elects exactly one winner when two owners contend from empty', async () => {
    const { a, b } = pair();
    const [first, second] = await Promise.all([
      a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS),
      b.acquire(PRIMACY_RESOURCE, 'window-b', T0, STALENESS)
    ]);
    const acquired = [first, second].filter((r) => r.outcome === 'acquired');
    const held = [first, second].filter((r) => r.outcome === 'held');
    expect(acquired).toHaveLength(1);
    expect(held).toHaveLength(1);
    const winner = acquired[0] as { outcome: 'acquired'; fence: number };
    // The refusal reports the *winner's* owner id, which is what the primacy
    // gate shows the operator.
    const refusal = held[0] as { outcome: 'held'; ownerId: string };
    expect(winner.fence).toBe(1);
    expect(['window-a', 'window-b']).toContain(refusal.ownerId);
    const record = await a.read(PRIMACY_RESOURCE);
    expect(record?.holder?.ownerId).toBe(refusal.ownerId);
  });

  it('keeps the fence and acquiredAt when the same owner re-acquires', async () => {
    const { registry: reg } = registry();
    const first = await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    const again = await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0 + 4_000, STALENESS);
    expect(again).toEqual({ outcome: 'acquired', fence: 1, acquiredAt: T0 });
    expect(first).toEqual({ outcome: 'acquired', fence: 1, acquiredAt: T0 });
    const record = await reg.read(PRIMACY_RESOURCE);
    expect(record?.holder?.heartbeatAt).toBe(T0 + 4_000);
  });

  it('refuses a live foreign holder', async () => {
    const { a, b } = pair();
    await a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    const result = await b.acquire(PRIMACY_RESOURCE, 'window-b', T0 + STALENESS, STALENESS);
    expect(result).toEqual({ outcome: 'held', ownerId: 'window-a' });
  });

  it('reclaims a stale foreign holder at the next generation', async () => {
    const { a, b } = pair();
    await a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    const result = await b.acquire(PRIMACY_RESOURCE, 'window-b', T0 + STALENESS + 1, STALENESS);
    expect(result).toEqual({
      outcome: 'acquired',
      fence: 2,
      acquiredAt: T0 + STALENESS + 1
    });
  });

  it('keeps tokens strictly increasing across release and re-acquire', async () => {
    const { a, b } = pair();
    const first = await a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    expect(first.outcome === 'acquired' && first.fence).toBe(1);
    await a.release(PRIMACY_RESOURCE, 'window-a', 1);
    const second = await b.acquire(PRIMACY_RESOURCE, 'window-b', T0 + 1, STALENESS);
    expect(second.outcome === 'acquired' && second.fence).toBe(2);
    await b.release(PRIMACY_RESOURCE, 'window-b', 2);
    const third = await a.acquire(PRIMACY_RESOURCE, 'window-a', T0 + 2, STALENESS);
    expect(third.outcome === 'acquired' && third.fence).toBe(3);
  });

  it('gives each resource its own counter', async () => {
    const { registry: reg } = registry();
    await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    await reg.release(PRIMACY_RESOURCE, 'window-a', 1);
    const primacy = await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0 + 1, STALENESS);
    const queueB = await reg.acquire(queueResource('queue-b'), 'window-a', T0 + 1, STALENESS);
    const queueC = await reg.acquire(queueResource('queue-c'), 'window-a', T0 + 1, STALENESS);
    expect(primacy.outcome === 'acquired' && primacy.fence).toBe(2);
    expect(queueB.outcome === 'acquired' && queueB.fence).toBe(1);
    expect(queueC.outcome === 'acquired' && queueC.fence).toBe(1);
  });

  it('rejects a revived holder whose generation was superseded', async () => {
    const { a, b } = pair();
    const mine = await a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    expect(mine.outcome).toBe('acquired');
    await b.acquire(PRIMACY_RESOURCE, 'window-b', T0 + STALENESS + 1, STALENESS);
    const verdict = await a.verify(PRIMACY_RESOURCE, 'window-a', 1);
    expect(verdict).toEqual({
      outcome: 'rejected',
      reason: 'stale-fence',
      currentFence: 2,
      ownerOfRecord: 'window-b'
    });
  });

  it('rejects a heartbeat and a release from a superseded generation', async () => {
    const { a, b } = pair();
    await a.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    await b.acquire(PRIMACY_RESOURCE, 'window-b', T0 + STALENESS + 1, STALENESS);
    const beat = await a.heartbeat(PRIMACY_RESOURCE, 'window-a', 1, T0 + STALENESS + 2);
    const gave = await a.release(PRIMACY_RESOURCE, 'window-a', 1);
    expect(beat.outcome).toBe('rejected');
    expect(gave.outcome).toBe('rejected');
    // The revived holder's release did not strip the live holder's claim.
    const record = await b.read(PRIMACY_RESOURCE);
    expect(record?.holder?.ownerId).toBe('window-b');
  });

  it('reports not-holder when the generation is current but unheld', async () => {
    const { registry: reg } = registry();
    await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    await reg.release(PRIMACY_RESOURCE, 'window-a', 1);
    const verdict = await reg.verify(PRIMACY_RESOURCE, 'window-a', 1);
    expect(verdict).toEqual({
      outcome: 'rejected',
      reason: 'not-holder',
      currentFence: 1,
      ownerOfRecord: null
    });
  });

  it('skips a generation whose winner died before writing its body', async () => {
    const memento = new FakeMemento();
    const fs = createMementoOwnershipFs(memento);
    const reg = new OwnershipRegistry(fs, DIR);
    await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS);
    // Generation 2 exists and is empty: a rival won the create and then died.
    const names = await fs.list(DIR);
    const generationOne = names.find((n) => n.endsWith('g000000001.json'))!;
    const generationTwo = generationOne.replace('g000000001', 'g000000002');
    await fs.createExclusive(`${DIR}/${generationTwo}`, '');
    // The live record is still generation 1, so window-a still verifies.
    expect(await reg.verify(PRIMACY_RESOURCE, 'window-a', 1)).toEqual({
      outcome: 'valid',
      fence: 1
    });
    // And a reclaim skips the aborted generation rather than wedging on it.
    const reclaim = await reg.acquire(
      PRIMACY_RESOURCE,
      'window-b',
      T0 + STALENESS + 1,
      STALENESS
    );
    expect(reclaim.outcome === 'acquired' && reclaim.fence).toBe(3);
  });

  it('refuses to acquire when the storage cannot answer', async () => {
    const failing: OwnershipFs = {
      ensureDir: async () => undefined,
      list: async () => {
        throw new Error('disk offline');
      },
      read: async () => null,
      createExclusive: async () => undefined,
      replace: async () => undefined,
      remove: async () => undefined
    };
    const reg = new OwnershipRegistry(failing, DIR);
    expect(await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS)).toEqual({
      outcome: 'unavailable',
      reason: 'io-error'
    });
    expect(await reg.verify(PRIMACY_RESOURCE, 'window-a', 1)).toEqual({
      outcome: 'unavailable'
    });
    expect(await reg.heartbeat(PRIMACY_RESOURCE, 'window-a', 1, T0)).toEqual({
      outcome: 'unavailable'
    });
  });

  it('refuses rather than spins when it loses every generation race', async () => {
    // Storage that reports the resource as free but claims every create is
    // already taken: the shape of losing eight rounds in a row.
    const alwaysTaken: OwnershipFs = {
      ensureDir: async () => undefined,
      list: async () => [],
      read: async () => null,
      createExclusive: async () => {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      },
      replace: async () => undefined,
      remove: async () => undefined
    };
    const reg = new OwnershipRegistry(alwaysTaken, DIR);
    expect(await reg.acquire(PRIMACY_RESOURCE, 'window-a', T0, STALENESS)).toEqual({
      outcome: 'unavailable',
      reason: 'contended'
    });
  });

  it('keeps an operator-supplied queue id out of the path it writes', async () => {
    const fs = createMementoOwnershipFs(new FakeMemento());
    const reg = new OwnershipRegistry(fs, DIR);
    const hostile = queueResource('../../etc/passwd');
    expect(await reg.acquire(hostile, 'window-a', T0, STALENESS)).toEqual({
      outcome: 'acquired',
      fence: 1,
      acquiredAt: T0
    });
    const names = await fs.list(DIR);
    expect(names).toHaveLength(1);
    // A flat basename inside the ownership directory: no separator of either
    // kind, and no parent reference. The readable slug may keep letters from
    // the id; what it may not keep is anything that navigates.
    expect(names[0]).not.toContain('/');
    expect(names[0]).not.toContain('\\');
    expect(names[0]).not.toContain('..');
    // Two ids that reduce to the same readable slug still address different
    // files, because the digest is taken over the raw resource.
    const sibling = queueResource('..\\..\\etc\\passwd');
    await reg.acquire(sibling, 'window-a', T0, STALENESS);
    expect(await fs.list(DIR)).toHaveLength(2);
  });
});
