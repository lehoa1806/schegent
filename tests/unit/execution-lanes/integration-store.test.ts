// FR-R6-F10 T013 — the integration store: requests, verification results, receipts, journal.
//
// WHAT THIS PINS:
//   - a request round-trips, scoped to its workspace, and pages by keyset like lanes do;
//   - a transition happens only from an expected state (`request-state-invalid`, or
//     `request-not-found` for a missing request);
//   - entering `verifying` or `landing` while another request of the same repository holds either
//     state refuses `integration-busy` (the partial unique index, FR-009, research R6), and leaves
//     both requests unchanged;
//   - `blockOpenRequestsForLane` blocks `queued`, `awaiting-review` and `blocked` requests with
//     `review-stale`, and nothing else;
//   - verification results are read per attempt in check order;
//   - one receipt per request, whose outcome is written once;
//   - journal `entry_seq` is monotonic per request.

import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATION_STATES, type IntegrationState } from '../../../src/contracts/execution-lanes';
import {
  IntegrationStore,
  type RequestRecord,
  type VerificationResultRecord
} from '../../../src/services/execution-lanes/integration-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW_MS = 1_800_000_000_000;
const WS = 'workspace-a';
const OTHER_WS = 'workspace-b';
const REPO_A = 'a'.repeat(64);
const REPO_B = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const TARGET = 'd'.repeat(40);
const DIGEST = 'e'.repeat(64);
const PROFILE_JSON = JSON.stringify({ profileId: 'default', revision: 1, checks: [] });

const connections: NodeSqliteConnection[] = [];

function openStore(): IntegrationStore {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  connections.push(conn);
  return new IntegrationStore(conn);
}

afterEach(() => {
  for (const conn of connections.splice(0, connections.length)) conn.close();
});

function hexId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function ts(second: number): string {
  return new Date(Date.UTC(2026, 10, 10, 11, 0, second)).toISOString();
}

function request(n: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: hexId(n),
    laneId: hexId(1000),
    workspaceId: WS,
    repositoryId: REPO_A,
    candidateId: hexId(2000),
    candidateCommit: COMMIT,
    targetRef: 'refs/heads/main',
    expectedTargetCommit: TARGET,
    profileId: 'default',
    profileRevision: 1,
    profileDigest: DIGEST,
    profileJson: PROFILE_JSON,
    state: 'queued',
    reason: null,
    verificationAttempt: 0,
    ownerGeneration: 1,
    createdAt: ts(n),
    updatedAt: ts(n),
    ...overrides
  };
}

function change(second: number, reason: string | null = null): { reason: string | null; now: string; generation: number } {
  return { reason, now: ts(second), generation: 1 };
}

function refusalOf(result: { ok: boolean; refusal?: { reason: string } }): string | null {
  return result.ok ? null : (result.refusal?.reason ?? null);
}

