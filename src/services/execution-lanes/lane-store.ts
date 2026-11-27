/**
 * FR-R6-F10 (data-model.md, research R7): lanes, operations, candidates and the generation fence.
 *
 * Every write runs in `BEGIN IMMEDIATE` through `inImmediateTransaction`, joining a transaction the
 * caller already holds. {@link LaneStore.fenced} opens that transaction, checks the caller's host
 * generation inside it, and only then runs the work, so a superseded owner can never interleave a
 * write between the check and the effect.
 *
 * Every statement binds its values; the only text built at run time is a list of `?` placeholders.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  LIVE_LANE_STATES,
  laneOk,
  laneRefused,
  type LaneOperationKind,
  type LaneOperationStatus,
  type LanePage,
  type LaneResult,
  type LaneState
} from '../../contracts/execution-lanes';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from '../usage-accounting/accounting-transaction';
import {
  CANDIDATE_COLUMNS,
  LANE_COLUMNS,
  OPERATION_COLUMNS,
  assertPageLimit,
  candidateFromRow,
  decodeLaneCursor,
  encodeLaneCursor,
  laneFromRow,
  laneInsertParams,
  operationFromRow,
  sqlPlaceholders as placeholders,
  type CandidateRecord,
  type CandidateRow,
  type LaneRecord,
  type LaneRow,
  type OperationRecord,
  type OperationRow
} from './lane-store-rows';

export interface LaneTransition {
  readonly reason: string | null;
  readonly now: string;
  /** Recorded as the lane's owner generation. */
  readonly generation: number;
  /** When `true`, refuses `lane-pinned` if the lane is currently pinned (concurrent pin guard). */
  readonly requireUnpinned?: boolean;
}

export interface LaneListQuery {
  /** 1..200 (`LANE_PAGE_LIMIT_MAX`); the port has already refused anything else. */
  readonly limit: number;
  readonly cursor?: string;
  readonly states?: readonly LaneState[];
}

export interface OperationStart {
  readonly operationId: string;
  readonly laneId: string;
  readonly workspaceId: string;
  readonly kind: LaneOperationKind;
  readonly generation: number;
  readonly now: string;
}

export interface CandidateInsert {
  readonly candidateId: string;
  readonly laneId: string;
  readonly commit: string;
  readonly tree: string;
  readonly parent: string;
  readonly generation: number;
  readonly now: string;
}

export class LaneStore {
  public constructor(private readonly conn: NodeSqliteConnection) {}

  // ---- generation fence (research R7) ----

  /** Claims the next generation for `workspaceId`; the first claim is 1. */
  public claimGeneration(workspaceId: string, now: string): number {
    return inImmediateTransaction(this.conn, () => {
      const next = (this.currentGeneration(workspaceId) ?? 0) + 1;
      this.conn.run(
        `INSERT INTO lane_host_generations (workspace_id, generation, claimed_at) VALUES (?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET generation = excluded.generation, claimed_at = excluded.claimed_at`,
        workspaceId,
        next,
        now
      );
      return next;
    });
  }

  public currentGeneration(workspaceId: string): number | null {
    const row = this.conn.get<{ generation: number }>(
      'SELECT generation FROM lane_host_generations WHERE workspace_id = ?',
      workspaceId
    );
    return row === undefined ? null : row.generation;
  }

  /** Refuses `ownership-superseded` unless `generation` is the workspace's current one. */
  public assertGeneration(workspaceId: string, generation: number): LaneResult<void> {
    return this.currentGeneration(workspaceId) === generation ? laneOk(undefined) : laneRefused('ownership-superseded');
  }

  /** Runs `work` in one IMMEDIATE transaction, after the fence admits `generation`. */
  public fenced<T>(workspaceId: string, generation: number, work: () => LaneResult<T>): LaneResult<T> {
    return inImmediateTransaction(this.conn, () => {
      const fence = this.assertGeneration(workspaceId, generation);
      if (!fence.ok) return laneRefused<T>(fence.refusal.reason);
      return work();
    });
  }

  // ---- lanes ----

  public insertLane(lane: LaneRecord): void {
    inImmediateTransaction(this.conn, () => {
      this.conn.run(
        `INSERT INTO execution_lanes (${LANE_COLUMNS}) VALUES (${placeholders(15)})`,
        ...laneInsertParams(lane)
      );
    });
  }

