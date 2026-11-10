// FR-R6-F10 T011 — the lane store: lanes, operations, candidates and the generation fence.
//
// WHAT THIS PINS:
//   - `claimGeneration` increments per workspace, and workspaces do not share a counter;
//   - `assertGeneration` refuses `ownership-superseded` for an older value, and `fenced` checks it
//     inside the same transaction as the write it guards, so a stale owner writes nothing;
//   - a lane round-trips, and is read only within its own workspace;
//   - a state transition happens only from an expected state, otherwise `lane-state-invalid`
//     (or `lane-not-found` for a lane that does not exist);
//   - the live count covers `preparing`, `active` and `paused` only;
//   - a keyset page holds at most `limit` lanes, its cursor round-trips, and a bad cursor refuses;
//   - an operation records `pending`, then one final status;
//   - candidates take the next sequence number, and the current one is the highest.

import { afterEach, describe, expect, it } from 'vitest';
import { LANE_STATES, type LaneState } from '../../../src/contracts/execution-lanes';
import { LaneStore } from '../../../src/services/execution-lanes/lane-store';
import {
  type LaneRecord,
  decodeLaneCursor,
  encodeLaneCursor,
  laneBaseRef,
  laneCandidateRef,
  laneRootRef
} from '../../../src/services/execution-lanes/lane-store-rows';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW_MS = 1_800_000_000_000;
const WS = 'workspace-a';
const OTHER_WS = 'workspace-b';
const REPO_ID = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);

const connections: NodeSqliteConnection[] = [];

function openStore(): { store: LaneStore; conn: NodeSqliteConnection } {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  connections.push(conn);
  return { store: new LaneStore(conn), conn };
}

afterEach(() => {
  for (const conn of connections.splice(0, connections.length)) conn.close();
});

function hexId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function ts(second: number): string {
  return new Date(Date.UTC(2026, 10, 10, 10, 0, second)).toISOString();
}

function laneRecord(n: number, overrides: Partial<LaneRecord> = {}): LaneRecord {
  const laneId = hexId(n);
  const workspaceId = overrides.workspaceId ?? WS;
  return {
    laneId,
    workspaceId,
    repositoryId: REPO_ID,
    rootExecutionId: `exec-${n}`,
    sourceCommit: COMMIT,
    baseRef: laneBaseRef(laneId),
    candidateRef: laneCandidateRef(laneId),
    rootRef: laneRootRef(workspaceId, laneId),
    dependencyRecipe: 'none',
    state: 'preparing',
    stateReason: null,
    pinned: false,
    ownerGeneration: 1,
    createdAt: ts(n),
    updatedAt: ts(n),
    ...overrides
  };
}

function refusalOf(result: { ok: boolean; refusal?: { reason: string } }): string | null {
  return result.ok ? null : (result.refusal?.reason ?? null);
}

