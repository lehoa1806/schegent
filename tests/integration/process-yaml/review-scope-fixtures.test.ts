// FR-R4-F18 (feature 246, T013; contract F2, F3; SC-001, SC-004) — the review scope block, run
// against fixture workspaces.
//
// The two review Phases tell the agent how to find the repositories to review. The pins in
// `speckit-review-scope-authority.test.ts` hold that text still; this file runs it. Each row builds
// a small workspace under the vitest temp root, hands the review's shipped instruction to the
// harness, and checks what the block's own commands and decisions came to. The commands are the
// instruction's: nothing here types one, so a changed flag in the YAML changes what runs.
//
// Every row runs on both Phases, and every row checks that discovery changed nothing: one tracked
// file in each repository is given a newer mtime first, so a command that refreshes the index
// would rewrite its bytes, and the status, `HEAD`, refs and index bytes taken before and after
// must be equal (SC-004).

import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveReviewScope,
  type CommandRun,
  type ScopeResolution
} from '../../fixtures/review-scope-harness';
import {
  buildW1,
  buildW2,
  buildW3,
  buildW4,
  buildW5,
  buildW6,
  buildW7,
  buildR1,
  buildR2,
  buildR3,
  buildR4,
  buildR5,
  buildR6,
  buildR7,
  buildR8,
  buildE1,
  buildE2,
  buildE3,
  buildE4,
  buildE5,
  git,
  makeRoot,
  seedStatDirty,
  snapshot,
  type Snapshot,
  type Workspace
} from '../../fixtures/review-scope-workspaces';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

const REVIEW_PHASES = ['speckit-code-review', 'speckit-security-review'] as const;
type ReviewPhase = (typeof REVIEW_PHASES)[number];

const COMMIT_SHA = /^[0-9a-f]{40}$/;

interface Row {
  readonly workspace: Workspace;
  readonly result: ScopeResolution;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

const example = loadExample();
const shippedInstruction = (phaseId: ReviewPhase): string => instructionOf(phaseOf(example, phaseId));

/**
 * Builds the row's workspace, seeds the stat-dirty file, resolves the scope with `instruction`
 * and returns both snapshots. The harness is called here and in the H controls, nowhere else.
 */
function resolveRow(build: () => Workspace, instruction: string): Row {
  const workspace = build();
  for (const repository of workspace.repositories) seedStatDirty(repository);
  const before = snapshot(workspace.repositories);
  const result = resolveReviewScope(instruction, workspace.root);
  const after = snapshot(workspace.repositories);
  return { workspace, result, before, after };
}

/** A row on a Phase's shipped text, with SC-004's check that nothing was written. */
function runRow(phaseId: ReviewPhase, build: () => Workspace): Row {
  const row = resolveRow(build, shippedInstruction(phaseId));
  expect(row.after, `${phaseId}: resolving the scope changed a repository`).toEqual(row.before);
  return row;
}

/** The paths a fixture's AGENTS.md declares, read here and not by the harness (SC-003's oracle). */
function declaredPaths(root: string): string[] {
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  return [...text.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]!);
}

/** Every `git` command of the log whose `-C` value, taken from its cwd, resolves outside `root`. */
function gitRunsOutside(root: string, log: readonly CommandRun[]): CommandRun[] {
  const inside = realpathSync(root);
  return log.filter((run) => {
    if (run.file !== 'git') return false;
    const target = resolve(run.cwd, run.argv[run.argv.indexOf('-C') + 1] ?? '.');
    let physical = target;
    try {
      physical = realpathSync(target);
    } catch {
      // A path that does not exist cannot lead outside: the check is about where a command ran.
    }
    return physical !== inside && !physical.startsWith(`${inside}${sep}`);
  });
}

