// FR-R6-F10 T044 — the lane engine's acceptance scenarios (quickstart §2), end to end through
// `LaneService` over a real fixture repository and a file-backed store.
//
// WHAT THIS PINS:
//   - AC-01: provisioning refuses each unsupported condition by name, and writes nothing: no lane
//     record, no worktree, no lane ref;
//   - AC-02 and NFR-004: two lanes edit the same file differently; the operator's checkout keeps
//     the same bytes and the same `git status --porcelain`;
//   - AC-03: an untracked `.env` and an ignored `node_modules/` never reach a lane, and the lane's
//     records outlive its cleanup;
//   - AC-04: freeze, request, verify, approve and land move the checked-out target to the
//     candidate, files included;
//   - AC-05: a landing interrupted by a host stop is classified after the store is closed and
//     reopened, and never replayed;
//   - AC-07: pages are bounded, and canceling one request touches no other;
//   - AC-08: every record survives closing and reopening the store;
//   - SC-006: the fixture's absolute paths, a seeded environment value and a check's output marker
//     appear in no stored row (every table, dumped whole), no result and no view.
//
// AC-06 is deferred except `nested-repository-unsupported`, which AC-01 covers.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROVISIONING_REFUSAL_REASONS,
  type IntegrationRequestView,
  type LaneResult,
  type LaneView,
  type ProvisioningRefusalReason,
  type VerificationProfile
} from '../../src/contracts/execution-lanes';
import * as lanesApi from '../../src/headless/execution-lanes-api';
import { createExecFileGitRunner, type LaneGitRunner } from '../../src/services/execution-lanes/git-runner';
import { LaneService, type LaneServiceDeps } from '../../src/services/execution-lanes/lane-service';
import { laneRootRef } from '../../src/services/execution-lanes/lane-store-rows';
import { createSpawnCheck } from '../../src/services/execution-lanes/verification-runner';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { createFixtureRepo, type FixtureRepo } from '../unit/execution-lanes/fixture-repo';

const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const WS = 'workspace-acceptance';
const ROOT_EXECUTION = 'root-exec-acceptance';
const RELEASE = 'release';
const FILE_A = path.join('src', 'a.txt');
const FILE_B = path.join('src', 'b.txt');
const SENTINEL_NAME = 'F10_SECRET_SENTINEL';
/** Unique per run, so a hit can only come from this run's environment. */
const SENTINEL = `sentinel-${randomBytes(12).toString('hex')}`;
/** Built at check time from parts, so the stored profile never holds the joined marker. */
const MARKER_PARTS = ['F10', 'CHECK', 'OUTPUT', 'MARKER'];
const MARKER = MARKER_PARTS.join('_');
const CHECK_TIMEOUT_MS = 30_000;
const SLOW_TEST_MS = 120_000;
const HOST_STOPPED = 'host stopped';
/** Reopening claims the next generation here, so this one table is expected to change. */
const OWNERSHIP_TABLE = 'lane_host_generations';

type GitWrapper = (real: LaneGitRunner) => LaneGitRunner;

interface HostOptions {
  readonly label: string;
  /** Files written before the seed commit. */
  readonly seed?: (fixture: FixtureRepo) => void;
  readonly liveLaneCap?: number;
  readonly wrapGit?: GitWrapper;
  readonly workspaceRoot?: (fixture: FixtureRepo) => string;
  readonly storageDir?: (fixture: FixtureRepo) => string;
}

interface Host {
  readonly fixture: FixtureRepo;
  /** The fixture's temporary container; every path the test made is under it. */
  readonly container: string;
  readonly storageDir: string;
  readonly service: LaneService;
  readonly connection: NodeSqliteConnection;
  /** Every result this host returned, for the SC-006 scan. */
  readonly observed: unknown[];
  /** Closes the store and opens a new host on the same file: the next ownership generation. */
  restart(wrapGit?: GitWrapper): void;
}

const openedConnections: NodeSqliteConnection[] = [];
const openedFixtures: FixtureRepo[] = [];

