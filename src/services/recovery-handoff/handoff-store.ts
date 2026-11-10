/**
 * FR-R6-F08 (contracts/recovery-handoff-store.md) — the only module issuing SQL against the
 * five recovery handoff tables.
 *
 * Every value is a bound parameter; column names in `updateHandoff` come from a fixed map,
 * never from the caller. Every write runs under `inImmediateTransaction`, so it joins the
 * caller's transaction or opens its own. Each insert is idempotent on its unique keys and
 * reports whether it created the row. Reads return frozen camelCase rows.
 *
 * A revision moves only draft -> issued -> superseded. The store triggers back the part that
 * protects content: once a revision leaves draft, its manifest and cutoff fields cannot change
 * and it cannot return to draft, and a superseded revision cannot change at all. They leave a
 * draft's own transitions to this module.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  DecisionOutcome,
  DeliveryOutcome,
  DeliveryOutcomeReason,
  DeliveryTransport,
  FreshSessionReason,
  HandoffClosedReason,
  HandoffDecision,
  HandoffPinPurpose,
  HandoffPinState,
  HandoffReferenceRole,
  HandoffResolution,
  HandoffState,
  SessionPlanKind
} from '../../contracts/recovery-handoff/handoff-types';
import type { RecoveryEffectCertainty, RecoveryWorkspaceCoverage } from '../../contracts/recovery-envelope';
import type { NodeSqliteConnection } from '../sqlite-store/sqlite-driver';
import { inImmediateTransaction } from '../usage-accounting/accounting-transaction';
import {
  toDecisionRow,
  toDeliveryRow,
  toHandoffRow,
  toReferenceRow,
  toRevisionRow,
  type DecisionRow,
  type DeliveryRow,
  type HandoffRow,
  type RawDecisionRow,
  type RawDeliveryRow,
  type RawHandoffRow,
  type RawReferenceRow,
  type RawRevisionRow,
  type ReferenceRow,
  type RevisionRow
} from './handoff-store-rows';

export type { DecisionRow, DeliveryRow, HandoffRow, ReferenceRow, RevisionRow } from './handoff-store-rows';

/** Thrown when a caller asks for a revision move the lifecycle forbids. */
export class HandoffStoreError extends Error {
  public constructor(
    public readonly code: 'revision-not-found' | 'revision-transition-refused',
    message: string
  ) {
    super(message);
    this.name = 'HandoffStoreError';
  }
}

export interface NewHandoffRow {
  readonly handoffId: string;
  readonly workspaceId: string;
  readonly rootExecutionId: string;
  readonly invocationId: string;
  readonly sourceAttemptId: string;
  readonly legacyProvenance: string | null;
  readonly nowMs: number;
}

export interface HandoffPatch {
  readonly state?: HandoffState;
  readonly paused?: boolean;
  readonly closedReason?: HandoffClosedReason | null;
  readonly currentRevision?: number | null;
  readonly pinPurpose?: HandoffPinPurpose | null;
  readonly pinPurposeTarget?: HandoffPinPurpose | null;
}

export interface NewRevisionRow {
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly cutoffKey: string;
  readonly executionRevision: string;
  readonly usageRevision: number;
  readonly factCutoffMs: number;
  readonly manifestVersion: number;
  readonly manifestJson: string;
  readonly manifestDigest: string;
  readonly certainty: RecoveryEffectCertainty;
  readonly coverage: RecoveryWorkspaceCoverage;
}

export interface NewReferenceRow {
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly required: boolean;
  readonly expectedDigest: string | null;
}

export interface NewDeliveryRow {
  readonly intentId: string;
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly targetAttemptId: string;
  readonly envelopeDigest: string;
  readonly transport: DeliveryTransport;
  readonly backendId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly ownerDigest: string;
  readonly sessionPlan: SessionPlanKind;
  readonly sessionReason: FreshSessionReason | null;
  readonly sessionId: string | null;
  readonly connectionId: string | null;
  readonly promptId: string | null;
  readonly capabilitiesDigest: string;
  readonly accessPlanDigest: string;
  readonly decisionId: string | null;
  readonly nowMs: number;
}

export interface NewDecisionRow {
  readonly decisionId: string;
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly decision: HandoffDecision;
  readonly outcome: DecisionOutcome;
  readonly nowMs: number;
}

