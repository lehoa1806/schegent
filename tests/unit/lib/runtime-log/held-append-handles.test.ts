// Feature 218 (FR-R3-191) — Unit tests for HeldAppendHandles, the runtime log
// writer's held append descriptors and the release that gives them back
// (T1858a, research R8):
//   1. Checks 3, 4 and 5: nothing opens once the close step has begun, and an
//      open that completes after it is closed rather than kept (FR-004).
//   2. Every close the module starts is tracked, and the release waits for it
//      (FR-005).
//   3. One release: the same promise on every call, and the drain runs once
//      (FR-006).
//   4. A close or drain that rejects, a close that throws, and a warning that
//      throws: the release still resolves, closes every descriptor, and no
//      longer counts one whose close failed (FR-007).
//   5. One warning, naming no path and no count, when the grace expires, and
//      none when the drain wins (FR-008).
//   6. The grace is the transport writer's (FR-003).
//
// The handles are plain objects whose `close` a case settles when it chooses.
// Nothing here opens a descriptor, and this file does not opt in to the
// descriptor detector (FR-022).

import type { FileHandle } from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HeldAppendHandles,
  RUNTIME_LOG_DRAIN_GRACE_MS
} from '../../../../src/lib/runtime-log/held-append-handles';
import { TRANSPORT_DRAIN_GRACE_MS } from '../../../../src/monitor/cli-transport-sink';

// Opaque keys. The module never touches a path, so these name nothing on disk.
const TARGET = 'held-append-handles/runtime.log';
const OTHER_TARGET = 'held-append-handles/other.log';
const ROOTS = ['held-append-handles'];
const OTHER_ROOTS = ['held-append-handles', 'repointed'];

/** An injected grace, short enough to read and distinct from the default. */
const GRACE_MS = 50;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface FakeHandle {
  /** What `acquire` hands back. Only `close` is ever called on it. */
  readonly handle: FileHandle;
  readonly closeCalls: () => number;
}

function fakeHandle(close: () => Promise<void> = () => Promise.resolve()): FakeHandle {
  let calls = 0;
  const stub = {
    close: (): Promise<void> => {
      calls += 1;
      return close();
    }
  };
  return { handle: stub as unknown as FileHandle, closeCalls: () => calls };
}

/** Whether `promise` has settled, observed without awaiting it. */
function watch(promise: Promise<unknown>): () => boolean {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void promise.then(mark, mark);
  return () => settled;
}

/** One full turn of the event loop, so every microtask already queued has run. */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function collectingWarn(): { readonly warn: (message: string) => void; readonly warnings: string[] } {
  const warnings: string[] = [];
  return {
    warn: (message) => {
      warnings.push(message);
    },
    warnings
  };
}

const drained = (): Promise<void> => Promise.resolve();

describe('HeldAppendHandles — acquire', () => {
  it('opens once per target and hands the held descriptor back for the same roots (FR-009)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const fake = fakeHandle();
    let opens = 0;
    const open = (): Promise<FileHandle | null> => {
      opens += 1;
      return Promise.resolve(fake.handle);
    };

    await expect(held.acquire(TARGET, ROOTS, open)).resolves.toBe(fake.handle);
    await expect(held.acquire(TARGET, ROOTS, open)).resolves.toBe(fake.handle);

    expect(opens).toBe(1);
    expect(held.size).toBe(1);
  });

  it('closes a descriptor proved against other roots before it opens again', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const stale = fakeHandle();
    const fresh = fakeHandle();
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(stale.handle));

    await expect(held.acquire(TARGET, OTHER_ROOTS, () => Promise.resolve(fresh.handle))).resolves.toBe(
      fresh.handle
    );

    expect(stale.closeCalls()).toBe(1);
    expect(held.size).toBe(1);
  });

  it('opens nothing once the close step has begun (check 3, FR-004)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    await held.release(drained);
    let opens = 0;

    const acquired = await held.acquire(TARGET, ROOTS, () => {
      opens += 1;
      return Promise.resolve(fakeHandle().handle);
    });

    expect(acquired).toBeNull();
    expect(opens).toBe(0);
    expect(held.size).toBe(0);
  });

  it('opens nothing when the close step ran while a stale descriptor closed (check 4, FR-004)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const closeGate = deferred<undefined>();
    const stale = fakeHandle(() => closeGate.promise);
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(stale.handle));
    let opens = 0;

    // The roots changed, so acquire awaits the stale close, which is gated.
    const acquiring = held.acquire(TARGET, OTHER_ROOTS, () => {
      opens += 1;
      return Promise.resolve(fakeHandle().handle);
    });
    const releasing = held.release(drained);
    await turn();
    // The precondition is the point: the close step has to have run inside the
    // stale close, or this case passes on check 3 instead.
    expect(held.isReleased(), 'the close step ran during the stale close').toBe(true);

    closeGate.resolve(undefined);

    await expect(acquiring).resolves.toBeNull();
    await releasing;
    // Check 5 would also return null here, after an open. No open is check 4.
    expect(opens).toBe(0);
    expect(stale.closeCalls()).toBe(1);
    expect(held.size).toBe(0);
  });

  it('closes, and does not keep, an open that completes after the close step (check 5, FR-004)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const opening = deferred<FileHandle | null>();
    const late = fakeHandle();

    const acquiring = held.acquire(TARGET, ROOTS, () => opening.promise);
    await held.release(drained);
    expect(held.size, 'the sweep ran, and it held nothing').toBe(0);

    // The open completes after the release has resolved: no owner is left to
    // close what it returns, so acquire has to.
    opening.resolve(late.handle);

    await expect(acquiring).resolves.toBeNull();
    expect(late.closeCalls()).toBe(1);
    expect(held.size).toBe(0);
  });
});

