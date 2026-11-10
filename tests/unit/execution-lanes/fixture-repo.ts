// FR-R6-F10 T009 — fixture repositories for the execution-lane tests.
//
// Each fixture is a fresh `git init` under the vitest temp root, which sits inside `repo/`.
// Every Git call sets `GIT_CEILING_DIRECTORIES` to the fixture's parent, so a command that
// loses its `.git` can never walk up into the product repository. The global setup
// (`tests/global-temp-root.ts`) already sets the same ceiling and `maintenance.auto=false`;
// this file restates the ceiling so the helper does not depend on load order.
//
// The repository carries its own identity in its local config, so a lane freeze inside it
// finds `user.name` and `user.email` without reading the operator's global config. Lane
// worktrees made by the tests live under the same temp root.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FIXTURE_BRANCH = 'main';
const GITLINK_MODE = '160000';

export interface FixtureRepo {
  /** The repository's real path. */
  readonly root: string;
  /** Runs `git` in `cwd` (the root by default) and returns stdout; a nonzero exit throws. */
  git(args: readonly string[], cwd?: string): string;
  /** Writes a file relative to the root, creating its directories. */
  write(relativePath: string, content: string): void;
  /** Stages everything and commits; returns the new commit id. */
  commit(message: string): string;
  /** The commit `HEAD` names. */
  head(): string;
  /** Records a gitlink at `relativePath` pointing at `commitId`, then commits it. */
  addGitlink(relativePath: string, commitId: string): string;
  /** A fresh directory beside the repository, under the same temp root, for lane roots. */
  sibling(label: string): string;
  /** Removes the repository and every sibling it made. */
  dispose(): void;
}

function fixtureEnv(ceiling: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CEILING_DIRECTORIES: ceiling, GIT_TERMINAL_PROMPT: '0' };
}

/** A repository on `main` holding one commit of `README.md`. */
export function createFixtureRepo(label: string): FixtureRepo {
  const container = realpathSync(mkdtempSync(join(tmpdir(), `schegent-f10-${label}-`)));
  const root = join(container, 'repo');
  mkdirSync(root);
  const env = fixtureEnv(container);

  const git = (args: readonly string[], cwd: string = root): string =>
    execFileSync('git', [...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const write = (relativePath: string, content: string): void => {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const head = (): string => git(['rev-parse', 'HEAD']).trim();

  const commit = (message: string): string => {
    git(['add', '-A']);
    git(['commit', '-q', '--no-verify', '-m', message]);
    return head();
  };

  git(['init', '-q', '-b', FIXTURE_BRANCH]);
  git(['config', 'user.name', 'Schegent Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  write('README.md', 'fixture\n');
  commit('initial');

  let siblingCount = 0;
  return {
    root,
    git,
    write,
    commit,
    head,
    addGitlink: (relativePath, commitId) => {
      git(['update-index', '--add', '--cacheinfo', `${GITLINK_MODE},${commitId},${relativePath}`]);
      git(['commit', '-q', '--no-verify', '-m', `gitlink ${relativePath}`]);
      return head();
    },
    sibling: (siblingLabel) => {
      siblingCount += 1;
      const dir = join(container, `${siblingLabel}-${siblingCount}`);
      mkdirSync(dir);
      return dir;
    },
    dispose: () => {
      rmSync(container, { recursive: true, force: true });
    }
  };
}
