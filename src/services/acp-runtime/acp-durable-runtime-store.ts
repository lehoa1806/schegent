/**
 * FR-R7-14 (14-04 & 14-06) — Schema-9 durable ACP runtime state stored in
 * `operational_kv_documents` and `acp_observation_ledger`:
 *   1. Backend- and normalized-workspace-root-bound mapping from persisted host session
 *      handles (`acp-sess-<backend>-<uuid>`) to genuine provider conversation IDs
 *      (Claude `session_id`, Codex `thread_id`).
 *   2. Persistent monotonic connection-generation high-water mark seeded strictly above
 *      existing `acp_observation_ledger` and `acp_authorization_receipts` generations so
 *      observations emitted across host restarts never collide on `(profile_id, gen, seq)`.
 *   3. Replay-safe observation ledger recording that deduplicates true replays while
 *      preventing silent row loss when two hosts emit distinct events at equal process-local
 *      `(generation, seq)` coordinates.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw filesystem writes (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  isBackendRunnerKind,
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../../contracts/backend-kinds';
import type { AcpObservation } from '../../contracts/acp-runtime';
import { canonicalizePathWithTailSync } from '../../lib/protected-path-match';
import type { NodeSqliteConnection } from '../sqlite-store/sqlite-driver';
import {
  isAgentIdentifier,
  isSafeProviderSessionId,
  SAFE_PROVIDER_SESSION_ID_RE
} from './agent-identifier';

export { SAFE_PROVIDER_SESSION_ID_RE };

export const ACP_SESSION_BINDING_MAX_ENTRIES = 512;
const ACP_SESSION_BINDING_SCHEMA_VERSION = 1;
const ACP_GENERATION_HWM_SCHEMA_VERSION = 1;
const ACP_GENERATION_HWM_KEY = 'connection-generation-hwm';
const EPHEMERAL_BRIDGE_SESSION_RE = new RegExp(
  `^acp-(?:${SUPPORTED_BACKENDS.join('|')})-session-\\d+$`
);

export interface AcpPersistedSessionBinding {
  readonly schemaVersion: 1;
  readonly persistedSessionId: string;
  readonly backend: BackendRunnerKind;
  readonly workspaceRoot: string;
  readonly providerSessionId: string;
  readonly updatedAtMs: number;
}

export interface AcpSessionBindingStore {
  getBinding(persistedSessionId: string): AcpPersistedSessionBinding | null;
  putBinding(binding: Omit<AcpPersistedSessionBinding, 'schemaVersion'>): void;
}

export interface AcpObservationRecordInput {
  readonly profileId: string;
  readonly attemptId: string;
  readonly observation: AcpObservation;
}

export interface AcpDurableRuntimeStore {
  readonly sessionBindings: AcpSessionBindingStore;
  allocateConnectionGeneration(): number;
  recordObservation(input: AcpObservationRecordInput, nowMs?: number): {
    readonly persistedGeneration: number;
    readonly deduplicated: boolean;
  };
  resetInMemoryState(): void;
}

export function normalizeAcpWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const canonical = canonicalizePathWithTailSync(resolved);
  return canonical.ok ? canonical.canonical : resolved;
}

export function isEphemeralBridgeSessionId(sessionId: string): boolean {
  return EPHEMERAL_BRIDGE_SESSION_RE.test(sessionId);
}

export function isValidProviderSessionId(providerSessionId: string): boolean {
  return isSafeProviderSessionId(providerSessionId) && !isEphemeralBridgeSessionId(providerSessionId);
}

function parseSessionBindingPayload(raw: string): AcpPersistedSessionBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== ACP_SESSION_BINDING_SCHEMA_VERSION) return null;
  if (typeof obj['persistedSessionId'] !== 'string' || !isAgentIdentifier(obj['persistedSessionId'])) {
    return null;
  }
  if (!isBackendRunnerKind(obj['backend'])) {
    return null;
  }
  if (typeof obj['workspaceRoot'] !== 'string' || obj['workspaceRoot'].length === 0) {
    return null;
  }
  if (
    typeof obj['providerSessionId'] !== 'string' ||
    !isValidProviderSessionId(obj['providerSessionId'])
  ) {
    return null;
  }
  if (typeof obj['updatedAtMs'] !== 'number' || !Number.isSafeInteger(obj['updatedAtMs'])) {
    return null;
  }
  return {
    schemaVersion: 1,
    persistedSessionId: obj['persistedSessionId'],
    backend: obj['backend'],
    workspaceRoot: obj['workspaceRoot'],
    providerSessionId: obj['providerSessionId'],
    updatedAtMs: obj['updatedAtMs']
  };
}

function computeObservationPayloadSha256(
  obs: AcpObservation,
  eventKind: string,
  sessionId: string,
  attemptId: string
): string {
  const detail: Record<string, unknown> = {
    kind: eventKind,
    turnId: obs.turnId || 'idle',
    origin: obs.origin,
    acpSessionId: sessionId,
    attemptId
  };
  switch (obs.kind) {
    case 'turn-started':
      detail['requestId'] = obs.requestId;
      break;
    case 'turn-completed':
      detail['requestId'] = obs.requestId;
      detail['stopReason'] = obs.stopReason;
      break;
    case 'display':
      detail['event'] = obs.event;
      break;
    case 'usage':
      detail['usage'] = obs.usage;
      break;
  }
  return createHash('sha256').update(JSON.stringify(detail), 'utf8').digest('hex');
}

export function createInMemoryAcpSessionBindingStore(
  maxEntries: number = ACP_SESSION_BINDING_MAX_ENTRIES
): AcpSessionBindingStore {
  const entries = new Map<string, AcpPersistedSessionBinding>();
  return {
    getBinding(persistedSessionId: string): AcpPersistedSessionBinding | null {
      return entries.get(persistedSessionId) ?? null;
    },
    putBinding(binding): void {
      if (!isAgentIdentifier(binding.persistedSessionId)) return;
      if (!isValidProviderSessionId(binding.providerSessionId)) return;
      const normalized: AcpPersistedSessionBinding = {
        schemaVersion: 1,
        persistedSessionId: binding.persistedSessionId,
        backend: binding.backend,
        workspaceRoot: normalizeAcpWorkspaceRoot(binding.workspaceRoot),
        providerSessionId: binding.providerSessionId,
        updatedAtMs: binding.updatedAtMs
      };
      entries.delete(normalized.persistedSessionId);
      entries.set(normalized.persistedSessionId, normalized);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    }
  };
}

function runImmediateTransaction<T>(conn: NodeSqliteConnection, fn: () => T): T {
  const inTx = conn.db.isTransaction;
  if (inTx) {
    conn.exec('SAVEPOINT acp_durable_sp');
    try {
      const value = fn();
      conn.exec('RELEASE SAVEPOINT acp_durable_sp');
      return value;
    } catch (error) {
      conn.exec('ROLLBACK TO SAVEPOINT acp_durable_sp');
      conn.exec('RELEASE SAVEPOINT acp_durable_sp');
      throw error;
    }
  }
  conn.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    conn.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // Connection may already have rolled back automatically on SQLITE_BUSY/abort.
    }
    throw error;
  }
}

export function createSqliteAcpDurableRuntimeStore(
  conn: NodeSqliteConnection,
  scopeId: string,
  nowMs: () => number = () => Date.now()
): AcpDurableRuntimeStore {
  const bindingNamespace = `acp-session-bindings:${scopeId}`;
  const stateNamespace = `acp-runtime-state:${scopeId}`;
  let lastAllocatedGeneration = 0;
  const allocatedByThisHost = new Set<number>();
  const remappedGenerations = new Map<string, number>();

  function trackAllocatedGeneration(generation: number): void {
    if (!allocatedByThisHost.has(generation) && allocatedByThisHost.size >= ACP_SESSION_BINDING_MAX_ENTRIES) {
      const oldest = allocatedByThisHost.values().next().value;
      if (oldest !== undefined) allocatedByThisHost.delete(oldest);
    }
    allocatedByThisHost.add(generation);
  }

  function trackRemappedGeneration(remapKey: string, generation: number): void {
    remappedGenerations.delete(remapKey);
    remappedGenerations.set(remapKey, generation);
    while (remappedGenerations.size > ACP_SESSION_BINDING_MAX_ENTRIES) {
      const oldest = remappedGenerations.keys().next().value;
      if (oldest === undefined) break;
      remappedGenerations.delete(oldest);
    }
  }

  function readGenerationFloor(): number {
    const row = conn.get<{ floor_gen: number }>(
      `SELECT MAX(g) AS floor_gen FROM (
         SELECT COALESCE(MAX(connection_generation), 0) AS g FROM acp_observation_ledger
         UNION ALL
         SELECT COALESCE(MAX(connection_generation), 0) AS g FROM acp_authorization_receipts
         UNION ALL
         SELECT COALESCE(MAX(revision), 0) AS g FROM operational_kv_documents
          WHERE doc_namespace = ? AND doc_key = ?
       )`,
      stateNamespace,
      ACP_GENERATION_HWM_KEY
    );
    const dbFloor = typeof row?.floor_gen === 'number' && Number.isFinite(row.floor_gen) ? row.floor_gen : 0;
    return Math.max(lastAllocatedGeneration, dbFloor);
  }

  function persistGenerationHighWaterMark(generation: number, timestampMs: number): void {
    const payload = JSON.stringify({
      schemaVersion: ACP_GENERATION_HWM_SCHEMA_VERSION,
      lastAllocatedGeneration: generation,
      updatedAtMs: timestampMs
    });
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
        revision = MAX(operational_kv_documents.revision, excluded.revision),
        payload_json = CASE
          WHEN excluded.revision > operational_kv_documents.revision THEN excluded.payload_json
          ELSE operational_kv_documents.payload_json
        END,
        payload_bytes = CASE
          WHEN excluded.revision > operational_kv_documents.revision THEN excluded.payload_bytes
          ELSE operational_kv_documents.payload_bytes
        END,
        updated_at_ms = excluded.updated_at_ms`,
      stateNamespace,
      ACP_GENERATION_HWM_KEY,
      generation,
      ACP_GENERATION_HWM_SCHEMA_VERSION,
      payload,
      Buffer.byteLength(payload, 'utf8'),
      timestampMs
    );
  }

  function allocateConnectionGeneration(): number {
    return runImmediateTransaction(conn, () => {
      const next = readGenerationFloor() + 1;
      persistGenerationHighWaterMark(next, nowMs());
      lastAllocatedGeneration = next;
      trackAllocatedGeneration(next);
      return next;
    });
  }

  function pruneOldSessionBindings(): void {
    const total = Number(
      conn.scalar(
        `SELECT COUNT(*) FROM operational_kv_documents WHERE doc_namespace = ?`,
        bindingNamespace
      ) ?? 0
    );
    const excess = total - ACP_SESSION_BINDING_MAX_ENTRIES;
    if (excess <= 0) return;
    conn.run(
      `DELETE FROM operational_kv_documents
        WHERE rowid IN (
          SELECT rowid FROM operational_kv_documents
           WHERE doc_namespace = ?
           ORDER BY updated_at_ms ASC, rowid ASC
           LIMIT ?
        )`,
      bindingNamespace,
      excess
    );
  }

  const sessionBindings: AcpSessionBindingStore = {
    getBinding(persistedSessionId: string): AcpPersistedSessionBinding | null {
      if (!isAgentIdentifier(persistedSessionId)) return null;
      const row = conn.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        bindingNamespace,
        persistedSessionId
      );
      if (row === undefined) return null;
      return parseSessionBindingPayload(row.payload_json);
    },
    putBinding(binding): void {
      if (!isAgentIdentifier(binding.persistedSessionId)) return;
      if (!isValidProviderSessionId(binding.providerSessionId)) return;
      const record: AcpPersistedSessionBinding = {
        schemaVersion: 1,
        persistedSessionId: binding.persistedSessionId,
        backend: binding.backend,
        workspaceRoot: normalizeAcpWorkspaceRoot(binding.workspaceRoot),
        providerSessionId: binding.providerSessionId,
        updatedAtMs: binding.updatedAtMs
      };
      const payload = JSON.stringify(record);
      runImmediateTransaction(conn, () => {
        conn.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, ?, 1, ?, ?, ?, 0, ?)
          ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
            revision = operational_kv_documents.revision + 1,
            payload_json = excluded.payload_json,
            payload_bytes = excluded.payload_bytes,
            updated_at_ms = excluded.updated_at_ms`,
          bindingNamespace,
          record.persistedSessionId,
          ACP_SESSION_BINDING_SCHEMA_VERSION,
          payload,
          Buffer.byteLength(payload, 'utf8'),
          record.updatedAtMs
        );
        pruneOldSessionBindings();
      });
    }
  };

  function recordObservation(
    input: AcpObservationRecordInput,
    timestampMs: number = nowMs()
  ): { readonly persistedGeneration: number; readonly deduplicated: boolean } {
    const obs = input.observation;
    const sessionId = obs.acpSessionId || `${input.attemptId}-session`;
    const rawGeneration = Math.max(1, Math.floor(obs.generation || 1));
    const hostReceiveSeq = Math.max(1, Math.floor(obs.hostReceiveSeq || 1));
    const turnId = obs.turnId || 'idle';
    const attemptId = obs.attemptId ?? input.attemptId;
    const eventKind = obs.kind === 'display' ? `display:${obs.event.kind}` : obs.kind;
    const payloadSha256 = computeObservationPayloadSha256(obs, eventKind, sessionId, attemptId);

    return runImmediateTransaction(conn, () => {
      const remapKey = `${input.profileId}:${rawGeneration}:${sessionId}:${attemptId}`;
      let targetGeneration = allocatedByThisHost.has(rawGeneration)
        ? rawGeneration
        : (remappedGenerations.get(remapKey) ?? rawGeneration);

      const existing = conn.get<{
        acp_session_id: string;
        turn_id: string;
        attempt_id: string;
        origin: string;
        kind: string;
        payload_sha256: string;
      }>(
        `SELECT acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256
           FROM acp_observation_ledger
          WHERE profile_id = ? AND connection_generation = ? AND host_receive_seq = ?`,
        input.profileId,
        targetGeneration,
        hostReceiveSeq
      );

      if (existing !== undefined) {
        const isTrueReplay =
          existing.acp_session_id === sessionId &&
          existing.turn_id === turnId &&
          existing.attempt_id === attemptId &&
          existing.origin === obs.origin &&
          existing.kind === eventKind &&
          existing.payload_sha256 === payloadSha256;
        if (isTrueReplay) {
          return { persistedGeneration: targetGeneration, deduplicated: true };
        }
        // Distinct event collided with a pre-existing process-local generation from a prior host
        // lifetime; allocate a fresh durable generation strictly above the store floor.
        targetGeneration = readGenerationFloor() + 1;
        persistGenerationHighWaterMark(targetGeneration, timestampMs);
        lastAllocatedGeneration = targetGeneration;
        trackAllocatedGeneration(targetGeneration);
        trackRemappedGeneration(remapKey, targetGeneration);
      }

      const observationKey = `${input.profileId}:${targetGeneration}:${hostReceiveSeq}`;
      conn.run(
        `INSERT INTO acp_observation_ledger (
          observation_key, profile_id, connection_generation, host_receive_seq,
          acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, connection_generation, host_receive_seq) DO NOTHING`,
        observationKey,
        input.profileId,
        targetGeneration,
        hostReceiveSeq,
        sessionId,
        turnId,
        attemptId,
        obs.origin,
        eventKind,
        payloadSha256,
        timestampMs
      );

      if (targetGeneration > lastAllocatedGeneration) {
        persistGenerationHighWaterMark(targetGeneration, timestampMs);
        lastAllocatedGeneration = targetGeneration;
      }
      return { persistedGeneration: targetGeneration, deduplicated: false };
    });
  }

  return {
    sessionBindings,
    allocateConnectionGeneration,
    recordObservation,
    resetInMemoryState(): void {
      lastAllocatedGeneration = 0;
      allocatedByThisHost.clear();
      remappedGenerations.clear();
    }
  };
}