  public getLane(workspaceId: string, laneId: string): LaneRecord | null {
    const row = this.conn.get<LaneRow>(
      `SELECT ${LANE_COLUMNS} FROM execution_lanes WHERE workspace_id = ? AND lane_id = ?`,
      workspaceId,
      laneId
    );
    return row === undefined ? null : laneFromRow(row);
  }

  /** Moves a lane to `to` only from one of `from`; otherwise `lane-state-invalid`, `lane-pinned` or `lane-not-found`. */
  public transitionLane(
    workspaceId: string,
    laneId: string,
    from: readonly LaneState[],
    to: LaneState,
    change: LaneTransition
  ): LaneResult<LaneRecord> {
    return inImmediateTransaction(this.conn, () => {
      const pinGuard = change.requireUnpinned === true ? ' AND pinned = 0' : '';
      const updated = this.conn.run(
        `UPDATE execution_lanes SET state = ?, state_reason = ?, owner_generation = ?, updated_at = ?
         WHERE workspace_id = ? AND lane_id = ? AND state IN (${placeholders(from.length)})${pinGuard}`,
        to,
        change.reason,
        change.generation,
        change.now,
        workspaceId,
        laneId,
        ...from
      );
      const lane = this.getLane(workspaceId, laneId);
      if (lane === null) return laneRefused<LaneRecord>('lane-not-found');
      if (updated.changes === 1) return laneOk(lane);
      if (change.requireUnpinned === true && lane.pinned) return laneRefused<LaneRecord>('lane-pinned');
      return laneRefused<LaneRecord>('lane-state-invalid');
    });
  }

  /** Pinning changes no state (data-model, lane lifecycle). */
  public setPinned(workspaceId: string, laneId: string, pinned: boolean, now: string): LaneResult<LaneRecord> {
    return inImmediateTransaction(this.conn, () => {
      this.conn.run(
        'UPDATE execution_lanes SET pinned = ?, updated_at = ? WHERE workspace_id = ? AND lane_id = ?',
        pinned ? 1 : 0,
        now,
        workspaceId,
        laneId
      );
      const lane = this.getLane(workspaceId, laneId);
      return lane === null ? laneRefused<LaneRecord>('lane-not-found') : laneOk(lane);
    });
  }

  /** Lanes in `preparing`, `active` or `paused`: the ones the live-lane cap counts (NFR-001). */
  public countLiveLanes(workspaceId: string): number {
    const row = this.conn.get<{ live: number }>(
      `SELECT COUNT(*) AS live FROM execution_lanes
       WHERE workspace_id = ? AND state IN (${placeholders(LIVE_LANE_STATES.length)})`,
      workspaceId,
      ...LIVE_LANE_STATES
    );
    return row === undefined ? 0 : row.live;
  }

  /** Lanes of the workspace in any of `states`, oldest first; for reconcile and cleanup. */
  public lanesInStates(workspaceId: string, states: readonly LaneState[]): readonly LaneRecord[] {
    if (states.length === 0) return [];
    return this.conn
      .all<LaneRow>(
        `SELECT ${LANE_COLUMNS} FROM execution_lanes
         WHERE workspace_id = ? AND state IN (${placeholders(states.length)})
         ORDER BY created_at, lane_id`,
        workspaceId,
        ...states
      )
      .map(laneFromRow);
  }

  /** A keyset page, oldest first; a cursor this module did not encode refuses `invalid-input`. */
  public listLanes(workspaceId: string, query: LaneListQuery): LaneResult<LanePage<LaneRecord>> {
    assertPageLimit(query.limit);
    const position = query.cursor === undefined ? null : decodeLaneCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return laneRefused('invalid-input');

    const where = ['workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (position !== null) {
      where.push('(created_at > ? OR (created_at = ? AND lane_id > ?))');
      params.push(position.createdAt, position.createdAt, position.id);
    }
    if (query.states !== undefined) {
      if (query.states.length === 0) return laneOk({ items: [], nextCursor: null });
      where.push(`state IN (${placeholders(query.states.length)})`);
      params.push(...query.states);
    }
    const rows = this.conn.all<LaneRow>(
      `SELECT ${LANE_COLUMNS} FROM execution_lanes WHERE ${where.join(' AND ')}
       ORDER BY created_at, lane_id LIMIT ?`,
      ...params,
      query.limit + 1
    );
    const items = rows.slice(0, query.limit).map(laneFromRow);
    const last = items.at(-1);
    const nextCursor = rows.length > query.limit && last !== undefined ? encodeLaneCursor(last.createdAt, last.laneId) : null;
    return laneOk({ items, nextCursor });
  }

  // ---- operations ----

