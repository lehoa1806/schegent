/**
 * FR-R6-F10 (spec US5, FR-014; data-model lifecycles; contract §5 `reconcile`): settling what a
 * stopped host left behind.
 *
 * A record is touched when an older generation owns it, or, for a request, when this host owns it
 * but has no operation in flight on its lane; work this host has in flight is left alone. In order:
 *   1. the worktree registry is read first, so a Git failure throws before anything is written;
 *   2. a `preparing` lane becomes `preparation-failed` (`provisioning-interrupted`), and its
 *      pending provision operation ends `failed`;
 *   3. a `verifying` request returns to `queued`;
 *   4. a `landing` request is observed and classified by the same rule the landing uses
 *      (`classifyLandingObservation`); the landing is never re-applied. A request whose target Git
 *      cannot read stays in `landing` for the next reconcile;
 *   5. a lane that should hold a root and does not is reported `root-missing`, unchanged; it is
 *      never re-provisioned.
 * A worktree no lane names is counted, never removed or reported by path.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  LANE_STATES,
  laneOk,
  laneRefused,
  type IntegrationState,
  type LaneResult,
  type LaneState,
  type ReconcileReport
} from '../../contracts/execution-lanes';
import { canonicalPath, listWorktreesDetailed, resolveCommit } from './git-observe';
import { LaneGitError } from './git-runner';
import type { RequestRecord } from './integration-store-rows';
import {
  classifyLandingObservation,
  commitsOf,
  observeLanding,
  settleLanding,
  type LandingContext,
  type LandingObservation
} from './landing';
import type { LaneRootLocation } from './lane-cleanup';
import { pruneLaneRetention, type LaneRetentionPolicy } from './lane-retention';

const ID_BYTES = 16;
const RECONCILE_GIT_TIMEOUT_MS = 60_000;
const PROVISIONING_INTERRUPTED = 'provisioning-interrupted';
const CLEANUP_INTERRUPTED = 'cleanup-interrupted';
const BASE_REF_KEPT = 'base-ref-kept';
const ROOT_MISSING = 'root-missing';
const CONTAINMENT_REFUSED = 'containment-refused';
const LANE_PINNED = 'lane-pinned';
const INTEGRATION_REQUEST_OPEN = 'integration-request-open';
const OPEN_REQUEST_STATES: readonly IntegrationState[] = Object.freeze([
  'queued',
  'verifying',
  'awaiting-review',
  'landing',
  'blocked',
  'uncertain'
]);
/** States whose lanes keep a root on disk (data-model, lane lifecycle). */
const ROOTED_STATES: readonly LaneState[] = Object.freeze(['active', 'paused', 'completed', 'retained', 'cleanup-eligible']);

export interface ReconcileContext extends LandingContext {
  /** Classifies a lane root as contained, absent, or refused by containment. */
  readonly locateLaneRoot: (rootRef: string) => Promise<LaneRootLocation>;
  /** Whether this host has an operation in flight on the lane. */
  readonly inFlight: (laneId: string) => boolean;
  readonly retentionPolicy?: Partial<LaneRetentionPolicy>;
}

type LaneEntry = ReconcileReport['lanes'][number];
type RequestEntry = ReconcileReport['requests'][number];

function nowIso(ctx: ReconcileContext): string {
  return new Date(ctx.clock()).toISOString();
}

function ownedByAnEarlierHost(ctx: ReconcileContext, record: { readonly ownerGeneration: number }): boolean {
  return record.ownerGeneration < ctx.generation;
}

/**
 * A request is abandoned when an earlier host left it, or when this host owns it but has no
 * operation in flight on its lane: a Git failure mid-landing leaves exactly that (review R1).
 */
function abandoned(ctx: ReconcileContext, request: RequestRecord): boolean {
  return ownedByAnEarlierHost(ctx, request) || !ctx.inFlight(request.laneId);
}

/**
 * One finished `reconcile` operation; call inside the fence. Suppresses consecutive identical
 * `kept` rows so repeated reconciliations converge without growing `lane_operations` (16-19).
 */
