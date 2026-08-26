// Feature 092 (T092, FR-011, FR-022) — the registry's own projection: one
// `QueueSummary` per queue entry.
//
// Extracted from `queue-projector.ts`, not newly written. Feature 030 published
// only `entries[0]` because the registry could hold one entry, so a summary read
// was a couple of lines beside the row projection. Raising `MAX_QUEUES` turned it
// into a per-entry fold with its own schedule sub-projection and its own
// per-queue counting rule, which is a different responsibility from mapping a
// `FeatureRequest` to a `QueueItem`; the row family stays where it was.
//
// This projection is UI-only and never persisted.

import type { FeatureRequest } from '../../queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../contracts/queue-identity';
import { type ProjectedQueueRegistry } from '../../queue/queue-registry';
import type { QueueSummary } from './snapshot';

export function projectQueues(
  // FR-R3-011 — the **projected** registry, not the persisted one. `state` and
  // `pauseSource` are no longer stored on an entry; they are filled in on read
  // from the owning `QueueState`, so a summary reads the same single value the
  // drain gate does instead of a copy that could disagree with it.
  registry: ProjectedQueueRegistry | undefined,
  requests: readonly FeatureRequest[],
  requestsOf: ((queueId: string) => readonly FeatureRequest[]) | undefined
): QueueSummary[] {
  // One summary per registry entry, in position order. Reading just the first
  // now would mean a queue the operator created is invisible on every surface.
  if (!registry) return [];
  return [...registry.entries]
    .sort((a, b) => a.position - b.position)
    .map((entry) => {
      // Own rows only. The caller's `requests` answer for the queue the row
      // projection was invoked with; anything else needs the lookup, and without
      // one the count is zero rather than a borrowed total that would
      // over-report every queue.
      const rows = requestsOf
        ? requestsOf(entry.id)
        : entry.id === DEFAULT_QUEUE_ID
          ? requests
          : [];
      return {
        id: entry.id,
        name: entry.name,
        position: entry.position,
        state: entry.state,
        // Feature 028 — surface the queue's pause source so the dashboard
        // can render a "cascaded" badge alongside the manually-paused
        // indicator. FR-R3-011 — projected from `QueueState.pauseSource`; the
        // registry entry no longer stores one.
        pauseSource: entry.pauseSource,
        schedule: projectSchedule(entry),
        taskCount: rows.filter(
          (request) => request.status === 'pending' || request.status === 'in-flight'
        ).length
      };
    });
}

/**
 * Feature 092 (FR-011) — a queue's own schedule, which feature 030 pinned to
 * `null` because a single default queue could not carry one.
 */
function projectSchedule(entry: ProjectedQueueRegistry['entries'][number]): QueueSummary['schedule'] {
  const schedule = entry.schedule;
  if (!schedule) return null;
  return {
    expression: schedule.expression,
    kind: schedule.kind,
    targetAt: new Date(schedule.targetAt).toISOString()
  };
}
