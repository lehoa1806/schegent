/**
 * FR-R6-F10 (data-model.md): row <-> record mapping for the lane store, the names a lane derives
 * from its id, and the keyset cursor.
 *
 * A row value outside its contract list means the store was written by something other than this
 * module, so the mapping throws {@link LaneStoreCorruptError} instead of guessing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  DEPENDENCY_RECIPES,
  LANE_DISCLOSURE,
  LANE_PAGE_LIMIT_MAX,
  LANE_OPERATION_KINDS,
  LANE_OPERATION_STATUSES,
  LANE_STATES,
  type CandidateView,
  type DependencyRecipe,
  type LaneOperationKind,
  type LaneOperationStatus,
  type LaneState,
  type LaneView
} from '../../contracts/execution-lanes';

/** The opaque cursor's length bound (contract §7). */
export const LANE_CURSOR_MAX_CHARS = 256;

const CURSOR_SEPARATOR = '|';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;
const TIMESTAMP_MIN_CHARS = 20;
const TIMESTAMP_MAX_CHARS = 32;

/** A stored value no contract list allows. */
export class LaneStoreCorruptError extends Error {
  public readonly column: string;

  public constructor(column: string) {
    super(`execution lane store holds an unknown ${column} value`);
    this.name = 'LaneStoreCorruptError';
    this.column = column;
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new LaneStoreCorruptError(column);
  return match;
}

export function laneBaseRef(laneId: string): string {
  return `refs/schegent/lanes/${laneId}/base`;
}

export function laneCandidateRef(laneId: string): string {
  return `refs/schegent/lanes/${laneId}/candidate`;
}

/** The directory under `storageDir` that holds every lane root (research R1). */
export const LANES_DIRECTORY = 'lanes';

/** Relative to the host storage directory (research R1); never an absolute path. */
export function laneRootRef(workspaceId: string, laneId: string): string {
  return `${LANES_DIRECTORY}/${workspaceId}/${laneId}`;
}

export interface LaneRecord {
  readonly laneId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly rootExecutionId: string;
  readonly sourceCommit: string;
  readonly baseRef: string;
  readonly candidateRef: string;
  readonly rootRef: string;
  readonly dependencyRecipe: DependencyRecipe;
  readonly state: LaneState;
  readonly stateReason: string | null;
  readonly pinned: boolean;
  readonly ownerGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LaneRow {
  readonly lane_id: string;
  readonly workspace_id: string;
  readonly repository_id: string;
  readonly root_execution_id: string;
  readonly source_commit: string;
  readonly base_ref: string;
  readonly candidate_ref: string;
  readonly root_ref: string;
  readonly dependency_recipe: string;
  readonly state: string;
  readonly state_reason: string | null;
  readonly pinned: number;
  readonly owner_generation: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const LANE_COLUMNS =
  'lane_id, workspace_id, repository_id, root_execution_id, source_commit, base_ref, candidate_ref, ' +
  'root_ref, dependency_recipe, state, state_reason, pinned, owner_generation, created_at, updated_at';

export function laneFromRow(row: LaneRow): LaneRecord {
  return {
    laneId: row.lane_id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    rootExecutionId: row.root_execution_id,
    sourceCommit: row.source_commit,
    baseRef: row.base_ref,
    candidateRef: row.candidate_ref,
    rootRef: row.root_ref,
    dependencyRecipe: oneOf(DEPENDENCY_RECIPES, row.dependency_recipe, 'dependency_recipe'),
    state: oneOf(LANE_STATES, row.state, 'state'),
    stateReason: row.state_reason,
    pinned: row.pinned === 1,
    ownerGeneration: row.owner_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** The parameters of an `INSERT ... (LANE_COLUMNS)`, in column order. */
export function laneInsertParams(lane: LaneRecord): (string | number | null)[] {
  return [
    lane.laneId,
    lane.workspaceId,
    lane.repositoryId,
    lane.rootExecutionId,
    lane.sourceCommit,
    lane.baseRef,
    lane.candidateRef,
    lane.rootRef,
    lane.dependencyRecipe,
    lane.state,
    lane.stateReason,
    lane.pinned ? 1 : 0,
    lane.ownerGeneration,
    lane.createdAt,
    lane.updatedAt
  ];
}

export interface CandidateRecord {
  readonly candidateId: string;
  readonly laneId: string;
  readonly seq: number;
  readonly commit: string;
  readonly tree: string;
  readonly parent: string;
  readonly ownerGeneration: number;
  readonly createdAt: string;
}

export interface CandidateRow {
  readonly candidate_id: string;
  readonly lane_id: string;
  readonly candidate_seq: number;
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly parent_sha: string;
  readonly owner_generation: number;
  readonly frozen_at: string;
}

export const CANDIDATE_COLUMNS =
  'candidate_id, lane_id, candidate_seq, commit_sha, tree_sha, parent_sha, owner_generation, frozen_at';

export function candidateFromRow(row: CandidateRow): CandidateRecord {
  return {
    candidateId: row.candidate_id,
    laneId: row.lane_id,
    seq: row.candidate_seq,
    commit: row.commit_sha,
    tree: row.tree_sha,
    parent: row.parent_sha,
    ownerGeneration: row.owner_generation,
    createdAt: row.frozen_at
  };
}

export interface OperationRecord {
  readonly operationId: string;
  readonly laneId: string;
  readonly workspaceId: string;
  readonly kind: LaneOperationKind;
  readonly status: LaneOperationStatus;
  readonly reason: string | null;
  readonly ownerGeneration: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface OperationRow {
  readonly operation_id: string;
  readonly lane_id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly owner_generation: number;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export const OPERATION_COLUMNS =
  'operation_id, lane_id, workspace_id, kind, status, reason, owner_generation, started_at, ended_at';

export function operationFromRow(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    laneId: row.lane_id,
    workspaceId: row.workspace_id,
    kind: oneOf(LANE_OPERATION_KINDS, row.kind, 'kind'),
    status: oneOf(LANE_OPERATION_STATUSES, row.status, 'status'),
    reason: row.reason,
    ownerGeneration: row.owner_generation,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

export function candidateViewOf(candidate: CandidateRecord): CandidateView {
  return {
    candidateId: candidate.candidateId,
    seq: candidate.seq,
    commit: candidate.commit,
    tree: candidate.tree,
    parent: candidate.parent,
    createdAt: candidate.createdAt
  };
}

/** The read model: no root reference, and the disclosure on every lane (FR-007, SC-006). */
export function laneViewOf(lane: LaneRecord, candidate: CandidateRecord | null): LaneView {
  return {
    laneId: lane.laneId,
    workspaceId: lane.workspaceId,
    repositoryId: lane.repositoryId,
    rootExecutionId: lane.rootExecutionId,
    sourceCommit: lane.sourceCommit,
    baseRef: lane.baseRef,
    candidateRef: lane.candidateRef,
    state: lane.state,
    stateReason: lane.stateReason,
    pinned: lane.pinned,
    ownerGeneration: lane.ownerGeneration,
    currentCandidate: candidate === null ? null : candidateViewOf(candidate),
    createdAt: lane.createdAt,
    updatedAt: lane.updatedAt,
    disclosure: LANE_DISCLOSURE
  };
}

export interface LaneCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** base64url of `<createdAt>|<id>`. */
export function encodeLaneCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}${CURSOR_SEPARATOR}${id}`, 'utf8').toString('base64url');
}

/** The position a cursor names, or `null` for anything this module did not encode. */
export function decodeLaneCursor(text: string): LaneCursor | null {
  if (text.length === 0 || text.length > LANE_CURSOR_MAX_CHARS) return null;
  if (!BASE64URL_PATTERN.test(text)) return null;
  const decoded = Buffer.from(text, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf(CURSOR_SEPARATOR);
  if (separator === -1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (createdAt.length < TIMESTAMP_MIN_CHARS || createdAt.length > TIMESTAMP_MAX_CHARS) return null;
  if (!HEX32_PATTERN.test(id)) return null;
  return { createdAt, id };
}

/** `?, ?, ...` for a bound `IN (...)` list; the only SQL text built at run time. */
export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** The port has already refused a limit outside 1..200; reaching here with one is a bug. */
export function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > LANE_PAGE_LIMIT_MAX) {
    throw new RangeError(`lane page limit must be an integer from 1 to ${LANE_PAGE_LIMIT_MAX}`);
  }
}
