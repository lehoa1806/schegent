// FR-R6-F10 T016 — provisioning a lane, happy path.
//
// WHAT THIS PINS:
//   - a provisioned lane is `active`, its HEAD is the source commit, detached, and its base ref
//     exists (research R2);
//   - the record names the workspace, repository, root execution, source commit, both refs and
//     the generation (US1-2); its root reference is relative (research R1); the provision
//     operation row is `succeeded`;
//   - two lanes from one revision edit the same file independently, and the checkout's bytes and
//     status are unchanged (US1-1, SC-001, NFR-004);
//   - an untracked `.env` and an ignored `node_modules/x` in the checkout are absent from the lane
//     (US1-3, FR-006).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANE_DISCLOSURE, type LaneView } from '../../../src/contracts/execution-lanes';
import {
  createExecFileGitRunner,
  type GitRunOptions,
  type GitRunResult,
  type LaneGitRunner
} from '../../../src/services/execution-lanes/git-runner';
import { LaneService, type LaneServiceDeps } from '../../../src/services/execution-lanes/lane-service';
import { LaneStore } from '../../../src/services/execution-lanes/lane-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { createFixtureRepo, type FixtureRepo } from './fixture-repo';

const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const WS = 'workspace-a';
const ROOT_EXECUTION = 'root-exec-1';

const fixtures: FixtureRepo[] = [];
const connections: NodeSqliteConnection[] = [];

afterEach(() => {
  for (const conn of connections.splice(0, connections.length)) conn.close();
  for (const fixture of fixtures.splice(0, fixtures.length)) fixture.dispose();
});

interface Harness {
  readonly fixture: FixtureRepo;
  readonly service: LaneService;
  readonly store: LaneStore;
  readonly storageDir: string;
}

type GitWrapper = (real: LaneGitRunner) => LaneGitRunner;

function harness(overrides: Partial<LaneServiceDeps> = {}, wrapGit: GitWrapper = (real) => real): Harness {
  const fixture = createFixtureRepo('provision');
  fixtures.push(fixture);
  fixture.write('src/a.txt', 'original\n');
  fixture.write('.gitignore', 'node_modules/\n');
  fixture.commit('add a.txt');
  fixture.write('.env', 'SECRET_PLACEHOLDER=1\n');
  fixture.write('node_modules/x', 'dependency\n');

  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  connections.push(conn);

  const storageDir = fixture.sibling('storage');
  const git = wrapGit(
    createExecFileGitRunner({
      baseEnv: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(fixture.root) }
    })
  );
  let counter = 0;
  const service = LaneService.open({
    connection: conn,
    workspaceRoot: fixture.root,
    storageDir,
    workspaceId: WS,
    liveLaneCap: 4,
    git,
    clock: () => NOW_MS,
    random: (size) => {
      counter += 1;
      return Buffer.alloc(size, counter);
    },
    ...overrides
  });
  return { fixture, service, store: new LaneStore(conn), storageDir };
}

async function provisioned(h: Harness): Promise<LaneView> {
  const result = await h.service.provisionLane({
    rootExecutionId: ROOT_EXECUTION,
    sourceRevision: 'HEAD',
    dependencyRecipe: 'none'
  });
  if (!result.ok) throw new Error(`provisioning refused: ${result.refusal.reason}`);
  return result.value;
}

async function laneRoot(h: Harness, laneId: string): Promise<string> {
  const record = h.store.getLane(WS, laneId);
  if (record === null) throw new Error('lane record missing');
  const root = await h.service.resolveLaneRoot(record.rootRef);
  if (root === null) throw new Error('lane root unresolved');
  return root;
}

