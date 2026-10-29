// FR-R4-F18 (feature 246, T008; contract F1; research R8; data-model "Resolution flow") — the
// review scope block of the shipped instruction, run against a fixture workspace.
//
// `speckit-code-review` and `speckit-security-review` carry a `Scope:` block that tells the agent
// how to work out which repositories to review. The block is prose, so a test of it has two parts:
//
//   - What it says to run. Every command in the block is an inline-code span that starts with
//     `git ` or `cd `. They are taken from the instruction text handed in, split on single spaces,
//     filled in at their placeholders and run with `execFileSync`, never through a shell. No
//     command is typed in this file, so change a flag in the YAML and the fixtures run the changed
//     command; the behavioral controls in `review-scope-fixtures.test.ts` rely on that.
//   - What it says to decide. The grammar of the declaration, the order of the per-target checks,
//     the file and gitlink rules and the Spec Kit exclusion are the test's own reading of the
//     prose (contract A, contract I1). Each decision names its clause, and a pin in
//     `speckit-review-scope-authority.test.ts` ties the clause to the text.
//
// The harness reads nothing else: no CLAUDE.md, no plan, no memory. It never returns a target the
// declaration did not name (SC-003).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export type SourceKind = 'declaration' | 'inference' | 'none';
export type WholeScope = 'resolved' | 'malformed' | 'conflicting' | 'no-layout' | 'blocked-by-gitlink';
export type UnresolvedReason = 'missing' | 'outside' | 'not-top-level' | 'no-base';
export type TargetState = 'resolved' | 'no-feature-changes' | `unresolved:${UnresolvedReason}`;
export type GitlinkListing = 'target' | 'not-reviewed' | 'changed-not-declared' | 'blocks-inference';

export interface ScopeTarget {
  readonly path: string;
  readonly base: string;
  readonly mergeBase: string | null;
  readonly state: TargetState;
  readonly changedTracked: readonly string[];
  readonly untracked: readonly string[];
}

export interface ScopeGitlink {
  /** Relative to its container. */
  readonly path: string;
  /** `.` for the workspace root, otherwise a target's path. */
  readonly container: string;
  readonly listing: GitlinkListing;
}

