/**
 * Review gap GC-11 (2026-11-12) — a host git call runs in the operator's repository, so its
 * repository-local config could run code the operator never approved: `core.fsmonitor` names a
 * program git runs on `status` and `diff`, and `.git/hooks` (or a repository `core.hooksPath`)
 * runs on `merge`, `checkout` and `commit`. Every host spawn of git now carries config overrides
 * that switch both off.
 *
 * Driven against a real temporary repository: the property is what git runs, and a stubbed
 * `execFile` would only report the arguments it was handed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOST_GIT_CONFIG_OVERRIDES, withHostGitConfig } from '../../../src/lib/host-git-config';
import { createExecFileGitRunner } from '../../../src/services/execution-lanes/git-runner';

const run = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';
const GIT_TIMEOUT_MS = 10_000;

let root: string;
let repo: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-host-git-config-'));
  repo = path.join(root, 'repo');
  await fs.mkdir(repo);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function git(args: readonly string[]): Promise<void> {
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo });
}

/** A repository whose local config runs a marker-writing program on `status` and on `merge`. */
async function initHostileRepository(): Promise<{ fsmonitorMarker: string; hookMarker: string }> {
  const fsmonitorMarker = path.join(root, 'fsmonitor-ran');
  const hookMarker = path.join(root, 'post-merge-ran');
  await git(['init', '-q', '-b', 'main']);
  await git(['commit', '-q', '--allow-empty', '-m', 'base']);
  await git(['branch', 'behind']);
  await git(['commit', '-q', '--allow-empty', '-m', 'ahead']);
  await git(['checkout', '-q', 'behind']);

  const fsmonitor = path.join(root, 'fsmonitor.sh');
  await fs.writeFile(fsmonitor, `#!/bin/sh\ntouch "${fsmonitorMarker}"\nexit 1\n`, { mode: 0o755 });
  await git(['config', 'core.fsmonitor', fsmonitor]);
  const hook = path.join(repo, '.git', 'hooks', 'post-merge');
  await fs.writeFile(hook, `#!/bin/sh\ntouch "${hookMarker}"\n`, { mode: 0o755 });
  return { fsmonitorMarker, hookMarker };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

describe('GC-11 — host git calls ignore repository fsmonitor and hooks', () => {
  it('prepends the overrides and leaves the caller arguments intact', () => {
    expect([...HOST_GIT_CONFIG_OVERRIDES]).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
    expect(withHostGitConfig(['status', '--porcelain'])).toEqual([...HOST_GIT_CONFIG_OVERRIDES, 'status', '--porcelain']);
  });

  it.skipIf(IS_WINDOWS)('a repository fsmonitor and post-merge hook do run for a plain git call (control)', async () => {
    const { fsmonitorMarker, hookMarker } = await initHostileRepository();

    await git(['status', '--porcelain']);
    await git(['merge', '-q', '--ff-only', 'main']);

    expect(await exists(fsmonitorMarker)).toBe(true);
    expect(await exists(hookMarker)).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('the lane git runner runs neither', async () => {
    const { fsmonitorMarker, hookMarker } = await initHostileRepository();
    const runner = createExecFileGitRunner();

    const status = await runner.run(['status', '--porcelain'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    const merge = await runner.run(['merge', '--ff-only', 'main'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });

    expect(status.ok).toBe(true);
    expect(merge.ok).toBe(true);
    expect(await exists(fsmonitorMarker)).toBe(false);
    expect(await exists(hookMarker)).toBe(false);
  });
});

/** Every `src` module that spawns git from `node:child_process`, found by reading the tree. */
async function gitSpawningModules(srcRoot: string): Promise<string[]> {
  const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await fs.readFile(file, 'utf8');
    if (text.includes("from 'node:child_process'") && text.includes("'git'")) {
      found.push(path.relative(srcRoot, file).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

describe('GC-11 — every host spawn of git goes through the overrides', () => {
  const srcRoot = path.resolve(__dirname, '..', '..', '..', 'src');

  it('finds the known git-spawning modules (control for the census below)', async () => {
    expect(await gitSpawningModules(srcRoot)).toEqual([
      'activation/run-safety-wiring.ts',
      'lib/git-diff-base.ts',
      'services/execution-lanes/git-runner.ts',
      'services/run-checkpoint-service.ts',
      'services/workflow-execution/recovery-envelope-builder.ts'
    ]);
  });

  it('each of them applies withHostGitConfig', async () => {
    const missing: string[] = [];
    for (const relative of await gitSpawningModules(srcRoot)) {
      const text = await fs.readFile(path.join(srcRoot, relative), 'utf8');
      if (!text.includes('withHostGitConfig(')) missing.push(relative);
    }
    expect(missing).toEqual([]);
  });

  // `git diff` runs a repository's `diff.<driver>.textconv` program unless told not to, and
  // `--no-ext-diff` does not stop it. Every host patch that says `--no-ext-diff` also says
  // `--no-textconv`.
  it('each host patch that passes --no-ext-diff also passes --no-textconv', async () => {
    const offenders: string[] = [];
    for (const relative of await gitSpawningModules(srcRoot)) {
      const text = await fs.readFile(path.join(srcRoot, relative), 'utf8');
      const extDiff = text.split("'--no-ext-diff'").length - 1;
      const textconv = text.split("'--no-textconv'").length - 1;
      if (textconv < extDiff) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