afterEach(() => {
  for (const conn of openedConnections.splice(0, openedConnections.length)) if (!conn.isClosed()) conn.close();
  for (const fixture of openedFixtures.splice(0, openedFixtures.length)) fixture.dispose();
});

function openStore(databasePath: string): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  openedConnections.push(conn);
  return conn;
}

function openHost(options: HostOptions): Host {
  const fixture = createFixtureRepo(options.label);
  openedFixtures.push(fixture);
  fixture.write(FILE_A, 'alpha\n');
  fixture.write(FILE_B, 'bravo\n');
  options.seed?.(fixture);
  fixture.commit('seed');

  const container = path.dirname(fixture.root);
  const storageDir = options.storageDir?.(fixture) ?? fixture.sibling('storage');
  const databasePath = path.join(fixture.sibling('db'), 'lanes.sqlite');
  const emptyConfig = path.join(fixture.sibling('config'), 'gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [SENTINEL_NAME]: SENTINEL,
    GIT_CEILING_DIRECTORIES: container,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1'
  };
  const real = createExecFileGitRunner({ baseEnv: gitEnv });
  const spawnCheck = createSpawnCheck({ baseEnv: { ...process.env, [SENTINEL_NAME]: SENTINEL } });
  const depsFor = (connection: NodeSqliteConnection, wrap: GitWrapper | undefined): LaneServiceDeps => ({
    connection,
    workspaceRoot: options.workspaceRoot?.(fixture) ?? fixture.root,
    storageDir,
    workspaceId: WS,
    liveLaneCap: options.liveLaneCap ?? 4,
    git: wrap === undefined ? real : wrap(real),
    clock: () => NOW_MS,
    random: (size) => randomBytes(size),
    spawnCheck
  });

  let connection = openStore(databasePath);
  let service = LaneService.open(depsFor(connection, options.wrapGit));
  return {
    fixture,
    container,
    storageDir,
    observed: [],
    get service() {
      return service;
    },
    get connection() {
      return connection;
    },
    restart(wrapGit) {
      connection.close();
      connection = openStore(databasePath);
      service = LaneService.open(depsFor(connection, wrapGit));
    }
  };
}

/** Records the result for the SC-006 scan, then returns its value or throws on a refusal. */
function kept<T>(host: Host, result: LaneResult<T>): T {
  host.observed.push(result);
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`);
  return result.value;
}

async function provision(host: Host): Promise<LaneView> {
  return kept(host, await host.service.provisionLane({ rootExecutionId: ROOT_EXECUTION, sourceRevision: 'HEAD', dependencyRecipe: 'none' }));
}

async function laneRoot(host: Host, lane: LaneView): Promise<string> {
  const root = await host.service.resolveLaneRoot(laneRootRef(WS, lane.laneId));
  if (root === null) throw new Error('lane root unresolved');
  return root;
}

async function editAndFreeze(host: Host, lane: LaneView, text: string): Promise<string> {
  fs.writeFileSync(path.join(await laneRoot(host, lane), FILE_A), text);
  return kept(host, await host.service.freezeCandidate({ laneId: lane.laneId })).commit;
}

/** One check per stream: each output is deterministic, so its digest is predictable. */
const SENTINEL_PROFILE: VerificationProfile = {
  profileId: 'acceptance',
  revision: 2,
  checks: [
    {
      name: 'stdout-marker',
      argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(MARKER_PARTS)}.join('_') + ':' + (process.env.${SENTINEL_NAME} ?? ''))`],
      timeoutMs: CHECK_TIMEOUT_MS
    },
    {
      name: 'stderr-marker',
      argv: [process.execPath, '-e', `process.stderr.write(${JSON.stringify(MARKER_PARTS)}.join('_') + '!' + (process.env.${SENTINEL_NAME} ?? ''))`],
      timeoutMs: CHECK_TIMEOUT_MS
    }
  ]
};