function recordOperation(ctx: ReconcileContext, laneId: string, status: 'succeeded' | 'kept', reason: string | null): void {
  if (status === 'kept') {
    const latest = ctx.lanes.latestOperation(laneId);
    if (latest !== null && latest.kind === 'reconcile' && latest.status === 'kept' && latest.reason === reason) {
      return;
    }
  }
  const operationId = ctx.random(ID_BYTES).toString('hex');
  const now = nowIso(ctx);
  ctx.lanes.beginOperation({ operationId, laneId, workspaceId: ctx.workspaceId, kind: 'reconcile', generation: ctx.generation, now });
  ctx.lanes.endOperation(operationId, status, reason, now);
}

/** Reads the worktree registry once: returns unknown-worktree count plus canonical linked paths. */
async function inspectWorktrees(
  ctx: ReconcileContext
): Promise<{ readonly unknownWorktrees: number; readonly linkedPaths: ReadonlySet<string> }> {
  const entries = await listWorktreesDetailed({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: RECONCILE_GIT_TIMEOUT_MS });
  if (!entries.ok) throw new LaneGitError('worktree', entries.failure);
  const laneRoots = ctx.lanes.lanesInStates(ctx.workspaceId, LANE_STATES).map((lane) => path.join(ctx.storageDir, lane.rootRef));
  const known = new Set(await Promise.all([ctx.workspaceRoot, ...laneRoots].map(canonicalPath)));
  const linked = await Promise.all(entries.value.slice(1).map((entry) => canonicalPath(entry.path)));
  const unknownWorktrees = linked.filter((entry) => !known.has(entry)).length;
  return { unknownWorktrees, linkedPaths: new Set(linked) };
}

function failInterruptedProvisioning(ctx: ReconcileContext): LaneResult<LaneEntry[]> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const now = nowIso(ctx);
    const pending = ctx.lanes.listPendingOperations(ctx.workspaceId);
    const entries: LaneEntry[] = [];
    for (const lane of ctx.lanes.lanesInStates(ctx.workspaceId, ['preparing'])) {
      if (!ownedByAnEarlierHost(ctx, lane)) continue;
      const change = { reason: PROVISIONING_INTERRUPTED, now, generation: ctx.generation };
      const moved = ctx.lanes.transitionLane(ctx.workspaceId, lane.laneId, ['preparing'], 'preparation-failed', change);
      if (!moved.ok) continue;
      const provisions = pending.filter((op) => op.laneId === lane.laneId && op.kind === 'provision');
      for (const op of provisions) ctx.lanes.endOperation(op.operationId, 'failed', PROVISIONING_INTERRUPTED, now);
      recordOperation(ctx, lane.laneId, 'succeeded', null);
      entries.push({ laneId: lane.laneId, from: 'preparing', to: 'preparation-failed', observation: null });
    }
    return laneOk(entries);
  });
}

/**
 * Fenced check before mutating `baseRef` or state during interrupted-cleanup settlement.
 * Returns `null` when the lane may proceed; otherwise closes `operationIds` cleanly and returns
 * the stop reason so pinned or open-request lanes never lose their `baseRef` (CR-B7/SR-B10).
 */
function guardInterruptedCleanup(
  ctx: ReconcileContext,
  laneId: string,
  operationIds: readonly string[]
): LaneResult<string | null> {
  return ctx.lanes.fenced<string | null>(ctx.workspaceId, ctx.generation, () => {
    const now = nowIso(ctx);
    const latest = ctx.lanes.getLane(ctx.workspaceId, laneId);
    if (latest === null || latest.state !== 'cleanup-eligible') {
      for (const opId of operationIds) ctx.lanes.endOperation(opId, 'failed', CLEANUP_INTERRUPTED, now);
      return laneOk(CLEANUP_INTERRUPTED);
    }
    if (latest.pinned) {
      for (const opId of operationIds) ctx.lanes.endOperation(opId, 'kept', LANE_PINNED, now);
      recordOperation(ctx, laneId, 'kept', LANE_PINNED);
      return laneOk(LANE_PINNED);
    }
    if (ctx.integrations.countLaneRequests(laneId, OPEN_REQUEST_STATES) > 0) {
      for (const opId of operationIds) ctx.lanes.endOperation(opId, 'kept', INTEGRATION_REQUEST_OPEN, now);
      recordOperation(ctx, laneId, 'kept', INTEGRATION_REQUEST_OPEN);
      return laneOk(INTEGRATION_REQUEST_OPEN);
    }
    return laneOk(null);
  });
}

