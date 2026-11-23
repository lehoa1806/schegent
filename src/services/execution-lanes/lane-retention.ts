/**
 * FR-R7-16 (`16-19`, FR-019): bounded retention for execution-lane metadata.
 *
 * Enforces two caps inside one fenced transaction:
 *   1. per-lane non-pending `lane_operations` cap (`maxOperationsPerLane`, default 64), keeping the
 *      newest rows and never touching `pending` operations;
 *   2. aged or over-cap unpinned `removed` lanes beyond `terminalLaneRetentionMs` (default 30
 *      days) or `maxTerminalLanesPerWorkspace` (default 500), strictly preserving every
 *      active/retained/pinned/`preparation-failed` lane (so unfinished worktrees or `baseRef`
 *      residue are never orphaned before cleanup transitions the lane to `removed`), every lane
 *      with reachable `lane_candidates`, and every lane carrying `lane_review_receipts` or
 *      `lane_integration_journal` recovery evidence.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneOk, type LaneResult } from '../../contracts/execution-lanes';
import type { LaneStore } from './lane-store';

export interface LaneRetentionPolicy {
  /** Maximum non-pending `lane_operations` rows retained per lane. */
  readonly maxOperationsPerLane: number;
  /** Age horizon in ms after which eligible terminal lanes may be pruned. */
  readonly terminalLaneRetentionMs: number;
  /** Maximum eligible terminal lanes retained per workspace, oldest pruned first. */
  readonly maxTerminalLanesPerWorkspace: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export const DEFAULT_LANE_RETENTION_POLICY: Readonly<LaneRetentionPolicy> = Object.freeze({
  maxOperationsPerLane: 64,
  terminalLaneRetentionMs: 30 * MS_PER_DAY,
  maxTerminalLanesPerWorkspace: 500
});

export interface LaneRetentionReport {
  readonly operationsPruned: number;
  readonly lanesPruned: number;
  readonly requestsPruned: number;
  readonly verificationResultsPruned: number;
}

export interface RetentionContext {
  readonly lanes: LaneStore;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly policy?: Partial<LaneRetentionPolicy>;
}

function boundedNonNegativeInt(value: number | undefined, fallback: number, min: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
  return value;
}

export function resolveRetentionPolicy(overrides?: Partial<LaneRetentionPolicy>): LaneRetentionPolicy {
  return {
    maxOperationsPerLane: boundedNonNegativeInt(
      overrides?.maxOperationsPerLane,
      DEFAULT_LANE_RETENTION_POLICY.maxOperationsPerLane,
      1,
      'maxOperationsPerLane'
    ),
    terminalLaneRetentionMs: boundedNonNegativeInt(
      overrides?.terminalLaneRetentionMs,
      DEFAULT_LANE_RETENTION_POLICY.terminalLaneRetentionMs,
      0,
      'terminalLaneRetentionMs'
    ),
    maxTerminalLanesPerWorkspace: boundedNonNegativeInt(
      overrides?.maxTerminalLanesPerWorkspace,
      DEFAULT_LANE_RETENTION_POLICY.maxTerminalLanesPerWorkspace,
      0,
      'maxTerminalLanesPerWorkspace'
    )
  };
}

/**
 * Runs one bounded, fenced retention pass for `ctx.workspaceId`. Refuses `ownership-superseded`
 * with nothing deleted if a newer host claimed the workspace.
 */
export function pruneLaneRetention(ctx: RetentionContext): LaneResult<LaneRetentionReport> {
  const policy = resolveRetentionPolicy(ctx.policy);
  const cutoffIso = new Date(ctx.clock() - policy.terminalLaneRetentionMs).toISOString();
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const excessOps = ctx.lanes.pruneExcessOperations(ctx.workspaceId, policy.maxOperationsPerLane);
    const terminal = ctx.lanes.pruneEligibleTerminalLanes(
      ctx.workspaceId,
      cutoffIso,
      policy.maxTerminalLanesPerWorkspace
    );
    return laneOk({
      operationsPruned: excessOps + terminal.operationsPruned,
      lanesPruned: terminal.lanesPruned,
      requestsPruned: terminal.requestsPruned,
      verificationResultsPruned: terminal.verificationResultsPruned
    });
  });
}
