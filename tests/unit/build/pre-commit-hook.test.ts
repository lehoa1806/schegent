import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANTED } from '../../fixtures/secret-scan-corpus';
import {
  REPO_ROOT,
  commit,
  git,
  gitOut,
  removeSandboxes,
  replaceEngineWithUnloadable,
  sandbox
} from './secret-scan-harness';

/**
 * FR-R4-F10 (contract test T6; HK1 to HK3; FR-015, FR-016) -- the tracked pre-commit hook, run by
 * real `git commit` with `core.hooksPath` set to `scripts/hooks`.
 *
 * WHAT IT PINS. The hook is the only place the staged scan stops a commit, so each outcome the
 * contract promises is exercised through git itself rather than by calling the script: a finding
 * and a refusal block the commit, a deletion-only or clean commit proceeds, `--no-verify` bypasses
 * the hook, and a machine without `node` on `PATH` gets the one named line instead of a silent
 * pass. The hook's executable bit is a property of what the repository tracks, so it is read from
 * the sandbox's index, where a hook committed with mode 100644 would never run.
 *
 * The value is the corpus's synthetic Slack token, assembled at call time.
 */
const SLACK = PLANTED.find((planted) => planted.family === 'slack');
if (SLACK === undefined) throw new Error('the corpus has no slack case');
const SLACK_VALUE = SLACK.build();
const HOOK_FILE = join(REPO_ROOT, 'scripts', 'hooks', 'pre-commit');
const NODE_MISSING_LINE =
  'pre-commit: node not found on PATH; the staged secret scan cannot run. ' +
  'Commit refused (use git commit --no-verify to bypass, see SECURITY.md).';

const tempDirs: string[] = [];

afterEach(() => {
  removeSandboxes();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/** A hook-enabled repository with a base commit that carries the hook and the configuration. */
function hookRepository(files: Record<string, string>): string {
  const root = sandbox(files, { hooks: true, stageConfig: true });
  const made = commit(root, ['-m', 'base', '--no-verify']);
  expect(made.status, made.out).toBe(0);
  return root;
}

function commitCount(root: string): number {
  return Number(gitOut(root, 'rev-list', '--count', 'HEAD').toString('utf8').trim());
}

function stage(root: string, name: string, text: string): void {
  mkdirSync(join(root, name, '..'), { recursive: true });
  writeFileSync(join(root, name), text);
  git(root, 'add', '--', name);
}

describe('the hook decides what a commit may do', () => {
  it('refuses a commit that stages a finding, and makes no commit', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    stage(root, 'leak.txt', SLACK_VALUE);
    const result = commit(root, ['-m', 'leak']);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('Secret scan (staged): FINDING');
    expect(commitCount(root)).toBe(before);
  });

  it('refuses a commit whose scan cannot run, and makes no commit', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    stage(root, '.secretlintrc.json', '{ this is not json');
    const result = commit(root, ['-m', 'broken config']);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('cannot run: config-unparseable');
    expect(commitCount(root)).toBe(before);
  });

  it('refuses a commit when the engine package will not load, with the named line, and makes no commit', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    replaceEngineWithUnloadable(root, "throw new Error('synthetic load failure');\n");
    stage(root, 'clean.txt', 'edited\n');
    const result = commit(root, ['-m', 'edit']);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('cannot run: engine-failed');
    expect(result.out, 'a raw module-loader trace reached the operator').not.toContain('node:internal');
    expect(commitCount(root)).toBe(before);
  });

  it('lets --no-verify through without running the scan', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    stage(root, 'leak.txt', SLACK_VALUE);
    const result = commit(root, ['-m', 'leak', '--no-verify']);
    expect(result.status, result.out).toBe(0);
    expect(commitCount(root)).toBe(before + 1);
  });

  it('lets a deletion-only commit through', () => {
    const root = hookRepository({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
    const before = commitCount(root);
    git(root, 'rm', '--quiet', '--', 'a.txt');
    const result = commit(root, ['-m', 'remove a']);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('nothing staged needed scanning');
    expect(commitCount(root)).toBe(before + 1);
  });

  it('lets clean content through', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    stage(root, 'clean.txt', 'edited\n');
    const result = commit(root, ['-m', 'edit']);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('Secret scan (staged): passed');
    expect(commitCount(root)).toBe(before + 1);
  });
});

describe('the hook refuses with one named line when node is not on PATH (HK1)', () => {
  it('prints the HK1 line and blocks the commit', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const before = commitCount(root);
    stage(root, 'clean.txt', 'edited\n');
    const bin = mkdtempSync(join(realpathSync(tmpdir()), 'hook-path-'));
    tempDirs.push(bin);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    expect(realGit.length, 'git must be found to build the restricted PATH').toBeGreaterThan(0);
    symlinkSync(realGit, join(bin, 'git'));
    symlinkSync('/bin/sh', join(bin, 'sh'));
    const result = commit(root, ['-m', 'edit'], { PATH: bin });
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain(NODE_MISSING_LINE);
    expect(commitCount(root)).toBe(before);
  });
});

describe('the hook file as tracked', () => {
  it('is tracked with mode 100755 in the sandbox index', () => {
    const root = hookRepository({ 'clean.txt': 'nothing here\n' });
    const listed = gitOut(root, 'ls-files', '-s', '--', 'scripts/hooks/pre-commit').toString('utf8');
    expect(listed.startsWith('100755 ')).toBe(true);
  });

  it('calls no package manager and no network command', () => {
    const text = readFileSync(HOOK_FILE, 'utf8');
    expect(text.startsWith('#!/bin/sh')).toBe(true);
    for (const forbidden of ['npm', 'npx', 'curl', 'wget', 'nc ', 'ssh', 'scp', 'git fetch', 'git push', 'git pull']) {
      expect(text, `the hook must not mention ${forbidden}`).not.toContain(forbidden);
    }
    expect(text).toContain('exec node scripts/scan-secrets.mjs --staged');
  });
});
