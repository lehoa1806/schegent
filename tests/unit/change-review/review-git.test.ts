// FR-R6-F12 T003 (FR-004, FR-009, FR-013; research R1, R2 and R4) — the review's Git reads.
//
// WHAT THIS PINS:
//   - an object identity other than 40 or 64 lowercase hex, or a target ref other than
//     `refs/heads/<valid branch>`, never reaches Git;
//   - the exact argv of each of the four verbs, with its timeout and output bound;
//   - exit 1 is an answer (`false` or a missing ref); a timeout, a buffer overflow and any other
//     failure each map to their own bounded code, and no Git output is returned on failure.

import { describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS } from '../../../src/contracts/change-review';
import type { GitRunOptions, GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import {
  commitExists,
  isAncestorOf,
  isObjectId,
  isTargetRef,
  readBlob,
  readInventory,
  targetTip,
  type ReviewGitContext
} from '../../../src/services/change-review/review-git';

const SHA1 = 'a'.repeat(40);
const SHA1_B = 'b'.repeat(40);
const SHA256 = 'c'.repeat(64);
const CWD = '/repo/root';

interface Call {
  readonly args: readonly string[];
  readonly opts: GitRunOptions;
}

function fakeGit(result: GitRunResult): { readonly git: LaneGitRunner; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    git: {
      run: (args, opts) => {
        calls.push({ args, opts });
        return Promise.resolve(result);
      }
    }
  };
}

function ctxOf(git: LaneGitRunner): ReviewGitContext {
  return { git, cwd: CWD, timeoutMs: CHANGE_REVIEW_LIMITS.gitTimeoutMs };
}

const OK = (stdout: string): GitRunResult => ({ ok: true, stdout });
const EXIT_1: GitRunResult = { ok: false, exitCode: 1, code: 'exit' };
const EXIT_128: GitRunResult = { ok: false, exitCode: 128, code: 'exit' };
const TIMEOUT: GitRunResult = { ok: false, exitCode: null, code: 'timeout' };
const BUFFER: GitRunResult = { ok: false, exitCode: null, code: 'buffer' };
const SPAWN: GitRunResult = { ok: false, exitCode: null, code: 'spawn' };

describe('identity grammar', () => {
  it('accepts 40 and 64 lowercase hex only', () => {
    expect(isObjectId(SHA1)).toBe(true);
    expect(isObjectId(SHA256)).toBe(true);
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `-${'a'.repeat(39)}`, 'HEAD', '', 7, null]) {
      expect(isObjectId(bad)).toBe(false);
    }
  });

  it('accepts refs/heads/ plus a valid branch only', () => {
    expect(isTargetRef('refs/heads/main')).toBe(true);
    expect(isTargetRef('refs/heads/feature/x')).toBe(true);
    for (const bad of ['main', 'refs/tags/v1', 'refs/heads/', 'refs/heads/a..b', 'refs/heads/-x', 'refs/heads/a^{commit}', 3]) {
      expect(isTargetRef(bad)).toBe(false);
    }
  });
});

