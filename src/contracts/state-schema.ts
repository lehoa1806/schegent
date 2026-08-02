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
 */
export const STATE_SCHEMA_VERSION = 8 as const;

export const STATE_SCHEMA_VERSION_V2 = 2 as const;
export const STATE_SCHEMA_VERSION_V3 = 3 as const;
export const STATE_SCHEMA_VERSION_V4 = 4 as const;
export const STATE_SCHEMA_VERSION_V5 = 5 as const;
export const STATE_SCHEMA_VERSION_V6 = 6 as const;
export const STATE_SCHEMA_VERSION_V7 = 7 as const;
export const STATE_SCHEMA_VERSION_V8 = 8 as const;

export interface VersionedRecord {
  readonly schemaVersion: number;
}