async function verifiedRequest(host: Host, lane: LaneView, targetBranch = 'main'): Promise<IntegrationRequestView> {
  const queued = kept(host, await host.service.requestIntegration({ laneId: lane.laneId, targetBranch, profile: SENTINEL_PROFILE }));
  return kept(host, await host.service.verifyRequest({ requestId: queued.requestId }));
}

function approve(host: Host, request: IntegrationRequestView): void {
  kept(
    host,
    host.service.approveRequest({
      requestId: request.requestId,
      candidateCommit: request.candidateCommit,
      targetCommit: request.expectedTargetCommit,
      profileRevision: request.profile.revision,
      profileDigest: request.profile.digest
    })
  );
}

/** Every file under the checkout except `.git`, as relative path and base64 bytes, sorted. */
function checkoutFiles(root: string): string[][] {
  const files: string[][] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push([path.relative(root, absolute), fs.readFileSync(absolute).toString('base64')]);
    }
  };
  walk(root);
  return files.sort((a, b) => (a.join('\0') < b.join('\0') ? -1 : 1));
}

function checkoutSnapshot(fixture: FixtureRepo): { readonly files: string[][]; readonly status: string } {
  return { files: checkoutFiles(fixture.root), status: fixture.git(['status', '--porcelain']) };
}