describe('FR-R6-F10 integration store: requests', () => {
  it('round-trips a request and scopes reads to its workspace', () => {
    const store = openStore();
    const record = request(1);
    store.insertRequest(record);
    expect(store.getRequest(WS, record.requestId)).toEqual(record);
    expect(store.getRequest(OTHER_WS, record.requestId)).toBeNull();
    expect(store.getRequest(WS, hexId(9))).toBeNull();
  });

  it('transitions only from an expected state, and counts verification attempts', () => {
    const store = openStore();
    store.insertRequest(request(1));
    const verifying = store.transitionRequest(WS, hexId(1), ['queued'], 'verifying', {
      ...change(10),
      startAttempt: true
    });
    expect(verifying.ok && verifying.value.state).toBe('verifying');
    expect(verifying.ok && verifying.value.verificationAttempt).toBe(1);

    expect(refusalOf(store.transitionRequest(WS, hexId(1), ['queued'], 'canceled', change(11)))).toBe(
      'request-state-invalid'
    );
    expect(refusalOf(store.transitionRequest(WS, hexId(7), ['queued'], 'canceled', change(11)))).toBe(
      'request-not-found'
    );
    expect(refusalOf(store.transitionRequest(OTHER_WS, hexId(1), ['verifying'], 'blocked', change(11)))).toBe(
      'request-not-found'
    );

    const blocked = store.transitionRequest(WS, hexId(1), ['verifying'], 'blocked', change(12, 'verification-failed'));
    expect(blocked.ok && blocked.value.reason).toBe('verification-failed');
    expect(blocked.ok && blocked.value.updatedAt).toBe(ts(12));
    expect(blocked.ok && blocked.value.verificationAttempt).toBe(1);
  });

  it('admits one verifying or landing request per repository (FR-009)', () => {
    const store = openStore();
    store.insertRequest(request(1));
    store.insertRequest(request(2));
    store.insertRequest(request(3, { repositoryId: REPO_B }));
    store.insertRequest(request(4, { state: 'awaiting-review' }));

    expect(store.transitionRequest(WS, hexId(1), ['queued'], 'verifying', change(10)).ok).toBe(true);
    const busy = store.transitionRequest(WS, hexId(2), ['queued'], 'verifying', { ...change(11), startAttempt: true });
    expect(refusalOf(busy)).toBe('integration-busy');
    expect(store.getRequest(WS, hexId(2))?.state).toBe('queued');
    expect(store.getRequest(WS, hexId(2))?.verificationAttempt).toBe(0);
    expect(refusalOf(store.transitionRequest(WS, hexId(4), ['awaiting-review'], 'landing', change(11)))).toBe(
      'integration-busy'
    );
    expect(store.getRequest(WS, hexId(1))?.state).toBe('verifying');

    expect(store.transitionRequest(WS, hexId(3), ['queued'], 'verifying', change(12)).ok).toBe(true);

    expect(store.transitionRequest(WS, hexId(1), ['verifying'], 'awaiting-review', change(13)).ok).toBe(true);
    expect(store.transitionRequest(WS, hexId(2), ['queued'], 'verifying', change(14)).ok).toBe(true);
  });

  it('blocks queued, awaiting-review and blocked requests of a lane as review-stale', () => {
    const store = openStore();
    INTEGRATION_STATES.forEach((state: IntegrationState, index) => {
      store.insertRequest(request(index + 1, { state, repositoryId: index.toString(16).padStart(64, '0') }));
    });
    store.insertRequest(request(50, { laneId: hexId(1001) }));

    expect(store.blockOpenRequestsForLane(hexId(1000), change(30))).toBe(3);
    const after = INTEGRATION_STATES.map((_, index) => {
      const stored = store.getRequest(WS, hexId(index + 1));
      return [stored?.state, stored?.reason];
    });
    expect(after).toEqual([
      ['blocked', 'review-stale'],
      ['verifying', null],
      ['blocked', 'review-stale'],
      ['landing', null],
      ['landed', null],
      ['blocked', 'review-stale'],
      ['canceled', null],
      ['uncertain', null]
    ]);
    expect(store.getRequest(WS, hexId(50))?.state).toBe('queued');
  });

  it('counts a lane requests in given states', () => {
    const store = openStore();
    store.insertRequest(request(1, { state: 'verifying' }));
    store.insertRequest(request(2, { state: 'queued', repositoryId: REPO_B }));
    expect(store.countLaneRequests(hexId(1000), ['verifying', 'landing'])).toBe(1);
    expect(store.countLaneRequests(hexId(1000), ['queued', 'awaiting-review', 'blocked'])).toBe(1);
    expect(store.countLaneRequests(hexId(1001), ['queued'])).toBe(0);
  });

  it('pages requests by keyset and filters by lane and state', () => {
    const store = openStore();
    for (let n = 1; n <= 4; n += 1) store.insertRequest(request(n, { state: n === 3 ? 'canceled' : 'queued' }));
    store.insertRequest(request(5, { laneId: hexId(1001) }));
    store.insertRequest(request(6, { workspaceId: OTHER_WS }));

    const first = store.listRequests(WS, { limit: 3 });
    expect(first.ok && first.value.items.map((r) => r.requestId)).toEqual([hexId(1), hexId(2), hexId(3)]);
    const cursor = first.ok ? first.value.nextCursor : null;
    const second = store.listRequests(WS, { limit: 3, cursor: cursor ?? undefined });
    expect(second.ok && second.value.items.map((r) => r.requestId)).toEqual([hexId(4), hexId(5)]);
    expect(second.ok && second.value.nextCursor).toBeNull();

    const laneOnly = store.listRequests(WS, { limit: 10, laneId: hexId(1000), states: ['queued'] });
    expect(laneOnly.ok && laneOnly.value.items.map((r) => r.requestId)).toEqual([hexId(1), hexId(2), hexId(4)]);
    expect(refusalOf(store.listRequests(WS, { limit: 2, cursor: '***' }))).toBe('invalid-input');
  });
});

