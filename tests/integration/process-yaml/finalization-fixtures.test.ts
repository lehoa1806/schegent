// FR-R4-F19 (feature 247, T012; contracts F2, F3 and F4; SC-001 to SC-006) — the shipped `finalize`
// and `integrate` instructions, run against fixture workspaces.
//
// The two Phases tell an agent how to find the repositories to finalize, which changed paths are
// this feature's, how to commit them, and how to move each target branch without touching a
// checkout. The pins in `speckit-finalization-authority.test.ts` hold that text still; this file
// runs it. Each row builds a small workspace under the vitest temp root, hands the shipped
// instruction to the harness, and checks what the instruction's own commands and decisions came
// to. The commands are the instruction's: nothing here types one, so a changed flag in the YAML
// changes what runs, and the controls B1 to B5 hand the harness a mutated copy to show it.
//
// Judgment is fixture input, never computed (research R18): which change the review ties to a
// task, which file mixes changes, and each repository's check result. The rows exercise the
// mechanics: the status reading, the column test, the claims by directory and by `tasks.md`, the
// pointer file, the commit, the preflight, the guard and the apply. Nothing here runs a live agent.

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyChanges,
  commitFeature,
  emitsClear,
  formatterArgv,
  HarnessError,
  integrate,
  listBranchChanges,
  readClaims,
  resolveRepositories,
  type CommandRun,
  type FeatureCommits,
  type IntegrateHooks,
  type IntegrationRecord,
  type ScopeFinding
} from '../../fixtures/finalization-harness';
import {
  buildFailedCommit,
  buildSecretBesideGitlink,
  buildH1,
  buildH2,
  buildI1,
  buildI2,
  buildI3,
  buildI4,
  buildI5,
  buildI6a,
  buildI6b,
  buildI6c,
  buildI7,
  buildI8,
  buildM1,
  buildM2,
  buildM3,
  buildM4,
  buildN1,
  buildN2,
  buildN2EnvelopeOnly,
  buildN3,
  buildR1,
  buildS1,
  buildS2,
  buildS3,
  buildU1,
  buildU2,
  buildU3,
  buildU4,
  buildU5,
  moveBranch,
  moveImplementationHead,
  OVERSIZE_BYTES,
  S1_OWNED,
  SECRET_PATHS,
  seedStatDirty,
  snapshot,
  worktreeCount,
  type FeatureWorkspace
} from '../../fixtures/finalization-workspaces';
import { resolveReviewScope, type ScopeResolution } from '../../fixtures/review-scope-harness';
import {
  buildE1,
  buildE2,
  buildE3,
  buildE4,
  buildE5,
  buildR1 as buildReviewR1,
  buildR2,
  buildR3,
  buildR4,
  buildR5,
  buildR6,
  buildR7,
  buildR8,
  buildW1,
  buildW2,
  buildW3,
  buildW4,
  buildW5,
  buildW6,
  buildW7,
  buildW8,
  git,
  headOf,
  type Snapshot,
  type Workspace
} from '../../fixtures/review-scope-workspaces';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

const example = loadExample();

/** The shipped instruction of a Phase, read inside each row so a missing Phase fails that row alone. */
const shipped = (phaseId: 'finalize' | 'integrate' | 'speckit-code-review'): string => instructionOf(phaseOf(example, phaseId));

/** The text with one clause swapped for another, in memory only. The clause must occur, and must change the text. */
function replaced(text: string, from: string, to: string): string {
  expect(text, `the clause "${from}" occurs in the shipped text`).toContain(from);
  const mutated = text.split(from).join(to);
  expect(mutated, 'the replacement changed the text').not.toBe(text);
  return mutated;
}

/**
 * A control: the row, run on a mutated copy, must fail by an assertion, and the assertion must be
 * the one the mutation breaks. A `HarnessError` means the mutation broke the text the harness
 * reads, not the behavior under test, so it is not a kill; an assertion about something else is a
 * kill for the wrong reason.
 */