describe('the review scope block, run on fixture workspaces (FR-R4-F18)', () => {
  describe.each(REVIEW_PHASES)('%s', (phaseId) => {
    describe('a declaration names the repositories (US1, SC-001)', () => {
      it('W5: both declared repositories are targets, though the root diff holds no source', () => {
        const { result } = runRow(phaseId, buildW5);
        expect(result.source).toBe('declaration');
        expect(result.wholeScope).toBe('resolved');
        expect(result.targets.map((target) => target.path)).toEqual(['alpha', 'beta']);
        for (const target of result.targets) {
          expect(target.base, `${target.path} base`).toBe('develop');
          expect(target.mergeBase, `${target.path} merge base`).toMatch(COMMIT_SHA);
          expect(target.state, `${target.path} state`).toBe('resolved');
        }
        expect(result.targets.find((target) => target.path === 'alpha')?.changedTracked).toEqual(['src/alpha.ts']);
        expect(result.targets.find((target) => target.path === 'beta')?.changedTracked).toEqual(['src/beta.ts']);
        expect(result.findings).toBe(0);
      });

      it('W6: a declared repository with no feature change is reported so, and alpha is still reviewed', () => {
        const { result } = runRow(phaseId, buildW6);
        const states = Object.fromEntries(result.targets.map((target) => [target.path, target.state]));
        expect(states).toEqual({ alpha: 'resolved', beta: 'no-feature-changes' });
        expect(result.findings).toBe(0);
      });

      it('W7: a changed gitlink the declaration omits is listed, not reviewed and not counted (FR-013a)', () => {
        const { result } = runRow(phaseId, buildW7);
        expect(result.targets.map((target) => target.path)).toEqual(['alpha', 'beta']);
        expect(result.gitlinks.find((gitlink) => gitlink.path === 'gamma')).toEqual({
          path: 'gamma',
          container: '.',
          listing: 'changed-not-declared'
        });
        expect(result.findings).toBe(0);
      });
    });

    describe('with no declaration, today\'s layouts still resolve to one target (US2, SC-002)', () => {
      it('W1: a standalone repository is the target, with its untracked source file listed', () => {
        const { result } = runRow(phaseId, buildW1);
        expect(result.source).toBe('inference');
        expect(result.targets).toMatchObject([
          { path: '.', changedTracked: ['src/a.ts'], untracked: ['src/new.ts'] }
        ]);
      });

      it('W2: the envelope resolves to repo, and Spec Kit files stay out of both lists', () => {
        const { workspace, result } = runRow(phaseId, buildW2);
        expect(result.source).toBe('inference');
        expect(result.targets).toMatchObject([{ path: 'repo', changedTracked: ['src/b.ts'], untracked: [] }]);
        // Control: the exclusion is live. Git does see the Spec Kit files inside repo/.
        const repoStatus = git(join(workspace.root, 'repo'), [
          '--no-optional-locks',
          'status',
          '--porcelain',
          '--untracked-files=all'
        ]);
        expect(repoStatus).toContain('specs/x.md');
        expect(repoStatus).toContain('.specify/y.md');
      });

      it('W2 control: with specs/ gone from the root, the root is the target, so the layout read is live', () => {
        const withoutSpecs = (): Workspace => {
          const workspace = buildW2();
          rmSync(join(workspace.root, 'specs'), { recursive: true });
          return workspace;
        };
        const { result } = runRow(phaseId, withoutSpecs);
        expect(result.targets.map((target) => target.path)).toEqual(['.']);
      });

      it('W3: a repo/ that is a linked worktree, whose .git is a file, is still the target', () => {
        const { workspace, result } = runRow(phaseId, buildW3);
        expect(result.source).toBe('inference');
        expect(result.targets.map((target) => target.path)).toEqual(['repo']);
        expect(result.targets[0]?.state).toBe('resolved');
        // Control: repo/.git is a file, not a directory, so a `test -d .git` rule would miss it.
        expect(git(join(workspace.root, 'repo'), ['rev-parse', '--git-dir'])).toContain('worktrees');
      });

      it('W4: an unchanged gitlink is listed as not reviewed, and does not block', () => {
        const { result } = runRow(phaseId, buildW4);
        expect(result.targets.map((target) => target.path)).toEqual(['.']);
        expect(result.gitlinks).toEqual([{ path: 'vendor/lib', container: '.', listing: 'not-reviewed' }]);
        expect(result.findings).toBe(0);
      });
    });

    describe('each refusal is a named, counted finding, and nothing is substituted (US3, SC-003)', () => {
      const states = (result: ScopeResolution): Record<string, string> =>
        Object.fromEntries(result.targets.map((target) => [target.path, target.state]));

      /** SC-003: no target the declaration did not name, and at least one finding. */
      const expectRefusal = (workspace: Workspace, result: ScopeResolution): void => {
        expect(result.findings).toBeGreaterThanOrEqual(1);
        const declared = declaredPaths(workspace.root);
        for (const target of result.targets) {
          expect(declared, `${target.path} is not a declared entry`).toContain(target.path);
        }
      };

      it('R1: a missing target is unresolved, and the valid one beside it is still reviewed', () => {
        const { workspace, result } = runRow(phaseId, buildR1);
        expect(states(result)).toEqual({ missing: 'unresolved:missing', alpha: 'resolved' });
        expect(result.findings).toBe(1);
        expectRefusal(workspace, result);
      });

      it('R2: an absolute path to a repository outside the root is unresolved, and nothing ran there', () => {
        const { workspace, result } = runRow(phaseId, buildR2);
        const [outside] = workspace.repositories;
        expect(states(result)).toEqual({ [outside!]: 'unresolved:outside' });
        expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
        expectRefusal(workspace, result);
      });

      it('R3: a symlink to a repository outside the root is unresolved, and no git ran there', () => {
        const { workspace, result } = runRow(phaseId, buildR3);
        expect(states(result)).toEqual({ link: 'unresolved:outside' });
        expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
        expectRefusal(workspace, result);
      });

      it('E3: a path leading outside the root through .. is unresolved, and nothing ran there', () => {
        const { workspace, result } = runRow(phaseId, buildE3);
        expect(result.targets.map((target) => target.state)).toEqual(['unresolved:outside']);
        expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
        expectRefusal(workspace, result);
      });

      it('control: the outside check flags a git command that ran at an outside path', () => {
        const { workspace } = runRow(phaseId, buildR2);
        const [outside] = workspace.repositories;
        const log: CommandRun[] = [{ file: 'git', argv: ['-C', outside!, 'status'], cwd: workspace.root }];
        expect(gitRunsOutside(workspace.root, log)).toHaveLength(1);
      });

      it('R4: a plain directory inside a repository is not a repository top level', () => {
        const { workspace, result } = runRow(phaseId, buildR4);
        expect(states(result)).toEqual({ 'alpha/src': 'unresolved:not-top-level' });
        expectRefusal(workspace, result);
      });

      it('E1: a .git file that points at a missing directory is not a repository top level', () => {
        const { workspace, result } = runRow(phaseId, buildE1);
        expect(states(result)).toEqual({ broken: 'unresolved:not-top-level' });
        expectRefusal(workspace, result);
      });

      it('R5: a target with no local develop has no base, and no remote-tracking ref or fetch is tried', () => {
        const { workspace, result } = runRow(phaseId, buildR5);
        expect(states(result)).toEqual({ alpha: 'unresolved:no-base' });
        const named = result.log.filter((run) => run.argv.some((word) => word.includes('origin/') || word === 'fetch'));
        expect(named).toEqual([]);
        expectRefusal(workspace, result);
      });

      it('E2: a main-only repository with no declaration has no base, and nothing is substituted', () => {
        const { result } = runRow(phaseId, buildE2);
        expect(states(result)).toEqual({ '.': 'unresolved:no-base' });
        expect(result.findings).toBe(1);
        expect(result.log.filter((run) => run.argv.some((word) => word === 'main' || word === 'fetch'))).toEqual([]);
      });

      it('R6: two entries at one location leave the whole scope unresolved, with no target', () => {
        const { result } = runRow(phaseId, buildR6);
        expect(result.wholeScope).toBe('conflicting');
        expect(result.targets).toEqual([]);
        expect(result.findings).toBe(1);
      });

      it('R7: an entry with a space in its path is malformed, and no command is run', () => {
        const { result } = runRow(phaseId, buildR7);
        expect(result.wholeScope).toBe('malformed');
        expect(result.targets).toEqual([]);
        expect(result.findings).toBe(1);
        expect(result.log).toEqual([]);
      });

      it('R8: with no declaration, a changed gitlink inside the inferred repository blocks the scope', () => {
        const { result } = runRow(phaseId, buildR8);
        expect(result.wholeScope).toBe('blocked-by-gitlink');
        expect(result.targets).toEqual([]);
        expect(result.gitlinks).toEqual([{ path: 'vendor/lib', container: '.', listing: 'blocks-inference' }]);
        expect(result.findings).toBe(1);
      });

      it('E4: a pointer moved in a commit blocks the scope, though status shows the checkout clean', () => {
        const { workspace, result } = runRow(phaseId, buildE4);
        // The root's config hides submodule changes from a plain listing; only the flag shows this one.
        const quiet = git(workspace.root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
        expect(quiet, 'status shows nothing for the clean gitlink').not.toContain('vendor/lib');
        expect(result.wholeScope).toBe('blocked-by-gitlink');
        expect(result.targets).toEqual([]);
        expect(result.gitlinks).toEqual([{ path: 'vendor/lib', container: '.', listing: 'blocks-inference' }]);
        expect(result.findings).toBe(1);
      });

      it('E5: with no declaration and no repository, there is no layout, and nothing is reviewed', () => {
        const { result } = runRow(phaseId, buildE5);
        expect(result.wholeScope).toBe('no-layout');
        expect(result.targets).toEqual([]);
        expect(result.findings).toBe(1);
      });
    });

    describe('discovery leaves every checkout as it found it (US4, SC-004)', () => {
      it('F3.3 W1: an untracked source file is listed, and stays untracked', () => {
        const { workspace, result, after } = runRow(phaseId, buildW1);
        expect(result.targets).toMatchObject([{ untracked: ['src/new.ts'] }]);
        expect(after[workspace.root]).toMatchObject({ status: expect.stringContaining('? src/new.ts') });
      });
    });

    describe('the fixtures run the shipped commands, not a copy (FR-026)', () => {
      const instruction = shippedInstruction(phaseId);

      /** Applies one change to the shipped text. The old text must occur once, so a stale control fails. */
      const mutated = (id: string, oldText: string, newText: string): string => {
        expect(instruction.split(oldText), `${id}: the old text occurs once`).toHaveLength(2);
        const text = instruction.replace(oldText, () => newText);
        expect(text, `${id}: the mutation changed the text`).not.toBe(instruction);
        return text;
      };

      /** The row's snapshot of `repository` before and after the mutated command ran. */
      const indexHashes = (row: Row, repository: string): [before: string, after: string] => [
        row.before[repository]!.indexSha256,
        row.after[repository]!.indexSha256
      ];

      it('control: the unmutated text leaves the index bytes of W1 as they were', () => {
        const row = resolveRow(buildW1, instruction);
        const [before, after] = indexHashes(row, row.workspace.root);
        expect(after).toBe(before);
      });

      it('B1: a status without --no-optional-locks rewrites the index, and the snapshot shows it', () => {
        const text = mutated(
          'B1',
          'git --no-optional-locks -C <path> status --porcelain',
          'git -C <path> status --porcelain'
        );
        const row = resolveRow(buildW1, text);
        const [before, after] = indexHashes(row, row.workspace.root);
        expect(after).not.toBe(before);
      });

      it('B2: a working-tree diff in place of the tree-to-tree one rewrites the index, and the snapshot shows it', () => {
        const text = mutated('B2', '--ignore-submodules=none <merge-base> HEAD', '--ignore-submodules=none <merge-base>');
        const row = resolveRow(buildW1, text);
        const [before, after] = indexHashes(row, row.workspace.root);
        expect(after).not.toBe(before);
      });

      it('B3: a status without --ignore-submodules=none misses the gitlink W7 changed, and the row shows it', () => {
        const text = mutated('B3', '--untracked-files=all --ignore-submodules=none', '--untracked-files=all');
        const { result } = resolveRow(buildW7, text);
        expect(result.gitlinks.find((gitlink) => gitlink.path === 'gamma')?.listing).not.toBe('changed-not-declared');
      });

      it('B4: a diff-index without --no-optional-locks rewrites a gitlinked repository\'s index (W4)', () => {
        const text = mutated(
          'B4',
          'git --no-optional-locks -C <path> diff-index -p',
          'git -C <path> diff-index -p'
        );
        const row = resolveRow(buildW4, text);
        const lib = row.workspace.repositories[1]!;
        const [before, after] = indexHashes(row, lib);
        expect(after).not.toBe(before);
      });

      it('B5: a committed listing without --ignore-submodules=none misses a moved pointer (E4)', () => {
        const text = mutated(
          'B5',
          'diff --name-only --ignore-submodules=none <merge-base> HEAD',
          'diff --name-only <merge-base> HEAD'
        );
        const { result } = resolveRow(buildE4, text);
        expect(result.wholeScope).not.toBe('blocked-by-gitlink');
      });

      it('H1: a command word holding a shell metacharacter makes the harness refuse, naming it', () => {
        const text = mutated('H1', 'git -C <path> ls-files --stage`', 'git -C <path> ls-files --stage $(id)`');
        expect(() => resolveReviewScope(text, makeRoot('h1'))).toThrow(/"\$\(id\)"/);
      });

      it('H2: a block with no diff-index command makes the harness refuse, naming the missing key', () => {
        const text = mutated(
          'H2',
          '`git --no-optional-locks -C <path> diff-index -p <merge-base>`',
          'the patch'
        );
        expect(() => resolveReviewScope(text, makeRoot('h2'))).toThrow(/"diff-index -p"/);
      });
    });
  });
});