/**
 * Settles abandoned `pending` cleanup operations left by a crash mid-cleanup (16-19, CR-B7/SR-B10):
 * - if the lane is pinned or holds an open integration request, closes the pending cleanup
 *   operations as `kept` (`lane-pinned` / `integration-request-open`) without touching `baseRef`;
 * - if the worktree is already absent and unregistered, re-checks pin/open-request eligibility
 *   under the generation fence before deleting any leftover `baseRef` and moving to `removed`;
 * - if the worktree is still present or registered, ends the interrupted cleanup operation as
 *   `failed` without discarding user work, leaving the lane `cleanup-eligible`.
 */
async function settleInterruptedCleanups(
  ctx: ReconcileContext,
  linkedPaths: ReadonlySet<string>
): Promise<LaneResult<LaneEntry[]>> {
  const pendingCleanups = ctx.lanes
    .listPendingOperations(ctx.workspaceId)
    .filter((op) => op.kind === 'cleanup' && (ownedByAnEarlierHost(ctx, op) || !ctx.inFlight(op.laneId)));
  if (pendingCleanups.length === 0) return laneOk([]);

  const byLane = new Map<string, string[]>();
  for (const op of pendingCleanups) {
    const list = byLane.get(op.laneId) ?? [];
    list.push(op.operationId);
    byLane.set(op.laneId, list);
  }

  const entries: LaneEntry[] = [];
  for (const [laneId, operationIds] of byLane) {
    const preGuard = guardInterruptedCleanup(ctx, laneId, operationIds);
    if (!preGuard.ok) return laneRefused(preGuard.refusal.reason);
    if (preGuard.value !== null) continue;

    const lane = ctx.lanes.getLane(ctx.workspaceId, laneId);
    if (lane === null || lane.state !== 'cleanup-eligible') {
      const closed = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
        const now = nowIso(ctx);
        for (const opId of operationIds) ctx.lanes.endOperation(opId, 'failed', CLEANUP_INTERRUPTED, now);
        return laneOk(undefined);
      });
      if (!closed.ok) return laneRefused(closed.refusal.reason);
      continue;
    }

    const located = await ctx.locateLaneRoot(lane.rootRef);
    const expectedPath = await canonicalPath(path.join(ctx.storageDir, lane.rootRef));
    const stillRegistered = linkedPaths.has(expectedPath);

    if (located.kind === 'absent' && !stillRegistered) {
      const existingBase = await resolveCommit(
        { git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: RECONCILE_GIT_TIMEOUT_MS },
        lane.baseRef
      );
      let refDeletedOk = true;
      if (existingBase !== null) {
        const refGuard = guardInterruptedCleanup(ctx, lane.laneId, operationIds);
        if (!refGuard.ok) return laneRefused(refGuard.refusal.reason);
        if (refGuard.value !== null) continue;

        const deleted = await ctx.git.run(['update-ref', '-d', lane.baseRef, lane.sourceCommit], {
          cwd: ctx.workspaceRoot,
          timeoutMs: RECONCILE_GIT_TIMEOUT_MS
        });
        refDeletedOk = deleted.ok;
      }
      const settled = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
        const now = nowIso(ctx);
        const latest = ctx.lanes.getLane(ctx.workspaceId, lane.laneId);
        if (latest === null || latest.state !== 'cleanup-eligible') {
          for (const opId of operationIds) ctx.lanes.endOperation(opId, 'failed', CLEANUP_INTERRUPTED, now);
          return laneOk(null);
        }
        if (latest.pinned) {
          for (const opId of operationIds) ctx.lanes.endOperation(opId, 'kept', LANE_PINNED, now);
          recordOperation(ctx, lane.laneId, 'kept', LANE_PINNED);
          return laneOk(null);
        }
        if (ctx.integrations.countLaneRequests(lane.laneId, OPEN_REQUEST_STATES) > 0) {
          for (const opId of operationIds) ctx.lanes.endOperation(opId, 'kept', INTEGRATION_REQUEST_OPEN, now);
          recordOperation(ctx, lane.laneId, 'kept', INTEGRATION_REQUEST_OPEN);
          return laneOk(null);
        }
        const moved = ctx.lanes.transitionLane(ctx.workspaceId, lane.laneId, ['cleanup-eligible'], 'removed', {
          reason: null,
          now,
          generation: ctx.generation,
          requireUnpinned: true
        });
        if (!moved.ok) {
          if (moved.refusal.reason === LANE_PINNED) {
            for (const opId of operationIds) ctx.lanes.endOperation(opId, 'kept', LANE_PINNED, now);
            recordOperation(ctx, lane.laneId, 'kept', LANE_PINNED);
          } else {
            for (const opId of operationIds) ctx.lanes.endOperation(opId, 'failed', CLEANUP_INTERRUPTED, now);
          }
          return laneOk(null);
        }
        for (const opId of operationIds) {
          ctx.lanes.endOperation(opId, 'succeeded', refDeletedOk ? null : BASE_REF_KEPT, now);
        }
        recordOperation(ctx, lane.laneId, 'succeeded', null);
        return laneOk<LaneEntry>({ laneId: lane.laneId, from: 'cleanup-eligible', to: 'removed', observation: null });
      });
      if (!settled.ok) return laneRefused(settled.refusal.reason);
      if (settled.value !== null) entries.push(settled.value);
    } else {
      const settled = ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
        const now = nowIso(ctx);
        for (const opId of operationIds) ctx.lanes.endOperation(opId, 'failed', CLEANUP_INTERRUPTED, now);
        recordOperation(ctx, lane.laneId, 'succeeded', CLEANUP_INTERRUPTED);
        return laneOk(undefined);
      });
      if (!settled.ok) return laneRefused(settled.refusal.reason);
    }
  }
  return laneOk(entries);
}