function expectRowFails(id: string, reason: RegExp, row: () => void): void {
  let thrown: unknown;
  try {
    row();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${id}: the row fails on the mutated text`).toBeDefined();
  expect(thrown, `${id}: it fails by an assertion, not by the harness`).not.toBeInstanceOf(HarnessError);
  expect((thrown as Error).name, `${id}: the failure is an assertion`).toBe('AssertionError');
  expect((thrown as Error).message, `${id}: the assertion that failed is the one this mutation breaks`).toMatch(reason);
}

/** What an integration row measures: the record, and the checkouts before and after (F3). */
interface IntegrationRow {
  readonly workspace: FeatureWorkspace;
  readonly record: IntegrationRecord;
  readonly commits: FeatureCommits | null;
  readonly before: Snapshot;
  readonly after: Snapshot;
  readonly worktreesBefore: number;
  readonly worktreesAfter: number;
}

interface RowOptions {
  /** Run `finalize`'s commit first, as a Run does. */
  readonly commit?: boolean;
  readonly hooks?: IntegrateHooks;
  /** Runs after the commit and before the snapshot: a later change another session makes. */
  readonly between?: () => void;
  readonly finalize?: string;
  readonly integrate?: string;
}

/**
 * Takes F3's snapshot of every repository and counts worktrees before and after `integrate`,
 * with a stat-dirty file seeded in each so an index write would show (TA4).
 */
function runRow(workspace: FeatureWorkspace, options: RowOptions = {}): IntegrationRow {
  const commits = options.commit
    ? commitFeature(options.finalize ?? shipped('finalize'), workspace.root, workspace.inputs)
    : null;
  options.between?.();
  for (const repository of workspace.repositories) seedStatDirty(repository);
  const count = (): number => workspace.repositories.reduce((sum, repository) => sum + worktreeCount(repository), 0);
  const worktreesBefore = count();
  const before = snapshot(workspace.repositories);
  const record = integrate(options.integrate ?? shipped('integrate'), workspace.root, workspace.inputs, options.hooks);
  expectClearOnlyWhenSettled(record);
  const after = snapshot(workspace.repositories);
  return { workspace, record, commits, before, after, worktreesBefore, worktreesAfter: count() };
}

/** FR-024, every row: a record that would emit CLEAR has nothing withheld, handed off or uncommitted. */
function expectClearOnlyWhenSettled(record: IntegrationRecord): void {
  if (!emitsClear(record)) return;
  expect(record.withheld, 'CLEAR with something withheld').toEqual([]);
  for (const repository of record.repositories) {
    expect(repository.handOffs, `${repository.path}: CLEAR with a hand-off`).toEqual([]);
    expect(repository.ownedUncommitted, `${repository.path}: CLEAR with an owned path uncommitted`).toEqual([]);
    expect(['integrated', 'already integrated'], `${repository.path}: CLEAR with a repository not integrated`).toContain(repository.integration.result);
  }
}

/** Ref names to commits, from a snapshot's `for-each-ref` text. */
function refsOf(text: string): Map<string, string> {
  return new Map(
    text
      .split('\n')
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const [meta, name] = line.split('\t');
        return [name!, meta!.split(' ')[0]!];
      })
  );
}

interface MovedRef {
  readonly repo: string;
  readonly ref: string;
}

/**
 * F3 (FR-013, SC-003): every checkout's status, `HEAD`, branch and index bytes are as they were,
 * every ref is as it was except those the row expects to move, and no worktree was added.
 */
function expectChangedOnly(row: IntegrationRow, moved: readonly MovedRef[]): void {
  for (const dir of Object.keys(row.before)) {
    const before = row.before[dir]!;
    const after = row.after[dir]!;
    expect(after.status, `${dir}: status`).toBe(before.status);
    expect(after.head, `${dir}: HEAD`).toBe(before.head);
    expect(after.symbolicRef, `${dir}: branch`).toBe(before.symbolicRef);
    expect(after.indexSha256, `${dir}: index bytes`).toBe(before.indexSha256);
    const allowed = new Set(moved.filter(({ repo }) => repo === dir).map(({ ref }) => ref));
    const wasRefs = refsOf(before.refs);
    const nowRefs = refsOf(after.refs);
    for (const name of new Set([...wasRefs.keys(), ...nowRefs.keys()])) {
      if (allowed.has(name)) continue;
      expect(nowRefs.get(name), `${dir}: ${name}`).toBe(wasRefs.get(name));
    }
  }
  expect(row.worktreesAfter, 'no worktree was added').toBe(row.worktreesBefore);
}

/** The git subcommand of each logged run, `-C <path>` and `--no-optional-locks` skipped. */
function loggedSubcommands(log: readonly CommandRun[]): string[] {
  return log
    .filter(({ file }) => file === 'git')
    .map(({ argv }) => {
      let index = 0;
      while (argv[index] === '--no-optional-locks' || argv[index] === '-C') index += argv[index] === '-C' ? 2 : 1;
      return argv[index] ?? '';
    });
}

/** The runs of one subcommand, with the repository path each was run in. */
function runsOf(log: readonly CommandRun[], subcommand: string): Array<{ path: string; argv: readonly string[] }> {
  return log
    .filter(({ file, argv }) => file === 'git' && loggedSubcommands([{ file, argv, cwd: '' }])[0] === subcommand)
    .map(({ argv }) => ({ path: argv[argv.indexOf('-C') + 1] ?? '', argv }));
}

/** A row that refuses or withholds writes no ref, no merge object's commit and no commit anywhere. */
function expectNoWrites(log: readonly CommandRun[], id: string): void {
  const subcommands = loggedSubcommands(log);
  for (const verb of ['update-ref', 'commit', 'fetch', 'push', 'switch', 'checkout', 'merge', 'reset', 'stash']) {
    expect(subcommands, `${id}: no ${verb}`).not.toContain(verb);
  }
}

/** FR-003, SC-003: no git command the harness ran had a `-C` outside the workspace root. */
function expectInsideRoot(root: string, log: readonly CommandRun[], id: string): void {
  const inside = realpathSync(root);
  const outside = log
    .filter(({ file }) => file === 'git')
    .map(({ argv, cwd }) => resolve(cwd, argv[argv.indexOf('-C') + 1] ?? '.'))
    .filter((target) => {
      let physical = target;
      try {
        physical = realpathSync(target);
      } catch {
        // A path that does not exist cannot lead outside: the check is about where a command ran.
      }
      return physical !== inside && !physical.startsWith(`${inside}${sep}`);
    });
  expect(outside, `${id}: no command ran outside the workspace`).toEqual([]);
}

const targetRef = (repo: string): MovedRef => ({ repo, ref: 'refs/heads/develop' });
/** The commit a repository's `develop` held before `integrate` ran. */
const targetBefore = (row: IntegrationRow, repo: string): string | undefined => refsOf(row.before[repo]!.refs).get('refs/heads/develop');
const commitCount = (dir: string): number => Number(git(dir, ['rev-list', '--count', '--all']).trim());
const parentsOf = (dir: string, ref: string): string[] => git(dir, ['rev-list', '--parents', '-n', '1', ref]).trim().split(' ').slice(1);

const committedPaths = (root: string, commit: string): string[] =>
  git(root, ['show', '--name-only', '--format=', commit])
    .split('\n')
    .filter((line) => line !== '')
    .sort();

/** An owned, uncommitted file in the feature's directory: what finalize would commit on a branch. */
const writeLate = (root: string): void => {
  writeFileSync(join(root, 'specs/A/late.md'), 'late\n');
};

describe('the finalization Phases, run on fixture workspaces (FR-R4-F19)', () => {
  describe('F2.1: finalize resolves the same repositories as the review scope (D1, FR-001 to FR-003)', () => {
    const F18_WORKSPACES: ReadonlyArray<readonly [string, () => Workspace]> = [
      ['W1', buildW1],
      ['W2', buildW2],
      ['W3', buildW3],
      ['W4', buildW4],
      ['W5', buildW5],
      ['W6', buildW6],
      ['W7', buildW7],
      ['W8', buildW8],
      ['R1', buildReviewR1],
      ['R2', buildR2],
      ['R3', buildR3],
      ['R4', buildR4],
      ['R5', buildR5],
      ['R6', buildR6],
      ['R7', buildR7],
      ['R8', buildR8],
      ['E1', buildE1],
      ['E2', buildE2],
      ['E3', buildE3],
      ['E4', buildE4],
      ['E5', buildE5]
    ];

    /** Contract C3's one stated exception: a root gitlink moved by a commit, which only F18 reads. */
    const COMMITTED_GITLINK_EXCEPTION = new Set(['E4']);

    const REASON_OF_REVIEW: Readonly<Record<string, string>> = {
      'unresolved:missing': 'missing',
      'unresolved:outside': 'outside',
      'unresolved:not-top-level': 'not-top-level',
      'unresolved:no-base': 'no-base'
    };

    /** The envelope F19 adds: the root, when it is a repository top level and not itself a target. */
    function envelopeExpected(root: string, review: ScopeResolution): Array<{ path: string; base: string }> {
      const isTopLevel = ((): boolean => {
        try {
          return git(root, ['rev-parse', '--show-prefix']).trim() === '';
        } catch {
          return false;
        }
      })();
      return isTopLevel && !review.targets.some((target) => target.path === '.') ? [{ path: '.', base: 'develop' }] : [];
    }

    it.each(F18_WORKSPACES)('%s: the same targets and bases, or the same findings', (name, build) => {
      const workspace = build();
      const review = resolveReviewScope(shipped('speckit-code-review'), workspace.root);
      const resolution = resolveRepositories(shipped('finalize'), workspace.root);

      if (COMMITTED_GITLINK_EXCEPTION.has(name)) {
        // C3: F18 flags a root gitlink a commit moved; this block reads the status only, and the
        // spec reads committed work on the source branch as the feature's by construction.
        expect(review.findings, `${name}: F18 flags the committed gitlink`).toBeGreaterThan(0);
        expect(resolution.findings, `${name}: finalize resolves it`).toEqual([]);
        return;
      }

      if (review.findings === 0) {
        expect(resolution.findings, `${name}: no finding`).toEqual([]);
        const expected = [
          ...review.targets.map((target) => ({ path: target.path, base: target.base })),
          ...envelopeExpected(workspace.root, review)
        ];
        expect(resolution.repositories.map(({ path, base }) => ({ path, base })), `${name}: targets and bases`).toEqual(expected);
        for (const target of review.targets) {
          expect(resolution.repositories.find(({ path }) => path === target.path)?.mergeBase, `${name}: ${target.path} merge base`).toBe(target.mergeBase);
        }
        return;
      }

      expect(resolution.repositories, `${name}: nothing resolved`).toEqual([]);
      expect(resolution.findings.length, `${name}: findings`).toBeGreaterThan(0);
      const named = (findings: readonly ScopeFinding[]): Array<[string | null, string]> => findings.map(({ path, code }) => [path, code]);
      for (const target of review.targets.filter(({ state }) => state.startsWith('unresolved:'))) {
        expect(named(resolution.findings), `${name}: ${target.path}`).toContainEqual([target.path, REASON_OF_REVIEW[target.state]]);
      }
      for (const gitlink of review.gitlinks.filter(({ listing }) => listing === 'blocks-inference')) {
        expect(named(resolution.findings), `${name}: ${gitlink.path}`).toContainEqual([gitlink.path, 'gitlink-not-repository']);
      }
    });

    it('control: the committed-gitlink exception covers E4 alone, and F18 does flag it', () => {
      const covered = F18_WORKSPACES.filter(([name]) => COMMITTED_GITLINK_EXCEPTION.has(name)).map(([name]) => name);
      expect(covered).toEqual(['E4']);
      const workspace = buildE4();
      expect(resolveReviewScope(shipped('speckit-code-review'), workspace.root).findings).toBeGreaterThan(0);
    });
  });

  describe('a feature commit holds only that feature\'s work (US1, SC-001)', () => {
    /** B's state in the checkout: bytes, the staged entry, and which paths are untracked. */
    function observeOther(workspace: FeatureWorkspace): Record<string, { bytes: string; entry: string; untracked: boolean }> {
      return Object.fromEntries(
        workspace.otherPaths.map((path) => [
          path,
          {
            bytes: readFileSync(join(workspace.root, path), 'utf8'),
            entry: git(workspace.root, ['ls-files', '--stage', '--', path]),
            untracked: git(workspace.root, ['ls-files', '--others', '--', path]).trim() !== ''
          }
        ])
      );
    }

    /** Runs `finalize`'s commit on a workspace and checks the claim of S1, S2 and S3 for it. */
    function finalizeRow(instruction: string, workspace: FeatureWorkspace): { commits: FeatureCommits; paths: string[] } {
      const before = observeOther(workspace);
      const commits = commitFeature(instruction, workspace.root, workspace.inputs);
      expect(commits.findings, 'the scope resolved').toEqual([]);
      const commit = commits.repositories[0]?.outcome.committed;
      expect(commit, 'a commit was made').toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
      expect(observeOther(workspace), 'B\'s bytes, staged entry and untracked files are as they were').toEqual(before);
      return { commits, paths: committedPaths(workspace.root, commit!) };
    }

    const rowS1 = (instruction: string): void => {
      const { paths } = finalizeRow(instruction, buildS1());
      expect(paths, 'A\'s commit holds exactly A\'s owned set').toEqual([...S1_OWNED]);
    };

    it('S1: A\'s commit holds exactly A\'s owned set, and B\'s bytes, staged entry and files are unchanged', () => {
      rowS1(shipped('finalize'));
    });

    it('S2: a shared pointer naming B\'s directory is not committed, and is unchanged', () => {
      const workspace = buildS2('B');
      const { paths } = finalizeRow(shipped('finalize'), workspace);
      expect(paths).not.toContain('.specify/feature.json');
      expect(paths).toEqual([...S1_OWNED]);
    });

    it('S2 control: the same pointer naming A\'s directory is committed, so the pointer rule is live', () => {
      const { paths } = finalizeRow(shipped('finalize'), (() => {
        const workspace = buildS2('A');
        // The pointer is A's own now, so it is no longer among B's paths.
        return { ...workspace, otherPaths: workspace.otherPaths.filter((path) => path !== '.specify/feature.json') };
      })());
      expect(paths).toContain('.specify/feature.json');
    });

    it('S3: the formatter command names only owned paths, never a formatter-dirty B file', () => {
      const workspace = buildS3();
      const resolution = resolveRepositories(shipped('finalize'), workspace.root);
      const repository = resolution.repositories[0]!;
      const claims = readClaims(workspace.root, workspace.inputs.feature);
      const owned = classifyChanges(shipped('finalize'), workspace.root, repository, claims, workspace.inputs.ties, new Set())
        .filter(({ class: kind }) => kind === 'owned')
        .map(({ path }) => path);
      const argv = formatterArgv(shipped('finalize'), owned);
      expect(argv.slice(0, 4)).toEqual(['npx', 'prettier', '--write', '--']);
      expect(argv.slice(4).sort()).toEqual([...S1_OWNED]);
      expect(argv).not.toContain('src/b-format.ts');
      // Control: the B file really is formatter-dirty and really is in the checkout.
      expect(readFileSync(join(workspace.root, 'src/b-format.ts'), 'utf8')).toMatch(/ {3}\n$/);
      expect(git(workspace.root, ['status', '--porcelain']).includes('src/b-format.ts')).toBe(true);
    });

    it('S1: step 3\'s listing of the branch\'s files names the tracked changes and changes no byte of the index (FR-012)', () => {
      const workspace = buildS1();
      const [repository] = resolveRepositories(shipped('finalize'), workspace.root).repositories;
      for (const dir of workspace.repositories) seedStatDirty(dir);
      const before = snapshot(workspace.repositories);
      const listed = listBranchChanges(shipped('finalize'), workspace.root, repository!);
      expect(snapshot(workspace.repositories), 'the listing wrote nothing').toEqual(before);
      expect(listed).toEqual(expect.arrayContaining(['src/a.ts', 'src/b-staged.ts', 'src/b.ts']));
      // Control: an untracked file is not listed, so the list is the tracked changes the text promises.
      expect(listed).not.toContain('src/a-new.ts');
    });

    it('B3: with `commit -a -m <message>` for the pathspec commit, S1 fails because B\'s change is committed', () => {
      const mutated = replaced(shipped('finalize'), '`git -C <path> commit -m <message> -- <owned paths>`', '`git -C <path> commit -a -m <message>`');
      expectRowFails('B3', /staged entry|exactly A's owned set/, () => rowS1(mutated));
    });
  });

  describe('mixed or unclear ownership is handed off, never swept in (US2, SC-002)', () => {
    type Ambiguity = 'mixed' | 'two-features' | 'partially-staged' | 'unattributed' | 'rename-one-side';
    const U_ROWS: ReadonlyArray<readonly [string, () => FeatureWorkspace, string, Ambiguity, readonly string[]]> = [
      ['U1', buildU1, 'src/mixed.ts', 'mixed', ['src/mixed.ts']],
      ['U2', buildU2, 'src/shared.ts', 'two-features', ['src/shared.ts']],
      ['U3', () => buildU3(), 'src/a.ts', 'partially-staged', ['src/a.ts']],
      ['U4', buildU4, 'src/orphan.ts', 'unattributed', ['src/orphan.ts']],
      ['U5', buildU5, 'src/moved.ts', 'rename-one-side', ['src/moved.ts', 'src/a.ts']]
    ];

    /** A path's bytes (null when it is not in the working tree) and its staged index entry. */
    const observe = (workspace: FeatureWorkspace, path: string): { bytes: string | null; entry: string } => ({
      bytes: existsSync(join(workspace.root, path)) ? readFileSync(join(workspace.root, path), 'utf8') : null,
      entry: git(workspace.root, ['ls-files', '--stage', '--', path])
    });

    it.each(U_ROWS)('%s: the path is a hand-off with its reason, absent from the commit, its bytes and entry unchanged', (_name, build, path, reason, absent) => {
      const workspace = build();
      const before = observe(workspace, path);
      const commits = commitFeature(shipped('finalize'), workspace.root, workspace.inputs);
      const repository = commits.repositories[0]!;
      expect(repository.changes.find((change) => change.path === path), `${path} is classified`).toMatchObject({ class: 'ambiguous', reason });
      const paths = committedPaths(workspace.root, repository.outcome.committed!);
      for (const missing of absent) expect(paths, `${missing} is not committed`).not.toContain(missing);
      expect(paths, 'A\'s owned paths are committed').toContain('specs/A/spec.md');
      expect(observe(workspace, path), `${path}: bytes and index entry`).toEqual(before);
    });

    it.each(U_ROWS)('%s: followed through integrate, A\'s owned paths are committed and no ref moves (U6)', (name, build, path, reason) => {
      const row = runRow(build(), { commit: true });
      expect(row.commits!.repositories[0]!.outcome.committed, `${name}: A's paths are committed`).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
      expect(row.record.state).toBe('committed, not integrated');
      expect(row.record.withheld).toContain('hand-off');
      expect(row.record.repositories[0]!.handOffs).toContainEqual({ path, reason });
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, name);
    });

    it('control: U3 with only the first change (`M `) is owned, and committed', () => {
      const workspace = buildU3(false);
      const commits = commitFeature(shipped('finalize'), workspace.root, workspace.inputs);
      expect(commits.repositories[0]!.changes.find((change) => change.path === 'src/a.ts')).toMatchObject({ x: 'M', y: ' ', class: 'owned' });
      expect(committedPaths(workspace.root, commits.repositories[0]!.outcome.committed!)).toContain('src/a.ts');
    });

    it('control: U4 tied to A by the review is owned, and committed', () => {
      const workspace = buildU4();
      const tied = { ...workspace.inputs, ties: { owned: ['src/orphan.ts'], mixed: [] } };
      const commits = commitFeature(shipped('finalize'), workspace.root, tied);
      expect(committedPaths(workspace.root, commits.repositories[0]!.outcome.committed!)).toContain('src/orphan.ts');
    });
  });

  describe('integration touches no checkout, and each refusal is named and moves nothing (US3, SC-003, SC-004)', () => {
    const rowI1 = (integrateText: string): void => {
      const row = runRow(buildI1(), { integrate: integrateText });
      const root = row.workspace.root;
      expect(row.record.state).toBe('integrated');
      expect(emitsClear(row.record)).toBe(true);
      expectChangedOnly(row, [targetRef(root)]);
      expect(parentsOf(root, 'refs/heads/develop'), 'the merge\'s parents: the old target, then the source').toEqual([targetBefore(row, root), headOf(root)]);
      expect(readFileSync(join(root, 'scratch/other.md'), 'utf8'), 'another session\'s file is as it was').toBe('another session\n');
    };

    it('I1: a clean integration moves only the target ref, to a merge of the old target and the source', () => {
      rowI1(shipped('integrate'));
    });

    it('I2: the checkout on the target is already integrated, not refused, and nothing moves', () => {
      const row = runRow(buildI2());
      const root = row.workspace.root;
      expect(row.record.repositories[0]).toMatchObject({ source: 'develop', integration: { result: 'already integrated' }, commitField: { kind: 'no feature changes' } });
      expect(row.record.state).toBe('integrated');
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I2');
      // Control: the target really is checked out here, which a refusal would have named.
      expect(git(root, ['for-each-ref', '--format=%(objectname) %(worktreepath)', 'refs/heads/develop'])).toContain(root);
    });

    it('I3: a target checked out in a second worktree is refused, naming that path, and no ref moves', () => {
      const workspace = buildI3();
      const row = runRow(workspace);
      expect(row.record.repositories[0]!.integration).toMatchObject({ result: 'refused', reason: 'checked-out', detail: workspace.dirs['second'] });
      expect(row.record.state).toBe('committed, not integrated');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I3');
    });

    it('I4: a detached HEAD at a commit the target lacks is refused, and finalize commits nothing there', () => {
      const row = runRow(buildI4());
      expect(row.record.repositories[0]!.integration).toMatchObject({ result: 'refused', reason: 'detached' });
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I4');

      const detached = buildI4();
      writeLate(detached.root);
      const commits = commitFeature(shipped('finalize'), detached.root, detached.inputs);
      expect(commits.repositories[0]!.outcome).toEqual({ committed: null, skipped: 'detached' });
    });

    it('I5: the checkout on its target with an owned uncommitted path: nothing is committed, and integration is withheld', () => {
      const row = runRow(buildI5(), { commit: true });
      expect(row.commits!.repositories[0]!.outcome).toEqual({ committed: null, skipped: 'on-base' });
      expect(row.record.repositories[0]!.integration).toEqual({ result: 'already integrated' });
      expect(row.record.withheld).toContain('owned-uncommitted');
      expect(row.record.state).toBe('nothing committed');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I5');
    });

    it('I6a: a declared base that exists only as a remote-tracking ref leaves the scope unresolved: nothing is written, fetched or created', () => {
      const row = runRow(buildI6a(), { commit: true });
      const unresolved: ScopeFinding[] = [{ code: 'no-base', path: '.' }];
      expect(row.commits!.findings).toEqual(unresolved);
      expect(row.commits!.repositories, 'commitOwned is never reached').toEqual([]);
      expect(loggedSubcommands(row.commits!.log)).not.toContain('add');
      expect(loggedSubcommands(row.commits!.log)).not.toContain('commit');
      expect(row.record.findings).toEqual(unresolved);
      expect(row.record.state).toBe('nothing committed');
      expect(() => git(row.workspace.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/release'])).toThrow();
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I6a');
      expectNoWrites(row.commits!.log, 'I6a finalize');
    });

    it('I6b: the envelope\'s missing local develop is refused "no such local branch", and nothing moves in any repository', () => {
      const row = runRow(buildI6b());
      const envelope = row.record.repositories.find(({ path }) => path === '.')!;
      expect(envelope.integration).toMatchObject({ result: 'refused', reason: 'no-local-branch' });
      expect(row.record.repositories.find(({ path }) => path === 'impl-a')!.integration).toMatchObject({ result: 'withheld' });
      expect(row.record.state).toBe('committed, not integrated');
      expect(() => git(row.workspace.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/develop'])).toThrow();
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I6b');
    });

    it('I6c: a branch nested under the target\'s name is not the target: still "no such local branch", and nothing moves', () => {
      const row = runRow(buildI6c());
      const envelope = row.record.repositories.find(({ path }) => path === '.')!;
      expect(envelope.integration).toMatchObject({ result: 'refused', reason: 'no-local-branch' });
      expect(row.record.repositories.find(({ path }) => path === 'impl-a')!.integration).toMatchObject({ result: 'withheld' });
      expect(row.record.state).toBe('committed, not integrated');
      // Control: the nested branch exists, and the target does not.
      expect(git(row.workspace.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/develop']).trim()).toBe('refs/heads/develop/old');
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I6c');
    });

    it('I7: a conflicting merge is refused, listing the path and both commits, and no ref moves', () => {
      const row = runRow(buildI7());
      const root = row.workspace.root;
      const integration = row.record.repositories[0]!.integration;
      expect(integration).toMatchObject({ result: 'refused', reason: 'conflict' });
      const detail = integration.result === 'refused' ? integration.detail : '';
      expect(detail).toContain('src/a.ts');
      expect(detail).toContain(targetBefore(row, root)!);
      expect(detail).toContain(headOf(root));
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'I7');
    });

    const rowI8 = (integrateText: string): void => {
      const row = runRow(buildI8(), { integrate: integrateText });
      expect(row.record.repositories[0]!.integration, 'a tag is not a local branch, and is not read as already integrated').toMatchObject({ result: 'refused', reason: 'no-local-branch' });
      expectChangedOnly(row, []);
    };

    it('I8: a tag named as the base is refused "no such local branch", not read as already integrated', () => {
      rowI8(shipped('integrate'));
    });

    it('B2: with `refs/heads/` dropped from step 1\'s command, a tag is read as already integrated, so I8 fails', () => {
      const clause = '`git -C <path> merge-base --is-ancestor <source commit> refs/heads/<target>`';
      expectRowFails('B2', /not read as already integrated/, () => rowI8(replaced(shipped('integrate'), clause, clause.replace('refs/heads/<target>', '<target>'))));
    });

    it('B4: with `--no-optional-locks` dropped from the status command, the index is rewritten, so I1 fails', () => {
      const mutated = replaced(shipped('integrate'), '`git --no-optional-locks -C <path> status', '`git -C <path> status');
      expectRowFails('B4', /index bytes/, () => rowI1(mutated));
    });

    it('B5: with `-p <target commit>` dropped from commit-tree, the merge has one parent, so I1 fails', () => {
      const mutated = replaced(shipped('integrate'), 'commit-tree <tree> -p <target commit> -p <source commit>', 'commit-tree <tree> -p <source commit>');
      expectRowFails('B5', /parents/, () => rowI1(mutated));
    });
  });

  describe('a multi-repository finalize says exactly how far it got (US4, SC-005, SC-006)', () => {
    const implementationRefs = (workspace: FeatureWorkspace): MovedRef[] => [
      targetRef(workspace.root),
      targetRef(workspace.dirs['impl-a']!),
      targetRef(workspace.dirs['impl-b']!)
    ];

    it('M1: both implementation targets, then the envelope, are integrated, and the recorded HEADs equal the actual ones', () => {
      const workspace = buildM1();
      const row = runRow(workspace);
      expect(row.record.state).toBe('integrated');
      expect(emitsClear(row.record)).toBe(true);
      expect(runsOf(row.record.log, 'update-ref').map(({ path }) => path), 'implementation repositories first, the envelope last').toEqual(['impl-a', 'impl-b', '.']);
      expectChangedOnly(row, implementationRefs(workspace));
      for (const name of ['impl-a', 'impl-b']) {
        const dir = workspace.dirs[name]!;
        expect(git(workspace.root, ['ls-tree', 'HEAD', '--', name]), `${name}: the envelope records its HEAD`).toContain(headOf(dir));
        expect(parentsOf(dir, 'refs/heads/develop')[1], `${name}: the source is the second parent`).toBe(headOf(dir));
      }
      expect(parentsOf(workspace.root, 'refs/heads/develop')).toHaveLength(2);
      expectInsideRoot(workspace.root, row.record.log, 'M1');
    });

    it('M2: a conflict in the second repository moves no ref anywhere, and names the conflict', () => {
      const row = runRow(buildM2());
      expect(row.record.state).toBe('committed, not integrated');
      const implB = row.record.repositories.find(({ path }) => path === 'impl-b')!;
      expect(implB.integration).toMatchObject({ result: 'refused', reason: 'conflict' });
      expect(implB.integration.result === 'refused' ? implB.integration.detail : '').toContain('src/impl-b.ts');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'M2');
    });

    it('M3: a failing check set in the first repository integrates nothing', () => {
      const row = runRow(buildM3());
      expect(row.record.state).toBe('committed, not integrated');
      expect(row.record.withheld).toContain('check-failing');
      expect(row.record.repositories.find(({ path }) => path === 'impl-a')!.checks).toBe('failing');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'M3');
    });

    /** M5: another session moves the second target between preflight and apply. */
    const rowM5 = (integrateText: string): void => {
      const workspace = buildM1();
      const implA = workspace.dirs['impl-a']!;
      const implB = workspace.dirs['impl-b']!;
      const row = runRow(workspace, {
        integrate: integrateText,
        hooks: { beforeApply: (repository) => (repository.path === 'impl-b' ? moveBranch(implB, 'develop') : undefined) }
      });
      expect(row.record.state, 'M5: the first target moved and the second failed').toBe('partially integrated');
      expect(emitsClear(row.record)).toBe(false);
      const byPath = (path: string) => row.record.repositories.find((repository) => repository.path === path)!;
      expect(byPath('impl-a').integration.result).toBe('integrated');
      expect(byPath('impl-b').integration.result).toBe('failed');
      expect(byPath('.').integration.result).toBe('not attempted');

      const moved = byPath('impl-a').integration;
      const merge = moved.result === 'integrated' ? moved.newTarget : '';
      const oldTarget = targetBefore(row, implA)!;
      const compensating = ['-C', 'impl-a', 'update-ref', 'refs/heads/develop', oldTarget, merge];
      expect(row.record.compensating, 'the restoring command is recorded with the old and new commits').toEqual([{ path: 'impl-a', argv: compensating }]);
      expect(git(implA, ['rev-parse', 'refs/heads/develop']).trim(), 'and never run: the ref still holds the merge').toBe(merge);
      expect(runsOf(row.record.log, 'update-ref').map(({ argv }) => argv)).not.toContainEqual(compensating);
      expectChangedOnly(row, [targetRef(implA), targetRef(implB)]);
    };

    it('M5: the first target moved, the second failed: partially integrated, with the restoring command recorded and not run', () => {
      rowM5(shipped('integrate'));
    });

    it('B1: with the old and new commits swapped in step 5\'s apply, nothing is compare-and-swapped, so M5 fails', () => {
      const apply = '`git -C <path> update-ref refs/heads/<target> <merge> <target commit>`';
      const compensate = '`git -C <path> update-ref refs/heads/<target> <target commit> <merge>`';
      expectRowFails('B1', /first target moved and the second failed/, () => rowM5(replaced(shipped('integrate'), apply, compensate)));
    });

    it('H1: a gitlink left at an older commit is a recorded HEAD that differs, so integration is withheld', () => {
      const row = runRow(buildH1());
      expect(row.record.state).toBe('committed, not integrated');
      expect(row.record.withheld).toContain('recorded-head-differs');
      const [mismatch] = row.record.headMismatches;
      expect(mismatch).toMatchObject({ path: 'impl-b', actual: headOf(row.workspace.dirs['impl-b']!) });
      expect(mismatch!.recorded).not.toBe(mismatch!.actual);
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'H1');
    });

    it('H2: a trailer the envelope\'s hook stamped integrates when it matches repo/\'s HEAD, and withholds when it is stale', () => {
      const matching = buildH2();
      const row = runRow(matching, { commit: true });
      expect(row.commits!.repositories.map(({ path, outcome }) => [path, outcome.committed !== null])).toEqual([['repo', true], ['.', true]]);
      expect(git(matching.root, ['log', '-1', '--format=%B'])).toContain(`Repo-head: ${headOf(matching.dirs['repo']!)}`);
      expect(row.record.state).toBe('integrated');
      expectChangedOnly(row, [targetRef(matching.root), targetRef(matching.dirs['repo']!)]);

      const stale = buildH2();
      const staleRow = runRow(stale, { commit: true, between: () => moveImplementationHead(stale) });
      expect(staleRow.record.withheld).toContain('recorded-head-differs');
      expect(staleRow.record.headMismatches.map(({ path }) => path)).toEqual(['repo']);
      expect(staleRow.record.state).toBe('committed, not integrated');
      expectChangedOnly(staleRow, []);
    });

    it('N1: feature commits already on the source, nothing owned uncommitted: no new commit, integrated', () => {
      const workspace = buildN1();
      const heads = workspace.repositories.map((repository) => headOf(repository));
      const row = runRow(workspace, { commit: true });
      expect(row.commits!.repositories.map(({ outcome }) => outcome.skipped)).toEqual(['nothing-owned', 'nothing-owned', 'nothing-owned']);
      expect(workspace.repositories.map((repository) => headOf(repository))).toEqual(heads);
      expect(row.record.state).toBe('integrated');
      expect(emitsClear(row.record)).toBe(true);
    });

    it('N3: a declared repository the feature never touched is already integrated, with no feature changes, and does not block', () => {
      const workspace = buildN3();
      const row = runRow(workspace);
      const implC = row.record.repositories.find(({ path }) => path === 'impl-c')!;
      expect(implC).toMatchObject({ integration: { result: 'already integrated' }, commitField: { kind: 'no feature changes' } });
      expect(row.record.state).toBe('integrated');
      expectChangedOnly(row, [targetRef(workspace.root), targetRef(workspace.dirs['impl-a']!), targetRef(workspace.dirs['impl-b']!)]);
    });

    it('N4: a re-run after integrating finds every repository already integrated, and makes no commit', () => {
      const workspace = buildM1();
      runRow(workspace);
      const commitsBefore = workspace.repositories.map(commitCount);
      const rerun = runRow(workspace);
      expect(rerun.record.repositories.map(({ integration }) => integration.result)).toEqual(['already integrated', 'already integrated', 'already integrated']);
      expect(rerun.record.state).toBe('integrated');
      expect(workspace.repositories.map(commitCount)).toEqual(commitsBefore);
      expect(loggedSubcommands(rerun.record.log)).not.toContain('commit-tree');
      expectChangedOnly(rerun, []);
      expectNoWrites(rerun.record.log, 'N4');
    });

    it('FR-018: a failed commit stops every later commit and every integration', () => {
      const workspace = buildFailedCommit();
      const row = runRow(workspace, { commit: true });
      expect(row.commits!.repositories.map(({ path, outcome }) => [path, outcome.skipped])).toEqual([
        ['impl-a', 'failed'],
        ['impl-b', 'after-failed-commit'],
        ['.', 'after-failed-commit']
      ]);
      expect(runsOf(row.commits!.log, 'commit'), 'only the first commit was tried').toHaveLength(1);
      expect(row.record.withheld).toContain('owned-uncommitted');
      expect(row.record.state).toBe('committed, not integrated');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'FR-018 integrate');
    });

    it('R1: an unresolved scope commits nothing and integrates nothing', () => {
      const row = runRow(buildR1(), { commit: true });
      expect(row.commits!.findings.map(({ code }) => code)).toEqual(['outside']);
      expect(row.commits!.repositories, 'commitOwned is never reached').toEqual([]);
      expect(loggedSubcommands(row.commits!.log)).not.toContain('add');
      expect(row.record.state).toBe('nothing committed');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'R1');
      expectNoWrites(row.commits!.log, 'R1 finalize');
      // FR-003: the repository the declaration named is outside, and no git command was run there.
      expectInsideRoot(row.workspace.root, row.record.log, 'R1 integrate');
      expectInsideRoot(row.workspace.root, row.commits!.log, 'R1 finalize');
    });
  });

  describe('the merge guard holds under isolation (US5)', () => {
    it('M4: a needs-maintainer decision withholds every integration, and a decided one does not (US5-1, US5-2)', () => {
      const row = runRow(buildM4());
      expect(row.record.state).toBe('committed, not integrated');
      expect(row.record.withheld).toContain('needs-maintainer');
      expect(readFileSync(join(row.workspace.root, 'specs/A/decisions.md'), 'utf8')).toContain('Status: needs-maintainer');
      expect(emitsClear(row.record)).toBe(false);
      expectChangedOnly(row, []);
      expectNoWrites(row.record.log, 'M4');

      // Control: the same workspace with the entry decided integrates.
      const decided = runRow(buildM4('decided'));
      expect(decided.record.state).toBe('integrated');
    });

    it('N2: an unverifiable implementation repository withholds every integration; an envelope with no check set does not block', () => {
      const withheld = runRow(buildN2());
      expect(withheld.record.withheld).toContain('check-unverifiable');
      expect(withheld.record.repositories.find(({ path }) => path === 'impl-a')!.checks).toBe('unverifiable');
      expect(withheld.record.repositories.find(({ path }) => path === '.')!.checks).toBe('no check set');
      expect(withheld.record.state).toBe('committed, not integrated');
      expectChangedOnly(withheld, []);
      expectNoWrites(withheld.record.log, 'N2');

      const integrated = runRow(buildN2EnvelopeOnly());
      expect(integrated.record.repositories.find(({ path }) => path === '.')!.checks).toBe('no check set');
      expect(integrated.record.state).toBe('integrated');
    });
  });

  // FR-R5-F19 (spec 278, T036, US4; FR-015 to FR-022). The harness is deterministic: it runs the
  // shipped commands, and the classification and refusal decisions are this file's reading of the
  // prose. So these rows build the workspace the clause is about, check that it is what it claims,
  // and then check that the shipped text says what the row needs it to say; each has a control that
  // removes the clause and must fail the same check.
  describe('prompt conflicts are resolved without relaxing commit safety (FR-R5-F19, US4)', () => {
    const PHASES = ['finalize', 'integrate'] as const;
    const GITLINK_ALTERNATIVE = 'the changed gitlink of a repository with feature work';
    const NO_FEATURE_CLAUSE = 'or claimed by no feature, other than the changed gitlink of a repository with feature work.';
    const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'] as const;

    const bulletOf = (text: string, name: 'ambiguous' | 'owned'): string => {
      const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(`- ${name}:`));
      expect(lines, `exactly one "${name}" bullet`).toHaveLength(1);
      return lines.at(0) ?? '';
    };

    /** Whether the bullet that runs first sends the changed gitlink of a repository with feature work to `ambiguous`. */
    const gitlinkIsAmbiguous = (text: string): boolean => {
      const ambiguous = bulletOf(text, 'ambiguous');
      const clause = ambiguous.slice(ambiguous.indexOf('claimed by no feature'));
      return !clause.includes(GITLINK_ALTERNATIVE);
    };

    const recordedSha = (root: string, path: string): string => git(root, ['ls-files', '--stage', '--', path]).split(/\s+/).at(1) ?? '';

    it.each(PHASES)('%s: the first-match order no longer sends the changed gitlink of a repository with feature work to ambiguous (FR-015)', (phaseId) => {
      const text = shipped(phaseId);

      expect(bulletOf(text, 'owned')).toContain(GITLINK_ALTERNATIVE);
      expect(bulletOf(text, 'ambiguous')).toContain(NO_FEATURE_CLAUSE);
      expect(gitlinkIsAmbiguous(text), `${phaseId}: the gitlink reaches owned`).toBe(false);
    });

    it('control: the clause as it stood sends the changed gitlink to ambiguous, so the reading above can fail', () => {
      const before = replaced(shipped('finalize'), NO_FEATURE_CLAUSE, 'or claimed by no feature.');
      expect(gitlinkIsAmbiguous(before)).toBe(true);
    });

    it('W8: a declared gitlink with a real new commit is a changed gitlink only the explicit flag shows', () => {
      const { root } = buildW8();
      const resolution = resolveRepositories(shipped('finalize'), root);
      const delta = join(root, 'delta');

      expect(resolution.findings).toEqual([]);
      expect(resolution.repositories.map(({ path }) => path)).toContain('delta');
      // The recorded SHA is the old commit; the nested HEAD is the new one: tracked content changed.
      expect(recordedSha(root, 'delta')).not.toBe(headOf(delta));
      expect(git(root, [...STATUS_ARGS]).split('\n')).toContain(' M delta');
      // The root's `diff.ignoreSubmodules=all` hides it from a plain status, as in W7.
      expect(git(root, ['status', '--porcelain']).split('\n')).not.toContain(' M delta');
    });

    it('control: W7\'s gitlink changed only by an untracked file, so its recorded SHA is still the nested HEAD', () => {
      const { root } = buildW7();
      expect(recordedSha(root, 'gamma')).toBe(headOf(join(root, 'gamma')));
    });

    it('S-gitlink: an untracked credential and an oversize file beside an owned gitlink change are refused by the shipped text (FR-017)', () => {
      const { root } = buildSecretBesideGitlink();
      const lines = git(root, [...STATUS_ARGS]).split('\n');

      expect(lines).toContain(' M delta');
      expect(lines).toContain(`?? ${SECRET_PATHS.credential}`);
      expect(lines).toContain(`?? ${SECRET_PATHS.oversize}`);
      expect(statSync(join(root, SECRET_PATHS.oversize)).size).toBe(OVERSIZE_BYTES);

      const refuses = (text: string): boolean =>
        text.includes('Before committing, list the untracked owned paths') &&
        text.includes('any that looks like a credential, key or token file') &&
        text.includes('or exceeds 1 MiB') &&
        text.includes('an owned gitlink change does not excuse it');
      expect(refuses(shipped('finalize'))).toBe(true);
      for (const clause of ['a credential, key or token file', 'or exceeds 1 MiB', 'an owned gitlink change does not excuse it']) {
        expect(refuses(replaced(shipped('finalize'), clause, 'x')), `without "${clause}"`).toBe(false);
      }
    });

    it('S-gitlink: the size default is written once, and the mechanism is stated as prompt-only with its backstop', () => {
      const text = shipped('finalize');

      expect(text.split('1 MiB')).toHaveLength(2);
      expect(text).toContain('Prompt-only');
      expect(text).toContain('the post-commit tracked-files scan is the backstop');
      // Integrate never commits, so it carries no copy of the clause.
      expect(shipped('integrate')).not.toContain('1 MiB');
    });

    it('C1: a test that pins behavior the requirements now change is handed off, not edited to pass (FR-019)', () => {
      const clause = 'A test that pins behavior the requirements now change is not edited to pass';
      const text = shipped('finalize');

      expect(text).toContain(clause);
      expect(text).toContain('Do NOT mask failures');
      expect(replaced(text, clause, 'x')).not.toContain(clause);
    });

    it('D1: a dependency advisory gets only the limited repair, or is reported (FR-019, FR-020, FR-022)', () => {
      const text = shipped('finalize');
      const bounds = [
        'a dependency the feature did not add or change',
        'by patch or minor versions only, with a targeted command that does not force',
        'Change at most three packages in all',
        'already holds a change that is not owned, do not apply it; report the advisory',
        'Nor over uncommitted owned edits',
        'If a check that was green before the change now fails, undo the commit with git revert and report the advisory'
      ];
      const bans = [
        'a major version bump',
        'an overrides, resolutions or constraints entry',
        'a forced or blanket update, such as `npm audit fix`',
        'any change to the audit command, its threshold, its ignore list or a waiver',
        'Do not edit unrelated code to silence it'
      ];

      for (const phrase of [...bounds, ...bans]) expect(text, phrase).toContain(phrase);
      for (const phrase of bans) expect(replaced(text, phrase, 'x'), phrase).not.toContain(phrase);
    });

    it('the mixed, partially staged and shared-path refusals keep their clauses beside the new exception', () => {
      for (const phaseId of PHASES) {
        const ambiguous = bulletOf(shipped(phaseId), 'ambiguous');
        for (const clause of ['claimed by this feature and another', 'both status columns letters (partially staged)', 'mixing a change tied to this feature with one that is not', 'a rename with one side not owned']) {
          expect(ambiguous, `${phaseId}: ${clause}`).toContain(clause);
        }
        expect(shipped(phaseId), `${phaseId}: shared pointers`).toContain('.specify/feature.json and other shared pointers are owned only while naming <feature_dir>');
      }
    });
  });
});
