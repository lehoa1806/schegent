// The base a checkpoint diff is taken against, in the three states a workspace
// can actually be in: a repository with history, a repository whose branch has
// no commits yet, and a directory that is not a repository at all.
//
// Driven against real temporary repositories rather than a stubbed `execFile`,
// for the reason the checkpoint suites already give: the property under test is
// what `git` reports, and a stub would assert that the stub returns what the
// stub was told to return.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EMPTY_TREE_SHA1, EMPTY_TREE_SHA256, resolveDiffBase } from '../../../src/lib/git-diff-base';

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-diff-base-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function initRepo(objectFormat?: 'sha256'): Promise<void> {
  const args = objectFormat === undefined ? ['init', '-q'] : ['init', '-q', '--object-format=sha256'];
  await run('git', args, { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test'], { cwd: root });
}

describe('resolveDiffBase', () => {
  it('resolves HEAD when the branch has commits', async () => {
    await initRepo();
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

    const base = await resolveDiffBase(root);

    expect(base).toEqual({ ref: head, unborn: false });
  });

  it('resolves the empty tree when the branch has no commits', async () => {
    // The state a freshly `git init`-ed workspace is in until its first commit.
    await initRepo();

    const base = await resolveDiffBase(root);

    expect(base).toEqual({ ref: EMPTY_TREE_SHA1, unborn: true });
  });

  it('resolves the empty tree for the repository hash algorithm, not a fixed one', async () => {
    // A sha256 repository's empty tree is a different object. Hard-coding the
    // sha1 constant would hand `git diff` an id that does not exist there.
    await initRepo('sha256');

    const base = await resolveDiffBase(root);

    expect(base).toEqual({ ref: EMPTY_TREE_SHA256, unborn: true });
  });

  it('produces a base git will diff a staged tree against', async () => {
    // The point of the resolution: the returned ref has to be usable as the
    // left-hand side of the checkpoint's own diff invocation.
    await initRepo();
    await fs.writeFile(path.join(root, 'a.txt'), 'staged before any commit\n');
    await run('git', ['add', '-A'], { cwd: root });

    const base = await resolveDiffBase(root);
    const { stdout } = await run('git', ['diff', '--binary', '--no-ext-diff', base.ref], {
      cwd: root
    });

    expect(stdout).toContain('staged before any commit');
  });

  it('rejects outside a git repository', async () => {
    // Not a repository is a genuine capture failure and must stay one: the
    // checkpoint's caller maps it to `checkpoint-unavailable` and blocks the
    // Git-capable phase. Only the unborn-HEAD case is being softened.
    await expect(resolveDiffBase(root)).rejects.toThrow();
  });
});
