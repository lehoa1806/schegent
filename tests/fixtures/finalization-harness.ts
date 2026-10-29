// FR-R4-F19 (feature 247, T006 and T007; contract F1; contracts C, O and N1; research R4, R6 to
// R14, R17, R21) — the shipped `finalize` and `integrate` instructions, run against a fixture
// workspace.
//
// The two Phases tell an agent how to find the repositories, tell this feature's paths from other
// work, commit only the former, and move each target branch without touching a checkout. The text is
// prose, so a test of it has two parts:
//
//   - What it says to run. Every command is an inline-code span that starts with `git ` or `cd `.
//     It is taken from the instruction text handed in, split on spaces outside single quotes and
//     angle brackets, filled in at its placeholders and run with `execFileSync`, never through a
//     shell. No shipped command is typed in this file, so change a flag in the YAML and the
//     fixtures run the changed command; the behavioral controls B1 to B5 in
//     `finalization-fixtures.test.ts` rely on that.
//   - What it says to decide. The declaration grammar and its unresolved conditions, the
//     first-match classification, the order of refusals, the guard and the apply order are the
//     test's own reading of the prose. Each decision names its clause (contract C2, O1, N1 step),
//     and a pin in `speckit-finalization-authority.test.ts` ties the clause to the text.
//
// Judgment is fixture input, never computed (research R18, tasks TA11): which change the review
// ties to a task, which file mixes changes, and each repository's check result. The harness never
// runs a project's check set. Its few "observations" (the branch `HEAD` names, `HEAD`'s commit, a
// commit count) are state reads the prose asks the agent to make without giving a command; they are
// the only git argv typed here, they write nothing, and every one is marked.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export type CheckResult = 'green' | 'failing' | 'unverifiable' | 'no check set';
export type RepositoryKind = 'implementation' | 'envelope';

/** One repository of the map (data-model "Repository map"). */
export interface RepositoryEntry {
  /** Relative to the workspace root; `.` for the root. */
  readonly path: string;
  readonly base: string;
  /** Null only for an added envelope whose base does not resolve (research R17). */
  readonly mergeBase: string | null;
  readonly kind: RepositoryKind;
}

export type ScopeFindingCode =
  | 'no-repository'
  | 'no-entry'
  | 'broken-entry'
  | 'twin-section'
  | 'same-location'
  | 'missing'
  | 'outside'
  | 'not-top-level'
  | 'no-base'
  | 'gitlink-not-repository';

/** One reason the scope is unresolved (contract C2.7 to C2.11). `path` is set for a per-path reason. */
export interface ScopeFinding {
  readonly code: ScopeFindingCode;
  readonly path: string | null;
}

