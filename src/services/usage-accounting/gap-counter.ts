/**
 * FR-R6-F06 (FR-015, NFR-002) — counted gaps, keyed by (gap kind, scope).
 *
 * The scope is an attempt id, a root id, `unattributed` or `global`. At most `maxGapKeys`
 * keys are kept: once the table holds that many, a new key folds into `(kind, 'global')`, so
 * the count is never lost and the table stays bounded (at most one extra `global` row per kind).
 *
 * Callers run this inside their own transaction.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { GapKind } from '../../contracts/usage-accounting/accounting-types';
import type { NodeSqliteConnection } from '../sqlite-store';

export const GLOBAL_GAP_SCOPE = 'global';
export const UNATTRIBUTED_GAP_SCOPE = 'unattributed';

export function recordGap(
  conn: NodeSqliteConnection,
  kind: GapKind,
  scope: string,
  nowUtc: string,
  maxGapKeys: number,
  increment = 1
): void {
  const exists = conn.get<{ one: number }>(
    'SELECT 1 AS one FROM accounting_gaps WHERE gap_kind = ? AND scope_key = ?',
    kind,
    scope
  );
  let scopeKey = scope;
  if (exists === undefined) {
    const keys = Number(conn.scalar('SELECT count(*) FROM accounting_gaps') ?? 0);
    if (keys >= maxGapKeys) scopeKey = GLOBAL_GAP_SCOPE;
  }
  conn.run(
    `INSERT INTO accounting_gaps (gap_kind, scope_key, count, first_seen_utc, last_seen_utc)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (gap_kind, scope_key) DO UPDATE SET count = count + excluded.count, last_seen_utc = excluded.last_seen_utc`,
    kind,
    scopeKey,
    increment,
    nowUtc,
    nowUtc
  );
}