describe('FR-R6-F10 integration store: verification results', () => {
  function result(
    attempt: number,
    checkIndex: number,
    overrides: Partial<VerificationResultRecord> = {}
  ): VerificationResultRecord {
    return {
      resultId: hexId(attempt * 100 + checkIndex),
      requestId: hexId(1),
      attempt,
      checkIndex,
      checkName: `check-${checkIndex}`,
      candidateCommit: COMMIT,
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 5,
      outputBytes: 12,
      outputSha256: DIGEST,
      recordedAt: ts(checkIndex),
      ...overrides
    };
  }

  it('reads one attempt in check order', () => {
    const store = openStore();
    store.insertVerificationResult(result(1, 1, { exitCode: 2 }));
    store.insertVerificationResult(result(1, 0));
    store.insertVerificationResult(result(2, 0, { exitCode: null, signal: 'SIGKILL', timedOut: true }));
    expect(store.listVerificationResults(hexId(1), 1).map((r) => [r.checkIndex, r.exitCode])).toEqual([
      [0, 0],
      [1, 2]
    ]);
    expect(store.listVerificationResults(hexId(1), 2)).toEqual([
      result(2, 0, { exitCode: null, signal: 'SIGKILL', timedOut: true })
    ]);
    expect(store.listVerificationResults(hexId(1), 3)).toEqual([]);
  });

  it('refuses a second result for the same check of one attempt', () => {
    const store = openStore();
    store.insertVerificationResult(result(1, 0));
    expect(() => store.insertVerificationResult(result(1, 0, { resultId: hexId(999) }))).toThrow();
  });
});

describe('FR-R6-F10 integration store: receipts and the journal', () => {
  it('keeps one receipt per request and writes its outcome once', () => {
    const store = openStore();
    const receipt = {
      receiptId: hexId(300),
      requestId: hexId(1),
      laneId: hexId(1000),
      candidateCommit: COMMIT,
      targetRef: 'refs/heads/main',
      targetCommit: TARGET,
      profileRevision: 1,
      profileDigest: DIGEST,
      approvedAt: ts(20),
      outcome: null,
      outcomeReason: null,
      ownerGeneration: 1
    };
    store.insertReceipt(receipt);
    expect(store.getReceipt(hexId(1))).toEqual(receipt);
    expect(store.getReceipt(hexId(2))).toBeNull();
    expect(() => store.insertReceipt({ ...receipt, receiptId: hexId(301) })).toThrow();

    expect(store.setReceiptOutcome(hexId(1), 'landed', 'target-advanced-beyond')).toBe(true);
    expect(store.setReceiptOutcome(hexId(1), 'blocked', 'landing-not-applied')).toBe(false);
    expect(store.getReceipt(hexId(1))?.outcome).toBe('landed');
    expect(store.getReceipt(hexId(1))?.outcomeReason).toBe('target-advanced-beyond');
  });

  it('numbers journal entries per request, in order', () => {
    const store = openStore();
    const base = {
      candidateCommit: COMMIT,
      expectedCommit: TARGET,
      observedTip: null,
      outcome: null,
      reason: null,
      method: null,
      generation: 1
    };
    const intent = store.appendJournal({
      ...base,
      entryId: hexId(400),
      requestId: hexId(1),
      kind: 'landing-intent',
      method: 'ff-merge',
      now: ts(1)
    });
    const other = store.appendJournal({
      ...base,
      entryId: hexId(401),
      requestId: hexId(2),
      kind: 'cancel',
      outcome: 'canceled',
      now: ts(2)
    });
    const observed = store.appendJournal({
      ...base,
      entryId: hexId(402),
      requestId: hexId(1),
      kind: 'landing-observed',
      method: 'ff-merge',
      observedTip: COMMIT,
      outcome: 'landed',
      now: ts(3)
    });
    expect([intent.seq, other.seq, observed.seq]).toEqual([1, 1, 2]);
    expect(store.listJournal(hexId(1)).map((entry) => [entry.seq, entry.kind, entry.outcome])).toEqual([
      [1, 'landing-intent', null],
      [2, 'landing-observed', 'landed']
    ]);
    expect(store.listJournal(hexId(1)).at(1)).toEqual(observed);
  });
});