function requeueInterruptedVerification(ctx: ReconcileContext): LaneResult<RequestEntry[]> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const now = nowIso(ctx);
    const entries: RequestEntry[] = [];
    for (const request of ctx.integrations.requestsInStates(ctx.workspaceId, ['verifying'])) {
      if (!abandoned(ctx, request)) continue;
      const change = { reason: null, now, generation: ctx.generation };
      const moved = ctx.integrations.transitionRequest(ctx.workspaceId, request.requestId, ['verifying'], 'queued', change);
      if (moved.ok) entries.push({ requestId: request.requestId, from: 'verifying', to: 'queued', reason: null });
    }
    return laneOk(entries);
  });
}

async function observeOrNull(ctx: ReconcileContext, request: RequestRecord): Promise<LandingObservation | null> {
  try {
    return await observeLanding(ctx, request);
  } catch (error) {
    if (error instanceof LaneGitError) return null;
    throw error;
  }
}

/** `null` when the request is left in `landing`: Git could not say, or it moved meanwhile. */
async function settleInterruptedLanding(ctx: ReconcileContext, request: RequestRecord): Promise<LaneResult<RequestEntry | null>> {
  const observation = await observeOrNull(ctx, request);
  if (observation === null) return laneOk(null);
  const verdict = classifyLandingObservation(observation);
  const by = { kind: 'reconcile', method: null } as const;
  const settled = settleLanding(ctx, request, by, observation.observedTip, verdict.outcome, verdict.reason);
  if (!settled.ok) return settled.refusal.reason === 'ownership-superseded' ? laneRefused(settled.refusal.reason) : laneOk(null);
  const entry: RequestEntry = { requestId: request.requestId, from: 'landing', to: verdict.outcome, reason: verdict.reason };
  if (verdict.outcome === 'landed') return laneOk(entry);
  return laneOk({ ...entry, commits: commitsOf(request, observation.observedTip) });
}

