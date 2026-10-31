// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Nothing here runs at wiring time: `closeStage2Resources` is called on the way
// down, and everything it disposes was constructed and granted while this window
// already held trust. There is no producer to gate, so no `isWorkspaceTrusted()`
// call belongs in it — a gate here would be a check on a shutdown.
//
// FR-R3-137 (T1530c, FR-008) — Stage 2's resource teardown.
//
// WHY THIS IS A MODULE. Two reasons, and the second is the load-bearing one:
//
//   1. `wireStage2` sat at exactly its pinned function-length exemption
//      (437/437, asserted shrink-only), so the shutdown plumbing FR-R3-137 needed
//      could not be added there — it had to buy its own room.
//   2. The order below is a decision, and a decision inside a 437-line function
//      is a decision nobody will find. It is four steps whose sequence is the
//      difference between a flushed transport log and a truncated one, and
//      (FR-R4-F06) between releasing ownership after a backend is gone and before.
//
// WHAT DELIBERATELY STAYED IN `extension.ts`: `executionLeases.releaseAll()` and
// `lock.release()`. AGENTS.md rule 4 puts window primacy's release at `dispose()`
// in the composition root "and nowhere else", with no exception, and no gate pins
// the call site — so moving it would have passed every check while turning an
// invariant a reader confirms by grepping one file into one they have to trace
// through two. The releases are three lines; the room was bought by the fourteen
// above them.

import type * as vscode from 'vscode';

import type { BoundedTransport } from '../monitor/drop-reporting-transport';

export interface Stage2ResourceTeardown {
  /**
   * The synchronous disposables held by name in `wireStage2` — the UI wiring,
   * the projector, the two watchdogs and the status bar. Taken as a list because
   * this module has no reason to know which is which; the caller's order is
   * preserved.
   */
  readonly sync: readonly { dispose: () => void }[];
  /** The `disposables` array every Stage-2 collaborator pushes onto. */
  readonly disposables: readonly vscode.Disposable[];
  /**
   * FR-R3-137 — the transport sink, wrapped. Owns one append descriptor per
   * destination; until this parameter existed, the only thing that ever closed
   * one was the garbage collector.
   */
  readonly transport: Pick<BoundedTransport, 'flushAndDispose'>;
  /**
   * FR-R4-F06 (FR-021; S5) — close the backend runners and wait, under one bound, for their
   * process trees to be gone, then record the shutdown evidence. Required, not optional: a
   * teardown that could be forgotten is the `cancelAll` disposable it replaces, which fired the
   * ladders and let the caller release ownership without waiting for them.
   *
   * Never rejects by contract. A caller that cannot promise that wraps it, because a throw here
   * would abandon the lease release and the primacy release that follow.
   */
  readonly teardown: () => Promise<void>;
}

/**
 * Dispose Stage 2's resources, in order, and never throw.
 *
 * The order, and why each step is where it is (FR-R4-F06 added the second):
 *
 *   1. the synchronous disposals — the producers stop first, so nothing new starts;
 *   2. `await teardown()` — admission closes and the backend trees are brought down, so the
 *      caller releases ownership only once their outcome is known and recorded. It runs BEFORE
 *      the transport flush so the dying CLI's last output is still accepted: the sink refuses
 *      lines that arrive after the flush begins (`cli-transport-sink.ts`);
 *   3. the disposables the collaborators registered;
 *   4. `await transport.flushAndDispose()`.
 *
 * Called from a `dispose()` chain whose remaining steps release the execution
 * leases and then window primacy. A throw here would abandon both, so every
 * failure is swallowed at the narrowest point that can still make progress —
 * which is what the per-entry `try`/`catch` below is for, and why the transport
 * close is documented as non-rejecting at its own definition.
 */
export async function closeStage2Resources(deps: Stage2ResourceTeardown): Promise<void> {
  for (const entry of deps.sync) {
    try {
      entry.dispose();
    } catch {
      // ignore disposal errors
    }
  }
  try {
    await deps.teardown();
  } catch {
    // Contractually never rejects; the guard is for the caller that promised and was wrong.
  }
  for (const d of deps.disposables) {
    try {
      d.dispose();
    } catch {
      // ignore disposal errors
    }
  }
  // FR-R3-137 (FR-008) — the transport settles BEFORE the caller releases the
  // leases and the lock, and the order is the requirement rather than a
  // preference. Evidence-health surfaces must still exist while the final drop
  // counts are reported, and a lock released before its protected writes have
  // landed is the ordering Feature 092 already rejected on the queue side.
  await deps.transport.flushAndDispose();
}
