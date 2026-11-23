// FR-R6-F10 T034 — lane lifecycle and cleanup (spec US5, FR-005, FR-015; data-model lane lifecycle;
// research R12).
//
// WHAT THIS PINS:
//   - the lifecycle transitions of data-model.md, and `lane-state-invalid` for every other one;
//   - cleanup removes a lane only when every R12 condition holds, checked in the table's order, and
//     otherwise keeps it with the first failing condition as its observation;
//   - removal is `git worktree remove` without `--force`, then the base ref is deleted with its
//     expected value; the candidate ref and every record are kept;
//   - a lane holding only ignored files is removed and those files go with it (R12, measured);
//   - a directory cleanup cannot tie to its own record and Git's registry is never touched.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CleanupReport, LaneView, VerificationProfile } from '../../../src/contracts/execution-lanes';
import { LaneGitError } from '../../../src/services/execution-lanes/git-runner';
import { createLaneHarness, disposeLaneHarnesses, HARNESS_WS, type GitWrapper, type LaneHarness } from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const PROFILE: VerificationProfile = {
  profileId: 'unit',
  revision: 1,
  checks: [{ name: 'pass', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

function valueOf<T>(result: { ok: true; value: T } | { ok: false; refusal: { reason: string } }): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`);
  return result.value;
}

async function eligibleLane(h: LaneHarness): Promise<{ lane: LaneView; root: string }> {
  const lane = await h.provision();
  const root = await h.laneRoot(lane.laneId);
  valueOf(h.service.completeLane({ laneId: lane.laneId }));
  valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));
  return { lane, root };
}

async function cleanup(h: LaneHarness, laneIds?: readonly string[]): Promise<CleanupReport> {
  return valueOf(await h.service.cleanupLanes(laneIds === undefined ? {} : { laneIds }));
}

function registeredPaths(h: LaneHarness): string[] {
  return h.fixture
    .git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function isRegistered(h: LaneHarness, laneId: string): boolean {
  return registeredPaths(h).some((entry) => entry.endsWith(laneId));
}

function refsOf(h: LaneHarness, laneId: string): string[] {
  return h.fixture
    .git(['for-each-ref', '--format=%(refname)', `refs/schegent/lanes/${laneId}/`])
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Holds the first Git call matching `when` until `release` is called. */
/** Records every Git call, so a test can see which mutating ones ran. */
function recorder(): { wrap: GitWrapper; calls: string[][] } {
  const calls: string[][] = [];
  const wrap: GitWrapper = (real) => ({
    run: (args, opts) => {
      calls.push([...args]);
      return real.run(args, opts);
    }
  });
  return { wrap, calls };
}

function removals(calls: readonly string[][]): string[][] {
  return calls.filter((args) => args.at(0) === 'update-ref' || (args.at(0) === 'worktree' && args.at(1) === 'remove'));
}

function gate(when: (args: readonly string[]) => boolean): { wrap: GitWrapper; reached: Promise<void>; release: () => void; armed: { on: boolean } } {
  const armed = { on: false };
  let signal: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap: GitWrapper = (real) => ({
    run: async (args, opts) => {
      if (armed.on && when(args)) {
        armed.on = false;
        signal();
        await opened;
      }
      return real.run(args, opts);
    }
  });
  return { wrap, reached, release, armed };
}

function operationsOf(h: LaneHarness, laneId: string, kind: string): string[] {
  return h.lanes
    .listOperations(laneId)
    .filter((op) => op.kind === kind)
    .map((op) => `${op.status}:${op.reason ?? ''}`);
}

describe('lane lifecycle (data-model, lane lifecycle)', () => {
  it('pauses an active lane and resumes it', async () => {
    const h = createLaneHarness({ label: 'life-pause' });
    const lane = await h.provision();

    expect(valueOf(h.service.pauseLane({ laneId: lane.laneId })).state).toBe('paused');
    expect(h.service.pauseLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-state-invalid' } });
    expect(valueOf(h.service.resumeLane({ laneId: lane.laneId })).state).toBe('active');
    expect(h.service.resumeLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-state-invalid' } });
  });

  it.each(['active', 'paused'] as const)('completes a %s lane', async (state) => {
    const h = createLaneHarness({ label: `life-complete-${state}` });
    const lane = await h.provision();
    if (state === 'paused') valueOf(h.service.pauseLane({ laneId: lane.laneId }));

    expect(valueOf(h.service.completeLane({ laneId: lane.laneId })).state).toBe('completed');
    expect(h.service.completeLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-state-invalid' } });
  });

  it.each(['verifying', 'landing'] as const)('refuses to complete a lane whose request is %s: lane-busy', async (state) => {
    const h = createLaneHarness({ label: `life-busy-${state}` });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'changed\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const request = valueOf(await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PROFILE }));
    const change = { reason: null, now: '2026-11-10T12:00:00.000Z', generation: h.service.generation };
    const states: readonly ('queued' | 'verifying' | 'awaiting-review' | 'landing')[] =
      state === 'verifying' ? ['queued', 'verifying'] : ['queued', 'verifying', 'awaiting-review', 'landing'];
    for (let step = 1; step < states.length; step += 1) {
      const from = states.at(step - 1);
      const to = states.at(step);
      if (from === undefined || to === undefined) throw new Error('bad path');
      valueOf(h.integrations.transitionRequest(HARNESS_WS, request.requestId, [from], to, change));
    }

    expect(h.service.completeLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    expect(valueOf(h.service.getLane({ laneId: lane.laneId })).state).toBe('active');
  });

  it('refuses to complete a lane while this host freezes it: lane-busy', async () => {
    const held = gate((args) => args.at(0) === 'add');
    const h = createLaneHarness({ label: 'life-inflight', wrapGit: held.wrap });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'changed\n');
    held.armed.on = true;
    const freezing = h.service.freezeCandidate({ laneId: lane.laneId });
    await held.reached;

    expect(h.service.completeLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    held.release();
    valueOf(await freezing);
    expect(valueOf(h.service.completeLane({ laneId: lane.laneId })).state).toBe('completed');
  });

  it('refuses to pause a lane while this host freezes it, so no candidate lands on a paused lane: lane-busy (review R9)', async () => {
    const held = gate((args) => args.at(0) === 'add');
    const h = createLaneHarness({ label: 'life-pause-inflight', wrapGit: held.wrap });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'changed\n');
    held.armed.on = true;
    const freezing = h.service.freezeCandidate({ laneId: lane.laneId });
    await held.reached;

    expect(h.service.pauseLane({ laneId: lane.laneId })).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    held.release();
    valueOf(await freezing);
    expect(valueOf(h.service.pauseLane({ laneId: lane.laneId })).state).toBe('paused');
  });

  it('releases a completed lane to retained, and a completed or retained lane to cleanup-eligible', async () => {
    const h = createLaneHarness({ label: 'life-release' });
    const first = await h.provision();
    const second = await h.provision();
    valueOf(h.service.completeLane({ laneId: first.laneId }));
    valueOf(h.service.completeLane({ laneId: second.laneId }));

    expect(valueOf(h.service.releaseLane({ laneId: first.laneId, disposition: 'retain' })).state).toBe('retained');
    expect(h.service.releaseLane({ laneId: first.laneId, disposition: 'retain' })).toEqual({
      ok: false,
      refusal: { reason: 'lane-state-invalid' }
    });
    expect(valueOf(h.service.releaseLane({ laneId: first.laneId, disposition: 'eligible' })).state).toBe('cleanup-eligible');
    expect(valueOf(h.service.releaseLane({ laneId: second.laneId, disposition: 'eligible' })).state).toBe('cleanup-eligible');
  });

  it('refuses to release a live lane: lane-state-invalid', async () => {
    const h = createLaneHarness({ label: 'life-release-live' });
    const lane = await h.provision();

    expect(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' })).toEqual({
      ok: false,
      refusal: { reason: 'lane-state-invalid' }
    });
  });

  it('pins and unpins a lane without changing its state', async () => {
    const h = createLaneHarness({ label: 'life-pin' });
    const lane = await h.provision();

    const pinned = valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: true }));
    expect([pinned.state, pinned.pinned]).toEqual(['active', true]);
    const unpinned = valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: false }));
    expect([unpinned.state, unpinned.pinned]).toEqual(['active', false]);
  });

  it('refuses every lifecycle operation on an unknown lane: lane-not-found', () => {
    const h = createLaneHarness({ label: 'life-unknown' });
    const laneId = 'f'.repeat(32);
    const refused = { ok: false, refusal: { reason: 'lane-not-found' } };

    expect(h.service.pauseLane({ laneId })).toEqual(refused);
    expect(h.service.resumeLane({ laneId })).toEqual(refused);
    expect(h.service.completeLane({ laneId })).toEqual(refused);
    expect(h.service.releaseLane({ laneId, disposition: 'eligible' })).toEqual(refused);
    expect(h.service.setLanePinned({ laneId, pinned: true })).toEqual(refused);
  });

  it('refuses every lifecycle operation from a superseded host: ownership-superseded', async () => {
    const h = createLaneHarness({ label: 'life-superseded' });
    const lane = await h.provision();
    h.reopen();
    const refused = { ok: false, refusal: { reason: 'ownership-superseded' } };

    expect(h.service.pauseLane({ laneId: lane.laneId })).toEqual(refused);
    expect(h.service.resumeLane({ laneId: lane.laneId })).toEqual(refused);
    expect(h.service.completeLane({ laneId: lane.laneId })).toEqual(refused);
    expect(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' })).toEqual(refused);
    expect(h.service.setLanePinned({ laneId: lane.laneId, pinned: true })).toEqual(refused);
    expect(await h.service.cleanupLanes({})).toEqual(refused);
    expect(valueOf(h.service.getLane({ laneId: lane.laneId })).state).toBe('active');
  });
});

describe('cleanupLanes (research R12)', () => {
  it('removes an eligible, clean, unpinned lane: worktree and base ref gone, candidate ref and records kept', async () => {
    const h = createLaneHarness({ label: 'clean-remove' });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'changed\n');
    const candidate = valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    valueOf(h.service.completeLane({ laneId: lane.laneId }));
    valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));

    expect(await cleanup(h)).toEqual({ removed: [lane.laneId], kept: [] });

    expect(fs.existsSync(root)).toBe(false);
    expect(isRegistered(h, lane.laneId)).toBe(false);
    expect(refsOf(h, lane.laneId)).toEqual([lane.candidateRef]);
    expect(h.fixture.git(['rev-parse', lane.candidateRef]).trim()).toBe(candidate.commit);
    const view = valueOf(h.service.getLane({ laneId: lane.laneId }));
    expect([view.state, view.currentCandidate?.commit]).toEqual(['removed', candidate.commit]);
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['succeeded:']);
  });

  it('removes a lane holding only ignored files, and the ignored files go with it', async () => {
    const h = createLaneHarness({ label: 'clean-ignored' });
    fs.appendFileSync(path.join(h.fixture.root, '.git', 'info', 'exclude'), 'build/\n');
    const { lane, root } = await eligibleLane(h);
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'out.txt'), 'output\n');

    expect(await cleanup(h)).toEqual({ removed: [lane.laneId], kept: [] });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('keeps a pinned lane: lane-pinned', async () => {
    const h = createLaneHarness({ label: 'clean-pinned' });
    const { lane, root } = await eligibleLane(h);
    valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: true }));

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }] });
    expect(fs.existsSync(root)).toBe(true);
    expect(isRegistered(h, lane.laneId)).toBe(true);
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['kept:lane-pinned']);
  });

  it.each([
    ['a tracked change', 'src/a.txt'],
    ['an untracked file', 'src/new.txt']
  ])('keeps a lane holding %s without asking Git to remove it: lane-dirty', async (_label, file) => {
    const recorded = recorder();
    const h = createLaneHarness({ label: 'clean-dirty', wrapGit: recorded.wrap });
    const { lane, root } = await eligibleLane(h);
    fs.writeFileSync(path.join(root, file), 'operator work\n');
    recorded.calls.length = 0;

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-dirty' }] });
    expect(removals(recorded.calls)).toEqual([]);
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe('operator work\n');
    expect(refsOf(h, lane.laneId)).toEqual([lane.baseRef]);
  });

  it.each([
    ['never frozen', false],
    ['committed after its last freeze', true]
  ])('keeps a clean lane whose HEAD holds commits no record names, %s: lane-dirty (review R5)', async (_label, frozen) => {
    const recorded = recorder();
    const h = createLaneHarness({ label: 'clean-unfrozen', wrapGit: recorded.wrap });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);
    if (frozen) {
      fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'frozen\n');
      valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    }
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'agent commit\n');
    h.fixture.git(['commit', '-q', '--no-verify', '-a', '-m', 'agent work'], root);
    const agentCommit = h.fixture.git(['rev-parse', 'HEAD'], root).trim();
    valueOf(h.service.completeLane({ laneId: lane.laneId }));
    valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));
    recorded.calls.length = 0;

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-dirty' }] });
    expect(removals(recorded.calls)).toEqual([]);
    expect(isRegistered(h, lane.laneId)).toBe(true);
    expect(h.fixture.git(['rev-parse', 'HEAD'], root).trim()).toBe(agentCommit);
  });

  it.each(['active', 'paused'] as const)('keeps a %s lane named explicitly: lane-live', async (state) => {
    const h = createLaneHarness({ label: `clean-live-${state}` });
    const lane = await h.provision();
    if (state === 'paused') valueOf(h.service.pauseLane({ laneId: lane.laneId }));

    expect(await cleanup(h, [lane.laneId])).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-live' }] });
  });

  it.each(['completed', 'retained'] as const)('keeps a %s lane named explicitly: lane-state-invalid', async (state) => {
    const h = createLaneHarness({ label: `clean-state-${state}` });
    const lane = await h.provision();
    valueOf(h.service.completeLane({ laneId: lane.laneId }));
    if (state === 'retained') valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'retain' }));

    expect(await cleanup(h, [lane.laneId])).toEqual({
      removed: [],
      kept: [{ laneId: lane.laneId, observation: 'lane-state-invalid' }]
    });
  });

  it('checks in R12 table order: a pinned live lane is kept lane-pinned', async () => {
    const h = createLaneHarness({ label: 'clean-order' });
    const lane = await h.provision();
    valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: true }));

    expect(await cleanup(h, [lane.laneId])).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }] });
  });

  it('keeps a lane with an open request: request-open', async () => {
    const h = createLaneHarness({ label: 'clean-request' });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'changed\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    valueOf(await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PROFILE }));
    valueOf(h.service.completeLane({ laneId: lane.laneId }));
    valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'request-open' }] });
  });

  it('keeps a lane whose root resolves outside the lanes directory, and touches neither side: not-contained', async () => {
    const h = createLaneHarness({ label: 'clean-contained' });
    const { lane, root } = await eligibleLane(h);
    const outside = path.join(h.fixture.sibling('outside'), 'moved');
    fs.renameSync(root, outside);
    fs.symlinkSync(outside, root);

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'not-contained' }] });
    expect(fs.readFileSync(path.join(outside, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(true);
  });

  it('keeps a root Git no longer registers, and leaves the directory: registry-mismatch', async () => {
    const h = createLaneHarness({ label: 'clean-registry' });
    const { lane, root } = await eligibleLane(h);
    h.fixture.git(['worktree', 'remove', '--force', root]);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'kept.txt'), 'not a worktree\n');

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'registry-mismatch' }] });
    expect(fs.readFileSync(path.join(root, 'src', 'kept.txt'), 'utf8')).toBe('not a worktree\n');
  });

  it('keeps a root whose registry entry Git reports prunable: registry-mismatch', async () => {
    const h = createLaneHarness({ label: 'clean-prunable' });
    const { lane, root } = await eligibleLane(h);
    fs.rmSync(root, { recursive: true });
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'kept.txt'), 'not a worktree\n');

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'registry-mismatch' }] });
    expect(fs.readFileSync(path.join(root, 'kept.txt'), 'utf8')).toBe('not a worktree\n');
  });

  it('keeps a lane another cleanup of this host is removing: lane-busy', async () => {
    const held = gate((args) => args.at(0) === 'worktree' && args.at(1) === 'remove');
    const h = createLaneHarness({ label: 'clean-busy', wrapGit: held.wrap });
    const { lane } = await eligibleLane(h);
    held.armed.on = true;
    const first = h.service.cleanupLanes({});
    await held.reached;

    expect(await cleanup(h, [lane.laneId])).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-busy' }] });
    held.release();
    expect(valueOf(await first)).toEqual({ removed: [lane.laneId], kept: [] });
  });

  it('settles an unregistered absent preparation-failed lane cleanly to removed (16-19)', async () => {
    const failWorktreeAdd: GitWrapper = (real) => ({
      run: (args, opts) =>
        args.at(0) === 'worktree' && args.at(1) === 'add'
          ? Promise.resolve({ ok: false, exitCode: 128, code: 'exit' })
          : real.run(args, opts)
    });
    const h = createLaneHarness({ label: 'clean-prep', wrapGit: failWorktreeAdd });
    const provisioned = await h.service.provisionLane({ rootExecutionId: 'root-exec-1', sourceRevision: 'HEAD', dependencyRecipe: 'none' });
    expect(provisioned).toEqual({ ok: false, refusal: { reason: 'provisioning-git-failed' } });
    const failed = h.lanes.lanesInStates(HARNESS_WS, ['preparation-failed']).at(0);
    if (failed === undefined) throw new Error('no preparation-failed lane');
    valueOf(h.service.releaseLane({ laneId: failed.laneId, disposition: 'eligible' }));

    // Reconcile does not log `root-missing` for an unregistered absent preparation-failed lane.
    const reconciled = valueOf(await h.service.reconcile());
    expect(reconciled.lanes).toEqual([]);

    expect(await cleanup(h)).toEqual({ removed: [failed.laneId], kept: [] });
    expect(valueOf(h.service.getLane({ laneId: failed.laneId })).state).toBe('removed');
    expect(operationsOf(h, failed.laneId, 'cleanup')).toEqual(['succeeded:']);
  });

  it('never touches a worktree no lane names', async () => {
    const h = createLaneHarness({ label: 'clean-unknown' });
    const stranger = path.join(h.fixture.sibling('operator'), 'operator-tree');
    h.fixture.git(['worktree', 'add', '--detach', stranger, 'HEAD']);
    fs.writeFileSync(path.join(stranger, 'scratch.txt'), 'operator\n');
    const { lane } = await eligibleLane(h);

    expect(await cleanup(h)).toEqual({ removed: [lane.laneId], kept: [] });
    expect(registeredPaths(h).filter((entry) => entry.endsWith('operator-tree'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(stranger, 'scratch.txt'), 'utf8')).toBe('operator\n');
  });

  it('considers only cleanup-eligible lanes when no lane is named', async () => {
    const h = createLaneHarness({ label: 'clean-default' });
    const live = await h.provision();
    const { lane } = await eligibleLane(h);

    expect(await cleanup(h)).toEqual({ removed: [lane.laneId], kept: [] });
    expect(valueOf(h.service.getLane({ laneId: live.laneId })).state).toBe('active');
  });

  it('reports a named lane it does not know as kept, lane-not-found, and a removed lane as lane-state-invalid', async () => {
    const h = createLaneHarness({ label: 'clean-named' });
    const { lane } = await eligibleLane(h);
    await cleanup(h);
    const unknown = 'e'.repeat(32);

    expect(await cleanup(h, [unknown, lane.laneId, unknown])).toEqual({
      removed: [],
      kept: [
        { laneId: unknown, observation: 'lane-not-found' },
        { laneId: lane.laneId, observation: 'lane-state-invalid' }
      ]
    });
  });

  it('keeps a lane that turned dirty between the checks and the removal: Git refuses, lane-dirty', async () => {
    const holder: { root: string | null } = { root: null };
    const dirtyBeforeRemove: GitWrapper = (real) => ({
      run: (args, opts) => {
        if (holder.root !== null && args.at(0) === 'worktree' && args.at(1) === 'remove') {
          fs.writeFileSync(path.join(holder.root, 'late.txt'), 'arrived late\n');
        }
        return real.run(args, opts);
      }
    });
    const h = createLaneHarness({ label: 'clean-late', wrapGit: dirtyBeforeRemove });
    const { lane, root } = await eligibleLane(h);
    holder.root = root;

    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-dirty' }] });
    expect(fs.readFileSync(path.join(root, 'late.txt'), 'utf8')).toBe('arrived late\n');
    expect(valueOf(h.service.getLane({ laneId: lane.laneId })).state).toBe('cleanup-eligible');
  });

  it('throws LaneGitError when Git refuses the removal of a clean lane, and leaves the lane eligible', async () => {
    const refuseRemove: GitWrapper = (real) => ({
      run: (args, opts) =>
        args.at(0) === 'worktree' && args.at(1) === 'remove'
          ? Promise.resolve({ ok: false, exitCode: 128, code: 'exit' })
          : real.run(args, opts)
    });
    const h = createLaneHarness({ label: 'clean-refused', wrapGit: refuseRemove });
    const { lane, root } = await eligibleLane(h);

    await expect(h.service.cleanupLanes({})).rejects.toBeInstanceOf(LaneGitError);
    expect(fs.existsSync(root)).toBe(true);
    expect(valueOf(h.service.getLane({ laneId: lane.laneId })).state).toBe('cleanup-eligible');
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['failed:worktree-remove-failed']);
  });

  it('still removes the lane when the base ref cannot be deleted, and records the ref as kept', async () => {
    const refuseRefDelete: GitWrapper = (real) => ({
      run: (args, opts) =>
        args.at(0) === 'update-ref' && args.at(1) === '-d' ? Promise.resolve({ ok: false, exitCode: 1, code: 'exit' }) : real.run(args, opts)
    });
    const h = createLaneHarness({ label: 'clean-ref', wrapGit: refuseRefDelete });
    const { lane } = await eligibleLane(h);

    expect(await cleanup(h)).toEqual({ removed: [lane.laneId], kept: [] });
    expect(refsOf(h, lane.laneId)).toEqual([lane.baseRef]);
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['succeeded:base-ref-kept']);
  });

  it('deletes the base ref only at its expected value', async () => {
    const recorded = recorder();
    const h = createLaneHarness({ label: 'clean-calls', wrapGit: recorded.wrap });
    const { lane, root } = await eligibleLane(h);
    recorded.calls.length = 0;

    await cleanup(h);

    expect(removals(recorded.calls)).toEqual([
      ['worktree', 'remove', root],
      ['update-ref', '-d', lane.baseRef, lane.sourceCommit]
    ]);
  });
});

describe('FR-R7-16 (16-19): deduplicated keeps, retention, locked worktrees, crash convergence, and concurrent pin', () => {
  it('deduplicates consecutive identical kept cleanup operations and records again when observation changes', async () => {
    const h = createLaneHarness({ label: 'clean-dedup' });
    const { lane, root } = await eligibleLane(h);
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'uncommitted\n');

    for (let i = 0; i < 5; i += 1) {
      expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-dirty' }] });
    }
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['kept:lane-dirty']);

    // Switching reason to lane-pinned records a new row, then deduplicates repeated lane-pinned keeps.
    valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: true }));
    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }] });
    expect(await cleanup(h)).toEqual({ removed: [], kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }] });
    expect(operationsOf(h, lane.laneId, 'cleanup')).toEqual(['kept:lane-dirty', 'kept:lane-pinned']);
  });

  it('keeps a locked worktree with worktree-locked without throwing or aborting sibling lane cleanup', async () => {
    const h = createLaneHarness({ label: 'clean-locked' });
    const locked = await eligibleLane(h);
    const sibling = await eligibleLane(h);
    h.fixture.git(['worktree', 'lock', '--reason', 'operator hold', locked.root]);

    const report = await cleanup(h);

    expect(report).toEqual({
      removed: [sibling.lane.laneId],
      kept: [{ laneId: locked.lane.laneId, observation: 'worktree-locked' }]
    });
    expect(fs.existsSync(locked.root)).toBe(true);
    expect(isRegistered(h, locked.lane.laneId)).toBe(true);
    expect(fs.existsSync(sibling.root)).toBe(false);
    expect(operationsOf(h, locked.lane.laneId, 'cleanup')).toEqual(['kept:worktree-locked']);
  });

  it('aborts removal when a lane is concurrently pinned while cleanup awaits git status, and refuses pin mid-remove', async () => {
    const statusGate = gate((args) => args.includes('status'));
    const h = createLaneHarness({ label: 'clean-concurrent-pin', wrapGit: statusGate.wrap });
    const { lane, root } = await eligibleLane(h);
    statusGate.armed.on = true;

    const cleaning = h.service.cleanupLanes({});
    await statusGate.reached;

    // Operator pins while cleanup is inspecting status: pin succeeds, removal must abort before worktree remove!
    const pinned = valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: true }));
    expect(pinned.pinned).toBe(true);

    statusGate.release();
    expect(valueOf(await cleaning)).toEqual({
      removed: [],
      kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }]
    });
    expect(fs.existsSync(root)).toBe(true);
    expect(isRegistered(h, lane.laneId)).toBe(true);
    expect(valueOf(h.service.getLane({ laneId: lane.laneId })).state).toBe('cleanup-eligible');

    // Once unpinned and past the fenced pre-removal transaction (inside `worktree remove`), pinning refuses lane-busy.
    valueOf(h.service.setLanePinned({ laneId: lane.laneId, pinned: false }));
    const removeGate = gate((args) => args.at(0) === 'worktree' && args.at(1) === 'remove');
    const host2 = h.reopen({ wrapGit: removeGate.wrap });
    removeGate.armed.on = true;
    const removing = host2.cleanupLanes({});
    await removeGate.reached;
    expect(host2.setLanePinned({ laneId: lane.laneId, pinned: true })).toEqual({
      ok: false,
      refusal: { reason: 'lane-busy' }
    });
    removeGate.release();
    expect(valueOf(await removing)).toEqual({ removed: [lane.laneId], kept: [] });
  });

  it('converges cleanly on a crash immediately after git worktree remove via repeated cleanupLanes or reconcile', async () => {
    const crashAfterRemove = { armed: false };
    const h = createLaneHarness({
      label: 'clean-crash-mid',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const res = await real.run(args, opts);
          if (crashAfterRemove.armed && args.at(0) === 'worktree' && args.at(1) === 'remove') {
            crashAfterRemove.armed = false;
            throw new Error('simulated crash mid-cleanup');
          }
          return res;
        }
      })
    });
    const first = await eligibleLane(h);
    const second = await eligibleLane(h);

    // Path A: crash mid-cleanup on `first`, then repeated `cleanupLanes` converges cleanly to `removed`.
    crashAfterRemove.armed = true;
    await expect(h.service.cleanupLanes({ laneIds: [first.lane.laneId] })).rejects.toThrow('simulated crash mid-cleanup');
    expect(fs.existsSync(first.root)).toBe(false);
    expect(h.lanes.hasPendingOperation(first.lane.laneId, 'cleanup')).toBe(true);
    expect(refsOf(h, first.lane.laneId)).toEqual([first.lane.baseRef]);

    const convergedClean = valueOf(await h.reopen().cleanupLanes({ laneIds: [first.lane.laneId] }));
    expect(convergedClean).toEqual({ removed: [first.lane.laneId], kept: [] });
    expect(valueOf(h.service.getLane({ laneId: first.lane.laneId })).state).toBe('removed');
    expect(refsOf(h, first.lane.laneId)).toEqual([]);
    expect(h.lanes.hasPendingOperation(first.lane.laneId, 'cleanup')).toBe(false);

    // Path B: crash mid-cleanup on `second`, then `reconcile` converges cleanly to `removed` and deletes baseRef.
    const hostForSecond = h.reopen({
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const res = await real.run(args, opts);
          if (crashAfterRemove.armed && args.at(0) === 'worktree' && args.at(1) === 'remove') {
            crashAfterRemove.armed = false;
            throw new Error('simulated crash mid-cleanup 2');
          }
          return res;
        }
      })
    });
    crashAfterRemove.armed = true;
    await expect(hostForSecond.cleanupLanes({ laneIds: [second.lane.laneId] })).rejects.toThrow('simulated crash mid-cleanup 2');
    const rec = valueOf(await h.reopen().reconcile());
    expect(rec.lanes).toEqual([{ laneId: second.lane.laneId, from: 'cleanup-eligible', to: 'removed', observation: null }]);
    expect(valueOf(h.service.getLane({ laneId: second.lane.laneId })).state).toBe('removed');
    expect(refsOf(h, second.lane.laneId)).toEqual([]);
  });

  it('keeps status-timeout lanes without aborting sibling cleanup', async () => {
    let targetRoot = '';
    const h = createLaneHarness({
      label: 'clean-status-timeout',
      wrapGit: (real) => ({
        run: (args, opts) => {
          if (targetRoot !== '' && opts.cwd === targetRoot && args.includes('status')) {
            return Promise.resolve({ ok: false, exitCode: null, code: 'timeout' });
          }
          return real.run(args, opts);
        }
      })
    });
    const slow = await eligibleLane(h);
    const fast = await eligibleLane(h);
    targetRoot = slow.root;

    const report = await cleanup(h);
    expect(report).toEqual({
      removed: [fast.lane.laneId],
      kept: [{ laneId: slow.lane.laneId, observation: 'status-timeout' }]
    });
    expect(fs.existsSync(slow.root)).toBe(true);
  });

  it('enforces bounded retention while preserving active, pinned, candidate-bearing, and receipted lanes', async () => {
    let nowMs = Date.UTC(2026, 10, 10, 12, 0, 0);
    const h = createLaneHarness({
      label: 'clean-retention',
      overrides: {
        liveLaneCap: 10,
        clock: () => nowMs,
        retentionPolicy: {
          maxOperationsPerLane: 3,
          terminalLaneRetentionMs: 1_000,
          maxTerminalLanesPerWorkspace: 1
        }
      }
    });

    // 1. Two empty removed lanes (no candidates, no receipts, unpinned) -> oldest pruned past cap/horizon.
    const emptyOld = await eligibleLane(h);
    await cleanup(h, [emptyOld.lane.laneId]);
    nowMs += 5_000;
    const emptyNew = await eligibleLane(h);
    await cleanup(h, [emptyNew.lane.laneId]);

    // 2. A removed lane with a frozen candidate -> MUST be preserved even when aged!
    const withCandidate = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(withCandidate.laneId), 'src', 'a.txt'), 'candidate-work\n');
    valueOf(await h.service.freezeCandidate({ laneId: withCandidate.laneId }));
    valueOf(h.service.completeLane({ laneId: withCandidate.laneId }));
    valueOf(h.service.releaseLane({ laneId: withCandidate.laneId, disposition: 'eligible' }));
    await cleanup(h, [withCandidate.laneId]);

    // 3. A pinned removed lane -> MUST be preserved even when aged!
    const pinnedRemoved = await eligibleLane(h);
    await cleanup(h, [pinnedRemoved.lane.laneId]);
    valueOf(h.service.setLanePinned({ laneId: pinnedRemoved.lane.laneId, pinned: true }));

    // 4. An aged, unpinned preparation-failed lane -> MUST NOT be pruned until cleaned up to removed (CR-B1)!
    const prepFailedLane = await h.provision();
    const prepFailedMoved = h.lanes.transitionLane(HARNESS_WS, prepFailedLane.laneId, ['active'], 'preparation-failed', {
      reason: 'provisioning-git-failed',
      now: new Date(nowMs).toISOString(),
      generation: h.service.generation
    });
    expect(prepFailedMoved.ok).toBe(true);

    // 5. An active lane with alternating keep operations > maxOperationsPerLane (3) -> ops capped at 3, lane preserved!
    const activeLane = await h.provision();
    for (let i = 0; i < 6; i += 1) {
      valueOf(h.service.setLanePinned({ laneId: activeLane.laneId, pinned: i % 2 === 0 }));
      await cleanup(h, [activeLane.laneId]);
    }
    expect(h.lanes.listOperations(activeLane.laneId).length).toBeLessThanOrEqual(3);

    // Advance past terminalLaneRetentionMs (1_000 ms) and trigger retention via cleanupLanes.
    nowMs += 10_000;
    await cleanup(h);

    expect(h.lanes.getLane(HARNESS_WS, emptyOld.lane.laneId)).toBeNull();
    expect(h.lanes.getLane(HARNESS_WS, emptyNew.lane.laneId)).toBeNull();
    expect(h.lanes.getLane(HARNESS_WS, withCandidate.laneId)?.state).toBe('removed');
    expect(h.lanes.currentCandidate(withCandidate.laneId)).not.toBeNull();
    expect(h.lanes.getLane(HARNESS_WS, pinnedRemoved.lane.laneId)?.pinned).toBe(true);
    expect(h.lanes.getLane(HARNESS_WS, prepFailedLane.laneId)?.state).toBe('preparation-failed');
    expect(h.lanes.getLane(HARNESS_WS, activeLane.laneId)?.state).toBe('active');

    // Only after releasing and cleaning up preparation-failed -> removed (and aging) is it pruned.
    valueOf(h.service.releaseLane({ laneId: prepFailedLane.laneId, disposition: 'eligible' }));
    expect(await cleanup(h, [prepFailedLane.laneId])).toEqual({ removed: [prepFailedLane.laneId], kept: [] });
    expect(h.lanes.getLane(HARNESS_WS, prepFailedLane.laneId)?.state).toBe('removed');
    nowMs += 10_000;
    await cleanup(h);
    expect(h.lanes.getLane(HARNESS_WS, prepFailedLane.laneId)).toBeNull();
  });

  it('settleAbsentLane re-checks pin before deleting baseRef so concurrent pin preserves baseRef (CR-B7/SR-B10)', async () => {
    let pinTargetLaneId = '';
    let pinOnce = true;
    let pinAction: (() => void) | null = null;
    const h = createLaneHarness({
      label: 'clean-absent-pin-base',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const res = await real.run(args, opts);
          // Inject concurrent pin right after `resolveCommit(baseRef)` and BEFORE `update-ref -d`.
          if (
            pinOnce &&
            pinTargetLaneId !== '' &&
            args.at(0) === 'rev-parse' &&
            args.some((arg) => arg.startsWith(`refs/schegent/lanes/${pinTargetLaneId}/base`))
          ) {
            pinOnce = false;
            pinAction?.();
          }
          return res;
        }
      })
    });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);
    valueOf(h.service.completeLane({ laneId: lane.laneId }));
    valueOf(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }));
    // Simulate a crash immediately after `git worktree remove`: worktree gone/unregistered, pending cleanup op, baseRef intact.
    h.fixture.git(['worktree', 'remove', root]);
    h.lanes.beginOperation({
      operationId: 'a'.repeat(32),
      laneId: lane.laneId,
      workspaceId: HARNESS_WS,
      kind: 'cleanup',
      generation: h.service.generation,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)).toISOString()
    });

    pinTargetLaneId = lane.laneId;
    pinAction = () => {
      h.lanes.setPinned(HARNESS_WS, lane.laneId, true, new Date(Date.UTC(2026, 10, 10, 12, 0, 1)).toISOString());
    };

    const report = await cleanup(h, [lane.laneId]);
    expect(pinOnce).toBe(false);
    expect(report).toEqual({
      removed: [],
      kept: [{ laneId: lane.laneId, observation: 'lane-pinned' }]
    });
    expect(refsOf(h, lane.laneId)).toEqual([lane.baseRef]);
    expect(h.lanes.getLane(HARNESS_WS, lane.laneId)?.state).toBe('cleanup-eligible');
    expect(h.lanes.hasPendingOperation(lane.laneId, 'cleanup')).toBe(false);
    expect(h.lanes.getOperation('a'.repeat(32))?.status).toBe('kept');
    expect(h.lanes.getOperation('a'.repeat(32))?.reason).toBe('lane-pinned');
  });

  it('keeps a lane pinned during removeLane transition as lane-pinned without aborting sibling cleanup (CR-B7/SR-B10)', async () => {
    let targetLaneId = '';
    let pinDuringRefDelete: (() => void) | null = null;
    const h = createLaneHarness({
      label: 'clean-remove-pin-sibling',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const res = await real.run(args, opts);
          // Pin directly in the store during `update-ref -d` so `transitionLane(..., requireUnpinned: true)` sees `lane-pinned`.
          if (
            pinDuringRefDelete !== null &&
            args.at(0) === 'update-ref' &&
            args.at(1) === '-d' &&
            args.at(2) === `refs/schegent/lanes/${targetLaneId}/base`
          ) {
            const fn = pinDuringRefDelete;
            pinDuringRefDelete = null;
            fn();
          }
          return res;
        }
      })
    });
    const first = await eligibleLane(h);
    const sibling = await eligibleLane(h);
    targetLaneId = first.lane.laneId;
    pinDuringRefDelete = () => {
      h.lanes.setPinned(HARNESS_WS, first.lane.laneId, true, new Date(Date.UTC(2026, 10, 10, 12, 0, 2)).toISOString());
    };

    const report = await cleanup(h, [first.lane.laneId, sibling.lane.laneId]);

    expect(report).toEqual({
      removed: [sibling.lane.laneId],
      kept: [{ laneId: first.lane.laneId, observation: 'lane-pinned' }]
    });
    expect(h.lanes.getLane(HARNESS_WS, first.lane.laneId)?.state).toBe('cleanup-eligible');
    expect(h.lanes.hasPendingOperation(first.lane.laneId, 'cleanup')).toBe(false);
    expect(operationsOf(h, first.lane.laneId, 'cleanup')).toEqual(['kept:lane-pinned']);
    expect(h.lanes.getLane(HARNESS_WS, sibling.lane.laneId)?.state).toBe('removed');
  });
});
