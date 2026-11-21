import { createHash } from 'node:crypto';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readBoundedRange } from '../lib/bounded-read';
import { openWithinRootByPath, segmentsUnderRoot } from '../lib/safe-open';
import { isObjectId } from './change-review/review-git';
import { createExecFileGitRunner, type LaneGitRunner } from './execution-lanes/git-runner';

const DECLARATION = '## Implementation repositories';
const LOCAL_NAME = /^(?!-)[A-Za-z0-9._/-]+$/;
const ENTRY = /^\s*[-*]\s+`([^`]+)`(?:\s+`\(base: ([^`]+)\)`)?\s*$/;
const DEFAULT_BASE = 'develop';
const EXCLUDED = ['specs', '.specify'];
const PATHS = ['.', ...EXCLUDED.map((path) => `:(exclude)${path}`)];
const MAX_AGENTS_BYTES = 1_048_576;

interface RepositoryEntry {
  readonly path: string;
  readonly base: string;
}

type UnresolvedReason = 'missing' | 'outside' | 'not-top-level' | 'no-base';
type WholeScope = 'resolved' | 'malformed' | 'conflicting' | 'no-layout' | 'blocked-by-gitlink';

export type ReviewTarget = RepositoryEntry & (
  | { readonly state: `unresolved:${UnresolvedReason}` }
  | {
      readonly state: 'resolved' | 'no-feature-changes';
      readonly cwd: string;
      readonly mergeBase: string;
      readonly changedTracked: readonly string[];
      readonly untracked: readonly string[];
      readonly excludedPaths: readonly string[];
      readonly canUseClaudeSecurityCommand: boolean;
      readonly fingerprint: string;
    }
);

interface LinkedRepository {
  readonly path: string;
  readonly container: string;
  readonly listing: 'target' | 'not-reviewed' | 'changed-not-declared' | 'blocks-inference';
}

export interface NativeReviewScope {
  readonly source: 'declaration' | 'inference' | 'none';
  readonly wholeScope: WholeScope;
  readonly targets: readonly ReviewTarget[];
  readonly gitlinks: readonly LinkedRepository[];
  readonly findings: number;
}

async function gitText(git: LaneGitRunner, cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await git.run(['--no-optional-locks', ...args], { cwd, timeoutMs: 20_000 });
  return result.ok ? result.stdout : null;
}

async function requireGitText(git: LaneGitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitText(git, cwd, args);
  if (result === null) throw new Error('Native review could not read the changes in a target repository.');
  return result;
}

async function agentsText(root: string): Promise<string> {
  const path = join(root, 'AGENTS.md');
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (before === null) return '';
  if (!before.isFile()) throw new Error('Native review needs a regular repository declaration file.');
  const opened = await openWithinRootByPath(root, path, { flags: 'r' });
  if (opened.outcome === 'refused') {
    throw new Error('Native review could not read the workspace repository declaration.');
  }
  try {
    const info = await opened.handle.stat();
    const result = await readBoundedRange(opened.handle, 0, MAX_AGENTS_BYTES + 1, MAX_AGENTS_BYTES + 1);
    if (!info.isFile() || result.bytes.length > MAX_AGENTS_BYTES) {
      throw new Error('Native review could not read the workspace repository declaration.');
    }
    return result.bytes.toString('utf8');
  } finally {
    await opened.handle.close();
  }
}

function declaredTargets(text: string): readonly RepositoryEntry[] | 'malformed' | 'conflicting' | null {
  let fence: string | undefined;
  let inSection = false;
  let sections = 0;
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
      inSection = line.trimEnd() === DECLARATION;
      if (inSection) sections += 1;
    } else if (inSection && /^\s*[-*]\s+`/.test(line)) {
      entries.push(line);
    }
  }
  if (sections === 0) return null;
  if (sections > 1) return 'conflicting';
  if (entries.length === 0) return 'malformed';
  const targets = [];
  for (const line of entries) {
    const entry = ENTRY.exec(line);
    const path = entry?.[1];
    const base = entry?.[2] ?? DEFAULT_BASE;
    if (path === undefined || !LOCAL_NAME.test(path) || !LOCAL_NAME.test(base)) return 'malformed';
    targets.push({ path, base });
  }
  return targets;
}

async function topLevel(git: LaneGitRunner, cwd: string): Promise<boolean> {
  const top = (await gitText(git, cwd, ['rev-parse', '--show-toplevel']))?.replace(/\r?\n$/, '');
  return top !== undefined && resolve(top) === cwd;
}

async function locate(root: string, path: string): Promise<string | 'outside' | 'missing'> {
  const requested = resolve(root, path);
  if (isAbsolute(path) || (requested !== root && segmentsUnderRoot(root, requested) === null)) return 'outside';
  try {
    const cwd = await realpath(requested);
    if (cwd !== root && segmentsUnderRoot(root, cwd) === null) return 'outside';
    return (await stat(cwd)).isDirectory() ? cwd : 'missing';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

async function inferPath(git: LaneGitRunner, root: string): Promise<string | null> {
  const candidate = await locate(root, 'repo');
  const specs = await lstat(join(root, 'specs')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (isAbsolute(candidate) && specs?.isDirectory() === true && await topLevel(git, candidate)) return 'repo';
  return await topLevel(git, root) ? '.' : null;
}

async function mergeBaseOf(git: LaneGitRunner, cwd: string, base: string): Promise<string | undefined> {
  const mergeBase = (await gitText(git, cwd, ['merge-base', 'HEAD', base]))?.trim();
  return isObjectId(mergeBase) ? mergeBase : undefined;
}

function nulRows(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

async function fingerprintFiles(cwd: string, base: string, staged: string, paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify([base, staged]));
  for (const path of paths) {
    const file = resolve(cwd, path);
    if (segmentsUnderRoot(cwd, file) === null) throw new Error('A review path is outside the repository.');
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return null;
    });
    hash.update(JSON.stringify([path, info?.mode, info?.size]));
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      const link = await readlink(file);
      if (segmentsUnderRoot(cwd, resolve(file, '..', link)) === null) {
        throw new Error('A review symlink points outside the repository.');
      }
      hash.update(link);
      continue;
    }
    if (!info.isFile()) throw new Error('A review path is not a regular file.');
    const opened = await openWithinRootByPath(cwd, file, { flags: 'r' });
    if (opened.outcome === 'refused') throw new Error('A review path could not be opened inside the repository.');
    try {
      const fileHash = createHash('sha256');
      for await (const bytes of opened.handle.createReadStream({ autoClose: false, start: 0, end: info.size })) {
        fileHash.update(bytes as Buffer);
      }
      hash.update(fileHash.digest());
    } finally {
      await opened.handle.close();
    }
  }
  return hash.digest('hex');
}

async function readChanges(git: LaneGitRunner, cwd: string, mergeBase: string | undefined) {
  const [committed, status, index] = await Promise.all([
    mergeBase === undefined ? '' : requireGitText(git, cwd, [
      'diff-tree', '-r', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', mergeBase, 'HEAD', '--'
    ]),
    requireGitText(git, cwd, [
      'status', '--porcelain', '--ignore-submodules=none', '--untracked-files=all', '--no-renames', '-z'
    ]),
    requireGitText(git, cwd, ['ls-files', '--stage', '-z'])
  ]);
  const rows = nulRows(status);
  const tracked = new Set([...nulRows(committed), ...rows.filter((row) => !row.startsWith('?? ')).map((row) => row.slice(3))]);
  const untracked = rows.filter((row) => row.startsWith('?? ')).map((row) => row.slice(3));
  const gitlinks = nulRows(index).filter((row) => row.startsWith('160000 ')).map((row) => row.slice(row.indexOf('\t') + 1));
  return { tracked, untracked, gitlinks, clean: rows.length === 0 };
}

function isIncluded(path: string, exclusions: readonly string[]): boolean {
  return !exclusions.some((root) => path === root || path.startsWith(`${root}/`));
}

async function readTarget(
  git: LaneGitRunner,
  cwd: string,
  entry: RepositoryEntry,
  mergeBase: string,
  changes: Awaited<ReturnType<typeof readChanges>>
): Promise<ReviewTarget> {
  const [staged, origin] = await Promise.all([
    requireGitText(git, cwd, ['diff-index', '--cached', '--no-renames', '--ignore-submodules=all', '--raw', '-z', mergeBase, '--', ...PATHS]),
    gitText(git, cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  ]);
  const excludedPaths = [...EXCLUDED, ...changes.gitlinks, ...changes.untracked
    .filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1))];
  const changedTracked = [...changes.tracked].filter((path) => isIncluded(path, excludedPaths)).sort();
  const untracked = changes.untracked.filter((path) => isIncluded(path, excludedPaths)).sort();
  const originRef = origin?.trim();
  const originHead = originRef?.startsWith('refs/remotes/origin/') === true
    ? (await gitText(git, cwd, ['rev-parse', '--verify', `${originRef}^{commit}`]))?.trim()
    : undefined;
  return {
    ...entry, cwd, mergeBase, changedTracked, untracked, excludedPaths,
    state: changedTracked.length + untracked.length > 0 ? 'resolved' : 'no-feature-changes',
    canUseClaudeSecurityCommand: originHead === mergeBase && changes.clean &&
      changedTracked.length === changes.tracked.size,
    fingerprint: await fingerprintFiles(cwd, mergeBase, staged, [...new Set([...changedTracked, ...untracked])])
  };
}

export async function readNativeReviewScope(
  rootPath: string,
  git: LaneGitRunner = createExecFileGitRunner()
): Promise<NativeReviewScope> {
  const root = await realpath(rootPath);
  const declared = declaredTargets(await agentsText(root));
  const source = declared === null ? 'inference' : 'declaration';
  const failed = (wholeScope: WholeScope): NativeReviewScope => ({
    source, wholeScope, targets: [], gitlinks: [], findings: 1
  });
  if (typeof declared === 'string') return failed(declared);
  const inferred = declared === null ? await inferPath(git, root) : null;
  if (declared === null && inferred === null) return { ...failed('no-layout'), source: 'none' };

  const entries = declared ?? [{ path: inferred!, base: DEFAULT_BASE }];
  const locations = await Promise.all(entries.map(({ path }) => locate(root, path)));
  const directories = locations.filter((cwd) => isAbsolute(cwd));
  if (new Set(directories).size !== directories.length) return failed('conflicting');

  const targets: ReviewTarget[] = [];
  const gitlinks: LinkedRepository[] = [];
  function recordGitlinks(cwd: string, container: string, changes: Awaited<ReturnType<typeof readChanges>>): void {
    for (const path of changes.gitlinks) {
      const listing = directories.includes(resolve(cwd, path)) ? 'target'
        : !changes.tracked.has(path) ? 'not-reviewed'
        : declared === null ? 'blocks-inference' : 'changed-not-declared';
      gitlinks.push({ path, container, listing });
    }
  }
  for (const [index, entry] of entries.entries()) {
    const cwd = locations[index]!;
    if (cwd === 'outside' || cwd === 'missing') targets.push({ ...entry, state: `unresolved:${cwd}` });
    else if (!await topLevel(git, cwd)) targets.push({ ...entry, state: 'unresolved:not-top-level' });
    else {
      const mergeBase = await mergeBaseOf(git, cwd, entry.base);
      if (mergeBase === undefined) targets.push({ ...entry, state: 'unresolved:no-base' });
      else {
        const changes = await readChanges(git, cwd, mergeBase);
        recordGitlinks(cwd, entry.path, changes);
        targets.push(await readTarget(git, cwd, entry, mergeBase, changes));
      }
    }
  }
  if (!directories.includes(root) && await topLevel(git, root)) {
    recordGitlinks(root, '.', await readChanges(git, root, await mergeBaseOf(git, root, DEFAULT_BASE)));
  }
  const blocked = gitlinks.filter(({ listing }) => listing === 'blocks-inference').length;
  if (blocked > 0) return { ...failed('blocked-by-gitlink'), gitlinks, findings: blocked };
  return { source, wholeScope: 'resolved', targets, gitlinks, findings: targets.filter(({ state }) => state.startsWith('unresolved:')).length };
}