describe('HeldAppendHandles — release', () => {
  it('closes every held descriptor and resolves only once each close has settled (FR-003, FR-005)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const firstGate = deferred<undefined>();
    const secondGate = deferred<undefined>();
    const first = fakeHandle(() => firstGate.promise);
    const second = fakeHandle(() => secondGate.promise);
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(first.handle));
    await held.acquire(OTHER_TARGET, ROOTS, () => Promise.resolve(second.handle));
    expect(held.size, 'the fixture must hold two descriptors').toBe(2);

    const releasing = held.release(drained);
    const settled = watch(releasing);
    await turn();
    expect(held.size).toBe(0);
    expect(settled()).toBe(false);

    firstGate.resolve(undefined);
    await turn();
    expect(settled(), 'one close is still in flight').toBe(false);

    secondGate.resolve(undefined);
    await releasing;
    expect(first.closeCalls()).toBe(1);
    expect(second.closeCalls()).toBe(1);
  });

  it('waits for a close a settings correction began before the release (FR-005)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const closeGate = deferred<undefined>();
    const corrected = fakeHandle(() => closeGate.promise);
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(corrected.handle));

    const correcting = held.close(TARGET);
    const releasing = held.release(drained);
    const settled = watch(releasing);
    await turn();
    expect(settled(), 'the correction close is still in flight').toBe(false);

    closeGate.resolve(undefined);
    await Promise.all([correcting, releasing]);
    expect(corrected.closeCalls()).toBe(1);
  });

  it("waits for a late open's close that begins while the sweep is still settling (FR-004, FR-005)", async () => {
    const held = new HeldAppendHandles(() => undefined);
    const sweptGate = deferred<undefined>();
    const lateGate = deferred<undefined>();
    const swept = fakeHandle(() => sweptGate.promise);
    const late = fakeHandle(() => lateGate.promise);
    const opening = deferred<FileHandle | null>();
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(swept.handle));

    const acquiring = held.acquire(OTHER_TARGET, ROOTS, () => opening.promise);
    const releasing = held.release(drained);
    const settled = watch(releasing);
    await turn();
    // The open completes inside the sweep, so its close joins the set the
    // release is already waiting on. Check 5 awaits that close, as the
    // transport's late open does, so `acquiring` settles only once it has.
    opening.resolve(late.handle);
    await turn();
    expect(late.closeCalls(), 'check 5 began the late close').toBe(1);

    sweptGate.resolve(undefined);
    await turn();
    expect(settled(), "the late open's close is still in flight").toBe(false);

    lateGate.resolve(undefined);
    await expect(acquiring).resolves.toBeNull();
    await releasing;
    expect(held.size).toBe(0);
  });

  it('hands every caller the same promise and drains once (FR-006)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    let drains = 0;
    const drain = (): Promise<void> => {
      drains += 1;
      return Promise.resolve();
    };

    // Concurrent callers: one promise, not three that happen to agree.
    const [a, b, c] = [held.release(drain), held.release(drain), held.release(drain)];
    expect(b).toBe(a);
    expect(c).toBe(a);
    await a;

    // A repeated caller, after the release has settled, gets the same one.
    expect(held.release(drain)).toBe(a);
    expect(drains).toBe(1);
  });

  it('resolves when a close rejects, and no longer counts that descriptor (FR-007)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const failing = fakeHandle(() => Promise.reject(new Error('EIO')));
    const failingAtRelease = fakeHandle(() => Promise.reject(new Error('EIO')));
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(failing.handle));
    await held.acquire(OTHER_TARGET, ROOTS, () => Promise.resolve(failingAtRelease.handle));

    await expect(held.close(TARGET)).resolves.toBeUndefined();
    expect(held.size).toBe(1);

    await expect(held.release(drained)).resolves.toBeUndefined();
    expect(held.size).toBe(0);
    expect(failing.closeCalls()).toBe(1);
    expect(failingAtRelease.closeCalls()).toBe(1);
  });

  it('resolves when a close throws instead of rejecting, and still closes the rest (FR-007)', async () => {
    const held = new HeldAppendHandles(() => undefined);
    const throwing = fakeHandle(() => {
      throw new Error('EBADF');
    });
    const next = fakeHandle();
    // Held in this order, so the sweep reaches the throwing close first.
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(throwing.handle));
    await held.acquire(OTHER_TARGET, ROOTS, () => Promise.resolve(next.handle));

    await expect(held.release(drained)).resolves.toBeUndefined();

    expect(throwing.closeCalls()).toBe(1);
    expect(next.closeCalls(), 'the sweep went on past the throw').toBe(1);
    expect(held.size).toBe(0);
  });

  it('resolves when the drain rejects, and warns nothing (FR-007, FR-008)', async () => {
    const { warn, warnings } = collectingWarn();
    const held = new HeldAppendHandles(warn);
    const fake = fakeHandle();
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(fake.handle));

    await expect(held.release(() => Promise.reject(new Error('drain failed')))).resolves.toBeUndefined();

    expect(warnings).toEqual([]);
    expect(fake.closeCalls()).toBe(1);
    expect(held.size).toBe(0);
  });
});

