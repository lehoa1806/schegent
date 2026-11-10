/**
 * FR-R6-F10 (research "Entry condition 3"): the provisioning probe.
 *
 * It runs before any worktree exists and refuses with the first failed check, in this order:
 *   1. Git is at least 2.17;
 *   2. the workspace is the top level of a repository with no superproject;
 *   3. the lanes directory does not resolve inside the workspace;
 *   4. the dependency recipe is `none`;
 *   5. the source revision names a commit;
 *   6. that commit's tree holds no gitlink;
 *   7. no `.gitattributes` in that tree routes a path through `filter=lfs`.
 * The live-lane bound (check 8) is checked inside the provisioning transaction instead.
 *
 * A check Git could not answer fails closed with that check's own reason: a property that cannot
 * be proven absent is treated as present. When the deadline has passed, the reason is
 * `provisioning-deadline-exceeded` instead.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEPENDENCY_RECIPES,
  laneOk,
  laneRefused,
  type LaneRefusalReason,
  type LaneResult
} from '../../contracts/execution-lanes';
import { classifyDestination } from '../../lib/path-containment';
import {
  hasGitlinks,
  hasLfsAttributes,
  meetsLaneGitFloor,
  readGitVersion,
  repositoryIdOf,
  resolveCommit,
  type GitContext
} from './git-observe';
import type { LaneGitRunner } from './git-runner';
import type { ProvisionProbeResult, ProvisionRequest } from './lane-provisioner';
import { LANES_DIRECTORY } from './lane-store-rows';

export interface ProbeContext {
  readonly git: LaneGitRunner;
  readonly workspaceRoot: string;
  readonly storageDir: string;
}

/** A revision Git could read as an option is never passed to it. */
const OPTION_PREFIX = '-';

type Topology = 'top-level' | 'nested' | 'not-a-repository';

function isSupportedRecipe(recipe: string): boolean {
  return DEPENDENCY_RECIPES.some((allowed) => allowed === recipe);
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

async function topologyOf(ctx: ProbeContext, git: GitContext): Promise<Topology> {
  const top = await ctx.git.run(['rev-parse', '--show-toplevel'], { cwd: git.cwd, timeoutMs: git.timeoutMs });
  if (!top.ok || top.stdout.trim() === '') return 'not-a-repository';
  const [topReal, workspaceReal] = await Promise.all([
    realpathOrNull(path.resolve(ctx.workspaceRoot, top.stdout.trim())),
    realpathOrNull(ctx.workspaceRoot)
  ]);
  if (topReal === null || workspaceReal === null || topReal !== workspaceReal) return 'nested';
  const superproject = await ctx.git.run(['rev-parse', '--show-superproject-working-tree'], {
    cwd: git.cwd,
    timeoutMs: git.timeoutMs
  });
  if (!superproject.ok || superproject.stdout.trim() !== '') return 'nested';
  return 'top-level';
}

export async function probeProvisioning(
  ctx: ProbeContext,
  request: ProvisionRequest,
  remainingMs: () => number
): Promise<LaneResult<ProvisionProbeResult>> {
  const git = (): GitContext => ({ git: ctx.git, cwd: ctx.workspaceRoot, timeoutMs: Math.max(remainingMs(), 1) });
  const refuse = (reason: LaneRefusalReason): LaneResult<ProvisionProbeResult> =>
    laneRefused(remainingMs() <= 0 ? 'provisioning-deadline-exceeded' : reason);

  const version = await readGitVersion(git());
  if (version === null || !meetsLaneGitFloor(version)) return refuse('git-version-unsupported');

  const topology = await topologyOf(ctx, git());
  if (topology === 'not-a-repository') return refuse('source-revision-unresolved');
  if (topology === 'nested') return refuse('nested-repository-unsupported');

  const lanesDir = path.join(ctx.storageDir, LANES_DIRECTORY);
  if ((await classifyDestination(lanesDir, [ctx.workspaceRoot])) !== 'outside') {
    return refuse('lane-root-inside-workspace');
  }

  if (!isSupportedRecipe(request.dependencyRecipe)) return refuse('dependency-recipe-unsupported');

  if (request.sourceRevision.startsWith(OPTION_PREFIX)) return refuse('source-revision-unresolved');
  const commit = await resolveCommit(git(), request.sourceRevision);
  if (commit === null) return refuse('source-revision-unresolved');

  if ((await hasGitlinks(git(), commit)) !== false) return refuse('submodules-unsupported');
  if ((await hasLfsAttributes(git(), commit)) !== false) return refuse('lfs-unsupported');

  const repositoryId = await repositoryIdOf(git());
  if (repositoryId === null) return refuse('source-revision-unresolved');

  return laneOk({ commit, repositoryId });
}
