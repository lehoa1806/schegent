/**
 * FR-R6-F10: read-only Git observations the lane modules decide on.
 *
 * Every function takes a {@link GitContext} and none changes a ref, the index or a file.
 * `status` runs with `--no-optional-locks`, so a stat-dirty file does not make Git
 * refresh and rewrite the index. A Git failure is `null`: the caller decides what an
 * unknown answer means, and no stderr text reaches it (research R5).
 */

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { GitFailureCode, LaneGitRunner } from './git-runner';

/** Bounded Git failure metadata preserved across read-only observations (never stderr). */
export interface GitRunFailure {
  readonly code: GitFailureCode;
  readonly exitCode: number | null;
}

export type GitObserveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GitRunFailure };

export type AncestryOutcome = 'ancestor' | 'not-ancestor' | 'missing-ref' | 'git-error';

export interface AncestryResult {
  readonly outcome: AncestryOutcome;
  readonly failure?: GitRunFailure;
}

/** Where and how long a read may take. */
export interface GitContext {
  readonly git: LaneGitRunner;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** The lowest Git the lane operations support (spec US2, research entry condition 3). */
export const LANE_GIT_FLOOR: Readonly<{ major: number; minor: number }> = Object.freeze({ major: 2, minor: 17 });

/** One block of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** `ls-tree -r` lists every path of a tree; this bounds a large repository's listing. */
const TREE_LISTING_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GITLINK_MODE_PREFIX = '160000 ';
const LFS_FILTER_NEEDLE = 'filter=lfs';
const ATTRIBUTES_PATHSPEC = ':(glob)**/.gitattributes';
const GIT_VERSION_PATTERN = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;
const NOT_ANCESTOR_EXIT = 1;
const MISSING_OBJECT_EXIT = 128;
const REV_PARSE_MISSING_EXIT = 1;
const GREP_NO_MATCH_EXIT = 1;

/** Parse `git --version` output; `null` when it is not one. */
export function parseGitVersion(text: string): GitVersion | null {
  const match = GIT_VERSION_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, major = '', minor = '', patch = '0'] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function meetsLaneGitFloor(version: GitVersion): boolean {
  if (version.major !== LANE_GIT_FLOOR.major) return version.major > LANE_GIT_FLOOR.major;
  return version.minor >= LANE_GIT_FLOOR.minor;
}

interface MutableEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

function newEntry(path: string): MutableEntry {
  return { path, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
}

function applyAttribute(entry: MutableEntry, line: string): void {
  const space = line.indexOf(' ');
  const key = space === -1 ? line : line.slice(0, space);
  const value = space === -1 ? '' : line.slice(space + 1);
  if (key === 'HEAD') entry.head = value;
  else if (key === 'branch') entry.branch = value;
  else if (key === 'detached') entry.detached = true;
  else if (key === 'bare') entry.bare = true;
  else if (key === 'locked') entry.locked = true;
  else if (key === 'prunable') entry.prunable = true;
}

/** Parse `git worktree list --porcelain`. Lines before the first block and unknown keys are skipped. */
export function parseWorktreeList(text: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: MutableEntry | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('worktree ')) {
      if (current !== null) entries.push({ ...current });
      current = newEntry(line.slice('worktree '.length));
    } else if (line === '') {
      if (current !== null) entries.push({ ...current });
      current = null;
    } else if (current !== null) {
      applyAttribute(current, line);
    }
  }
  if (current !== null) entries.push({ ...current });
  return entries;
}

async function runDetailed(
  ctx: GitContext,
  args: readonly string[],
  maxBuffer?: number
): Promise<GitObserveResult<string>> {
  const result = await ctx.git.run(args, {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    ...(maxBuffer === undefined ? {} : { maxBuffer })
  });
  return result.ok
    ? { ok: true, value: result.stdout }
    : { ok: false, failure: { code: result.code, exitCode: result.exitCode } };
}

async function stdoutOf(ctx: GitContext, args: readonly string[], maxBuffer?: number): Promise<string | null> {
  const result = await runDetailed(ctx, args, maxBuffer);
  return result.ok ? result.value : null;
}

export async function readGitVersion(ctx: GitContext): Promise<GitVersion | null> {
  const out = await stdoutOf(ctx, ['--version']);
  return out === null ? null : parseGitVersion(out);
}

/** `listWorktrees` preserving exact {@link GitRunFailure} (`timeout` / `buffer` / `exit` / `spawn`). */
export async function listWorktreesDetailed(ctx: GitContext): Promise<GitObserveResult<readonly WorktreeEntry[]>> {
  const result = await runDetailed(ctx, ['worktree', 'list', '--porcelain']);
  return result.ok ? { ok: true, value: parseWorktreeList(result.value) } : result;
}

export async function listWorktrees(ctx: GitContext): Promise<readonly WorktreeEntry[] | null> {
  const result = await listWorktreesDetailed(ctx);
  return result.ok ? result.value : null;
}

