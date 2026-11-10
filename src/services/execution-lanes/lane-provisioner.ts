/**
 * FR-R6-F10 (research R1, R2, R10): provisioning one execution lane.
 *
 * The steps, in order:
 *   1. one fenced transaction checks the live-lane bound, then inserts a `preparing` lane and a
 *      `pending` provision operation;
 *   2. the lane's parent directory is made, never the root itself, and the root is proven to sit
 *      inside `<storageDir>/lanes`;
 *   3. `git worktree add --detach <root> <commit>`;
 *   4. `git update-ref <base> <commit> ""`, which only creates;
 *   5. the lane's `HEAD` is read back and must equal the commit;
 *   6. one fenced transaction sets the lane `active` and the operation `succeeded`.
 *
 * Every Git call is bounded by the time left before the provisioning deadline. A failure after
 * step 1 leaves the lane `preparation-failed` and the operation `failed`; whatever reached disk is
 * kept for the operator and for cleanup, never deleted here. A step that throws settles the lane
 * the same way, `provisioning-git-failed`, before the error propagates.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import { laneOk, laneRefused, type LaneRefusalReason, type LaneResult } from '../../contracts/execution-lanes';
import { resolveContainedForWrite } from '../../lib/path-containment';
import { ensureDirWithinRoot } from '../../lib/safe-open';
import type { GitRunResult, LaneGitRunner } from './git-runner';
import type { LaneStore } from './lane-store';
import { LANES_DIRECTORY, laneBaseRef, laneCandidateRef, laneRootRef, type LaneRecord } from './lane-store-rows';

const ID_BYTES = 16;
/** Lane parent directories hold working trees of the operator's repository: owner-only. */
const LANE_DIR_MODE = 0o700;

export interface ProvisionRequest {
  readonly rootExecutionId: string;
  readonly sourceRevision: string;
  readonly dependencyRecipe: string;
}

/** What the probe proved about the workspace before any worktree exists. */
export interface ProvisionProbeResult {
  readonly commit: string;
  readonly repositoryId: string;
}

export interface ProvisionContext {
  readonly store: LaneStore;
  readonly git: LaneGitRunner;
  readonly workspaceRoot: string;
  readonly storageDir: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly liveLaneCap: number;
  readonly deadlineMs: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
  /** Checks the entry conditions before the deadline; see `provisioning-probe.ts`. */
  readonly probe: (request: ProvisionRequest, remainingMs: () => number) => Promise<LaneResult<ProvisionProbeResult>>;
}

type Deadline = () => number;

function failureReason(result: GitRunResult, remaining: Deadline): LaneRefusalReason {
  if (!result.ok && result.code === 'timeout') return 'provisioning-deadline-exceeded';
  return remaining() <= 0 ? 'provisioning-deadline-exceeded' : 'provisioning-git-failed';
}

function insertPreparing(
  ctx: ProvisionContext,
  probed: ProvisionProbeResult,
  request: ProvisionRequest,
  now: string
): LaneResult<{ lane: LaneRecord; operationId: string }> {
  const laneId = ctx.random(ID_BYTES).toString('hex');
  const operationId = ctx.random(ID_BYTES).toString('hex');
  return ctx.store.fenced(ctx.workspaceId, ctx.generation, () => {
    if (ctx.store.countLiveLanes(ctx.workspaceId) >= ctx.liveLaneCap) return laneRefused('lane-bound-reached');
    const lane: LaneRecord = {
      laneId,
      workspaceId: ctx.workspaceId,
      repositoryId: probed.repositoryId,
      rootExecutionId: request.rootExecutionId,
      sourceCommit: probed.commit,
      baseRef: laneBaseRef(laneId),
      candidateRef: laneCandidateRef(laneId),
      rootRef: laneRootRef(ctx.workspaceId, laneId),
      dependencyRecipe: 'none',
      state: 'preparing',
      stateReason: null,
      pinned: false,
      ownerGeneration: ctx.generation,
      createdAt: now,
      updatedAt: now
    };
    ctx.store.insertLane(lane);
    ctx.store.beginOperation({
      operationId,
      laneId,
      workspaceId: ctx.workspaceId,
      kind: 'provision',
      generation: ctx.generation,
      now
    });
    return laneOk({ lane, operationId });
  });
}