describe('FR-R6-F10 lane store: the generation fence (research R7)', () => {
  it('claims increasing generations per workspace', () => {
    const { store } = openStore();
    expect(store.currentGeneration(WS)).toBeNull();
    expect(store.claimGeneration(WS, ts(1))).toBe(1);
    expect(store.claimGeneration(WS, ts(2))).toBe(2);
    expect(store.claimGeneration(OTHER_WS, ts(3))).toBe(1);
    expect(store.currentGeneration(WS)).toBe(2);
    expect(store.currentGeneration(OTHER_WS)).toBe(1);
  });

  it('refuses an older generation and admits the current one', () => {
    const { store } = openStore();
    const first = store.claimGeneration(WS, ts(1));
    const second = store.claimGeneration(WS, ts(2));
    expect(refusalOf(store.assertGeneration(WS, first))).toBe('ownership-superseded');
    expect(store.assertGeneration(WS, second)).toEqual({ ok: true, value: undefined });
    expect(refusalOf(store.assertGeneration(OTHER_WS, 1))).toBe('ownership-superseded');
  });

  it('runs a fenced write only for the current owner, inside one transaction', () => {
    const { store, conn } = openStore();
    const stale = store.claimGeneration(WS, ts(1));
    const current = store.claimGeneration(WS, ts(2));

    let ranStale = false;
    const refused = store.fenced(WS, stale, () => {
      ranStale = true;
      store.insertLane(laneRecord(1, { ownerGeneration: stale }));
      return { ok: true as const, value: 'written' };
    });
    expect(refusalOf(refused)).toBe('ownership-superseded');
    expect(ranStale).toBe(false);
    expect(store.getLane(WS, hexId(1))).toBeNull();

    let sawTransaction = false;
    const admitted = store.fenced(WS, current, () => {
      sawTransaction = conn.db.isTransaction;
      store.insertLane(laneRecord(2, { ownerGeneration: current }));
      return { ok: true as const, value: 'written' };
    });
    expect(admitted).toEqual({ ok: true, value: 'written' });
    expect(sawTransaction).toBe(true);
    expect(conn.db.isTransaction).toBe(false);
    expect(store.getLane(WS, hexId(2))?.ownerGeneration).toBe(current);
  });

  it('rolls a fenced write back when the work throws', () => {
    const { store } = openStore();
    const generation = store.claimGeneration(WS, ts(1));
    expect(() =>
      store.fenced(WS, generation, () => {
        store.insertLane(laneRecord(3));
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.getLane(WS, hexId(3))).toBeNull();
  });
});

describe('FR-R6-F10 lane store: lanes', () => {
  it('round-trips a lane and scopes reads to its workspace', () => {
    const { store } = openStore();
    const lane = laneRecord(1, { pinned: true, stateReason: null });
    store.insertLane(lane);
    expect(store.getLane(WS, lane.laneId)).toEqual(lane);
    expect(store.getLane(OTHER_WS, lane.laneId)).toBeNull();
    expect(store.getLane(WS, hexId(99))).toBeNull();
  });

  it('names refs and the root reference from the lane id', () => {
    const laneId = hexId(7);
    expect(laneBaseRef(laneId)).toBe(`refs/schegent/lanes/${laneId}/base`);
    expect(laneCandidateRef(laneId)).toBe(`refs/schegent/lanes/${laneId}/candidate`);
    expect(laneRootRef(WS, laneId)).toBe(`lanes/${WS}/${laneId}`);
  });

  it('transitions only from an expected state', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(1));
    const activated = store.transitionLane(WS, hexId(1), ['preparing'], 'active', {
      reason: null,
      now: ts(30),
      generation: 2
    });
    expect(activated.ok).toBe(true);
    const stored = store.getLane(WS, hexId(1));
    expect(stored?.state).toBe('active');
    expect(stored?.updatedAt).toBe(ts(30));
    expect(stored?.ownerGeneration).toBe(2);

    const again = store.transitionLane(WS, hexId(1), ['preparing'], 'preparation-failed', {
      reason: 'provisioning-git-failed',
      now: ts(31),
      generation: 2
    });
    expect(refusalOf(again)).toBe('lane-state-invalid');
    expect(store.getLane(WS, hexId(1))?.state).toBe('active');

    const missing = store.transitionLane(WS, hexId(9), ['active'], 'paused', {
      reason: null,
      now: ts(32),
      generation: 2
    });
    expect(refusalOf(missing)).toBe('lane-not-found');
    const elsewhere = store.transitionLane(OTHER_WS, hexId(1), ['active'], 'paused', {
      reason: null,
      now: ts(32),
      generation: 2
    });
    expect(refusalOf(elsewhere)).toBe('lane-not-found');
  });

  it('records a state reason and returns the updated lane', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(1));
    const failed = store.transitionLane(WS, hexId(1), ['preparing'], 'preparation-failed', {
      reason: 'provisioning-deadline-exceeded',
      now: ts(40),
      generation: 1
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.value.state).toBe('preparation-failed');
      expect(failed.value.stateReason).toBe('provisioning-deadline-exceeded');
    }
  });

  it('sets the pin without changing the state', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(1, { state: 'active' }));
    const pinned = store.setPinned(WS, hexId(1), true, ts(50));
    expect(pinned.ok).toBe(true);
    expect(store.getLane(WS, hexId(1))?.pinned).toBe(true);
    expect(store.getLane(WS, hexId(1))?.state).toBe('active');
    expect(refusalOf(store.setPinned(WS, hexId(8), true, ts(51)))).toBe('lane-not-found');
  });

  it('counts preparing, active and paused lanes as live, per workspace', () => {
    const { store } = openStore();
    LANE_STATES.forEach((state: LaneState, index) => {
      store.insertLane(laneRecord(index + 1, { state }));
    });
    store.insertLane(laneRecord(50, { state: 'active', workspaceId: OTHER_WS }));
    expect(store.countLiveLanes(WS)).toBe(3);
    expect(store.countLiveLanes(OTHER_WS)).toBe(1);
  });
});

