// FR-R6-F10 T019 — the provisioning probe refuses instead of degrading (US2, SC-002).
//
// WHAT THIS PINS:
//   - one fixture per refusal reason, in research "Entry condition 3";
//   - the checks run in their fixed order: with two conditions failing, the earlier one is named;
//   - a `filter.lfs.*` config with no LFS attribute in the tree does not refuse;
//   - a revision that Git could read as an option is refused without reaching Git as one.

import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecFileGitRunner,
  type GitRunOptions,
  type GitRunResult,
  type LaneGitRunner
} from '../../../src/services/execution-lanes/git-runner';
import type { ProvisionRequest } from '../../../src/services/execution-lanes/lane-provisioner';
import { probeProvisioning } from '../../../src/services/execution-lanes/provisioning-probe';
import { createFixtureRepo, type FixtureRepo } from './fixture-repo';

const TIMEOUT_MS = 30_000;
const remaining = (): number => TIMEOUT_MS;

const fixtures: FixtureRepo[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0, fixtures.length)) fixture.dispose();
});

function fixtureRepo(): FixtureRepo {
  const fixture = createFixtureRepo('probe');
  fixtures.push(fixture);
  return fixture;
}

function realGit(fixture: FixtureRepo): LaneGitRunner {
  return createExecFileGitRunner({
    baseEnv: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(fixture.root) }
  });
}

/** The real runner, except that `answer` may replace the result of a call it recognizes. */
function patchedGit(
  inner: LaneGitRunner,
  answer: (args: readonly string[]) => GitRunResult | null
): LaneGitRunner {
  return {
    run: (args: readonly string[], opts: GitRunOptions) => {
      const patched = answer(args);
      return patched === null ? inner.run(args, opts) : Promise.resolve(patched);
    }
  };
}

function request(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return { rootExecutionId: 'root-exec-1', sourceRevision: 'HEAD', dependencyRecipe: 'none', ...overrides };
}

async function reasonOf(
  fixture: FixtureRepo,
  options: { workspaceRoot?: string; storageDir?: string; git?: LaneGitRunner; request?: Partial<ProvisionRequest> } = {}
): Promise<string> {
  const result = await probeProvisioning(
    {
      git: options.git ?? realGit(fixture),
      workspaceRoot: options.workspaceRoot ?? fixture.root,
      storageDir: options.storageDir ?? fixture.sibling('storage')
    },
    request(options.request),
    remaining
  );
  return result.ok ? 'ok' : result.refusal.reason;
}

