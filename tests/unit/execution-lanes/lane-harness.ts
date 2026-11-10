// FR-R6-F10 — a `LaneService` over a fresh fixture repository, shared by the lane tests from US3
// on.
//
// The Git runner reads no global or system config (`GIT_CONFIG_GLOBAL` names an empty file,
// `GIT_CONFIG_NOSYSTEM=1`), so a test that unsets the fixture's identity sees it missing on any
// machine. The `GIT_CONFIG_COUNT` entries the global setup adds still apply.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LaneView } from '../../../src/contracts/execution-lanes';
import { createExecFileGitRunner, type LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../../src/services/execution-lanes/integration-store';
import { LaneService, type LaneServiceDeps } from '../../../src/services/execution-lanes/lane-service';
import { LaneStore } from '../../../src/services/execution-lanes/lane-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { createFixtureRepo, type FixtureRepo } from './fixture-repo';

export const HARNESS_NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
export const HARNESS_WS = 'workspace-a';
export const HARNESS_ROOT_EXECUTION = 'root-exec-1';

export type GitWrapper = (real: LaneGitRunner) => LaneGitRunner;

export interface LaneHarnessOptions {
  readonly label?: string;
  readonly overrides?: Partial<LaneServiceDeps>;
  readonly wrapGit?: GitWrapper;
}

export interface LaneHarness {
  readonly fixture: FixtureRepo;
  readonly service: LaneService;
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly storageDir: string;
  /** The ceiling-and-isolated environment the service's Git runner uses. */
  readonly gitEnv: NodeJS.ProcessEnv;
  provision(): Promise<LaneView>;
  laneRoot(laneId: string): Promise<string>;
  /** A new host on the same store: it claims the next generation, so `service` is superseded. */
  reopen(options?: { readonly wrapGit?: GitWrapper; readonly overrides?: Partial<LaneServiceDeps> }): LaneService;
}

const opened: { connections: NodeSqliteConnection[]; fixtures: FixtureRepo[] } = { connections: [], fixtures: [] };

/** Call from `afterEach`. */
export function disposeLaneHarnesses(): void {
  for (const conn of opened.connections.splice(0, opened.connections.length)) conn.close();
  for (const fixture of opened.fixtures.splice(0, opened.fixtures.length)) fixture.dispose();
}

export function createLaneHarness(options: LaneHarnessOptions = {}): LaneHarness {
  const fixture = createFixtureRepo(options.label ?? 'lanes');
  opened.fixtures.push(fixture);
  fixture.write('src/a.txt', 'alpha\n');
  fixture.write('src/b.txt', 'bravo\n');
  fixture.commit('seed');

  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => HARNESS_NOW_MS);
  opened.connections.push(conn);

  const storageDir = fixture.sibling('storage');
  const emptyConfig = path.join(fixture.sibling('config'), 'gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(fixture.root),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1'
  };
  const real = createExecFileGitRunner({ baseEnv: gitEnv });
  const git = options.wrapGit === undefined ? real : options.wrapGit(real);
  let counter = 0;
  const deps: LaneServiceDeps = {
    connection: conn,
    workspaceRoot: fixture.root,
    storageDir,
    workspaceId: HARNESS_WS,
    liveLaneCap: 4,
    git,
    clock: () => HARNESS_NOW_MS,
    random: (size) => {
      counter += 1;
      return Buffer.alloc(size, counter);
    },
    ...options.overrides
  };
  const service = LaneService.open(deps);
  const reopen: LaneHarness['reopen'] = (again = {}) =>
    LaneService.open({ ...deps, git: again.wrapGit === undefined ? real : again.wrapGit(real), ...again.overrides });
  const lanes = new LaneStore(conn);
  const laneRoot = async (laneId: string): Promise<string> => {
    const record = lanes.getLane(HARNESS_WS, laneId);
    if (record === null) throw new Error('lane record missing');
    const root = await service.resolveLaneRoot(record.rootRef);
    if (root === null) throw new Error('lane root unresolved');
    return root;
  };
  const provision = async (): Promise<LaneView> => {
    const result = await service.provisionLane({
      rootExecutionId: HARNESS_ROOT_EXECUTION,
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!result.ok) throw new Error(`provisioning refused: ${result.refusal.reason}`);
    return result.value;
  };
  return { fixture, service, lanes, integrations: new IntegrationStore(conn), storageDir, gitEnv, provision, laneRoot, reopen };
}
