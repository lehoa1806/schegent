/**
 * FR-R6-F10 (contract §6, research R4): landing an approved request on its target branch.
 *
 * The order is fixed: the intent is journaled, the target is re-checked, the Git effect runs, the
 * target is observed, and only the observation decides the outcome. The effect's own exit status
 * is never trusted; `classifyLandingObservation` is the one rule the service and the reconciler
 * both apply, and neither ever re-applies a landing.
 *
 * A target checked out in a worktree is fast-forwarded there with autostash forced off; a target
 * checked out nowhere is moved with `update-ref` and the expected old value.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  laneRefused,
  type LaneRefusalCommits,
  type LaneRefusalReason,
  type LaneResult,
  type LandingMethod,
  type ReceiptOutcome
} from '../../contracts/execution-lanes';
import { resolveContainedTarget } from '../../lib/path-containment';
import { listWorktrees, trackedDirtyCount } from './git-observe';
import { LaneGitError, type LaneGitRunner } from './git-runner';
import type { IntegrationStore } from './integration-store';
import type { RequestRecord } from './integration-store-rows';
import { isAncestor, resolveRef } from './integration-requests';
import type { LaneStore } from './lane-store';
import { LANES_DIRECTORY } from './lane-store-rows';
import { isStaleByRefreeze, receiptMatches } from './review-receipts';

const LANDING_GIT_TIMEOUT_MS = 60_000;
const ID_BYTES = 16;
const UNKNOWN_FAILURE = { code: 'exit', exitCode: null } as const;

export interface LandingObservation {
  readonly expected: string;
  readonly candidate: string;
  /** The target's tip after the effect; `null` when the branch is gone. */
  readonly observedTip: string | null;
  /** Whether the candidate is reachable from the observed tip. */
  readonly isAncestor: boolean;
  /** For a checked-out target, whether its tracked files are clean; `null` when checked out nowhere. */
  readonly checkedOutFilesMatch: boolean | null;
}

export type LandingClassification =
  | { readonly outcome: 'landed'; readonly reason: null | 'target-advanced-beyond' }
  | { readonly outcome: 'blocked'; readonly reason: 'landing-not-applied' }
  | { readonly outcome: 'uncertain'; readonly reason: null };

/** Contract §6: what an observed target says about a landing. Pure. */
export function classifyLandingObservation(observation: LandingObservation): LandingClassification {
  const { expected, candidate, observedTip } = observation;
  if (observedTip === null) return { outcome: 'uncertain', reason: null };
  if (observedTip === expected) return { outcome: 'blocked', reason: 'landing-not-applied' };
  if (observedTip === candidate) {
    return observation.checkedOutFilesMatch === false
      ? { outcome: 'uncertain', reason: null }
      : { outcome: 'landed', reason: null };
  }
  if (observation.isAncestor) return { outcome: 'landed', reason: 'target-advanced-beyond' };
  return { outcome: 'uncertain', reason: null };
}

export interface LandingContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly git: LaneGitRunner;
  readonly workspaceRoot: string;
  readonly storageDir: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

/** Where the target branch is checked out. */
type TargetPlace =
  | { readonly kind: 'lane' }
  | { readonly kind: 'checked-out'; readonly worktree: string }
  | { readonly kind: 'nowhere' };

interface Recheck {
  readonly reason: LaneRefusalReason;
  readonly observed: string | null;
}

function nowIso(ctx: LandingContext): string {
  return new Date(ctx.clock()).toISOString();
}

/** The commits a blocked or uncertain outcome carries (contract §6). */
export function commitsOf(request: RequestRecord, observed: string | null): LaneRefusalCommits {
  const base = { expected: request.expectedTargetCommit, candidate: request.candidateCommit };
  return observed === null ? base : { ...base, observed };
}

async function isLaneRoot(ctx: LandingContext, worktree: string): Promise<boolean> {
  const verdict = await resolveContainedTarget(worktree, [path.join(ctx.storageDir, LANES_DIRECTORY)]);
  return verdict.outcome === 'contained';
}