describe('FR-R6-F10 lane provisioner: happy path', () => {
  it('provisions an active lane detached at the source commit, with a base ref', async () => {
    const h = harness();
    const source = h.fixture.head();
    const lane = await provisioned(h);
    const root = await laneRoot(h, lane.laneId);

    expect(lane.state).toBe('active');
    expect(h.fixture.git(['rev-parse', 'HEAD'], root).trim()).toBe(source);
    expect(h.fixture.git(['branch', '--show-current'], root).trim()).toBe('');
    expect(h.fixture.git(['rev-parse', `refs/schegent/lanes/${lane.laneId}/base`]).trim()).toBe(source);
  });

  it('records the lane and a succeeded provision operation', async () => {
    const h = harness();
    const source = h.fixture.head();
    const lane = await provisioned(h);
    const record = h.store.getLane(WS, lane.laneId);

    expect(lane).toMatchObject({
      workspaceId: WS,
      rootExecutionId: ROOT_EXECUTION,
      sourceCommit: source,
      baseRef: `refs/schegent/lanes/${lane.laneId}/base`,
      candidateRef: `refs/schegent/lanes/${lane.laneId}/candidate`,
      ownerGeneration: h.service.generation,
      currentCandidate: null,
      pinned: false,
      disclosure: LANE_DISCLOSURE
    });
    expect(lane.repositoryId).toMatch(/^[0-9a-f]{64}$/);
    expect(lane).not.toHaveProperty('rootRef');
    if (record === null) throw new Error('lane record missing');
    expect(record.rootRef).toBe(`lanes/${WS}/${lane.laneId}`);
    expect(path.isAbsolute(record.rootRef)).toBe(false);

    const operations = h.store.listOperations(lane.laneId);
    expect(operations.map((op) => [op.kind, op.status])).toEqual([['provision', 'succeeded']]);
  });

  it('isolates two lanes from each other and from the checkout', async () => {
    const h = harness();
    const checkoutBytes = fs.readFileSync(path.join(h.fixture.root, 'src/a.txt'));
    const checkoutStatus = h.fixture.git(['status', '--porcelain']);

    const first = await provisioned(h);
    const second = await provisioned(h);
    expect(first.laneId).not.toBe(second.laneId);
    const firstRoot = await laneRoot(h, first.laneId);
    const secondRoot = await laneRoot(h, second.laneId);

    fs.writeFileSync(path.join(firstRoot, 'src/a.txt'), 'first lane\n');
    fs.writeFileSync(path.join(secondRoot, 'src/a.txt'), 'second lane\n');

    expect(fs.readFileSync(path.join(firstRoot, 'src/a.txt'), 'utf8')).toBe('first lane\n');
    expect(fs.readFileSync(path.join(secondRoot, 'src/a.txt'), 'utf8')).toBe('second lane\n');
    expect(fs.readFileSync(path.join(h.fixture.root, 'src/a.txt')).equals(checkoutBytes)).toBe(true);
    expect(h.fixture.git(['status', '--porcelain'])).toBe(checkoutStatus);
  });

  it('carries no untracked or ignored file from the checkout', async () => {
    const h = harness();
    const lane = await provisioned(h);
    const root = await laneRoot(h, lane.laneId);

    expect(fs.existsSync(path.join(root, 'src/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
  });

  it('lists and reads back the provisioned lane', async () => {
    const h = harness();
    const lane = await provisioned(h);

    const read = h.service.getLane({ laneId: lane.laneId });
    expect(read).toEqual({ ok: true, value: lane });
    const page = h.service.listLanes({});
    expect(page.ok && page.value.items.map((item) => item.laneId)).toEqual([lane.laneId]);
    expect(h.service.getLane({ laneId: 'e'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'lane-not-found' }
    });
  });
});

const GIT_FAILED: GitRunResult = { ok: false, exitCode: 128, code: 'exit' };

/** Answers `failing` calls with `answer`; every other call reaches the real runner. */
function faulting(match: (args: readonly string[]) => boolean, answer: () => GitRunResult): GitWrapper {
  return (real) => ({
    run: (args: readonly string[], opts: GitRunOptions) => (match(args) ? Promise.resolve(answer()) : real.run(args, opts))
  });
}

const isWorktreeAdd = (args: readonly string[]): boolean => args.at(0) === 'worktree' && args.at(1) === 'add';
const isBaseRefCreate = (args: readonly string[]): boolean => args.at(0) === 'update-ref';
const isHeadReadBack = (args: readonly string[]): boolean => args.join(' ') === 'rev-parse HEAD';

async function refusalOf(h: Harness): Promise<string> {
  const result = await h.service.provisionLane({
    rootExecutionId: ROOT_EXECUTION,
    sourceRevision: 'HEAD',
    dependencyRecipe: 'none'
  });
  return result.ok ? `ok:${result.value.state}` : result.refusal.reason;
}

function onlyLane(h: Harness): LaneView {
  const page = h.service.listLanes({});
  if (!page.ok) throw new Error('list refused');
  expect(page.value.items).toHaveLength(1);
  const lane = page.value.items.at(0);
  if (lane === undefined) throw new Error('no lane listed');
  return lane;
}

describe('FR-R6-F10 lane provisioner: failure paths', () => {
  it('refuses lane-bound-reached at the cap and inserts no row', async () => {
    const h = harness({ liveLaneCap: 1 });
    await provisioned(h);
    expect(await refusalOf(h)).toBe('lane-bound-reached');
    onlyLane(h);
  });

  it('refuses a probe failure before any row or worktree exists', async () => {
    const h = harness();
    const worktreesBefore = h.fixture.git(['worktree', 'list', '--porcelain']);
    const result = await h.service.provisionLane({
      rootExecutionId: ROOT_EXECUTION,
      sourceRevision: 'HEAD',
      dependencyRecipe: 'npm-ci'
    });
    expect(result).toEqual({ ok: false, refusal: { reason: 'dependency-recipe-unsupported' } });
    const page = h.service.listLanes({});
    expect(page.ok && page.value.items).toEqual([]);
    expect(h.fixture.git(['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
    expect(fs.existsSync(path.join(h.storageDir, 'lanes'))).toBe(false);
  });

  it.each([
    ['worktree add', isWorktreeAdd],
    ['update-ref', isBaseRefCreate],
    ['the HEAD read-back', isHeadReadBack]
  ])('keeps the lane preparation-failed when %s fails', async (_label, match) => {
    const h = harness({}, faulting(match, () => GIT_FAILED));
    expect(await refusalOf(h)).toBe('provisioning-git-failed');

    const lane = onlyLane(h);
    expect(lane.state).toBe('preparation-failed');
    expect(lane.stateReason).toBe('provisioning-git-failed');
    const operations = h.store.listOperations(lane.laneId);
    expect(operations.map((op) => [op.kind, op.status, op.reason])).toEqual([
      ['provision', 'failed', 'provisioning-git-failed']
    ]);
  });

  it('settles the lane preparation-failed when a step throws, then rethrows (review R12)', async () => {
    const thrown = new Error('unexpected step failure');
    const throwing: GitWrapper = (real) => ({
      run: (args: readonly string[], opts: GitRunOptions) => (isWorktreeAdd(args) ? Promise.reject(thrown) : real.run(args, opts))
    });
    const h = harness({}, throwing);
    await expect(refusalOf(h)).rejects.toBe(thrown);

    const lane = onlyLane(h);
    expect([lane.state, lane.stateReason]).toEqual(['preparation-failed', 'provisioning-git-failed']);
    const operations = h.store.listOperations(lane.laneId);
    expect(operations.map((op) => [op.kind, op.status, op.reason])).toEqual([
      ['provision', 'failed', 'provisioning-git-failed']
    ]);
  });

  it('refuses a HEAD read-back naming another commit', async () => {
    const h = harness({}, faulting(isHeadReadBack, () => ({ ok: true, stdout: `${'0'.repeat(40)}\n` })));
    expect(await refusalOf(h)).toBe('provisioning-git-failed');
    expect(onlyLane(h).state).toBe('preparation-failed');
  });

  it('keeps the residue of a failed provisioning on disk', async () => {
    const h = harness({}, faulting(isBaseRefCreate, () => GIT_FAILED));
    expect(await refusalOf(h)).toBe('provisioning-git-failed');
    const lane = onlyLane(h);
    expect(await h.service.resolveLaneRoot(`lanes/${WS}/${lane.laneId}`)).not.toBeNull();
  });

  it('refuses provisioning-deadline-exceeded when a Git call outlives the deadline', async () => {
    let nowMs = NOW_MS;
    const stall: GitWrapper = (real) => ({
      run: (args: readonly string[], opts: GitRunOptions) => {
        if (!isWorktreeAdd(args)) return real.run(args, opts);
        nowMs += opts.timeoutMs;
        return Promise.resolve({ ok: false, exitCode: null, code: 'timeout' });
      }
    });
    const h = harness({ provisioningDeadlineMs: 1_000, clock: () => nowMs }, stall);
    expect(await refusalOf(h)).toBe('provisioning-deadline-exceeded');
    const lane = onlyLane(h);
    expect(lane.state).toBe('preparation-failed');
    expect(lane.stateReason).toBe('provisioning-deadline-exceeded');
  });
});