/** One command the harness ran: the argv log the fixtures read to show where it did not go. */
export interface CommandRun {
  readonly file: 'git' | 'pwd';
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface Resolution {
  /** Empty when the scope is unresolved: nothing is written anywhere (FR-002). */
  readonly repositories: readonly RepositoryEntry[];
  readonly findings: readonly ScopeFinding[];
  readonly log: readonly CommandRun[];
}

export type AmbiguityReason = 'two-features' | 'partially-staged' | 'mixed' | 'rename-one-side' | 'unattributed';
export type ChangeClass = 'ambiguous' | 'owned' | 'unrelated';

/** One line of `status --porcelain`, classified (data-model "Changed path"). */
export interface ClassifiedChange {
  /** Relative to its repository, as status prints it (the new name of a rename). */
  readonly path: string;
  readonly fromPath: string | null;
  /** Relative to the workspace root, the form feature claims use. */
  readonly claimPath: string;
  readonly x: string;
  readonly y: string;
  readonly isGitlink: boolean;
  readonly class: ChangeClass;
  readonly reason: AmbiguityReason | null;
}

/** Judgment supplied by a fixture (TA11): root-relative paths the review ties, or finds mixed. */
export interface Ties {
  readonly owned: readonly string[];
  readonly mixed: readonly string[];
}

/** Everything a row decides that the harness must not: the feature, the ties and each check result. */
export interface FixtureInputs {
  /** The finalizing feature's directory name under `specs/`. */
  readonly feature: string;
  readonly ties: Ties;
  /** By repository path; a repository not named here is `green`. */
  readonly checks: Readonly<Record<string, CheckResult>>;
}

export interface FeatureClaim {
  readonly directory: string;
  /** Paths its `tasks.md` and `plan.md` name in inline code, relative to the workspace root. */
  readonly paths: ReadonlySet<string>;
}

export interface Claims {
  readonly feature: string;
  readonly features: ReadonlyMap<string, FeatureClaim>;
  /** The text of `.specify/feature.json`, or null when there is none. */
  readonly pointer: string | null;
}

export type SkipReason = 'nothing-owned' | 'detached' | 'on-base' | 'after-failed-commit';

export interface CommitOutcome {
  /** The new commit, or null when none was made. */
  readonly committed: string | null;
  readonly skipped: SkipReason | 'failed' | null;
}

export interface RepositoryCommit {
  readonly path: string;
  readonly kind: RepositoryKind;
  readonly changes: readonly ClassifiedChange[];
  readonly outcome: CommitOutcome;
}

export interface FeatureCommits {
  readonly findings: readonly ScopeFinding[];
  readonly repositories: readonly RepositoryCommit[];
  readonly log: readonly CommandRun[];
}

export type RecordState = 'integrated' | 'partially integrated' | 'committed, not integrated' | 'nothing committed';

export type WithholdReason =
  | 'hand-off'
  | 'owned-uncommitted'
  | 'needs-maintainer'
  | 'recorded-head-differs'
  | 'check-failing'
  | 'check-unverifiable'
  | 'refused-elsewhere';

export type RefusalReason =
  | 'detached'
  | 'source-is-target'
  | 'no-local-branch'
  | 'checked-out'
  | 'conflict'
  | 'cannot-merge-without-working-tree';

export type Integration =
  | { readonly result: 'integrated'; readonly oldTarget: string; readonly newTarget: string }
  | { readonly result: 'already integrated' }
  | { readonly result: 'refused'; readonly reason: RefusalReason; readonly detail: string }
  | { readonly result: 'withheld'; readonly reasons: readonly WithholdReason[] }
  | { readonly result: 'failed'; readonly detail: string }
  | { readonly result: 'not attempted' };

export interface HandOff {
  readonly path: string;
  readonly reason: AmbiguityReason;
}

export interface RepositoryRecord {
  readonly path: string;
  readonly kind: RepositoryKind;
  readonly source: string | null;
  readonly target: string;
  readonly sourceCommit: string;
  /** "no feature changes", or the source commit and how many commits the target lacks. */
  readonly commitField:
    | { readonly kind: 'no feature changes' }
    | { readonly kind: 'commits'; readonly sourceCommit: string; readonly lacking: number | null };
  /** The count of `diff --name-only <merge-base> HEAD`. */
  readonly ownedCommitted: number;
  readonly checks: CheckResult | 'not run';
  readonly unrelated: readonly string[];
  readonly handOffs: readonly HandOff[];
  readonly ownedUncommitted: readonly string[];
  readonly integration: Integration;
  /** Paths the checked tree held outside the commit: unrelated and ambiguous. */
  readonly outsideCommit: readonly string[];
}

/** A compensating command, recorded and never run (D7, FR-020). */
export interface CompensatingCommand {
  readonly path: string;
  readonly argv: readonly string[];
}

export interface IntegrationRecord {
  readonly state: RecordState;
  readonly findings: readonly ScopeFinding[];
  readonly repositories: readonly RepositoryRecord[];
  readonly withheld: readonly WithholdReason[];
  /** Recorded `HEAD`s that differ, by repository path. */
  readonly headMismatches: ReadonlyArray<{ readonly path: string; readonly recorded: string; readonly actual: string }>;
  readonly compensating: readonly CompensatingCommand[];
  readonly log: readonly CommandRun[];
}

export interface IntegrateHooks {
  /** Called once per repository to integrate, after preflight and before any ref moves. */
  readonly beforeApply?: (repository: RepositoryEntry) => void;
}

/** A shipped instruction that does not hold what the harness needs: the fixtures cannot run it. */
export class HarnessError extends Error {}

const SCALAR_PLACEHOLDERS = [
  '<root>',
  '<path>',
  '<base>',
  '<merge-base>',
  '<message>',
  '<target>',
  '<target commit>',
  '<source commit>',
  '<tree>',
  '<merge>'
] as const;
const LIST_PLACEHOLDERS = ['<untracked owned paths>', '<owned paths>', '<paths>'] as const;
type ScalarPlaceholder = (typeof SCALAR_PLACEHOLDERS)[number];
type ListPlaceholder = (typeof LIST_PLACEHOLDERS)[number];
type Values = Partial<Record<ScalarPlaceholder, string>> & Partial<Record<ListPlaceholder, readonly string[]>>;

/** Config only, never a command: the identity a commit needs, with no signing. Hooks stay on. */
const RUN_CONFIG = ['-c', 'user.name=Schegent Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
const SHELL_METACHARACTERS = /[$`;|<>"&]/;
const CD_CHAIN_WORD = '&&';
const SPAN = /`([^`\n]+)`/g;

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
const POINTER_FILE = '.specify/feature.json';
const TRAILER = /^Repo-head:\s*([0-9a-f]{40})\s*$/m;
const NEEDS_MAINTAINER = /Status:\s*needs-maintainer\b/;
const LETTER = /^[A-Za-z]$/;
const IMPLEMENTATION_DIRECTORY = 'repo';

interface Context {
  readonly root: string;
  readonly log: CommandRun[];
}

interface GitResult {
  readonly status: number;
  readonly ok: boolean;
  readonly stdout: string;
}

// F1: the commands, taken from the text.

/** The sections and steps of one instruction (contract C1; data-model "Phase flow"). */
interface Sections {
  readonly repositories: string;
  readonly ownership: string;
  readonly steps: ReadonlyMap<number, string>;
  /** `integrate` only: the paragraph from `Report "Finalization record:"` to the result lines. */
  readonly record: string;
}

function splitInstruction(instruction: string): Sections {
  const lines = instruction.split('\n');
  const repositories = lines.indexOf('Repositories:');
  const ownership = lines.indexOf('Ownership:');
  const firstStep = lines.findIndex((line) => /^1\. /.test(line));
  const result = lines.indexOf('Result determination:');
  if (repositories < 0 || ownership <= repositories || firstStep <= ownership || result <= firstStep) {
    throw new HarnessError('instruction: no `Repositories:`, `Ownership:`, step 1 and `Result determination:`, in order');
  }

  // `integrate`'s record paragraph follows its last step; it is not part of that step.
  const recordStart = lines.findIndex((line) => line.startsWith('Report "Finalization record:"'));
  const hasRecord = recordStart > firstStep && recordStart < result;
  const stepsEnd = hasRecord ? recordStart : result;

  const stepLines = new Map<number, string[]>();
  let current = 0;
  for (const line of lines.slice(firstStep, stepsEnd)) {
    const number = /^(\d+)\. /.exec(line)?.[1];
    if (number !== undefined) {
      current = Number(number);
      stepLines.set(current, []);
    }
    stepLines.get(current)!.push(line);
  }
  return {
    repositories: lines.slice(repositories, ownership).join('\n'),
    ownership: lines.slice(ownership, firstStep).join('\n'),
    steps: new Map([...stepLines].map(([number, text]) => [number, text.join('\n')])),
    record: hasRecord ? lines.slice(recordStart, result).join('\n') : ''
  };
}

function stepOf(sections: Sections, number: number): string {
  const text = sections.steps.get(number);
  if (text === undefined) throw new HarnessError(`instruction: no step ${number}`);
  return text;
}

/** Every inline-code span of `text`, in order. */
function spansOf(text: string): string[] {
  return [...text.matchAll(SPAN)].map((match) => match[1]!);
}

function commandSpans(text: string): string[] {
  return spansOf(text).filter((span) => span.startsWith('git ') || span.startsWith('cd '));
}

/**
 * Splits one span into words on spaces outside single quotes and outside `<...>`, dropping the
 * quotes: the one quoted argument is `for-each-ref`'s format (research R21), and several
 * placeholders hold a space.
 */
function tokenize(span: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quoted = false;
  let depth = 0;
  for (const character of span) {
    if (character === "'" && depth === 0) {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && character === '<') depth += 1;
    if (!quoted && character === '>') depth = Math.max(0, depth - 1);
    if (character === ' ' && !quoted && depth === 0) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += character;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/** F1.3: after the known placeholders are removed from a word, no metacharacter may be left in it. */
function checkWords(where: string, words: readonly string[]): void {
  for (const word of words) {
    if (word === CD_CHAIN_WORD) continue;
    const residue = [...SCALAR_PLACEHOLDERS, ...LIST_PLACEHOLDERS].reduce((rest, placeholder) => rest.split(placeholder).join(''), word);
    if (SHELL_METACHARACTERS.test(residue)) {
      throw new HarnessError(`${where}: word "${word}" holds a shell metacharacter or an unknown placeholder`);
    }
    const listed = LIST_PLACEHOLDERS.some((placeholder) => word.includes(placeholder));
    if (listed && !LIST_PLACEHOLDERS.some((placeholder) => placeholder === word)) {
      throw new HarnessError(`${where}: word "${word}" holds a list placeholder that is not a whole word`);
    }
  }
}

/** The one command of `text` that holds `key`, as words. Zero or several throw, naming the key. */
function commandWith(where: string, text: string, key: string): string[] {
  const holders = commandSpans(text).filter((span) => span.includes(key));
  if (holders.length !== 1) throw new HarnessError(`${where}: "${key.trim()}" occurs in ${holders.length} commands, not exactly 1`);
  const words = tokenize(holders[0]!);
  checkWords(where, words);
  return words;
}

function fill(words: readonly string[], values: Values): string[] {
  const filled: string[] = [];
  for (const word of words) {
    const list = LIST_PLACEHOLDERS.find((placeholder) => placeholder === word);
    if (list !== undefined) {
      filled.push(...need(values[list], word));
      continue;
    }
    filled.push(
      SCALAR_PLACEHOLDERS.reduce((rest, placeholder) => {
        return rest.includes(placeholder) ? rest.split(placeholder).join(need(values[placeholder], placeholder)) : rest;
      }, word)
    );
  }
  return filled;
}

function need<T>(value: T | undefined, placeholder: string): T {
  if (value === undefined) throw new HarnessError(`finalization harness: no value for ${placeholder}`);
  return value;
}

// F1.3: running them, with no shell.

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Runs `git <argv>` from the workspace root. A nonzero exit is a result, not a throw. */
function execGit(context: Context, argv: readonly string[]): GitResult {
  context.log.push({ file: 'git', argv, cwd: context.root });
  try {
    const stdout = execFileSync('git', [...RUN_CONFIG, ...argv], {
      cwd: context.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, ok: true, stdout };
  } catch (error) {
    const status = statusOf(error);
    if (status === null) throw error;
    const stdout = (error as { stdout?: unknown }).stdout;
    return { status, ok: false, stdout: typeof stdout === 'string' ? stdout : '' };
  }
}

function runShipped(context: Context, words: readonly string[], values: Values): GitResult {
  return execGit(context, fill(words, values).slice(1));
}

/** Runs the `cd <dir> && pwd -P` chain. Null when the `cd` fails: the directory is missing or a file. */
function physicalPath(context: Context, words: readonly string[], path: string): string | null {
  const filled = fill(words, { '<root>': context.root, '<path>': path });
  const cwd = filled[1]!;
  const argv = filled.slice(4);
  context.log.push({ file: 'pwd', argv, cwd });
  try {
    return execFileSync(filled[3]!, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

// Observations: state reads the prose asks the agent to make without giving a command. They write
// nothing, and they are the only git argv typed in this file.

function observeBranch(context: Context, path: string): string | null {
  const result = execGit(context, ['-C', path, 'symbolic-ref', '--short', '-q', 'HEAD']);
  return result.ok && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

function observeHead(context: Context, path: string): string {
  return execGit(context, ['-C', path, 'rev-parse', 'HEAD']).stdout.trim();
}

/** How many commits the local target branch lacks of the source; null when there is no such branch. */
function observeLacking(context: Context, path: string, target: string, sourceCommit: string): number | null {
  const result = execGit(context, ['-C', path, 'rev-list', '--count', `refs/heads/${target}..${sourceCommit}`]);
  return result.ok ? Number(result.stdout.trim()) : null;
}

// F1.4: the repositories (contract C2).

interface RepositoryCommands {
  readonly containment: readonly string[];
  readonly topLevel: readonly string[];
  readonly base: readonly string[];
  readonly gitlinks: readonly string[];
  readonly status: readonly string[];
}

function repositoryCommands(sections: Sections): RepositoryCommands {
  return {
    containment: commandWith('Repositories', sections.repositories, 'pwd -P'),
    topLevel: commandWith('Repositories', sections.repositories, 'rev-parse --show-prefix'),
    base: commandWith('Repositories', sections.repositories, 'merge-base HEAD'),
    gitlinks: commandWith('Repositories', sections.repositories, 'ls-files --stage'),
    status: commandWith('Ownership', sections.ownership, 'status --porcelain')
  };
}

interface Entry {
  readonly path: string;
  readonly base: string;
}

type Declaration =
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly code: ScopeFindingCode }
  | { readonly kind: 'valid'; readonly entries: readonly Entry[] };

/**
 * Runs one instruction's `Repositories:` block against the workspace at `root` and reports the
 * map it resolved, or every reason it is unresolved. Throws a `HarnessError` when the block does
 * not hold the commands the harness needs.
 */
export function resolveRepositories(instruction: string, root: string): Resolution {
  const commands = repositoryCommands(splitInstruction(instruction));
  const context: Context = { root, log: [] };
  const declaration = readDeclaration(root);
  if (declaration.kind === 'refused') return unresolved(context, [{ code: declaration.code, path: null }]);

  const listed =
    declaration.kind === 'valid' ? resolveListed(context, commands, declaration.entries) : resolveInferred(context, commands);
  if (listed.findings.length > 0) return unresolved(context, listed.findings);

  return { repositories: addEnvelope(context, commands, listed.repositories), findings: [], log: context.log };
}

function unresolved(context: Context, findings: readonly ScopeFinding[]): Resolution {
  return { repositories: [], findings, log: context.log };
}

/** C2.2: the declaration, from the root's AGENTS.md; the same grammar as the review scope (F18). */
function readDeclaration(root: string): Declaration {
  const file = join(root, DECLARATION_FILE);
  if (!existsSync(file)) return { kind: 'absent' };

  let inFence = false;
  let inSection = false;
  let sections = 0;
  const entryTexts: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (HEADING_LINE.test(line)) {
      inSection = line.trimEnd() === SECTION_HEADING;
      if (inSection) sections += 1;
      continue;
    }
    if (!inSection) continue;
    const text = BULLET_LINE.exec(line)?.[1];
    if (text !== undefined && text.startsWith('`')) entryTexts.push(text.trimEnd());
  }

  if (sections === 0) return { kind: 'absent' };
  if (sections > 1) return { kind: 'refused', code: 'twin-section' };
  if (entryTexts.length === 0) return { kind: 'refused', code: 'no-entry' };

  const entries: Entry[] = [];
  for (const text of entryTexts) {
    const entry = parseEntry(text);
    if (entry === null) return { kind: 'refused', code: 'broken-entry' };
    entries.push(entry);
  }
  return { kind: 'valid', entries };
}

/** C2.2 and C2.3: one code span, optionally followed by a `(base: <ref>)` span, in the safe set. */
function parseEntry(text: string): Entry | null {
  const match = ENTRY_FORM.exec(text);
  if (match === null) return null;
  const path = match[1]!;
  const base = match.at(2) ?? DEFAULT_BASE;
  return isSafeValue(path) && isSafeValue(base) ? { path, base } : null;
}

function isSafeValue(value: string): boolean {
  return SAFE_VALUE.test(value) && !value.startsWith('-');
}

function normalize(path: string): string {
  return posix.normalize(path).replace(/(.)\/$/, '$1');
}

function kindOf(path: string): RepositoryKind {
  return normalize(path) === ROOT_PATH ? 'envelope' : 'implementation';
}

function resolveListed(
  context: Context,
  commands: RepositoryCommands,
  entries: readonly Entry[]
): { readonly repositories: readonly RepositoryEntry[]; readonly findings: readonly ScopeFinding[] } {
  const rootLocation = physicalPath(context, commands.containment, ROOT_PATH);
  const placed = entries.map((entry) => ({ entry, ...locate(context, commands, entry.path, rootLocation) }));

  // C2.7: two entries that print one location conflict, whatever their bases.
  const locations = placed.map(({ location }) => location).filter((location): location is string => location !== null);
  if (new Set(locations).size < locations.length) return { repositories: [], findings: [{ code: 'same-location', path: null }] };

  const repositories: RepositoryEntry[] = [];
  const findings: ScopeFinding[] = [];
  for (const { entry, failure } of placed) {
    const result = failure === null ? checkRepository(context, commands, entry) : failure;
    if (typeof result === 'string') findings.push({ code: result, path: entry.path });
    else repositories.push(result);
  }
  return { repositories, findings };
}

/** C2.8: absolute, missing or outside, in that order and before any `git` command at the path. */
function locate(
  context: Context,
  commands: RepositoryCommands,
  path: string,
  rootLocation: string | null
): { readonly failure: 'outside' | 'missing' | null; readonly location: string | null } {
  if (path.startsWith('/')) return { failure: 'outside', location: null };
  const location = physicalPath(context, commands.containment, path);
  if (location === null) return { failure: 'missing', location: null };
  const inside = rootLocation !== null && (location === rootLocation || location.startsWith(`${rootLocation}/`));
  return { failure: inside ? null : 'outside', location };
}

/** C2.9 and C2.10: a top level, and a merge base. A string is the finding code that stopped it. */
function checkRepository(context: Context, commands: RepositoryCommands, entry: Entry): RepositoryEntry | ScopeFindingCode {
  if (!isTopLevel(context, commands, entry.path)) return 'not-top-level';
  const base = runShipped(context, commands.base, { '<path>': entry.path, '<base>': entry.base });
  const mergeBase = base.ok ? base.stdout.trim() : '';
  if (mergeBase === '') return 'no-base';
  return { path: entry.path, base: entry.base, mergeBase, kind: kindOf(entry.path) };
}

function isTopLevel(context: Context, commands: RepositoryCommands, path: string): boolean {
  const result = runShipped(context, commands.topLevel, { '<path>': path });
  return result.ok && result.stdout.trim() === '';
}

/** C2.4: `repo` when the root holds `specs/` and `repo` is a top level, otherwise `.`, otherwise nothing. */
function resolveInferred(
  context: Context,
  commands: RepositoryCommands
): { readonly repositories: readonly RepositoryEntry[]; readonly findings: readonly ScopeFinding[] } {
  const hasSpecs = existsSync(join(context.root, 'specs')) && statSync(join(context.root, 'specs')).isDirectory();
  const candidates = hasSpecs ? [IMPLEMENTATION_DIRECTORY, ROOT_PATH] : [ROOT_PATH];
  const picked = candidates.find((path) => isTopLevel(context, commands, path));
  if (picked === undefined) return { repositories: [], findings: [{ code: 'no-repository', path: null }] };

  const checked = checkRepository(context, commands, { path: picked, base: DEFAULT_BASE });
  if (typeof checked === 'string') return { repositories: [], findings: [{ code: checked, path: picked }] };
  const blocking = changedRootGitlinks(context, commands).filter((path) => normalize(path) !== normalize(picked));
  const findings = blocking.map((path): ScopeFinding => ({ code: 'gitlink-not-repository', path }));
  return { repositories: [checked], findings };
}

/**
 * C2.11: a gitlink of the root (mode 160000 in `ls-files --stage`) that the status lists as
 * changed. Only an uncommitted change is read; a committed one is the feature's by construction
 * (contract C3's stated exception).
 */
function changedRootGitlinks(context: Context, commands: RepositoryCommands): string[] {
  if (!isTopLevel(context, commands, ROOT_PATH)) return [];
  const changed = new Set(parseStatus(runShipped(context, commands.status, { '<path>': ROOT_PATH }).stdout).map((line) => line.path));
  return gitlinkPaths(context, commands, ROOT_PATH).filter((gitlink) => changed.has(gitlink));
}

/** The gitlinks of one repository: mode 160000 entries of `ls-files --stage`, run with `<root>` as it. */
function gitlinkPaths(context: Context, commands: RepositoryCommands, path: string): string[] {
  const container = path === ROOT_PATH ? context.root : join(context.root, path);
  return runShipped(context, commands.gitlinks, { '<root>': container })
    .stdout.split('\n')
    .filter((line) => line.split(' ')[0] === GITLINK_MODE)
    .map((line) => unquote(line.split('\t')[1] ?? ''));
}

/** C2.6: the envelope `<root>`, last, base `develop`, when it is a top level and not already listed. */
function addEnvelope(
  context: Context,
  commands: RepositoryCommands,
  repositories: readonly RepositoryEntry[]
): RepositoryEntry[] {
  if (repositories.some((repository) => normalize(repository.path) === ROOT_PATH)) return [...repositories];
  if (!isTopLevel(context, commands, ROOT_PATH)) return [...repositories];
  const base = runShipped(context, commands.base, { '<path>': ROOT_PATH, '<base>': DEFAULT_BASE });
  const mergeBase = base.ok && base.stdout.trim() !== '' ? base.stdout.trim() : null;
  return [...repositories, { path: ROOT_PATH, base: DEFAULT_BASE, mergeBase, kind: 'envelope' }];
}

/** Implementation repositories first, the envelope last (FR-018, FR-020). Stable. */
function inApplyOrder(repositories: readonly RepositoryEntry[]): RepositoryEntry[] {
  return [
    ...repositories.filter(({ kind }) => kind === 'implementation'),
    ...repositories.filter(({ kind }) => kind === 'envelope')
  ];
}

// F1.5: ownership (contract O1).

interface StatusLine {
  readonly x: string;
  readonly y: string;
  readonly path: string;
  readonly fromPath: string | null;
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function parseStatus(output: string): StatusLine[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parts = line.slice(3).split(' -> ');
      return {
        x: line.slice(0, 1),
        y: line.slice(1, 2),
        path: unquote(parts.at(-1)!),
        fromPath: parts.length > 1 ? unquote(parts[0]!) : null
      };
    });
}

/**
 * Reads what each feature claims: its directory under `specs/`, and the paths its `tasks.md` and
 * `plan.md` name in inline code (data-model "Claims"). Throws when `feature` has no directory.
 */
export function readClaims(root: string, feature: string): Claims {
  const specs = join(root, 'specs');
  const features = new Map<string, FeatureClaim>();
  const names = existsSync(specs) ? readdirSync(specs).filter((name) => statSync(join(specs, name)).isDirectory()) : [];
  for (const name of names) {
    const paths = new Set<string>();
    for (const doc of ['tasks.md', 'plan.md']) {
      const file = join(specs, name, doc);
      if (!existsSync(file)) continue;
      for (const span of spansOf(readFileSync(file, 'utf8'))) if (SAFE_VALUE.test(span)) paths.add(normalize(span));
    }
    features.set(name, { directory: `specs/${name}`, paths });
  }
  if (!features.has(feature)) throw new HarnessError(`finalization harness: no specs/${feature} directory under ${root}`);
  const pointerFile = join(root, POINTER_FILE);
  return { feature, features, pointer: existsSync(pointerFile) ? readFileSync(pointerFile, 'utf8') : null };
}

function claimedBy(claims: Claims, name: string, path: string, ties: Ties): boolean {
  const claim = claims.features.get(name)!;
  if (path.startsWith(`${claim.directory}/`) || claim.paths.has(path)) return true;
  if (name === claims.feature && ties.owned.includes(path)) return true;
  // O1.8: a shared pointer is claimed by the feature directory it names.
  return path === POINTER_FILE && claims.pointer !== null && pointerNames(claims.pointer, claim.directory);
}

function pointerNames(text: string, directory: string): boolean {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9._-])`).test(text);
}

/**
 * Classifies each changed path of `repository` (contract O1; first match winning). `featureWork`
 * names the repositories, by path, that hold feature work: their changed gitlink is owned, and a
 * changed gitlink of any other repository is unrelated (O1.5, O1.6).
 */
export function classifyChanges(
  instruction: string,
  root: string,
  repository: RepositoryEntry,
  claims: Claims,
  ties: Ties,
  featureWork: ReadonlySet<string>,
  resolved: readonly RepositoryEntry[] = [repository]
): ClassifiedChange[] {
  const context: Context = { root, log: [] };
  return classifyIn(context, repositoryCommands(splitInstruction(instruction)), repository, claims, ties, featureWork, resolved);
}

function classifyIn(
  context: Context,
  commands: RepositoryCommands,
  repository: RepositoryEntry,
  claims: Claims,
  ties: Ties,
  featureWork: ReadonlySet<string>,
  resolved: readonly RepositoryEntry[]
): ClassifiedChange[] {
  const status = parseStatus(runShipped(context, commands.status, { '<path>': repository.path }).stdout);
  const gitlinks = new Set(gitlinkPaths(context, commands, repository.path));
  const resolvedPaths = new Set(resolved.map(({ path }) => normalize(path)));
  const claimPathOf = (path: string): string => normalize(posix.join(repository.path, path));
  const otherNames = [...claims.features.keys()].filter((name) => name !== claims.feature);
  const ownedNow = (path: string): boolean => claimedBy(claims, claims.feature, claimPathOf(path), ties);

  return status.map((line): ClassifiedChange => {
    const claimPath = claimPathOf(line.path);
    const isGitlink = gitlinks.has(line.path);
    const base = { path: line.path, fromPath: line.fromPath, claimPath, x: line.x, y: line.y, isGitlink };
    if (isGitlink) {
      // O1.5 and O1.6: a gitlink is the feature's when its repository holds feature work.
      if (featureWork.has(claimPath)) return { ...base, class: 'owned', reason: null };
      if (!resolvedPaths.has(claimPath)) return { ...base, class: 'unrelated', reason: null };
      return { ...base, class: 'ambiguous', reason: 'unattributed' };
    }
    const mine = ownedNow(line.path);
    const others = otherNames.some((name) => claimedBy(claims, name, claimPath, ties));
    const reason = ambiguityOf(line, mine, others, ties.mixed.includes(claimPath), line.fromPath === null ? null : ownedNow(line.fromPath));
    if (reason !== null) return { ...base, class: 'ambiguous', reason };
    return { ...base, class: mine ? 'owned' : 'unrelated', reason: null };
  });
}

/** O1.4, in the order the text lists the reasons. */
function ambiguityOf(
  line: StatusLine,
  mine: boolean,
  others: boolean,
  mixed: boolean,
  fromOwned: boolean | null
): AmbiguityReason | null {
  if (mine && others) return 'two-features';
  if (LETTER.test(line.x) && LETTER.test(line.y)) return 'partially-staged';
  if (mixed) return 'mixed';
  if (fromOwned !== null && fromOwned !== mine) return 'rename-one-side';
  if (!mine && !others) return 'unattributed';
  return null;
}

// F1.6: the commit (`finalize` steps 1 and 5).

/** Step 1's example formatter command, filled with the owned paths. It is never executed (F1). */
export function formatterArgv(instruction: string, owned: readonly string[]): string[] {
  const step = stepOf(splitInstruction(instruction), 1);
  const holders = spansOf(step).filter((span) => span.includes('--write'));
  if (holders.length !== 1) throw new HarnessError(`step 1: "--write" occurs in ${holders.length} commands, not exactly 1`);
  const words = tokenize(holders[0]!);
  checkWords('step 1', words);
  return fill(words, { '<paths>': owned });
}

/**
 * `finalize` step 3's listing of the tracked files that differ from the merge base, run as
 * written (FR-012). It must not rewrite the index, which a plain `git diff` can.
 */
export function listBranchChanges(instruction: string, root: string, repository: RepositoryEntry): string[] {
  if (repository.mergeBase === null) throw new HarnessError(`finalization harness: ${repository.path} has no merge base`);
  const words = commandWith('step 3', stepOf(splitInstruction(instruction), 3), 'diff-index --name-only');
  const context: Context = { root, log: [] };
  const listed = runShipped(context, words, { '<path>': repository.path, '<merge-base>': repository.mergeBase });
  return listed.stdout.split('\n').filter((line) => line !== '').sort();
}

interface CommitCommands {
  readonly add: readonly string[];
  readonly commit: readonly string[];
}

function commitCommands(sections: Sections): CommitCommands {
  const step = stepOf(sections, 5);
  return { add: commandWith('step 5', step, 'add --'), commit: commandWith('step 5', step, ' commit ') };
}

/** The pathspecs a commit of `change` names: a rename names both sides. */
function pathspecs(change: ClassifiedChange): string[] {
  return change.fromPath === null ? [change.path] : [change.fromPath, change.path];
}

/**
 * Runs `finalize` step 5 in one repository: `add --` the untracked owned paths, then `commit -m
 * <message> --` every owned path. Nothing is run when nothing is owned, `HEAD` is detached or the
 * branch is the base.
 */
export function commitOwned(
  instruction: string,
  root: string,
  repository: RepositoryEntry,
  owned: readonly ClassifiedChange[],
  message: string,
  log: CommandRun[] = []
): CommitOutcome {
  const context: Context = { root, log };
  const commands = commitCommands(splitInstruction(instruction));
  if (owned.length === 0) return { committed: null, skipped: 'nothing-owned' };
  const branch = observeBranch(context, repository.path);
  if (branch === null) return { committed: null, skipped: 'detached' };
  if (branch === repository.base) return { committed: null, skipped: 'on-base' };

  const untracked = owned.filter(({ x }) => x === '?').map(({ path }) => path);
  if (untracked.length > 0) {
    const added = runShipped(context, commands.add, { '<path>': repository.path, '<untracked owned paths>': untracked });
    if (!added.ok) return { committed: null, skipped: 'failed' };
  }
  const committed = runShipped(context, commands.commit, {
    '<path>': repository.path,
    '<message>': message,
    '<owned paths>': owned.flatMap(pathspecs)
  });
  if (!committed.ok) return { committed: null, skipped: 'failed' };
  return { committed: observeHead(context, repository.path), skipped: null };
}

/**
 * `finalize` as a whole, for the rows that follow it into `integrate`: resolve, classify and
 * commit in each repository, implementation repositories first and the envelope last. An
 * unresolved scope commits nothing. A failed commit stops every later one (FR-018).
 */
export function commitFeature(instruction: string, root: string, inputs: FixtureInputs): FeatureCommits {
  const resolution = resolveRepositories(instruction, root);
  const log: CommandRun[] = [...resolution.log];
  if (resolution.findings.length > 0) return { findings: resolution.findings, repositories: [], log };

  const sections = splitInstruction(instruction);
  const context: Context = { root, log };
  const commands = repositoryCommands(sections);
  const claims = readClaims(root, inputs.feature);
  const featureWork = new Set<string>();
  const repositories: RepositoryCommit[] = [];
  let failed = false;
  for (const repository of inApplyOrder(resolution.repositories)) {
    const changes = classifyIn(context, commands, repository, claims, inputs.ties, featureWork, resolution.repositories);
    const owned = changes.filter(({ class: kind }) => kind === 'owned');
    const outcome = failed
      ? { committed: null, skipped: 'after-failed-commit' as const }
      : commitOwned(instruction, root, repository, owned, `feat(${inputs.feature.toLowerCase()}): fixture`, log);
    if (outcome.skipped === 'failed') failed = true;
    const hasCommits = repository.mergeBase !== null && observeHead(context, repository.path) !== repository.mergeBase;
    if (owned.length > 0 || hasCommits) featureWork.add(normalize(repository.path));
    repositories.push({ path: repository.path, kind: repository.kind, changes, outcome });
  }
  return { findings: [], repositories, log };
}

// F1.7: `integrate` (contract N1 steps 1 to 5 and the record).

interface IntegrateCommands {
  readonly symbolicRef: readonly string[];
  readonly revParse: readonly string[];
  readonly isAncestor: readonly string[];
  readonly lsTree: readonly string[];
  readonly log: readonly string[];
  readonly forEachRef: readonly string[];
  readonly mergeTree: readonly string[];
  readonly commitTree: readonly string[];
  readonly applyRef: readonly string[];
  readonly compensateRef: readonly string[];
  readonly diffNames: readonly string[];
}

function integrateCommands(sections: Sections): IntegrateCommands {
  // Step 5 holds the two `update-ref` commands: the first applies, the second is the recorded
  // compensation. They are told apart by position, so a mutated copy that swaps the arguments of
  // the first still runs, and fails where a real swap would (control B1).
  const updates = commandSpans(stepOf(sections, 5)).filter((span) => span.includes('update-ref'));
  if (updates.length !== 2) throw new HarnessError(`step 5: "update-ref" occurs in ${updates.length} commands, not exactly 2`);
  const [applyRef, compensateRef] = updates.map((span) => {
    const words = tokenize(span);
    checkWords('step 5', words);
    return words;
  });
  const step = (number: number): string => stepOf(sections, number);
  return {
    symbolicRef: commandWith('step 1', step(1), 'symbolic-ref'),
    revParse: commandWith('step 1', step(1), 'rev-parse HEAD'),
    isAncestor: commandWith('step 1', step(1), '--is-ancestor'),
    lsTree: commandWith('step 2', step(2), 'ls-tree'),
    log: commandWith('step 2', step(2), 'log -1'),
    forEachRef: commandWith('step 3', step(3), 'for-each-ref'),
    mergeTree: commandWith('step 3', step(3), 'merge-tree'),
    commitTree: commandWith('step 3', step(3), 'commit-tree'),
    applyRef: applyRef!,
    compensateRef: compensateRef!,
    diffNames: commandWith('the record', sections.record, 'diff --name-only')
  };
}

/** One repository's state at step 1, before the guard. */
interface Prepared {
  readonly repository: RepositoryEntry;
  readonly source: string | null;
  readonly sourceCommit: string;
  readonly contained: boolean;
  readonly changes: readonly ClassifiedChange[];
}

interface Preflight {
  readonly refusal: { readonly reason: RefusalReason; readonly detail: string } | null;
  readonly targetCommit: string;
  readonly merge: string;
}

interface HeadMismatch {
  readonly path: string;
  readonly recorded: string;
  readonly actual: string;
}

interface Applied {
  readonly moved: ReadonlyArray<{ readonly repository: RepositoryEntry; readonly oldTarget: string; readonly newTarget: string }>;
  readonly failed: { readonly repository: RepositoryEntry; readonly detail: string } | null;
}

/**
 * Runs `integrate` steps 1 to 5 against the workspace at `root` and returns the record. It never
 * runs a project's check set: each repository's result comes from `inputs` (TA11).
 */
export function integrate(
  instruction: string,
  root: string,
  inputs: FixtureInputs,
  hooks: IntegrateHooks = {}
): IntegrationRecord {
  const sections = splitInstruction(instruction);
  const resolution = resolveRepositories(instruction, root);
  const context: Context = { root, log: [...resolution.log] };
  if (resolution.findings.length > 0) return { ...emptyRecord(context), findings: resolution.findings };

  const commands = integrateCommands(sections);
  const claims = readClaims(root, inputs.feature);
  const prepared = prepare(context, commands, repositoryCommands(sections), resolution.repositories, claims, inputs);

  // Step 2: every condition but the checks, decided first.
  const withheld = new Set<WithholdReason>(guardReasons(root, claims, prepared));
  const mismatches = recordedHeadMismatches(context, commands, prepared);
  if (mismatches.length > 0) withheld.add('recorded-head-differs');

  // Step 3: preflight each repository to integrate, whatever the guard said.
  const toIntegrate = prepared.filter(({ contained }) => !contained);
  const preflights = new Map(toIntegrate.map((item): [string, Preflight] => [item.repository.path, preflight(context, commands, item)]));
  if ([...preflights.values()].some(({ refusal }) => refusal !== null)) withheld.add('refused-elsewhere');

  // Step 4: the check set, only when nothing is withheld or refused.
  const checks = new Map<string, CheckResult | 'not run'>(prepared.map(({ repository }) => [repository.path, 'not run']));
  if (withheld.size === 0) {
    for (const { repository } of toIntegrate) {
      const result = checkResult(inputs, repository);
      checks.set(repository.path, result);
      if (result === 'failing') withheld.add('check-failing');
      if (result === 'unverifiable') withheld.add('check-unverifiable');
    }
  }

  // Step 5: apply, only when every check is green.
  const applied = withheld.size === 0 ? apply(context, commands, toIntegrate, preflights, hooks) : null;
  return assemble(context, commands, { prepared, preflights, checks, withheld: [...withheld], mismatches, applied });
}

function emptyRecord(context: Context): IntegrationRecord {
  return {
    state: 'nothing committed',
    findings: [],
    repositories: [],
    withheld: [],
    headMismatches: [],
    compensating: [],
    log: context.log
  };
}

/** N1 step 1: the source, the source commit and whether the target already contains it. */
function prepare(
  context: Context,
  commands: IntegrateCommands,
  ownership: RepositoryCommands,
  repositories: readonly RepositoryEntry[],
  claims: Claims,
  inputs: FixtureInputs
): Prepared[] {
  const basics = inApplyOrder(repositories).map((repository) => {
    const source = runShipped(context, commands.symbolicRef, { '<path>': repository.path });
    const sourceCommit = runShipped(context, commands.revParse, { '<path>': repository.path }).stdout.trim();
    const contained = runShipped(context, commands.isAncestor, {
      '<path>': repository.path,
      '<source commit>': sourceCommit,
      '<target>': repository.base
    }).ok;
    return { repository, source: source.ok && source.stdout.trim() !== '' ? source.stdout.trim() : null, sourceCommit, contained };
  });

  // A repository holds feature work once it has commits past its merge base (O1.5).
  const featureWork = new Set(
    basics
      .filter(({ repository, sourceCommit }) => repository.mergeBase !== null && sourceCommit !== repository.mergeBase)
      .map(({ repository }) => normalize(repository.path))
  );
  return basics.map((basic) => ({
    ...basic,
    changes: classifyIn(context, ownership, basic.repository, claims, inputs.ties, featureWork, repositories)
  }));
}

/** N1 step 2's conditions other than the checks and the recorded `HEAD`s. */
function guardReasons(root: string, claims: Claims, prepared: readonly Prepared[]): WithholdReason[] {
  const reasons: WithholdReason[] = [];
  const classes = prepared.flatMap(({ changes }) => changes.map(({ class: kind }) => kind));
  if (classes.includes('ambiguous')) reasons.push('hand-off');
  if (classes.includes('owned')) reasons.push('owned-uncommitted');
  const decisions = join(root, 'specs', claims.feature, 'decisions.md');
  if (existsSync(decisions) && NEEDS_MAINTAINER.test(readFileSync(decisions, 'utf8'))) reasons.push('needs-maintainer');
  return reasons;
}

/**
 * N1 step 2: each implementation `HEAD` the envelope's `HEAD` records, as a gitlink in `ls-tree`
 * or as a `Repo-head:` trailer its hooks wrote for `repo/`, must equal that repository's source
 * commit (research R13, R14, D8).
 */
function recordedHeadMismatches(context: Context, commands: IntegrateCommands, prepared: readonly Prepared[]): HeadMismatch[] {
  if (!prepared.some(({ repository }) => repository.kind === 'envelope')) return [];
  const message = runShipped(context, commands.log, { '<root>': context.root }).stdout;
  const trailer = TRAILER.exec(message)?.[1];
  const mismatches: HeadMismatch[] = [];
  for (const { repository, sourceCommit } of prepared.filter((item) => item.repository.kind === 'implementation')) {
    const tree = runShipped(context, commands.lsTree, { '<root>': context.root, '<path>': repository.path }).stdout;
    const [mode, , gitlink] = tree.split(/\s+/);
    const recorded = mode === GITLINK_MODE ? gitlink : repository.path === IMPLEMENTATION_DIRECTORY ? trailer : undefined;
    if (recorded !== undefined && recorded !== sourceCommit) mismatches.push({ path: repository.path, recorded, actual: sourceCommit });
  }
  return mismatches;
}

/** N1 step 3: the refusals, then the tree-only merge and its commit. */
function preflight(context: Context, commands: IntegrateCommands, item: Prepared): Preflight {
  const { repository, source, sourceCommit } = item;
  const refuse = (reason: RefusalReason, detail: string, targetCommit = ''): Preflight => ({
    refusal: { reason, detail },
    targetCommit,
    merge: ''
  });
  if (source === null) return refuse('detached', 'HEAD is detached');
  // Step 1 reads a `HEAD` the target contains as already integrated, so this clause never fires.
  if (source === repository.base) return refuse('source-is-target', `${source} is its own target`);

  const ref = runShipped(context, commands.forEachRef, { '<path>': repository.path, '<target>': repository.base });
  // The pattern also matches branches under `<target>/`, so only the target's own line counts.
  const own = `refs/heads/${repository.base} `;
  const line = ref.stdout.split('\n').find((candidate) => candidate.startsWith(own));
  if (line === undefined) return refuse('no-local-branch', `no local branch ${repository.base}`);
  const fields = line.slice(own.length);
  const space = fields.indexOf(' ');
  const targetCommit = fields.slice(0, space);
  const checkedOutAt = fields.slice(space + 1).trim();
  if (checkedOutAt !== '') return refuse('checked-out', checkedOutAt, targetCommit);

  const merged = runShipped(context, commands.mergeTree, {
    '<path>': repository.path,
    '<target commit>': targetCommit,
    '<source commit>': sourceCommit
  });
  if (merged.status === 1) {
    const paths = merged.stdout.split('\n').slice(1).filter((path) => path !== '');
    return refuse('conflict', `${paths.join(', ')} (target ${targetCommit}, source ${sourceCommit})`, targetCommit);
  }
  if (merged.status !== 0) return refuse('cannot-merge-without-working-tree', `merge-tree exited ${merged.status}`, targetCommit);

  const made = runShipped(context, commands.commitTree, {
    '<path>': repository.path,
    '<tree>': merged.stdout.split('\n')[0] ?? '',
    '<target commit>': targetCommit,
    '<source commit>': sourceCommit,
    '<message>': `Merge branch '${source}' into ${repository.base}`
  });
  return { refusal: null, targetCommit, merge: made.stdout.trim() };
}

/** N1 step 4: a repository's check result. An implementation with no check set is unverifiable. */
function checkResult(inputs: FixtureInputs, repository: RepositoryEntry): CheckResult {
  const given = inputs.checks[repository.path] ?? 'green';
  return given === 'no check set' && repository.kind === 'implementation' ? 'unverifiable' : given;
}

/** N1 step 5: `update-ref` in map order, stopping at the first failure. */
function apply(
  context: Context,
  commands: IntegrateCommands,
  toIntegrate: readonly Prepared[],
  preflights: ReadonlyMap<string, Preflight>,
  hooks: IntegrateHooks
): Applied {
  for (const { repository } of toIntegrate) hooks.beforeApply?.(repository);
  const moved: Array<Applied['moved'][number]> = [];
  for (const { repository } of toIntegrate) {
    const { targetCommit, merge } = preflights.get(repository.path)!;
    const result = runShipped(context, commands.applyRef, {
      '<path>': repository.path,
      '<target>': repository.base,
      '<merge>': merge,
      '<target commit>': targetCommit
    });
    if (!result.ok) return { moved, failed: { repository, detail: `the target moved from ${targetCommit}` } };
    moved.push({ repository, oldTarget: targetCommit, newTarget: merge });
  }
  return { moved, failed: null };
}

interface Outcome {
  readonly prepared: readonly Prepared[];
  readonly preflights: ReadonlyMap<string, Preflight>;
  readonly checks: ReadonlyMap<string, CheckResult | 'not run'>;
  readonly withheld: readonly WithholdReason[];
  readonly mismatches: readonly HeadMismatch[];
  readonly applied: Applied | null;
}

/** The record (data-model "Finalization record"): the state, then one entry per repository. */
function assemble(context: Context, commands: IntegrateCommands, outcome: Outcome): IntegrationRecord {
  const { prepared, preflights, checks, withheld, mismatches, applied } = outcome;
  const moved = new Map((applied?.moved ?? []).map((entry) => [entry.repository.path, entry]));

  const repositories = prepared.map((item): RepositoryRecord => {
    const { repository } = item;
    const owned = item.changes.filter(({ class: kind }) => kind === 'owned').map(({ path }) => path);
    const refusal = preflights.get(repository.path)?.refusal ?? null;
    const done = moved.get(repository.path);

    let integration: Integration;
    if (item.contained) integration = { result: 'already integrated' };
    else if (done !== undefined) integration = { result: 'integrated', oldTarget: done.oldTarget, newTarget: done.newTarget };
    else if (refusal !== null) integration = { result: 'refused', reason: refusal.reason, detail: refusal.detail };
    else if (applied?.failed?.repository.path === repository.path) integration = { result: 'failed', detail: applied.failed.detail };
    else if (applied !== null) integration = { result: 'not attempted' };
    else integration = { result: 'withheld', reasons: withheld };

    const lacking = item.contained ? 0 : observeLacking(context, repository.path, repository.base, item.sourceCommit);
    return {
      path: repository.path,
      kind: repository.kind,
      source: item.source,
      target: repository.base,
      sourceCommit: item.sourceCommit,
      commitField:
        item.contained && owned.length === 0
          ? { kind: 'no feature changes' }
          : { kind: 'commits', sourceCommit: item.sourceCommit, lacking },
      ownedCommitted: ownedCommitted(context, commands, repository),
      checks: checks.get(repository.path) ?? 'not run',
      unrelated: item.changes.filter(({ class: kind }) => kind === 'unrelated').map(({ path }) => path),
      handOffs: item.changes
        .filter(({ class: kind }) => kind === 'ambiguous')
        .map(({ path, reason }): HandOff => ({ path, reason: reason! })),
      ownedUncommitted: owned,
      integration,
      outsideCommit: item.changes.filter(({ class: kind }) => kind !== 'owned').map(({ path }) => path)
    };
  });

  // D7, FR-020: after a failure, each ref already moved gets its restoring command recorded, never run.
  const compensating =
    applied === null || applied.failed === null
      ? []
      : applied.moved.map((entry): CompensatingCommand => ({
          path: entry.repository.path,
          argv: fill(commands.compensateRef, {
            '<path>': entry.repository.path,
            '<target>': entry.repository.base,
            '<target commit>': entry.oldTarget,
            '<merge>': entry.newTarget
          }).slice(1)
        }));

  return {
    state: stateOf(repositories, withheld, applied),
    findings: [],
    repositories,
    withheld,
    headMismatches: mismatches,
    compensating,
    log: context.log
  };
}

function ownedCommitted(context: Context, commands: IntegrateCommands, repository: RepositoryEntry): number {
  if (repository.mergeBase === null) return 0;
  const result = runShipped(context, commands.diffNames, { '<path>': repository.path, '<merge-base>': repository.mergeBase });
  return result.stdout.split('\n').filter((line) => line !== '').length;
}

function isSettled(integration: Integration): boolean {
  return integration.result === 'integrated' || integration.result === 'already integrated';
}

/** The overall state, first matching (data-model "Finalization record"). */
function stateOf(repositories: readonly RepositoryRecord[], withheld: readonly WithholdReason[], applied: Applied | null): RecordState {
  if (applied !== null && applied.failed !== null && applied.moved.length > 0) return 'partially integrated';
  const open = repositories.some(({ handOffs, ownedUncommitted }) => handOffs.length > 0 || ownedUncommitted.length > 0);
  if (repositories.every(({ integration }) => isSettled(integration)) && !open && withheld.length === 0) return 'integrated';
  return repositories.some(({ integration }) => !isSettled(integration)) ? 'committed, not integrated' : 'nothing committed';
}

/** FR-024: only a record in the state "integrated" would emit CLEAR. */
export function emitsClear(record: IntegrationRecord): boolean {
  return record.state === 'integrated';
}
