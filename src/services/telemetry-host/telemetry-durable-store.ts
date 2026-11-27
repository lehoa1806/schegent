/**
 * FR-R6-F14 (F14-B: FR-010, FR-012, FR-019; NFR-001, NFR-005, NFR-007; AC-04, AC-06, AC-10) —
 * SQLite-backed durable telemetry ledger, persisted cardinality dictionary, and governed 32 MiB
 * private file spool (`openWithinRoot` with `0o600` files / `0o700` directories).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero network imports (`expansion-freeze.test.ts`).
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_MAPPING_REVISION,
  type BatchTerminalState,
  type DeliveryReceipt,
  type DropReason,
  type ExpiryReason,
  type ResolvedDestination,
  type TelemetryLedgerPort
} from '../../contracts/telemetry-export';
import { readBoundedRange } from '../../lib/bounded-read';
import { resolveContainedLink } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';
import type { SqliteApplicationStore } from '../sqlite-store';

export interface DurableBatchDisposition {
  readonly batchId: string;
  readonly state: BatchTerminalState;
  readonly reason: ExpiryReason | DropReason | null;
  readonly at: number;
}

export interface PersistedTelemetryAuthFingerprint {
  readonly version: 1;
  readonly fingerprint: string | null;
  readonly updatedAtMs: number;
}

export interface SqliteTelemetryLedger extends TelemetryLedgerPort {
  setActiveProfileId(profileId: string): void;
  readAuthorizationGeneration(): number;
  bumpAuthorizationGeneration(): number;
  readAuthorizationFingerprint(): string | null;
  writeAuthorizationFingerprint(fingerprint: string | null): void;
  syncAuthorizationDestination(fingerprint: string | null): {
    readonly generation: number;
    readonly changed: boolean;
  };
  copyCount(): number;
  receipts(): readonly DeliveryReceipt[];
  dispositions(): readonly DurableBatchDisposition[];
  admitCardinalitySet(params: {
    readonly profileId: string;
    readonly mappingRevision?: number;
    readonly instrument: string;
    readonly attributeSetKey: string;
  }): 'admitted' | 'overflow';
  cardinalitySetCount(params: {
    readonly profileId: string;
    readonly mappingRevision?: number;
    readonly instrument: string;
  }): number;
}

const AUTH_GEN_NAMESPACE = 'telemetry-export';
const AUTH_GEN_KEY = 'authorization-generation';
const AUTH_FINGERPRINT_KEY = 'telemetry-authorization-fingerprint';
const RECENT_ENTRIES_MAX = 256;

type StoredFingerprintState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly fingerprint: string | null }
  | { readonly kind: 'corrupt' };

function inTransaction(conn: SqliteApplicationStore['writerConnection']): boolean {
  return conn.db.isTransaction;
}

function inImmediateTransaction<T>(conn: SqliteApplicationStore['writerConnection'], work: () => T): T {
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

export function createSqliteTelemetryLedger(
  sqliteStore: SqliteApplicationStore,
  nowMs: () => number = () => Date.now()
): SqliteTelemetryLedger {
  const conn = sqliteStore.writerConnection;
  let activeProfileId = 'default';
  let lastNowMs = 0;
  const recentReceipts: DeliveryReceipt[] = [];
  const recentDispositions: DurableBatchDisposition[] = [];

  function safeNowMs(): number {
    try {
      const value = nowMs();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        lastNowMs = value;
        return value;
      }
    } catch {
      // Clock faults fall back to the last valid timestamp so durability writes never throw.
    }
    return lastNowMs;
  }

  function readGenerationRow(): number {
    const row = conn.get<{ revision: number }>(
      `SELECT revision FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
      AUTH_GEN_NAMESPACE,
      AUTH_GEN_KEY
    );
    return row?.revision ?? 1;
  }

  function writeGenerationRow(generation: number): void {
    const payload = JSON.stringify({ generation });
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)
      ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        updated_at_ms = excluded.updated_at_ms`,
      AUTH_GEN_NAMESPACE,
      AUTH_GEN_KEY,
      generation,
      payload,
      Buffer.byteLength(payload, 'utf8'),
      safeNowMs()
    );
  }

  function readStoredFingerprint(): StoredFingerprintState {
    const row = conn.get<{ payload_json: string }>(
      `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
      AUTH_GEN_NAMESPACE,
      AUTH_FINGERPRINT_KEY
    );
    if (row === undefined) return { kind: 'absent' };
    try {
      const parsed = JSON.parse(row.payload_json) as Partial<PersistedTelemetryAuthFingerprint>;
      if (
        parsed.version === 1 &&
        (parsed.fingerprint === null || (typeof parsed.fingerprint === 'string' && parsed.fingerprint.length > 0))
      ) {
        return { kind: 'valid', fingerprint: parsed.fingerprint };
      }
      return { kind: 'corrupt' };
    } catch {
      // Corrupt persisted fingerprint fails closed by forcing an authorization generation bump.
      return { kind: 'corrupt' };
    }
  }

  function writeFingerprintRow(fingerprint: string | null): void {
    const updatedAtMs = safeNowMs();
    const doc: PersistedTelemetryAuthFingerprint = {
      version: 1,
      fingerprint,
      updatedAtMs
    };
    const payload = JSON.stringify(doc);
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
      ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
        revision = operational_kv_documents.revision + 1,
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        updated_at_ms = excluded.updated_at_ms`,
      AUTH_GEN_NAMESPACE,
      AUTH_FINGERPRINT_KEY,
      payload,
      Buffer.byteLength(payload, 'utf8'),
      updatedAtMs
    );
  }

  function ensureDestinationRegistered(profileId: string): void {
    const existing = conn.get<{ destination_id: string }>(
      `SELECT destination_id FROM telemetry_destinations WHERE destination_id = ?`,
      profileId
    );
    if (existing !== undefined) return;
    sqliteStore.telemetry.registerDestination({
      destinationId: profileId,
      kind: 'otlp_http',
      endpointOrPath: `profile:${profileId}`,
      enabled: true
    });
  }

  function pruneRememberedCopiesIfNeeded(): void {
    const total = Number(
      conn.scalar(`SELECT COUNT(*) FROM telemetry_export_ledger WHERE record_kind = 'copy'`) ?? 0
    );
    const excess = total - TELEMETRY_EXPORT_BOUNDS.rememberedCopiesMax;
    if (excess <= 0) return;
    conn.run(
      `DELETE FROM telemetry_export_ledger
       WHERE rowid IN (
         SELECT rowid FROM telemetry_export_ledger
         WHERE record_kind = 'copy'
         ORDER BY updated_at_ms ASC
         LIMIT ?
       )`,
      excess
    );
  }

  return {
    setActiveProfileId(profileId: string): void {
      activeProfileId = profileId.length > 0 ? profileId : 'default';
    },

    readAuthorizationGeneration(): number {
      return readGenerationRow();
    },

    bumpAuthorizationGeneration(): number {
      return inImmediateTransaction(conn, () => {
        const next = readGenerationRow() + 1;
        writeGenerationRow(next);
        return next;
      });
    },

    readAuthorizationFingerprint(): string | null {
      const stored = readStoredFingerprint();
      return stored.kind === 'valid' ? stored.fingerprint : null;
    },

    writeAuthorizationFingerprint(fingerprint: string | null): void {
      inImmediateTransaction(conn, () => {
        writeFingerprintRow(fingerprint);
      });
    },

    syncAuthorizationDestination(nextFingerprint: string | null): {
      readonly generation: number;
      readonly changed: boolean;
    } {
      return inImmediateTransaction(conn, () => {
        const currentGen = readGenerationRow();
        const stored = readStoredFingerprint();
        if (stored.kind === 'absent') {
          if (nextFingerprint === null) {
            return { generation: currentGen, changed: false };
          }
          const hasLegacySpooledBatches =
            Number(conn.scalar(`SELECT COUNT(*) FROM telemetry_spool_batches`) ?? 0) > 0;
          if (hasLegacySpooledBatches) {
            const nextGen = currentGen + 1;
            writeGenerationRow(nextGen);
            writeFingerprintRow(nextFingerprint);
            return { generation: nextGen, changed: true };
          }
          writeFingerprintRow(nextFingerprint);
          return { generation: currentGen, changed: false };
        }
        if (stored.kind === 'valid' && stored.fingerprint === nextFingerprint) {
          return { generation: currentGen, changed: false };
        }
        const nextGen = currentGen + 1;
        writeGenerationRow(nextGen);
        writeFingerprintRow(nextFingerprint);
        return { generation: nextGen, changed: true };
      });
    },

    rememberCopy(copyId: string): 'new' | 'duplicate' {
      const existing = conn.get<{ state: string }>(
        `SELECT state FROM telemetry_export_ledger
         WHERE record_kind = 'copy' AND record_id = ? AND revision = 1 AND profile_id = ? AND mapping_revision = ?`,
        copyId,
        activeProfileId,
        TELEMETRY_MAPPING_REVISION
      );
      if (existing !== undefined) return 'duplicate';
      conn.run(
        `INSERT INTO telemetry_export_ledger (
          record_kind, record_id, revision, profile_id, mapping_revision, state, updated_at_ms
        ) VALUES ('copy', ?, 1, ?, ?, 'exported', ?)`,
        copyId,
        activeProfileId,
        TELEMETRY_MAPPING_REVISION,
        safeNowMs()
      );
      pruneRememberedCopiesIfNeeded();
      return 'new';
    },

    recordReceipt(receipt: DeliveryReceipt): void {
      recentReceipts.push(Object.freeze({ ...receipt }));
      if (recentReceipts.length > RECENT_ENTRIES_MAX) {
        recentReceipts.splice(0, recentReceipts.length - RECENT_ENTRIES_MAX);
      }
      ensureDestinationRegistered(activeProfileId);
      const copyExists = conn.get<{ copy_id: string }>(
        `SELECT copy_id FROM telemetry_export_copies WHERE copy_id = ?`,
        receipt.batchId
      );
      if (copyExists === undefined) {
        sqliteStore.telemetry.enqueueExportCopy({
          copyId: receipt.batchId,
          destinationId: activeProfileId,
          sourceCommitUnit: 'telemetry-batch',
          sourceRevision: 1,
          payloadJson: JSON.stringify({ batchId: receipt.batchId })
        });
      }
      const markStatus =
        receipt.outcome === 'acknowledged'
          ? 'sent'
          : receipt.outcome === 'retry'
            ? 'failed'
            : 'dead_letter';
      sqliteStore.telemetry.recordDeliveryReceipt({
        deliveryId: receipt.attemptId,
        copyId: receipt.batchId,
        destinationId: activeProfileId,
        statusCode: receipt.statusCode ?? 0,
        diagnosticText: receipt.errorClass ?? receipt.outcome,
        markStatus
      });
    },

    recordDisposition(
      batchId: string,
      state: BatchTerminalState,
      reason: ExpiryReason | DropReason | null
    ): void {
      const at = safeNowMs();
      recentDispositions.push(Object.freeze({ batchId, state, reason, at }));
      if (recentDispositions.length > RECENT_ENTRIES_MAX) {
        recentDispositions.splice(0, recentDispositions.length - RECENT_ENTRIES_MAX);
      }
      const dbState = state === 'acknowledged' ? 'exported' : 'dropped';
      conn.run(
        `INSERT INTO telemetry_export_ledger (
          record_kind, record_id, revision, profile_id, mapping_revision, state, updated_at_ms
        ) VALUES ('disposition', ?, 1, ?, ?, ?, ?)
        ON CONFLICT(record_kind, record_id, revision, profile_id, mapping_revision) DO UPDATE SET
          state = excluded.state,
          updated_at_ms = excluded.updated_at_ms`,
        batchId,
        activeProfileId,
        TELEMETRY_MAPPING_REVISION,
        dbState,
        at
      );
    },

    copyCount(): number {
      return Number(
        conn.scalar(`SELECT COUNT(*) FROM telemetry_export_ledger WHERE record_kind = 'copy'`) ?? 0
      );
    },

    receipts(): readonly DeliveryReceipt[] {
      return [...recentReceipts];
    },

    dispositions(): readonly DurableBatchDisposition[] {
      return [...recentDispositions];
    },

    admitCardinalitySet(params): 'admitted' | 'overflow' {
      const rev = params.mappingRevision ?? TELEMETRY_MAPPING_REVISION;
      const verdict = sqliteStore.telemetry.recordCardinalityAttribute({
        metricFamily: `${params.profileId}:v${String(rev)}:${params.instrument}`,
        attributeKey: 'attribute_set',
        attributeValue: params.attributeSetKey,
        maxDistinctPerKey: TELEMETRY_EXPORT_BOUNDS.attributeSetsMax - 1
      });
      return verdict.admitted ? 'admitted' : 'overflow';
    },

    cardinalitySetCount(params): number {
      const rev = params.mappingRevision ?? TELEMETRY_MAPPING_REVISION;
      return Number(
        conn.scalar(
          `SELECT COUNT(*) FROM telemetry_cardinality_sets WHERE metric_family = ? AND attribute_key = 'attribute_set'`,
          `${params.profileId}:v${String(rev)}:${params.instrument}`
        ) ?? 0
      );
    }
  };
}

export interface SpooledBatchMeta {
  readonly relPath: string;
  readonly sha256: string;
  readonly profileRevision: number;
  readonly authorizationGeneration: number;
}

export interface SpooledBatchEntry {
  readonly batchId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly authorizationGeneration: number;
  readonly relPath: string;
  readonly sha256: string | null;
  readonly payloadBytes: number;
  readonly attemptCount: number;
  readonly createdAtMs: number;
}

export interface TelemetrySpoolStore {
  spoolBatch(params: {
    readonly batchId: string;
    readonly destination: ResolvedDestination;
    readonly authorizationGeneration: number;
    readonly body: Uint8Array;
  }): Promise<{ readonly spooled: boolean; readonly droppedBatchIds: readonly string[] }>;
  readSpooledPayload(entry: SpooledBatchEntry): Promise<Uint8Array | null>;
  removeBatch(batchId: string): Promise<boolean>;
  reconcileForDestination(params: {
    readonly activeDestination: ResolvedDestination | null;
    readonly authorizationGeneration: number;
    readonly onDropped: (batchId: string, reason: DropReason) => void;
    readonly onExpired: (batchId: string, reason: ExpiryReason) => void;
  }): Promise<readonly SpooledBatchEntry[]>;
  stats(): { readonly spooledBatches: number; readonly spooledBytes: number };
}

const SPOOL_SUBDIR = 'telemetry-spool';
const SAFE_BATCH_ID = /^[A-Za-z0-9._-]{1,128}$/;

type StoredSpoolMeta = Omit<SpooledBatchMeta, 'sha256'> & { readonly sha256?: string };

function parseSpoolMeta(raw: string): StoredSpoolMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SpooledBatchMeta>;
    if (
      typeof parsed.relPath === 'string' &&
      typeof parsed.profileRevision === 'number' &&
      typeof parsed.authorizationGeneration === 'number'
    ) {
      return {
        relPath: parsed.relPath,
        ...(typeof parsed.sha256 === 'string' ? { sha256: parsed.sha256 } : {}),
        profileRevision: parsed.profileRevision,
        authorizationGeneration: parsed.authorizationGeneration
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function createTelemetrySpoolStore(params: {
  readonly sqliteStore: SqliteApplicationStore;
  readonly storageRoot: string;
  readonly nowMs?: () => number;
}): TelemetrySpoolStore {
  const conn = params.sqliteStore.writerConnection;
  const storageRoot = params.storageRoot;
  const nowMs = params.nowMs ?? (() => Date.now());
  let lastNowMs = 0;

  function safeNowMs(): number {
    try {
      const value = nowMs();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        lastNowMs = value;
        return value;
      }
    } catch {
      // Clock faults fall back to the last valid timestamp so spool operations never reject.
    }
    return lastNowMs;
  }

  async function unlinkQuietly(relPath: string): Promise<void> {
    if (path.posix.dirname(relPath) !== SPOOL_SUBDIR || relPath.includes('\\') || relPath.includes('..')) return;
    try {
      const contained = await resolveContainedLink(path.join(storageRoot, relPath), [storageRoot]);
      if (contained.outcome !== 'contained') return;
      const expected = path.join(await fsp.realpath(storageRoot), relPath);
      if (contained.resolved !== expected) return;
      await fsp.unlink(contained.resolved);
    } catch {
      // Missing or already removed spool leaf.
    }
  }

  function listDbEntries(): SpooledBatchEntry[] {
    const rows = conn.all<{
      batch_id: string;
      profile_id: string;
      payload_json: string;
      payload_bytes: number;
      attempt_count: number;
      created_at_ms: number;
    }>(
      `SELECT batch_id, profile_id, payload_json, payload_bytes, attempt_count, created_at_ms
       FROM telemetry_spool_batches
       ORDER BY created_at_ms ASC, batch_id ASC`
    );
    const out: SpooledBatchEntry[] = [];
    for (const row of rows) {
      const meta = parseSpoolMeta(row.payload_json);
      const relPath = `${SPOOL_SUBDIR}/${row.batch_id}.json`;
      const validDigest =
        SAFE_BATCH_ID.test(row.batch_id) &&
        meta?.relPath === relPath &&
        typeof meta.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(meta.sha256);
      out.push({
        batchId: row.batch_id,
        profileId: row.profile_id,
        profileRevision: meta?.profileRevision ?? 0,
        authorizationGeneration: meta?.authorizationGeneration ?? 0,
        relPath,
        sha256: validDigest ? meta.sha256 : null,
        payloadBytes: row.payload_bytes,
        attemptCount: row.attempt_count,
        createdAtMs: row.created_at_ms
      });
    }
    return out;
  }

  function insertSpoolRow(
    req: { readonly batchId: string; readonly destination: ResolvedDestination; readonly body: Uint8Array },
    metaJson: string,
    now: number
  ): void {
    conn.run(
      `INSERT INTO telemetry_spool_batches (
        batch_id, profile_id, signal, payload_json, payload_bytes, attempt_count, next_attempt_at_ms, created_at_ms
      ) VALUES (?, ?, 'metrics', ?, ?, 1, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        attempt_count = telemetry_spool_batches.attempt_count + 1,
        next_attempt_at_ms = excluded.next_attempt_at_ms`,
      req.batchId,
      req.destination.profileId,
      metaJson,
      req.body.byteLength,
      now,
      now
    );
  }

  return {
    async spoolBatch(req) {
      if (!SAFE_BATCH_ID.test(req.batchId)) {
        return { spooled: false, droppedBatchIds: [req.batchId] };
      }
      if (
        req.body.byteLength > TELEMETRY_EXPORT_BOUNDS.batchBytesMax ||
        req.body.byteLength > TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes
      ) {
        return { spooled: false, droppedBatchIds: [req.batchId] };
      }
      // A spool is started without being awaited, from a retry timer, so it can begin or resume after
      // the store closed at shutdown. It then drops the batch instead of rejecting with
      // `database is not open` (seen in the Linux leg, 2026-11-12). Checked again after every await.
      if (conn.isClosed()) return { spooled: false, droppedBatchIds: [req.batchId] };

      const droppedBatchIds: string[] = [];
      const existing = listDbEntries();
      let currentBytes = existing.reduce((acc, item) => acc + item.payloadBytes, 0);
      for (const candidate of existing) {
        if (currentBytes + req.body.byteLength <= TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes) break;
        if (conn.isClosed()) return { spooled: false, droppedBatchIds: [...droppedBatchIds, req.batchId] };
        const del = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, candidate.batchId);
        currentBytes -= candidate.payloadBytes;
        if (del.changes > 0) {
          await unlinkQuietly(candidate.relPath);
          droppedBatchIds.push(candidate.batchId);
        }
      }

      const relPath = `${SPOOL_SUBDIR}/${req.batchId}.json`;
      const opened = await openWithinRoot(storageRoot, [SPOOL_SUBDIR, `${req.batchId}.json`], {
        flags: 'w',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (opened.outcome !== 'opened') {
        return { spooled: false, droppedBatchIds: [...droppedBatchIds, req.batchId] };
      }
      let writeFailed = false;
      try {
        await opened.handle.writeFile(req.body);
      } catch (err) {
        writeFailed = true;
        throw err;
      } finally {
        await opened.handle.close();
        if (writeFailed) {
          await unlinkQuietly(relPath);
        }
      }
      if (conn.isClosed()) {
        await unlinkQuietly(relPath);
        return { spooled: false, droppedBatchIds: [...droppedBatchIds, req.batchId] };
      }

      const now = safeNowMs();
      const metaJson = JSON.stringify({
        relPath,
        sha256: createHash('sha256').update(req.body).digest('hex'),
        profileRevision: req.destination.profileRevision,
        authorizationGeneration: req.authorizationGeneration
      } satisfies SpooledBatchMeta);

      try {
        insertSpoolRow(req, metaJson, now);
      } catch (err) {
        // No row means no reader: the file would only wait for orphan reconciliation.
        await unlinkQuietly(relPath);
        throw err;
      }

      return { spooled: true, droppedBatchIds };
    },

    async readSpooledPayload(entry) {
      if (
        !SAFE_BATCH_ID.test(entry.batchId) ||
        entry.sha256 === null ||
        !Number.isSafeInteger(entry.payloadBytes) ||
        entry.payloadBytes < 1 ||
        entry.payloadBytes > TELEMETRY_EXPORT_BOUNDS.batchBytesMax
      ) return null;
      const opened = await openWithinRoot(storageRoot, [SPOOL_SUBDIR, `${entry.batchId}.json`], {
        flags: 'r'
      });
      if (opened.outcome !== 'opened') return null;
      try {
        const st = await opened.handle.stat();
        if (!st.isFile() || st.size !== entry.payloadBytes) return null;
        const { bytes } = await readBoundedRange(opened.handle, 0, st.size, TELEMETRY_EXPORT_BOUNDS.batchBytesMax);
        if (bytes.byteLength !== st.size) return null;
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return null;
        return bytes;
      } catch {
        return null;
      } finally {
        await opened.handle.close();
      }
    },

    async removeBatch(batchId) {
      if (conn.isClosed()) return false;
      const existing = listDbEntries().find((item) => item.batchId === batchId);
      const deleted = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, batchId);
      if (existing !== undefined) {
        await unlinkQuietly(existing.relPath);
      }
      return deleted.changes > 0;
    },

    async reconcileForDestination(rec) {
      if (conn.isClosed()) return [];
      const now = safeNowMs();
      const entries = listDbEntries();
      const referencedRelPaths = new Set<string>();
      const kept: SpooledBatchEntry[] = [];

      for (const entry of entries) {
        if (conn.isClosed()) return [];
        if (now - entry.createdAtMs > TELEMETRY_EXPORT_BOUNDS.copyExpiryMs) {
          const del = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          if (del.changes > 0) {
            await unlinkQuietly(entry.relPath);
            rec.onExpired(entry.batchId, 'age');
          }
          continue;
        }
        if (rec.activeDestination === null) {
          const del = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          if (del.changes > 0) {
            await unlinkQuietly(entry.relPath);
            rec.onDropped(entry.batchId, 'disabled');
          }
          continue;
        }
        if (
          entry.profileId !== rec.activeDestination.profileId ||
          entry.profileRevision !== rec.activeDestination.profileRevision ||
          entry.authorizationGeneration !== rec.authorizationGeneration
        ) {
          const del = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          if (del.changes > 0) {
            await unlinkQuietly(entry.relPath);
            rec.onDropped(entry.batchId, 'authorization-changed');
          }
          continue;
        }
        if (entry.sha256 === null) {
          const del = conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          if (del.changes > 0) {
            await unlinkQuietly(entry.relPath);
            rec.onDropped(entry.batchId, 'rejected');
          }
          continue;
        }
        referencedRelPaths.add(entry.relPath);
        kept.push(entry);
      }

      // Sweep orphan spool files left by a crash before SQLite row publication (F14-AC-10).
      try {
        const spoolDir = path.join(storageRoot, SPOOL_SUBDIR);
        const dirEntries = await fsp.readdir(spoolDir, { withFileTypes: true });
        for (const dirent of dirEntries) {
          const relPath = `${SPOOL_SUBDIR}/${dirent.name}`;
          if (!referencedRelPaths.has(relPath)) {
            await unlinkQuietly(relPath);
          }
        }
      } catch {
        // Spool directory does not exist in disabled mode (F14-NFR-05).
      }

      return kept;
    },

    stats() {
      if (conn.isClosed()) return { spooledBatches: 0, spooledBytes: 0 };
      const row = conn.get<{ cnt: number; total_bytes: number | null }>(
        `SELECT COUNT(*) AS cnt, SUM(payload_bytes) AS total_bytes FROM telemetry_spool_batches`
      );
      return {
        spooledBatches: Number(row?.cnt ?? 0),
        spooledBytes: Number(row?.total_bytes ?? 0)
      };
    }
  };
}
