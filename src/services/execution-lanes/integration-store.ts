/**
 * FR-R6-F10 (data-model.md, research R6): integration requests, verification results, review
 * receipts and the integration journal.
 *
 * At most one request per repository may be `verifying` or `landing`; the partial unique index
 * `lane_integration_active_per_repository` enforces that, and a transition the index refuses
 * returns `integration-busy` with nothing changed (FR-009).
 *
 * Every write runs in `BEGIN IMMEDIATE` through `inImmediateTransaction`, joining a transaction the
 * caller already holds. Every statement binds its values; the only text built at run time is a list
 * of `?` placeholders.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  laneOk,
  laneRefused,
  type IntegrationState,
  type JournalKind,
  type JournalOutcome,
  type LandingMethod,
  type LanePage,
  type LaneResult,
  type ReceiptOutcome
} from '../../contracts/execution-lanes';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from '../usage-accounting/accounting-transaction';
import {
  JOURNAL_COLUMNS,
  RECEIPT_COLUMNS,
  REQUEST_COLUMNS,
  RESULT_COLUMNS,
  journalFromRow,
  receiptFromRow,
  requestFromRow,
  requestInsertParams,
  resultFromRow,
  type JournalRecord,
  type JournalRow,
  type ReceiptRecord,
  type ReceiptRow,
  type RequestRecord,
  type RequestRow,
  type VerificationResultRecord,
  type VerificationResultRow
} from './integration-store-rows';
import {
  assertPageLimit,
  decodeLaneCursor,
  encodeLaneCursor,
  sqlPlaceholders as placeholders
} from './lane-store-rows';

export type {
  JournalRecord,
  ReceiptRecord,
  RequestRecord,
  VerificationResultRecord
} from './integration-store-rows';

/** SQLite's extended result code for a UNIQUE constraint violation. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** The open states a new candidate makes stale (data-model, integration lifecycle). */
const STALE_ON_NEW_CANDIDATE: readonly IntegrationState[] = Object.freeze(['queued', 'awaiting-review', 'blocked']);
const REVIEW_STALE_REASON = 'review-stale';

export interface RequestTransition {
  readonly reason: string | null;
  readonly now: string;
  readonly generation: number;
  /** Entering `verifying`: count a new verification attempt. */
  readonly startAttempt?: boolean;
}

export interface RequestListQuery {
  readonly limit: number;
  readonly cursor?: string;
  readonly laneId?: string;
  readonly states?: readonly IntegrationState[];
}

export interface JournalAppend {
  readonly entryId: string;
  readonly requestId: string;
  readonly kind: JournalKind;
  readonly method: LandingMethod | null;
  readonly candidateCommit: string;
  readonly expectedCommit: string;
  readonly observedTip: string | null;
  readonly outcome: JournalOutcome | null;
  readonly reason: string | null;
  readonly generation: number;
  readonly now: string;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE;
}

export class IntegrationStore {
  public constructor(private readonly conn: NodeSqliteConnection) {}

  // ---- requests ----

