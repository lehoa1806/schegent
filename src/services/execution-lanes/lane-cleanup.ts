/**
 * FR-R6-F10 (spec US5, FR-005, FR-015; research R12; contract §5 `cleanupLanes`): removing the
 * worktrees of lanes nobody needs, and keeping every other one with the reason.
 *
 * A lane is removed only when every condition holds, checked in this order; the first that fails
 * is the lane's observation:
 *   1. not pinned (`lane-pinned`);
 *   2. not live (`lane-live`);
 *   3. in `cleanup-eligible` (`lane-state-invalid`);
 *   4. no request queued, verifying, awaiting review, landing, blocked or uncertain (`request-open`);
 *   5. its root resolves inside `<storageDir>/lanes/` (`not-contained`);
 *   6. Git's registry lists the root (`registry-mismatch`; an absent root lands here too);
 *   7. no tracked change, no untracked file, and `HEAD` at the source commit or the current
 *      candidate, so no commit made in the lane is lost (`lane-dirty`).
 * Removal is `git worktree remove` without `--force`, so Git refuses a lane that turned dirty
 * meanwhile, then the base ref is deleted at its expected value. Ignored files go with the lane.
 * The candidate ref and every record are kept; the lane ends `removed`. A worktree no lane names
 * is never touched. Each lane's outcome is one `cleanup` operation.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  LIVE_LANE_STATES,
  laneOk,
  laneRefused,
  type CleanupReport,
  type IntegrationState,
  type LaneOperationStatus,
  type LaneResult,
  type LaneState
} from '../../contracts/execution-lanes';
import { allDirtyCount, canonicalPath, listWorktrees } from './git-observe';
import { LaneGitError } from './git-runner';
import type { LandingContext } from './landing';
import type { LaneRecord } from './lane-store-rows';

/** Where a lane's root is: the real path when contained, else why not. */
export type LaneRootLocation =
  | { readonly kind: 'contained'; readonly root: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-contained' };

export interface CleanupContext extends LandingContext {
  readonly locateLaneRoot: (rootRef: string) => Promise<LaneRootLocation>;
  /** Runs `work` holding the lane's in-host operation slot, or refuses `lane-busy`. */
  readonly exclusively: <T>(laneId: string, work: () => Promise<LaneResult<T>>) => Promise<LaneResult<T>>;
}

const CLEANUP_GIT_TIMEOUT_MS = 60_000;
const ID_BYTES = 16;
const UNKNOWN_FAILURE = { code: 'exit', exitCode: null } as const;
const LIVE_STATES: readonly LaneState[] = LIVE_LANE_STATES;
const OPEN_REQUEST_STATES: readonly IntegrationState[] = Object.freeze([
  'queued',
  'verifying',
  'awaiting-review',
  'landing',
  'blocked',
  'uncertain'
]);
const WORKTREE_REMOVE_FAILED = 'worktree-remove-failed';
const BASE_REF_KEPT = 'base-ref-kept';

/** `null` when the lane was removed, else the observation it was kept with. */
type LaneOutcome = string | null;

type DiskCheck = { readonly kind: 'kept'; readonly observation: string } | { readonly kind: 'removable'; readonly root: string };

function nowIso(ctx: CleanupContext): string {
  return new Date(ctx.clock()).toISOString();
}

function git(ctx: CleanupContext, args: readonly string[], cwd: string = ctx.workspaceRoot): ReturnType<CleanupContext['git']['run']> {
  return ctx.git.run(args, { cwd, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
}

/** One finished `cleanup` operation; call inside the fence. */
function recordOperation(ctx: CleanupContext, laneId: string, status: LaneOperationStatus, reason: string | null): void {
  const operationId = ctx.random(ID_BYTES).toString('hex');
  const now = nowIso(ctx);
  ctx.lanes.beginOperation({ operationId, laneId, workspaceId: ctx.workspaceId, kind: 'cleanup', generation: ctx.generation, now });
  ctx.lanes.endOperation(operationId, status, reason, now);
}

function keep(ctx: CleanupContext, laneId: string, observation: string): LaneResult<LaneOutcome> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    recordOperation(ctx, laneId, 'kept', observation);
    return laneOk(observation);
  });
}

/** Conditions 1 to 4, read in one fenced transaction. */
function recordObservation(ctx: CleanupContext, lane: LaneRecord): string | null {
  if (lane.pinned) return 'lane-pinned';
  if (LIVE_STATES.includes(lane.state)) return 'lane-live';
  if (lane.state !== 'cleanup-eligible') return 'lane-state-invalid';
  if (ctx.integrations.countLaneRequests(lane.laneId, OPEN_REQUEST_STATES) > 0) return 'request-open';
  return null;
}