describe('FR-R6-F10 lane store: keyset pages', () => {
  it('pages at most limit lanes, oldest first, and the cursor round-trips', () => {
    const { store } = openStore();
    for (let n = 1; n <= 5; n += 1) store.insertLane(laneRecord(n));
    store.insertLane(laneRecord(6, { workspaceId: OTHER_WS }));

    const first = store.listLanes(WS, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items.map((lane) => lane.laneId)).toEqual([hexId(1), hexId(2)]);
    expect(first.value.nextCursor).not.toBeNull();

    const second = store.listLanes(WS, { limit: 2, cursor: first.value.nextCursor ?? undefined });
    expect(second.ok && second.value.items.map((lane) => lane.laneId)).toEqual([hexId(3), hexId(4)]);

    const third = store.listLanes(WS, {
      limit: 2,
      cursor: (second.ok ? second.value.nextCursor : null) ?? undefined
    });
    expect(third.ok && third.value.items.map((lane) => lane.laneId)).toEqual([hexId(5)]);
    expect(third.ok && third.value.nextCursor).toBeNull();
  });

  it('breaks a created-at tie by lane id', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(2, { createdAt: ts(9) }));
    store.insertLane(laneRecord(1, { createdAt: ts(9) }));
    const first = store.listLanes(WS, { limit: 1 });
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(first.ok && first.value.items.map((lane) => lane.laneId)).toEqual([hexId(1)]);
    const second = store.listLanes(WS, { limit: 1, cursor: cursor ?? undefined });
    expect(second.ok && second.value.items.map((lane) => lane.laneId)).toEqual([hexId(2)]);
  });

  it('filters by state', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(1, { state: 'active' }));
    store.insertLane(laneRecord(2, { state: 'removed' }));
    store.insertLane(laneRecord(3, { state: 'paused' }));
    const page = store.listLanes(WS, { limit: 10, states: ['active', 'paused'] });
    expect(page.ok && page.value.items.map((lane) => lane.laneId)).toEqual([hexId(1), hexId(3)]);
  });

  it('encodes a cursor as base64url and refuses a malformed one', () => {
    const cursor = encodeLaneCursor(ts(1), hexId(1));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLaneCursor(cursor)).toEqual({ createdAt: ts(1), id: hexId(1) });
    expect(decodeLaneCursor('')).toBeNull();
    expect(decodeLaneCursor('not base64url!')).toBeNull();
    expect(decodeLaneCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
    expect(decodeLaneCursor(Buffer.from(`${ts(1)}|XYZ`).toString('base64url'))).toBeNull();
    expect(decodeLaneCursor('A'.repeat(257))).toBeNull();

    const { store } = openStore();
    expect(refusalOf(store.listLanes(WS, { limit: 2, cursor: 'garbage!' }))).toBe('invalid-input');
  });

  it('throws on a limit outside 1..200, which the port has already refused', () => {
    const { store } = openStore();
    expect(() => store.listLanes(WS, { limit: 0 })).toThrow(RangeError);
    expect(() => store.listLanes(WS, { limit: 201 })).toThrow(RangeError);
  });
});

describe('FR-R6-F10 lane store: operations', () => {
  it('records pending, then one final status', () => {
    const { store } = openStore();
    store.beginOperation({
      operationId: hexId(100),
      laneId: hexId(1),
      workspaceId: WS,
      kind: 'provision',
      generation: 1,
      now: ts(1)
    });
    expect(store.getOperation(hexId(100))).toEqual({
      operationId: hexId(100),
      laneId: hexId(1),
      workspaceId: WS,
      kind: 'provision',
      status: 'pending',
      reason: null,
      ownerGeneration: 1,
      startedAt: ts(1),
      endedAt: null
    });
    expect(store.listPendingOperations(WS).map((op) => op.operationId)).toEqual([hexId(100)]);

    expect(store.endOperation(hexId(100), 'failed', 'provisioning-git-failed', ts(2))).toBe(true);
    const ended = store.getOperation(hexId(100));
    expect(ended?.status).toBe('failed');
    expect(ended?.reason).toBe('provisioning-git-failed');
    expect(ended?.endedAt).toBe(ts(2));
    expect(store.listPendingOperations(WS)).toEqual([]);

    expect(store.endOperation(hexId(100), 'succeeded', null, ts(3))).toBe(false);
    expect(store.getOperation(hexId(100))?.status).toBe('failed');
  });

  it('lists a lane operations oldest first', () => {
    const { store } = openStore();
    store.beginOperation({ operationId: hexId(2), laneId: hexId(1), workspaceId: WS, kind: 'cleanup', generation: 1, now: ts(5) });
    store.beginOperation({ operationId: hexId(1), laneId: hexId(1), workspaceId: WS, kind: 'provision', generation: 1, now: ts(1) });
    expect(store.listOperations(hexId(1)).map((op) => op.kind)).toEqual(['provision', 'cleanup']);
  });
});

describe('FR-R6-F10 lane store: candidates', () => {
  it('numbers candidates per lane, and the current one is the highest', () => {
    const { store } = openStore();
    store.insertLane(laneRecord(1, { state: 'active' }));
    expect(store.currentCandidate(hexId(1))).toBeNull();
    const first = store.insertCandidate({
      candidateId: hexId(200),
      laneId: hexId(1),
      commit: COMMIT,
      tree: TREE,
      parent: COMMIT,
      generation: 1,
      now: ts(10)
    });
    expect(first.seq).toBe(1);
    const second = store.insertCandidate({
      candidateId: hexId(201),
      laneId: hexId(1),
      commit: 'e'.repeat(40),
      tree: TREE,
      parent: COMMIT,
      generation: 1,
      now: ts(11)
    });
    expect(second.seq).toBe(2);
    expect(store.currentCandidate(hexId(1))).toEqual(second);
    expect(store.getCandidate(hexId(200))).toEqual(first);
    expect(store.currentCandidate(hexId(2))).toBeNull();
    expect(second).toEqual({
      candidateId: hexId(201),
      laneId: hexId(1),
      seq: 2,
      commit: 'e'.repeat(40),
      tree: TREE,
      parent: COMMIT,
      ownerGeneration: 1,
      createdAt: ts(11)
    });
  });
});
