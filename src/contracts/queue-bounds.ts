// FR-R3-110 (FR-104) — the queue *capacity bounds*, where the contract layer can
// reach them without importing the queue layer.
//
// WHY THEY MOVED
//
// `src/contracts/validators/queue-management.ts` value-imported `MAX_QUEUES` from
// `src/queue/queue-registry.ts`, so the contract layer depended at runtime on the
// layer it exists to describe. That is the backwards edge the dependency-direction
// gate refuses, and the validator is in the right place — a bound that gates
// operator input belongs beside the other validators — so the number moved rather
// than the check.
//
// WHAT DID NOT CHANGE
//
// The values, and the preconditions on changing them. `AGENTS.md` ties any
// widening of `MAX_QUEUES` to two things that must arrive together: a forward-only
// state migration that can read the wider shape, and a scheduler that decides
// which of N queues runs. Feature 092 met both — the v9 -> v10 migrator turns a
// single `QueueState` into a `Record<queueId, QueueState>` in one atomic write,
// and `AutoDrainCoordinator`'s per-queue drain chooses between them — which is why
// the cap is 20 today and not 1. Relocating the declaration does not relitigate
// any of that; a migration alone leaves N queues with no rule for choosing between
// them, and a scheduler alone leaves persisted state the loader cannot read.
//
// This module imports nothing, on purpose. It is a leaf.

/**
 * The most queues one workspace may hold.
 *
 * Observable in three places: the migrator refuses to produce more, the queue
 * validator refuses a configured cap above it, and `MAX_GLOBAL_CONCURRENCY_CAP`
 * derives the concurrency ceiling from it. Feature 030 reduced this to 1 for the
 * single-queue collapse and feature 092 restored it; the bound's *meaning* never
 * changed.
 *
 * FR-R3-145 (T1572) corrected the third clause, which used to read "the settings
 * enumeration projects it". It no longer does: `schegent.queue.globalConcurrencyCap`
 * was removed, so no manifest property restates this number.
 */
export const MAX_QUEUES = 20;

/**
 * The concurrency ceiling a cold workspace runs at.
 *
 * FR-R3-145 (T1572) moved this here from `src/state/workspace-state.ts`. It is
 * read by the store that decides the cap and by the snapshot projection that
 * displays it, and those live in different layers; the contract layer is the one
 * both may reach. Feature 098 (REL-02) set the value: concurrent Runs share one
 * working tree, so `RunCheckpointService` declines to snapshot above one in-flight
 * Run, and at the previous default of 3 that decline was every fresh install's
 * behaviour. Raising it is gated on per-run worktree isolation, not on this line.
 *
 * That the cap may exceed one *at all* is authorised by
 * `docs/architecture/local-queue-parallelism-ratification.md`, which narrows one
 * clause of the remote/multi-user expansion gate for the local single-operator
 * shape and enumerates the premises whose change reopens it. The ceiling above
 * and this default are the two numbers that record reasons about, so a reader who
 * arrives here through the code can reach the authority from here.
 */
export const DEFAULT_GLOBAL_CONCURRENCY_CAP = 1;

/** The longest operator-chosen queue name, in characters. */
export const MAX_QUEUE_NAME_LENGTH = 64;
