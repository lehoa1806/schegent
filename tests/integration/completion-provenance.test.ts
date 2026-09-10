// Feature 195 (T065, BUG-001, FR-026, SC-017) — the stored record says what
// produced it.
//
// WHAT FR-026 ADDS TO FR-025. T062/T063 gave the halt a third exit: the operator
// asserts that a failed task's work completed elsewhere, and the row becomes
// `completed`. That is the whole mechanism — `completed` is already outside the
// blocking set, so FR-003's recomputation ends the halt with nothing stored about
// it (SC-008 still holds). But it also means an attested row and a row the host
// watched succeed are now the same six characters. FR-026 is the requirement that
// they not be.
//
// FOUR PROVENANCES, THREE OF THEM ROWS. SC-017 names four things a reader must be
// able to tell apart: the host verified the work, the operator attested it, the
// operator cancelled the task, the operator removed it. Only three of those leave
// a record. A removed row is *gone* (feature 192, invariant 5 — removal deletes,
// it does not mark), so the fourth reading is measured by absence, and this file
// asserts it that way rather than pretending there is a field to inspect.
//
// "FROM THAT RECORD ALONE" IS STRUCTURAL HERE, NOT A PROMISE. SC-017 requires the
// reading to be possible without consulting the audit log or any queue-level
// record. `readProvenance` below therefore takes a single `FeatureRequest` (or
// `undefined`) and nothing else — no store, no `QueueState`, no audit reader is in
// scope for it to reach. A test that took the harness and asserted the same four
// answers would prove the answers exist somewhere, which is not the criterion.
//
// The rows are produced by the real writers over a real `WorkspaceStateStore`,
// and read back out of the memento rather than off the manager, because "stored
// record" is the claim: a field held only in memory would satisfy an assertion
// against `getQueue()` and vanish on the next window.