/** One command the harness ran: the argv log the fixtures read to show where it did not go. */
export interface CommandRun {
  readonly file: 'git' | 'pwd';
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface ScopeResolution {
  readonly source: SourceKind;
  readonly wholeScope: WholeScope;
  readonly targets: readonly ScopeTarget[];
  readonly gitlinks: readonly ScopeGitlink[];
  /** The count of unresolved conditions (D5, FR-017). */
  readonly findings: number;
  readonly log: readonly CommandRun[];
}

/** F1.2: each key must occur in exactly one command of the block, checked in this order. */
const COMMAND_KEYS = {
  containment: 'pwd -P',
  topLevel: 'rev-parse --show-prefix',
  base: 'merge-base HEAD',
  committed: 'diff --name-only',
  status: 'status --porcelain',
  reading: 'diff-index -p',
  gitlinks: 'ls-files --stage'
} as const;

type CommandName = keyof typeof COMMAND_KEYS;
type PreparedCommands = Readonly<Record<CommandName, readonly string[]>>;

/** F1.3: longest first, so the compound word is removed before the words inside it. */
const PLACEHOLDERS = ['<root>/<path>', '<merge-base>', '<root>', '<path>', '<base>'] as const;
const SHELL_METACHARACTERS = /[$`;|<>'"&]/;
const CD_CHAIN_WORD = '&&';

const DECLARATION_FILE = 'AGENTS.md';
const SECTION_HEADING = '## Implementation repositories';
const HEADING_LINE = /^ {0,3}#{1,6}(\s|$)/;
const FENCE_LINE = /^ {0,3}(```|~~~)/;
const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const ENTRY_FORM = /^`([^`]*)`(?: `\(base: ([^`)]*)\)`)?$/;
const SAFE_VALUE = /^[A-Za-z0-9._/-]+$/;
const DEFAULT_BASE = 'develop';
const ROOT_PATH = '.';
const GITLINK_MODE = '160000';
const UNTRACKED_CODE = '??';
const SPEC_KIT_PREFIXES = ['specs/', '.specify/'] as const;

interface Entry {
  readonly path: string;
  readonly base: string;
}

type Declaration =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'conflicting' }
  | { readonly kind: 'valid'; readonly entries: readonly Entry[] };

interface Context {
  readonly root: string;
  readonly commands: PreparedCommands;
  readonly source: 'declaration' | 'inference';
  readonly log: CommandRun[];
}

interface Values {
  readonly path?: string;
  readonly base?: string;
  readonly mergeBase?: string;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

interface Scan {
  readonly committed: readonly string[];
  readonly status: ReadonlyArray<{ readonly code: string; readonly path: string }>;
}

interface Placement {
  readonly failure: 'missing' | 'outside' | null;
  readonly location: string | null;
}

/**
 * Runs one review instruction's `Scope:` block against the workspace at `root` and reports what
 * its steps decided. Throws when the block does not hold the seven commands F1.2 expects, or when
 * a command word holds a shell metacharacter; both name the offender.
 */
export function resolveReviewScope(instruction: string, root: string): ScopeResolution {
  const commands = prepareCommands(instruction);
  const log: CommandRun[] = [];
  const declaration = readDeclaration(root);

  if (declaration.kind === 'malformed' || declaration.kind === 'conflicting') {
    return finish(log, 'declaration', declaration.kind, [], [], 1);
  }
  if (declaration.kind === 'valid') {
    return resolveDeclared({ root, commands, source: 'declaration', log }, declaration.entries);
  }
  return resolveInferred({ root, commands, source: 'inference', log });
}

// F1.2: the commands, taken from the text.

function prepareCommands(instruction: string): PreparedCommands {
  const block = scopeBlock(instruction);
  const spans = [...block.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  const commands = spans.filter((span) => span.startsWith('git ') || span.startsWith('cd '));

  const prepared = {} as Record<CommandName, readonly string[]>;
  for (const name of Object.keys(COMMAND_KEYS) as CommandName[]) {
    const key = COMMAND_KEYS[name];
    const holders = commands.filter((command) => command.includes(key));
    if (holders.length !== 1) {
      throw new Error(`review scope block: "${key}" occurs in ${holders.length} commands, not exactly 1`);
    }
    prepared[name] = holders[0]!.split(' ');
  }
  for (const words of Object.values(prepared)) checkWords(words);
  checkContainmentShape(prepared.containment);
  return prepared;
}

function scopeBlock(instruction: string): string {
  const lines = instruction.split('\n');
  const start = lines.indexOf('Scope:');
  const end = lines.indexOf('Reviewing:');
  if (start < 0 || end <= start) throw new Error('review scope block: no `Scope:` section before `Reviewing:`');
  return lines.slice(start, end).join('\n');
}

/** F1.3: after the known placeholders are removed from a word, no metacharacter may be left in it. */
function checkWords(words: readonly string[]): void {
  for (const word of words) {
    if (word === CD_CHAIN_WORD) continue;
    const residue = PLACEHOLDERS.reduce((rest, placeholder) => rest.split(placeholder).join(''), word);
    if (SHELL_METACHARACTERS.test(residue)) {
      throw new Error(`review scope block: word "${word}" holds a shell metacharacter`);
    }
    if (residue !== word && !PLACEHOLDERS.some((placeholder) => placeholder === word)) {
      throw new Error(`review scope block: word "${word}" holds a placeholder that is not a whole word`);
    }
  }
}

function checkContainmentShape(words: readonly string[]): void {
  if (words[0] !== 'cd' || words[2] !== CD_CHAIN_WORD || words.length < 4) {
    throw new Error(`review scope block: "${words.join(' ')}" is not a "cd <dir> && <command>" chain`);
  }
}

// F1.3: running them, with no shell.

function fill(words: readonly string[], root: string, values: Values): string[] {
  const need = (value: string | undefined, placeholder: string): string => {
    if (value === undefined) throw new Error(`review scope harness: no value for ${placeholder}`);
    return value;
  };
  return words.map((word) => {
    switch (word) {
      case '<root>/<path>':
        return `${root}/${need(values.path, word)}`;
      case '<root>':
        return root;
      case '<path>':
        return need(values.path, word);
      case '<base>':
        return need(values.base, word);
      case '<merge-base>':
        return need(values.mergeBase, word);
      default:
        return word;
    }
  });
}

function hasExitStatus(error: unknown): boolean {
  return typeof (error as { status?: unknown } | null)?.status === 'number';
}

/** Runs a `git …` command from the workspace root. A nonzero exit is a result, not a throw. */
function runGit(context: Context, name: CommandName, values: Values): GitResult {
  const argv = fill(context.commands[name], context.root, values).slice(1);
  context.log.push({ file: 'git', argv, cwd: context.root });
  try {
    const stdout = execFileSync('git', argv, {
      cwd: context.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, stdout };
  } catch (error) {
    if (!hasExitStatus(error)) throw error;
    return { ok: false, stdout: '' };
  }
}

/** Runs the `cd <dir> && pwd -P` chain. Null when the `cd` fails: the directory is missing or a file. */
function physicalPath(context: Context, path: string): string | null {
  const words = fill(context.commands.containment, context.root, { path });
  const cwd = words[1]!;
  const argv = words.slice(4);
  context.log.push({ file: 'pwd', argv, cwd });
  try {
    return execFileSync(words[3]!, argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

// F1.4: the declaration (contract A1, A2).

function readDeclaration(root: string): Declaration {
  const file = join(root, DECLARATION_FILE);
  if (!existsSync(file)) return { kind: 'absent' };

  let inFence = false;
  let inSection = false;
  let sections = 0;
  const entryTexts: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    // A1.2: a fenced line is neither a heading nor an entry.
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A1.1: the section runs to the next heading of any level.
    if (HEADING_LINE.test(line)) {
      inSection = line.trimEnd() === SECTION_HEADING;
      if (inSection) sections += 1;
      continue;
    }
    if (!inSection) continue;
    // A2.1: a bullet whose text starts with inline code is an entry; every other line is prose.
    const text = BULLET_LINE.exec(line)?.[1];
    if (text !== undefined && text.startsWith('`')) entryTexts.push(text.trimEnd());
  }

  if (sections === 0) return { kind: 'absent' };
  if (sections > 1) return { kind: 'conflicting' }; // A1.4
  if (entryTexts.length === 0) return { kind: 'malformed' }; // A2.5

  const entries: Entry[] = [];
  for (const text of entryTexts) {
    const entry = parseEntry(text);
    if (entry === null) return { kind: 'malformed' }; // A2.4
    entries.push(entry);
  }
  return { kind: 'valid', entries };
}

/** A2.2 and A2.3: one code span, optionally followed by a `(base: <ref>)` span, in the safe set. */
function parseEntry(text: string): Entry | null {
  const match = ENTRY_FORM.exec(text);
  if (match === null) return null;
  const path = match[1]!;
  const base = match.at(2) ?? DEFAULT_BASE; // `at` types the optional group as possibly missing
  return isSafeValue(path) && isSafeValue(base) ? { path, base } : null;
}

function isSafeValue(value: string): boolean {
  return SAFE_VALUE.test(value) && !value.startsWith('-');
}

// F1.4: resolution (contract A3, A5; data-model "Resolution flow").

function resolveDeclared(context: Context, entries: readonly Entry[]): ScopeResolution {
  const rootLocation = physicalPath(context, ROOT_PATH);
  const placed = entries.map((entry) => ({ entry, ...locate(context, entry.path, rootLocation) }));

  // A2.6: two entries that print one location conflict, whatever their bases.
  const locations = placed.map(({ location }) => location).filter((location): location is string => location !== null);
  if (new Set(locations).size < locations.length) return finish(context.log, 'declaration', 'conflicting', [], [], 1);

  const targetPaths = entries.map(({ path }) => path);
  const targets: ScopeTarget[] = [];
  const gitlinks: ScopeGitlink[] = [];
  for (const { entry, failure } of placed) {
    if (failure !== null) {
      targets.push(unresolved(entry, failure));
      continue;
    }
    const resolved = resolveTarget(context, entry, targetPaths);
    targets.push(resolved.target);
    gitlinks.push(...resolved.gitlinks);
  }
  gitlinks.push(...rootGitlinks(context, targetPaths));
  return finish(context.log, 'declaration', 'resolved', targets, gitlinks, countFindings(targets, gitlinks));
}

/** A3 rows 1 to 3, in order and before any `git` command at the path. */
function locate(context: Context, path: string, rootLocation: string | null): Placement {
  if (path.startsWith('/')) return { failure: 'outside', location: null };
  const location = physicalPath(context, path);
  if (location === null) return { failure: 'missing', location: null };
  const inside = rootLocation !== null && (location === rootLocation || location.startsWith(`${rootLocation}/`));
  return { failure: inside ? null : 'outside', location };
}

/** A5.2: `repo` when the root holds specs/ and `repo` is a top level, otherwise `.`, otherwise nothing. */
function resolveInferred(context: Context): ScopeResolution {
  const candidates = isDirectory(join(context.root, 'specs')) ? ['repo', ROOT_PATH] : [ROOT_PATH];
  const picked = candidates.find((path) => isTopLevel(context, path));
  if (picked === undefined) return finish(context.log, 'none', 'no-layout', [], [], 1);

  const resolved = resolveTarget(context, { path: picked, base: DEFAULT_BASE }, [picked]);
  const gitlinks = [...resolved.gitlinks, ...rootGitlinks(context, [picked])];
  const blocking = gitlinks.filter(({ listing }) => listing === 'blocks-inference');
  if (blocking.length > 0) return finish(context.log, 'inference', 'blocked-by-gitlink', [], gitlinks, blocking.length);
  return finish(context.log, 'inference', 'resolved', [resolved.target], gitlinks, countFindings([resolved.target], gitlinks));
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** A3 row 4: `rev-parse --show-prefix` fails or prints anything. */
function isTopLevel(context: Context, path: string): boolean {
  const result = runGit(context, 'topLevel', { path });
  return result.ok && result.stdout.trim() === '';
}

function resolveTarget(
  context: Context,
  entry: Entry,
  targetPaths: readonly string[]
): { readonly target: ScopeTarget; readonly gitlinks: readonly ScopeGitlink[] } {
  if (!isTopLevel(context, entry.path)) return { target: unresolved(entry, 'not-top-level'), gitlinks: [] };

  // A3 row 5: the merge base decides, and nothing is substituted for a base that does not resolve.
  const base = runGit(context, 'base', { path: entry.path, base: entry.base });
  const mergeBase = base.ok ? base.stdout.trim() : '';
  if (mergeBase === '') return { target: unresolved(entry, 'no-base'), gitlinks: [] };

  const scan = scanContainer(context, entry.path, mergeBase);
  const gitlinks = classifyGitlinks(context, entry.path, scan, targetPaths);
  const gitlinkPaths = new Set(gitlinks.map(({ path }) => path));

  // I1 "Files": the union of the two listings, minus the Spec Kit paths and the gitlinks.
  const tracked = [...scan.committed, ...scan.status.filter(({ code }) => code !== UNTRACKED_CODE).map(({ path }) => path)];
  const changedTracked = sortedUnique(tracked.filter((path) => isReviewable(path) && !gitlinkPaths.has(path)));
  const untracked = sortedUnique(
    scan.status.filter(({ code }) => code === UNTRACKED_CODE).map(({ path }) => path).filter(isReviewable)
  );
  // I1 "Files": changes are read with `diff-index -p`; run so the snapshot covers the reading step.
  runGit(context, 'reading', { path: entry.path, mergeBase });

  const state: TargetState = changedTracked.length + untracked.length === 0 ? 'no-feature-changes' : 'resolved';
  return { target: { path: entry.path, base: entry.base, mergeBase, state, changedTracked, untracked }, gitlinks };
}

/** I1 "Files": the committed listing, then the status listing. */
function scanContainer(context: Context, path: string, mergeBase: string | null): Scan {
  const committed = mergeBase === null ? [] : splitLines(runGit(context, 'committed', { path, mergeBase }).stdout);
  const status = splitLines(runGit(context, 'status', { path }).stdout).map((line) => ({
    code: line.slice(0, 2),
    path: unquote(line.slice(3).split(' -> ').at(-1)!)
  }));
  return { committed, status };
}

/** I1 "Gitlinks": the checks of the root when it is not a target, against `develop` or by status alone. */
function rootGitlinks(context: Context, targetPaths: readonly string[]): ScopeGitlink[] {
  if (targetPaths.some((path) => normalize(path) === ROOT_PATH)) return [];
  if (!isTopLevel(context, ROOT_PATH)) return [];
  const base = runGit(context, 'base', { path: ROOT_PATH, base: DEFAULT_BASE });
  const mergeBase = base.ok && base.stdout.trim() !== '' ? base.stdout.trim() : null;
  const scan = scanContainer(context, ROOT_PATH, mergeBase);
  return classifyGitlinks(context, ROOT_PATH, scan, targetPaths);
}

/** I1 "Gitlinks": mode 160000 in `ls-files --stage`; changed when either listing names it. */
function classifyGitlinks(
  context: Context,
  container: string,
  scan: Scan,
  targetPaths: readonly string[]
): ScopeGitlink[] {
  const named = new Set([...scan.committed, ...scan.status.map(({ path }) => path)]);
  const targets = new Set(targetPaths.map(normalize));
  const staged = splitLines(runGit(context, 'gitlinks', { path: container }).stdout).map((line) => line.split('\t'));
  return staged
    .filter(([meta]) => meta!.split(' ')[0] === GITLINK_MODE)
    .map(([, quoted]) => unquote(quoted!))
    .map((path) => ({ path, container, listing: listingOf(context, targets, container, path, named) }));
}

function listingOf(
  context: Context,
  targets: ReadonlySet<string>,
  container: string,
  path: string,
  named: ReadonlySet<string>
): GitlinkListing {
  if (targets.has(normalize(posix.join(container, path)))) return 'target';
  if (!named.has(path)) return 'not-reviewed';
  return context.source === 'declaration' ? 'changed-not-declared' : 'blocks-inference';
}

function normalize(path: string): string {
  return posix.normalize(path).replace(/(.)\/$/, '$1');
}

function isReviewable(path: string): boolean {
  return !SPEC_KIT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function unresolved(entry: Entry, reason: UnresolvedReason): ScopeTarget {
  return {
    path: entry.path,
    base: entry.base,
    mergeBase: null,
    state: `unresolved:${reason}`,
    changedTracked: [],
    untracked: []
  };
}

function splitLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function countFindings(targets: readonly ScopeTarget[], gitlinks: readonly ScopeGitlink[]): number {
  const unresolvedTargets = targets.filter(({ state }) => state.startsWith('unresolved:')).length;
  return unresolvedTargets + gitlinks.filter(({ listing }) => listing === 'blocks-inference').length;
}

function finish(
  log: readonly CommandRun[],
  source: SourceKind,
  wholeScope: WholeScope,
  targets: readonly ScopeTarget[],
  gitlinks: readonly ScopeGitlink[],
  findings: number
): ScopeResolution {
  return { source, wholeScope, targets, gitlinks, findings, log };
}
