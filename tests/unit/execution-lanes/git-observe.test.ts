// FR-R6-F10 T009 — read-only Git observations the lane modules decide on.
//
// WHAT THIS PINS:
//   - the version parser and the 2.17 floor;
//   - the `worktree list --porcelain` parser, every line kind the registry prints;
//   - commit, ancestry and tree reads against a real fixture repository;
//   - gitlinks and LFS routing judged from a commit's tree, not from the working tree;
//   - tracked-only and all-files dirty counts;
//   - the repository identity, equal from the checkout and from a linked worktree;
//   - no observation writes the index, even when a file is stat-dirty.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecFileGitRunner } from '../../../src/services/execution-lanes/git-runner';
import {
  LANE_GIT_FLOOR,
  allDirtyCount,
  hasGitlinks,
  hasLfsAttributes,
  isAncestor,
  listWorktrees,
  meetsLaneGitFloor,
  parseGitVersion,
  parseWorktreeList,
  readGitVersion,
  repositoryIdOf,
  resolveCommit,
  trackedDirtyCount,
  treeOf,
  type GitContext
} from '../../../src/services/execution-lanes/git-observe';
import { createFixtureRepo, type FixtureRepo } from './fixture-repo';

const TIMEOUT_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;
const STAT_AHEAD_MS = 10_000;

const fixtures: FixtureRepo[] = [];

function fixture(label: string): FixtureRepo {
  const repo = createFixtureRepo(label);
  fixtures.push(repo);
  return repo;
}

function ctx(cwd: string): GitContext {
  return { git: createExecFileGitRunner(), cwd, timeoutMs: TIMEOUT_MS };
}

afterEach(() => {
  for (const repo of fixtures.splice(0, fixtures.length)) repo.dispose();
});

describe('FR-R6-F10 parseGitVersion and the 2.17 floor', () => {
  it('parses release, vendor and old versions, and refuses garbage', () => {
    expect(parseGitVersion('git version 2.54.0\n')).toEqual({ major: 2, minor: 54, patch: 0 });
    expect(parseGitVersion('git version 2.17.0.windows.1')).toEqual({ major: 2, minor: 17, patch: 0 });
    expect(parseGitVersion('git version 2.16.6')).toEqual({ major: 2, minor: 16, patch: 6 });
    expect(parseGitVersion('git version 3.0')).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseGitVersion('not git at all')).toBeNull();
    expect(parseGitVersion('')).toBeNull();
  });

  it('holds the floor at 2.17', () => {
    expect(LANE_GIT_FLOOR).toEqual({ major: 2, minor: 17 });
    expect(meetsLaneGitFloor({ major: 2, minor: 17, patch: 0 })).toBe(true);
    expect(meetsLaneGitFloor({ major: 2, minor: 54, patch: 0 })).toBe(true);
    expect(meetsLaneGitFloor({ major: 3, minor: 0, patch: 0 })).toBe(true);
    expect(meetsLaneGitFloor({ major: 2, minor: 16, patch: 6 })).toBe(false);
    expect(meetsLaneGitFloor({ major: 1, minor: 99, patch: 0 })).toBe(false);
  });

  it('reads the installed Git, which meets the floor', async () => {
    const version = await readGitVersion(ctx(process.cwd()));
    expect(version).not.toBeNull();
    if (version !== null) expect(meetsLaneGitFloor(version)).toBe(true);
  });
});