describe('HeldAppendHandles — the grace (FR-003, FR-008)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns once, naming no path and no count, when the grace expires, and closes anyway', async () => {
    const { warn, warnings } = collectingWarn();
    const held = new HeldAppendHandles(warn, GRACE_MS);
    const fake = fakeHandle();
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(fake.handle));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = deferred<undefined>();

    const releasing = held.release(() => stalled.promise);
    const settled = watch(releasing);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(settled(), 'the grace has not yet elapsed').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await releasing;

    expect(warnings).toHaveLength(1);
    for (const named of [TARGET, ...ROOTS]) expect(warnings[0]).not.toContain(named);
    expect(warnings[0], 'no count').not.toMatch(/\d/);
    expect(fake.closeCalls()).toBe(1);
    expect(held.size).toBe(0);

    // Said once per release, however many callers.
    await held.release(() => stalled.promise);
    expect(warnings).toHaveLength(1);
  });

  it('warns nothing when the drain wins, and leaves no timer behind', async () => {
    const { warn, warnings } = collectingWarn();
    const held = new HeldAppendHandles(warn, GRACE_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const draining = deferred<undefined>();

    const releasing = held.release(() => draining.promise);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    draining.resolve(undefined);
    await releasing;

    expect(vi.getTimerCount(), 'the grace was cleared').toBe(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(warnings).toEqual([]);
  });

  it('resolves, and closes every descriptor, when the warning throws (FR-007, FR-008)', async () => {
    let attempts = 0;
    const held = new HeldAppendHandles(() => {
      attempts += 1;
      throw new Error('the fallback logger failed');
    }, GRACE_MS);
    const fake = fakeHandle();
    await held.acquire(TARGET, ROOTS, () => Promise.resolve(fake.handle));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = deferred<undefined>();

    // Both outcomes handled here, so a rejection is an assertion, not an
    // unhandled rejection.
    const outcome = held.release(() => stalled.promise).then(
      () => 'resolved',
      () => 'rejected'
    );
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const result = await outcome;

    expect(attempts, 'the grace expired, so the warning was attempted').toBe(1);
    expect(result, 'the release never rejects').toBe('resolved');
    expect(fake.closeCalls()).toBe(1);
    expect(held.size).toBe(0);
    expect(held.isReleased()).toBe(true);
  });

  it("pins the default grace to the transport writer's", () => {
    expect(RUNTIME_LOG_DRAIN_GRACE_MS).toBe(TRANSPORT_DRAIN_GRACE_MS);
  });
});