function laneRefs(fixture: FixtureRepo): string {
  return fixture.git(['for-each-ref', '--format=%(refname)', 'refs/schegent/']);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every table of the store, every row, every column. */
function dumpTables(conn: NodeSqliteConnection): Record<string, unknown[]> {
  const names = conn.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, conn.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

/** The needles found in `value`'s JSON text. */
function leaks(value: unknown, needles: readonly string[]): string[] {
  const text = JSON.stringify(value);
  return needles.filter((needle) => text.includes(needle));
}

describe('FR-R6-F10 AC-01: provisioning refuses each unsupported condition by name', () => {
  interface RefusalCase {
    readonly reason: ProvisioningRefusalReason;
    readonly options?: Partial<HostOptions>;
    readonly sourceRevision?: string;
    readonly dependencyRecipe?: string;
    /** Lanes provisioned first, which the refusal must leave alone. */
    readonly before?: number;
  }

  const oldGit: GitWrapper = (real) => ({
    run: (args, opts) => (args.at(0) === '--version' ? Promise.resolve({ ok: true, stdout: 'git version 2.16.6\n' }) : real.run(args, opts))
  });

  const cases: readonly RefusalCase[] = [
    { reason: 'git-version-unsupported', options: { wrapGit: oldGit } },
    {
      reason: 'nested-repository-unsupported',
      options: { seed: (fixture) => fixture.write(path.join('sub', 'file.txt'), 'nested\n'), workspaceRoot: (fixture) => path.join(fixture.root, 'sub') }
    },
    { reason: 'lane-root-inside-workspace', options: { storageDir: (fixture) => path.join(fixture.root, '.schegent') } },
    { reason: 'dependency-recipe-unsupported', dependencyRecipe: 'npm-ci' },
    { reason: 'source-revision-unresolved', sourceRevision: 'no-such-branch' },
    { reason: 'submodules-unsupported' },
    {
      reason: 'lfs-unsupported',
      options: { seed: (fixture) => fixture.write('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n') }
    },
    { reason: 'lane-bound-reached', options: { liveLaneCap: 1 }, before: 1 }
  ];

  it('lists one case per declared refusal', () => {
    expect(cases.map((c) => c.reason).sort()).toEqual([...PROVISIONING_REFUSAL_REASONS].sort());
  });

  for (const c of cases) {
    it(
      `refuses ${c.reason} and writes nothing`,
      async () => {
        const host = openHost({ label: `ac01-${c.reason}`, ...c.options });
        if (c.reason === 'submodules-unsupported') host.fixture.addGitlink('vendor/lib', host.fixture.head());
        for (let n = 0; n < (c.before ?? 0); n++) await provision(host);
        const lanesBefore = kept(host, host.service.listLanes({}));
        const worktreesBefore = host.fixture.git(['worktree', 'list', '--porcelain']);
        const refsBefore = laneRefs(host.fixture);

        const result = await host.service.provisionLane({
          rootExecutionId: ROOT_EXECUTION,
          sourceRevision: c.sourceRevision ?? 'HEAD',
          dependencyRecipe: c.dependencyRecipe ?? 'none'
        });

        expect(result).toEqual({ ok: false, refusal: { reason: c.reason } });
        expect(kept(host, host.service.listLanes({}))).toEqual(lanesBefore);
        expect(host.fixture.git(['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
        expect(laneRefs(host.fixture)).toBe(refsBefore);
      },
      SLOW_TEST_MS
    );
  }
});

describe('FR-R6-F10 AC-02 and NFR-004: two lanes leave the checkout untouched', () => {
  it(
    'keeps the checkout bytes and status while two lanes edit the same file differently',
    async () => {
      const host = openHost({ label: 'ac02' });
      const before = checkoutSnapshot(host.fixture);

      const first = await provision(host);
      const second = await provision(host);
      await editAndFreeze(host, first, 'alpha from the first lane\n');
      fs.writeFileSync(path.join(await laneRoot(host, second), FILE_A), 'alpha from the second lane\n');

      expect(fs.readFileSync(path.join(await laneRoot(host, first), FILE_A), 'utf8')).toBe('alpha from the first lane\n');
      expect(fs.readFileSync(path.join(await laneRoot(host, second), FILE_A), 'utf8')).toBe('alpha from the second lane\n');
      expect(checkoutSnapshot(host.fixture)).toEqual(before);
      expect(fs.readFileSync(path.join(host.fixture.root, FILE_A), 'utf8')).toBe('alpha\n');
    },
    SLOW_TEST_MS
  );
});

describe('FR-R6-F10 AC-03: uncommitted state never reaches a lane', () => {
  it(
    'leaves out an untracked .env and an ignored node_modules, and keeps the records after cleanup',
    async () => {
      const host = openHost({ label: 'ac03', seed: (fixture) => fixture.write('.gitignore', 'node_modules/\n') });
      host.fixture.write('.env', `${SENTINEL_NAME}=${SENTINEL}\n`);
      host.fixture.write(path.join('node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

      const lane = await provision(host);
      const root = await laneRoot(host, lane);

      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(root, FILE_A))).toBe(true);

      kept(host, host.service.completeLane({ laneId: lane.laneId }));
      kept(host, host.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));
      const report = kept(host, await host.service.cleanupLanes({}));

      expect(report).toEqual({ removed: [lane.laneId], kept: [] });
      expect(fs.existsSync(root)).toBe(false);
      expect(kept(host, host.service.getLane({ laneId: lane.laneId }))).toMatchObject({ laneId: lane.laneId, state: 'removed' });
      expect(fs.readFileSync(path.join(host.fixture.root, '.env'), 'utf8')).toBe(`${SENTINEL_NAME}=${SENTINEL}\n`);
      expect(fs.existsSync(path.join(host.fixture.root, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    },
    SLOW_TEST_MS
  );
});

describe('FR-R6-F10 AC-04: the whole path lands the candidate', () => {
  it(
    'moves the checked-out target and its files to the candidate',
    async () => {
      const host = openHost({ label: 'ac04' });
      const lane = await provision(host);
      const candidate = await editAndFreeze(host, lane, 'alpha, landed\n');
      const request = await verifiedRequest(host, lane);
      expect(request.state).toBe('awaiting-review');
      approve(host, request);

      const landed = kept(host, await host.service.landRequest({ requestId: request.requestId }));

      expect(landed.state).toBe('landed');
      expect(host.fixture.head()).toBe(candidate);
      expect(host.fixture.git(['rev-parse', 'HEAD^{tree}'])).toBe(host.fixture.git(['rev-parse', `${candidate}^{tree}`]));
      expect(host.fixture.git(['diff', '--name-only', candidate])).toBe('');
      expect(host.fixture.git(['status', '--porcelain'])).toBe('');
      expect(fs.readFileSync(path.join(host.fixture.root, FILE_A), 'utf8')).toBe('alpha, landed\n');
    },
    SLOW_TEST_MS
  );
});

describe('FR-R6-F10 AC-05: an interrupted landing is classified after the store reopens', () => {
  interface LandingCase {
    readonly name: string;
    readonly target: string;
    /** `before`: the landing effect never runs. `after`: it runs, then the host stops. */
    readonly when: 'before' | 'after';
    /** Moves the target after the stop, before the store reopens. */
    readonly then: (fixture: FixtureRepo, expected: string) => void;
    readonly to: 'blocked' | 'landed' | 'uncertain';
    readonly reason: string | null;
    /** Whether the report lists the expected, candidate and observed commits. */
    readonly listsCommits: boolean;
  }

  const isLandingEffect = (args: readonly string[]): boolean =>
    args.includes('--ff-only') || (args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/'));

  const cases: readonly LandingCase[] = [
    { name: 'target still at T', target: 'main', when: 'before', then: () => undefined, to: 'blocked', reason: 'landing-not-applied', listsCommits: true },
    { name: 'target at C', target: RELEASE, when: 'after', then: () => undefined, to: 'landed', reason: null, listsCommits: false },
    {
      name: 'target past C',
      target: 'main',
      when: 'after',
      then: (fixture) => {
        fixture.write(path.join('src', 'c.txt'), 'charlie\n');
        fixture.commit('main moves past the candidate');
      },
      to: 'landed',
      reason: 'target-advanced-beyond',
      listsCommits: false
    },
    {
      name: 'target rewritten',
      target: RELEASE,
      when: 'before',
      then: (fixture, expected) => {
        const orphan = fixture.git(['commit-tree', `${expected}^{tree}`, '-m', 'rewritten']).trim();
        fixture.git(['update-ref', `refs/heads/${RELEASE}`, orphan]);
      },
      to: 'uncertain',
      reason: null,
      listsCommits: true
    }
  ];

  for (const c of cases) {
    it(
      `${c.name}: ${c.to}${c.reason === null ? '' : ` ${c.reason}`}, never replayed`,
      async () => {
        let armed = false;
        const crashing: GitWrapper = (real) => ({
          run: async (args, opts) => {
            if (!armed || !isLandingEffect(args)) return real.run(args, opts);
            armed = false;
            if (c.when === 'after') await real.run(args, opts);
            throw new Error(HOST_STOPPED);
          }
        });
        const host = openHost({ label: 'ac05', wrapGit: crashing });
        host.fixture.git(['branch', RELEASE]);
        const lane = await provision(host);
        const candidate = await editAndFreeze(host, lane, 'alpha, interrupted\n');
        const request = await verifiedRequest(host, lane, c.target);
        approve(host, request);
        armed = true;
        await expect(host.service.landRequest({ requestId: request.requestId })).rejects.toThrow(HOST_STOPPED);
        c.then(host.fixture, request.expectedTargetCommit);
        const observed = host.fixture.git(['rev-parse', `refs/heads/${c.target}`]).trim();

        const calls: string[][] = [];
        host.restart((real) => ({
          run: (args, opts) => {
            calls.push([...args]);
            return real.run(args, opts);
          }
        }));
        const report = kept(host, await host.service.reconcile());

        const commits = { expected: request.expectedTargetCommit, candidate, observed };
        expect(report.requests).toEqual([
          {
            requestId: request.requestId,
            from: 'landing',
            to: c.to,
            reason: c.reason,
            ...(c.listsCommits ? { commits } : {})
          }
        ]);
        expect(calls.filter((args) => isLandingEffect(args) || args.includes('merge'))).toEqual([]);
        expect(kept(host, host.service.getRequest({ requestId: request.requestId })).state).toBe(c.to);
      },
      SLOW_TEST_MS
    );
  }
});

describe('FR-R6-F10 AC-07: bounded pages and scoped cancellation', () => {
  it(
    'pages lanes and requests within the bound, refuses an oversized page, and cancels only the named request',
    async () => {
      const host = openHost({ label: 'ac07' });
      host.fixture.git(['branch', RELEASE]);
      const lanes = [await provision(host), await provision(host), await provision(host)];
      const requests: IntegrationRequestView[] = [];
      for (const lane of lanes) {
        await editAndFreeze(host, lane, `alpha from ${lane.laneId}\n`);
        requests.push(kept(host, await host.service.requestIntegration({ laneId: lane.laneId, targetBranch: RELEASE, profile: SENTINEL_PROFILE })));
      }

      const firstPage = kept(host, lanesApi.listLanes(host.service, { limit: 2 }));
      expect(firstPage.items.length).toBe(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = kept(host, lanesApi.listLanes(host.service, { limit: 2, cursor: firstPage.nextCursor ?? '' }));
      expect(secondPage.items.length).toBe(1);
      expect(secondPage.nextCursor).toBeNull();
      expect([...firstPage.items, ...secondPage.items].map((lane) => lane.laneId).sort()).toEqual(lanes.map((lane) => lane.laneId).sort());
      expect(lanesApi.listLanes(host.service, { limit: 201 })).toEqual({ ok: false, refusal: { reason: 'invalid-input' } });
      expect(lanesApi.listRequests(host.service, { limit: 0 })).toEqual({ ok: false, refusal: { reason: 'invalid-input' } });

      const target = requests.at(1);
      if (target === undefined) throw new Error('second request missing');
      expect(kept(host, lanesApi.cancelRequest(host.service, { requestId: target.requestId })).state).toBe('canceled');

      const states = kept(host, lanesApi.listRequests(host.service, { limit: 200 })).items.map((request) => [request.requestId, request.state]);
      expect(states.sort()).toEqual(requests.map((request) => [request.requestId, request.requestId === target.requestId ? 'canceled' : 'queued']).sort());
      const scoped = kept(host, lanesApi.listRequests(host.service, { laneId: target.laneId }));
      expect(scoped.items.map((request) => request.requestId)).toEqual([target.requestId]);
      const canceled = kept(host, lanesApi.listRequests(host.service, { states: ['canceled'] }));
      expect(canceled.items.map((request) => request.requestId)).toEqual([target.requestId]);
      expect(lanesApi.cancelRequest(host.service, { requestId: target.requestId })).toEqual({ ok: false, refusal: { reason: 'request-state-invalid' } });
    },
    SLOW_TEST_MS
  );
});

describe('FR-R6-F10 AC-08: every record survives closing and reopening the store', () => {
  it(
    'returns the same lanes, requests, verification results and rows after a reopen',
    async () => {
      const host = openHost({ label: 'ac08' });
      host.fixture.git(['branch', RELEASE]);
      const landedLane = await provision(host);
      await editAndFreeze(host, landedLane, 'alpha, before the reopen\n');
      const verified = await verifiedRequest(host, landedLane);
      approve(host, verified);
      kept(host, await host.service.landRequest({ requestId: verified.requestId }));
      const openLane = await provision(host);
      await editAndFreeze(host, openLane, 'alpha, still open\n');
      const queued = kept(host, await host.service.requestIntegration({ laneId: openLane.laneId, targetBranch: RELEASE, profile: SENTINEL_PROFILE }));
      kept(host, host.service.cancelRequest({ requestId: queued.requestId }));
      kept(host, host.service.setLanePinned({ laneId: openLane.laneId, pinned: true }));

      const read = () => {
        const rows = Object.entries(dumpTables(host.connection)).filter(([name]) => name !== OWNERSHIP_TABLE);
        return {
          lanes: kept(host, host.service.listLanes({ limit: 200 })),
          requests: kept(host, host.service.listRequests({ limit: 200 })),
          verification: kept(host, host.service.getVerification({ requestId: verified.requestId })),
          rows
        };
      };
      const before = read();
      expect(before.lanes.items.length).toBe(2);
      expect(before.requests.items.length).toBe(2);
      expect(before.verification.length).toBe(SENTINEL_PROFILE.checks.length);
      const generation = host.service.generation;

      host.restart();

      expect(host.service.generation).toBeGreaterThan(generation);
      expect(read()).toEqual(before);
    },
    SLOW_TEST_MS
  );
});

describe('FR-R6-F10 SC-006: no path, environment value or check output is retained', () => {
  it('the scan finds a planted needle', () => {
    expect(leaks([{ nested: { note: `at ${SENTINEL} and ${MARKER}` } }], [SENTINEL, MARKER, 'absent'])).toEqual([SENTINEL, MARKER]);
  });

  it(
    'keeps none of them in any row, result or view across the whole lifecycle',
    async () => {
      const host = openHost({ label: 'sc006' });
      host.fixture.git(['branch', RELEASE]);
      const lane = await provision(host);
      await editAndFreeze(host, lane, 'alpha, scanned\n');
      const request = await verifiedRequest(host, lane);
      const checks = kept(host, host.service.getVerification({ requestId: request.requestId }));
      approve(host, request);
      kept(host, await host.service.landRequest({ requestId: request.requestId }));
      kept(host, host.service.getRequest({ requestId: request.requestId }));
      kept(host, host.service.getLane({ laneId: lane.laneId }));

      const other = await provision(host);
      await editAndFreeze(host, other, 'alpha, abandoned\n');
      const abandoned = kept(host, await host.service.requestIntegration({ laneId: other.laneId, targetBranch: RELEASE, profile: SENTINEL_PROFILE }));
      kept(host, host.service.cancelRequest({ requestId: abandoned.requestId }));
      host.observed.push(await host.service.provisionLane({ rootExecutionId: ROOT_EXECUTION, sourceRevision: 'no-such-branch', dependencyRecipe: 'none' }));
      for (const done of [lane, other]) {
        kept(host, host.service.completeLane({ laneId: done.laneId }));
        kept(host, host.service.releaseLane({ laneId: done.laneId, disposition: 'eligible' }));
      }
      kept(host, await host.service.cleanupLanes({}));
      kept(host, host.service.listLanes({ limit: 200 }));
      kept(host, host.service.listRequests({ limit: 200 }));
      host.restart();
      kept(host, await host.service.reconcile());

      // The checks saw the seeded value and produced the marker: the digests prove both.
      expect(checks.map((check) => [check.name, check.passed, check.outputSha256, check.outputBytes])).toEqual([
        ['stdout-marker', true, sha256(`${MARKER}:${SENTINEL}`), Buffer.byteLength(`${MARKER}:${SENTINEL}`)],
        ['stderr-marker', true, sha256(`${MARKER}!${SENTINEL}`), Buffer.byteLength(`${MARKER}!${SENTINEL}`)]
      ]);

      const rows = dumpTables(host.connection);
      expect(rows.execution_lanes.length).toBe(2);
      expect(rows.lane_verification_results.length).toBe(SENTINEL_PROFILE.checks.length);

      const needles = [
        ...new Set([
          host.container,
          fs.realpathSync(host.container),
          path.join(os.tmpdir(), path.basename(host.container)),
          host.storageDir,
          host.fixture.root,
          SENTINEL,
          MARKER
        ])
      ];
      // Controls: the same scan finds an id each source must hold.
      expect(leaks(rows, [lane.laneId])).toEqual([lane.laneId]);
      expect(leaks(host.observed, [other.laneId])).toEqual([other.laneId]);
      expect(leaks(rows, needles)).toEqual([]);
      expect(leaks(host.observed, needles)).toEqual([]);
      expect(host.observed.length).toBeGreaterThan(15);
    },
    SLOW_TEST_MS
  );
});
