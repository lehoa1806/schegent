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
  type LaneResult,
  type LaneState,
  type ReconcileReport
} from '../../contracts/execution-lanes';
import { canonicalPath, listWorktrees } from './git-observe';
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

const ID_BYTES = 16;
const RECONCILE_GIT_TIMEOUT_MS = 60_000;
const UNKNOWN_FAILURE = { code: 'exit', exitCode: null } as const;
const PROVISIONING_INTERRUPTED = 'provisioning-interrupted';
const ROOT_MISSING = 'root-missing';
/** States whose lanes keep a root on disk (data-model, lane lifecycle). */
const ROOTED_STATES: readonly LaneState[] = Object.freeze(['active', 'paused', 'completed', 'retained', 'cleanup-eligible']);

export interface ReconcileContext extends LandingContext {
  /** The real path of an existing, contained lane root, or `null`. */
  readonly resolveLaneRoot: (rootRef: string) => Promise<string | null>;
  /** Whether this host has an operation in flight on the lane. */
  readonly inFlight: (laneId: string) => boolean;
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

/** One finished `reconcile` operation; call inside the fence. */
function recordOperation(ctx: ReconcileContext, laneId: string, status: 'succeeded' | 'kept', reason: string | null): void {
  const operationId = ctx.random(ID_BYTES).toString('hex');
  const now = nowIso(ctx);
  ctx.lanes.beginOperation({ operationId, laneId, workspaceId: ctx.workspaceId, kind: 'reconcile', generation: ctx.generation, now });
  ctx.lanes.endOperation(operationId, status, reason, now);
}

/** Registry entries, other than the main worktree and the workspace, that no lane names. */
async function countUnknownWorktrees(ctx: ReconcileContext): Promise<number> {
  const entries = await listWorktrees({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: RECONCILE_GIT_TIMEOUT_MS });
  if (entries === null) throw new LaneGitError('worktree', UNKNOWN_FAILURE);
  const laneRoots = ctx.lanes.lanesInStates(ctx.workspaceId, LANE_STATES).map((lane) => path.join(ctx.storageDir, lane.rootRef));
  const known = new Set(await Promise.all([ctx.workspaceRoot, ...laneRoots].map(canonicalPath)));
  const linked = await Promise.all(entries.slice(1).map((entry) => canonicalPath(entry.path)));
  return linked.filter((entry) => !known.has(entry)).length;
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

async function observeMissingRoots(ctx: ReconcileContext): Promise<LaneResult<LaneEntry[]>> {
  const entries: LaneEntry[] = [];
  for (const lane of ctx.lanes.lanesInStates(ctx.workspaceId, ROOTED_STATES)) {
    if ((await ctx.resolveLaneRoot(lane.rootRef)) !== null) continue;
    entries.push({ laneId: lane.laneId, from: lane.state, to: lane.state, observation: ROOT_MISSING });
  }
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    for (const entry of entries) recordOperation(ctx, entry.laneId, 'kept', ROOT_MISSING);
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
  const unknownWorktrees = await countUnknownWorktrees(ctx);

  const failed = failInterruptedProvisioning(ctx);
  if (!failed.ok) return laneRefused(failed.refusal.reason);
  const requeued = requeueInterruptedVerification(ctx);
  if (!requeued.ok) return laneRefused(requeued.refusal.reason);
  const landings = await settleInterruptedLandings(ctx);
  if (!landings.ok) return laneRefused(landings.refusal.reason);
  const missing = await observeMissingRoots(ctx);
  if (!missing.ok) return laneRefused(missing.refusal.reason);

  return laneOk({
    lanes: [...failed.value, ...missing.value],
    requests: [...requeued.value, ...landings.value],
    unknownWorktrees
  });
}
