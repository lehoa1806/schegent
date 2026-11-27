// Feature 254 (FR-R4-F07, W-T1; contract W1; data-model §8; FR-037) — the store's write chain, alone.
//
// One chain per store, and every write the store performs runs through it, from the manifest load to its
// last step. The chain is its own pure module so it can be tested without a store: what is asserted here
// is the property the store's lost-update test depends on, in the smallest form that can show it.
//
//   * an operation starts only after the one before it has SETTLED, however long the first takes;
//   * the caller gets its own operation's result, and its own operation's rejection;
//   * a rejection does not wedge the chain: the next writer still runs.
//
// The chain is the shape of `mutation-command-executor.ts` (`chain.then(run, run)`), per store and not per
// router, because FR-037 is a property of the store, the one object every in-process writer shares.

import { describe, expect, it } from 'vitest';

import { createWriteChain } from '../../../src/catalog/write-chain';

/** A promise settled from outside, so a test decides when an operation finishes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('FR-R4-F07 W-T1 — createWriteChain (data-model §8)', () => {
  it('runs a second operation only after the first has settled', async () => {
    const chain = createWriteChain();
    const order: string[] = [];
    const gate = deferred<void>();

    const first = chain.run(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 'one';
    });
    const second = chain.run(async () => {
      order.push('second:start');
      return 'two';
    });

    // Let every microtask that can run, run: the second must still be waiting on the first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first:start']);

    gate.resolve();
    expect(await first).toBe('one');
    expect(await second).toBe('two');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs many operations in the order they were issued', async () => {
    const chain = createWriteChain();
    const seen: number[] = [];
    const started: number[] = [];
    const entered = Array.from({ length: 8 }, () => deferred<void>());
    const release = Array.from({ length: 8 }, () => deferred<void>());

    const resultsPromise = Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7].map((n) =>
        chain.run(async () => {
          started.push(n);
          entered[n]!.resolve();
          await release[n]!.promise;
          seen.push(n);
          return n * 2;
        })
      )
    );

    // Pre-release operations 1..7 before 0 finishes: any overlap would let a later operation
    // finish ahead of an earlier one, while releasing step-by-step proves strict serialization.
    await entered[0]!.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0]);
    for (let n = 7; n >= 1; n -= 1) release[n]!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0]);
    expect(seen).toEqual([]);

    release[0]!.resolve();
    const results = await resultsPromise;

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it('hands the caller its own rejection, and the next writer still runs', async () => {
    const chain = createWriteChain();
    const boom = new Error('first write failed');

    const first = chain.run(async () => {
      throw boom;
    });
    const second = chain.run(async () => 'second ran');

    await expect(first).rejects.toBe(boom);
    expect(await second).toBe('second ran');
  });

  it('survives an operation that throws before returning a promise', async () => {
    const chain = createWriteChain();
    const boom = new Error('threw synchronously');

    const first = chain.run((() => {
      throw boom;
    }) as () => Promise<never>);
    const second = chain.run(async () => 'after');

    await expect(first).rejects.toBe(boom);
    expect(await second).toBe('after');
  });

  it('keeps separate chains independent (one chain per store)', async () => {
    const left = createWriteChain();
    const right = createWriteChain();
    const gate = deferred<void>();
    const order: string[] = [];

    const slow = left.run(async () => {
      await gate.promise;
      order.push('left');
    });
    const quick = right.run(async () => {
      order.push('right');
    });

    await quick;
    expect(order).toEqual(['right']);
    gate.resolve();
    await slow;
    expect(order).toEqual(['right', 'left']);
  });
});
