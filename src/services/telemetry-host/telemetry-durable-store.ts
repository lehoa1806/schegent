/**
 * FR-R6-F14 (F14-B: FR-010, FR-012, FR-019; NFR-001, NFR-005, NFR-007; AC-04, AC-06, AC-10) —
 * SQLite-backed durable telemetry ledger, persisted cardinality dictionary, and governed 32 MiB
 * private file spool (`openWithinRoot` with `0o600` files / `0o700` directories).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero network imports (`expansion-freeze.test.ts`).
 */
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
import { resolveContainedLink } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';
import type { SqliteApplicationStore } from '../sqlite-store';

export interface DurableBatchDisposition {
  readonly batchId: string;
  readonly state: BatchTerminalState;
  readonly reason: ExpiryReason | DropReason | null;
  readonly at: number;
}

export interface SqliteTelemetryLedger extends TelemetryLedgerPort {
  setActiveProfileId(profileId: string): void;
  readAuthorizationGeneration(): number;
  bumpAuthorizationGeneration(): number;
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
const RECENT_ENTRIES_MAX = 256;

export function createSqliteTelemetryLedger(
  sqliteStore: SqliteApplicationStore,
  nowMs: () => number = () => Date.now()
): SqliteTelemetryLedger {
  const conn = sqliteStore.writerConnection;
  let activeProfileId = 'default';
  const recentReceipts: DeliveryReceipt[] = [];
  const recentDispositions: DurableBatchDisposition[] = [];

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
      const row = conn.get<{ revision: number }>(
        `SELECT revision FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        AUTH_GEN_NAMESPACE,
        AUTH_GEN_KEY
      );
      return row?.revision ?? 1;
    },

    bumpAuthorizationGeneration(): number {
      const next = this.readAuthorizationGeneration() + 1;
      const payload = JSON.stringify({ generation: next });
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
        next,
        payload,
        Buffer.byteLength(payload, 'utf8'),
        nowMs()
      );
      return next;
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
        nowMs()
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
      const at = nowMs();
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
  readonly profileRevision: number;
  readonly authorizationGeneration: number;
}

export interface SpooledBatchEntry {
  readonly batchId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly authorizationGeneration: number;
  readonly relPath: string;
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
  removeBatch(batchId: string): Promise<void>;
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

function parseSpoolMeta(raw: string): SpooledBatchMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SpooledBatchMeta>;
    if (
      typeof parsed.relPath === 'string' &&
      typeof parsed.profileRevision === 'number' &&
      typeof parsed.authorizationGeneration === 'number'
    ) {
      return {
        relPath: parsed.relPath,
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

  async function unlinkQuietly(relPath: string): Promise<void> {
    if (!relPath.startsWith(`${SPOOL_SUBDIR}/`) || relPath.includes('..')) return;
    try {
      const contained = await resolveContainedLink(path.join(storageRoot, relPath), [storageRoot]);
      if (contained.outcome !== 'contained') return;
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
      if (meta === null) {
        conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, row.batch_id);
        continue;
      }
      out.push({
        batchId: row.batch_id,
        profileId: row.profile_id,
        profileRevision: meta.profileRevision,
        authorizationGeneration: meta.authorizationGeneration,
        relPath: meta.relPath,
        payloadBytes: row.payload_bytes,
        attemptCount: row.attempt_count,
        createdAtMs: row.created_at_ms
      });
    }
    return out;
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

      const droppedBatchIds: string[] = [];
      const existing = listDbEntries();
      let currentBytes = existing.reduce((acc, item) => acc + item.payloadBytes, 0);
      for (const candidate of existing) {
        if (currentBytes + req.body.byteLength <= TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes) break;
        conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, candidate.batchId);
        await unlinkQuietly(candidate.relPath);
        currentBytes -= candidate.payloadBytes;
        droppedBatchIds.push(candidate.batchId);
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
      try {
        await opened.handle.writeFile(req.body);
      } finally {
        await opened.handle.close();
      }

      const now = nowMs();
      const metaJson = JSON.stringify({
        relPath,
        profileRevision: req.destination.profileRevision,
        authorizationGeneration: req.authorizationGeneration
      } satisfies SpooledBatchMeta);

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

      return { spooled: true, droppedBatchIds };
    },

    async readSpooledPayload(entry) {
      const opened = await openWithinRoot(storageRoot, entry.relPath.split('/'), {
        flags: 'r'
      });
      if (opened.outcome !== 'opened') return null;
      try {
        const buf = await opened.handle.readFile();
        return new Uint8Array(buf);
      } catch {
        return null;
      } finally {
        await opened.handle.close();
      }
    },

    async removeBatch(batchId) {
      const existing = listDbEntries().find((item) => item.batchId === batchId);
      conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, batchId);
      if (existing !== undefined) {
        await unlinkQuietly(existing.relPath);
      }
    },

    async reconcileForDestination(rec) {
      const now = nowMs();
      const entries = listDbEntries();
      const referencedRelPaths = new Set<string>();
      const kept: SpooledBatchEntry[] = [];

      for (const entry of entries) {
        if (now - entry.createdAtMs > TELEMETRY_EXPORT_BOUNDS.copyExpiryMs) {
          conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          await unlinkQuietly(entry.relPath);
          rec.onExpired(entry.batchId, 'age');
          continue;
        }
        if (rec.activeDestination === null) {
          conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          await unlinkQuietly(entry.relPath);
          rec.onDropped(entry.batchId, 'disabled');
          continue;
        }
        if (
          entry.profileId !== rec.activeDestination.profileId ||
          entry.profileRevision !== rec.activeDestination.profileRevision ||
          entry.authorizationGeneration !== rec.authorizationGeneration
        ) {
          conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          await unlinkQuietly(entry.relPath);
          rec.onDropped(entry.batchId, 'authorization-changed');
          continue;
        }
        const payload = await this.readSpooledPayload(entry);
        if (payload === null || payload.byteLength !== entry.payloadBytes) {
          conn.run(`DELETE FROM telemetry_spool_batches WHERE batch_id = ?`, entry.batchId);
          await unlinkQuietly(entry.relPath);
          rec.onDropped(entry.batchId, 'rejected');
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
