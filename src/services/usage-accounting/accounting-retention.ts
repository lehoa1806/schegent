/**
 * FR-R6-F06 (T045, FR-016, research R10) — retention and the compaction floor.
 *
 * `pruneExpired` runs in one `BEGIN IMMEDIATE` transaction and removes, past the horizon:
 * - closed contribution rows whose closing revision was committed before the horizon;
 * - corrections no contribution row references any more;
 * - observations no contribution row selects and no pending intent references, with their
 *   applied intents (their measures cascade).
 *
 * It never removes an open contribution, the observation or correction an open contribution
 * stands on, or the observation holding the highest `ingest_seq` (so a sequence is never
 * reused). Removing a closed row closed at revision `t` makes every read below `t` inexact,
 * so the revisions below the highest such `t` are deleted too: the compaction floor is
 * `MIN(revision)` of what remains, and a read below it answers `revision-compacted`.
 *
 * Event and commit instants are compared through `julianday`, since `event_utc` keeps the
 * source's ISO text.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';

export interface PruneResult {
  readonly observationsPruned: number;
  readonly historyRowsPruned: number;
}

const MS_PER_DAY = 86_400_000;
/** `pruneExpired` runs before an ingest once the retained count is within 1% of the bound. */
const NEAR_BOUND_DIVISOR = 100;

const EXPIRED_CLOSED_ROWS = `FROM accounting_contributions
  WHERE to_revision IN (SELECT revision FROM accounting_revisions WHERE julianday(committed_utc) < julianday(?))`;

const PRUNABLE_OBSERVATIONS = `SELECT o.observation_id FROM accounting_observations o
  WHERE julianday(o.event_utc) < julianday(?)
    AND o.ingest_seq < (SELECT MAX(ingest_seq) FROM accounting_observations)
    AND NOT EXISTS (SELECT 1 FROM accounting_contributions c WHERE c.selected_observation_id = o.observation_id)
    AND NOT EXISTS (SELECT 1 FROM accounting_projection_intents i WHERE i.observation_id = o.observation_id AND i.state = 'pending')`;

function horizonCutoff(nowUtc: string, horizonDays: number): string {
  return new Date(Date.parse(nowUtc) - horizonDays * MS_PER_DAY).toISOString();
}

/** The lowest revision a read can still answer exactly; 0 when no revision exists. */
export function compactionFloor(conn: NodeSqliteConnection): number {
  return Number(conn.scalar('SELECT COALESCE(MIN(revision), 0) FROM accounting_revisions') ?? 0);
}

/** Prunes expired, non-authoritative detail. Idempotent; see the module comment. */
export function pruneExpired(conn: NodeSqliteConnection, nowUtc: string, horizonDays: number): PruneResult {
  const cutoff = horizonCutoff(nowUtc, horizonDays);
  return inImmediateTransaction(conn, (): PruneResult => {
    const floor = Number(conn.scalar(`SELECT COALESCE(MAX(to_revision), 0) ${EXPIRED_CLOSED_ROWS}`, cutoff) ?? 0);
    const closedRows = conn.run(`DELETE ${EXPIRED_CLOSED_ROWS}`, cutoff).changes;
    if (floor > 0) conn.run('DELETE FROM accounting_revisions WHERE revision < ?', floor);
    const corrections = conn.run(
      `DELETE FROM accounting_corrections
        WHERE julianday(recorded_utc) < julianday(?)
          AND NOT EXISTS (SELECT 1 FROM accounting_contributions c WHERE c.correction_id = accounting_corrections.correction_id)`,
      cutoff
    ).changes;
    conn.run(`DELETE FROM accounting_projection_intents WHERE state = 'applied' AND observation_id IN (${PRUNABLE_OBSERVATIONS})`, cutoff);
    const observations = conn.run(`DELETE FROM accounting_observations WHERE observation_id IN (${PRUNABLE_OBSERVATIONS})`, cutoff).changes;
    return { observationsPruned: observations, historyRowsPruned: closedRows + corrections };
  });
}

/**
 * True when the retained count is within 1% of `maxRetained`. `MAX(ingest_seq)` bounds the
 * count from above, so the count itself is read only near the bound.
 */
export function isNearRetentionBound(conn: NodeSqliteConnection, maxRetained: number): boolean {
  const threshold = maxRetained - Math.floor(maxRetained / NEAR_BOUND_DIVISOR);
  const highest = Number(conn.scalar('SELECT COALESCE(MAX(ingest_seq), 0) FROM accounting_observations') ?? 0);
  if (highest < threshold) return false;
  return Number(conn.scalar('SELECT count(*) FROM accounting_observations') ?? 0) >= threshold;
}
