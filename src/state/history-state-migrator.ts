// ---------------------------------------------------------------------------
// FR-R3-010 (T406) — v11 → v12 migration: partition `KEYS.history` by queue.
//
// One flat `HistoryEntry[]`, capped at 50 across the whole workspace, becomes
// `Record<queueId, HistoryEntry[]>` capped at 50 per queue. It is the third in
// the same family as the v9 → v10 queue lift and the v10 → v11 run lift: one
// key, one shape change, one write, and no rollback.
//
// Like every migrator in this repo it is a **pure** function over the record it
// is handed. It has no store, so `KEYS.queue` is not merely left alone — there
// is nothing here that could reach it. The task → queue resolver is injected
// for exactly that reason, and the clock so every emitted event carries a
// stamp the caller chose rather than one this module read.
//
// What it does NOT do, deliberately:
//
//   - It does not re-cap. A legacy array holds at most 50 entries and each
//     partition it produces therefore holds at most 50, so the per-queue cap is
//     satisfied on arrival. Applying the cap here would mean a migration that
//     *deletes* records, and a forward-only step that destroys data on the way
//     past is the one kind that cannot be re-attempted.
//   - It does not move the description out of the entries it carries forward.
//     T405 changed what new entries store; migrating old ones would mean
//     writing files from inside a pure function. A legacy entry keeps its
//     `originalDescription` and the readers keep handling it — which they must
//     anyway, for every workspace that never opens a build with this migration.
// ---------------------------------------------------------------------------

import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../contracts/queue-identity';
import { STATE_SCHEMA_VERSION_V12 } from '../contracts/state-schema';

/** The v12 persisted shape of `KEYS.history`. */
export type HistoryStateMap = Record<string, object[]>;

/**
 * Audit payload for the v11 → v12 reshape.
 *
 * Queue **identifiers** and counts only, the same discipline as the v10 → v11
 * event next door. A history entry carries a task description, an error
 * summary, and a feature id; none of the three belongs in the structured audit
 * log, and a count of entries answers everything an auditor needs from a
 * migration anyway.
 */
export interface StateMigratedV11ToV12AuditEvent {
  readonly type: 'state-migrated-v11-to-v12';
  readonly fromVersion: 11;
  readonly toVersion: 12;
  readonly occurredAt: number;
  readonly queueIds: readonly string[];
  readonly entryCount: number;
}

/**
 * Entries the migration could not attribute to a queue, filed under the
 * documented fallback partition.
 *
 * Emitted once with a count rather than once per entry: a flat history holds up
 * to 50 rows and every one of them could be unattributable, and 50 audit events
 * saying the same thing is noise that buries the one fact worth recording.
 *
 * This is the honest outcome, not a failure. A legacy entry names a Task, and a
 * Task that has since been removed from every queue leaves nothing to attribute
 * with. The alternatives were both worse: dropping the entries loses the
 * workspace's record of runs that really happened, and defaulting them to
 * `DEFAULT_QUEUE_ID` files them under a queue that did not run them, which is
 * an answer that looks right.
 */
export interface HistoryEntriesUnattributedAuditEvent {
  readonly type: 'history-entries-unattributed';
  readonly occurredAt: number;
  readonly queueId: typeof HISTORY_UNATTRIBUTED_QUEUE_ID;
  readonly entryCount: number;
  readonly reason: 'task-not-in-any-queue';
}

/** The record at `KEYS.history` was not a shape this migrator recognises. */
export interface HistoryRecordRepairedAuditEvent {
  readonly type: 'history-record-repaired';
  readonly occurredAt: number;
  readonly reason: 'unrecognised-record-shape';
}

export type HistoryStateMigrationAuditEvent =
  | StateMigratedV11ToV12AuditEvent
  | HistoryEntriesUnattributedAuditEvent
  | HistoryRecordRepairedAuditEvent;

export interface MigrateV11ToV12Result {
  readonly history: HistoryStateMap;
  /** `false` ⇒ the caller performs no write at all. */
  readonly changed: boolean;
  readonly events: readonly HistoryStateMigrationAuditEvent[];
}

/**
 * A v12 record: an object whose every value is an array.
 *
 * An **empty** object qualifies. `{}` is the ordinary steady state of a
 * migrated workspace that has completed no runs, and treating it as
 * unrecognised would rewrite the key and emit a repair event on every window
 * open until the first run finished.
 *
 * The *contents* of the arrays are not checked. `ensureHistoryEntry` is the
 * oracle for what a valid row is, it runs on every read, and it already drops
 * what it cannot read. Duplicating its rules here would be a second oracle free
 * to disagree — and disagreeing would mean a migration that discards rows the
 * reader would have accepted.
 */
export function isHistoryStateMap(raw: unknown): raw is HistoryStateMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  return Object.values(raw as Record<string, unknown>).every((value) => Array.isArray(value));
}

function reshapeEvent(history: HistoryStateMap, now: number): StateMigratedV11ToV12AuditEvent {
  const queueIds = Object.keys(history);
  return {
    type: 'state-migrated-v11-to-v12',
    fromVersion: 11,
    toVersion: STATE_SCHEMA_VERSION_V12,
    occurredAt: now,
    queueIds,
    entryCount: queueIds.reduce((total, queueId) => total + history[queueId].length, 0)
  };
}

/**
 * Reshape a v11 persisted history record into the v12 partitioned shape.
 *
 * Returns `changed: false` only for a record already in v12 shape. Every other
 * input — absent, a flat array, or something unreadable — produces a written
 * map, because the shape at `KEYS.history` is what the rest of the system now
 * reads and a flat array left in place would hand a per-queue reader a list of
 * entries where it expects a record of lists.
 *
 * @param raw            the value currently at `KEYS.history`
 * @param queueIdForTask resolves a Task id to its queue; `null` when the Task
 *                       belongs to no queue in the persisted registry
 * @param now            injected clock, stamped on every emitted event
 */
export function migrateV11ToV12(
  raw: unknown,
  queueIdForTask: (taskId: string) => string | null,
  now: number = Date.now()
): MigrateV11ToV12Result {
  if (isHistoryStateMap(raw)) {
    return { history: raw, changed: false, events: [] };
  }

  if (raw === null || raw === undefined) {
    return { history: {}, changed: true, events: [reshapeEvent({}, now)] };
  }

  if (!Array.isArray(raw)) {
    // Not an array, not a map of arrays. Repaired to "no history" rather than
    // guessed at: an unreadable value cannot be turned into a plausible one,
    // and fabricating rows would put runs in the record that never happened.
    return {
      history: {},
      changed: true,
      events: [
        reshapeEvent({}, now),
        { type: 'history-record-repaired', occurredAt: now, reason: 'unrecognised-record-shape' }
      ]
    };
  }

  const history: HistoryStateMap = {};
  let unattributed = 0;
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const featureId = (row as { featureId?: unknown }).featureId;
    const resolved = typeof featureId === 'string' ? queueIdForTask(featureId) : null;
    if (resolved === null) unattributed += 1;
    const queueId = resolved ?? HISTORY_UNATTRIBUTED_QUEUE_ID;
    (history[queueId] ??= []).push(row as object);
  }

  const events: HistoryStateMigrationAuditEvent[] = [reshapeEvent(history, now)];
  if (unattributed > 0) {
    events.push({
      type: 'history-entries-unattributed',
      occurredAt: now,
      queueId: HISTORY_UNATTRIBUTED_QUEUE_ID,
      entryCount: unattributed,
      reason: 'task-not-in-any-queue'
    });
  }

  return { history, changed: true, events };
}
