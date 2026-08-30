// ---------------------------------------------------------------------------
// Feature 093 — v10 → v11 migration: pluralise `KEYS.run`. One
// `WorkflowRun | null` becomes `Record<queueId, WorkflowRun>`, the shape that
// lets more than one queue hold an executing Run at once.
//
// This is the exact complement of the v9 → v10 lift in
// `queue-state-migrator.ts`, which pluralised `KEYS.queue` and documented
// leaving `KEYS.run` untouched. The two migrations never overlap a key, and
// that is what keeps each of them a single-key write — a `Memento` offers no
// multi-key transaction, so a half-populated workspace has to be unreachable by
// construction rather than by care (`src/contracts/state-schema.ts:74-78`).
//
// Like every migrator in this repo it is a **pure** function over the record it
// is handed. It has no store, so `KEYS.queue` is not merely left alone — there
// is nothing here that could reach it. The clock and the task→queue resolver
// are injected for the same reason: the resolver in particular keeps the
// migrator free of the queue manager, which would otherwise drag the whole
// registry into a function that runs before the registry is loaded.
// ---------------------------------------------------------------------------

import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { STATE_SCHEMA_VERSION_V11 } from '../contracts/state-schema';
import type { WorkflowRun, WorkflowRunStatus } from './workflow-run';

/**
 * The v11 persisted shape of `KEYS.run`: at most one **active** `WorkflowRun`
 * per queue, keyed by queue id. A queue with no Run executing has no key —
 * absence is the empty state, never a stored `null`.
 */
export type RunStateMap = Record<string, WorkflowRun>;

/**
 * Why a Run or a record needed repairing. A closed set of codes, never free
 * text: the structured audit log is not a place for operator-authored content,
 * and a code is what an auditor can correlate anyway.
 */
export type RunStateRepairReason = 'task-not-in-any-queue' | 'unrecognised-record-shape';

/**
 * Audit payload for the v10 → v11 reshape.
 *
 * Queue **identifiers** and counts only — the same payload discipline as
 * `StateMigratedV9ToV10AuditEvent`. Queue names, task descriptions and pipeline
 * names are all operator-authored.
 */
export interface StateMigratedV10ToV11AuditEvent {
  readonly type: 'state-migrated-v10-to-v11';
  readonly fromVersion: 10;
  readonly toVersion: 11;
  readonly occurredAt: number;
  readonly queueIds: readonly string[];
  readonly runCount: number;
}

/**
 * A Run whose Task belongs to no queue was moved to the default queue.
 *
 * It is **not** dropped (FR-003, FR-006): dropping the Run does not drop the
 * Task that points at it, so the Task would keep its in-flight status with
 * nothing left to advance or terminate it — a queue stuck forever on work
 * nothing is running. Reassignment keeps the Run addressable and cancellable,
 * and this event is the record of why it is where it is.
 */
export interface RunReassignedToDefaultQueueAuditEvent {
  readonly type: 'run-reassigned-to-default-queue';
  readonly occurredAt: number;
  readonly runId: string;
  readonly queueId: typeof DEFAULT_QUEUE_ID;
  readonly reason: 'task-not-in-any-queue';
}

/** The record at `KEYS.run` was not a shape this migrator recognises. */
export interface RunRecordRepairedAuditEvent {
  readonly type: 'run-record-repaired';
  readonly occurredAt: number;
  readonly reason: 'unrecognised-record-shape';
}

export type RunStateMigrationAuditEvent =
  | StateMigratedV10ToV11AuditEvent
  | RunReassignedToDefaultQueueAuditEvent
  | RunRecordRepairedAuditEvent;

export interface MigrateV10ToV11Result {
  readonly runs: RunStateMap;
  /** `false` ⇒ the caller performs no write at all. */
  readonly changed: boolean;
  readonly events: readonly RunStateMigrationAuditEvent[];
}

const RUN_STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>([
  'running',
  'paused',
  'failed',
  'completed',
  'canceled'
]);

