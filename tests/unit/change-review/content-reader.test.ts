// FR-R6-F12 T010 (FR-005, FR-015; research R2) — reading one side of a change.
//
// WHAT THIS PINS:
//   - a text blob is returned as its text, read by object identity;
//   - binary and submodule sides return their sentence without any Git call;
//   - an overflow, a missing object and any other failure each return their own sentence;
//   - a side with no live resource returns the `unavailable` sentence.

import { describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS, PLACEHOLDER_SENTENCES } from '../../../src/contracts/change-review';
import type { ContentResource } from '../../../src/services/change-review/content-handles';
import { readContentResource } from '../../../src/services/change-review/content-reader';
import type { GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';

const BLOB = 'a'.repeat(40);

function fakeGit(result: GitRunResult): { readonly git: LaneGitRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve(result);
      }
    }
  };
}

function side(overrides: Partial<ContentResource> = {}): ContentResource {
  return { handle: 'h', reviewId: 'r', blob: BLOB, mode: '100644', binary: false, ...overrides };
}

function ctxOf(git: LaneGitRunner) {
  return { git, cwd: '/repo', timeoutMs: CHANGE_REVIEW_LIMITS.gitTimeoutMs };
}

describe('readContentResource', () => {
  it('returns the blob text', async () => {
    const { git, calls } = fakeGit({ ok: true, stdout: 'one\ntwo\n' });
    expect(await readContentResource(ctxOf(git), side())).toEqual({ kind: 'text', text: 'one\ntwo\n' });
    expect(calls).toEqual([['cat-file', 'blob', BLOB]]);
  });

  it('never reads a binary or submodule side', async () => {
    const { git, calls } = fakeGit({ ok: true, stdout: 'x' });
    expect(await readContentResource(ctxOf(git), side({ binary: true }))).toEqual({
      kind: 'placeholder',
      reason: 'binary',
      text: PLACEHOLDER_SENTENCES.binary
    });
    expect(await readContentResource(ctxOf(git), side({ mode: '160000' }))).toEqual({
      kind: 'placeholder',
      reason: 'submodule',
      text: PLACEHOLDER_SENTENCES.submodule
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['oversized', { ok: false, exitCode: null, code: 'buffer' }],
    ['missing', { ok: false, exitCode: 128, code: 'exit' }],
    ['read-failed', { ok: false, exitCode: null, code: 'timeout' }],
    ['read-failed', { ok: false, exitCode: null, code: 'spawn' }]
  ] as const)('maps a failed read to %s', async (reason, result) => {
    const { git } = fakeGit(result);
    expect(await readContentResource(ctxOf(git), side())).toEqual({
      kind: 'placeholder',
      reason,
      text: PLACEHOLDER_SENTENCES[reason]
    });
  });

  it('returns the unavailable sentence for a side with no live resource', async () => {
    const { git, calls } = fakeGit({ ok: true, stdout: 'x' });
    expect(await readContentResource(ctxOf(git), null)).toEqual({
      kind: 'placeholder',
      reason: 'unavailable',
      text: PLACEHOLDER_SENTENCES.unavailable
    });
    expect(calls).toHaveLength(0);
  });
});