/** Whether a linked worktree other than the main one sits at `root`. Throws when Git cannot list. */
async function isRegistered(ctx: CleanupContext, root: string): Promise<boolean> {
  const entries = await listWorktrees({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (entries === null) throw new LaneGitError('worktree', UNKNOWN_FAILURE);
  const linked = entries.slice(1).filter((entry) => !entry.bare && !entry.prunable);
  const paths = await Promise.all(linked.map((entry) => canonicalPath(entry.path)));
  return paths.includes(await canonicalPath(root));
}

async function dirtyCount(ctx: CleanupContext, root: string): Promise<number> {
  const count = await allDirtyCount({ git: ctx.git, cwd: root, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (count === null) throw new LaneGitError('status', UNKNOWN_FAILURE);
  return count;
}

/**
 * Whether the root's `HEAD` is the lane's source commit or its current candidate. Any other commit
 * was made in the lane and never frozen; removing the worktree would leave it unreachable (review
 * R5). Throws when Git cannot read `HEAD`.
 */
async function headIsRecorded(ctx: CleanupContext, lane: LaneRecord, root: string): Promise<boolean> {
  const head = await git(ctx, ['rev-parse', '--verify', 'HEAD^{commit}'], root);
  if (!head.ok) throw new LaneGitError('rev-parse', { code: head.code, exitCode: head.exitCode });
  const commit = head.stdout.trim();
  return commit === lane.sourceCommit || commit === ctx.lanes.currentCandidate(lane.laneId)?.commit;
}

/** Conditions 5 to 7. */
async function checkDisk(ctx: CleanupContext, lane: LaneRecord): Promise<DiskCheck> {
  const located = await ctx.locateLaneRoot(lane.rootRef);
  if (located.kind === 'not-contained') return { kind: 'kept', observation: 'not-contained' };
  if (located.kind === 'absent' || !(await isRegistered(ctx, located.root))) {
    return { kind: 'kept', observation: 'registry-mismatch' };
  }
  if ((await dirtyCount(ctx, located.root)) > 0) return { kind: 'kept', observation: 'lane-dirty' };
  if (!(await headIsRecorded(ctx, lane, located.root))) return { kind: 'kept', observation: 'lane-dirty' };
  return { kind: 'removable', root: located.root };
}

/**
 * Removes the worktree, then the base ref, then records the lane `removed`. A root Git would not
 * remove because it turned dirty is kept `lane-dirty`; one Git would not remove for any other
 * reason throws `LaneGitError`, with the failure recorded and the lane left `cleanup-eligible`.
 */
async function removeLane(ctx: CleanupContext, lane: LaneRecord, root: string): Promise<LaneResult<LaneOutcome>> {
  const removal = await git(ctx, ['worktree', 'remove', root]);
  if (await isRegistered(ctx, root)) {
    if ((await dirtyCount(ctx, root)) > 0) return keep(ctx, lane.laneId, 'lane-dirty');
    const recorded = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
      recordOperation(ctx, lane.laneId, 'failed', WORKTREE_REMOVE_FAILED);
      return laneOk(null);
    });
    if (!recorded.ok) return recorded;
    throw new LaneGitError('worktree', removal.ok ? UNKNOWN_FAILURE : { code: removal.code, exitCode: removal.exitCode });
  }

  const refDeleted = await git(ctx, ['update-ref', '-d', lane.baseRef, lane.sourceCommit]);
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const change = { reason: null, now: nowIso(ctx), generation: ctx.generation };
    const moved = ctx.lanes.transitionLane(ctx.workspaceId, lane.laneId, ['cleanup-eligible'], 'removed', change);
    if (!moved.ok) return laneRefused<LaneOutcome>(moved.refusal.reason);
    recordOperation(ctx, lane.laneId, 'succeeded', refDeleted.ok ? null : BASE_REF_KEPT);
    return laneOk(null);
  });
}

async function cleanupOne(ctx: CleanupContext, laneId: string): Promise<LaneResult<LaneOutcome>> {
  const checked = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const lane = ctx.lanes.getLane(ctx.workspaceId, laneId);
    return laneOk(lane === null ? null : { lane, observation: recordObservation(ctx, lane) });
  });
  if (!checked.ok) return laneRefused(checked.refusal.reason);
  if (checked.value === null) return laneOk('lane-not-found');
  const { lane, observation } = checked.value;
  if (observation !== null) return keep(ctx, laneId, observation);

  const disk = await checkDisk(ctx, lane);
  if (disk.kind === 'kept') return keep(ctx, laneId, disk.observation);
  return removeLane(ctx, lane, disk.root);
}

/**
 * Contract §5: cleans the named lanes, or every `cleanup-eligible` lane when none is named. A named
 * lane the workspace does not hold is kept `lane-not-found`; one another operation of this host
 * holds is kept `lane-busy`. Refuses only `ownership-superseded`. Throws `LaneGitError` when Git
 * cannot say what a root holds or will not remove a clean one.
 */
export async function cleanupLanes(ctx: CleanupContext, laneIds?: readonly string[]): Promise<LaneResult<CleanupReport>> {
  const fence = ctx.lanes.assertGeneration(ctx.workspaceId, ctx.generation);
  if (!fence.ok) return laneRefused(fence.refusal.reason);
  const selected =
    laneIds === undefined
      ? ctx.lanes.lanesInStates(ctx.workspaceId, ['cleanup-eligible']).map((lane) => lane.laneId)
      : [...new Set(laneIds)];

  const removed: string[] = [];
  const kept: CleanupReport['kept'][number][] = [];
  for (const laneId of selected) {
    const outcome = await ctx.exclusively(laneId, () => cleanupOne(ctx, laneId));
    if (!outcome.ok && outcome.refusal.reason === 'lane-busy') {
      kept.push({ laneId, observation: 'lane-busy' });
      continue;
    }
    if (!outcome.ok) return laneRefused(outcome.refusal.reason);
    if (outcome.value === null) removed.push(laneId);
    else kept.push({ laneId, observation: outcome.value });
  }
  return laneOk({ removed, kept });
}
