// FR-R4-F18 (feature 246, T009; contract F2 preamble, F3.1, F3.2; research R9, R15) — the
// primitives the review scope fixtures are built from.
//
// Each fixture workspace is made fresh under the vitest temp root, offline: `git init`, commits,
// and gitlinks pinned with `update-index --cacheinfo`, which needs no clone and no `.gitmodules`.
// This module holds what every row shares: the roots, the repositories, the files, the gitlinks,
// the stat-dirty seed and the read-only snapshot. The rows themselves (W1 to W7, R1 to R8, E1 to E5)
// are added beside it by the tasks of each user story.
//
// Git is spawned with `execFileSync` and no shell. Commits pass their own identity and touch no
// global configuration; the temp root's `maintenance.auto=false` and `GIT_CEILING_DIRECTORIES`
// (`tests/global-temp-root.ts`) stay in force.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** A built fixture: its root, and every repository the row made, inside the root or outside it. */
export interface Workspace {
  readonly root: string;
  /** Every repository the row builds. The read-only snapshot compares each of them. */
  readonly repositories: readonly string[];
}

/** One repository's state, read without writing anything (F3.2). */
export interface RepositorySnapshot {
  readonly status: string;
  readonly head: string;
  readonly symbolicRef: string;
  readonly refs: string;
  readonly indexSha256: string;
}

export type Snapshot = Readonly<Record<string, RepositorySnapshot>>;

/** The base branch every fixture repository starts on, and the branch left checked out. */
const DEFAULT_BASE = 'develop';
const FEATURE_BRANCH = 'feature';
const GITLINK_MODE = '160000';
/** F3.1: ahead of the index's own time, so a command that refreshes the index would rewrite it. */
const STAT_DIRTY_AHEAD_MS = 10_000;

/** Commits carry their own identity and run no hook; nothing global is read or written. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=Schegent Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null'
] as const;

/** Runs `git` in `dir` and returns its stdout. A nonzero exit throws. */
export function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...COMMIT_CONFIG, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** A fresh directory under the vitest temp root, as a real path (the root sits inside `repo/`). */
export function makeRoot(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `schegent-246-${label}-`)));
}

/** `git init` on `base`, one commit, then `feature` checked out. */
export function initRepo(dir: string, options: { readonly base?: string } = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', options.base ?? DEFAULT_BASE]);
  commitFile(dir, 'README.md', 'fixture\n');
  git(dir, ['switch', '-q', '-c', FEATURE_BRANCH]);
}

