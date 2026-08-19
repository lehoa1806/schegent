// Feature FR-R3-006 (T337) — the shape of a reset, as a transaction.
//
// Reset is the only operation in the product that is *supposed* to invalidate
// everything else in flight, and before this feature it was the one operation
// that asked nothing to stop. It prompted, fired thirteen independent
// `memento.update` calls outside the store's serialization chain, and showed a
// toast. A drain, a watchdog tick, or a `setRun` already in flight could land
// after the corresponding key was cleared, and nothing on disk distinguished
// "reset completed" from "reset died half-way through".
//
// This module holds the parts of the fix that are pure: the phase order, the
// marker, and the closed set of reasons a reset can refuse. It imports nothing
// — not `vscode`, not the store — so the order can be asserted directly and the
// marker can be validated on the activation path without dragging the command
// layer in behind it.
//
// ## The order, and why each step is where it is
//
// The phases below are the whole contract. Each one exists because doing it
// later would make an earlier one meaningless:
//
//   1. `quiesce`        — cancel in-flight work and wait for the CLI subprocesses
//                         to actually go away. Before the clear, because a live
//                         subprocess outlives the state that describes it, and
//                         its driver writes on completion.
//   2. `stop-producers` — tear the workspace-bound wiring down: watchdogs,
//                         drain triggers, lease heartbeats. Before the clear,
//                         because these are the writers that would otherwise
//                         recreate a key seconds after it was cleared.
//   3. `mark`           — persist an in-progress marker. Before the clear, so
//                         an interrupted reset is detectable; a marker written
//                         after would only ever describe a reset that finished.
//   4. `clear`          — clear every non-exempt key, through the store's
//                         serialize chain.
//   5. `commit`         — advance the marker to complete. After the clear, for
//                         the same reason the mark comes before it.
//   6. `reload`         — rebuild the wiring so the window is usable again, and
//                         so primacy is re-acquired rather than left dropped.
//
// `reload` is last and is not optional. Tearing down releases the window's
// primacy lease, and `release()` stops the heartbeat and nulls the record while
// nothing but `tryAcquire()` restores either — so a reset that stopped at
// `commit` would leave the window non-primary for the rest of the session.
// CLAUDE.md permits reset to release primacy because it is workspace
// maintenance rather than a Run-scoped path; it does not permit leaving it
// released.

/**
 * How long `quiesce` waits for the CLI subprocesses to go away, and how often
 * it looks.
 *
 * Ten seconds rather than the two `clear-all.ts` allows, because the two
 * commands do different things when the window elapses. Clean All warns and
 * proceeds, so a short window costs an operator a toast; reset **refuses** and
 * clears nothing, so a short window costs them the whole operation and a retry.
 * The asymmetry in the consequence is what sets the asymmetry in the number,
 * and a subprocess that has not exited in ten seconds is not one that was about
 * to.
 */
export const RESET_QUIESCE_WINDOW_MS = 10_000;
export const RESET_QUIESCE_POLL_INTERVAL_MS = 50;

/** The transaction's phases, in the only order they are correct in. */
export const RESET_PHASES = [
  'quiesce',
  'stop-producers',
  'mark',
  'clear',
  'commit',
  'reload'
] as const;

export type ResetPhase = (typeof RESET_PHASES)[number];

/**
 * Why a reset did not happen. Closed, bounded, and safe in an audit payload —
 * no path, no task description, no operator-authored text.
 *
 * `runner-still-active` is the one an operator can act on: work did not stop
 * inside the quiesce window, so the reset refused rather than clearing state
 * out from under a live CLI subprocess. The other two are host-side failures
 * that leave the reset un-attempted (`quiesce-failed`) or partially applied and
 * marked as such (`clear-failed`).
 */
export type ResetRefusalReason = 'runner-still-active' | 'quiesce-failed' | 'clear-failed';

/** The phase a refusal is reported against, for the audit payload. */
export interface ResetRefusal {
  readonly reason: ResetRefusalReason;
  readonly phase: ResetPhase;
}

export type ResetMarkerStatus = 'in-progress' | 'complete';

/**
 * The generation marker.
 *
 * Two fields and no more. `generation` is monotone across resets so a workspace
 * carries how many it has had rather than just whether one is underway, and
 * `status` is the interruption signal: a marker still reading `in-progress` at
 * activation means the host died between the mark and the commit.
 *
 * There is deliberately no timestamp. A marker is read on the activation path
 * to decide whether to finish a clear, and that decision must not depend on a
 * clock the workspace may have moved underneath — a stale-by-time heuristic
 * would either finish a reset the operator abandoned or skip one that is
 * genuinely half-applied. `in-progress` means unfinished at any age.
 */
export interface ResetMarker {
  readonly generation: number;
  readonly status: ResetMarkerStatus;
}

/**
 * Whether a persisted value is a marker.
 *
 * Validated rather than cast because it is read from a `Memento` that an older
 * build, a partial write, or a hand edit could have left in any shape, and the
 * consequence of trusting a bad one is either repeating a clear that already
 * happened or skipping one that did not.
 */
export function isResetMarker(value: unknown): value is ResetMarker {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ResetMarker>;
  return (
    typeof candidate.generation === 'number' &&
    Number.isInteger(candidate.generation) &&
    candidate.generation >= 0 &&
    (candidate.status === 'in-progress' || candidate.status === 'complete')
  );
}

/**
 * The generation the next reset claims.
 *
 * An unreadable or absent marker starts at 1 rather than refusing: a workspace
 * that has never been reset is the ordinary case, and a corrupt marker must not
 * be able to block the one command an operator reaches for when state is
 * already wrong.
 */
export function nextResetGeneration(marker: ResetMarker | null): number {
  return (marker?.generation ?? 0) + 1;
}

/**
 * Whether the last reset this workspace saw never reached its commit.
 *
 * The activation path finishes such a reset rather than reporting and moving
 * on, because the alternative is a workspace holding a partially cleared state
 * that reads as a normal one — which is the defect this feature closes, not a
 * condition it may leave behind.
 */
export function isResetInterrupted(marker: ResetMarker | null): boolean {
  return marker?.status === 'in-progress';
}
