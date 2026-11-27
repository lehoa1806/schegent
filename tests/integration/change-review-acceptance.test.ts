// FR-R6-F12 T033 — the change review acceptance scenarios (quickstart section 2), end to end through
// the headless port over a real fixture repository and an in-memory F10 integration store.
//
// WHAT THIS PINS:
//   - AC-02: every change kind is listed once, and each side reads its committed text or its fixed
//     placeholder; approval and landing eligibility follow the stored receipt;
//   - AC-03: a target advance makes the review `stale` with `target-advanced`; the stale review
//     still reads its original text; a refresh is a new review and leaves the old one open;
//   - AC-04: 1,050 changed files give total 1,050, loaded 1,000, truncated, and five 200-entry
//     pages;
//   - AC-07: a hostile path is listed exactly and shown only as an inert display name; hostile
//     inputs reach no store or Git read;
//   - review R-2: a stored request row the store cannot decode is a value, never a rejection:
//     classify reads `uncertain` and open reads `unavailable`, both `record-unreadable`.
//
// AC-01, AC-05 and AC-06 are deferred (spec, F12 traceability).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeEntry, ChangeKind } from '../../src/contracts/change-review';
import { createChangeReviewApi, type ChangeReviewApi } from '../../src/headless/change-review-api';
import { createChangeReviewService, integrationStoreSource, type ChangeReviewService } from '../../src/services/change-review/index';
import { createExecFileGitRunner, type LaneGitRunner } from '../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../src/services/execution-lanes/integration-store';
import type { ReceiptRecord, RequestRecord } from '../../src/services/execution-lanes/integration-store-rows';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { displayName, pickLabel } from '../../src/ui/change-review/review-uri';
import { createFixtureRepo, type FixtureRepo } from '../unit/execution-lanes/fixture-repo';

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const STAMP = '2026-11-11T12:00:00.000Z';
const WS = 'workspace-f12';
const TARGET_REF = 'refs/heads/main';
const LARGE_FILE_COUNT = 1_050;
const SLOW_TEST_MS = 120_000;
const RLO = String.fromCodePoint(0x202e);
const TAB = String.fromCodePoint(0x09);
const REPLACEMENT = String.fromCodePoint(0xfffd);
const HOSTILE_NAME = `hostile${RLO}txt.exe${TAB}$(zap) <img src=x onerror=1>.txt`;
const RENAMED_TEXT = Array.from({ length: 20 }, (_, index) => `rename line ${String(index)}`).join('\n');

const hex = (char: string, length: number): string => char.repeat(length);

interface Host {
  readonly fixture: FixtureRepo;
  readonly conn: NodeSqliteConnection;
  readonly store: IntegrationStore;
  readonly service: ChangeReviewService;
  readonly api: ChangeReviewApi;
  /** Every Git argument list the service ran. */
  readonly gitCalls: string[][];
  readonly storeReads: { count: number };
}

const opened: Array<{ readonly conn: NodeSqliteConnection; readonly fixture: FixtureRepo }> = [];

afterEach(() => {
  for (const { conn, fixture } of opened.splice(0, opened.length)) {
    if (!conn.isClosed()) conn.close();
    fixture.dispose();
  }
});

function host(label: string): Host {
  const fixture = createFixtureRepo(`f12-${label}`);
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  opened.push({ conn, fixture });
  const store = new IntegrationStore(conn);
  const real = createExecFileGitRunner();
  const gitCalls: string[][] = [];
  const git: LaneGitRunner = {
    run: (args, options) => {
      gitCalls.push([...args]);
      return real.run(args, options);
    }
  };
  const storeReads = { count: 0 };
  const inner = integrationStoreSource(store, WS);
  const source = {
    getRequest: (requestId: string) => {
      storeReads.count += 1;
      return inner.getRequest(requestId);
    },
    getReceipt: (requestId: string) => inner.getReceipt(requestId)
  };
  const service = createChangeReviewService({ source, git, cwd: fixture.root });
  const api = createChangeReviewApi(service, { isWorkspaceTrusted: () => true });
  return { fixture, conn, store, service, api, gitCalls, storeReads };
}

