/**
 * FR-R6-F10 (contract §5, `requestIntegration`): opening an integration request for a lane's
 * current candidate.
 *
 * The request freezes three things: the target tip it expects, the canonical profile JSON and its
 * SHA-256. Landing later compares the live target with the frozen tip; it never re-reads a
 * profile.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  laneOk,
  laneRefused,
  type LaneResult,
  type LaneState,
  type VerificationProfile
} from '../../contracts/execution-lanes';
import { isAncestorDetailed as observeIsAncestorDetailed, type AncestryResult } from './git-observe';
import { LaneGitError, type LaneGitRunner } from './git-runner';
import type { IntegrationStore, RequestRecord } from './integration-store';
import {
  canonicalProfileJson,
  isValidTargetBranch,
  profileDigest,
  snapshotVerificationProfile
} from './lane-input-rules';
import type { LaneStore } from './lane-store';
import type { CandidateRecord, LaneRecord } from './lane-store-rows';

/** A lane in one of these states may open a request (data-model, integration lifecycle). */
export const REQUESTABLE_LANE_STATES: readonly LaneState[] = Object.freeze(['active', 'paused', 'completed']);

const BRANCH_REF_PREFIX = 'refs/heads/';
const GIT_TIMEOUT_MS = 60_000;
const ID_BYTES = 16;
/** `rev-parse --verify --quiet` and `merge-base --is-ancestor` exit 1 for "no". */
const GIT_NO_EXIT_CODE = 1;

export interface RequestIntegrationInput {
  readonly laneId: string;
  readonly targetBranch: string;
  readonly profile: VerificationProfile;
}

export interface RequestContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly git: LaneGitRunner;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

/** The commit `ref` names, `null` when it names none, or a throw when Git could not say. */
export async function resolveRef(
  ctx: Pick<RequestContext, 'git' | 'workspaceRoot'>,
  ref: string
): Promise<string | null> {
  const result = await ctx.git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: ctx.workspaceRoot,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (result.ok) return result.stdout.trim();
  if (result.code === 'exit' && result.exitCode === GIT_NO_EXIT_CODE) return null;
  throw new LaneGitError('rev-parse', result);
}

/**
 * Distinguishes ancestry (`ancestor` / `not-ancestor`), an absent/GC'd commit (`missing-ref`),
 * and a Git subprocess failure (`git-error`).
 */
export function isAncestorDetailed(
  git: LaneGitRunner,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<AncestryResult> {
  return observeIsAncestorDetailed({ git, cwd, timeoutMs: GIT_TIMEOUT_MS }, ancestor, descendant);
}

/** Whether `ancestor` is reachable from `descendant`. Throws `LaneGitError` on Git failure. */
export async function isAncestor(
  git: LaneGitRunner,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await isAncestorDetailed(git, cwd, ancestor, descendant);
  if (result.outcome === 'ancestor') return true;
  if (result.outcome === 'not-ancestor' || result.outcome === 'missing-ref') return false;
  throw new LaneGitError('merge-base', result.failure ?? { code: 'exit', exitCode: null });
}

async function treeOf(ctx: RequestContext, commit: string): Promise<string> {
  const result = await ctx.git.run(['rev-parse', '--verify', `${commit}^{tree}`], {
    cwd: ctx.workspaceRoot,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!result.ok) throw new LaneGitError('rev-parse', result);
  return result.stdout.trim();
}

function recordOf(
  ctx: RequestContext,
  lane: LaneRecord,
  candidate: CandidateRecord,
  targetBranch: string,
  profile: VerificationProfile,
  tip: string
): RequestRecord {
  const now = new Date(ctx.clock()).toISOString();
  const profileJson = canonicalProfileJson(profile);
  return {
    requestId: ctx.random(ID_BYTES).toString('hex'),
    laneId: lane.laneId,
    workspaceId: ctx.workspaceId,
    repositoryId: lane.repositoryId,
    candidateId: candidate.candidateId,
    candidateCommit: candidate.commit,
    targetRef: `${BRANCH_REF_PREFIX}${targetBranch}`,
    expectedTargetCommit: tip,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    profileDigest: profileDigest(profileJson),
    profileJson,
    state: 'queued',
    reason: null,
    verificationAttempt: 0,
    ownerGeneration: ctx.generation,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Opens a `queued` request for `lane`'s current candidate against `targetBranch`, or the first
 * refusal. Snapshots `targetBranch` and `profile` once before any asynchronous Git step so caller
 * getters or post-call mutations cannot diverge. Throws `LaneGitError` when Git cannot answer.
 */
export async function createIntegrationRequest(
  ctx: RequestContext,
  lane: LaneRecord,
  input: RequestIntegrationInput
): Promise<LaneResult<RequestRecord>> {
  let targetBranch: unknown;
  let rawProfile: unknown;
  try {
    targetBranch = input.targetBranch;
    rawProfile = input.profile;
  } catch {
    return laneRefused('invalid-input');
  }
  if (typeof targetBranch !== 'string' || !isValidTargetBranch(targetBranch)) return laneRefused('invalid-input');
  const profile = snapshotVerificationProfile(rawProfile);
  if (profile === null) return laneRefused('invalid-input');
  if (!REQUESTABLE_LANE_STATES.includes(lane.state)) return laneRefused('lane-state-invalid');
  const candidate = ctx.lanes.currentCandidate(lane.laneId);
  if (candidate === null) return laneRefused('candidate-empty');

  const tip = await resolveRef(ctx, `${BRANCH_REF_PREFIX}${targetBranch}`);
  if (tip === null) return laneRefused('invalid-input');
  const ancestry = await isAncestorDetailed(ctx.git, ctx.workspaceRoot, tip, candidate.commit);
  if (ancestry.outcome === 'git-error') {
    throw new LaneGitError('merge-base', ancestry.failure ?? { code: 'exit', exitCode: null });
  }
  if (ancestry.outcome !== 'ancestor') return laneRefused('target-diverged');
  if ((await treeOf(ctx, tip)) === candidate.tree) return laneRefused('candidate-empty');

  const record = recordOf(ctx, lane, candidate, targetBranch, profile, tip);
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const current = ctx.lanes.currentCandidate(lane.laneId);
    if (current === null || current.candidateId !== candidate.candidateId) return laneRefused('lane-busy');
    ctx.integrations.insertRequest(record);
    return laneOk(record);
  });
}
