/**
 * FR-R6-F10 (research R3): freezing a lane's work into a candidate commit.
 *
 * Plumbing only: `add -A`, `write-tree`, `commit-tree`, then `update-ref` of the lane's detached
 * `HEAD` with its expected old value, then the candidate ref. `git commit` is never called, so no
 * commit hook runs; `reference-transaction` still may (research R3, "What this does not claim").
 * `commit-tree` is told not to sign, so an operator's signing config cannot stall a host
 * operation on a passphrase prompt.
 *
 * Identity comes from `git config user.name` and `user.email` as the lane sees them. With either
 * missing the freeze refuses `git-identity-missing`; the host never invents an author.
 *
 * Recording the candidate blocks every open request of the lane with `review-stale`, in the same
 * fenced transaction. A request that is `verifying` or `landing` makes the freeze refuse
 * `lane-busy` before any Git effect.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneOk, laneRefused, type IntegrationState, type LaneResult } from '../../contracts/execution-lanes';
import { LaneGitError, type LaneGitRunner } from './git-runner';
import type { IntegrationStore } from './integration-store';
import type { LaneStore } from './lane-store';
import type { CandidateRecord, LaneRecord } from './lane-store-rows';

/** The bound on each Git call of a lane operation other than provisioning. */
export const LANE_GIT_TIMEOUT_MS = 60_000;

/** A request in one of these states depends on the lane's current candidate. */
export const LANE_BUSY_STATES: readonly IntegrationState[] = Object.freeze(['verifying', 'landing']);

const ID_BYTES = 16;
const IDENTITY_KEYS = Object.freeze(['user.name', 'user.email']);
/** `git config --get` exits 1 when the key is unset. */
const CONFIG_UNSET_EXIT_CODE = 1;
const CANDIDATE_MESSAGE = 'schegent lane candidate';

export interface FreezeContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly git: LaneGitRunner;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

async function stdoutOf(ctx: FreezeContext, root: string, args: readonly string[]): Promise<string> {
  const result = await ctx.git.run(args, { cwd: root, timeoutMs: LANE_GIT_TIMEOUT_MS });
  if (!result.ok) throw new LaneGitError(args.at(0) ?? 'git', result);
  return result.stdout.trim();
}

async function hasIdentity(ctx: FreezeContext, root: string): Promise<boolean> {
  for (const key of IDENTITY_KEYS) {
    const result = await ctx.git.run(['config', '--get', key], { cwd: root, timeoutMs: LANE_GIT_TIMEOUT_MS });
    if (!result.ok) {
      if (result.code === 'exit' && result.exitCode === CONFIG_UNSET_EXIT_CODE) return false;
      throw new LaneGitError('config', result);
    }
    if (result.stdout.trim() === '') return false;
  }
  return true;
}

/**
 * Freezes the work in `root`, the lane's resolved root. The caller has checked that the lane is
 * `active`. Throws `LaneGitError` when a Git step fails for a reason no refusal names.
 */
export async function freezeCandidate(
  ctx: FreezeContext,
  lane: LaneRecord,
  root: string
): Promise<LaneResult<CandidateRecord>> {
  if (ctx.integrations.countLaneRequests(lane.laneId, LANE_BUSY_STATES) > 0) return laneRefused('lane-busy');
  if (!(await hasIdentity(ctx, root))) return laneRefused('git-identity-missing');

  const head = await stdoutOf(ctx, root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  await stdoutOf(ctx, root, ['add', '-A']);
  const tree = await stdoutOf(ctx, root, ['write-tree']);
  // "No changes" is measured from the last recorded candidate, not from HEAD: a freeze that
  // failed after moving HEAD left no record, and must be repeatable (review R3).
  const recorded = ctx.lanes.currentCandidate(lane.laneId)?.commit ?? lane.sourceCommit;
  const recordedTree = await stdoutOf(ctx, root, ['rev-parse', '--verify', `${recorded}^{tree}`]);
  if (tree === recordedTree) return laneRefused('candidate-empty');

  const message = `${CANDIDATE_MESSAGE} ${lane.laneId}`;
  const commit = await stdoutOf(ctx, root, ['commit-tree', '--no-gpg-sign', '-p', head, '-m', message, tree]);
  await stdoutOf(ctx, root, ['update-ref', '--no-deref', 'HEAD', commit, head]);
  await stdoutOf(ctx, root, ['update-ref', lane.candidateRef, commit]);

  const now = new Date(ctx.clock()).toISOString();
  const candidateId = ctx.random(ID_BYTES).toString('hex');
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    ctx.integrations.blockOpenRequestsForLane(lane.laneId, { now, generation: ctx.generation });
    return laneOk(
      ctx.lanes.insertCandidate({
        candidateId,
        laneId: lane.laneId,
        commit,
        tree,
        parent: head,
        generation: ctx.generation,
        now
      })
    );
  });
}
