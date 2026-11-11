// FR-R6-F15 T038 — preparation admission (NFR-003, research R11): two active owners, eight
// queued in arrival order, 8 MiB across the active owners, a two-second deadline from
// activation, and a refusal that takes no slot.
import { describe, expect, it } from 'vitest';

import { createPreparationAdmission, type PreparationAdmission } from '../../../src/services/phase-context/preparation-admission';

const MIB = 1024 * 1024;
const BUDGET = 8 * MIB;
const DEADLINE_MS = 2_000;

interface Harness {
  readonly admission: PreparationAdmission;
  advance(ms: number): void;
}

function setup(start = 1_000): Harness {
  let at = start;
  return {
    admission: createPreparationAdmission({ now: () => at }),
    advance: (ms) => {
      at += ms;
    }
  };
}

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

const ACTIVE = { ok: true, state: 'active' };
const QUEUED = { ok: true, state: 'queued' };

function ownerOf(index: number): string {
  return `owner-${String(index)}`;
}

/** Ten owners of 1 KiB each: two active and a full queue. */
function full(): Harness {
  const harness = setup();
  for (let index = 1; index <= 10; index += 1) harness.admission.request(ownerOf(index), 1_024);
  return harness;
}

describe('a request', () => {
  it('makes the first two owners active and queues the third', () => {
    const { admission } = setup();

    expect(admission.request('owner-1', MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-2', 2 * MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-3', MIB)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 1, workingSetBytes: 3 * MIB });
  });

  it('starts empty', () => {
    expect(setup().admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
  });

  it('refuses the eleventh owner, which then holds no slot', () => {
    const { admission } = full();
    const before = admission.snapshot();

    expect(before).toEqual({ active: 2, queued: 8, workingSetBytes: 2_048 });
    expect(admission.request('owner-11', 1_024)).toEqual(refusal('capacity-exceeded', 'preparation-queue-full'));
    expect(admission.snapshot()).toEqual(before);

    admission.release('owner-11');
    expect(admission.snapshot()).toEqual(before);
    admission.release('owner-1');
    expect(admission.request('owner-11', 1_024)).toEqual(QUEUED);
  });

  it('admits a working set of exactly 8 MiB and refuses one byte more', () => {
    const { admission } = setup();

    expect(admission.request('owner-1', BUDGET + 1)).toEqual(refusal('capacity-exceeded', 'working-set-exceeded'));
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
    expect(admission.request('owner-1', BUDGET)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0, workingSetBytes: BUDGET });
  });

  it('refuses a working set over 8 MiB even when the queue is full', () => {
    const { admission } = full();

    expect(admission.request('owner-11', BUDGET + 1)).toEqual(refusal('capacity-exceeded', 'working-set-exceeded'));
  });

  it('queues an owner whose working set would take the active owners past 8 MiB', () => {
    const { admission } = setup();

    expect(admission.request('owner-1', 5 * MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-2', 3 * MIB + 1)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 1, workingSetBytes: 5 * MIB });
  });

  it('activates a second owner that takes the active owners to exactly 8 MiB', () => {
    const { admission } = setup();

    admission.request('owner-1', 5 * MIB);

    expect(admission.request('owner-2', 3 * MIB)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 0, workingSetBytes: BUDGET });
  });

  it('refuses an owner past the working set when the queue is full', () => {
    const { admission } = setup();
    admission.request('owner-1', BUDGET);
    for (let index = 2; index <= 9; index += 1) expect(admission.request(ownerOf(index), 1)).toEqual(QUEUED);

    expect(admission.request('owner-10', 1)).toEqual(refusal('capacity-exceeded', 'preparation-queue-full'));
    expect(admission.snapshot()).toEqual({ active: 1, queued: 8, workingSetBytes: BUDGET });
  });

  it('admits an owner with no working set', () => {
    const { admission } = setup();

    expect(admission.request('owner-1', 0)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0, workingSetBytes: 0 });
  });

  it('does not let a newcomer pass a queued owner', () => {
    const { admission } = setup();
    admission.request('owner-1', 5 * MIB);
    admission.request('owner-2', 6 * MIB);

    expect(admission.request('owner-3', 1)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 2, workingSetBytes: 5 * MIB });
  });

  it('gives a known owner its state and no second slot', () => {
    const { admission } = setup();
    admission.request('owner-1', MIB);
    admission.request('owner-2', MIB);
    admission.request('owner-3', MIB);
    const before = admission.snapshot();

    expect(admission.request('owner-1', MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-3', MIB)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual(before);
  });

  it('keeps the first working set of a known owner', () => {
    const { admission } = setup();
    admission.request('owner-1', MIB);

    expect(admission.request('owner-1', 7 * MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-1', BUDGET + 1)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0, workingSetBytes: MIB });
  });

  it('gives a known owner its state when the queue is full', () => {
    const { admission } = full();

    expect(admission.request('owner-2', 1_024)).toEqual(ACTIVE);
    expect(admission.request('owner-10', 1_024)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 8, workingSetBytes: 2_048 });
  });

  it.each([
    ['an empty owner key', ''],
    ['an owner key with a space', 'bad key'],
    ['an owner key over 128 characters', 'o'.repeat(129)],
    ['an owner key that is not text', 42 as never]
  ])('refuses %s and takes no slot', (_label, ownerKey: string) => {
    const { admission } = setup();

    expect(admission.request(ownerKey, MIB)).toEqual(refusal('invalid-source', 'owner-key'));
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
  });

  it.each([
    ['a negative working set', -1],
    ['a working set that is not a whole number', 1.5],
    ['a working set that is not a number', Number.NaN],
    ['an unbounded working set', Number.POSITIVE_INFINITY],
    ['a working set given as text', '5' as never]
  ])('refuses %s and takes no slot', (_label, workingSetBytes: number) => {
    const { admission } = setup();

    expect(admission.request('owner-1', workingSetBytes)).toEqual(refusal('invalid-source', 'working-set'));
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
  });

  it('checks the owner key before the working set', () => {
    expect(setup().admission.request('bad key', -1)).toEqual(refusal('invalid-source', 'owner-key'));
  });
});

describe('a release', () => {
  it('activates the oldest queued owner', () => {
    const { admission } = setup();
    for (let index = 1; index <= 4; index += 1) admission.request(ownerOf(index), MIB);

    admission.release('owner-1');

    expect(admission.request('owner-3', MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-4', MIB)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 1, workingSetBytes: 2 * MIB });
  });

  it('keeps arrival order: a queued owner that does not fit holds back the ones behind it', () => {
    const { admission } = setup();
    admission.request('a', 5 * MIB);
    admission.request('b', MIB);
    admission.request('c', 6 * MIB);
    admission.request('d', MIB);

    admission.release('b');

    expect(admission.request('c', 0)).toEqual(QUEUED);
    expect(admission.request('d', 0)).toEqual(QUEUED);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 2, workingSetBytes: 5 * MIB });

    admission.release('a');

    expect(admission.request('c', 0)).toEqual(ACTIVE);
    expect(admission.request('d', 0)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 0, workingSetBytes: 7 * MIB });
  });

  it('removes a queued owner without activating anyone', () => {
    const { admission } = setup();
    for (let index = 1; index <= 4; index += 1) admission.request(ownerOf(index), MIB);

    admission.release('owner-3');

    expect(admission.snapshot()).toEqual({ active: 2, queued: 1, workingSetBytes: 2 * MIB });
    expect(admission.request('owner-4', MIB)).toEqual(QUEUED);
    admission.release('owner-2');
    expect(admission.request('owner-4', MIB)).toEqual(ACTIVE);
  });

  it('lets the owners behind a released queue head move up', () => {
    const { admission } = setup();
    admission.request('a', 5 * MIB);
    admission.request('b', 6 * MIB);
    admission.request('c', MIB);

    admission.release('b');

    expect(admission.request('c', 0)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 2, queued: 0, workingSetBytes: 6 * MIB });
  });

  it.each([
    ['an owner it never saw', 'owner-9'],
    ['an owner key that is not an identifier', 'bad key'],
    ['an owner key that is not text', 42 as never]
  ])('does nothing for %s', (_label, ownerKey: string) => {
    const { admission } = setup();
    admission.request('owner-1', MIB);
    admission.request('owner-2', MIB);
    admission.request('owner-3', MIB);
    const before = admission.snapshot();

    admission.release(ownerKey);

    expect(admission.snapshot()).toEqual(before);
  });

  it('frees the name: a released owner asks again as a newcomer', () => {
    const { admission } = setup();
    for (let index = 1; index <= 3; index += 1) admission.request(ownerOf(index), MIB);

    admission.release('owner-1');

    expect(admission.request('owner-1', MIB)).toEqual(QUEUED);
    admission.release('owner-1');
    admission.release('owner-1');
    expect(admission.snapshot()).toEqual({ active: 2, queued: 0, workingSetBytes: 2 * MIB });
  });
});