  public insertRequest(record: RequestRecord): void {
    inImmediateTransaction(this.conn, () => {
      this.conn.run(
        `INSERT INTO lane_integration_requests (${REQUEST_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...requestInsertParams(record)
      );
    });
  }

  public getRequest(workspaceId: string, requestId: string): RequestRecord | null {
    const row = this.conn.get<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM lane_integration_requests WHERE workspace_id = ? AND request_id = ?`,
      workspaceId,
      requestId
    );
    return row === undefined ? null : requestFromRow(row);
  }

  /**
   * Moves a request from one of `from` to `to`. A move the per-repository index refuses returns
   * `integration-busy`; the failed statement changes nothing, the attempt count included.
   */
  public transitionRequest(
    workspaceId: string,
    requestId: string,
    from: readonly IntegrationState[],
    to: IntegrationState,
    change: RequestTransition
  ): LaneResult<RequestRecord> {
    return inImmediateTransaction(this.conn, () => {
      const attemptStep = change.startAttempt === true ? 1 : 0;
      let changes: number;
      try {
        changes = this.conn.run(
          `UPDATE lane_integration_requests
           SET state = ?, reason = ?, owner_generation = ?, updated_at = ?,
               verification_attempt = verification_attempt + ?
           WHERE workspace_id = ? AND request_id = ? AND state IN (${placeholders(from.length)})`,
          to,
          change.reason,
          change.generation,
          change.now,
          attemptStep,
          workspaceId,
          requestId,
          ...from
        ).changes;
      } catch (error) {
        if (isUniqueViolation(error)) return laneRefused<RequestRecord>('integration-busy');
        throw error;
      }
      const request = this.getRequest(workspaceId, requestId);
      if (request === null) return laneRefused<RequestRecord>('request-not-found');
      return changes === 1 ? laneOk(request) : laneRefused<RequestRecord>('request-state-invalid');
    });
  }

  /** A new candidate makes every open request of the lane stale; returns how many it blocked. */
  public blockOpenRequestsForLane(laneId: string, change: { readonly now: string; readonly generation: number }): number {
    return inImmediateTransaction(this.conn, () => {
      return this.conn.run(
        `UPDATE lane_integration_requests SET state = 'blocked', reason = ?, owner_generation = ?, updated_at = ?
         WHERE lane_id = ? AND state IN (${placeholders(STALE_ON_NEW_CANDIDATE.length)})`,
        REVIEW_STALE_REASON,
        change.generation,
        change.now,
        laneId,
        ...STALE_ON_NEW_CANDIDATE
      ).changes;
    });
  }

  public countLaneRequests(laneId: string, states: readonly IntegrationState[]): number {
    if (states.length === 0) return 0;
    const row = this.conn.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM lane_integration_requests
       WHERE lane_id = ? AND state IN (${placeholders(states.length)})`,
      laneId,
      ...states
    );
    return row?.count ?? 0;
  }

  /** Requests of the workspace in any of `states`, oldest first; for reconcile. */
  public requestsInStates(workspaceId: string, states: readonly IntegrationState[]): readonly RequestRecord[] {
    if (states.length === 0) return [];
    return this.conn
      .all<RequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM lane_integration_requests
         WHERE workspace_id = ? AND state IN (${placeholders(states.length)})
         ORDER BY created_at, request_id`,
        workspaceId,
        ...states
      )
      .map(requestFromRow);
  }

  /** Oldest first by `(created_at, request_id)`; `limit` is 1..200 (`LANE_PAGE_LIMIT_MAX`). */
  public listRequests(workspaceId: string, query: RequestListQuery): LaneResult<LanePage<RequestRecord>> {
    assertPageLimit(query.limit);
    const position = query.cursor === undefined ? null : decodeLaneCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return laneRefused('invalid-input');

    const where = ['workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (position !== null) {
      where.push('(created_at > ? OR (created_at = ? AND request_id > ?))');
      params.push(position.createdAt, position.createdAt, position.id);
    }
    if (query.laneId !== undefined) {
      where.push('lane_id = ?');
      params.push(query.laneId);
    }
    if (query.states !== undefined && query.states.length > 0) {
      where.push(`state IN (${placeholders(query.states.length)})`);
      params.push(...query.states);
    }
    const rows = this.conn.all<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM lane_integration_requests WHERE ${where.join(' AND ')}
       ORDER BY created_at, request_id LIMIT ?`,
      ...params,
      query.limit + 1
    );
    const items = rows.slice(0, query.limit).map(requestFromRow);
    const last = items.at(-1);
    const hasMore = rows.length > query.limit && last !== undefined;
    const nextCursor = hasMore ? encodeLaneCursor(last.createdAt, last.requestId) : null;
    return laneOk({ items, nextCursor });
  }

  // ---- verification results ----

  /** Throws on a second result for the same `(request, attempt, check)`. */
  public insertVerificationResult(result: VerificationResultRecord): void {
    inImmediateTransaction(this.conn, () => {
      this.conn.run(
        `INSERT INTO lane_verification_results (${RESULT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        result.resultId,
        result.requestId,
        result.attempt,
        result.checkIndex,
        result.checkName,
        result.candidateCommit,
        result.exitCode,
        result.signal,
        result.timedOut ? 1 : 0,
        result.durationMs,
        result.outputBytes,
        result.outputSha256,
        result.recordedAt
      );
    });
  }

