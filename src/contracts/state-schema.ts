/**
 * Numeric schema version. Forward-only; never decremented.
 *
 * Version history:
 *   1 — feature 010 baseline (audit pipeline + fatal signatures + retry condition).
 *   2 — feature 011: adds `WorkflowRun.delayedRetryCount`,
 *       `WorkflowRun.pendingRetryAt`, `WorkflowRun.pendingRetryCause`. Legacy
 *       records are forward-migrated by `migrateLegacyRun()` in
 *       `src/state/workflow-run-migrator.ts`. Down-migration is unsupported.
 *   3 — feature 017: adds `WorkflowRun.phaseOverrides`,
 *       `WorkflowRun.manualPauseAt`, `WorkflowRun.manualPauseCause`. Also
 *       introduces the queue-registry (multi-queue) and queue-schedule
 *       persisted state. Legacy single-queue records are forward-lifted by
 *       `migrateLegacyQueueState()` in
 *       `src/state/queue-state-migrator.ts`. Forward-only.
 *   4 — feature 022: extends `WorkflowRun.phaseOverrides` with
 *       task-scoped removed-phase metadata. Pipeline snapshots remain
 *       immutable; removed phases are represented as per-run overrides.
 *   5 — feature 028: adds `WorkflowRun.phaseBreakpoints` (per-run
 *       future-phase breakpoint list, defaults to `[]`),
 *       `WorkflowRun.resumeTargetPhaseId` (defaults to `null`), and
 *       `QueueRegistryEntry.pauseSource: 'operator' | 'cascade' | null`
 *       (defaults to `'operator'` when `state === 'manually-paused'`, else
 *       `null`). Extends `ManualPauseCause` union with `'breakpoint-paused'`.
 *       Legacy v4 records are forward-migrated by `migrateV4ToV5()` and
 *       `migrateQueueRegistryV4ToV5()` in
 *       `src/state/workflow-run-migrator.ts`. Down-migration is unsupported.
 *   6 — feature 030: collapses the multi-queue `QueueRegistry` to a single
 *       entry with `id === 'default'`. Pending tasks across pre-migration
 *       source queues are coalesced into the unified queue, preserving each
 *       source queue's within-queue order, sequenced by source queue
 *       `createdAt`. In-flight tasks retain their `WorkflowRun` state
 *       (pipeline snapshot, pause causes, breakpoints, phase overrides)
 *       unchanged; their `queueId` is rewritten to `'default'`. If any
 *       pre-migration queue had `state === 'manually-paused'`, the unified
 *       queue is born `manually-paused` with `pauseSource: 'operator'`.
 *       Forward-only. Migrator: `migrateV5ToV6()` in
 *       `src/state/queue-state-migrator.ts`.
 *   7 — feature 065: introduces the explicit `QueueLifecycle` discriminator
 *       and the scheduled-start fields on `QueueState`
 *       (`queueLifecycle`, `scheduledStartAt`, `scheduledStartSource`).
 *       Pre-feature `QueueState` records are forward-lifted by
 *       `migrateV6ToV7()` in `src/state/queue-state-migrator.ts`. The
 *       lift preserves every pending task byte-for-byte and derives
 *       `queueLifecycle` from the legacy (`inFlightId`, `paused`,
 *       `pending.length`) triple. The `paused` boolean remains as a
 *       legacy mirror of `queueLifecycle === 'operator-paused'`.
 *       Forward-only. Down-migration is unsupported.
 *   8 — architecture hardening: freezes the raw-transcript retention mode
 *       and Git mutation-plan/approval metadata on each run. Legacy runs
 *       retain the historical `always` transcript behavior. Also introduces
 *       the separately persisted terminal-transition intent journal.
 *   9 — feature 088: introduces the connected-run aggregate under the new
 *       `schegent.connectedRuns` key. Additive and forward-only: a workspace
 *       with no such key reads as an empty collection, and no existing
 *       record's shape changes — `WorkflowRun` in particular is untouched and
 *       remains the per-Pipeline run record. Reader:
 *       `migrateConnectedRuns()` in `src/state/connected-run-migrator.ts`.
 *       Down-migration is unsupported.
 *  10 — feature 092: pluralises queue execution state. `KEYS.queue` moves from
 *       a single `QueueState` to `Record<queueId, QueueState>`, the shape that
 *       lets more than one queue drain at once. This is the deliberate reversal
 *       of the v6 collapse above, and it supplies the state migration half of
 *       the precondition the `CLAUDE.md` multi-queue-registry rule names.
 *
 *       The v6 entry stays in this history and stays true: v6 coalesced the
 *       queues that existed then, and the information needed to separate them
 *       again is not in v9 state. v10 therefore lifts the single v9 queue into
 *       a one-entry map keyed by `'default'` and fabricates nothing — an
 *       operator's pre-030 lanes are not recoverable here and must not be
 *       guessed at.
 *
 *       Every pending task is carried verbatim, `KEYS.run` is not read or
 *       written, and the `scheduledStartAt` / `queueLifecycle === 'idle-pending'`
 *       lockstep is asserted per map entry rather than once globally. The whole
 *       lift is a single-key write, so it either completes or leaves valid v9
 *       state in place; a `Memento` offers no multi-key transaction, and a
 *       half-populated workspace is a state this migration must not be able to
 *       produce. Migrator: `migrateV9ToV10()` in
 *       `src/state/queue-state-migrator.ts`. Forward-only: a persisted version
 *       above 10 is refused rather than silently discarding queues.
 *  11 — feature 093: pluralises run execution state. `KEYS.run` moves from a
 *       single `WorkflowRun | null` to `Record<queueId, WorkflowRun>`, the
 *       shape that lets more than one queue hold an executing Run at once.
 *       This is the exact complement of v10 above: v10 reshaped `KEYS.queue`
 *       and left `KEYS.run` untouched, v11 reshapes `KEYS.run` and leaves
 *       `KEYS.queue` untouched. The two migrations never overlap a key, which
 *       is what keeps each of them a single-key write.
 *
 *       `WorkflowRun` itself is unchanged — no field is added, removed or
 *       retyped. In particular no `queueId` is stamped onto the Run: the map
 *       key *is* the queue association, so it has exactly one representation
 *       and cannot disagree with a stored copy of itself. Each entry holds
 *       that queue's **active** Run only; a terminal Run leaves the map and
 *       flows into the existing Run history, so the stored size is bounded by
 *       queue count rather than by Runs ever executed.
 *
 *       A Run inherited from v10 is keyed by the queue its Task belongs to. If
 *       that Task belongs to no queue, the Run is reassigned to `'default'`
 *       with an audit event naming the reason rather than dropped — dropping
 *       the Run would not drop the Task pointing at it, leaving a queue stuck
 *       on work nothing is left to advance or terminate. Migrator:
 *       `migrateV10ToV11()` in `src/state/run-state-migrator.ts`.
 *       Forward-only: a persisted version above 11 is refused rather than
 *       silently discarding runs.
 *  12 — FR-R3-010: partitions run history. `KEYS.history` moves from one flat
 *       `HistoryEntry[]` capped at 50 across the whole workspace to
 *       `Record<queueId, HistoryEntry[]>` capped at 50 per queue. The third
 *       key-pluralising step in the same family as v10 and v11, and like both
 *       of them a single-key write: v10 reshaped `KEYS.queue`, v11 `KEYS.run`,
 *       v12 `KEYS.history`, and no two of them overlap a key.
 *
 *       The cap's number is unchanged and its denominator is not. 50 across up
 *       to `MAX_QUEUES` queues retained an average of 2.5 runs each and let one
 *       busy queue evict every other queue's record of itself; 50 per queue is
 *       the depth the constant always read as describing.
 *
 *       No `queueId` is stamped onto an entry — the map key *is* the queue
 *       association, so it has one representation and cannot disagree with a
 *       stored copy of itself, exactly as in v11.
 *
 *       An inherited entry is filed under the queue that owns the Task it
 *       names. An entry whose Task belongs to no queue goes to the documented
 *       `HISTORY_UNATTRIBUTED_QUEUE_ID` partition with one audit event naming
 *       the count and the reason — not dropped, because those runs happened,
 *       and not defaulted to `'default'`, because that files them under a queue
 *       that did not run them. The migration never re-caps and never deletes.
 *       Migrator: `migrateV11ToV12()` in `src/state/history-state-migrator.ts`.
 *       Forward-only: a persisted version above 12 is refused rather than
 *       silently discarding history.
 *  13 — FR-R3-011: collapses queue pause state to one persisted value. Before
 *       this step "is this queue paused" was written three times across two
 *       memento keys — `QueueRegistryEntry.state` (+ `pauseSource`) in
 *       `KEYS.queueRegistry`, and `QueueState.queueLifecycle` plus the legacy
 *       `QueueState.paused` / `pausedReason` mirrors in `KEYS.queue`. The
 *       memento offers no multi-key transaction, so every pause was two writes
 *       with a window between them, and a window disposed inside that gap left
 *       the pair split. `reconcileQueuePauseStateIfDivergent()` existed to
 *       repair exactly that, and its existence was the proof the three could
 *       disagree.
 *
 *       After v13, `QueueState.queueLifecycle === 'operator-paused'` is the
 *       whole answer and `QueueState.pauseSource` its attribution; both live in
 *       one entry of one key, so a pause is one write and a split pair is
 *       unrepresentable rather than repaired. The registry's `state` and
 *       `pauseSource` are **derived on read** by `projectQueueRegistry()` in
 *       `src/queue/queue-registry.ts` and are gone from the persisted entry.
 *
 *       Per-entry winner, applied when the representations disagree: **any
 *       representation reading paused wins.** The directions are not
 *       symmetric — resolving to paused costs an operator one Resume click,
 *       resolving the other way starts work nobody asked for. A queue that is not
 *       paused keeps its existing `queueLifecycle` verbatim; the migration
 *       never re-derives a lifecycle from `(inFlightId, paused, pendingCount)`,
 *       which is the specific behaviour that made the retired reconciler able
 *       to overwrite a legitimately held `idle-pending`.
 *
 *       Two single-key writes, queue record first: the authoritative value is
 *       in place before the now-derived copy is removed, and a window lost
 *       between them leaves inert leftovers that `projectQueueRegistry()`
 *       overwrites on every read. Migrator: `migrateV12ToV13()` in
 *       `src/state/queue-state-migrator.ts`. Forward-only: a persisted version
 *       above 13 is refused rather than silently unpausing queues.
 *
 *  14 — FR-R3-117. `hostVerification` changed what an ABSENT value means: it used
 *       to mean `model-token` (self-report) and now means the resolved default,
 *       which is `exit-code` for any Phase whose resolved `sideEffects` is other
 *       than `'none'`. A snapshot written at v13 or earlier stores the value the
 *       old rule produced, and reading it under the new rule would guess. So the
 *       migrator stamps the RESOLVED value and its provenance into every phase of
 *       every persisted plan snapshot. Migrator: `migrateV13ToV14()` in
 *       `src/state/host-verification-migrator.ts`. Forward-only.
 *
 *       Note the direction carefully: a v<=13 snapshot's absent `hostVerification`
 *       meant self-report, so the migration PRESERVES that Run's original verdict
 *       basis rather than retroactively tightening a plan the operator already
 *       approved. A frozen plan is never retargeted in flight; the new default
 *       applies to plans frozen after the upgrade.
 */
export const STATE_SCHEMA_VERSION = 14 as const;

export const STATE_SCHEMA_VERSION_V2 = 2 as const;
export const STATE_SCHEMA_VERSION_V3 = 3 as const;
export const STATE_SCHEMA_VERSION_V4 = 4 as const;
export const STATE_SCHEMA_VERSION_V5 = 5 as const;
export const STATE_SCHEMA_VERSION_V6 = 6 as const;
export const STATE_SCHEMA_VERSION_V7 = 7 as const;
export const STATE_SCHEMA_VERSION_V8 = 8 as const;
export const STATE_SCHEMA_VERSION_V9 = 9 as const;
export const STATE_SCHEMA_VERSION_V10 = 10 as const;
export const STATE_SCHEMA_VERSION_V11 = 11 as const;
export const STATE_SCHEMA_VERSION_V12 = 12 as const;
export const STATE_SCHEMA_VERSION_V13 = 13 as const;
export const STATE_SCHEMA_VERSION_V14 = 14 as const;

export interface VersionedRecord {
  readonly schemaVersion: number;
}