describe('expire', () => {
  it('leaves an owner active for exactly 2,000 ms and ends it one millisecond later', () => {
    const { admission, advance } = setup();
    admission.request('owner-1', MIB);

    advance(DEADLINE_MS);
    expect(admission.expire()).toEqual([]);
    expect(admission.request('owner-1', MIB)).toEqual(ACTIVE);

    advance(1);
    expect(admission.expire()).toEqual(['owner-1']);
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
    expect(admission.expire()).toEqual([]);
  });

  it('returns the ended owners in the order they became active', () => {
    const { admission, advance } = setup();
    admission.request('second', MIB);
    advance(10);
    admission.request('first', MIB);
    advance(10);
    admission.request('third', MIB);
    admission.release('second');
    admission.request('second', MIB);

    advance(DEADLINE_MS + 1);

    expect(admission.expire()).toEqual(['first', 'third']);
  });

  it('ends only the owners past the deadline', () => {
    const { admission, advance } = setup();
    admission.request('early', MIB);
    advance(1_500);
    admission.request('late', MIB);

    advance(501);

    expect(admission.expire()).toEqual(['early']);
    expect(admission.request('late', MIB)).toEqual(ACTIVE);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0, workingSetBytes: MIB });
  });

  it('frees the slots of ended owners for the queue, with a deadline from that moment', () => {
    const { admission, advance } = setup();
    for (let index = 1; index <= 4; index += 1) admission.request(ownerOf(index), MIB);

    advance(DEADLINE_MS + 1);
    expect(admission.expire()).toEqual(['owner-1', 'owner-2']);
    expect(admission.request('owner-3', MIB)).toEqual(ACTIVE);
    expect(admission.request('owner-4', MIB)).toEqual(ACTIVE);

    advance(DEADLINE_MS);
    expect(admission.expire()).toEqual([]);
    advance(1);
    expect(admission.expire()).toEqual(['owner-3', 'owner-4']);
  });

  it('counts the deadline of an owner activated by a release from that release', () => {
    const { admission, advance } = setup();
    for (let index = 1; index <= 3; index += 1) admission.request(ownerOf(index), MIB);
    advance(1_900);
    admission.release('owner-1');

    advance(101);

    expect(admission.expire()).toEqual(['owner-2']);
    expect(admission.request('owner-3', MIB)).toEqual(ACTIVE);
  });

  it('never ends a queued owner, however long it waits', () => {
    const { admission, advance } = setup();
    admission.request('holder', BUDGET);
    admission.request('waiting', MIB);

    advance(DEADLINE_MS);
    expect(admission.expire()).toEqual([]);
    advance(60_000);
    admission.release('holder');
    expect(admission.expire()).toEqual([]);

    expect(admission.request('waiting', MIB)).toEqual(ACTIVE);
  });
});

