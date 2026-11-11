/**
 * FR-R6-F12 (research R1, R2 and R4) — the four Git reads a change review makes.
 *
 * Every read goes through the F10 `LaneGitRunner` (no shell, a stripped environment, a timeout and
 * an output bound). Each identity is checked against its grammar before any call, so repository
 * text or a malformed record can never become a Git option or a revision expression. Each read is
 * a value: exit 1 is an answer, and every other failure maps to one bounded code with no Git
 * output attached.
 */

import { CHANGE_REVIEW_LIMITS } from '../../contracts/change-review';
import type { GitRunResult, LaneGitRunner } from '../execution-lanes/git-runner';
import { isValidTargetBranch } from '../execution-lanes/lane-input-rules';

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TARGET_REF_PREFIX = 'refs/heads/';
const PEEL_TO_COMMIT = '^{commit}';
const ANSWER_NO = 1;

export interface ReviewGitContext {
  readonly git: LaneGitRunner;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type ReviewGitFailure = 'deadline' | 'oversized' | 'exit' | 'failed';

export type ReviewGitRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ReviewGitFailure };

/** A full object identity: 40 or 64 lowercase hex characters. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

/** `refs/heads/` followed by a branch name F10 accepts. */
export function isTargetRef(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(TARGET_REF_PREFIX)) return false;
  return isValidTargetBranch(value.slice(TARGET_REF_PREFIX.length));
}

function failureOf(result: Extract<GitRunResult, { ok: false }>): ReviewGitFailure {
  switch (result.code) {
    case 'timeout':
      return 'deadline';
    case 'buffer':
      return 'oversized';
    case 'exit':
      return 'exit';
    default:
      return 'failed';
  }
}

function isAnswerNo(result: GitRunResult): boolean {
  return !result.ok && result.code === 'exit' && result.exitCode === ANSWER_NO;
}

function runOptions(ctx: ReviewGitContext, maxBuffer?: number): { cwd: string; timeoutMs: number; maxBuffer?: number } {
  return maxBuffer === undefined ? { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs } : { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, maxBuffer };
}

function peelArgs(revision: string): readonly string[] {
  return ['rev-parse', '--verify', '--quiet', `${revision}${PEEL_TO_COMMIT}`];
}

/** `true` when `id` names a commit, `false` when it does not, `null` when Git could not say. */
export async function commitExists(ctx: ReviewGitContext, id: string): Promise<boolean | null> {
  if (!isObjectId(id)) return null;
  const result = await ctx.git.run(peelArgs(id), runOptions(ctx));
  if (result.ok) return true;
  return isAnswerNo(result) ? false : null;
}

/** The commit `ref` names now; `null` value when the ref is gone. */
export async function targetTip(ctx: ReviewGitContext, ref: string): Promise<ReviewGitRead<string | null>> {
  if (!isTargetRef(ref)) return { ok: false, failure: 'failed' };
  const result = await ctx.git.run(peelArgs(ref), runOptions(ctx));
  if (isAnswerNo(result)) return { ok: true, value: null };
  if (!result.ok) return { ok: false, failure: failureOf(result) };
  const tip = result.stdout.trim();
  return isObjectId(tip) ? { ok: true, value: tip } : { ok: false, failure: 'failed' };
}

/** `true` when `ancestor` is reachable from `descendant`, `null` when Git could not say. */
export async function isAncestorOf(ctx: ReviewGitContext, ancestor: string, descendant: string): Promise<boolean | null> {
  if (!isObjectId(ancestor) || !isObjectId(descendant)) return null;
  const result = await ctx.git.run(['merge-base', '--is-ancestor', ancestor, descendant], runOptions(ctx));
  if (result.ok) return true;
  return isAnswerNo(result) ? false : null;
}

/** The raw NUL-separated inventory of `target..candidate`, bounded in bytes and time. */
export async function readInventory(ctx: ReviewGitContext, target: string, candidate: string): Promise<ReviewGitRead<string>> {
  if (!isObjectId(target) || !isObjectId(candidate)) return { ok: false, failure: 'failed' };
  const args = ['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-textconv', '--no-ext-diff', target, candidate];
  const result = await ctx.git.run(args, runOptions(ctx, CHANGE_REVIEW_LIMITS.inventoryOutputBytesMax));
  return result.ok ? { ok: true, value: result.stdout } : { ok: false, failure: failureOf(result) };
}

/** One blob's text by identity, bounded to one side's byte limit. */
export async function readBlob(ctx: ReviewGitContext, blob: string): Promise<ReviewGitRead<string>> {
  if (!isObjectId(blob)) return { ok: false, failure: 'failed' };
  const result = await ctx.git.run(['cat-file', 'blob', blob], runOptions(ctx, CHANGE_REVIEW_LIMITS.sideBytesMax));
  return result.ok ? { ok: true, value: result.stdout } : { ok: false, failure: failureOf(result) };
}