/** Writes an untracked file, making its directories. */
export function writeFile(dir: string, rel: string, text: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Writes a file and commits it. */
export function commitFile(dir: string, rel: string, text: string): void {
  writeFile(dir, rel, text);
  git(dir, ['add', '--', rel]);
  git(dir, ['commit', '-q', '-m', `add ${rel}`]);
}

/** The commit a repository's `HEAD` names. */
export function headOf(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Moves the base branch to the current commit, so everything committed so far is the base. A
 * fixture builds what the base already holds on `feature`, settles it, then commits the feature's
 * own changes; no branch is switched, which would otherwise try to remove a gitlink's directory.
 */
export function settleBase(dir: string, base: string = DEFAULT_BASE): void {
  git(dir, ['branch', '-f', base, 'HEAD']);
}

/** Records `rel` in `container` as a gitlink at `sha`, and commits it. */
export function addGitlink(container: string, rel: string, sha: string): void {
  git(container, ['update-index', '--add', '--cacheinfo', `${GITLINK_MODE},${sha},${rel}`]);
  git(container, ['commit', '-q', '-m', `pin ${rel}`]);
}

/** Writes `<root>/AGENTS.md` exactly as given. */
export function writeAgentsMd(root: string, lines: readonly string[]): void {
  writeFileSync(join(root, 'AGENTS.md'), `${lines.join('\n')}\n`);
}

/** F3.1: gives one tracked file an mtime ahead of the index, its content unchanged. */
export function seedStatDirty(repoDir: string): void {
  const tracked = git(repoDir, ['ls-files']).split('\n').find((line) => line !== '');
  if (tracked === undefined) return;
  const ahead = new Date(Date.now() + STAT_DIRTY_AHEAD_MS);
  utimesSync(join(repoDir, tracked), ahead, ahead);
}

/** One snapshot command; `allowFailure` records a nonzero exit as empty output. */
function read(dir: string, args: readonly string[], allowFailure = false): string {
  try {
    return git(dir, args);
  } catch (error) {
    if (allowFailure && typeof (error as { status?: unknown }).status === 'number') return '';
    throw error;
  }
}

/** F3.2: the state of every repository, taken with commands that write nothing. */
export function snapshot(repositories: readonly string[]): Snapshot {
  const taken: Record<string, RepositorySnapshot> = {};
  for (const dir of repositories) {
    const indexPath = resolve(dir, read(dir, ['rev-parse', '--git-path', 'index']).trim());
    taken[dir] = {
      status: read(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all']),
      head: read(dir, ['rev-parse', 'HEAD']),
      symbolicRef: read(dir, ['symbolic-ref', '-q', 'HEAD'], true),
      refs: read(dir, ['for-each-ref']),
      indexSha256: createHash('sha256').update(readFileSync(indexPath)).digest('hex')
    };
  }
  return taken;
}

// Rows W5 to W7 (contract F2; US1): the feature code lives in linked repositories, and the root
// holds planning files only.

/** The declaration of a planning root, as an owner writes it: one prose line, then the entries. */
function declare(root: string, entries: readonly string[]): void {
  writeAgentsMd(root, [
    '# Workspace',
    '',
    '## Implementation repositories',
    '',
    'The feature code lives in these linked repositories.',
    ...entries.map((entry) => `- \`${entry}\``)
  ]);
}

interface DeclaredOptions {
  /** Whether `beta` has a change after its first commit. */
  readonly betaChanged: boolean;
  /** An undeclared gitlink `gamma`, pinned on `develop`, whose only change is an untracked file. */
  readonly gamma: boolean;
  /** The declared entries; `alpha` and `beta` when absent. */
  readonly entries?: readonly string[];
}

/** A root with `specs/` changes only, and nested repositories `alpha` and `beta` pinned as gitlinks. */
function buildDeclared(label: string, options: DeclaredOptions): Workspace {
  const root = makeRoot(label);
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  const gamma = join(root, 'gamma');
  const nested = options.gamma ? [alpha, beta, gamma] : [alpha, beta];

  // Everything `develop` already holds is committed on `feature` first, then settled as the base.
  initRepo(root);
  commitFile(root, 'specs/README.md', 'specs\n');
  for (const dir of nested) {
    initRepo(dir);
    addGitlink(root, relative(root, dir), headOf(dir));
  }
  settleBase(root);

  // The feature's own changes: planning files in the root, source in the nested repositories.
  commitFile(root, 'specs/feature.md', 'a change to the plan\n');
  commitFile(alpha, 'src/alpha.ts', 'export const alpha = 1;\n');
  if (options.betaChanged) commitFile(beta, 'src/beta.ts', 'export const beta = 1;\n');
  if (options.gamma) {
    writeFile(gamma, 'scratch.txt', 'untracked\n');
    // F2 W7: with this set in the root, only the explicit flag shows the change (contract P2, B3).
    git(root, ['config', 'diff.ignoreSubmodules', 'all']);
    if (git(root, ['config', 'diff.ignoreSubmodules']).trim() !== 'all') {
      throw new Error(`${label}: diff.ignoreSubmodules is not set in the root`);
    }
  }

  declare(root, options.entries ?? ['alpha', 'beta']);
  return { root, repositories: [root, ...nested] };
}

/** W5: both declared repositories changed, and the root's only change is in `specs/`. */
export function buildW5(): Workspace {
  return buildDeclared('w5', { betaChanged: true, gamma: false });
}

/** W6: as W5, but `beta` has no change after its first commit. */
export function buildW6(): Workspace {
  return buildDeclared('w6', { betaChanged: false, gamma: false });
}

/** W7: as W5, plus an undeclared gitlink `gamma` with one untracked file, and the root's config. */
export function buildW7(): Workspace {
  return buildDeclared('w7', { betaChanged: true, gamma: true });
}

// Rows W1 to W4 (contract F2; US2): the layouts the Phases supported before the declaration, and
// that must still resolve to the same single target.

/** W1: a standalone repository, one committed change and one untracked source file. */
export function buildW1(): Workspace {
  const root = makeRoot('w1');
  initRepo(root);
  commitFile(root, 'src/a.ts', 'export const a = 1;\n');
  settleBase(root);
  commitFile(root, 'src/a.ts', 'export const a = 2;\n');
  writeFile(root, 'src/new.ts', 'export const added = true;\n');
  return { root, repositories: [root] };
}

/** The planning root of the envelope layout: `specs/` committed, and `repo/` ignored. */
function buildEnvelopeRoot(label: string): string {
  const root = makeRoot(label);
  initRepo(root);
  commitFile(root, 'specs/README.md', 'specs\n');
  commitFile(root, '.gitignore', '/repo/\n');
  return root;
}

/** Spec Kit files inside the code repository, untracked: the exclusion must keep them out. */
function writeSpecKitFiles(repoDir: string): void {
  writeFile(repoDir, 'specs/x.md', 'a plan\n');
  writeFile(repoDir, '.specify/y.md', 'a template\n');
}

/** W2: the envelope: a planning root holding `specs/`, and `repo/` its own repository. */
export function buildW2(): Workspace {
  const root = buildEnvelopeRoot('w2');
  const repoDir = join(root, 'repo');
  initRepo(repoDir);
  commitFile(repoDir, 'src/b.ts', 'export const b = 1;\n');
  writeSpecKitFiles(repoDir);
  return { root, repositories: [root, repoDir] };
}

/**
 * W3: as W2, but `repo/` is a linked worktree, so its `.git` is a file. `git worktree add` runs
 * only on this row's own throwaway repository, which sits beside the root under the temp root
 * (tasks TA7, `docs/hard-rules.md`, `git worktree`); the builder checks that before the command.
 */
export function buildW3(): Workspace {
  const root = buildEnvelopeRoot('w3');
  const main = makeRoot('w3-main');
  if (!realpathSync(main).startsWith(realpathSync(tmpdir()))) {
    throw new Error('w3: the main repository is not under the temp root; refusing `git worktree add`');
  }
  initRepo(main);
  commitFile(main, 'src/b.ts', 'export const b = 1;\n');
  // `initRepo` leaves `feature` checked out, and Git refuses a worktree for a checked-out branch.
  git(main, ['switch', '-q', DEFAULT_BASE]);
  const repoDir = join(root, 'repo');
  git(main, ['worktree', 'add', '-q', repoDir, FEATURE_BRANCH]);
  writeSpecKitFiles(repoDir);
  return { root, repositories: [root, main, repoDir] };
}

/** W4: a standalone repository with a gitlinked `vendor/lib`, its checkout at the recorded commit. */
export function buildW4(): Workspace {
  const root = makeRoot('w4');
  const lib = join(root, 'vendor', 'lib');
  initRepo(root);
  initRepo(lib);
  addGitlink(root, 'vendor/lib', headOf(lib));
  settleBase(root);
  commitFile(root, 'src/c.ts', 'export const c = 1;\n');
  return { root, repositories: [root, lib] };
}

// Rows R1 to R8 and E1 to E5 (contract F2; US3): the refusals. Each builds a workspace the block
// must report as unresolved, in whole or for one target, and never review a substitute for.

/** The character set a declared path may use (contract A2.3); a builder refuses a path outside it. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** A repository beside `root`, outside it, with one committed source change. */
function buildOutsideRepo(label: string): string {
  const outside = makeRoot(label);
  initRepo(outside);
  commitFile(outside, 'src/out.ts', 'export const out = 1;\n');
  return outside;
}

/** A bare root holding only a declaration. It is not a repository. */
function buildDeclaringRoot(label: string, entries: readonly string[]): string {
  const root = makeRoot(label);
  declare(root, entries);
  return root;
}

/** R1: declares `missing`, which does not exist, beside a valid `alpha`. */
export function buildR1(): Workspace {
  return buildDeclared('r1', { betaChanged: false, gamma: false, entries: ['missing', 'alpha'] });
}

/** R2: declares an existing repository outside the root by its absolute path. */
export function buildR2(): Workspace {
  const outside = buildOutsideRepo('r2-outside');
  if (!SAFE_PATH.test(outside)) throw new Error(`r2: ${outside} is outside the declaration's character set`);
  return { root: buildDeclaringRoot('r2', [outside]), repositories: [outside] };
}

/** R3: declares `link`, a symlink inside the root to a repository outside it. */
export function buildR3(): Workspace {
  const outside = buildOutsideRepo('r3-outside');
  const root = buildDeclaringRoot('r3', ['link']);
  symlinkSync(outside, join(root, 'link'));
  return { root, repositories: [outside] };
}

/** R4: declares `alpha/src`, a plain directory inside a repository. */
export function buildR4(): Workspace {
  return buildDeclared('r4', { betaChanged: false, gamma: false, entries: ['alpha/src'] });
}

/** R5: declares `alpha`, which has no local `develop` while `origin/develop` exists as a ref. */
export function buildR5(): Workspace {
  const root = buildDeclaringRoot('r5', ['alpha']);
  const alpha = join(root, 'alpha');
  initRepo(alpha, { base: 'main' });
  commitFile(alpha, 'src/alpha.ts', 'export const alpha = 1;\n');
  git(alpha, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  return { root, repositories: [alpha] };
}

/** R6: declares `repo` and `./repo` with another base: two entries at one location. */
export function buildR6(): Workspace {
  const root = makeRoot('r6');
  const repoDir = join(root, 'repo');
  initRepo(repoDir);
  commitFile(repoDir, 'src/r.ts', 'export const r = 1;\n');
  writeAgentsMd(root, ['## Implementation repositories', '', '- `repo`', '- `./repo` `(base: main)`']);
  return { root, repositories: [repoDir] };
}

/** R7: a declaration whose only entry has a space in its path. */
export function buildR7(): Workspace {
  const root = makeRoot('r7');
  writeAgentsMd(root, ['## Implementation repositories', '', '- `my repo`']);
  return { root, repositories: [] };
}

/** R8: no declaration; a standalone root whose gitlink `vendor/lib` has a commit beyond its pointer. */
export function buildR8(): Workspace {
  const root = makeRoot('r8');
  const lib = join(root, 'vendor', 'lib');
  initRepo(root);
  initRepo(lib);
  addGitlink(root, 'vendor/lib', headOf(lib));
  settleBase(root);
  commitFile(root, 'src/r8.ts', 'export const r8 = 1;\n');
  commitFile(lib, 'src/lib.ts', 'export const lib = 1;\n');
  return { root, repositories: [root, lib] };
}

/** E1: declares `broken`, whose `.git` file points at a directory that does not exist. */
export function buildE1(): Workspace {
  const root = buildDeclaringRoot('e1', ['broken']);
  writeFile(root, 'broken/.git', `gitdir: ${root}/nowhere\n`);
  return { root, repositories: [] };
}

/** E2: no declaration; a standalone repository with `main` and no `develop`. */
export function buildE2(): Workspace {
  const root = makeRoot('e2');
  initRepo(root, { base: 'main' });
  commitFile(root, 'src/e2.ts', 'export const e2 = 1;\n');
  return { root, repositories: [root] };
}

/** E3: declares `../sibling`, an existing repository beside the root. */
export function buildE3(): Workspace {
  const root = makeRoot('e3');
  const siblingName = `${basename(root)}-sibling`;
  const sibling = join(dirname(root), siblingName);
  initRepo(sibling);
  commitFile(sibling, 'src/sibling.ts', 'export const sibling = 1;\n');
  declare(root, [`../${siblingName}`]);
  return { root, repositories: [sibling] };
}

/**
 * E4: no declaration; a standalone root whose gitlink `vendor/lib` had its pointer moved in a commit
 * on `feature`, the checkout at the new pointer and clean. The committed listing alone shows it,
 * and only because of its explicit flag: the root sets `diff.ignoreSubmodules=all` (contract P2).
 */
export function buildE4(): Workspace {
  const root = makeRoot('e4');
  const lib = join(root, 'vendor', 'lib');
  initRepo(root);
  initRepo(lib);
  addGitlink(root, 'vendor/lib', headOf(lib));
  settleBase(root);
  commitFile(lib, 'src/lib.ts', 'export const lib = 1;\n');
  addGitlink(root, 'vendor/lib', headOf(lib));
  git(root, ['config', 'diff.ignoreSubmodules', 'all']);
  if (git(root, ['config', 'diff.ignoreSubmodules']).trim() !== 'all') {
    throw new Error('e4: diff.ignoreSubmodules is not set in the root');
  }
  return { root, repositories: [root, lib] };
}

/** E5: no declaration; a root that is not a repository and holds no `repo/`. */
export function buildE5(): Workspace {
  return { root: makeRoot('e5'), repositories: [] };
}