  public beginOperation(start: OperationStart): void {
    inImmediateTransaction(this.conn, () => {
      this.conn.run(
        `INSERT INTO lane_operations (${OPERATION_COLUMNS}) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
        start.operationId,
        start.laneId,
        start.workspaceId,
        start.kind,
        start.generation,
        start.now
      );
    });
  }

  /** Ends a pending operation once; `false` when it is not pending. */
  public endOperation(operationId: string, status: LaneOperationStatus, reason: string | null, now: string): boolean {
    return inImmediateTransaction(this.conn, () => {
      const updated = this.conn.run(
        `UPDATE lane_operations SET status = ?, reason = ?, ended_at = ?
         WHERE operation_id = ? AND status = 'pending'`,
        status,
        reason,
        now,
        operationId
      );
      return updated.changes === 1;
    });
  }

  public getOperation(operationId: string): OperationRecord | null {
    const row = this.conn.get<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM lane_operations WHERE operation_id = ?`,
      operationId
    );
    return row === undefined ? null : operationFromRow(row);
  }

  public listOperations(laneId: string): readonly OperationRecord[] {
    return this.conn
      .all<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} FROM lane_operations WHERE lane_id = ? ORDER BY started_at, operation_id`,
        laneId
      )
      .map(operationFromRow);
  }

  /** Operations of the workspace still `pending`: what an interruption left behind. */
  public listPendingOperations(workspaceId: string): readonly OperationRecord[] {
    return this.conn
      .all<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} FROM lane_operations
         WHERE workspace_id = ? AND status = 'pending' ORDER BY started_at, operation_id`,
        workspaceId
      )
      .map(operationFromRow);
  }