/**
 * A v10 record: a single `WorkflowRun`, recognisable by its identity triple.
 *
 * Exported for `WorkspaceStateStore.readRunMap()`, which needs the same rule to
 * tell a pre-migration record from a migrated one on a read taken before
 * `initialize()` has written. A second copy of the rule there would be free to
 * disagree with this one about what counts as a Run, and the disagreement would
 * surface as a workspace that reads as empty on one path and occupied on the
 * other.
 */
export function isWorkflowRun(raw: unknown): raw is WorkflowRun {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const candidate = raw as Partial<WorkflowRun>;
  return (
    typeof candidate.id === 'string'
    && typeof candidate.featureId === 'string'
    && typeof candidate.status === 'string'
    && RUN_STATUSES.has(candidate.status)
  );
}

/**
 * A v11 record: a map whose every value is a `WorkflowRun`.
 *
 * Exported alongside `isWorkflowRun` for `normalizeRunForInitialize()`, which
 * runs before this migrator and so must tell the two shapes apart to write each
 * back in the shape it arrived in.
 *
 * An **empty** object qualifies, unlike the v10 map predicate next door. There
 * the empty case was ambiguous because a queue record always exists; here `{}`
 * is the ordinary steady state of a migrated workspace with nothing executing,
 * and treating it as unrecognised would rewrite `KEYS.run` and emit a repair
 * event on every window open where no Run happens to be running.
 */
export function isRunStateMap(raw: unknown): raw is RunStateMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  return Object.values(raw as Record<string, unknown>).every(isWorkflowRun);
}

function reshapeEvent(runs: RunStateMap, now: number): StateMigratedV10ToV11AuditEvent {
  const queueIds = Object.keys(runs);
  return {
    type: 'state-migrated-v10-to-v11',
    fromVersion: 10,
    toVersion: STATE_SCHEMA_VERSION_V11,
    occurredAt: now,
    queueIds,
    runCount: queueIds.length
  };
}

/**
 * Reshape a v10 persisted run record into the v11 map shape.
 *
 * Returns `changed: false` only for a record already in v11 shape, which is the
 * one case where the caller must write nothing. Every other input — absent,
 * a single Run, or a record this migrator cannot read — produces a written map,
 * because the shape at `KEYS.run` is what the rest of the system now reads and
 * leaving a v10-shaped value in place would hand it a `WorkflowRun` where it
 * expects a record of them.
 *
 * @param raw            the value currently at `KEYS.run`
 * @param queueIdForTask resolves a Task id to its queue; `null` when the Task
 *                       belongs to no queue in the persisted registry
 * @param now            injected clock, stamped on every emitted event
 */
export function migrateV10ToV11(
  raw: unknown,
  queueIdForTask: (taskId: string) => string | null,
  now: number = Date.now()
): MigrateV10ToV11Result {
  if (isRunStateMap(raw)) {
    return { runs: raw, changed: false, events: [] };
  }

  if (raw === null || raw === undefined) {
    return { runs: {}, changed: true, events: [reshapeEvent({}, now)] };
  }

  if (!isWorkflowRun(raw)) {
    // Not a Run, not a map of Runs. The record is repaired to "no Run
    // executing" rather than guessed at: an unreadable value cannot be
    // converted into a plausible one, and a fabricated Run would hand the
    // drain coordinator a queue that looks busy forever.
    return {
      runs: {},
      changed: true,
      events: [
        reshapeEvent({}, now),
        {
          type: 'run-record-repaired',
          occurredAt: now,
          reason: 'unrecognised-record-shape'
        }
      ]
    };
  }

  const resolved = queueIdForTask(raw.featureId);
  const queueId = resolved ?? DEFAULT_QUEUE_ID;
  const runs: RunStateMap = { [queueId]: raw };
  const events: RunStateMigrationAuditEvent[] = [reshapeEvent(runs, now)];

  if (resolved === null) {
    events.push({
      type: 'run-reassigned-to-default-queue',
      occurredAt: now,
      runId: raw.id,
      queueId: DEFAULT_QUEUE_ID,
      reason: 'task-not-in-any-queue'
    });
  }

  return { runs, changed: true, events };
}
