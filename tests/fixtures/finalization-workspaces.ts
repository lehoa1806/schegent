// FR-R4-F19 (feature 247, T008, T011, T021, T024, T028, T031; contract F2; research R13, R14, R17,
// R21; tasks TA6, TA7) — the fixture workspaces the finalization rows run in.
//
// Each workspace is made fresh under the vitest temp root, offline, from F18's primitives
// (`review-scope-workspaces.ts`, imported and never copied): `git init`, commits, and gitlinks
// pinned with `update-index --cacheinfo`. "A" is the finalizing feature and "B" another feature
// with its own directory under `specs/`; both have a `tasks.md` and a `plan.md` that name paths in
// inline code, which is how the harness reads their claims. Everything `develop` already holds is
// committed on the feature branch first and then settled as the base, so no row switches a branch
// that a gitlink's directory sits under.
//
// The rows are grouped by what they build: S and U (one repository, a shared checkout), I (one
// repository with A's work committed, then a twist per refusal), and M, H, N and R (an envelope with
// implementation repositories). A builder returns the workspace and the `FixtureInputs` the
// harness needs for the judgment it must not make (research R18).
//
// `git worktree add` runs only in `addSecondCheckout`, only on the throwaway repository a row built
// under the temp root, after asserting the path (hard rule 59; tasks TA7).

import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { FixtureInputs } from './finalization-harness';
import {
  addGitlink,
  commitFile,
  git,
  headOf,
  initRepo,
  makeRoot,
  settleBase,
  writeAgentsMd,
  writeFile,
  type Workspace
} from './review-scope-workspaces';

export { seedStatDirty, snapshot } from './review-scope-workspaces';
export type { FixtureInputs } from './finalization-harness';

/** A finalization row's workspace: the repositories to snapshot, the inputs, and any named paths. */
export interface FeatureWorkspace extends Workspace {
  readonly inputs: FixtureInputs;
  /** Directories a row names: implementation repositories, a second checkout, an outside sibling. */
  readonly dirs: Readonly<Record<string, string>>;
  /** Root-relative paths of B's changes in the checkout, which a commit of A must leave alone. */
  readonly otherPaths: readonly string[];
}

export const FEATURE = 'A';
export const FEATURE_BRANCH = '247-feature';
const BASE = 'develop';

/** What A's `tasks.md` and B's name, relative to the workspace root. */
const A_TASKS = ['src/a.ts', 'src/a-new.ts', 'src/mixed.ts', 'src/shared.ts'] as const;
const B_TASKS = ['src/b.ts', 'src/b-staged.ts', 'src/b-format.ts', 'src/shared.ts', 'notes/b.md', 'scratch/other.md'] as const;

/** A's owned set in S1: its directory, and the two paths its `tasks.md` names. */
export const S1_OWNED = ['specs/A/spec.md', 'src/a-new.ts', 'src/a.ts'] as const;
const S1_OTHER = ['notes/b.md', 'src/b-staged.ts', 'src/b.ts'] as const;

const MIXED_BASE = Array.from({ length: 12 }, (_, index) => `line ${index + 1}\n`).join('');

/** Files every single-repository row starts from, committed on the base. */
const BASE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['src/a.ts', 'export const a = 1;\n'],
  ['src/b.ts', 'export const b = 1;\n'],
  ['src/b-staged.ts', 'export const bStaged = 1;\n'],
  ['src/b-format.ts', 'export const bFormat = 1;\n'],
  ['src/mixed.ts', MIXED_BASE],
  ['src/shared.ts', 'export const shared = 1;\n'],
  ['src/orphan.ts', 'export const orphan = 1;\n'],
  ['.specify/feature.json', '{"feature_directory":"specs/A"}\n']
];