/** The fixed patch-key to column map; `updateHandoff` names no other column. */
const HANDOFF_PATCH_COLUMNS = Object.freeze({
  state: 'state',
  paused: 'paused',
  closedReason: 'closed_reason',
  currentRevision: 'current_revision',
  pinPurpose: 'pin_purpose',
  pinPurposeTarget: 'pin_purpose_target'
} as const);

type PatchValue = string | number | null;

function patchValue(value: string | number | boolean | null): PatchValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export class SqliteHandoffStore {
  public constructor(private readonly conn: NodeSqliteConnection) {}

  public transaction<T>(work: () => T): T {
    return inImmediateTransaction(this.conn, work);
  }

  // ---- handoffs ----

  public getHandoff(handoffId: string): HandoffRow | undefined {
    const raw = this.conn.get<RawHandoffRow>(`SELECT * FROM recovery_handoffs WHERE handoff_id = ?`, handoffId);
    return raw === undefined ? undefined : toHandoffRow(raw);
  }

  public listOpenHandoffs(): readonly HandoffRow[] {
    return this.conn
      .all<RawHandoffRow>(
        `SELECT * FROM recovery_handoffs WHERE state NOT IN ('consumed', 'superseded') ORDER BY created_at_ms, handoff_id`
      )
      .map(toHandoffRow);
  }

  public insertHandoff(row: NewHandoffRow): boolean {
    return this.write(
      `INSERT INTO recovery_handoffs (handoff_id, workspace_id, root_execution_id, invocation_id,
         source_attempt_id, state, paused, legacy_provenance, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?) ON CONFLICT DO NOTHING`,
      row.handoffId,
      row.workspaceId,
      row.rootExecutionId,
      row.invocationId,
      row.sourceAttemptId,
      row.legacyProvenance,
      row.nowMs,
      row.nowMs
    );
  }

  public updateHandoff(handoffId: string, patch: HandoffPatch, nowMs: number): boolean {
    const assignments: string[] = [];
    const values: PatchValue[] = [];
    for (const [key, column] of Object.entries(HANDOFF_PATCH_COLUMNS)) {
      const value = patch[key as keyof HandoffPatch];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(patchValue(value));
    }
    assignments.push('updated_at_ms = ?');
    return this.write(
      `UPDATE recovery_handoffs SET ${assignments.join(', ')} WHERE handoff_id = ?`,
      ...values,
      nowMs,
      handoffId
    );
  }

  // ---- revisions ----

  public getRevision(handoffId: string, revisionNo: number): RevisionRow | undefined {
    const raw = this.conn.get<RawRevisionRow>(
      `SELECT * FROM recovery_handoff_revisions WHERE handoff_id = ? AND revision_no = ?`,
      handoffId,
      revisionNo
    );
    return raw === undefined ? undefined : toRevisionRow(raw);
  }

  public getRevisionByCutoff(handoffId: string, cutoffKey: string): RevisionRow | undefined {
    const raw = this.conn.get<RawRevisionRow>(
      `SELECT * FROM recovery_handoff_revisions WHERE handoff_id = ? AND cutoff_key = ?`,
      handoffId,
      cutoffKey
    );
    return raw === undefined ? undefined : toRevisionRow(raw);
  }

  public listRevisions(handoffId: string): readonly RevisionRow[] {
    return this.conn
      .all<RawRevisionRow>(
        `SELECT * FROM recovery_handoff_revisions WHERE handoff_id = ? ORDER BY revision_no`,
        handoffId
      )
      .map(toRevisionRow);
  }

  /** The highest revision number of a handoff, or 0 when it has none. */
  public maxRevisionNo(handoffId: string): number {
    const row = this.conn.get<{ n: number | null }>(
      `SELECT max(revision_no) AS n FROM recovery_handoff_revisions WHERE handoff_id = ?`,
      handoffId
    );
    return row?.n ?? 0;
  }

  public insertRevision(row: NewRevisionRow): boolean {
    return this.write(
      `INSERT INTO recovery_handoff_revisions (handoff_id, revision_no, status, cutoff_key,
         execution_revision, usage_revision, fact_cutoff_ms, manifest_version, manifest_json,
         manifest_digest, certainty, coverage)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      row.handoffId,
      row.revisionNo,
      row.cutoffKey,
      row.executionRevision,
      row.usageRevision,
      row.factCutoffMs,
      row.manifestVersion,
      row.manifestJson,
      row.manifestDigest,
      row.certainty,
      row.coverage
    );
  }

  /** draft -> issued. An already issued revision is a no-op; a superseded one throws. */
  public issueRevision(handoffId: string, revisionNo: number, nowMs: number): boolean {
    return this.transaction(() => {
      const status = this.requireRevision(handoffId, revisionNo).status;
      if (status === 'issued') return false;
      if (status === 'superseded') {
        throw new HandoffStoreError('revision-transition-refused', 'cannot issue a superseded revision');
      }
      return this.write(
        `UPDATE recovery_handoff_revisions SET status = 'issued', issued_at_ms = ?
         WHERE handoff_id = ? AND revision_no = ? AND status = 'draft'`,
        nowMs,
        handoffId,
        revisionNo
      );
    });
  }

  /** issued -> superseded. An already superseded revision is a no-op; a draft one throws. */
  public supersedeRevision(handoffId: string, revisionNo: number, nowMs: number): boolean {
    return this.transaction(() => {
      const status = this.requireRevision(handoffId, revisionNo).status;
      if (status === 'superseded') return false;
      if (status === 'draft') {
        throw new HandoffStoreError('revision-transition-refused', 'cannot supersede a draft revision');
      }
      return this.write(
        `UPDATE recovery_handoff_revisions SET status = 'superseded', superseded_at_ms = ?
         WHERE handoff_id = ? AND revision_no = ? AND status = 'issued'`,
        nowMs,
        handoffId,
        revisionNo
      );
    });
  }

  // ---- references ----

  public insertReference(row: NewReferenceRow): boolean {
    return this.write(
      `INSERT INTO recovery_handoff_references (handoff_id, revision_no, artifact_id, role,
         required, expected_digest, pin_state)
       VALUES (?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT DO NOTHING`,
      row.handoffId,
      row.revisionNo,
      row.artifactId,
      row.role,
      row.required ? 1 : 0,
      row.expectedDigest
    );
  }

  public listReferences(handoffId: string, revisionNo: number): readonly ReferenceRow[] {
    return this.conn
      .all<RawReferenceRow>(
        `SELECT * FROM recovery_handoff_references WHERE handoff_id = ? AND revision_no = ?
         ORDER BY role, artifact_id`,
        handoffId,
        revisionNo
      )
      .map(toReferenceRow);
  }

  public listReferencesForHandoff(handoffId: string): readonly ReferenceRow[] {
    return this.conn
      .all<RawReferenceRow>(
        `SELECT * FROM recovery_handoff_references WHERE handoff_id = ?
         ORDER BY revision_no, role, artifact_id`,
        handoffId
      )
      .map(toReferenceRow);
  }

  public setPinState(
    handoffId: string,
    revisionNo: number,
    artifactId: string,
    pinState: HandoffPinState,
    pinRefusal: string | null
  ): boolean {
    return this.write(
      `UPDATE recovery_handoff_references SET pin_state = ?, pin_refusal = ?
       WHERE handoff_id = ? AND revision_no = ? AND artifact_id = ?`,
      pinState,
      pinRefusal,
      handoffId,
      revisionNo,
      artifactId
    );
  }

  public setResolution(
    handoffId: string,
    revisionNo: number,
    artifactId: string,
    resolution: HandoffResolution,
    nowMs: number
  ): boolean {
    return this.write(
      `UPDATE recovery_handoff_references SET last_resolution = ?, resolved_at_ms = ?
       WHERE handoff_id = ? AND revision_no = ? AND artifact_id = ?`,
      resolution,
      nowMs,
      handoffId,
      revisionNo,
      artifactId
    );
  }

  // ---- deliveries ----

  public insertDelivery(row: NewDeliveryRow): boolean {
    return this.write(
      `INSERT INTO recovery_handoff_deliveries (intent_id, handoff_id, revision_no,
         target_attempt_id, envelope_digest, transport, backend_id, profile_id, profile_version,
         owner_digest, session_plan, session_reason, session_id, connection_id, prompt_id,
         capabilities_digest, access_plan_digest, outcome, decision_id, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`,
      row.intentId,
      row.handoffId,
      row.revisionNo,
      row.targetAttemptId,
      row.envelopeDigest,
      row.transport,
      row.backendId,
      row.profileId,
      row.profileVersion,
      row.ownerDigest,
      row.sessionPlan,
      row.sessionReason,
      row.sessionId,
      row.connectionId,
      row.promptId,
      row.capabilitiesDigest,
      row.accessPlanDigest,
      row.decisionId,
      row.nowMs
    );
  }

  public getDelivery(intentId: string): DeliveryRow | undefined {
    const raw = this.conn.get<RawDeliveryRow>(`SELECT * FROM recovery_handoff_deliveries WHERE intent_id = ?`, intentId);
    return raw === undefined ? undefined : toDeliveryRow(raw);
  }

  public listDeliveries(handoffId: string): readonly DeliveryRow[] {
    return this.conn
      .all<RawDeliveryRow>(
        `SELECT * FROM recovery_handoff_deliveries WHERE handoff_id = ? ORDER BY recorded_at_ms, rowid`,
        handoffId
      )
      .map(toDeliveryRow);
  }

  public listPendingDeliveries(): readonly DeliveryRow[] {
    return this.conn
      .all<RawDeliveryRow>(
        `SELECT * FROM recovery_handoff_deliveries WHERE outcome = 'pending' ORDER BY recorded_at_ms, rowid`
      )
      .map(toDeliveryRow);
  }

  /** pending -> a final outcome, once. A delivery already settled is left as it is. */
  public settleDelivery(
    intentId: string,
    outcome: Exclude<DeliveryOutcome, 'pending'>,
    reason: DeliveryOutcomeReason | null,
    nowMs: number
  ): boolean {
    return this.write(
      `UPDATE recovery_handoff_deliveries SET outcome = ?, outcome_reason = ?, settled_at_ms = ?
       WHERE intent_id = ? AND outcome = 'pending'`,
      outcome,
      reason,
      nowMs,
      intentId
    );
  }

  /** pending or uncertain -> acknowledged, once: an acknowledgement after a restart still lands. */
  public acknowledgeDelivery(intentId: string, nowMs: number): boolean {
    return this.write(
      `UPDATE recovery_handoff_deliveries SET outcome = 'acknowledged', outcome_reason = NULL, settled_at_ms = ?
       WHERE intent_id = ? AND outcome IN ('pending', 'uncertain')`,
      nowMs,
      intentId
    );
  }

  /** Closed handoffs whose pins an interrupted close left; restart releases them. */
  public listClosedHandoffsHoldingPins(): readonly string[] {
    return this.conn
      .all<{ handoff_id: string }>(
        `SELECT DISTINCT h.handoff_id FROM recovery_handoffs h
         JOIN recovery_handoff_references r ON r.handoff_id = h.handoff_id
         WHERE h.state IN ('consumed', 'superseded') AND r.pin_state IN ('pinned', 'pending')
         ORDER BY h.handoff_id`
      )
      .map((row) => row.handoff_id);
  }

  // ---- decisions ----

  public insertDecision(row: NewDecisionRow): boolean {
    return this.write(
      `INSERT INTO recovery_handoff_decisions (decision_id, handoff_id, revision_no, decision,
         outcome, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      row.decisionId,
      row.handoffId,
      row.revisionNo,
      row.decision,
      row.outcome,
      row.nowMs
    );
  }

  public getDecision(decisionId: string): DecisionRow | undefined {
    const raw = this.conn.get<RawDecisionRow>(`SELECT * FROM recovery_handoff_decisions WHERE decision_id = ?`, decisionId);
    return raw === undefined ? undefined : toDecisionRow(raw);
  }

  public listDecisions(handoffId: string): readonly DecisionRow[] {
    return this.conn
      .all<RawDecisionRow>(
        `SELECT * FROM recovery_handoff_decisions WHERE handoff_id = ? ORDER BY recorded_at_ms, decision_id`,
        handoffId
      )
      .map(toDecisionRow);
  }

  /** Binds an accepted decision to the one intent that consumes it; a second bind is refused. */
  public markDecisionConsumed(decisionId: string, intentId: string): boolean {
    return this.write(
      `UPDATE recovery_handoff_decisions SET consumed_by_intent_id = ?
       WHERE decision_id = ? AND consumed_by_intent_id IS NULL`,
      intentId,
      decisionId
    );
  }

  // ---- internals ----

  private requireRevision(handoffId: string, revisionNo: number): RevisionRow {
    const revision = this.getRevision(handoffId, revisionNo);
    if (revision === undefined) {
      throw new HandoffStoreError('revision-not-found', `recovery handoff revision ${revisionNo} not found`);
    }
    return revision;
  }

  private write(sql: string, ...params: PatchValue[]): boolean {
    return this.transaction(() => this.conn.run(sql, ...params).changes === 1);
  }
}

export function createHandoffStore(conn: NodeSqliteConnection): SqliteHandoffStore {
  return new SqliteHandoffStore(conn);
}
