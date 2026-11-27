// FR-R6-F10 T032 — reconciliation after a host stops mid-operation (spec US5-1..4, FR-014, FR-015).
//
// WHAT THIS PINS:
//   - a landing interrupted around its Git effect is classified by contract §6 from the observed
//     target alone: not applied, landed, landed beyond, or uncertain with both commits;
//   - reconciliation never re-applies a landing: no merge and no branch `update-ref` runs;
//   - an interrupted `verifying` request returns to `queued`, and an interrupted `preparing` lane
//     becomes `preparation-failed` with its provision operation ended;
//   - a lane whose root was deleted is reported `root-missing` and left as it is;
//   - a worktree no lane names is counted and never touched;
//   - a request the reconciling host owns is left alone while its lane has an operation in flight,
//     and settled like any other once it has none (a Git failure mid-landing, review R1).
//
// A host "stops" when the wrapped Git runner throws around the landing effect; a new host is the
// harness's `reopen`, which claims the next generation on the same store.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationRequestView, ReconcileReport, VerificationProfile } from '../../../src/contracts/execution-lanes';
import type { LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import {
  createLaneHarness,
  disposeLaneHarnesses,
  HARNESS_ROOT_EXECUTION,
  HARNESS_WS,
  type GitWrapper,
  type LaneHarness
} from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const RELEASE = 'release';
const STOPPED = 'host stopped';
const PROFILE: VerificationProfile = {
  profileId: 'unit',
  revision: 1,
  checks: [{ name: 'pass', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

interface Crash {
  armed: boolean;
  /** `before`: the effect never runs. `after`: it runs, then `then`, then the host stops. */
  readonly when: 'before' | 'after';
  then: () => void;
}

function isLandingEffect(args: readonly string[]): boolean {
  if (args.includes('--ff-only')) return true;
  return args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/');
}

function crashingGit(crash: Crash): GitWrapper {
  return (real) => ({
    run: async (args, opts) => {
      if (!crash.armed || !isLandingEffect(args)) return real.run(args, opts);
      crash.armed = false;
      if (crash.when === 'after') {
        await real.run(args, opts);
        crash.then();
      }
      throw new Error(STOPPED);
    }
  });
}

function recording(calls: string[][]): GitWrapper {
  return (real: LaneGitRunner) => ({
    run: (args, opts) => {
      calls.push([...args]);
      return real.run(args, opts);
    }
  });
}

interface Hold {
  /** Holds the first Git call made while this is true; `null` once it has held one. */
  when: (() => boolean) | null;
  readonly reached: Promise<void>;
  readonly release: () => void;
  readonly signal: () => void;
  readonly released: Promise<void>;
}

function newHold(): Hold {
  let signal = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { when: null, reached, released, signal, release };
}

/** Parks the held call until `release`, so the lane stays in the host's in-flight set meanwhile. */
function holdingGit(hold: Hold): GitWrapper {
  return (real) => ({
    run: async (args, opts) => {
      if (hold.when !== null && hold.when()) {
        hold.when = null;
        hold.signal();
        await hold.released;
      }
      return real.run(args, opts);
    }
  });
}

async function verifyAndApprove(h: LaneHarness, requestId: string): Promise<IntegrationRequestView> {
  const verified = await h.service.verifyRequest({ requestId });
  if (!verified.ok) throw new Error(`verify refused: ${verified.refusal.reason}`);
  const request = verified.value;
  const approved = h.service.approveRequest({
    requestId: request.requestId,
    candidateCommit: request.candidateCommit,
    targetCommit: request.expectedTargetCommit,
    profileRevision: request.profile.revision,
    profileDigest: request.profile.digest
  });
  if (!approved.ok) throw new Error(`approve refused: ${approved.refusal.reason}`);
  return request;
}

interface Interrupted {
  readonly h: LaneHarness;
  readonly requestId: string;
  readonly expected: string;
  readonly candidate: string;
}

/** Lands a verified, approved request on `target` and stops the host around the effect. */
async function interrupted(target: string, when: Crash['when'], then: (h: LaneHarness) => void = () => undefined): Promise<Interrupted> {
  const crash: Crash = { armed: false, when, then: () => undefined };
  const h = createLaneHarness({ label: 'reconcile', wrapGit: crashingGit(crash) });
  crash.then = () => then(h);
  h.fixture.git(['branch', RELEASE]);
  const lane = await h.provision();
  fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'alpha, reconciled\n');
  const frozen = await h.service.freezeCandidate({ laneId: lane.laneId });
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.refusal.reason}`);
  const queued = await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: target, profile: PROFILE });
  if (!queued.ok) throw new Error(`request refused: ${queued.refusal.reason}`);
  const request = await verifyAndApprove(h, queued.value.requestId);

  crash.armed = true;
  await expect(h.service.landRequest({ requestId: request.requestId })).rejects.toThrow(STOPPED);
  expect(h.integrations.getRequest(HARNESS_WS, request.requestId)?.state).toBe('landing');
  return { h, requestId: request.requestId, expected: request.expectedTargetCommit, candidate: request.candidateCommit };
}

async function reconcileAsNewHost(h: LaneHarness, calls: string[][] = []): Promise<ReconcileReport> {
  const result = await h.reopen({ wrapGit: recording(calls) }).reconcile();
  if (!result.ok) throw new Error(`reconcile refused: ${result.refusal.reason}`);
  return result.value;
}

function landingEffects(calls: readonly (readonly string[])[]): number {
  return calls.filter((args) => isLandingEffect(args) || args.includes('merge')).length;
}

describe('FR-R6-F10 US5-1..4: an interrupted landing is classified, never replayed', () => {
  it('US5-1: the target still at T is blocked landing-not-applied, and nothing is replayed', async () => {
    const f = await interrupted('main', 'before');
    const calls: string[][] = [];

    const report = await reconcileAsNewHost(f.h, calls);

    expect(report.requests).toEqual([
      {
        requestId: f.requestId,
        from: 'landing',
        to: 'blocked',
        reason: 'landing-not-applied',
        commits: { expected: f.expected, candidate: f.candidate, observed: f.expected }
      }
    ]);
    expect(landingEffects(calls)).toBe(0);
    expect(f.h.fixture.head()).toBe(f.expected);
    expect(f.h.integrations.getReceipt(f.requestId)?.outcome).toBe('blocked');
    const journal = f.h.integrations.listJournal(f.requestId);
    expect(journal.map((entry) => entry.kind)).toEqual(['landing-intent', 'reconcile']);
    expect(journal.at(-1)).toMatchObject({ method: null, observedTip: f.expected, outcome: 'blocked', reason: 'landing-not-applied' });
  });

  it('US5-2: the target at C is landed', async () => {
    const f = await interrupted('main', 'after');
    const calls: string[][] = [];

    const report = await reconcileAsNewHost(f.h, calls);

    expect(report.requests).toEqual([{ requestId: f.requestId, from: 'landing', to: 'landed', reason: null }]);
    expect(landingEffects(calls)).toBe(0);
    expect(f.h.integrations.getRequest(HARNESS_WS, f.requestId)?.state).toBe('landed');
    expect(f.h.integrations.getReceipt(f.requestId)?.outcome).toBe('landed');
  });

  it('US5-3: the target past C is landed with target-advanced-beyond', async () => {
    const f = await interrupted('main', 'after', (h) => {
      h.fixture.write('src/c.txt', 'charlie\n');
      h.fixture.commit('main moves past the candidate');
    });

    const report = await reconcileAsNewHost(f.h);

    expect(report.requests).toEqual([{ requestId: f.requestId, from: 'landing', to: 'landed', reason: 'target-advanced-beyond' }]);
  });

  it('US5-4: the target elsewhere is uncertain and lists both commits', async () => {
    const f = await interrupted(RELEASE, 'before');
    const orphan = f.h.fixture.git(['commit-tree', `${f.expected}^{tree}`, '-m', 'rewritten']).trim();
    f.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, orphan]);

    const report = await reconcileAsNewHost(f.h);

    expect(report.requests).toEqual([
      {
        requestId: f.requestId,
        from: 'landing',
        to: 'uncertain',
        reason: null,
        commits: { expected: f.expected, candidate: f.candidate, observed: orphan }
      }
    ]);
    expect(f.h.fixture.git(['rev-parse', `refs/heads/${RELEASE}`]).trim()).toBe(orphan);
  });

  it('US5-4: the checked-out target at C with stale files is uncertain', async () => {
    const f = await interrupted('main', 'before');
    f.h.fixture.git(['update-ref', 'refs/heads/main', f.candidate]);

    const report = await reconcileAsNewHost(f.h);

    expect(report.requests).toEqual([
      {
        requestId: f.requestId,
        from: 'landing',
        to: 'uncertain',
        reason: null,
        commits: { expected: f.expected, candidate: f.candidate, observed: f.candidate }
      }
    ]);
    expect(fs.readFileSync(path.join(f.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  it('settles once: a second reconcile reports nothing', async () => {
    const f = await interrupted('main', 'before');
    await reconcileAsNewHost(f.h);

    const again = await reconcileAsNewHost(f.h);

    expect(again).toEqual({ lanes: [], requests: [], unknownWorktrees: 0 });
  });
});

describe('FR-R6-F10 US5: other interruptions', () => {
  it('returns an interrupted verifying request to queued', async () => {
    const h = createLaneHarness({ label: 'reconcile-verify' });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'alpha, verifying\n');
    expect((await h.service.freezeCandidate({ laneId: lane.laneId })).ok).toBe(true);
    const queued = await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PROFILE });
    if (!queued.ok) throw new Error('request refused');
    const moved = h.integrations.transitionRequest(HARNESS_WS, queued.value.requestId, ['queued'], 'verifying', {
      reason: null,
      now: new Date(0).toISOString(),
      generation: h.service.generation
    });
    expect(moved.ok).toBe(true);

    const report = await reconcileAsNewHost(h);

    expect(report.requests).toEqual([{ requestId: queued.value.requestId, from: 'verifying', to: 'queued', reason: null }]);
    expect(h.integrations.getRequest(HARNESS_WS, queued.value.requestId)?.state).toBe('queued');
  });

  it('moves an interrupted preparing lane to preparation-failed and ends its provision operation', async () => {
    // A host that stopped mid-provision never settles its lane; a step that throws does (review
    // R12). So the stop is a call parked for good while a newer host reconciles.
    const hold = newHold();
    const parkAtWorktreeAdd: GitWrapper = (real) => ({
      run: async (args, opts) => {
        if (args.at(0) === 'worktree' && args.at(1) === 'add') {
          hold.signal();
          await hold.released;
        }
        return real.run(args, opts);
      }
    });
    const h = createLaneHarness({ label: 'reconcile-prep', wrapGit: parkAtWorktreeAdd });
    const stalled = h.provision().catch(() => undefined);
    await hold.reached;
    const preparing = h.lanes.lanesInStates(HARNESS_WS, ['preparing']).at(0);
    if (preparing === undefined) throw new Error('no preparing lane');

    const report = await reconcileAsNewHost(h);
    hold.release();
    await stalled;

    expect(report.lanes).toEqual([{ laneId: preparing.laneId, from: 'preparing', to: 'preparation-failed', observation: null }]);
    const lane = h.lanes.getLane(HARNESS_WS, preparing.laneId);
    expect(lane === null ? null : [lane.state, lane.stateReason]).toEqual(['preparation-failed', 'provisioning-interrupted']);
    const operations = h.lanes.listOperations(preparing.laneId).map((op) => `${op.kind}:${op.status}:${op.reason ?? ''}`);
    expect([...operations].sort()).toEqual(['provision:failed:provisioning-interrupted', 'reconcile:succeeded:']);
  });

  it('reports a lane whose root was deleted root-missing, and does not re-provision it', async () => {
    const h = createLaneHarness({ label: 'reconcile-root' });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);
    fs.rmSync(root, { recursive: true, force: true });

    const report = await reconcileAsNewHost(h);

    expect(report).toEqual({
      lanes: [{ laneId: lane.laneId, from: 'active', to: 'active', observation: 'root-missing' }],
      requests: [],
      unknownWorktrees: 0
    });
    expect(fs.existsSync(root)).toBe(false);
    expect(h.lanes.getLane(HARNESS_WS, lane.laneId)?.state).toBe('active');
  });

  it('counts a worktree no lane names and leaves it in place', async () => {
    const h = createLaneHarness({ label: 'reconcile-unknown' });
    await h.provision();
    const stranger = path.join(h.fixture.sibling('elsewhere'), 'operator-tree');
    h.fixture.git(['worktree', 'add', '--detach', stranger, 'HEAD']);
    const registryBefore = h.fixture.git(['worktree', 'list', '--porcelain']);

    const report = await reconcileAsNewHost(h);

    expect(report).toEqual({ lanes: [], requests: [], unknownWorktrees: 1 });
    expect(fs.existsSync(path.join(stranger, 'src', 'a.txt'))).toBe(true);
    expect(h.fixture.git(['worktree', 'list', '--porcelain'])).toBe(registryBefore);
  });

  it.each(['verifying', 'landing'] as const)(
    "leaves the reconciling host's own %s request alone while its lane is in flight",
    async (state) => {
      const hold = newHold();
      const h = createLaneHarness({ label: 'reconcile-own', wrapGit: holdingGit(hold) });
      const lane = await h.provision();
      fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'alpha, own\n');
      expect((await h.service.freezeCandidate({ laneId: lane.laneId })).ok).toBe(true);
      const queued = await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PROFILE });
      if (!queued.ok) throw new Error('request refused');
      const requestId = queued.value.requestId;
      if (state === 'landing') await verifyAndApprove(h, requestId);
      hold.when = () => h.integrations.getRequest(HARNESS_WS, requestId)?.state === state;
      const pending = state === 'verifying' ? h.service.verifyRequest({ requestId }) : h.service.landRequest({ requestId });
      await hold.reached;

      const result = await h.service.reconcile();
      const stateAtReconcile = h.integrations.getRequest(HARNESS_WS, requestId)?.state;
      hold.release();
      await pending;

      expect(result).toEqual({ ok: true, value: { lanes: [], requests: [], unknownWorktrees: 0 } });
      expect(stateAtReconcile).toBe(state);
    }
  );

  it("settles the host's own landing a Git failure left behind once its lane is free", async () => {
    const f = await interrupted('main', 'before');

    const result = await f.h.service.reconcile();

    expect(result.ok && result.value.requests).toEqual([
      {
        requestId: f.requestId,
        from: 'landing',
        to: 'blocked',
        reason: 'landing-not-applied',
        commits: { expected: f.expected, candidate: f.candidate, observed: f.expected }
      }
    ]);
    expect(f.h.fixture.head()).toBe(f.expected);
    expect(f.h.integrations.listJournal(f.requestId).map((entry) => entry.kind)).toEqual(['landing-intent', 'reconcile']);
    expect(f.h.integrations.requestsInStates(HARNESS_WS, ['verifying', 'landing'])).toEqual([]);
  });

  it("leaves the reconciling host's own preparing lane alone", async () => {
    const h = createLaneHarness({ label: 'reconcile-own-prep' });
    const lane = await h.provision();
    const change = { reason: null, now: new Date(0).toISOString(), generation: h.service.generation };
    expect(h.lanes.transitionLane(HARNESS_WS, lane.laneId, ['active'], 'preparing', change).ok).toBe(true);

    const result = await h.service.reconcile();

    expect(result).toEqual({ ok: true, value: { lanes: [], requests: [], unknownWorktrees: 0 } });
    expect(h.lanes.getLane(HARNESS_WS, lane.laneId)?.state).toBe('preparing');
  });

  it('refuses ownership-superseded once a newer host has opened', async () => {
    const h = createLaneHarness({ label: 'reconcile-superseded' });
    h.reopen();

    expect(await h.service.reconcile()).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
  });

  it('does not count the main worktree when the workspace is a linked worktree', async () => {
    const h = createLaneHarness({ label: 'reconcile-linked' });
    const linked = path.join(h.fixture.sibling('linked'), 'workspace');
    h.fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);

    const result = await h.reopen({ overrides: { workspaceRoot: linked } }).reconcile();

    expect(result).toEqual({ ok: true, value: { lanes: [], requests: [], unknownWorktrees: 0 } });
  });

  it('matches a lane root reached through a symlinked storage directory', async () => {
    const h = createLaneHarness({ label: 'reconcile-symlink' });
    const link = path.join(h.fixture.sibling('links'), 'storage');
    fs.symlinkSync(h.storageDir, link);
    const host = h.reopen({ overrides: { storageDir: link } });
    const provisioned = await host.provisionLane({ rootExecutionId: HARNESS_ROOT_EXECUTION, sourceRevision: 'HEAD', dependencyRecipe: 'none' });
    expect(provisioned.ok).toBe(true);

    const result = await host.reconcile();

    expect(result).toEqual({ ok: true, value: { lanes: [], requests: [], unknownWorktrees: 0 } });
  });

  it('stops with ownership-superseded when a newer host opens mid-reconcile, and leaves the landing unsettled', async () => {
    const f = await interrupted('main', 'before');
    const armed = { value: true };
    const supersedeOnFirstRead: GitWrapper = (real) => ({
      run: (args, opts) => {
        if (armed.value && args.at(0) === 'rev-parse') {
          armed.value = false;
          f.h.reopen();
        }
        return real.run(args, opts);
      }
    });

    const result = await f.h.reopen({ wrapGit: supersedeOnFirstRead }).reconcile();

    expect(armed.value).toBe(false);
    expect(result).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(f.h.integrations.getRequest(HARNESS_WS, f.requestId)?.state).toBe('landing');
    expect(f.h.integrations.listJournal(f.requestId).map((entry) => entry.kind)).toEqual(['landing-intent']);
  });

  it('distinguishes containment-refused from root-missing and deduplicates consecutive reconcile keep rows (16-19)', async () => {
    const h = createLaneHarness({ label: 'reconcile-containment' });
    const escaped = await h.provision();
    const deleted = await h.provision();
    const escapedRoot = await h.laneRoot(escaped.laneId);
    const deletedRoot = await h.laneRoot(deleted.laneId);
    const outside = path.join(h.fixture.sibling('outside'), 'escaped-target');
    fs.renameSync(escapedRoot, outside);
    fs.symlinkSync(outside, escapedRoot);
    fs.rmSync(deletedRoot, { recursive: true, force: true });

    const first = await reconcileAsNewHost(h);
    expect(first.lanes).toEqual([
      { laneId: escaped.laneId, from: 'active', to: 'active', observation: 'containment-refused' },
      { laneId: deleted.laneId, from: 'active', to: 'active', observation: 'root-missing' }
    ]);

    // Repeating reconcile 3 more times keeps reporting the observations without appending duplicate rows.
    const host = h.reopen();
    for (let i = 0; i < 3; i += 1) {
      const again = await host.reconcile();
      expect(again.ok).toBe(true);
    }
    const escapedReconciles = h.lanes.listOperations(escaped.laneId).filter((op) => op.kind === 'reconcile');
    const deletedReconciles = h.lanes.listOperations(deleted.laneId).filter((op) => op.kind === 'reconcile');
    expect(escapedReconciles.map((op) => `${op.status}:${op.reason}`)).toEqual(['kept:containment-refused']);
    expect(deletedReconciles.map((op) => `${op.status}:${op.reason}`)).toEqual(['kept:root-missing']);
  });

  it('classifies a landing request whose candidate commit is missing/GCd as uncertain instead of wedging, while keeping git-error retryable (16-23)', async () => {
    const f = await interrupted(RELEASE, 'before');
    const other = f.h.fixture.git(['commit-tree', `${f.expected}^{tree}`, '-m', 'diverged-other']).trim();
    f.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, other]);

    // 1. Transient timeout (git-error) leaves request in `landing` so a subsequent reconcile can still classify it.
    const timeoutReconcile = await f.h
      .reopen({
        wrapGit: (real) => ({
          run: (args, opts) =>
            args.at(0) === 'merge-base'
              ? Promise.resolve({ ok: false, exitCode: null, code: 'timeout' })
              : real.run(args, opts)
        })
      })
      .reconcile();
    expect(timeoutReconcile.ok && timeoutReconcile.value.requests).toEqual([]);
    expect(f.h.integrations.getRequest(HARNESS_WS, f.requestId)?.state).toBe('landing');

    // 2. Missing/GC'd commit (`merge-base` exit 128 + `rev-parse` exit 1) settles as `uncertain` instead of wedging!
    const missingCommitReconcile = await f.h
      .reopen({
        wrapGit: (real) => ({
          run: (args, opts) => {
            if (args.at(0) === 'merge-base') {
              return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
            }
            if (args.at(0) === 'rev-parse' && (args.at(3) ?? '').startsWith(f.candidate)) {
              return Promise.resolve({ ok: false, exitCode: 1, code: 'exit' });
            }
            return real.run(args, opts);
          }
        })
      })
      .reconcile();
    expect(missingCommitReconcile.ok && missingCommitReconcile.value.requests).toEqual([
      {
        requestId: f.requestId,
        from: 'landing',
        to: 'uncertain',
        reason: null,
        commits: { expected: f.expected, candidate: f.candidate, observed: other }
      }
    ]);
    expect(f.h.integrations.getRequest(HARNESS_WS, f.requestId)?.state).toBe('uncertain');
  });

  it('preserves baseRef and closes interrupted cleanup operations cleanly when a lane is pinned or holds an open request (CR-B7/SR-B10)', async () => {
    const h = createLaneHarness({ label: 'reconcile-cleanup-guards', overrides: { liveLaneCap: 4 } });

    // Case 1: Pinned cleanup-eligible lane with pending cleanup op and already-removed worktree.
    const pinnedLane = await h.provision();
    const pinnedRoot = await h.laneRoot(pinnedLane.laneId);
    expect(h.service.completeLane({ laneId: pinnedLane.laneId }).ok).toBe(true);
    expect(h.service.releaseLane({ laneId: pinnedLane.laneId, disposition: 'eligible' }).ok).toBe(true);
    h.fixture.git(['worktree', 'remove', pinnedRoot]);
    const pinnedOpId = '1'.repeat(32);
    h.lanes.beginOperation({
      operationId: pinnedOpId,
      laneId: pinnedLane.laneId,
      workspaceId: HARNESS_WS,
      kind: 'cleanup',
      generation: h.service.generation,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)).toISOString()
    });
    expect(h.service.setLanePinned({ laneId: pinnedLane.laneId, pinned: true }).ok).toBe(true);

    // Case 2: Cleanup-eligible lane with an open integration request, pending cleanup op, and removed worktree.
    const openReqLane = await h.provision();
    const openReqRoot = await h.laneRoot(openReqLane.laneId);
    fs.writeFileSync(path.join(openReqRoot, 'src', 'a.txt'), 'open-req-edit\n');
    expect((await h.service.freezeCandidate({ laneId: openReqLane.laneId })).ok).toBe(true);
    expect(
      (await h.service.requestIntegration({ laneId: openReqLane.laneId, targetBranch: 'main', profile: PROFILE })).ok
    ).toBe(true);
    expect(h.service.completeLane({ laneId: openReqLane.laneId }).ok).toBe(true);
    expect(h.service.releaseLane({ laneId: openReqLane.laneId, disposition: 'eligible' }).ok).toBe(true);
    h.fixture.git(['worktree', 'remove', openReqRoot]);
    const openReqOpId = '2'.repeat(32);
    h.lanes.beginOperation({
      operationId: openReqOpId,
      laneId: openReqLane.laneId,
      workspaceId: HARNESS_WS,
      kind: 'cleanup',
      generation: h.service.generation,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 1)).toISOString()
    });

    // Case 3: Concurrent pin right before `update-ref -d` during reconcile preserves baseRef & closes op cleanly.
    const racingLane = await h.provision();
    const racingRoot = await h.laneRoot(racingLane.laneId);
    expect(h.service.completeLane({ laneId: racingLane.laneId }).ok).toBe(true);
    expect(h.service.releaseLane({ laneId: racingLane.laneId, disposition: 'eligible' }).ok).toBe(true);
    h.fixture.git(['worktree', 'remove', racingRoot]);
    const racingOpId = '3'.repeat(32);
    h.lanes.beginOperation({
      operationId: racingOpId,
      laneId: racingLane.laneId,
      workspaceId: HARNESS_WS,
      kind: 'cleanup',
      generation: h.service.generation,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 2)).toISOString()
    });

    let pinRacingOnce = true;
    const host2 = h.reopen({
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const res = await real.run(args, opts);
          if (
            pinRacingOnce &&
            args.at(0) === 'rev-parse' &&
            args.some((arg) => arg.startsWith(`refs/schegent/lanes/${racingLane.laneId}/base`))
          ) {
            pinRacingOnce = false;
            h.lanes.setPinned(HARNESS_WS, racingLane.laneId, true, new Date(Date.UTC(2026, 10, 10, 12, 0, 3)).toISOString());
          }
          return res;
        }
      })
    });

    const rec = await host2.reconcile();
    expect(pinRacingOnce).toBe(false);
    expect(rec.ok).toBe(true);

    // None of the three lanes transitioned to `removed`, all three kept their `baseRef`, and ZERO pending ops remain!
    expect(h.lanes.getLane(HARNESS_WS, pinnedLane.laneId)?.state).toBe('cleanup-eligible');
    expect(h.lanes.getLane(HARNESS_WS, openReqLane.laneId)?.state).toBe('cleanup-eligible');
    expect(h.lanes.getLane(HARNESS_WS, racingLane.laneId)?.state).toBe('cleanup-eligible');
    expect(h.fixture.git(['for-each-ref', '--format=%(refname)', pinnedLane.baseRef]).trim()).toBe(pinnedLane.baseRef);
    expect(h.fixture.git(['for-each-ref', '--format=%(refname)', openReqLane.baseRef]).trim()).toBe(openReqLane.baseRef);
    expect(h.fixture.git(['for-each-ref', '--format=%(refname)', racingLane.baseRef]).trim()).toBe(racingLane.baseRef);
    expect(h.lanes.listPendingOperations(HARNESS_WS)).toEqual([]);

    expect(h.lanes.getOperation(pinnedOpId)).toMatchObject({ status: 'kept', reason: 'lane-pinned' });
    expect(h.lanes.getOperation(openReqOpId)).toMatchObject({ status: 'kept', reason: 'integration-request-open' });
    expect(h.lanes.getOperation(racingOpId)).toMatchObject({ status: 'kept', reason: 'lane-pinned' });
  });
});
