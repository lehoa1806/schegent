// FR-R6-F10 T040 (NFR-003, SC-005) — listing stays bounded at 1,000 lanes and 1,000 requests.
//
// WHAT THIS PINS:
//   - 1,000 lanes and 1,000 requests page out in pages of at most 200;
//   - the pages concatenate to every record exactly once (no repeat, no gap);
//   - each page's p95 latency, over 50 timed listings after 5 warm-ups, is under 500 ms
//     (nearest-rank, the same calculator FR-R6-F03 uses).

import { afterEach, describe, expect, it } from 'vitest';
import { LANE_PAGE_LIMIT_MAX, type LanePage, type LaneResult } from '../../../src/contracts/execution-lanes';
import { IntegrationStore, type RequestRecord } from '../../../src/services/execution-lanes/integration-store';
import { LaneStore } from '../../../src/services/execution-lanes/lane-store';
import { type LaneRecord, laneBaseRef, laneCandidateRef, laneRootRef } from '../../../src/services/execution-lanes/lane-store-rows';
import { computeDistribution } from '../../../src/services/runtime-resource-budgets/distribution';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW_MS = 1_800_000_000_000;
const WS = 'workspace-a';
const REPO_ID = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const TARGET = 'd'.repeat(40);
const DIGEST = 'e'.repeat(64);
const PROFILE_JSON = JSON.stringify({ profileId: 'default', revision: 1, checks: [] });
const RECORD_COUNT = 1_000;
const REQUEST_ID_OFFSET = 100_000;
const WARM_UPS = 5;
const TIMED_RUNS = 50;
const P95_BUDGET_MS = 500;
const EXPECTED_PAGES = Math.ceil(RECORD_COUNT / LANE_PAGE_LIMIT_MAX);
const PERF_TIMEOUT_MS = 120_000;

const connections: NodeSqliteConnection[] = [];

afterEach(() => {
  for (const conn of connections.splice(0, connections.length)) conn.close();
});

function openStores(): { lanes: LaneStore; integrations: IntegrationStore } {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  connections.push(conn);
  return { lanes: new LaneStore(conn), integrations: new IntegrationStore(conn) };
}

function hexId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function ts(n: number): string {
  return new Date(NOW_MS + n * 1_000).toISOString();
}

function laneRecord(n: number): LaneRecord {
  const laneId = hexId(n);
  return {
    laneId,
    workspaceId: WS,
    repositoryId: REPO_ID,
    rootExecutionId: `exec-${n}`,
    sourceCommit: COMMIT,
    baseRef: laneBaseRef(laneId),
    candidateRef: laneCandidateRef(laneId),
    rootRef: laneRootRef(WS, laneId),
    dependencyRecipe: 'none',
    state: 'active',
    stateReason: null,
    pinned: false,
    ownerGeneration: 1,
    createdAt: ts(n),
    updatedAt: ts(n)
  };
}

function requestRecord(n: number): RequestRecord {
  return {
    requestId: hexId(REQUEST_ID_OFFSET + n),
    laneId: hexId(n),
    workspaceId: WS,
    repositoryId: REPO_ID,
    candidateId: hexId(2 * REQUEST_ID_OFFSET + n),
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
    updatedAt: ts(n)
  };
}

type PageFetch<T> = (cursor: string | undefined) => LaneResult<LanePage<T>>;

interface Walk<T> {
  readonly pages: readonly (readonly T[])[];
  readonly millis: readonly number[];
}

/** Lists every page once, timing each page separately. */
function walk<T>(fetch: PageFetch<T>): Walk<T> {
  const pages: T[][] = [];
  const millis: number[] = [];
  let cursor: string | undefined;
  for (;;) {
    const started = performance.now();
    const result = fetch(cursor);
    millis.push(performance.now() - started);
    if (!result.ok) throw new Error(`listing refused: ${result.refusal.reason}`);
    pages.push([...result.value.items]);
    if (result.value.nextCursor === null) return { pages, millis };
    if (pages.length > EXPECTED_PAGES) throw new Error('listing did not end');
    cursor = result.value.nextCursor;
  }
}

/** Walks `WARM_UPS + TIMED_RUNS` times; returns the last walk's pages and each page's p95. */
function measure<T>(fetch: PageFetch<T>): { pages: readonly (readonly T[])[]; p95s: readonly number[] } {
  const perPage: number[][] = Array.from({ length: EXPECTED_PAGES }, () => []);
  let last: Walk<T> = { pages: [], millis: [] };
  for (let run = 0; run < WARM_UPS + TIMED_RUNS; run++) {
    last = walk(fetch);
    expect(last.millis.length).toBe(EXPECTED_PAGES);
    last.millis.forEach((ms, page) => perPage.at(page)?.push(ms));
  }
  const p95s = perPage.map(
    (values, page) => computeDistribution({ metric: `page-${page}`, runId: 'lane-store-perf', values, warmUpCount: WARM_UPS, unit: 'ms' }).p95
  );
  return { pages: last.pages, p95s };
}

function expectCompletePaging(pages: readonly (readonly string[])[], expected: readonly string[]): void {
  expect(pages.length).toBe(EXPECTED_PAGES);
  for (const page of pages) expect(page.length).toBeLessThanOrEqual(LANE_PAGE_LIMIT_MAX);
  const all = pages.flat();
  expect(all.length).toBe(RECORD_COUNT);
  expect(new Set(all).size).toBe(RECORD_COUNT);
  expect([...all].sort()).toEqual([...expected].sort());
}

describe('FR-R6-F10 lane and request listing at 1,000 records (NFR-003, SC-005)', () => {
  it(
    'pages 1,000 lanes in pages of at most 200, with every page under the p95 budget',
    () => {
      const { lanes } = openStores();
      const ids = Array.from({ length: RECORD_COUNT }, (_, i) => laneRecord(i + 1));
      for (const lane of ids) lanes.insertLane(lane);

      const { pages, p95s } = measure((cursor) =>
        lanes.listLanes(WS, { limit: LANE_PAGE_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) })
      );

      expectCompletePaging(
        pages.map((page) => page.map((lane) => lane.laneId)),
        ids.map((lane) => lane.laneId)
      );
      expect(p95s.length).toBe(EXPECTED_PAGES);
      for (const p95 of p95s) expect(p95).toBeLessThan(P95_BUDGET_MS);
    },
    PERF_TIMEOUT_MS
  );

  it(
    'pages 1,000 requests in pages of at most 200, with every page under the p95 budget',
    () => {
      const { integrations } = openStores();
      const records = Array.from({ length: RECORD_COUNT }, (_, i) => requestRecord(i + 1));
      for (const record of records) integrations.insertRequest(record);

      const { pages, p95s } = measure((cursor) =>
        integrations.listRequests(WS, { limit: LANE_PAGE_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) })
      );

      expectCompletePaging(
        pages.map((page) => page.map((request) => request.requestId)),
        records.map((request) => request.requestId)
      );
      expect(p95s.length).toBe(EXPECTED_PAGES);
      for (const p95 of p95s) expect(p95).toBeLessThan(P95_BUDGET_MS);
    },
    PERF_TIMEOUT_MS
  );
});