describe('the limits', () => {
  it('hold after every step of a long mixed sequence', () => {
    const { admission, advance } = setup();
    let seed = 12_345;
    const next = (bound: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % bound;
    };
    const breaches: string[] = [];
    const refused = new Map<string, number>();
    let expired = 0;

    for (let step = 0; step < 2_000; step += 1) {
      const owner = ownerOf(next(24));
      const action = next(10);
      if (action < 6) {
        const result = admission.request(owner, next(10) * MIB + next(1_024));
        if (!result.ok) refused.set(result.detail, (refused.get(result.detail) ?? 0) + 1);
      } else if (action < 9) {
        admission.release(owner);
      } else {
        advance(next(1_500));
        expired += admission.expire().length;
      }
      const { active, queued, workingSetBytes } = admission.snapshot();
      if (active > 2 || queued > 8 || workingSetBytes > BUDGET || active < 0 || queued < 0) breaches.push(`${String(step)}:${String(active)}/${String(queued)}`);
      if (queued > 0 && active === 0) breaches.push(`${String(step)}:idle-with-queue`);
    }

    expect(breaches).toEqual([]);
    expect([...refused.keys()].sort()).toEqual(['preparation-queue-full', 'working-set-exceeded']);
    expect(refused.get('preparation-queue-full')).toBeGreaterThan(10);
    expect(refused.get('working-set-exceeded')).toBeGreaterThan(10);
    expect(expired).toBeGreaterThan(10);
  });
});
