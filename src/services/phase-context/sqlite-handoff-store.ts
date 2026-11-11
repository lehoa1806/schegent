/**
 * FR-R6-F15 (F15-B; F15-FR-07, F15-FR-09, F15-FR-22, F15-FR-27..FR-31, F15-FR-35) — durable
 * SQLite-backed implementation of `HandoffStorePort` (`phase_handoff_records`) and review-loop
 * `FindingLedger` persistence (`phase_review_loop_ledgers`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { DeliveryRepresentation } from '../../contracts/phase-context/context-delivery';
import type {
  AcceptedRevision,
  ApprovalRecord,
  DispatchRecord,
  HandoffObservation,
  HandoffRecord,
  HandoffStorePort
} from '../../contracts/phase-context/context-manifest';
import type { Verdict } from '../../contracts/phase-context/review-loop';
import type { NodeSqliteConnection } from '../sqlite-store/sqlite-driver';
import { storedManifest } from './acceptance';
import {
  createFindingLedger,
  rehydrateFindingLedger,
  type FindingLedger,
  type FindingLedgerSnapshot,
  type LedgerOptions
} from './finding-ledger';

export interface HandoffRunMetadata {
  readonly runId: string;
  readonly sourceAttemptId?: string;
  readonly targetPhaseId?: string;
  readonly laneId?: string | null;
}

interface StoredHandoffEnvelope {
  readonly schemaVersion: 1;
  readonly record: HandoffRecord;
  readonly representations: Readonly<Record<string, DeliveryRepresentation>>;
  readonly observations: Readonly<Record<string, HandoffObservation>>;
  readonly laneId: string | null;
}

interface RawHandoffRow {
  readonly handoff_id: string;
  readonly run_id: string;
  readonly source_attempt_id: string;
  readonly target_phase_id: string;
  readonly revision: number;
  readonly status: string;
  readonly record_json: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface StoredReviewLoopEntry {
  readonly loopId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly verdict: Verdict | 'pending';
  readonly candidateRef: string | null;
  readonly scopeRevision: string | null;
  readonly criteriaRevision: string | null;
  readonly snapshot: FindingLedgerSnapshot;
  readonly updatedAtMs: number;
}

interface StoredReviewLoopJson {
  readonly schemaVersion: 1;
  readonly candidateRef: string | null;
  readonly scopeRevision: string | null;
  readonly criteriaRevision: string | null;
  readonly snapshot: FindingLedgerSnapshot;
}

export interface DurableHandoffStore extends HandoffStorePort {
  bindRunMetadata(handoffId: string, metadata: HandoffRunMetadata): void;
  getRunMetadata(handoffId: string): HandoffRunMetadata | null;
  saveRepresentation(representation: DeliveryRepresentation): void;
  loadRepresentation(
    handoffId: string,
    revision: number,
    targetAttemptId: string
  ): DeliveryRepresentation | null;
  recordObservation(observation: HandoffObservation): boolean;
  listObservations(handoffId: string): readonly HandoffObservation[];
  listHandoffIdsForRun(runId: string): readonly string[];
  listAllHandoffIds(): readonly string[];
  loadOrCreateReviewLoop(params: {
    readonly loopId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly options: LedgerOptions;
  }): { readonly ledger: FindingLedger; readonly entry: StoredReviewLoopEntry | null };
  saveReviewLoop(params: {
    readonly loopId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly ledger: FindingLedger;
    readonly options: LedgerOptions;
    readonly candidateRef?: string | null;
    readonly scopeRevision?: string | null;
    readonly criteriaRevision?: string | null;
  }): void;
  loadReviewLoop(loopId: string): StoredReviewLoopEntry | null;
  listReviewLoopsForRun(runId: string): readonly StoredReviewLoopEntry[];
  runInImmediateTransaction<T>(work: () => T): T;
}

function copyRevision(revision: AcceptedRevision): AcceptedRevision {
  return Object.freeze({
    revision: revision.revision,
    manifestDigest: revision.manifestDigest,
    serializedManifest: revision.serializedManifest,
    rendererVersion: revision.rendererVersion,
    renderedDigest: revision.renderedDigest,
    renderedBytes: revision.renderedBytes,
    state: revision.state
  });
}

function copyApproval(approval: ApprovalRecord): ApprovalRecord {
  return Object.freeze({ revision: approval.revision, decisionId: approval.decisionId });
}

function copyDispatch(dispatch: DispatchRecord): DispatchRecord {
  return Object.freeze({
    revision: dispatch.revision,
    targetAttemptId: dispatch.targetAttemptId,
    representationDigest: dispatch.representationDigest,
    state: dispatch.state
  });
}

function freezeRecord(record: HandoffRecord, version: number): HandoffRecord {
  return Object.freeze({
    handoffId: record.handoffId,
    version,
    revisions: Object.freeze(record.revisions.map(copyRevision)),
    approvals: Object.freeze(record.approvals.map(copyApproval)),
    dispatches: Object.freeze(record.dispatches.map(copyDispatch))
  });
}

function representationKey(revision: number, targetAttemptId: string): string {
  return `${revision}:${targetAttemptId}`;
}

function parseEnvelope(rawJson: string, rowVersion: number): StoredHandoffEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<StoredHandoffEnvelope>;
    if (candidate.record === undefined) return null;
    return {
      schemaVersion: 1,
      record: freezeRecord(candidate.record, rowVersion),
      representations: candidate.representations ?? {},
      observations: candidate.observations ?? {},
      laneId: typeof candidate.laneId === 'string' ? candidate.laneId : null
    };
  } catch {
    return null;
  }
}

class SqliteHandoffStoreImpl implements DurableHandoffStore {
  private readonly pendingMetaByHandoffId = new Map<string, HandoffRunMetadata>();
  private inImmediateTxDepth = 0;

  public constructor(
    private readonly conn: NodeSqliteConnection,
    private readonly nowMs: () => number
  ) {}

  private readRawRow(handoffId: string): RawHandoffRow | undefined {
    return this.conn.get<RawHandoffRow>(
      `SELECT handoff_id, run_id, source_attempt_id, target_phase_id, revision, status,
              record_json, created_at_ms, updated_at_ms
         FROM phase_handoff_records
        WHERE handoff_id = ?`,
      handoffId
    );
  }

  private deriveRowColumns(
    record: HandoffRecord,
    existing?: {
      readonly run_id: string;
      readonly source_attempt_id: string;
      readonly target_phase_id: string;
      readonly laneId: string | null;
    }
  ): {
    readonly runId: string;
    readonly sourceAttemptId: string;
    readonly targetPhaseId: string;
    readonly status: string;
    readonly laneId: string | null;
  } {
    const pending = this.pendingMetaByHandoffId.get(record.handoffId);
    const latestRev = record.revisions.at(-1);
    const manifest = latestRev !== undefined ? storedManifest(latestRev) : null;
    const runId =
      pending?.runId ?? existing?.run_id ?? manifest?.identity.workspaceId ?? 'unknown-run';
    const sourceAttemptId =
      pending?.sourceAttemptId ??
      existing?.source_attempt_id ??
      manifest?.sources[0]?.producer.attemptId ??
      'none';
    const targetPhaseId =
      pending?.targetPhaseId ??
      existing?.target_phase_id ??
      manifest?.identity.targetNodePath ??
      'unknown-target';
    const laneId =
      pending?.laneId !== undefined ? pending.laneId : (existing?.laneId ?? null);
    const latestDispatch = record.dispatches.at(-1);
    const status = latestDispatch?.state ?? latestRev?.state ?? 'empty';
    return { runId, sourceAttemptId, targetPhaseId, status, laneId };
  }

  public runInImmediateTransaction<T>(work: () => T): T {
    if (this.inImmediateTxDepth > 0) {
      return work();
    }
    this.inImmediateTxDepth += 1;
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      const outcome = work();
      this.conn.exec('COMMIT');
      return outcome;
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore rollback error on already-aborted transaction.
      }
      throw err;
    } finally {
      this.inImmediateTxDepth -= 1;
    }
  }

  public load(handoffId: string): HandoffRecord | null {
    const row = this.readRawRow(handoffId);
    if (row === undefined) return null;
    const env = parseEnvelope(row.record_json, row.revision);
    return env?.record ?? null;
  }

  public save(record: HandoffRecord, expectedVersion: number): boolean {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return false;
    const nextVersion = expectedVersion + 1;
    const frozen = freezeRecord(record, nextVersion);
    const now = this.nowMs();

    if (expectedVersion === 0) {
      if (this.readRawRow(record.handoffId) !== undefined) return false;
      const cols = this.deriveRowColumns(frozen);
      const envelope: StoredHandoffEnvelope = {
        schemaVersion: 1,
        record: frozen,
        representations: {},
        observations: {},
        laneId: cols.laneId
      };
      const recordJson = JSON.stringify(envelope);
      const recordBytes = Buffer.byteLength(recordJson, 'utf8');
      try {
        const res = this.conn.run(
          `INSERT INTO phase_handoff_records (
            handoff_id, run_id, source_attempt_id, target_phase_id,
            revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(handoff_id) DO NOTHING`,
          record.handoffId,
          cols.runId,
          cols.sourceAttemptId,
          cols.targetPhaseId,
          nextVersion,
          cols.status,
          recordJson,
          recordBytes,
          now,
          now
        );
        return res.changes === 1;
      } catch {
        return false;
      }
    }

    const existing = this.readRawRow(record.handoffId);
    if (existing === undefined || existing.revision !== expectedVersion) {
      return false;
    }
    const prevEnv = parseEnvelope(existing.record_json, existing.revision);
    const cols = this.deriveRowColumns(frozen, {
      run_id: existing.run_id,
      source_attempt_id: existing.source_attempt_id,
      target_phase_id: existing.target_phase_id,
      laneId: prevEnv?.laneId ?? null
    });
    const envelope: StoredHandoffEnvelope = {
      schemaVersion: 1,
      record: frozen,
      representations: prevEnv?.representations ?? {},
      observations: prevEnv?.observations ?? {},
      laneId: cols.laneId
    };
    const recordJson = JSON.stringify(envelope);
    const recordBytes = Buffer.byteLength(recordJson, 'utf8');
    const res = this.conn.run(
      `UPDATE phase_handoff_records
          SET run_id = ?, source_attempt_id = ?, target_phase_id = ?,
              revision = ?, status = ?, record_json = ?, record_bytes = ?, updated_at_ms = ?
        WHERE handoff_id = ? AND revision = ?`,
      cols.runId,
      cols.sourceAttemptId,
      cols.targetPhaseId,
      nextVersion,
      cols.status,
      recordJson,
      recordBytes,
      now,
      record.handoffId,
      expectedVersion
    );
    return res.changes === 1;
  }

  public bindRunMetadata(handoffId: string, metadata: HandoffRunMetadata): void {
    this.pendingMetaByHandoffId.set(handoffId, metadata);
    const existing = this.readRawRow(handoffId);
    if (existing === undefined) return;
    const env = parseEnvelope(existing.record_json, existing.revision);
    if (env === null) return;
    const updatedEnv: StoredHandoffEnvelope = {
      ...env,
      laneId: metadata.laneId !== undefined ? metadata.laneId : env.laneId
    };
    const recordJson = JSON.stringify(updatedEnv);
    this.conn.run(
      `UPDATE phase_handoff_records
          SET run_id = ?,
              source_attempt_id = COALESCE(?, source_attempt_id),
              target_phase_id = COALESCE(?, target_phase_id),
              record_json = ?,
              record_bytes = ?,
              updated_at_ms = ?
        WHERE handoff_id = ?`,
      metadata.runId,
      metadata.sourceAttemptId ?? null,
      metadata.targetPhaseId ?? null,
      recordJson,
      Buffer.byteLength(recordJson, 'utf8'),
      this.nowMs(),
      handoffId
    );
  }

  public getRunMetadata(handoffId: string): HandoffRunMetadata | null {
    const existing = this.readRawRow(handoffId);
    if (existing === undefined) {
      return this.pendingMetaByHandoffId.get(handoffId) ?? null;
    }
    const env = parseEnvelope(existing.record_json, existing.revision);
    return {
      runId: existing.run_id,
      sourceAttemptId: existing.source_attempt_id,
      targetPhaseId: existing.target_phase_id,
      laneId: env?.laneId ?? null
    };
  }

  public saveRepresentation(representation: DeliveryRepresentation): void {
    const existing = this.readRawRow(representation.handoffId);
    if (existing === undefined) return;
    const env = parseEnvelope(existing.record_json, existing.revision);
    if (env === null) return;
    const key = representationKey(representation.revision, representation.targetAttemptId);
    const updatedEnv: StoredHandoffEnvelope = {
      ...env,
      representations: { ...env.representations, [key]: representation }
    };
    const recordJson = JSON.stringify(updatedEnv);
    this.conn.run(
      `UPDATE phase_handoff_records
          SET record_json = ?, record_bytes = ?, updated_at_ms = ?
        WHERE handoff_id = ?`,
      recordJson,
      Buffer.byteLength(recordJson, 'utf8'),
      this.nowMs(),
      representation.handoffId
    );
  }

  public loadRepresentation(
    handoffId: string,
    revision: number,
    targetAttemptId: string
  ): DeliveryRepresentation | null {
    const existing = this.readRawRow(handoffId);
    if (existing === undefined) return null;
    const env = parseEnvelope(existing.record_json, existing.revision);
    if (env === null) return null;
    return env.representations[representationKey(revision, targetAttemptId)] ?? null;
  }

  public recordObservation(observation: HandoffObservation): boolean {
    const existing = this.readRawRow(observation.handoffId);
    if (existing === undefined) return false;
    const env = parseEnvelope(existing.record_json, existing.revision);
    if (env === null) return false;
    if (Object.hasOwn(env.observations, observation.key)) {
      return false;
    }
    const updatedEnv: StoredHandoffEnvelope = {
      ...env,
      observations: { ...env.observations, [observation.key]: observation }
    };
    const recordJson = JSON.stringify(updatedEnv);
    this.conn.run(
      `UPDATE phase_handoff_records
          SET record_json = ?, record_bytes = ?, updated_at_ms = ?
        WHERE handoff_id = ?`,
      recordJson,
      Buffer.byteLength(recordJson, 'utf8'),
      this.nowMs(),
      observation.handoffId
    );
    return true;
  }

  public listObservations(handoffId: string): readonly HandoffObservation[] {
    const existing = this.readRawRow(handoffId);
    if (existing === undefined) return [];
    const env = parseEnvelope(existing.record_json, existing.revision);
    if (env === null) return [];
    return Object.values(env.observations);
  }

  public listHandoffIdsForRun(runId: string): readonly string[] {
    const rows = this.conn.all<{ readonly handoff_id: string }>(
      `SELECT handoff_id FROM phase_handoff_records WHERE run_id = ? ORDER BY created_at_ms ASC, handoff_id ASC`,
      runId
    );
    return rows.map((r) => r.handoff_id);
  }

  public listAllHandoffIds(): readonly string[] {
    const rows = this.conn.all<{ readonly handoff_id: string }>(
      `SELECT handoff_id FROM phase_handoff_records ORDER BY updated_at_ms DESC, handoff_id ASC`
    );
    return rows.map((r) => r.handoff_id);
  }

  public loadOrCreateReviewLoop(params: {
    readonly loopId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly options: LedgerOptions;
  }): { readonly ledger: FindingLedger; readonly entry: StoredReviewLoopEntry | null } {
    const existing = this.loadReviewLoop(params.loopId);
    if (existing !== null) {
      return { ledger: rehydrateFindingLedger(existing.snapshot), entry: existing };
    }
    return { ledger: createFindingLedger(params.options), entry: null };
  }

  public saveReviewLoop(params: {
    readonly loopId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly ledger: FindingLedger;
    readonly options: LedgerOptions;
    readonly candidateRef?: string | null;
    readonly scopeRevision?: string | null;
    readonly criteriaRevision?: string | null;
  }): void {
    const snap: FindingLedgerSnapshot =
      typeof params.ledger.snapshot === 'function'
        ? params.ledger.snapshot()
        : {
            options: params.options,
            findings: params.ledger.findings(),
            passes: params.ledger.passes().map((outcome) => ({
              outcome,
              candidateRef: params.candidateRef ?? 'unknown',
              inputDigest: ''
            }))
          };
    const latestPass = snap.passes.at(-1)?.outcome;
    const iteration = latestPass?.pass ?? 0;
    const verdict: Verdict | 'pending' = latestPass?.verdict ?? 'pending';
    const existing = this.loadReviewLoop(params.loopId);
    const payload: StoredReviewLoopJson = {
      schemaVersion: 1,
      candidateRef:
        params.candidateRef !== undefined ? params.candidateRef : (existing?.candidateRef ?? null),
      scopeRevision:
        params.scopeRevision !== undefined
          ? params.scopeRevision
          : (existing?.scopeRevision ?? null),
      criteriaRevision:
        params.criteriaRevision !== undefined
          ? params.criteriaRevision
          : (existing?.criteriaRevision ?? null),
      snapshot: snap
    };
    this.conn.run(
      `INSERT INTO phase_review_loop_ledgers (
        loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(loop_id) DO UPDATE SET
        run_id = excluded.run_id,
        node_id = excluded.node_id,
        iteration = excluded.iteration,
        verdict = excluded.verdict,
        ledger_json = excluded.ledger_json,
        updated_at_ms = excluded.updated_at_ms`,
      params.loopId,
      params.runId,
      params.nodeId,
      iteration,
      verdict,
      JSON.stringify(payload),
      this.nowMs()
    );
  }

  public loadReviewLoop(loopId: string): StoredReviewLoopEntry | null {
    const row = this.conn.get<{
      readonly loop_id: string;
      readonly run_id: string;
      readonly node_id: string;
      readonly iteration: number;
      readonly verdict: string;
      readonly ledger_json: string;
      readonly updated_at_ms: number;
    }>(
      `SELECT loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms
         FROM phase_review_loop_ledgers
        WHERE loop_id = ?`,
      loopId
    );
    if (row === undefined) return null;
    try {
      const rawParsed: unknown = JSON.parse(row.ledger_json);
      if (rawParsed === null || typeof rawParsed !== 'object') return null;
      const parsed = rawParsed as Partial<StoredReviewLoopJson>;
      if (parsed.snapshot === undefined) return null;
      return {
        loopId: row.loop_id,
        runId: row.run_id,
        nodeId: row.node_id,
        iteration: row.iteration,
        verdict: row.verdict as Verdict | 'pending',
        candidateRef: parsed.candidateRef ?? null,
        scopeRevision: parsed.scopeRevision ?? null,
        criteriaRevision: parsed.criteriaRevision ?? null,
        snapshot: parsed.snapshot,
        updatedAtMs: row.updated_at_ms
      };
    } catch {
      return null;
    }
  }

  public listReviewLoopsForRun(runId: string): readonly StoredReviewLoopEntry[] {
    const rows = this.conn.all<{ readonly loop_id: string }>(
      `SELECT loop_id FROM phase_review_loop_ledgers WHERE run_id = ? ORDER BY updated_at_ms ASC, loop_id ASC`,
      runId
    );
    const result: StoredReviewLoopEntry[] = [];
    for (const row of rows) {
      const entry = this.loadReviewLoop(row.loop_id);
      if (entry !== null) result.push(entry);
    }
    return result;
  }
}

export function createSqliteHandoffStore(
  conn: NodeSqliteConnection,
  nowMs: () => number = () => Date.now()
): DurableHandoffStore {
  return new SqliteHandoffStoreImpl(conn, nowMs);
}
