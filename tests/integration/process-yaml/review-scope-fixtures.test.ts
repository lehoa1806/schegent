// FR-R4-F18 — the production scope resolver on disposable Git workspaces.

import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readNativeReviewScope, type NativeReviewScope } from '../../../src/services/native-review-scope';
import { createExecFileGitRunner } from '../../../src/services/execution-lanes/git-runner';
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
  seedStatDirty,
  snapshot,
  type Snapshot,
  type Workspace
} from '../../fixtures/review-scope-workspaces';
interface CommandRun {
  readonly cwd: string;
  readonly argv: readonly string[];
}

type ScopeResolution = NativeReviewScope & { readonly log: readonly CommandRun[] };

const COMMIT_SHA = /^[0-9a-f]{40}$/;

interface Row {
  readonly workspace: Workspace;
  readonly result: ScopeResolution;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

async function runRow(build: () => Workspace): Promise<Row> {
  const workspace = build();
  for (const repository of workspace.repositories) seedStatDirty(repository);
  const before = snapshot(workspace.repositories);
  const git = createExecFileGitRunner();
  const log: CommandRun[] = [];
  const scope = await readNativeReviewScope(workspace.root, {
    run(args, options) {
      log.push({ argv: args, cwd: options.cwd });
      return git.run(args, options);
    }
  });
  const after = snapshot(workspace.repositories);
  expect(after, 'resolving the scope changed a repository').toEqual(before);
  return { workspace, result: { ...scope, log }, before, after };
}

/** The paths a fixture's AGENTS.md declares, read here and not by the harness (SC-003's oracle). */
function declaredPaths(root: string): string[] {
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  return [...text.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]!);
}

/** Every Git call made outside the workspace. */
function gitRunsOutside(root: string, log: readonly CommandRun[]): CommandRun[] {
  const inside = realpathSync(root);
  return log.filter((run) => {
    const target = resolve(run.cwd);
    let physical = target;
    try {
      physical = realpathSync(target);
    } catch {
      // A path that does not exist cannot lead outside: the check is about where a command ran.
    }
    return physical !== inside && !physical.startsWith(`${inside}${sep}`);
  });
}