describe('commitExists', () => {
  it('asks rev-parse to peel the identity to a commit', async () => {
    const { git, calls } = fakeGit(OK(`${SHA1}\n`));
    expect(await commitExists(ctxOf(git), SHA1)).toBe(true);
    expect(calls.at(0)?.args).toEqual(['rev-parse', '--verify', '--quiet', `${SHA1}^{commit}`]);
    expect(calls.at(0)?.opts).toEqual({ cwd: CWD, timeoutMs: CHANGE_REVIEW_LIMITS.gitTimeoutMs });
  });

  it('reads exit 1 as missing and any other failure as unknown', async () => {
    expect(await commitExists(ctxOf(fakeGit(EXIT_1).git), SHA1)).toBe(false);
    expect(await commitExists(ctxOf(fakeGit(EXIT_128).git), SHA1)).toBeNull();
    expect(await commitExists(ctxOf(fakeGit(TIMEOUT).git), SHA1)).toBeNull();
  });

  it('never calls Git for an invalid identity', async () => {
    const { git, calls } = fakeGit(OK(''));
    expect(await commitExists(ctxOf(git), '--output=/tmp/x')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('targetTip', () => {
  it('resolves the ref to a commit', async () => {
    const { git, calls } = fakeGit(OK(`${SHA1}\n`));
    expect(await targetTip(ctxOf(git), 'refs/heads/main')).toEqual({ ok: true, value: SHA1 });
    expect(calls.at(0)?.args).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']);
  });

  it('reads exit 1 as a missing ref and other failures as a failed read', async () => {
    expect(await targetTip(ctxOf(fakeGit(EXIT_1).git), 'refs/heads/main')).toEqual({ ok: true, value: null });
    expect(await targetTip(ctxOf(fakeGit(SPAWN).git), 'refs/heads/main')).toEqual({ ok: false, failure: 'failed' });
    expect(await targetTip(ctxOf(fakeGit(OK('not a sha\n')).git), 'refs/heads/main')).toEqual({ ok: false, failure: 'failed' });
  });

  it('never calls Git for an invalid ref', async () => {
    const { git, calls } = fakeGit(OK(SHA1));
    expect(await targetTip(ctxOf(git), 'refs/heads/a..b')).toEqual({ ok: false, failure: 'failed' });
    expect(calls).toHaveLength(0);
  });
});

describe('isAncestorOf', () => {
  it('runs merge-base --is-ancestor and reads exit 1 as false', async () => {
    const { git, calls } = fakeGit(OK(''));
    expect(await isAncestorOf(ctxOf(git), SHA1, SHA1_B)).toBe(true);
    expect(calls.at(0)?.args).toEqual(['merge-base', '--is-ancestor', SHA1, SHA1_B]);
    expect(await isAncestorOf(ctxOf(fakeGit(EXIT_1).git), SHA1, SHA1_B)).toBe(false);
    expect(await isAncestorOf(ctxOf(fakeGit(EXIT_128).git), SHA1, SHA1_B)).toBeNull();
  });

  it('never calls Git for an invalid identity', async () => {
    const { git, calls } = fakeGit(OK(''));
    expect(await isAncestorOf(ctxOf(git), SHA1, 'HEAD')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('readInventory', () => {
  it('runs one NUL-separated diff-tree with the inventory bound', async () => {
    const { git, calls } = fakeGit(OK('out'));
    expect(await readInventory(ctxOf(git), SHA1, SHA1_B)).toEqual({ ok: true, value: 'out' });
    expect(calls.at(0)?.args).toEqual([
      'diff-tree',
      '-r',
      '-z',
      '-M',
      '--raw',
      '--numstat',
      '--no-textconv',
      '--no-ext-diff',
      SHA1,
      SHA1_B
    ]);
    expect(calls.at(0)?.opts.maxBuffer).toBe(CHANGE_REVIEW_LIMITS.inventoryOutputBytesMax);
  });

  it('maps each failure to its own code', async () => {
    expect(await readInventory(ctxOf(fakeGit(TIMEOUT).git), SHA1, SHA1_B)).toEqual({ ok: false, failure: 'deadline' });
    expect(await readInventory(ctxOf(fakeGit(BUFFER).git), SHA1, SHA1_B)).toEqual({ ok: false, failure: 'oversized' });
    expect(await readInventory(ctxOf(fakeGit(EXIT_128).git), SHA1, SHA1_B)).toEqual({ ok: false, failure: 'exit' });
    expect(await readInventory(ctxOf(fakeGit(SPAWN).git), SHA1, SHA1_B)).toEqual({ ok: false, failure: 'failed' });
  });
});

describe('readBlob', () => {
  it('reads one blob by identity with the per-side bound', async () => {
    const { git, calls } = fakeGit(OK('text\n'));
    expect(await readBlob(ctxOf(git), SHA1)).toEqual({ ok: true, value: 'text\n' });
    expect(calls.at(0)?.args).toEqual(['cat-file', 'blob', SHA1]);
    expect(calls.at(0)?.opts.maxBuffer).toBe(CHANGE_REVIEW_LIMITS.sideBytesMax);
  });

  it('maps an overflow and a missing object', async () => {
    expect(await readBlob(ctxOf(fakeGit(BUFFER).git), SHA1)).toEqual({ ok: false, failure: 'oversized' });
    expect(await readBlob(ctxOf(fakeGit(EXIT_128).git), SHA1)).toEqual({ ok: false, failure: 'exit' });
  });

  it('never calls Git for an invalid identity', async () => {
    const { git, calls } = fakeGit(OK(''));
    expect(await readBlob(ctxOf(git), 'HEAD:secret')).toEqual({ ok: false, failure: 'failed' });
    expect(calls).toHaveLength(0);
  });
});
