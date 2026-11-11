// FR-R6-F12 — a scripted Git runner and request fixtures shared by the change review unit tests.

import type { ReceiptRecord, RequestRecord } from '../../../src/services/execution-lanes/integration-store-rows';
import type { GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import type { ChangeReviewSource } from '../../../src/services/change-review/review-source';

export const CANDIDATE = 'c'.repeat(40);
export const TARGET = 'a'.repeat(40);
export const MOVED_TARGET = 'b'.repeat(40);
export const REQUEST_ID = 'f'.repeat(32);
export const TARGET_REF = 'refs/heads/main';
export const NULL_SHA = '0'.repeat(40);
export const BLOB_OLD = '1'.repeat(40);
export const BLOB_NEW = '2'.repeat(40);

const Z = '\u0000';

export const OK = (stdout: string): GitRunResult => ({ ok: true, stdout });
export const EXIT_1: GitRunResult = { ok: false, exitCode: 1, code: 'exit' };
export const EXIT_128: GitRunResult = { ok: false, exitCode: 128, code: 'exit' };
export const TIMEOUT: GitRunResult = { ok: false, exitCode: null, code: 'timeout' };
export const BUFFER: GitRunResult = { ok: false, exitCode: null, code: 'buffer' };

/** One added, one deleted and one modified file, in Git's -z raw then numstat layout. */
export const THREE_CHANGES =
  `:000000 100644 ${NULL_SHA} ${BLOB_NEW} A${Z}added.txt${Z}` +
  `:100644 000000 ${BLOB_OLD} ${NULL_SHA} D${Z}gone.txt${Z}` +
  `:100644 100644 ${BLOB_OLD} ${BLOB_NEW} M${Z}mod.txt${Z}` +
  `1\t0\tadded.txt${Z}0\t1\tgone.txt${Z}1\t1\tmod.txt${Z}`;

export interface ScriptedGit {
  readonly git: LaneGitRunner;
  readonly calls: string[][];
  /** Replace one verb's answer; the key is the first argument (`rev-parse`, `diff-tree`, ...). */
  answer(key: string, result: GitRunResult | ((args: readonly string[]) => GitRunResult)): void;
  /** Move the target ref's tip; `null` removes the ref. */
  setTip(value: string | null): void;
}

/** A runner that answers each verb as scripted; the target tip starts at TARGET. */
export function scriptedGit(inventory: string = THREE_CHANGES): ScriptedGit {
  const calls: string[][] = [];
  let tip: string | null = TARGET;
  const answers = new Map<string, (args: readonly string[]) => GitRunResult>();
  answers.set('rev-parse', (args) => {
    const revision = args.at(3) ?? '';
    if (!revision.startsWith('refs/heads/')) return OK(`${revision.slice(0, -'^{commit}'.length)}\n`);
    return tip === null ? EXIT_1 : OK(`${tip}\n`);
  });
  answers.set('merge-base', () => OK(''));
  answers.set('diff-tree', () => OK(inventory));
  answers.set('cat-file', (args) => OK(`text of ${args.at(2) ?? ''}\n`));
  return {
    calls,
    git: {
      run: (args) => {
        calls.push([...args]);
        const handler = answers.get(args.at(0) ?? '');
        return Promise.resolve(handler === undefined ? EXIT_128 : handler(args));
      }
    },
    answer: (key, result) => {
      answers.set(key, typeof result === 'function' ? result : () => result);
    },
    setTip: (value) => {
      tip = value;
    }
  };
}

export function requestRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: REQUEST_ID,
    laneId: 'lane-1',
    workspaceId: 'ws-1',
    repositoryId: 'repo-1',
    candidateId: 'cand-1',
    candidateCommit: CANDIDATE,
    targetRef: TARGET_REF,
    expectedTargetCommit: TARGET,
    profileId: 'default',
    profileRevision: 2,
    profileDigest: 'digest-a',
    profileJson: '{}',
    state: 'awaiting-review',
    reason: null,
    verificationAttempt: 1,
    ownerGeneration: 1,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides
  };
}

export function receiptRecord(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    receiptId: 'receipt-1',
    requestId: REQUEST_ID,
    laneId: 'lane-1',
    candidateCommit: CANDIDATE,
    targetRef: TARGET_REF,
    targetCommit: TARGET,
    profileRevision: 2,
    profileDigest: 'digest-a',
    approvedAt: '2026-11-11T00:00:00.000Z',
    outcome: null,
    outcomeReason: null,
    ownerGeneration: 1,
    ...overrides
  };
}

export interface MutableSource extends ChangeReviewSource {
  request: RequestRecord | null;
  receipt: ReceiptRecord | null;
  reads: number;
}

export function mutableSource(request: RequestRecord | null = requestRecord()): MutableSource {
  const source: MutableSource = {
    request,
    receipt: null,
    reads: 0,
    getRequest: (requestId) => {
      source.reads += 1;
      return source.request !== null && source.request.requestId === requestId ? source.request : null;
    },
    getReceipt: (requestId) => (source.receipt !== null && source.receipt.requestId === requestId ? source.receipt : null)
  };
  return source;
}