/** Makes the parent and returns the root's absolute path, or `null` when it would escape the lanes directory. */
async function prepareRootPath(ctx: ProvisionContext, laneId: string): Promise<string | null> {
  const lanesDir = path.join(ctx.storageDir, LANES_DIRECTORY);
  // The storage directory is the caller's trusted root and must exist; it may itself be a link.
  // A symlink at `lanes` or at the workspace folder is refused by name.
  const made = await ensureDirWithinRoot(ctx.storageDir, [LANES_DIRECTORY, ctx.workspaceId], LANE_DIR_MODE);
  if (made.outcome === 'refused') return null;
  const root = path.join(lanesDir, ctx.workspaceId, laneId);
  const verdict = await resolveContainedForWrite(root, [lanesDir]);
  return verdict.outcome === 'contained' ? root : null;
}

/** Steps 2 to 5; `null` on success, else the refusal reason. */
async function materialize(ctx: ProvisionContext, lane: LaneRecord, remaining: Deadline): Promise<LaneRefusalReason | null> {
  const root = await prepareRootPath(ctx, lane.laneId);
  if (root === null) return 'provisioning-git-failed';

  const inWorkspace = (args: readonly string[]): Promise<GitRunResult> =>
    ctx.git.run(args, { cwd: ctx.workspaceRoot, timeoutMs: Math.max(remaining(), 1) });
  const steps: readonly (() => Promise<GitRunResult>)[] = [
    () => inWorkspace(['worktree', 'add', '--detach', root, lane.sourceCommit]),
    () => inWorkspace(['update-ref', lane.baseRef, lane.sourceCommit, ''])
  ];
  for (const step of steps) {
    if (remaining() <= 0) return 'provisioning-deadline-exceeded';
    const result = await step();
    if (!result.ok) return failureReason(result, remaining);
  }

  if (remaining() <= 0) return 'provisioning-deadline-exceeded';
  const head = await ctx.git.run(['rev-parse', 'HEAD'], { cwd: root, timeoutMs: Math.max(remaining(), 1) });
  if (!head.ok) return failureReason(head, remaining);
  return head.stdout.trim() === lane.sourceCommit ? null : 'provisioning-git-failed';
}

function settle(
  ctx: ProvisionContext,
  laneId: string,
  operationId: string,
  failure: LaneRefusalReason | null
): LaneResult<LaneRecord> {
  const now = new Date(ctx.clock()).toISOString();
  const change = { reason: failure, now, generation: ctx.generation };
  const settled = ctx.store.fenced(ctx.workspaceId, ctx.generation, () => {
    const moved = ctx.store.transitionLane(
      ctx.workspaceId,
      laneId,
      ['preparing'],
      failure === null ? 'active' : 'preparation-failed',
      change
    );
    if (!moved.ok) return moved;
    ctx.store.endOperation(operationId, failure === null ? 'succeeded' : 'failed', failure, now);
    return moved;
  });
  if (failure !== null) return laneRefused(failure);
  return settled;
}

/**
 * Provisions one lane. Refusals before step 1 leave no row; a failure after it leaves the lane
 * `preparation-failed` with its reason. Never leaves a lane `active` on failure.
 */
export async function provisionLane(ctx: ProvisionContext, request: ProvisionRequest): Promise<LaneResult<LaneRecord>> {
  const deadlineAt = ctx.clock() + ctx.deadlineMs;
  const remaining: Deadline = () => deadlineAt - ctx.clock();

  const probed = await ctx.probe(request, remaining);
  if (!probed.ok) return laneRefused(probed.refusal.reason);
  if (remaining() <= 0) return laneRefused('provisioning-deadline-exceeded');

  const inserted = insertPreparing(ctx, probed.value, request, new Date(ctx.clock()).toISOString());
  if (!inserted.ok) return laneRefused(inserted.refusal.reason);
  const { lane, operationId } = inserted.value;

  let failure: LaneRefusalReason | null;
  try {
    failure = await materialize(ctx, lane, remaining);
  } catch (error: unknown) {
    // A throw would leave the lane `preparing` under this generation, holding a live-lane slot no
    // reconcile of this host frees (review R12). Settle it, then let the error through.
    settle(ctx, lane.laneId, operationId, 'provisioning-git-failed');
    throw error;
  }
  return settle(ctx, lane.laneId, operationId, failure);
}