function requestRecord(requestId: string, candidateCommit: string, expectedTargetCommit: string): RequestRecord {
  return {
    requestId,
    laneId: hex('1', 32),
    workspaceId: WS,
    repositoryId: hex('2', 64),
    candidateId: hex('3', 32),
    candidateCommit,
    targetRef: TARGET_REF,
    expectedTargetCommit,
    profileId: 'default',
    profileRevision: 1,
    profileDigest: hex('4', 64),
    profileJson: '{}',
    state: 'awaiting-review',
    reason: null,
    verificationAttempt: 1,
    ownerGeneration: 1,
    createdAt: STAMP,
    updatedAt: STAMP
  };
}

function receiptFor(request: RequestRecord): ReceiptRecord {
  return {
    receiptId: hex('5', 32),
    requestId: request.requestId,
    laneId: request.laneId,
    candidateCommit: request.candidateCommit,
    targetRef: request.targetRef,
    targetCommit: request.expectedTargetCommit,
    profileRevision: request.profileRevision,
    profileDigest: request.profileDigest,
    approvedAt: STAMP,
    outcome: null,
    outcomeReason: null,
    ownerGeneration: 1
  };
}

/** Target: four tracked files. Candidate: one change of every kind, a binary and a hostile name. */
function everyKind(fixture: FixtureRepo): { readonly target: string; readonly candidate: string } {
  fixture.write('a.txt', 'before\n');
  fixture.write('d.txt', 'deleted text\n');
  fixture.write('m.txt', `${RENAMED_TEXT}\n`);
  fixture.write('t.txt', 'plain file\n');
  const target = fixture.commit('target');
  fixture.git(['checkout', '-q', '-b', 'candidate']);
  fixture.write('a.txt', 'after\n');
  fs.rmSync(path.join(fixture.root, 'd.txt'));
  fixture.write('n.txt', 'new text\n');
  fs.renameSync(path.join(fixture.root, 'm.txt'), path.join(fixture.root, 'moved.txt'));
  fs.rmSync(path.join(fixture.root, 't.txt'));
  fs.symlinkSync('a.txt', path.join(fixture.root, 't.txt'));
  fs.writeFileSync(path.join(fixture.root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 0]));
  fixture.write(HOSTILE_NAME, 'hostile text\n');
  fixture.commit('candidate');
  const candidate = fixture.addGitlink('sub', target);
  return { target, candidate };
}

async function openCurrent(api: ChangeReviewApi, requestId: string) {
  const result = await api.openReview({ requestId });
  if (!result.ok || result.value.review === null) throw new Error(`open refused: ${JSON.stringify(result)}`);
  return { review: result.value.review, firstPage: result.value.firstPage, state: result.value.state, reason: result.value.reason };
}

function byKind(entries: readonly ChangeEntry[], kind: ChangeKind): ChangeEntry {
  const found = entries.filter((entry) => entry.kind === kind && !entry.binary && (entry.newPath ?? '') !== HOSTILE_NAME);
  const entry = found.at(0);
  if (found.length !== 1 || entry === undefined) throw new Error(`expected one ${kind} entry, found ${String(found.length)}`);
  return entry;
}

async function text(service: ChangeReviewService, handle: string | null): Promise<string> {
  if (handle === null) throw new Error('side has no handle');
  return (await service.readContent(handle)).text;
}

