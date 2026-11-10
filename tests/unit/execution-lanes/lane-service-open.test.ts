// FR-R6-F10 T015 — opening the lane service.
//
// WHAT THIS PINS:
//   - `open` refuses a live-lane cap outside 1..20 and a provisioning deadline outside
//     1,000..600,000 ms by throwing (a host defect, contract §5), and defaults both;
//   - `open` refuses a workspace root or storage directory that is not absolute (review S7);
//   - each `open` claims the next ownership generation, so an older service is superseded;
//   - `resolveLaneRoot` returns the real path of a lane root inside `<storageDir>/lanes`, and
//     `null` for a root that is absent or resolves outside it (a symlink planted in its place).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LANE_CAP_DEFAULT,
  PROVISIONING_DEADLINE_DEFAULT_MS
} from '../../../src/contracts/execution-lanes';
import type { LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { LaneService, type LaneServiceDeps } from '../../../src/services/execution-lanes/lane-service';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const WS = 'workspace-a';
const LANE_ID = 'f'.repeat(32);

const connections: NodeSqliteConnection[] = [];
const sandboxes: string[] = [];

afterEach(() => {
  for (const conn of connections.splice(0, connections.length)) conn.close();
  for (const dir of sandboxes.splice(0, sandboxes.length)) fs.rmSync(dir, { recursive: true, force: true });
});

const refusingGit: LaneGitRunner = {
  run: () => Promise.reject(new Error('git is not used by open'))
};

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-service-open-'));
  sandboxes.push(dir);
  return dir;
}

function deps(overrides: Partial<LaneServiceDeps> = {}): LaneServiceDeps {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);
  connections.push(conn);
  return {
    connection: conn,
    workspaceRoot: '/nonexistent/workspace',
    storageDir: '/nonexistent/storage',
    workspaceId: WS,
    git: refusingGit,
    clock: () => NOW_MS,
    random: (size) => Buffer.alloc(size, 7),
    ...overrides
  };
}

describe('FR-R6-F10 lane service: open', () => {
  it('defaults the cap and the deadline', () => {
    const service = LaneService.open(deps());
    expect(service.liveLaneCap).toBe(LANE_CAP_DEFAULT);
    expect(service.provisioningDeadlineMs).toBe(PROVISIONING_DEADLINE_DEFAULT_MS);
  });

  it.each([0, 21, 1.5, Number.NaN])('throws on a live-lane cap of %s', (cap) => {
    expect(() => LaneService.open(deps({ liveLaneCap: cap }))).toThrow(RangeError);
  });

  it.each([999, 600_001, 2_000.5])('throws on a provisioning deadline of %s ms', (deadline) => {
    expect(() => LaneService.open(deps({ provisioningDeadlineMs: deadline }))).toThrow(RangeError);
  });

  it.each(['', '.hidden', '..', 'a/b', '-lead', 'x'.repeat(129)])('throws on workspace id %j', (workspaceId) => {
    expect(() => LaneService.open(deps({ workspaceId }))).toThrow(RangeError);
  });

  it.each([
    ['workspaceRoot', 'relative/workspace'],
    ['workspaceRoot', ''],
    ['storageDir', 'relative/storage'],
    ['storageDir', '-storage']
  ] as const)('throws on a relative %s %j (review S7)', (field, value) => {
    expect(() => LaneService.open(deps({ [field]: value }))).toThrow(RangeError);
  });

  it('accepts the range ends', () => {
    expect(LaneService.open(deps({ liveLaneCap: 1, provisioningDeadlineMs: 1_000 })).liveLaneCap).toBe(1);
    expect(LaneService.open(deps({ liveLaneCap: 20, provisioningDeadlineMs: 600_000 })).liveLaneCap).toBe(20);
  });

  it('claims the next generation on each open', () => {
    const shared = deps();
    const first = LaneService.open(shared);
    const second = LaneService.open(shared);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
  });
});

describe('FR-R6-F10 lane service: resolveLaneRoot', () => {
  it('resolves a root inside the lanes directory', async () => {
    const storageDir = sandbox();
    const root = path.join(storageDir, 'lanes', WS, LANE_ID);
    fs.mkdirSync(root, { recursive: true });
    const service = LaneService.open(deps({ storageDir }));
    expect(await service.resolveLaneRoot(`lanes/${WS}/${LANE_ID}`)).toBe(fs.realpathSync(root));
  });

  it('returns null for an absent root', async () => {
    const storageDir = sandbox();
    fs.mkdirSync(path.join(storageDir, 'lanes'), { recursive: true });
    const service = LaneService.open(deps({ storageDir }));
    expect(await service.resolveLaneRoot(`lanes/${WS}/${LANE_ID}`)).toBeNull();
  });

  it('returns null for a root that resolves outside the lanes directory', async () => {
    const storageDir = sandbox();
    const outside = sandbox();
    fs.mkdirSync(path.join(storageDir, 'lanes', WS), { recursive: true });
    fs.symlinkSync(outside, path.join(storageDir, 'lanes', WS, LANE_ID));
    const service = LaneService.open(deps({ storageDir }));
    expect(await service.resolveLaneRoot(`lanes/${WS}/${LANE_ID}`)).toBeNull();
  });

  it('returns null for a reference that escapes lexically', async () => {
    const storageDir = sandbox();
    fs.mkdirSync(path.join(storageDir, 'lanes'), { recursive: true });
    const service = LaneService.open(deps({ storageDir }));
    expect(await service.resolveLaneRoot('lanes/../..')).toBeNull();
    expect(await service.resolveLaneRoot(`lanes/../${LANE_ID}`)).toBeNull();
    expect(await service.resolveLaneRoot(`lanes/./${LANE_ID}`)).toBeNull();
    expect(await service.resolveLaneRoot('/etc')).toBeNull();
  });
});