/**
 * Finds the worktrees holding the target branch. Git refuses a branch checked out twice without
 * `--force`; if it happened anyway, any lane among them makes the target a lane.
 */
async function locateTarget(ctx: LandingContext, targetRef: string): Promise<TargetPlace> {
  const entries = await listWorktrees({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: LANDING_GIT_TIMEOUT_MS });
  if (entries === null) throw new LaneGitError('worktree', UNKNOWN_FAILURE);
  const holders = entries.filter((entry) => entry.branch === targetRef && !entry.bare && !entry.prunable);
  for (const holder of holders) {
    if (await isLaneRoot(ctx, holder.path)) return { kind: 'lane' };
  }
  const first = holders.at(0);
  return first === undefined ? { kind: 'nowhere' } : { kind: 'checked-out', worktree: first.path };
}

async function dirtyCount(ctx: LandingContext, worktree: string): Promise<number> {
  const count = await trackedDirtyCount({ git: ctx.git, cwd: worktree, timeoutMs: LANDING_GIT_TIMEOUT_MS });
  if (count === null) throw new LaneGitError('status', UNKNOWN_FAILURE);
  return count;
}

/** The first reason the target cannot take the landing now, or `null`. */
async function recheckTarget(ctx: LandingContext, request: RequestRecord, place: TargetPlace): Promise<Recheck | null> {
  const tip = await resolveRef(ctx, request.targetRef);
  if (place.kind === 'lane') return { reason: 'target-is-lane', observed: tip };
  if (tip !== request.expectedTargetCommit) {
    const advanced = tip !== null && (await isAncestor(ctx.git, ctx.workspaceRoot, request.expectedTargetCommit, tip));
    return { reason: advanced ? 'target-advanced' : 'target-diverged', observed: tip };
  }
  if (place.kind === 'checked-out' && (await dirtyCount(ctx, place.worktree)) > 0) {
    return { reason: 'target-worktree-dirty', observed: tip };
  }
  return null;
}

function methodFor(place: TargetPlace): LandingMethod {
  return place.kind === 'nowhere' ? 'update-ref' : 'ff-merge';
}

/** Runs the Git effect. Its result is deliberately ignored: the observation decides. */
async function applyLanding(ctx: LandingContext, request: RequestRecord, place: TargetPlace): Promise<void> {
  if (place.kind === 'checked-out') {
    await ctx.git.run(['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', request.candidateCommit], {
      cwd: place.worktree,
      timeoutMs: LANDING_GIT_TIMEOUT_MS
    });
    return;
  }
  await ctx.git.run(['update-ref', request.targetRef, request.candidateCommit, request.expectedTargetCommit], {
    cwd: ctx.workspaceRoot,
    timeoutMs: LANDING_GIT_TIMEOUT_MS
  });
}

async function observeTarget(ctx: LandingContext, request: RequestRecord, place: TargetPlace): Promise<LandingObservation> {
  const observedTip = await resolveRef(ctx, request.targetRef);
  const reachable = observedTip !== null && (await isAncestor(ctx.git, ctx.workspaceRoot, request.candidateCommit, observedTip));
  const checkedOutFilesMatch = place.kind === 'checked-out' ? (await dirtyCount(ctx, place.worktree)) === 0 : null;
  return {
    expected: request.expectedTargetCommit,
    candidate: request.candidateCommit,
    observedTip,
    isAncestor: reachable,
    checkedOutFilesMatch
  };
}

/**
 * Observes a `landing` request's target without touching it. The reconciler's half of the rule:
 * the observation it returns goes to `classifyLandingObservation`, never to a second effect.
 * Throws `LaneGitError` when Git cannot say what the target holds.
 */
export async function observeLanding(ctx: LandingContext, request: RequestRecord): Promise<LandingObservation> {
  const place = await locateTarget(ctx, request.targetRef);
  return observeTarget(ctx, request, place);
}

/** Who settles: the landing itself (`landing-observed` with its method), or the reconciler. */
export type SettledBy =
  | { readonly kind: 'landing-observed'; readonly method: LandingMethod }
  | { readonly kind: 'reconcile'; readonly method: null };