describe('FR-R6-F12 change review acceptance', () => {
  it(
    'AC-02: lists every kind once and reads each side; eligibility follows the receipt',
    async () => {
      const h = host('kinds');
      const { target, candidate } = everyKind(h.fixture);
      const request = requestRecord(hex('a', 32), candidate, target);
      h.store.insertRequest(request);

      const { review, firstPage, state } = await openCurrent(h.api, request.requestId);
      expect(state).toBe('current');
      expect([review.total, review.loaded, review.truncated]).toEqual([8, 8, false]);
      expect([review.approval, review.landing]).toEqual([
        { eligible: true, reason: null },
        { eligible: false, reason: 'receipt-missing' }
      ]);
      const entries = firstPage.entries;
      expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      const paths = entries.map((entry) => entry.newPath ?? entry.oldPath);
      expect(new Set(paths).size).toBe(entries.length);

      const modified = byKind(entries, 'modified');
      expect([modified.oldPath, await text(h.service, modified.oldHandle), await text(h.service, modified.newHandle)]).toEqual([
        'a.txt',
        'before\n',
        'after\n'
      ]);
      const deleted = byKind(entries, 'deleted');
      expect([deleted.oldPath, deleted.newPath, deleted.newHandle, await text(h.service, deleted.oldHandle)]).toEqual([
        'd.txt',
        null,
        null,
        'deleted text\n'
      ]);
      const added = byKind(entries, 'added');
      expect([added.oldPath, added.newPath, added.oldHandle, await text(h.service, added.newHandle)]).toEqual([
        null,
        'n.txt',
        null,
        'new text\n'
      ]);
      const renamed = byKind(entries, 'renamed');
      expect([renamed.oldPath, renamed.newPath, renamed.similarity]).toEqual(['m.txt', 'moved.txt', 100]);
      expect(await text(h.service, renamed.newHandle)).toBe(`${RENAMED_TEXT}\n`);
      const typeChanged = byKind(entries, 'type-changed');
      expect([typeChanged.oldPath, await text(h.service, typeChanged.oldHandle)]).toEqual(['t.txt', 'plain file\n']);
      const submodule = byKind(entries, 'submodule');
      expect([submodule.newPath, (await h.service.readContent(submodule.newHandle ?? '')).kind]).toEqual(['sub', 'placeholder']);
      const binary = entries.find((entry) => entry.binary);
      expect(binary?.newPath).toBe('bin.dat');
      expect(await h.service.readContent(binary?.newHandle ?? '')).toMatchObject({ kind: 'placeholder', reason: 'binary' });

      h.store.insertReceipt(receiptFor(request));
      const classified = await h.api.classifyReview({ reviewId: review.reviewId });
      expect(classified).toMatchObject({
        ok: true,
        value: {
          state: 'current',
          approval: { eligible: false, reason: 'already-approved' },
          landing: { eligible: true, reason: null }
        }
      });
    },
    SLOW_TEST_MS
  );

  it(
    'AC-03: a target advance gives stale, the stale review still reads, and refresh is a new review',
    async () => {
      const h = host('stale');
      const { target, candidate } = everyKind(h.fixture);
      const request = requestRecord(hex('b', 32), candidate, target);
      h.store.insertRequest(request);
      const { review, firstPage } = await openCurrent(h.api, request.requestId);
      const modified = byKind(firstPage.entries, 'modified');

      h.fixture.git(['checkout', '-q', 'main']);
      h.fixture.write('later.txt', 'moved on\n');
      h.fixture.commit('target advances');

      const classified = await h.api.classifyReview({ reviewId: review.reviewId });
      expect(classified).toMatchObject({
        ok: true,
        value: {
          state: 'stale',
          reason: 'target-advanced',
          approval: { eligible: false, reason: 'review-not-current' },
          landing: { eligible: false, reason: 'review-not-current' }
        }
      });
      expect(await text(h.service, modified.oldHandle)).toBe('before\n');
      expect(await text(h.service, modified.newHandle)).toBe('after\n');

      const refreshed = await h.api.refreshReview({ reviewId: review.reviewId });
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok || refreshed.value.review === null) return;
      expect(refreshed.value.review.reviewId).not.toBe(review.reviewId);
      expect([refreshed.value.state, refreshed.value.reason]).toEqual(['stale', 'target-advanced']);
      expect(await text(h.service, modified.newHandle)).toBe('after\n');
      expect(h.api.closeReview({ reviewId: review.reviewId })).toEqual({ ok: true, value: { closed: true } });
    },
    SLOW_TEST_MS
  );

  it(
    'AC-04: 1,050 changed files give the bounded counts and five 200-entry pages',
    async () => {
      const h = host('large');
      const target = h.fixture.head();
      h.fixture.git(['checkout', '-q', '-b', 'large']);
      for (let index = 0; index < LARGE_FILE_COUNT; index += 1) {
        h.fixture.write(path.join('gen', `file-${String(index).padStart(4, '0')}.txt`), `line ${String(index)}\n`);
      }
      const candidate = h.fixture.commit('large candidate');
      const request = requestRecord(hex('c', 32), candidate, target);
      h.store.insertRequest(request);

      const { review, firstPage } = await openCurrent(h.api, request.requestId);
      expect([review.total, review.loaded, review.truncated]).toEqual([LARGE_FILE_COUNT, 1_000, true]);
      const sizes = [firstPage.entries.length];
      let cursor = firstPage.nextCursor;
      let lastIndex = firstPage.entries.at(-1)?.index;
      while (cursor !== null) {
        const page = h.api.readPage({ cursor });
        if (!page.ok) throw new Error(`readPage refused: ${page.reason}`);
        sizes.push(page.value.entries.length);
        lastIndex = page.value.entries.at(-1)?.index;
        cursor = page.value.nextCursor;
      }
      expect(sizes).toEqual([200, 200, 200, 200, 200]);
      expect(lastIndex).toBe(999);
    },
    SLOW_TEST_MS
  );

  it(
    'AC-07: a hostile path is listed exactly and shown inert; hostile inputs reach no read',
    async () => {
      const h = host('hostile');
      const { target, candidate } = everyKind(h.fixture);
      const request = requestRecord(hex('d', 32), candidate, target);
      h.store.insertRequest(request);

      const hostileInputs: readonly unknown[] = [
        { requestId: '../../etc/passwd' },
        { requestId: 'file:///etc/passwd' },
        { requestId: 'command:workbench.action.terminal.new' },
        { requestId: '<img src=x onerror=alert(1)>' },
        { requestId: request.requestId, path: HOSTILE_NAME },
        { requestId: request.requestId.toUpperCase() }
      ];
      for (const input of hostileInputs) {
        await expect(h.api.openReview(input)).resolves.toEqual({ ok: false, reason: 'invalid-input' });
      }
      expect(h.api.readPage({ cursor: '$(zap)' })).toEqual({ ok: false, reason: 'invalid-input' });
      expect(h.storeReads.count).toBe(0);
      expect(h.gitCalls).toEqual([]);

      const { firstPage } = await openCurrent(h.api, request.requestId);
      const hostile = firstPage.entries.find((entry) => entry.newPath === HOSTILE_NAME);
      expect(hostile?.kind).toBe('added');
      expect(await text(h.service, hostile?.newHandle ?? null)).toBe('hostile text\n');

      const shown = displayName(HOSTILE_NAME);
      expect(shown).toBe(`hostile${REPLACEMENT}txt.exe${REPLACEMENT}$(zap) <img src=x onerror=1>.txt`);
      expect(pickLabel(HOSTILE_NAME).includes('$(')).toBe(false);
      for (const entry of firstPage.entries) {
        for (const side of [entry.oldHandle, entry.newHandle]) {
          if (side !== null) expect(side).toMatch(/^[A-Za-z0-9_-]{22}$/);
        }
      }
    },
    SLOW_TEST_MS
  );

  it(
    'R-2: a request row the store cannot decode reads as a value, never a rejection',
    async () => {
      const h = host('corrupt');
      const { target, candidate } = everyKind(h.fixture);
      const request = requestRecord(hex('e', 32), candidate, target);
      h.store.insertRequest(request);
      const { review } = await openCurrent(h.api, request.requestId);

      h.conn.exec('PRAGMA ignore_check_constraints = ON');
      h.conn.run('UPDATE lane_integration_requests SET state = ? WHERE request_id = ?', 'not-a-state', request.requestId);
      h.conn.exec('PRAGMA ignore_check_constraints = OFF');
      expect(() => h.store.getRequest(WS, request.requestId)).toThrow();

      const classified = await h.api.classifyReview({ reviewId: review.reviewId });
      expect(classified.ok && classified.value).toMatchObject({
        state: 'uncertain',
        reason: 'record-unreadable',
        approval: { eligible: false, reason: 'review-not-current' },
        landing: { eligible: false, reason: 'review-not-current' }
      });
      const callsBefore = h.gitCalls.length;
      expect(await h.api.openReview({ requestId: request.requestId })).toEqual({
        ok: true,
        value: { state: 'unavailable', reason: 'record-unreadable', review: null, firstPage: null }
      });
      expect(h.gitCalls.length).toBe(callsBefore);
    },
    SLOW_TEST_MS
  );
});