import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { FeatureRequest } from '../../src/queue/feature-request';
import { KEYS, WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { makeHaltHarness, type HaltHarness } from './queue-halt-fixture';

/**
 * The four readings SC-017 enumerates. Local to this test: it is the reader the
 * criterion posits, and the product has no control-flow use for it — see the
 * field's own doc comment on why that is deliberate rather than an oversight.
 */
type Provenance = 'host-verified' | 'operator-attested' | 'operator-cancelled' | 'operator-removed';

/**
 * The whole of SC-017, as a function of one stored row.
 *
 * `undefined` is not a defensive branch — it is the removed provenance, and the
 * only shape a removed task has.
 */
function readProvenance(row: FeatureRequest | undefined): Provenance {
  if (row === undefined) return 'operator-removed';
  if (row.status === 'canceled') return 'operator-cancelled';
  if (row.status === 'completed') {
    return row.completionProvenance === 'operator-attested' ? 'operator-attested' : 'host-verified';
  }
  throw new Error(`not a settled outcome: ${row.status}`);
}

/** The stored rows, read out of the memento rather than off the store's cache. */
function storedRows(memento: Memento): readonly FeatureRequest[] {
  const queues = memento.get<Record<string, { requests: readonly FeatureRequest[] }>>(KEYS.queue);
  const queue = queues?.[DEFAULT_QUEUE_ID];
  if (queue === undefined) throw new Error('the default queue must be persisted');
  return queue.requests;
}

function storedRow(memento: Memento, id: string): FeatureRequest | undefined {
  return storedRows(memento).find((row) => row.id === id);
}

/** Enqueue, start, and settle one task as `status`, leaving it at the head. */
async function settleOne(h: HaltHarness, label: string, status: 'completed' | 'canceled' | 'failed') {
  const task = await h.queue.enqueue(label);
  await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
  await h.finish(DEFAULT_QUEUE_ID, status);
  return task;
}

describe('feature 195 (T065, FR-026, SC-017) — the stored record names what produced it', () => {
  it('reads back four distinct provenances, one task of each', async () => {
    // The criterion as written: one task of each provenance, all four readings
    // taken from stored rows through the one-argument reader above. Asserted as
    // a set as well as element-wise — two provenances that collapsed onto the
    // same answer would still satisfy four equality assertions written
    // separately, which is the shape of check FR-026 exists because of.
    const h = await makeHaltHarness('continue');

    const verified = await settleOne(h, 'host verified this', 'completed');
    const cancelled = await settleOne(h, 'operator cancelled this', 'canceled');
    const attestedTask = await settleOne(h, 'operator attested this', 'failed');
    expect(await h.queue.attestCompleted(attestedTask.id)).toEqual({ ok: true });
    const removed = await settleOne(h, 'operator removed this', 'failed');
    await h.queue.removeTask(removed.id);

    const readings = {
      verified: readProvenance(storedRow(h.memento, verified.id)),
      attested: readProvenance(storedRow(h.memento, attestedTask.id)),
      cancelled: readProvenance(storedRow(h.memento, cancelled.id)),
      removed: readProvenance(storedRow(h.memento, removed.id))
    };

    expect(readings).toEqual({
      verified: 'host-verified',
      attested: 'operator-attested',
      cancelled: 'operator-cancelled',
      removed: 'operator-removed'
    });
    expect(new Set(Object.values(readings)).size).toBe(4);
  });

  it('separates the two completions on the marker, not on any other field', async () => {
    // The one distinction `status` cannot make, isolated. Both rows are
    // `completed`; the reading differs, and it differs because of the marker —
    // deleting it from the attested row must collapse the two answers, which is
    // what the second half asserts.
    const h = await makeHaltHarness('continue');

    const verified = await settleOne(h, 'ran to success', 'completed');
    const attestedTask = await settleOne(h, 'failed then attested', 'failed');
    await h.queue.attestCompleted(attestedTask.id);

    const verifiedRow = storedRow(h.memento, verified.id);
    const attestedRow = storedRow(h.memento, attestedTask.id);
    expect(verifiedRow?.status).toBe('completed');
    expect(attestedRow?.status).toBe('completed');
    expect(readProvenance(verifiedRow)).not.toBe(readProvenance(attestedRow));

    const withoutMarker: FeatureRequest = { ...(attestedRow as FeatureRequest) };
    delete withoutMarker.completionProvenance;
    expect(readProvenance(withoutMarker)).toBe('host-verified');
  });

  it('preserves the failure the attested row terminated with', async () => {
    // FR-026's readability is not only the marker. `completedAt` and `lastError`
    // are the evidence that THIS row failed and was later attested; an attested
    // completion that refreshed either would be indistinguishable from a clean
    // first-attempt success on every field but one.
    // `h.finish` passes no failure payload, and widening the shared harness for
    // one scenario would touch every 195 suite that uses it. `queue.finish` is
    // called directly instead — nothing here drains again, so the execution
    // lease this skips releasing is never asked for.
    const h = await makeHaltHarness('halt-on-failure');
    const task = await h.queue.enqueue('committed then recorded failed');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.queue.finish(task.id, 'failed', {
      code: 'host-verification-failed',
      message: 'exit code 143',
      phase: 'finalize'
    });

    const beforeAttest = storedRow(h.memento, task.id);
    expect(beforeAttest?.lastError).not.toBeNull();

    await h.queue.attestCompleted(task.id);

    const after = storedRow(h.memento, task.id);
    expect(after?.lastError).toEqual(beforeAttest?.lastError);
    expect(after?.completedAt).toBe(beforeAttest?.completedAt);
    expect(after?.retryCount).toBe(beforeAttest?.retryCount);
  });

  it('marks only the attested row, so absence stays a reading', async () => {
    // Absence means host-verified, and that is only checkable while absence is
    // real. A write that filled the field in on every row would make the marker
    // uninformative and fail nothing else here — the `degradedPhases` C3.6
    // precedent, same argument.
    const h = await makeHaltHarness('continue');
    const verified = await settleOne(h, 'row-1', 'completed');
    const attestedTask = await settleOne(h, 'row-2', 'failed');
    const pending = await h.queue.enqueue('row-3');

    await h.queue.attestCompleted(attestedTask.id);

    for (const id of [verified.id, pending.id]) {
      expect(Object.keys(storedRow(h.memento, id) ?? {})).not.toContain('completionProvenance');
    }
    expect(Object.keys(storedRow(h.memento, attestedTask.id) ?? {})).toContain(
      'completionProvenance'
    );
  });

  it('survives a window reload, because a later reader is the point', async () => {
    // "A later reader" is not the same session. The store object is discarded and
    // a new one built over the same memento, which is what a window reload does.
    const h = await makeHaltHarness('halt-on-failure');
    const task = await settleOne(h, 'attested before the reload', 'failed');
    await h.queue.attestCompleted(task.id);

    const reloaded = new WorkspaceStateStore(h.memento);
    await reloaded.initialize();
    const reread = reloaded.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === task.id);

    expect(readProvenance(reread)).toBe('operator-attested');
  });

  it('injects no marker into a record written before this feature', async () => {
    // FR-017 / research D2 — optional and additive, so no schema bump and no
    // migrator. A record that predates the field must read back without it, or
    // every historical completion silently acquires a provenance nobody asserted.
    const h = await makeHaltHarness('continue');
    const task = await settleOne(h, 'pre-feature row', 'completed');

    const reloaded = new WorkspaceStateStore(h.memento);
    await reloaded.initialize();
    const reread = reloaded.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === task.id);

    expect(reread).not.toHaveProperty('completionProvenance');
    expect(readProvenance(reread)).toBe('host-verified');
  });
});
