/**
 * Durable post-cutover authority tombstone and shared pure helpers extracted from
 * `sqlite-operational-backing.ts` so every module under `src/state/` remains well
 * under the 1,100-line ceiling (`tests/lint/layer-dependency-direction.test.ts`).
 *
 * - Persists a durable cutover tombstone (`KEYS.sqliteCutoverAuthority`) in the legacy
 *   VS Code Memento once SQLite cutover completes (or backfills it on any primary attach).
 * - When the tombstone is present and SQLite is neither attached nor snapshot-loaded,
 *   all operational writes are refused with `QueueMutationRejected('durable-store-unavailable')`
 *   and operational reads do not fall back to stale pre-cutover Memento state.
 * - Refuses mixed passthrough + operational `updateBatch()` calls explicitly because
 *   cross-store atomicity across Memento and SQLite is not supported.
 *
 * Zero `vscode` imports (keeps module headless-testable).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { SQLITE_SCHEMA_CURRENT_VERSION } from '../contracts/sqlite-store/schema-types';
import type { SanitizedLogger } from '../lib/logger';
import {
  deepFreezeValue,
  isDeepEqualJsonValue,
  isPlainRecord,
  parseStrictSchemaMetaVersion
} from '../lib/operational-value-helpers';
import { deepFreezeConnectedRunsDocument } from './connected-run-migrator';
import type { SqliteConnectionPort } from './sqlite-operational-port';
import { readOperationalQueueMapFromDb, readOperationalRunMapFromDb } from './sqlite-operational-rows';
import { deepFreezeTerminalJournalDocument } from './terminal-transition-journal';
import { KEYS, QueueMutationRejected, type Memento } from './workspace-state-types';

export interface SqliteCutoverAuthorityTombstone {
  readonly scopeId: string;
  readonly cutoverAt: number;
}

export type CutoverAuthorityMode =
  | 'pre-cutover'
  | 'sqlite-primary'
  | 'sqlite-readonly'
  | 'sqlite-unavailable-post-cutover';

export interface CutoverAuthorityStatus {
  readonly mode: CutoverAuthorityMode;
  readonly scopeId: string | null;
  readonly cutoverAt: number | null;
  readonly reason: string | null;
}

/**
 * Raised when a single `updateBatch()` mixes passthrough ownership keys (stored in
 * legacy Memento) with operational keys (stored in SQLite), which cannot commit atomically.
 */
export class MixedOperationalBatchError extends Error {
  public readonly code = 'mixed-operational-batch-forbidden' as const;

  public constructor(passthroughKeys: readonly string[], operationalKeys: readonly string[]) {
    super(
      `Refused mixed updateBatch combining passthrough keys [${passthroughKeys.join(', ')}] ` +
        `with operational keys [${operationalKeys.join(', ')}]: cross-store atomicity is not supported.`
    );
    this.name = 'MixedOperationalBatchError';
  }
}

export function readCutoverAuthorityTombstone(
  legacyMemento: Memento
): SqliteCutoverAuthorityTombstone | null {
  const raw = legacyMemento.get<unknown>(KEYS.sqliteCutoverAuthority);
  if (!isPlainRecord(raw)) return null;
  const scopeId = raw.scopeId;
  const cutoverAt = raw.cutoverAt;
  if (
    typeof scopeId !== 'string' ||
    scopeId.length === 0 ||
    typeof cutoverAt !== 'number' ||
    !Number.isFinite(cutoverAt) ||
    cutoverAt < 0
  ) {
    return null;
  }
  return { scopeId, cutoverAt };
}

export function persistCutoverAuthorityTombstone(
  legacyMemento: Memento,
  scopeId: string,
  cutoverAt: number,
  logger?: SanitizedLogger
): Promise<void> {
  const existing = readCutoverAuthorityTombstone(legacyMemento);
  if (existing !== null && existing.scopeId === scopeId) {
    return Promise.resolve();
  }
  const tombstone: SqliteCutoverAuthorityTombstone = { scopeId, cutoverAt };
  try {
    return Promise.resolve(legacyMemento.update(KEYS.sqliteCutoverAuthority, tombstone)).catch(
      (err: unknown) => {
        logger?.warn('failed to persist sqlite cutover authority tombstone', {
          scopeId,
          error: err instanceof Error ? err.name : typeof err
        });
      }
    );
  } catch (err: unknown) {
    logger?.warn('failed to persist sqlite cutover authority tombstone', {
      scopeId,
      error: err instanceof Error ? err.name : typeof err
    });
    return Promise.resolve();
  }
}

