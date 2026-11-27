// FR-R6-F10 T036 — failure at every Git boundary of provision, land and cleanup (NFR-005, SC-004).
//
// WHAT THIS PINS: for every N, failing the Nth Git call of the operation, either before the call
// runs or after it ran, leaves untouched:
//   - every ref outside the operated lane's namespace (the landing target too, unless the failed
//     call was the landing effect itself and it ran);
//   - an untracked operator file in the checkout;
//   - an unowned worktree, with its tracked change;
//   - a sibling lane, with its refs and a dirty file.
// A new host's reconcile then classifies the lane or the request: no lane is left `preparing`,
// no request `landing`, and a moved target is reported `landed`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANE_STATES, type VerificationProfile } from '../../../src/contracts/execution-lanes';
import { LaneGitError, type GitRunResult } from '../../../src/services/execution-lanes/git-runner';
import { HARNESS_WS, createLaneHarness, disposeLaneHarnesses, type GitWrapper, type LaneHarness } from './lane-harness';
import type { LaneService } from '../../../src/services/execution-lanes/lane-service';

afterEach(() => {
  disposeLaneHarnesses();
});

const CASE_TIMEOUT_MS = 600_000;
const INJECTED: GitRunResult = { ok: false, exitCode: 128, code: 'exit' };
const OPERATOR_NOTE = 'operator-notes.txt';
const OPERATOR_TEXT = 'operator work, never touched\n';
const UNOWNED_BRANCH = 'operator';
const RELEASE = 'release';
const PASSING: VerificationProfile = {
  profileId: 'unit',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

type Mode = 'before' | 'after';

interface Injector {
  readonly wrap: GitWrapper;
  /** Counts calls from now on, and fails the `failAt`th one (1-based), or none when `null`. */
  arm(failAt: number | null, mode: Mode): void;
  readonly calls: string[][];
  /** Whether the failing call was reached. */
  hit(): boolean;
}

function injector(): Injector {
  const state = { armed: false, hit: false, failAt: null as number | null, mode: 'before' as Mode };
  const calls: string[][] = [];
  const wrap: GitWrapper = (real) => ({
    run: async (args, opts) => {
      if (!state.armed) return real.run(args, opts);
      calls.push([...args]);
      if (calls.length !== state.failAt) return real.run(args, opts);
      state.hit = true;
      if (state.mode === 'before') return INJECTED;
      await real.run(args, opts);
      return INJECTED;
    }
  });
  const arm: Injector['arm'] = (failAt, mode) => {
    state.armed = true;
    state.failAt = failAt;
    state.mode = mode;
  };
  return { wrap, arm, calls, hit: () => state.hit };
}

interface Seeded {
  readonly h: LaneHarness;
  readonly inject: Injector;
  readonly unowned: string;
  readonly siblingId: string;
  readonly siblingRoot: string;
}

/** A harness with an operator file, an unowned dirty worktree and a dirty sibling lane. */
async function seeded(label: string): Promise<Seeded> {
  const inject = injector();
  const h = createLaneHarness({ label, wrapGit: inject.wrap });
  h.fixture.git(['branch', RELEASE]);
  const unowned = h.fixture.sibling('unowned');
  fs.rmSync(unowned, { recursive: true, force: true });
  h.fixture.git(['worktree', 'add', '-q', '-b', UNOWNED_BRANCH, unowned]);
  fs.writeFileSync(path.join(unowned, 'src', 'b.txt'), 'bravo, operator edit\n');
  fs.writeFileSync(path.join(h.fixture.root, OPERATOR_NOTE), OPERATOR_TEXT);
  const sibling = await h.provision();
  const siblingRoot = await h.laneRoot(sibling.laneId);
  fs.writeFileSync(path.join(siblingRoot, OPERATOR_NOTE), OPERATOR_TEXT);
  return { h, inject, unowned, siblingId: sibling.laneId, siblingRoot };
}

interface Snapshot {
  readonly refs: readonly string[];
  readonly checkoutNote: string;
  readonly checkoutNoteStatus: string;
  readonly unownedHead: string;
  readonly unownedStatus: string;
  readonly unownedRegistered: boolean;
  readonly siblingNote: string;
  readonly siblingStatus: string;
}

function registeredPaths(s: Seeded): string[] {
  return s.h.fixture
    .git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => fs.realpathSync(line.slice('worktree '.length)));
}