describe('FR-R6-F10 parseWorktreeList', () => {
  const MAIN = 'a'.repeat(40);
  const LANE = 'b'.repeat(40);

  it('reads branch, detached, locked, prunable and bare blocks', () => {
    const text = [
      'worktree /work/main',
      `HEAD ${MAIN}`,
      'branch refs/heads/main',
      '',
      'worktree /store/lanes/ws/lane-1',
      `HEAD ${LANE}`,
      'detached',
      'locked',
      '',
      'worktree /store/lanes/ws/lane-2',
      `HEAD ${LANE}`,
      'detached',
      'locked held by operator',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /bare.git',
      'bare',
      ''
    ].join('\n');
    expect(parseWorktreeList(text)).toEqual([
      { path: '/work/main', head: MAIN, branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/store/lanes/ws/lane-1', head: LANE, branch: null, detached: true, bare: false, locked: true, prunable: false },
      { path: '/store/lanes/ws/lane-2', head: LANE, branch: null, detached: true, bare: false, locked: true, prunable: true },
      { path: '/bare.git', head: null, branch: null, detached: false, bare: true, locked: false, prunable: false }
    ]);
  });

  it('accepts CRLF line ends, a missing trailing blank line and empty input', () => {
    const text = `worktree C:/work/main\r\nHEAD ${MAIN}\r\nbranch refs/heads/main`;
    expect(parseWorktreeList(text)).toEqual([
      { path: 'C:/work/main', head: MAIN, branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false }
    ]);
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('ignores lines before the first worktree line and unknown attributes', () => {
    const text = ['HEAD stray', 'worktree /w', `HEAD ${MAIN}`, 'future-attribute x', 'detached', ''].join('\n');
    expect(parseWorktreeList(text)).toEqual([
      { path: '/w', head: MAIN, branch: null, detached: true, bare: false, locked: false, prunable: false }
    ]);
  });
});

describe('FR-R6-F10 commit, ancestry and tree reads', () => {
  it('resolves commits and refuses what is not one', async () => {
    const repo = fixture('resolve');
    const first = repo.head();
    const c = ctx(repo.root);
    expect(await resolveCommit(c, 'HEAD')).toBe(first);
    expect(await resolveCommit(c, 'refs/heads/main')).toBe(first);
    expect(await resolveCommit(c, 'refs/heads/no-such-branch')).toBeNull();
    const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim();
    expect(await resolveCommit(c, tree)).toBeNull();
  });

  it('answers ancestry both ways and null for an unknown commit', async () => {
    const repo = fixture('ancestry');
    const first = repo.head();
    repo.write('src/a.txt', 'one\n');
    const second = repo.commit('second');
    const c = ctx(repo.root);
    expect(await isAncestor(c, first, second)).toBe(true);
    expect(await isAncestor(c, second, first)).toBe(false);
    expect(await isAncestor(c, first, first)).toBe(true);
    expect(await isAncestor(c, 'c'.repeat(40), second)).toBeNull();
  });

  it('reads the tree of a commit', async () => {
    const repo = fixture('tree');
    const c = ctx(repo.root);
    expect(await treeOf(c, repo.head())).toBe(repo.git(['rev-parse', 'HEAD^{tree}']).trim());
    expect(await treeOf(c, 'd'.repeat(40))).toBeNull();
  });
});

describe('FR-R6-F10 gitlinks and LFS are judged from the commit', () => {
  it('finds a gitlink only once one is committed', async () => {
    const repo = fixture('gitlink');
    const c = ctx(repo.root);
    const before = repo.head();
    expect(await hasGitlinks(c, before)).toBe(false);
    const after = repo.addGitlink('vendor/lib', before);
    expect(await hasGitlinks(c, after)).toBe(true);
    expect(await hasGitlinks(c, before)).toBe(false);
  });

  it('finds an LFS filter in a nested .gitattributes, and ignores an uncommitted one', async () => {
    const repo = fixture('lfs');
    const c = ctx(repo.root);
    repo.write('.gitattributes', '*.txt text eol=lf\n');
    const plain = repo.commit('attributes');
    expect(await hasLfsAttributes(c, plain)).toBe(false);

    repo.write('assets/.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    expect(await hasLfsAttributes(c, plain)).toBe(false);
    const routed = repo.commit('lfs');
    expect(await hasLfsAttributes(c, routed)).toBe(true);
  });

  it('finds an LFS filter in the root .gitattributes', async () => {
    const repo = fixture('lfs-root');
    repo.write('.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    const routed = repo.commit('lfs');
    expect(await hasLfsAttributes(ctx(repo.root), routed)).toBe(true);
  });

  it.each(['GIT_LITERAL_PATHSPECS', 'GIT_NOGLOB_PATHSPECS'])(
    'still finds a nested LFS filter when the host environment sets %s (review S5)',
    async (name) => {
      const repo = fixture('lfs-env');
      repo.write('assets/.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      const routed = repo.commit('lfs');
      const git = createExecFileGitRunner({ baseEnv: { ...process.env, [name]: '1' } });
      expect(await hasLfsAttributes({ git, cwd: repo.root, timeoutMs: TIMEOUT_MS }, routed)).toBe(true);
    }
  );
});

describe('FR-R6-F10 dirty counts', () => {
  it('counts tracked changes apart from untracked files', async () => {
    const repo = fixture('dirty');
    const c = ctx(repo.root);
    expect(await trackedDirtyCount(c)).toBe(0);
    expect(await allDirtyCount(c)).toBe(0);
    repo.write('README.md', 'changed\n');
    repo.write('notes/new.txt', 'new\n');
    expect(await trackedDirtyCount(c)).toBe(1);
    expect(await allDirtyCount(c)).toBe(2);
  });

  it('never writes the index, even for a stat-dirty file', async () => {
    const repo = fixture('no-write');
    const c = ctx(repo.root);
    const future = new Date(Date.now() + STAT_AHEAD_MS);
    utimesSync(join(repo.root, 'README.md'), future, future);
    const indexPath = join(repo.root, '.git', 'index');
    const before = readFileSync(indexPath);
    expect(await trackedDirtyCount(c)).toBe(0);
    expect(await allDirtyCount(c)).toBe(0);
    expect(await hasGitlinks(c, repo.head())).toBe(false);
    expect(await hasLfsAttributes(c, repo.head())).toBe(false);
    expect(readFileSync(indexPath).equals(before)).toBe(true);
  });
});

describe('FR-R6-F10 repository identity and the worktree registry', () => {
  it('hashes the common-dir real path, equal from the checkout and from a lane', async () => {
    const repo = fixture('identity');
    const laneRoot = join(repo.sibling('lanes'), 'lane-1');
    repo.git(['worktree', 'add', '--detach', laneRoot, 'HEAD']);

    const fromCheckout = await repositoryIdOf(ctx(repo.root));
    const fromLane = await repositoryIdOf(ctx(laneRoot));
    const expected = createHash('sha256')
      .update(realpathSync(resolve(repo.root, '.git')))
      .digest('hex');
    expect(fromCheckout).toMatch(HEX64);
    expect(fromCheckout).toBe(expected);
    expect(fromLane).toBe(expected);
  });

  it('lists the checkout and a detached lane', async () => {
    const repo = fixture('registry');
    const laneRoot = join(repo.sibling('lanes'), 'lane-1');
    repo.git(['worktree', 'add', '--detach', laneRoot, 'HEAD']);
    const entries = await listWorktrees(ctx(repo.root));
    expect(entries).not.toBeNull();
    expect((entries ?? []).map((entry) => [entry.path, entry.branch, entry.detached])).toEqual([
      [repo.root, 'refs/heads/main', false],
      [realpathSync(laneRoot), null, true]
    ]);
  });

  it('returns null outside a repository', async () => {
    const repo = fixture('outside');
    const outside = repo.sibling('plain');
    expect(await repositoryIdOf(ctx(outside))).toBeNull();
    expect(await listWorktrees(ctx(outside))).toBeNull();
  });
});
