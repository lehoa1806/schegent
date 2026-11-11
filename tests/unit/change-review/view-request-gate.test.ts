// FR-R6-F12 T029 (research R7; FR-016, NFR-002) — the view-request gate.

import { describe, expect, it } from 'vitest';
import { reviewOk, type ReviewResult } from '../../../src/contracts/change-review';
import { createViewRequestGate } from '../../../src/services/change-review/view-request-gate';

const VIEW = 'review-view';

interface Pending<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function pending<T>(): Pending<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe('view-request gate (R7)', () => {
  it('delivers the work result when nothing intervenes', async () => {
    const gate = createViewRequestGate();
    const ticket = gate.begin(VIEW);
    await expect(gate.run(ticket, () => Promise.resolve(reviewOk(7)))).resolves.toEqual({ ok: true, value: 7 });
  });

  it('a newer begin resolves the older run superseded while its work is still pending', async () => {
    const gate = createViewRequestGate();
    const first = gate.begin(VIEW);
    const work = pending<ReviewResult<number>>();
    const older = gate.run(first, () => work.promise);
    const second = gate.begin(VIEW);
    await expect(older).resolves.toEqual({ ok: false, reason: 'superseded' });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    work.resolve(reviewOk(1));
  });

  it('cancel resolves canceled within one tick while the work never settles', async () => {
    const gate = createViewRequestGate();
    const ticket = gate.begin(VIEW);
    const run = gate.run(ticket, () => never<ReviewResult<number>>());
    expect(gate.cancel(VIEW)).toBe(true);
    const settled = await Promise.race([run, new Promise((resolve) => setImmediate(() => resolve('late')))]);
    expect(settled).toEqual({ ok: false, reason: 'canceled' });
  });

  it('cancel with nothing in flight answers false', () => {
    const gate = createViewRequestGate();
    expect(gate.cancel(VIEW)).toBe(false);
    const ticket = gate.begin(VIEW);
    expect(gate.cancel(VIEW)).toBe(true);
    expect(gate.cancel(VIEW)).toBe(false);
    expect(ticket.signal.reason).toBe('canceled');
  });

  it('does not deliver a late result after an abort, and swallows a late rejection', async () => {
    const gate = createViewRequestGate();
    const resolved = pending<ReviewResult<number>>();
    const rejected = pending<ReviewResult<number>>();
    const firstTicket = gate.begin(VIEW);
    const first = gate.run(firstTicket, () => resolved.promise);
    gate.cancel(VIEW);
    resolved.resolve(reviewOk(99));
    await expect(first).resolves.toEqual({ ok: false, reason: 'canceled' });

    const secondTicket = gate.begin(VIEW);
    const second = gate.run(secondTicket, () => rejected.promise);
    gate.cancel(VIEW);
    rejected.reject(new Error('late failure'));
    await expect(second).resolves.toEqual({ ok: false, reason: 'canceled' });
  });

  it('refuses a work result that lands after the signal aborted in the same turn', async () => {
    const gate = createViewRequestGate();
    const ticket = gate.begin(VIEW);
    const result = gate.run(ticket, async (signal) => {
      await Promise.resolve();
      gate.begin(VIEW);
      expect(signal.aborted).toBe(true);
      return reviewOk(5);
    });
    await expect(result).resolves.toEqual({ ok: false, reason: 'superseded' });
  });

  it('runs an already aborted ticket to its refusal without starting the work', async () => {
    const gate = createViewRequestGate();
    const ticket = gate.begin(VIEW);
    gate.cancel(VIEW);
    let started = 0;
    const result = await gate.run(ticket, () => {
      started += 1;
      return Promise.resolve(reviewOk(1));
    });
    expect(result).toEqual({ ok: false, reason: 'canceled' });
    expect(started).toBe(0);
  });

  it('increments the generation and keeps views apart', async () => {
    const gate = createViewRequestGate();
    const first = gate.begin(VIEW);
    const other = gate.begin('other-view');
    const second = gate.begin(VIEW);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(other.generation).toBeGreaterThan(first.generation);
    expect(other.signal.aborted).toBe(false);
    await expect(gate.run(second, () => Promise.resolve(reviewOk('done')))).resolves.toEqual({ ok: true, value: 'done' });
    expect(gate.cancel(VIEW)).toBe(false);
  });

  it('a finished older run does not clear the newer request', async () => {
    const gate = createViewRequestGate();
    const first = gate.begin(VIEW);
    const firstRun = gate.run(first, () => Promise.resolve(reviewOk(1)));
    const second = gate.begin(VIEW);
    const work = pending<ReviewResult<number>>();
    const secondRun = gate.run(second, () => work.promise);
    await firstRun;
    expect(gate.cancel(VIEW)).toBe(true);
    await expect(secondRun).resolves.toEqual({ ok: false, reason: 'canceled' });
  });

  it('passes a work failure through when the request was not aborted', async () => {
    const gate = createViewRequestGate();
    const ticket = gate.begin(VIEW);
    await expect(gate.run(ticket, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.cancel(VIEW)).toBe(false);
  });
});