/** Everything the operation must not touch; `keepRef` drops the refs it may change. */
function snapshot(s: Seeded, keepRef: (ref: string) => boolean): Snapshot {
  const refs = s.h.fixture
    .git(['for-each-ref', '--format=%(refname) %(objectname)'])
    .trim()
    .split('\n')
    .filter((line) => keepRef(line.split(' ').at(0) ?? ''));
  return {
    refs,
    checkoutNote: fs.readFileSync(path.join(s.h.fixture.root, OPERATOR_NOTE), 'utf8'),
    checkoutNoteStatus: s.h.fixture.git(['status', '--porcelain', '--', OPERATOR_NOTE]),
    unownedHead: s.h.fixture.git(['rev-parse', 'HEAD'], s.unowned),
    unownedStatus: s.h.fixture.git(['status', '--porcelain'], s.unowned),
    unownedRegistered: registeredPaths(s).includes(fs.realpathSync(s.unowned)),
    siblingNote: fs.readFileSync(path.join(s.siblingRoot, OPERATOR_NOTE), 'utf8'),
    siblingStatus: s.h.fixture.git(['status', '--porcelain'], s.siblingRoot)
  };
}

function outsideLane(laneId: string): (ref: string) => boolean {
  return (ref) => !ref.startsWith(`refs/schegent/lanes/${laneId}/`);
}

/** Runs `work`, treating a thrown Git failure as one outcome among others. */
async function settle(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // A Git failure is an expected outcome of an injected one; the state is checked after.
    if (!(error instanceof LaneGitError)) throw error;
  }
}

/** A new host's reconcile; returns that host. */
async function reconcileOnNewHost(s: Seeded): Promise<LaneService> {
  const next = s.h.reopen();
  const report = await next.reconcile();
  if (!report.ok) throw new Error(`reconcile refused: ${report.refusal.reason}`);
  return next;
}

/**
 * Runs `scenario` once to count its Git calls, then once per call failing it in `mode`. Returns
 * the counted calls, so the caller can assert the boundary it meant to cover was reached.
 */
async function everyBoundary(
  mode: Mode,
  scenario: (failAt: number | null, mode: Mode) => Promise<Injector>
): Promise<readonly string[][]> {
  const counting = await scenario(null, mode);
  const counted = counting.calls.map((args) => [...args]);
  for (let failAt = 1; failAt <= counted.length; failAt += 1) {
    disposeLaneHarnesses();
    const injected = await scenario(failAt, mode);
    expect(injected.hit(), `call ${failAt} of ${counted.length} was never reached`).toBe(true);
  }
  return counted;
}

interface Approved {
  readonly laneId: string;
  readonly requestId: string;
  readonly candidate: string;
  readonly expected: string;
}