/** The F3 worktree count: the `worktree ` lines of `git worktree list --porcelain`, in test code only. */
export function worktreeCount(repoDir: string): number {
  return git(repoDir, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
}

/** `initRepo` on `base`, with the feature branch named `247-feature` and checked out. */
export function makeFeatureRepo(root: string, rel: string, options: { readonly base?: string } = {}): string {
  const dir = rel === '.' ? root : join(root, rel);
  initRepo(dir, { base: options.base ?? BASE });
  git(dir, ['branch', '-m', 'feature', FEATURE_BRANCH]);
  return dir;
}

/** Writes `specs/<feature>/tasks.md` and `plan.md`, each naming its paths one per line in inline code. */
export function writeFeatureDocs(
  root: string,
  feature: string,
  docs: { readonly tasks: readonly string[]; readonly plan?: readonly string[] }
): void {
  const body = (title: string, paths: readonly string[]): string =>
    [`# ${title} ${feature}`, '', ...paths.map((path) => `- \`${path}\``), ''].join('\n');
  writeFile(root, `specs/${feature}/tasks.md`, body('Tasks', docs.tasks));
  writeFile(root, `specs/${feature}/plan.md`, body('Plan', docs.plan ?? []));
}

/** `specs/<feature>/decisions.md` with one entry of the given status, committed on the checked-out branch. */
export function writeDecision(root: string, feature: string, status: string): void {
  commitFile(root, `specs/${feature}/decisions.md`, `# Decisions\n\n## D-1\n\nStatus: ${status}\n`);
}

/** The declaration as an owner writes it: one prose line, then one bullet per entry. */
export function declareRepositories(root: string, entries: ReadonlyArray<{ readonly path: string; readonly base?: string }>): void {
  writeAgentsMd(root, [
    '# Workspace',
    '',
    '## Implementation repositories',
    '',
    'The feature code lives in these repositories.',
    ...entries.map(({ path, base }) => (base === undefined ? `- \`${path}\`` : `- \`${path}\` \`(base: ${base})\``))
  ]);
}

function defaultInputs(overrides: Partial<FixtureInputs> = {}): FixtureInputs {
  return { feature: FEATURE, ties: { owned: [], mixed: [] }, checks: {}, ...overrides };
}

function commitEverything(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

/** Moves a branch's ref by plumbing only, so no checkout changes: another session's commit on the target. */
export function moveBranch(dir: string, branch: string): void {
  const tree = git(dir, ['rev-parse', `${branch}^{tree}`]).trim();
  const commit = git(dir, ['commit-tree', tree, '-p', branch, '-m', 'another session']).trim();
  git(dir, ['update-ref', `refs/heads/${branch}`, commit]);
}

/** Commits `rel` on `branch` and returns to the feature branch. Builder code; the harness never switches. */
function commitOnBranch(dir: string, branch: string, rel: string, text: string): void {
  git(dir, ['switch', '-q', branch]);
  commitFile(dir, rel, text);
  git(dir, ['switch', '-q', FEATURE_BRANCH]);
}

interface SingleOptions {
  readonly base?: string;
  readonly declare?: ReadonlyArray<{ readonly path: string; readonly base?: string }>;
}

/** One repository, the root: both features' docs and the base files committed, `develop` settled. */
function createSingle(label: string, options: SingleOptions = {}): FeatureWorkspace {
  const root = makeRoot(label);
  makeFeatureRepo(root, '.', options.base === undefined ? {} : { base: options.base });
  writeFeatureDocs(root, 'A', { tasks: A_TASKS });
  writeFeatureDocs(root, 'B', { tasks: B_TASKS });
  for (const [rel, text] of BASE_FILES) writeFile(root, rel, text);
  if (options.declare !== undefined) declareRepositories(root, options.declare);
  commitEverything(root, 'base');
  settleBase(root, options.base ?? BASE);
  return { root, repositories: [root], inputs: defaultInputs(), dirs: {}, otherPaths: [] };
}

/** A's changes in the working tree: its directory, and two paths its `tasks.md` names. */
function applyOwnedChanges(root: string): void {
  writeFile(root, 'specs/A/spec.md', 'a spec\n');
  writeFile(root, 'src/a.ts', 'export const a = 2;\n');
  writeFile(root, 'src/a-new.ts', 'export const aNew = 1;\n');
}

/** B's changes in the working tree: one tracked, one staged, one untracked. */
function applyOtherChanges(root: string): void {
  writeFile(root, 'src/b.ts', 'export const b = 2;\n');
  writeFile(root, 'src/b-staged.ts', 'export const bStaged = 2;\n');
  git(root, ['add', '--', 'src/b-staged.ts']);
  writeFile(root, 'notes/b.md', 'b notes\n');
}

function withOther(workspace: FeatureWorkspace, otherPaths: readonly string[], inputs?: Partial<FixtureInputs>): FeatureWorkspace {
  return { ...workspace, otherPaths, inputs: { ...workspace.inputs, ...inputs } };
}

// Rows S1 to S3 (contract F2; US1): A and B share one checkout.

/** S1: A's owned changes beside B's tracked, staged and untracked ones. */
export function buildS1(): FeatureWorkspace {
  const workspace = createSingle('s1');
  applyOwnedChanges(workspace.root);
  applyOtherChanges(workspace.root);
  return withOther(workspace, S1_OTHER);
}

/** S2: as S1, with the shared pointer file changed to name B's directory (or A's, as the control). */
export function buildS2(pointerNames: 'B' | 'A' = 'B'): FeatureWorkspace {
  const workspace = buildS1();
  writeFile(workspace.root, '.specify/feature.json', `{"feature_directory":"specs/${pointerNames}","step":"implement"}\n`);
  return withOther(workspace, [...workspace.otherPaths, '.specify/feature.json']);
}

/** S3: as S1, plus a B file whose bytes a formatter would change (trailing spaces). */
export function buildS3(): FeatureWorkspace {
  const workspace = buildS1();
  writeFile(workspace.root, 'src/b-format.ts', 'export const bFormat = 2;   \n');
  return withOther(workspace, [...workspace.otherPaths, 'src/b-format.ts']);
}

// Rows U1 to U5 (contract F2; US2): one ambiguous case each, on S1's base.

/** U1: `src/mixed.ts` has two changed hunks, and the review finds only one tied to A. */
export function buildU1(): FeatureWorkspace {
  const workspace = createSingle('u1');
  applyOwnedChanges(workspace.root);
  applyOtherChanges(workspace.root);
  writeFile(workspace.root, 'src/mixed.ts', MIXED_BASE.replace('line 1\n', 'line 1 changed\n').replace('line 12\n', 'line 12 changed\n'));
  return withOther(workspace, S1_OTHER, { ties: { owned: [], mixed: ['src/mixed.ts'] } });
}

/** U2: `src/shared.ts` is named by both A's `tasks.md` and B's. */
export function buildU2(): FeatureWorkspace {
  const workspace = createSingle('u2');
  applyOwnedChanges(workspace.root);
  applyOtherChanges(workspace.root);
  writeFile(workspace.root, 'src/shared.ts', 'export const shared = 2;\n');
  return withOther(workspace, S1_OTHER);
}

/** U3: `src/a.ts` is staged, then changed again (`MM`). Without the second change it is only staged (`M `). */
export function buildU3(secondChange = true): FeatureWorkspace {
  const workspace = createSingle('u3');
  applyOwnedChanges(workspace.root);
  applyOtherChanges(workspace.root);
  git(workspace.root, ['add', '--', 'src/a.ts']);
  if (secondChange) writeFile(workspace.root, 'src/a.ts', 'export const a = 3;\n');
  return withOther(workspace, S1_OTHER);
}

/** U4: `src/orphan.ts` changed, named by no feature and tied to none. */
export function buildU4(): FeatureWorkspace {
  const workspace = createSingle('u4');
  applyOwnedChanges(workspace.root);
  applyOtherChanges(workspace.root);
  writeFile(workspace.root, 'src/orphan.ts', 'export const orphan = 2;\n');
  return withOther(workspace, S1_OTHER);
}

/** U5: `src/a.ts`, which A names, renamed to the unclaimed `src/moved.ts`. */
export function buildU5(): FeatureWorkspace {
  const workspace = createSingle('u5');
  writeFile(workspace.root, 'specs/A/spec.md', 'a spec\n');
  writeFile(workspace.root, 'src/a-new.ts', 'export const aNew = 1;\n');
  applyOtherChanges(workspace.root);
  git(workspace.root, ['mv', 'src/a.ts', 'src/moved.ts']);
  return withOther(workspace, S1_OTHER);
}

// Rows I1 to I8 (contract F2; US3): one repository with A's work committed, then a twist.

/** A's work committed on the feature branch: one change to `src/a.ts`, and its own file. */
function commitFeatureWork(root: string): void {
  commitFile(root, 'src/a.ts', 'export const a = 2;\n');
  commitFile(root, 'specs/A/spec.md', 'a spec\n');
}

/** I1: a clean merge, another session's untracked file, and (set by the runner) a stat-dirty file. */
export function buildI1(): FeatureWorkspace {
  const workspace = createSingle('i1');
  commitFeatureWork(workspace.root);
  writeFile(workspace.root, 'scratch/other.md', 'another session\n');
  return withOther(workspace, ['scratch/other.md']);
}

/**
 * I2: the checkout is on the target. Its `HEAD` is then the target's tip, so step 1 reads it as
 * already integrated and the checked-out refusal is never reached here; it is reached through a
 * second worktree (I3).
 */
export function buildI2(): FeatureWorkspace {
  const workspace = createSingle('i2');
  git(workspace.root, ['switch', '-q', BASE]);
  return workspace;
}

/** The directory `addSecondCheckout` makes: a sibling of the root, so it never shows in the root's status. */
function secondCheckoutPath(root: string): string {
  return join(dirname(root), `${basename(root)}-second`);
}

/**
 * Checks `branch` out in a second worktree of `repoDir`. `git worktree add` is forbidden as an
 * agent practice (hard rule 59); this builder runs it only on the throwaway repository the row
 * built, after asserting that the repository sits under the temp root.
 */
export function addSecondCheckout(repoDir: string, branch: string): string {
  if (!realpathSync(repoDir).startsWith(realpathSync(tmpdir()))) {
    throw new Error('i3: the repository is not under the temp root; refusing `git worktree add`');
  }
  const second = secondCheckoutPath(repoDir);
  git(repoDir, ['worktree', 'add', '-q', second, branch]);
  return second;
}

/** I3: the target checked out in a second worktree, made before any snapshot. */
export function buildI3(): FeatureWorkspace {
  const workspace = createSingle('i3');
  commitFeatureWork(workspace.root);
  const second = addSecondCheckout(workspace.root, BASE);
  return { ...workspace, repositories: [workspace.root, second], dirs: { second } };
}

/** I4: a detached `HEAD` at a commit the target lacks. */
export function buildI4(): FeatureWorkspace {
  const workspace = createSingle('i4');
  commitFeatureWork(workspace.root);
  git(workspace.root, ['switch', '-q', '--detach']);
  return workspace;
}

/** I5: the checkout on `develop` with an owned uncommitted path. */
export function buildI5(): FeatureWorkspace {
  const workspace = createSingle('i5');
  git(workspace.root, ['switch', '-q', BASE]);
  writeFile(workspace.root, 'specs/A/spec.md', 'a spec\n');
  return workspace;
}

/** I6a: base `release` declared, absent locally, with `origin/release` written as a ref. */
export function buildI6a(): FeatureWorkspace {
  const workspace = createSingle('i6a', { declare: [{ path: '.', base: 'release' }] });
  commitFeatureWork(workspace.root);
  git(workspace.root, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
  return workspace;
}

/** I6b: an envelope on `main` with no local `develop`, and one declared implementation repository. */
export function buildI6b(): FeatureWorkspace {
  const root = makeRoot('i6b');
  makeFeatureRepo(root, '.', { base: 'main' });
  writeFeatureDocs(root, 'A', { tasks: ['impl-a/src/impl-a.ts'] });
  const implementation = makeFeatureRepo(root, 'impl-a');
  addGitlink(root, 'impl-a', headOf(implementation));
  declareRepositories(root, [{ path: 'impl-a' }]);
  commitEverything(root, 'base');
  settleBase(root, 'main');
  commitFile(implementation, 'src/impl-a.ts', 'export const implA = 1;\n');
  commitFile(root, 'specs/A/spec.md', 'a spec\n');
  addGitlink(root, 'impl-a', headOf(implementation));
  return { root, repositories: [root, implementation], inputs: defaultInputs(), dirs: { 'impl-a': implementation }, otherPaths: [] };
}

/** I6c: I6b with a branch `develop/old` in the envelope, which `for-each-ref refs/heads/develop` also lists. */
export function buildI6c(): FeatureWorkspace {
  const workspace = buildI6b();
  git(workspace.root, ['branch', `${BASE}/old`, 'main']);
  return workspace;
}

/** I7:a conflicting change to the same line, on `develop` and on the feature branch. */
export function buildI7(): FeatureWorkspace {
  const workspace = createSingle('i7');
  commitFeatureWork(workspace.root);
  commitOnBranch(workspace.root, BASE, 'src/a.ts', 'export const a = 99;\n');
  return workspace;
}

/** I8: base `v1` declared, a tag `v1` at a commit that contains the source, and no branch `v1`. */
export function buildI8(): FeatureWorkspace {
  const workspace = createSingle('i8', { declare: [{ path: '.', base: 'v1' }] });
  commitFeatureWork(workspace.root);
  git(workspace.root, ['tag', 'v1', 'HEAD']);
  return workspace;
}

// Rows M, H, N and R (contract F2; US4, US5): an envelope with implementation repositories.

/** The implementation repositories' own feature file, and A's tasks naming them. */
const featureFile = (name: string): string => `src/${name}.ts`;

interface EnvelopeOptions {
  readonly declare: boolean;
  /** Named repositories that get feature commits and their gitlink recorded; the rest are untouched. */
  readonly touched?: readonly string[];
  /** Touched repositories whose new `HEAD` is not recorded in the envelope. */
  readonly leftStale?: readonly string[];
}

/**
 * An envelope root with `specs/` and the named repositories gitlinked into it. The base is
 * settled, then each touched repository gets a feature commit and the envelope records its new
 * `HEAD` as a gitlink (research R13), after a commit of A's own file.
 */
function createEnvelope(label: string, names: readonly string[], options: EnvelopeOptions): FeatureWorkspace {
  const root = makeRoot(label);
  makeFeatureRepo(root, '.');
  writeFeatureDocs(root, 'A', { tasks: names.map((name) => `${name}/${featureFile(name)}`) });
  writeFeatureDocs(root, 'B', { tasks: B_TASKS });
  const dirs: Record<string, string> = {};
  for (const name of names) {
    dirs[name] = makeFeatureRepo(root, name);
    addGitlink(root, name, headOf(dirs[name]));
  }
  if (options.declare) declareRepositories(root, names.map((path) => ({ path })));
  commitEverything(root, 'base');
  settleBase(root);

  const touched = options.touched ?? names;
  for (const name of touched) commitFile(dirs[name]!, featureFile(name), `export const ${name.replace('-', '')} = 1;\n`);
  commitFile(root, 'specs/A/spec.md', 'a spec\n');
  for (const name of touched.filter((candidate) => !(options.leftStale ?? []).includes(candidate))) {
    addGitlink(root, name, headOf(dirs[name]!));
  }
  return { root, repositories: [root, ...names.map((name) => dirs[name]!)], inputs: defaultInputs(), dirs, otherPaths: [] };
}

const TWO = ['impl-a', 'impl-b'] as const;

/** M1: two implementation repositories and the envelope, A's work committed in all, every check green. */
export function buildM1(): FeatureWorkspace {
  return createEnvelope('m1', TWO, { declare: true });
}

/** M2: M1 with a change on `impl-b`'s `develop` that conflicts with the feature's. */
export function buildM2(): FeatureWorkspace {
  const workspace = buildM1();
  commitOnBranch(workspace.dirs['impl-b']!, BASE, featureFile('impl-b'), 'export const implB = 99;\n');
  return workspace;
}

/** M3: M1 with the first repository's check set failing (an input). */
export function buildM3(): FeatureWorkspace {
  const workspace = buildM1();
  return { ...workspace, inputs: { ...workspace.inputs, checks: { 'impl-a': 'failing' } } };
}

/** M4: M1 with a `Status: needs-maintainer` decision, committed on the feature branch. */
export function buildM4(status = 'needs-maintainer'): FeatureWorkspace {
  const workspace = buildM1();
  writeDecision(workspace.root, FEATURE, status);
  return workspace;
}

/** H1: M1 with `impl-b`'s new `HEAD` not recorded in the envelope, so its gitlink is the older commit. */
export function buildH1(): FeatureWorkspace {
  return createEnvelope('h1', TWO, { declare: true, leftStale: ['impl-b'] });
}

/** The hook text of H2: it stamps the `repo/` `HEAD` as the workspace's own tooling does (research R14). */
const PREPARE_COMMIT_MSG = [
  '#!/bin/sh',
  '# Stamps the HEAD of repo/ on the envelope commit. The environment git sets for a hook is cleared first.',
  'unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX',
  'head=$(git -C repo rev-parse HEAD) || exit 0',
  'printf "\\nRepo-head: %s\\n" "$head" >> "$1"',
  ''
].join('\n');

/**
 * H2: the `repo/` layout (inferred, no declaration), `repo/` ignored by the envelope, and a
 * `prepare-commit-msg` hook in the envelope that appends `Repo-head:`. A's work is uncommitted, so
 * the harness's own commits run the hook. `stale` moves `repo/`'s `HEAD` after the envelope commit,
 * which `commitStale` does; this builder only prepares.
 */
export function buildH2(): FeatureWorkspace {
  const root = makeRoot('h2');
  makeFeatureRepo(root, '.');
  writeFeatureDocs(root, 'A', { tasks: ['repo/src/a.ts'] });
  writeFile(root, '.gitignore', '/repo/\n');
  const repoDir = makeFeatureRepo(root, 'repo');
  commitFile(repoDir, 'src/a.ts', 'export const a = 1;\n');
  commitEverything(root, 'base');
  settleBase(root);
  settleBase(repoDir);
  writeFile(repoDir, 'src/a.ts', 'export const a = 2;\n');
  writeFile(root, 'specs/A/spec.md', 'a spec\n');
  writeExecutable(join(root, '.git', 'hooks', 'prepare-commit-msg'), PREPARE_COMMIT_MSG);
  return { root, repositories: [root, repoDir], inputs: defaultInputs(), dirs: { repo: repoDir }, otherPaths: [] };
}

/** H2's stale variant: `repo/` gains a commit after the envelope's was made, so the trailer is old. */
export function moveImplementationHead(workspace: FeatureWorkspace): void {
  commitFile(workspace.dirs['repo']!, 'src/late.ts', 'export const late = 1;\n');
}

function writeExecutable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/**
 * A failed commit (FR-018): M1's repositories with A's work uncommitted in both, and a `pre-commit`
 * hook in the first that rejects every commit, so the first commit fails and the rest must not run.
 */
export function buildFailedCommit(): FeatureWorkspace {
  const workspace = createEnvelope('fc', TWO, { declare: true, touched: [] });
  for (const name of TWO) writeFile(workspace.dirs[name]!, featureFile(name), `export const ${name.replace('-', '')} = 1;\n`);
  writeExecutable(join(workspace.dirs['impl-a']!, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "rejected by the fixture" >&2\nexit 1\n');
  return workspace;
}

/** N1: A's commits on the source, nothing owned uncommitted: M1 itself is that state. */
export function buildN1(): FeatureWorkspace {
  return buildM1();
}

/** N3: M1 plus a declared `impl-c` the feature never touched, checked out on its base. */
export function buildN3(): FeatureWorkspace {
  const workspace = createEnvelope('n3', ['impl-a', 'impl-b', 'impl-c'], { declare: true, touched: TWO });
  git(workspace.dirs['impl-c']!, ['switch', '-q', BASE]);
  return workspace;
}

/** N2: M1 with `impl-a` unverifiable and the envelope without a check set (inputs). */
export function buildN2(): FeatureWorkspace {
  const workspace = buildM1();
  return { ...workspace, inputs: { ...workspace.inputs, checks: { 'impl-a': 'unverifiable', '.': 'no check set' } } };
}

/** N2's second variant: only the envelope has no check set. */
export function buildN2EnvelopeOnly(): FeatureWorkspace {
  const workspace = buildM1();
  return { ...workspace, inputs: { ...workspace.inputs, checks: { '.': 'no check set' } } };
}

/** R1: a declaration naming `../<sibling>`, an existing repository beside the root. */
export function buildR1(): FeatureWorkspace {
  const workspace = createSingle('r1');
  const sibling = `${basename(workspace.root)}-outside`;
  const outside = join(dirname(workspace.root), sibling);
  initRepo(outside);
  declareRepositories(workspace.root, [{ path: `../${sibling}` }]);
  commitEverything(workspace.root, 'declare');
  settleBase(workspace.root);
  applyOwnedChanges(workspace.root);
  return { ...workspace, repositories: [workspace.root, outside], dirs: { outside } };
}