describe('native review scope (FR-R4-F18)', () => {
  describe('a declaration names the repositories (US1, SC-001)', () => {
    it('W5: both declared repositories are targets, though the root diff holds no source', async () => {
      const { result } = await runRow(buildW5);
      expect(result.source).toBe('declaration');
      expect(result.wholeScope).toBe('resolved');
      expect(result.targets.map((target) => target.path)).toEqual(['alpha', 'beta']);
      for (const target of result.targets) {
        expect(target.base, `${target.path} base`).toBe('develop');
        expect(('mergeBase' in target ? target.mergeBase : null), `${target.path} merge base`).toMatch(COMMIT_SHA);
        expect(target.state, `${target.path} state`).toBe('resolved');
      }
      expect(result.targets.find((target) => target.path === 'alpha')).toMatchObject({ changedTracked: ['src/alpha.ts'] });
      expect(result.targets.find((target) => target.path === 'beta')).toMatchObject({ changedTracked: ['src/beta.ts'] });
      expect(result.findings).toBe(0);
    });

    it('W6: a declared repository with no feature change is reported so, and alpha is still reviewed', async () => {
      const { result } = await runRow(buildW6);
      const states = Object.fromEntries(result.targets.map((target) => [target.path, target.state]));
      expect(states).toEqual({ alpha: 'resolved', beta: 'no-feature-changes' });
      expect(result.findings).toBe(0);
    });

    it('W7: a changed gitlink the declaration omits is listed, not reviewed and not counted (FR-013a)', async () => {
      const { result } = await runRow(buildW7);
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
    it('W1: a standalone repository is the target, with its untracked source file listed', async () => {
      const { result } = await runRow(buildW1);
      expect(result.source).toBe('inference');
      expect(result.targets).toMatchObject([
        { path: '.', changedTracked: ['src/a.ts'], untracked: ['src/new.ts'] }
      ]);
    });

    it('W2: the envelope resolves to repo, and Spec Kit files stay out of both lists', async () => {
      const { workspace, result } = await runRow(buildW2);
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

    it('W2 control: with specs/ gone from the root, the root is the target, so the layout read is live', async () => {
      const withoutSpecs = (): Workspace => {
        const workspace = buildW2();
        rmSync(join(workspace.root, 'specs'), { recursive: true });
        return workspace;
      };
      const { result } = await runRow(withoutSpecs);
      expect(result.targets.map((target) => target.path)).toEqual(['.']);
    });

    it('W3: a repo/ that is a linked worktree, whose .git is a file, is still the target', async () => {
      const { workspace, result } = await runRow(buildW3);
      expect(result.source).toBe('inference');
      expect(result.targets.map((target) => target.path)).toEqual(['repo']);
      expect(result.targets[0]?.state).toBe('resolved');
      // Control: repo/.git is a file, not a directory, so a `test -d .git` rule would miss it.
      expect(git(join(workspace.root, 'repo'), ['rev-parse', '--git-dir'])).toContain('worktrees');
    });

    it('W4: an unchanged gitlink is listed as not reviewed, and does not block', async () => {
      const { result } = await runRow(buildW4);
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

    it('R1: a missing target is unresolved, and the valid one beside it is still reviewed', async () => {
      const { workspace, result } = await runRow(buildR1);
      expect(states(result)).toEqual({ missing: 'unresolved:missing', alpha: 'resolved' });
      expect(result.findings).toBe(1);
      expectRefusal(workspace, result);
    });

    it('R2: an absolute path to a repository outside the root is unresolved, and nothing ran there', async () => {
      const { workspace, result } = await runRow(buildR2);
      const [outside] = workspace.repositories;
      expect(states(result)).toEqual({ [outside!]: 'unresolved:outside' });
      expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
      expectRefusal(workspace, result);
    });

    it('R3: a symlink to a repository outside the root is unresolved, and no git ran there', async () => {
      const { workspace, result } = await runRow(buildR3);
      expect(states(result)).toEqual({ link: 'unresolved:outside' });
      expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
      expectRefusal(workspace, result);
    });

    it('E3: a path leading outside the root through .. is unresolved, and nothing ran there', async () => {
      const { workspace, result } = await runRow(buildE3);
      expect(result.targets.map((target) => target.state)).toEqual(['unresolved:outside']);
      expect(gitRunsOutside(workspace.root, result.log)).toEqual([]);
      expectRefusal(workspace, result);
    });

    it('control: the outside check flags a git command that ran at an outside path', async () => {
      const { workspace } = await runRow(buildR2);
      const [outside] = workspace.repositories;
      const log: CommandRun[] = [{ argv: ['status'], cwd: outside! }];
      expect(gitRunsOutside(workspace.root, log)).toHaveLength(1);
    });

    it('R4: a plain directory inside a repository is not a repository top level', async () => {
      const { workspace, result } = await runRow(buildR4);
      expect(states(result)).toEqual({ 'alpha/src': 'unresolved:not-top-level' });
      expectRefusal(workspace, result);
    });

    it('E1: a .git file that points at a missing directory is not a repository top level', async () => {
      const { workspace, result } = await runRow(buildE1);
      expect(states(result)).toEqual({ broken: 'unresolved:not-top-level' });
      expectRefusal(workspace, result);
    });

    it('R5: a target with no local develop has no base, and no remote-tracking ref or fetch is tried', async () => {
      const { workspace, result } = await runRow(buildR5);
      expect(states(result)).toEqual({ alpha: 'unresolved:no-base' });
      const named = result.log.filter((run) => run.argv.some((word) => word.includes('origin/') || word === 'fetch'));
      expect(named).toEqual([]);
      expectRefusal(workspace, result);
    });

    it('E2: a main-only repository with no declaration has no base, and nothing is substituted', async () => {
      const { result } = await runRow(buildE2);
      expect(states(result)).toEqual({ '.': 'unresolved:no-base' });
      expect(result.findings).toBe(1);
      expect(result.log.filter((run) => run.argv.some((word) => word === 'main' || word === 'fetch'))).toEqual([]);
    });

    it('R6: two entries at one location leave the whole scope unresolved, with no target', async () => {
      const { result } = await runRow(buildR6);
      expect(result.wholeScope).toBe('conflicting');
      expect(result.targets).toEqual([]);
      expect(result.findings).toBe(1);
    });

    it('R7: an entry with a space in its path is malformed, and no command is run', async () => {
      const { result } = await runRow(buildR7);
      expect(result.wholeScope).toBe('malformed');
      expect(result.targets).toEqual([]);
      expect(result.findings).toBe(1);
      expect(result.log).toEqual([]);
    });

    it('R8: with no declaration, a changed gitlink inside the inferred repository blocks the scope', async () => {
      const { result } = await runRow(buildR8);
      expect(result.wholeScope).toBe('blocked-by-gitlink');
      expect(result.targets).toEqual([]);
      expect(result.gitlinks).toEqual([{ path: 'vendor/lib', container: '.', listing: 'blocks-inference' }]);
      expect(result.findings).toBe(1);
    });

    it('E4: a pointer moved in a commit blocks the scope, though status shows the checkout clean', async () => {
      const { workspace, result } = await runRow(buildE4);
      // The root's config hides submodule changes from a plain listing; only the flag shows this one.
      const quiet = git(workspace.root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
      expect(quiet, 'status shows nothing for the clean gitlink').not.toContain('vendor/lib');
      expect(result.wholeScope).toBe('blocked-by-gitlink');
      expect(result.targets).toEqual([]);
      expect(result.gitlinks).toEqual([{ path: 'vendor/lib', container: '.', listing: 'blocks-inference' }]);
      expect(result.findings).toBe(1);
    });

    it('E5: with no declaration and no repository, there is no layout, and nothing is reviewed', async () => {
      const { result } = await runRow(buildE5);
      expect(result.wholeScope).toBe('no-layout');
      expect(result.targets).toEqual([]);
      expect(result.findings).toBe(1);
    });
  });

  describe('discovery leaves every checkout as it found it (US4, SC-004)', () => {
    it('F3.3 W1: an untracked source file is listed, and stays untracked', async () => {
      const { workspace, result, after } = await runRow(buildW1);
      expect(result.targets).toMatchObject([{ untracked: ['src/new.ts'] }]);
      expect(after[workspace.root]).toMatchObject({ status: expect.stringContaining('? src/new.ts') });
    });
  });

});
