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
 * validator refuses a configured cap above it, and the settings enumeration
 * projects it. Feature 030 reduced this to 1 for the single-queue collapse and
 * feature 092 restored it; the bound's *meaning* never changed.
 */
export const MAX_QUEUES = 20;

/** The longest operator-chosen queue name, in characters. */
export const MAX_QUEUE_NAME_LENGTH = 64;