/** The commit `rev` names, or `null` when it names none. */
export async function resolveCommit(ctx: GitContext, rev: string): Promise<string | null> {
  const out = await stdoutOf(ctx, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const id = out === null ? '' : out.trim();
  return id === '' ? null : id;
}

/** The tree of `commit`, or `null`. */
export async function treeOf(ctx: GitContext, commit: string): Promise<string | null> {
  const out = await stdoutOf(ctx, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  const id = out === null ? '' : out.trim();
  return id === '' ? null : id;
}

/**
 * Distinguishes ancestry (`ancestor` / `not-ancestor`), an absent or GC'd commit (`missing-ref`),
 * and a Git subprocess failure (`git-error` carrying the exact `GitRunFailure`).
 */
export async function isAncestorDetailed(
  ctx: GitContext,
  ancestor: string,
  descendant: string
): Promise<AncestryResult> {
  const result = await ctx.git.run(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs
  });
  if (result.ok) return { outcome: 'ancestor' };
  if (result.code === 'exit' && result.exitCode === NOT_ANCESTOR_EXIT) return { outcome: 'not-ancestor' };
  const failure: GitRunFailure = { code: result.code, exitCode: result.exitCode };
  if (result.code === 'exit' && result.exitCode === MISSING_OBJECT_EXIT) {
    // Disambiguate an absent/GC'd commit from a general Git exit-128 error (e.g. corrupt repo or
    // injected fault): `rev-parse --verify --quiet <rev>^{commit}` exits 1 specifically when the
    // commit does not exist in a healthy repository.
    for (const rev of [ancestor, descendant]) {
      const check = await ctx.git.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs
      });
      if (!check.ok) {
        if (check.code === 'exit' && check.exitCode === REV_PARSE_MISSING_EXIT) {
          return { outcome: 'missing-ref', failure };
        }
        return { outcome: 'git-error', failure: { code: check.code, exitCode: check.exitCode } };
      }
    }
  }
  return { outcome: 'git-error', failure };
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`; `null` when Git cannot say. */
export async function isAncestor(ctx: GitContext, ancestor: string, descendant: string): Promise<boolean | null> {
  const detailed = await isAncestorDetailed(ctx, ancestor, descendant);
  if (detailed.outcome === 'ancestor') return true;
  if (detailed.outcome === 'not-ancestor') return false;
  return null;
}

/** Whether `commit`'s tree holds a gitlink (mode 160000) at any depth. */
export async function hasGitlinks(ctx: GitContext, commit: string): Promise<boolean | null> {
  const out = await stdoutOf(ctx, ['ls-tree', '-r', '--full-tree', commit], TREE_LISTING_MAX_BUFFER_BYTES);
  if (out === null) return null;
  return out.split('\n').some((line) => line.startsWith(GITLINK_MODE_PREFIX));
}

/** Whether any `.gitattributes` in `commit`'s tree routes a path through `filter=lfs`. */
export async function hasLfsAttributes(ctx: GitContext, commit: string): Promise<boolean | null> {
  const result = await ctx.git.run(['grep', '-q', '-F', LFS_FILTER_NEEDLE, commit, '--', ATTRIBUTES_PATHSPEC], {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs
  });
  if (result.ok) return true;
  return result.code === 'exit' && result.exitCode === GREP_NO_MATCH_EXIT ? false : null;
}

async function statusLineCountDetailed(
  ctx: GitContext,
  untracked: 'no' | 'all'
): Promise<GitObserveResult<number>> {
  const result = await runDetailed(ctx, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    `--untracked-files=${untracked}`
  ]);
  if (!result.ok) return result;
  return { ok: true, value: result.value.split('\n').filter((line) => line !== '').length };
}

/** Changed tracked paths in `cwd`, preserving exact `GitRunFailure` on timeout/buffer/exit/spawn. */
export function trackedDirtyCountDetailed(ctx: GitContext): Promise<GitObserveResult<number>> {
  return statusLineCountDetailed(ctx, 'no');
}

/** Changed tracked paths plus every untracked file (ignored excluded), preserving `GitRunFailure`. */
export function allDirtyCountDetailed(ctx: GitContext): Promise<GitObserveResult<number>> {
  return statusLineCountDetailed(ctx, 'all');
}

/** Changed tracked paths in the working tree at `cwd`. */
export async function trackedDirtyCount(ctx: GitContext): Promise<number | null> {
  const result = await trackedDirtyCountDetailed(ctx);
  return result.ok ? result.value : null;
}

/** Changed tracked paths plus every untracked file (ignored files excluded). */
export async function allDirtyCount(ctx: GitContext): Promise<number | null> {
  const result = await allDirtyCountDetailed(ctx);
  return result.ok ? result.value : null;
}

/** Research R8: SHA-256 hex of the real path of the shared Git directory. */
export async function repositoryIdOf(ctx: GitContext): Promise<string | null> {
  const out = await stdoutOf(ctx, ['rev-parse', '--git-common-dir']);
  const commonDir = out === null ? '' : out.trim();
  if (commonDir === '') return null;
  try {
    const real = await realpath(resolve(ctx.cwd, commonDir));
    return createHash('sha256').update(real).digest('hex');
  } catch {
    return null;
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * A worktree path compared by its real location, so a registry entry and a lane root name the same
 * directory however each was spelled. A missing leaf keeps its name under its real parent.
 */
export async function canonicalPath(target: string): Promise<string> {
  const whole = await realpathOrNull(target);
  if (whole !== null) return whole;
  const parent = await realpathOrNull(dirname(target));
  return join(parent ?? resolve(dirname(target)), basename(target));
}
