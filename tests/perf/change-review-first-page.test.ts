// FR-R6-F12 (T028; NFR-001, NFR-002, SC-004; F12-AC-04) — first-page review data on a generated
// 1,050-file change set.
//
// The fixture is a real repository in the OS temp directory: a target commit and a candidate commit
// that adds 1,050 small files. Each measured take is one `openReview` through the real Git runner:
// the two commit checks, the ancestry check, the bounded inventory read and parse, the target tip
// read, classification and the first page. 3 warm-up and 20 measured takes.
//
// Asserted: total 1,050, loaded 1,000, truncated, pages of at most 200 in index order, and the
// first-page p95 within 500 ms (NFR-002). Every take is printed so a miss can be read.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS } from '../../src/contracts/change-review';
import { createChangeReviewService } from '../../src/services/change-review/change-review-service';
import { createExecFileGitRunner } from '../../src/services/execution-lanes/git-runner';
import type { RequestRecord } from '../../src/services/execution-lanes/integration-store-rows';

const FILE_COUNT = 1_050;
const WARMUP_TAKES = 3;
const MEASURED_TAKES = 20;
const P95_BUDGET_MS = 500;
const P95_RANK = 0.95;
const TEST_TIMEOUT_MS = 300_000;
const REQUEST_ID = 'd'.repeat(32);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-change-review-perf-'));

function git(args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=Perf', '-c', 'user.email=perf@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) }
  }).trim();
}

function fixture(): { readonly target: string; readonly candidate: string } {
  git(['init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'README.txt'), 'base\n');
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'target']);
  const target = git(['rev-parse', 'HEAD']);
  git(['checkout', '--quiet', '-b', 'candidate']);
  fs.mkdirSync(path.join(root, 'gen'));
  for (let index = 0; index < FILE_COUNT; index += 1) {
    fs.writeFileSync(path.join(root, 'gen', `file-${String(index).padStart(4, '0')}.txt`), `line ${String(index)}\n`);
  }
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'candidate']);
  return { target, candidate: git(['rev-parse', 'HEAD']) };
}

function request(target: string, candidate: string): RequestRecord {
  return {
    requestId: REQUEST_ID,
    laneId: 'lane-perf',
    workspaceId: 'ws-perf',
    repositoryId: 'repo-perf',
    candidateId: 'cand-perf',
    candidateCommit: candidate,
    targetRef: 'refs/heads/main',
    expectedTargetCommit: target,
    profileId: 'default',
    profileRevision: 1,
    profileDigest: 'digest-perf',
    profileJson: '{}',
    state: 'awaiting-review',
    reason: null,
    verificationAttempt: 1,
    ownerGeneration: 1,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z'
  };
}

function percentile(samples: readonly number[], rank: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
  return sorted.at(index) ?? Number.NaN;
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('change review first page at 1,050 files (FR-R6-F12 NFR-002)', () => {
  it(
    'opens with the bounds applied and the first page within the p95 target',
    async () => {
      const { target, candidate } = fixture();
      const record = request(target, candidate);
      const service = createChangeReviewService({
        source: { getRequest: (id) => (id === REQUEST_ID ? record : null), getReceipt: () => null },
        git: createExecFileGitRunner(),
        cwd: root
      });

      const take = async (): Promise<number> => {
        const started = performance.now();
        const result = await service.openReview({ requestId: REQUEST_ID });
        const elapsed = performance.now() - started;
        if (!result.ok || result.value.review === null) throw new Error('openReview did not build a review');
        service.closeReview(result.value.review.reviewId);
        return elapsed;
      };
      for (let index = 0; index < WARMUP_TAKES; index += 1) await take();
      const samples: number[] = [];
      for (let index = 0; index < MEASURED_TAKES; index += 1) samples.push(await take());

      const opened = await service.openReview({ requestId: REQUEST_ID });
      expect(opened.ok).toBe(true);
      if (!opened.ok || opened.value.review === null) return;
      const review = opened.value.review;
      expect([review.total, review.loaded, review.truncated]).toEqual([FILE_COUNT, CHANGE_REVIEW_LIMITS.loadedEntriesMax, true]);

      const sizes: number[] = [];
      let lastIndex = -1;
      let page = opened.value.firstPage;
      for (;;) {
        sizes.push(page.entries.length);
        lastIndex = page.entries.at(-1)?.index ?? lastIndex;
        if (page.nextCursor === null) break;
        const next = service.readPage(page.nextCursor);
        if (!next.ok) throw new Error('readPage refused a cursor it issued');
        page = next.value;
      }
      expect(sizes).toEqual([200, 200, 200, 200, 200]);
      expect(lastIndex).toBe(CHANGE_REVIEW_LIMITS.loadedEntriesMax - 1);

      const p95 = percentile(samples, P95_RANK);
      const median = percentile(samples, 0.5);
      console.log(
        `[change-review perf] first page over ${String(MEASURED_TAKES)} takes: p50 ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms ` +
          `(target ${String(P95_BUDGET_MS)} ms); takes ${samples.map((sample) => sample.toFixed(1)).join(', ')}`
      );
      expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    },
    TEST_TIMEOUT_MS
  );
});
