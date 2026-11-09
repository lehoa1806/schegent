/**
 * FR-R6-F06 (FR-014, research R7) — one `BEGIN IMMEDIATE` transaction around accounting writes.
 *
 * The F04 connection has no transaction helper; this follows the `catalog-config-store.ts`
 * precedent (BEGIN IMMEDIATE, COMMIT, or ROLLBACK and rethrow). A call made while a transaction
 * is already open joins it, so a helper can be used inside a larger unit of work.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { NodeSqliteConnection } from '../sqlite-store';

/**
 * Read through a call so the compiler does not carry the narrowing from the first check past
 * `work()`, which can open or close the transaction itself.
 */
function inTransaction(conn: NodeSqliteConnection): boolean {
  return conn.db.isTransaction;
}

export function inImmediateTransaction<T>(conn: NodeSqliteConnection, work: () => T): T {
  if (inTransaction(conn)) return work();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    if (inTransaction(conn)) conn.exec('ROLLBACK');
    throw error;
  }
}