  /** Most recently inserted operation for a lane (using rowid tie-break for identical timestamps). */
  public latestOperation(laneId: string): OperationRecord | null {
    const row = this.conn.get<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM lane_operations
       WHERE lane_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      laneId
    );
    return row === undefined ? null : operationFromRow(row);
  }

  /** Whether `laneId` currently has a `pending` operation of `kind`. */
  public hasPendingOperation(laneId: string, kind: LaneOperationKind): boolean {
    const row = this.conn.get<{ found: number }>(
      `SELECT 1 AS found FROM lane_operations WHERE lane_id = ? AND kind = ? AND status = 'pending' LIMIT 1`,
      laneId,
      kind
    );
    return row !== undefined;
  }

  /**
   * Whether `laneId`'s provisioning failed and never succeeded (so its worktree may never have
   * been created or registered in Git).
   */
  public isProvisionFailureWithoutSuccess(laneId: string): boolean {
    const row = this.conn.get<{ failed_only: number }>(
      `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM lane_operations WHERE lane_id = ? AND kind = 'provision' AND status = 'failed')
          AND NOT EXISTS (SELECT 1 FROM lane_operations WHERE lane_id = ? AND kind = 'provision' AND status = 'succeeded')
         THEN 1 ELSE 0 END AS failed_only`,
      laneId,
      laneId
    );
    return row?.failed_only === 1;
  }

  /**
   * Prunes non-pending `lane_operations` beyond `maxPerLane` per lane in `workspaceId`, keeping
   * `provision` operations first (so `isProvisionFailureWithoutSuccess()` remains authoritative)
   * followed by the newest non-pending rows, and never removing `pending` operations. Call inside
   * `fenced(...)`.
   */
  public pruneExcessOperations(workspaceId: string, maxPerLane: number): number {
    return inImmediateTransaction(this.conn, () => {
      const overCap = this.conn.all<{ lane_id: string }>(
        `SELECT lane_id FROM lane_operations
         WHERE workspace_id = ? AND status <> 'pending'
         GROUP BY lane_id
         HAVING COUNT(*) > ?`,
        workspaceId,
        maxPerLane
      );
      let pruned = 0;
      for (const { lane_id } of overCap) {
        pruned += this.conn.run(
          `DELETE FROM lane_operations
           WHERE lane_id = ? AND status <> 'pending'
             AND rowid NOT IN (
               SELECT rowid FROM lane_operations
               WHERE lane_id = ? AND status <> 'pending'
               ORDER BY CASE WHEN kind = 'provision' THEN 0 ELSE 1 END ASC, started_at DESC, rowid DESC
               LIMIT ?
             )`,
          lane_id,
          lane_id,
          maxPerLane
        ).changes;
      }
      return pruned;
    });
  }

  /**
   * Prunes unpinned `removed` lanes that hold no pending operations, no open requests, no
   * reachable candidates, and no recovery receipts or journals, when older than `cutoffIso` or
   * exceeding `maxTerminalLanes`. `preparation-failed` lanes are never pruned here because their
   * worktree or `baseRef` may still exist on disk/Git until explicitly cleaned up to `removed`.
   * Call inside `fenced(...)`.
   */
  public pruneEligibleTerminalLanes(
    workspaceId: string,
    cutoffIso: string,
    maxTerminalLanes: number
  ): {
    readonly lanesPruned: number;
    readonly operationsPruned: number;
    readonly requestsPruned: number;
    readonly verificationResultsPruned: number;
  } {
    return inImmediateTransaction(this.conn, () => {
      const eligible = this.conn.all<{ lane_id: string; updated_at: string }>(
        `SELECT l.lane_id, l.updated_at
         FROM execution_lanes l
         WHERE l.workspace_id = ?
           AND l.state = 'removed'
           AND l.pinned = 0
           AND NOT EXISTS (
             SELECT 1 FROM lane_operations o
             WHERE o.lane_id = l.lane_id AND o.status = 'pending'
           )
           AND NOT EXISTS (
             SELECT 1 FROM lane_candidates c
             WHERE c.lane_id = l.lane_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM lane_review_receipts r
             WHERE r.lane_id = l.lane_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM lane_integration_requests req
             WHERE req.lane_id = l.lane_id
               AND req.state IN ('queued', 'verifying', 'awaiting-review', 'landing', 'blocked', 'uncertain')
           )
           AND NOT EXISTS (
             SELECT 1 FROM lane_integration_requests req
             JOIN lane_integration_journal j ON j.request_id = req.request_id
             WHERE req.lane_id = l.lane_id
           )
         ORDER BY l.updated_at ASC, l.lane_id ASC`,
        workspaceId
      );
      const excess = Math.max(0, eligible.length - maxTerminalLanes);
      const selected = eligible.filter((row, index) => index < excess || row.updated_at < cutoffIso);
      let lanesPruned = 0;
      let operationsPruned = 0;
      let requestsPruned = 0;
      let verificationResultsPruned = 0;
      for (const { lane_id } of selected) {
        verificationResultsPruned += this.conn.run(
          `DELETE FROM lane_verification_results
           WHERE request_id IN (SELECT request_id FROM lane_integration_requests WHERE lane_id = ?)`,
          lane_id
        ).changes;
        requestsPruned += this.conn.run(
          'DELETE FROM lane_integration_requests WHERE lane_id = ?',
          lane_id
        ).changes;
        operationsPruned += this.conn.run(
          'DELETE FROM lane_operations WHERE lane_id = ?',
          lane_id
        ).changes;
        lanesPruned += this.conn.run(
          'DELETE FROM execution_lanes WHERE workspace_id = ? AND lane_id = ?',
          workspaceId,
          lane_id
        ).changes;
      }
      return { lanesPruned, operationsPruned, requestsPruned, verificationResultsPruned };
    });
  }

  // ---- candidates ----

  /** Records a frozen candidate with the lane's next sequence number. */
  public insertCandidate(insert: CandidateInsert): CandidateRecord {
    return inImmediateTransaction(this.conn, () => {
      const top = this.conn.get<{ seq: number | null }>(
        'SELECT MAX(candidate_seq) AS seq FROM lane_candidates WHERE lane_id = ?',
        insert.laneId
      );
      const seq = (top?.seq ?? 0) + 1;
      this.conn.run(
        `INSERT INTO lane_candidates (${CANDIDATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        insert.candidateId,
        insert.laneId,
        seq,
        insert.commit,
        insert.tree,
        insert.parent,
        insert.generation,
        insert.now
      );
      return {
        candidateId: insert.candidateId,
        laneId: insert.laneId,
        seq,
        commit: insert.commit,
        tree: insert.tree,
        parent: insert.parent,
        ownerGeneration: insert.generation,
        createdAt: insert.now
      };
    });
  }

  public getCandidate(candidateId: string): CandidateRecord | null {
    const row = this.conn.get<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM lane_candidates WHERE candidate_id = ?`,
      candidateId
    );
    return row === undefined ? null : candidateFromRow(row);
  }

  /** The lane's highest-numbered candidate, or `null`. */
  public currentCandidate(laneId: string): CandidateRecord | null {
    const row = this.conn.get<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM lane_candidates WHERE lane_id = ? ORDER BY candidate_seq DESC LIMIT 1`,
      laneId
    );
    return row === undefined ? null : candidateFromRow(row);
  }
}
