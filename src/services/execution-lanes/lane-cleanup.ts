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

import * as path from 'node:path';
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
import { allDirtyCountDetailed, canonicalPath, listWorktreesDetailed, resolveCommit } from './git-observe';
import { LaneGitError } from './git-runner';
import type { LandingContext } from './landing';
import { pruneLaneRetention, type LaneRetentionPolicy } from './lane-retention';
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
  readonly retentionPolicy?: Partial<LaneRetentionPolicy>;
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
const WORKTREE_LOCKED = 'worktree-locked';
const STATUS_BUFFER_EXCEEDED = 'status-buffer-exceeded';
const STATUS_TIMEOUT = 'status-timeout';

/** `null` when the lane was removed, else the observation it was kept with. */
type LaneOutcome = string | null;

type RegistryStatus = 'registered' | 'locked' | 'prunable' | 'unregistered';

type DiskCheck =
  | { readonly kind: 'kept'; readonly observation: string }
  | { readonly kind: 'removable'; readonly root: string }
  | { readonly kind: 'settle-absent' };

function nowIso(ctx: CleanupContext): string {
  return new Date(ctx.clock()).toISOString();
}

function git(ctx: CleanupContext, args: readonly string[], cwd: string = ctx.workspaceRoot): ReturnType<CleanupContext['git']['run']> {
  return ctx.git.run(args, { cwd, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
}

/**
 * One finished `cleanup` operation; call inside the fence. Suppresses consecutive identical
 * `kept` rows (`kind = 'cleanup', status = 'kept', reason`) so repeated cleanup passes converge
 * without unbounded journal growth (16-19).
 */
function recordOperation(ctx: CleanupContext, laneId: string, status: LaneOperationStatus, reason: string | null): void {
  if (status === 'kept') {
    const latest = ctx.lanes.latestOperation(laneId);
    if (latest !== null && latest.kind === 'cleanup' && latest.status === 'kept' && latest.reason === reason) {
      return;
    }
  }
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

/** Classifies `targetPath` in Git's linked worktree registry. Throws `LaneGitError` if Git cannot list. */
async function inspectRegistry(ctx: CleanupContext, targetPath: string): Promise<RegistryStatus> {
  const entries = await listWorktreesDetailed({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (!entries.ok) throw new LaneGitError('worktree', entries.failure);
  const target = await canonicalPath(targetPath);
  const linked = entries.value.slice(1).filter((entry) => !entry.bare);
  const paths = await Promise.all(linked.map((entry) => canonicalPath(entry.path)));
  const index = paths.indexOf(target);
  if (index === -1) return 'unregistered';
  const entry = linked.at(index);
  if (entry === undefined) return 'unregistered';
  if (entry.prunable) return 'prunable';
  if (entry.locked) return 'locked';
  return 'registered';
}

async function inspectDirty(
  ctx: CleanupContext,
  root: string
): Promise<{ readonly kind: 'count'; readonly value: number } | { readonly kind: 'kept'; readonly observation: string }> {
  const dirty = await allDirtyCountDetailed({ git: ctx.git, cwd: root, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (dirty.ok) return { kind: 'count', value: dirty.value };
  if (dirty.failure.code === 'buffer') return { kind: 'kept', observation: STATUS_BUFFER_EXCEEDED };
  if (dirty.failure.code === 'timeout') return { kind: 'kept', observation: STATUS_TIMEOUT };
  throw new LaneGitError('status', dirty.failure);
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
  if (located.kind === 'absent') {
    const regStatus = await inspectRegistry(ctx, path.join(ctx.storageDir, lane.rootRef));
    if (
      regStatus === 'unregistered' &&
      (ctx.lanes.isProvisionFailureWithoutSuccess(lane.laneId) || ctx.lanes.hasPendingOperation(lane.laneId, 'cleanup'))
    ) {
      return { kind: 'settle-absent' };
    }
    return { kind: 'kept', observation: 'registry-mismatch' };
  }
  const regStatus = await inspectRegistry(ctx, located.root);
  if (regStatus === 'locked') return { kind: 'kept', observation: WORKTREE_LOCKED };
  if (regStatus !== 'registered') return { kind: 'kept', observation: 'registry-mismatch' };
  const dirty = await inspectDirty(ctx, located.root);
  if (dirty.kind === 'kept') return dirty;
  if (dirty.value > 0) return { kind: 'kept', observation: 'lane-dirty' };
  if (!(await headIsRecorded(ctx, lane, located.root))) return { kind: 'kept', observation: 'lane-dirty' };
  return { kind: 'removable', root: located.root };
}

function finishPendingOrRecordKept(ctx: CleanupContext, laneId: string, observation: string): void {
  const pending = ctx.lanes
    .listPendingOperations(ctx.workspaceId)
    .filter((op) => op.laneId === laneId && op.kind === 'cleanup');
  if (pending.length > 0) {
    const now = nowIso(ctx);
    for (const op of pending) ctx.lanes.endOperation(op.operationId, 'kept', observation, now);
  } else {
    recordOperation(ctx, laneId, 'kept', observation);
  }
}

/**
 * Settles an eligible lane whose worktree is already absent and unregistered in Git (either an
 * unregistered `preparation-failed` lane or a crash after `git worktree remove` completed).
 */
async function settleAbsentLane(ctx: CleanupContext, lane: LaneRecord): Promise<LaneResult<LaneOutcome>> {
  const preFence = ctx.lanes.assertGeneration(ctx.workspaceId, ctx.generation);
  if (!preFence.ok) return laneRefused(preFence.refusal.reason);

  const existingBase = await resolveCommit(
    { git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: CLEANUP_GIT_TIMEOUT_MS },
    lane.baseRef
  );
  let refDeletedOk = true;
  if (existingBase !== null) {
    // Re-check generation, pin status, state, and open requests inside one fenced transaction
    // immediately before invoking `git update-ref -d` so a concurrent pin or open request never
    // loses its `baseRef` (CR-B7/SR-B10).
    const beforeRefDelete = ctx.lanes.fenced<string | null>(ctx.workspaceId, ctx.generation, () => {
      const latest = ctx.lanes.getLane(ctx.workspaceId, lane.laneId);
      if (latest === null) return laneOk('lane-not-found');
      const obs = recordObservation(ctx, latest);
      if (obs !== null) {
        finishPendingOrRecordKept(ctx, lane.laneId, obs);
        return laneOk(obs);
      }
      return laneOk(null);
    });
    if (!beforeRefDelete.ok) return laneRefused(beforeRefDelete.refusal.reason);
    if (beforeRefDelete.value !== null) return laneOk(beforeRefDelete.value);

    const refDeleted = await git(ctx, ['update-ref', '-d', lane.baseRef, lane.sourceCommit]);
    refDeletedOk = refDeleted.ok;
  }

  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const latest = ctx.lanes.getLane(ctx.workspaceId, lane.laneId);
    if (latest === null) return laneOk('lane-not-found');
    const obs = recordObservation(ctx, latest);
    if (obs !== null) {
      finishPendingOrRecordKept(ctx, lane.laneId, obs);
      return laneOk(obs);
    }
    const now = nowIso(ctx);
    const moved = ctx.lanes.transitionLane(ctx.workspaceId, lane.laneId, ['cleanup-eligible'], 'removed', {
      reason: null,
      now,
      generation: ctx.generation,
      requireUnpinned: true
    });
    if (!moved.ok) {
      if (moved.refusal.reason === 'lane-pinned') {
        finishPendingOrRecordKept(ctx, lane.laneId, 'lane-pinned');
        return laneOk('lane-pinned');
      }
      return laneRefused<LaneOutcome>(moved.refusal.reason);
    }
    const reason = refDeletedOk ? null : BASE_REF_KEPT;
    const pending = ctx.lanes
      .listPendingOperations(ctx.workspaceId)
      .filter((op) => op.laneId === lane.laneId && op.kind === 'cleanup');
    if (pending.length > 0) {
      for (const op of pending) ctx.lanes.endOperation(op.operationId, 'succeeded', reason, now);
    } else {
      recordOperation(ctx, lane.laneId, 'succeeded', reason);
    }
    return laneOk(null);
  });
}

/**
 * Removes the worktree, then the base ref, then records the lane `removed`.
 *
 * Inside one fenced transaction immediately before `git worktree remove`, rechecks `pinned = 0`
 * and lane eligibility (aborting if concurrently pinned) and records a durable `pending` `cleanup`
 * operation so a crash mid-cleanup converges on restart. A root Git would not remove because it
 * turned dirty or locked is kept without aborting sibling lanes; any other refusal throws
 * `LaneGitError` with the failure recorded and the lane left `cleanup-eligible`.
 */
async function removeLane(ctx: CleanupContext, lane: LaneRecord, root: string): Promise<LaneResult<LaneOutcome>> {
  const preRemoval = ctx.lanes.fenced<
    { readonly kind: 'kept'; readonly observation: string } | { readonly kind: 'begun'; readonly operationId: string }
  >(ctx.workspaceId, ctx.generation, () => {
    const latest = ctx.lanes.getLane(ctx.workspaceId, lane.laneId);
    if (latest === null) return laneOk({ kind: 'kept', observation: 'lane-not-found' });
    const obs = recordObservation(ctx, latest);
    if (obs !== null) {
      recordOperation(ctx, lane.laneId, 'kept', obs);
      return laneOk({ kind: 'kept', observation: obs });
    }
    const operationId = ctx.random(ID_BYTES).toString('hex');
    ctx.lanes.beginOperation({
      operationId,
      laneId: lane.laneId,
      workspaceId: ctx.workspaceId,
      kind: 'cleanup',
      generation: ctx.generation,
      now: nowIso(ctx)
    });
    return laneOk({ kind: 'begun', operationId });
  });
  if (!preRemoval.ok) return laneRefused(preRemoval.refusal.reason);
  if (preRemoval.value.kind === 'kept') return laneOk(preRemoval.value.observation);
  const { operationId } = preRemoval.value;

  const removeFence = ctx.lanes.assertGeneration(ctx.workspaceId, ctx.generation);
  if (!removeFence.ok) return laneRefused(removeFence.refusal.reason);

  const removal = await git(ctx, ['worktree', 'remove', root]);
  const afterStatus = await inspectRegistry(ctx, root);
  if (afterStatus === 'locked') {
    return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
      ctx.lanes.endOperation(operationId, 'kept', WORKTREE_LOCKED, nowIso(ctx));
      return laneOk(WORKTREE_LOCKED);
    });
  }
  if (afterStatus === 'registered') {
    const dirty = await inspectDirty(ctx, root);
    if (dirty.kind === 'kept') {
      return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
        ctx.lanes.endOperation(operationId, 'kept', dirty.observation, nowIso(ctx));
        return laneOk(dirty.observation);
      });
    }
    if (dirty.value > 0) {
      return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
        ctx.lanes.endOperation(operationId, 'kept', 'lane-dirty', nowIso(ctx));
        return laneOk('lane-dirty');
      });
    }
    const recorded = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
      ctx.lanes.endOperation(operationId, 'failed', WORKTREE_REMOVE_FAILED, nowIso(ctx));
      return laneOk(null);
    });
    if (!recorded.ok) return recorded;
    throw new LaneGitError('worktree', removal.ok ? UNKNOWN_FAILURE : { code: removal.code, exitCode: removal.exitCode });
  }

  const beforeRefDelete = ctx.lanes.fenced<string | null>(ctx.workspaceId, ctx.generation, () => {
    const latest = ctx.lanes.getLane(ctx.workspaceId, lane.laneId);
    if (latest !== null && latest.pinned) {
      ctx.lanes.endOperation(operationId, 'kept', 'lane-pinned', nowIso(ctx));
      return laneOk('lane-pinned');
    }
    return laneOk(null);
  });
  if (!beforeRefDelete.ok) return laneRefused(beforeRefDelete.refusal.reason);
  if (beforeRefDelete.value !== null) return laneOk(beforeRefDelete.value);

  const refDeleted = await git(ctx, ['update-ref', '-d', lane.baseRef, lane.sourceCommit]);
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const now = nowIso(ctx);
    const change = { reason: null, now, generation: ctx.generation, requireUnpinned: true };
    const moved = ctx.lanes.transitionLane(ctx.workspaceId, lane.laneId, ['cleanup-eligible'], 'removed', change);
    if (!moved.ok) {
      if (moved.refusal.reason === 'lane-pinned') {
        ctx.lanes.endOperation(operationId, 'kept', 'lane-pinned', now);
        return laneOk('lane-pinned');
      }
      ctx.lanes.endOperation(operationId, 'failed', moved.refusal.reason, now);
      return laneRefused<LaneOutcome>(moved.refusal.reason);
    }
    ctx.lanes.endOperation(operationId, 'succeeded', refDeleted.ok ? null : BASE_REF_KEPT, now);
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
  if (disk.kind === 'settle-absent') return settleAbsentLane(ctx, lane);
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
  const retained = pruneLaneRetention({
    lanes: ctx.lanes,
    workspaceId: ctx.workspaceId,
    generation: ctx.generation,
    clock: ctx.clock,
    ...(ctx.retentionPolicy === undefined ? {} : { policy: ctx.retentionPolicy })
  });
  if (!retained.ok) return laneRefused(retained.refusal.reason);
  return laneOk({ removed, kept });
}