/** A lane with one change, frozen, verified and approved for `target`. */
async function approvedRequest(s: Seeded, target: string): Promise<Approved> {
  const lane = await s.h.provision();
  const root = await s.h.laneRoot(lane.laneId);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha, landed\n');
  const frozen = await s.h.service.freezeCandidate({ laneId: lane.laneId });
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.refusal.reason}`);
  const queued = await s.h.service.requestIntegration({ laneId: lane.laneId, targetBranch: target, profile: PASSING });
  if (!queued.ok) throw new Error(`request refused: ${queued.refusal.reason}`);
  const verified = await s.h.service.verifyRequest({ requestId: queued.value.requestId });
  if (!verified.ok) throw new Error(`verify refused: ${verified.refusal.reason}`);
  const request = verified.value;
  const receipt = s.h.service.approveRequest({
    requestId: request.requestId,
    candidateCommit: request.candidateCommit,
    targetCommit: request.expectedTargetCommit,
    profileRevision: request.profile.revision,
    profileDigest: request.profile.digest
  });
  if (!receipt.ok) throw new Error(`approve refused: ${receipt.refusal.reason}`);
  return { laneId: lane.laneId, requestId: request.requestId, candidate: request.candidateCommit, expected: request.expectedTargetCommit };
}

function verbs(calls: readonly string[][]): string[] {
  return calls.map((args) => args.slice(0, 2).join(' '));
}

describe('FR-R6-F10 fault injection: the snapshot (control)', () => {
  it('sees a moved ref, a changed operator file, a changed unowned worktree and a changed sibling lane', async () => {
    const s = await seeded('fault-control');
    const keepAll = (): boolean => true;
    const changes: readonly (() => void)[] = [
      () => {
        const moved = s.h.fixture.git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'control']).trim();
        s.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, moved]);
      },
      () => fs.writeFileSync(path.join(s.h.fixture.root, OPERATOR_NOTE), 'changed\n'),
      () => fs.writeFileSync(path.join(s.unowned, 'src', 'a.txt'), 'changed\n'),
      () => fs.writeFileSync(path.join(s.siblingRoot, OPERATOR_NOTE), 'changed\n')
    ];
    for (const change of changes) {
      const before = snapshot(s, keepAll);
      change();
      expect(snapshot(s, keepAll)).not.toEqual(before);
    }
  }, CASE_TIMEOUT_MS);
});

describe.each<Mode>(['before', 'after'])('FR-R6-F10 fault injection, failing the call %s it runs (NFR-005)', (mode) => {
  it(
    'provision: unrelated refs, dirty files and worktrees are untouched, and no lane is left preparing',
    async () => {
      const calls = await everyBoundary(mode, async (failAt, m) => {
        const s = await seeded('fault-provision');
        const lanesBefore = s.h.lanes.lanesInStates(HARNESS_WS, LANE_STATES).map((lane) => lane.laneId);
        const unrelated = (ref: string): boolean => {
          if (!ref.startsWith('refs/schegent/lanes/')) return true;
          return lanesBefore.some((laneId) => ref.startsWith(`refs/schegent/lanes/${laneId}/`));
        };
        const before = snapshot(s, unrelated);
        s.inject.arm(failAt, m);

        await settle(() => s.h.service.provisionLane({ rootExecutionId: 'root-exec-2', sourceRevision: 'HEAD', dependencyRecipe: 'none' }));

        expect(snapshot(s, unrelated), `failing call ${failAt} ${m}`).toEqual(before);
        const next = await reconcileOnNewHost(s);
        expect(s.h.lanes.lanesInStates(HARNESS_WS, ['preparing']), `failing call ${failAt} ${m}`).toEqual([]);
        const sibling = next.getLane({ laneId: s.siblingId });
        expect(sibling.ok && sibling.value.state).toBe('active');
        return s.inject;
      });
      expect(verbs(calls)).toContain('worktree add');
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    ['a checked-out target, by fast-forward', 'main', (args: readonly string[]) => args.includes('merge') && args.includes('--ff-only')],
    ['a target checked out nowhere, by update-ref', RELEASE, (args: readonly string[]) => args.at(0) === 'update-ref' && args.at(1) === `refs/heads/${RELEASE}`]
  ])(
    'land %s: unrelated refs, dirty files and worktrees are untouched, and reconcile classifies the request',
    async (_label, target, effect) => {
      const calls = await everyBoundary(mode, async (failAt, m) => {
        const s = await seeded('fault-land');
        const { laneId, requestId, candidate, expected } = await approvedRequest(s, target);
        const targetRef = `refs/heads/${target}`;
        const untouched = (ref: string): boolean => outsideLane(laneId)(ref) && ref !== targetRef;
        const before = snapshot(s, untouched);
        s.inject.arm(failAt, m);

        await settle(() => s.h.service.landRequest({ requestId }));

        const tip = s.h.fixture.git(['rev-parse', targetRef]).trim();
        const at = `failing call ${failAt} ${m}`;
        const effectAt = s.inject.calls.findIndex(effect) + 1;
        const effectRan = effectAt > 0 && !(m === 'before' && failAt === effectAt);
        expect(tip, at).toBe(effectRan ? candidate : expected);
        expect(snapshot(s, untouched), at).toEqual(before);
        const next = await reconcileOnNewHost(s);
        const view = next.getRequest({ requestId });
        if (!view.ok) throw new Error(`getRequest refused: ${view.refusal.reason}`);
        expect(view.value.state, at).not.toBe('landing');
        expect(view.value.state === 'landed', at).toBe(tip === candidate);
        return s.inject;
      });
      expect(calls.filter(effect)).toHaveLength(1);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'cleanup: unrelated refs, dirty files and worktrees are untouched, and the lane is removed or still eligible',
    async () => {
      const calls = await everyBoundary(mode, async (failAt, m) => {
        const s = await seeded('fault-clean');
        const lane = await s.h.provision();
        const completed = s.h.service.completeLane({ laneId: lane.laneId });
        if (!completed.ok) throw new Error(`complete refused: ${completed.refusal.reason}`);
        const released = s.h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' });
        if (!released.ok) throw new Error(`release refused: ${released.refusal.reason}`);
        const root = await s.h.laneRoot(lane.laneId);
        const before = snapshot(s, outsideLane(lane.laneId));
        s.inject.arm(failAt, m);

        await settle(() => s.h.service.cleanupLanes({ laneIds: [lane.laneId] }));

        const at = `failing call ${failAt} ${m}`;
        expect(snapshot(s, outsideLane(lane.laneId)), at).toEqual(before);
        const next = await reconcileOnNewHost(s);
        const view = next.getLane({ laneId: lane.laneId });
        if (!view.ok) throw new Error(`getLane refused: ${view.refusal.reason}`);
        expect(['removed', 'cleanup-eligible'], at).toContain(view.value.state);
        if (view.value.state === 'removed') expect(registeredPaths(s), at).not.toContain(root);
        return s.inject;
      });
      expect(verbs(calls)).toContain('worktree remove');
    },
    CASE_TIMEOUT_MS
  );
});