describe('FR-R6-F10 provisioning probe: one refusal per condition', () => {
  it('admits a plain repository and names its commit and repository id', async () => {
    const fixture = fixtureRepo();
    const result = await probeProvisioning(
      { git: realGit(fixture), workspaceRoot: fixture.root, storageDir: fixture.sibling('storage') },
      request(),
      remaining
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.commit).toBe(fixture.head());
    expect(result.value.repositoryId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses git-version-unsupported below Git 2.17', async () => {
    const fixture = fixtureRepo();
    const git = patchedGit(realGit(fixture), (args) =>
      args.at(0) === '--version' ? { ok: true, stdout: 'git version 2.16.6\n' } : null
    );
    expect(await reasonOf(fixture, { git })).toBe('git-version-unsupported');
  });

  it('refuses nested-repository-unsupported for a subdirectory of a repository', async () => {
    const fixture = fixtureRepo();
    fixture.write('sub/file.txt', 'x\n');
    fixture.commit('sub');
    expect(await reasonOf(fixture, { workspaceRoot: path.join(fixture.root, 'sub') })).toBe(
      'nested-repository-unsupported'
    );
  });

  it('refuses nested-repository-unsupported for a repository with a superproject', async () => {
    const fixture = fixtureRepo();
    const git = patchedGit(realGit(fixture), (args) =>
      args.includes('--show-superproject-working-tree') ? { ok: true, stdout: '/elsewhere/super\n' } : null
    );
    expect(await reasonOf(fixture, { git })).toBe('nested-repository-unsupported');
  });

  it('refuses source-revision-unresolved outside a repository', async () => {
    const fixture = fixtureRepo();
    expect(await reasonOf(fixture, { workspaceRoot: fixture.sibling('plain') })).toBe('source-revision-unresolved');
  });

  it('refuses source-revision-unresolved on an unborn HEAD', async () => {
    const fixture = fixtureRepo();
    const unborn = fixture.sibling('unborn');
    fixture.git(['init', '-q'], unborn);
    expect(await reasonOf(fixture, { workspaceRoot: unborn })).toBe('source-revision-unresolved');
  });

  it.each(['no-such-branch', '-x', '--all'])('refuses source-revision-unresolved for revision %j', async (rev) => {
    const fixture = fixtureRepo();
    expect(await reasonOf(fixture, { request: { sourceRevision: rev } })).toBe('source-revision-unresolved');
  });

  it('refuses lane-root-inside-workspace when the storage directory is in the workspace', async () => {
    const fixture = fixtureRepo();
    expect(await reasonOf(fixture, { storageDir: path.join(fixture.root, '.schegent') })).toBe(
      'lane-root-inside-workspace'
    );
  });

  it('refuses dependency-recipe-unsupported for any recipe but none', async () => {
    const fixture = fixtureRepo();
    expect(await reasonOf(fixture, { request: { dependencyRecipe: 'npm-ci' } })).toBe('dependency-recipe-unsupported');
  });

  it('refuses submodules-unsupported for a gitlink in the tree', async () => {
    const fixture = fixtureRepo();
    fixture.addGitlink('vendor/lib', fixture.head());
    expect(await reasonOf(fixture)).toBe('submodules-unsupported');
  });

  it.each(['.gitattributes', 'assets/.gitattributes'])('refuses lfs-unsupported for filter=lfs in %s', async (file) => {
    const fixture = fixtureRepo();
    fixture.write(file, '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    fixture.commit('lfs attributes');
    expect(await reasonOf(fixture)).toBe('lfs-unsupported');
  });

  it('does not refuse on filter.lfs config alone', async () => {
    const fixture = fixtureRepo();
    fixture.git(['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
    fixture.git(['config', 'filter.lfs.required', 'true']);
    expect(await reasonOf(fixture)).toBe('ok');
  });
});

describe('FR-R6-F10 provisioning probe: check order', () => {
  it('names the storage location before the recipe', async () => {
    const fixture = fixtureRepo();
    expect(
      await reasonOf(fixture, {
        storageDir: path.join(fixture.root, '.schegent'),
        request: { dependencyRecipe: 'npm-ci' }
      })
    ).toBe('lane-root-inside-workspace');
  });

  it('names the recipe before the revision', async () => {
    const fixture = fixtureRepo();
    expect(
      await reasonOf(fixture, { request: { dependencyRecipe: 'npm-ci', sourceRevision: 'no-such-branch' } })
    ).toBe('dependency-recipe-unsupported');
  });

  it('names submodules before LFS', async () => {
    const fixture = fixtureRepo();
    fixture.write('.gitattributes', '*.bin filter=lfs\n');
    fixture.commit('lfs');
    fixture.addGitlink('vendor/lib', fixture.head());
    expect(await reasonOf(fixture)).toBe('submodules-unsupported');
  });

  it('names the Git version before the topology', async () => {
    const fixture = fixtureRepo();
    const git = patchedGit(realGit(fixture), (args) =>
      args.at(0) === '--version' ? { ok: true, stdout: 'git version 2.16.6\n' } : null
    );
    expect(await reasonOf(fixture, { git, workspaceRoot: path.join(fixture.root, 'missing-sub') })).toBe(
      'git-version-unsupported'
    );
  });
});