export function buildDurableStoreUnavailableError(
  keyLabel: string,
  scopeId: string | null,
  reason: string | null
): QueueMutationRejected {
  const scopeDetail = scopeId !== null ? ` in scope '${scopeId}'` : '';
  const reasonDetail = reason !== null && reason.length > 0 ? ` (${reason})` : '';
  return new QueueMutationRejected(
    'durable-store-unavailable',
    `Refused operational write for ${keyLabel}${scopeDetail}: durable SQLite store is unavailable${reasonDetail}.`
  );
}

export function isSameSerializedState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return isDeepEqualJsonValue(a, b);
  } catch {
    return false;
  }
}

export function parseAndFreezeKvDocument(
  docKey: string,
  payloadJson: string,
  logger?: SanitizedLogger
): { readonly present: true; readonly value: unknown } | { readonly present: false } {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (docKey !== KEYS.connectedRuns && docKey !== KEYS.terminalTransitionIntent) {
      return { present: true, value: deepFreezeValue(parsed) };
    }
    const frozen =
      docKey === KEYS.connectedRuns
        ? deepFreezeConnectedRunsDocument(parsed)
        : deepFreezeTerminalJournalDocument(parsed);
    if (frozen.quarantinedCount > 0) {
      logger?.warn(
        `quarantined unfreezable ${docKey === KEYS.connectedRuns ? 'connectedRuns' : 'terminalTransitionIntent'} entries on reload`,
        {
          count: frozen.quarantinedCount,
          keys: frozen.quarantinedKeys
        }
      );
    }
    return { present: true, value: frozen.value };
  } catch {
    logger?.warn('corrupt operational_kv_documents payload skipped', { key: docKey });
    return docKey === KEYS.connectedRuns ||
      docKey === KEYS.controlLedger ||
      docKey === KEYS.terminalTransitionIntent
      ? { present: true, value: null }
      : { present: false };
  }
}

export function readOperationalSnapshotFromConnection(
  roConn: SqliteConnectionPort,
  scopeId: string
): Map<string, unknown> | null {
  roConn.exec('BEGIN');
  try {
    const minReaderRow = roConn.get<{ meta_value: string }>(
      `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
    );
    if (minReaderRow !== undefined) {
      const floor = parseStrictSchemaMetaVersion(minReaderRow.meta_value);
      if (floor === null || floor > SQLITE_SCHEMA_CURRENT_VERSION) return null;
    }
    const sentinel = roConn.get<{ authority: string }>(
      `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
      scopeId
    );
    if (!sentinel || (sentinel.authority !== 'sqlite' && sentinel.authority !== 'retired_legacy')) {
      return null;
    }
    const rows = roConn.all<{ doc_key: string; payload_json: string }>(
      `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
      scopeId
    );
    const snapshot = new Map<string, unknown>();
    for (const row of rows) {
      const loaded = parseAndFreezeKvDocument(row.doc_key, row.payload_json);
      if (loaded.present) snapshot.set(row.doc_key, loaded.value);
    }
    const hasEntityTables =
      roConn.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_queue_meta'`
      ) !== undefined;
    if (hasEntityTables) {
      const ignoreCorrupt = { onCorruptRow: () => undefined };
      const queueRes = readOperationalQueueMapFromDb(roConn, scopeId, ignoreCorrupt);
      if (queueRes.present) snapshot.set(KEYS.queue, deepFreezeValue(queueRes.map));
      const runRes = readOperationalRunMapFromDb(roConn, scopeId, ignoreCorrupt);
      if (runRes.present) snapshot.set(KEYS.run, deepFreezeValue(runRes.map));
    }
    return snapshot;
  } finally {
    try {
      roConn.exec('COMMIT');
    } catch {
      // Ignore read-transaction close error.
    }
  }
}