  public listVerificationResults(requestId: string, attempt: number): VerificationResultRecord[] {
    return this.conn
      .all<VerificationResultRow>(
        `SELECT ${RESULT_COLUMNS} FROM lane_verification_results WHERE request_id = ? AND attempt = ?
         ORDER BY check_index`,
        requestId,
        attempt
      )
      .map(resultFromRow);
  }

  // ---- receipts ----

  /** Throws on a second receipt for the same request. */
  public insertReceipt(receipt: ReceiptRecord): void {
    inImmediateTransaction(this.conn, () => {
      this.conn.run(
        `INSERT INTO lane_review_receipts (${RECEIPT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        receipt.receiptId,
        receipt.requestId,
        receipt.laneId,
        receipt.candidateCommit,
        receipt.targetRef,
        receipt.targetCommit,
        receipt.profileRevision,
        receipt.profileDigest,
        receipt.approvedAt,
        receipt.outcome,
        receipt.outcomeReason,
        receipt.ownerGeneration
      );
    });
  }

  public getReceipt(requestId: string): ReceiptRecord | null {
    const row = this.conn.get<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM lane_review_receipts WHERE request_id = ?`,
      requestId
    );
    return row === undefined ? null : receiptFromRow(row);
  }

  /** Writes the outcome once; returns false when the receipt is missing or already has one. */
  public setReceiptOutcome(requestId: string, outcome: ReceiptOutcome, reason: string | null): boolean {
    return inImmediateTransaction(this.conn, () => {
      const updated = this.conn.run(
        `UPDATE lane_review_receipts SET outcome = ?, outcome_reason = ? WHERE request_id = ? AND outcome IS NULL`,
        outcome,
        reason,
        requestId
      );
      return updated.changes === 1;
    });
  }

  // ---- journal ----

  /** Appends with the next per-request `entry_seq`, in the same transaction as the read of the last one. */
  public appendJournal(entry: JournalAppend): JournalRecord {
    return inImmediateTransaction(this.conn, () => {
      const last = this.conn.get<{ seq: number | null }>(
        'SELECT MAX(entry_seq) AS seq FROM lane_integration_journal WHERE request_id = ?',
        entry.requestId
      );
      const record: JournalRecord = {
        entryId: entry.entryId,
        requestId: entry.requestId,
        seq: (last?.seq ?? 0) + 1,
        kind: entry.kind,
        method: entry.method,
        candidateCommit: entry.candidateCommit,
        expectedCommit: entry.expectedCommit,
        observedTip: entry.observedTip,
        outcome: entry.outcome,
        reason: entry.reason,
        ownerGeneration: entry.generation,
        recordedAt: entry.now
      };
      this.conn.run(
        `INSERT INTO lane_integration_journal (${JOURNAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.entryId,
        record.requestId,
        record.seq,
        record.kind,
        record.method,
        record.candidateCommit,
        record.expectedCommit,
        record.observedTip,
        record.outcome,
        record.reason,
        record.ownerGeneration,
        record.recordedAt
      );
      return record;
    });
  }

  public listJournal(requestId: string): JournalRecord[] {
    return this.conn
      .all<JournalRow>(
        `SELECT ${JOURNAL_COLUMNS} FROM lane_integration_journal WHERE request_id = ? ORDER BY entry_seq`,
        requestId
      )
      .map(journalFromRow);
  }
}