/**
 * One fenced write: the state, the receipt outcome and the journal entry together. Only a request
 * still in `landing` moves; any other refuses `request-state-invalid` with nothing written.
 */
export function settleLanding(
  ctx: LandingContext,
  request: RequestRecord,
  by: SettledBy,
  observedTip: string | null,
  outcome: ReceiptOutcome,
  reason: string | null
): LaneResult<RequestRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const now = nowIso(ctx);
    const moved = ctx.integrations.transitionRequest(ctx.workspaceId, request.requestId, ['landing'], outcome, {
      reason,
      now,
      generation: ctx.generation
    });
    if (!moved.ok) return moved;
    ctx.integrations.setReceiptOutcome(request.requestId, outcome, reason);
    ctx.integrations.appendJournal({
      entryId: ctx.random(ID_BYTES).toString('hex'),
      requestId: request.requestId,
      kind: by.kind,
      method: by.method,
      candidateCommit: request.candidateCommit,
      expectedCommit: request.expectedTargetCommit,
      observedTip,
      outcome,
      reason,
      generation: ctx.generation,
      now
    });
    return moved;
  });
}

/** Moves the request into `landing` and journals the intent, in one fenced write. */
function begin(ctx: LandingContext, request: RequestRecord, method: LandingMethod): LaneResult<RequestRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const receipt = ctx.integrations.getReceipt(request.requestId);
    if (receipt === null || receipt.outcome !== null || !receiptMatches(receipt, request)) {
      return laneRefused<RequestRecord>('review-stale');
    }
    const now = nowIso(ctx);
    const moved = ctx.integrations.transitionRequest(ctx.workspaceId, request.requestId, ['awaiting-review'], 'landing', {
      reason: null,
      now,
      generation: ctx.generation
    });
    if (!moved.ok) return moved;
    ctx.integrations.appendJournal({
      entryId: ctx.random(ID_BYTES).toString('hex'),
      requestId: request.requestId,
      kind: 'landing-intent',
      method,
      candidateCommit: request.candidateCommit,
      expectedCommit: request.expectedTargetCommit,
      observedTip: null,
      outcome: null,
      reason: null,
      generation: ctx.generation,
      now
    });
    return moved;
  });
}

/**
 * Lands an approved request, or the first refusal. A refusal from the re-checks or an effect that
 * did not apply leaves the request `blocked` with the commits; `uncertain` comes back as a value.
 * Throws `LaneGitError` when Git cannot say what the target holds; the request then stays in
 * `landing` until a reconcile, from this host or a later one, observes and settles it.
 */
export async function landRequest(ctx: LandingContext, request: RequestRecord): Promise<LaneResult<RequestRecord>> {
  if (isStaleByRefreeze(request)) return laneRefused('review-stale');
  if (request.state !== 'awaiting-review') return laneRefused('request-state-invalid');

  const place = await locateTarget(ctx, request.targetRef);
  const started = begin(ctx, request, methodFor(place));
  if (!started.ok) return started;

  // Located again right before the effect: a branch checked out since the first look must be
  // fast-forwarded in its worktree, never moved under it by `update-ref` (review S9).
  const current = await locateTarget(ctx, request.targetRef);
  const by: SettledBy = { kind: 'landing-observed', method: methodFor(current) };
  const refusal = await recheckTarget(ctx, request, current);
  if (refusal !== null) {
    const blocked = settleLanding(ctx, request, by, refusal.observed, 'blocked', refusal.reason);
    return blocked.ok ? laneRefused(refusal.reason, commitsOf(request, refusal.observed)) : blocked;
  }

  await applyLanding(ctx, request, current);
  const observation = await observeTarget(ctx, request, current);
  const verdict = classifyLandingObservation(observation);
  const settled = settleLanding(ctx, request, by, observation.observedTip, verdict.outcome, verdict.reason);
  if (!settled.ok || verdict.outcome !== 'blocked') return settled;
  return laneRefused(verdict.reason, commitsOf(request, observation.observedTip));
}