async function settleInterruptedLandings(ctx: ReconcileContext): Promise<LaneResult<RequestEntry[]>> {
  const entries: RequestEntry[] = [];
  for (const request of ctx.integrations.requestsInStates(ctx.workspaceId, ['landing'])) {
    if (!abandoned(ctx, request)) continue;
    const settled = await settleInterruptedLanding(ctx, request);
    if (!settled.ok) return laneRefused(settled.refusal.reason);
    if (settled.value !== null) entries.push(settled.value);
  }
  return laneOk(entries);
}

async function observeMissingRoots(
  ctx: ReconcileContext,
  linkedPaths: ReadonlySet<string>
): Promise<LaneResult<LaneEntry[]>> {
  const entries: LaneEntry[] = [];
  for (const lane of ctx.lanes.lanesInStates(ctx.workspaceId, ROOTED_STATES)) {
    const located = await ctx.locateLaneRoot(lane.rootRef);
    if (located.kind === 'contained') continue;
    if (located.kind === 'not-contained') {
      entries.push({ laneId: lane.laneId, from: lane.state, to: lane.state, observation: CONTAINMENT_REFUSED });
      continue;
    }
    // Unregistered absent lanes whose provisioning failed never created a root on disk (16-19).
    if (lane.state === 'cleanup-eligible' && ctx.lanes.isProvisionFailureWithoutSuccess(lane.laneId)) {
      const expectedPath = await canonicalPath(path.join(ctx.storageDir, lane.rootRef));
      if (!linkedPaths.has(expectedPath)) continue;
    }
    entries.push({ laneId: lane.laneId, from: lane.state, to: lane.state, observation: ROOT_MISSING });
  }
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    for (const entry of entries) recordOperation(ctx, entry.laneId, 'kept', entry.observation);
    return laneOk(entries);
  });
}

/**
 * Contract §5: settles every record an earlier host left mid-operation and reports each change.
 * Refuses only `ownership-superseded`. Throws `LaneGitError` when the worktree registry cannot be
 * read, before anything is written.
 */
export async function reconcileLanes(ctx: ReconcileContext): Promise<LaneResult<ReconcileReport>> {
  const fence = ctx.lanes.assertGeneration(ctx.workspaceId, ctx.generation);
  if (!fence.ok) return laneRefused(fence.refusal.reason);
  const { unknownWorktrees, linkedPaths } = await inspectWorktrees(ctx);

  const failed = failInterruptedProvisioning(ctx);
  if (!failed.ok) return laneRefused(failed.refusal.reason);
  const cleanups = await settleInterruptedCleanups(ctx, linkedPaths);
  if (!cleanups.ok) return laneRefused(cleanups.refusal.reason);
  const requeued = requeueInterruptedVerification(ctx);
  if (!requeued.ok) return laneRefused(requeued.refusal.reason);
  const landings = await settleInterruptedLandings(ctx);
  if (!landings.ok) return laneRefused(landings.refusal.reason);
  const missing = await observeMissingRoots(ctx, linkedPaths);
  if (!missing.ok) return laneRefused(missing.refusal.reason);
  const retained = pruneLaneRetention({
    lanes: ctx.lanes,
    workspaceId: ctx.workspaceId,
    generation: ctx.generation,
    clock: ctx.clock,
    ...(ctx.retentionPolicy === undefined ? {} : { policy: ctx.retentionPolicy })
  });
  if (!retained.ok) return laneRefused(retained.refusal.reason);

  return laneOk({
    lanes: [...failed.value, ...cleanups.value, ...missing.value],
    requests: [...requeued.value, ...landings.value],
    unknownWorktrees
  });
}
