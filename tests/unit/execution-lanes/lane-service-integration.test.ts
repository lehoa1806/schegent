// FR-R6-F10 T029, T030 — the integration path through the service (spec US3-1..5, US4-1..3).
//
// WHAT THIS PINS:
//   - US3-1: request, verify, approve and land move the target to the candidate, with a receipt;
//   - US3-2: a failing check blocks the request with `verification-failed`;
//   - US3-3: an approval naming anything but what was verified refuses `review-stale`;
//   - US3-4: a diverged target refuses at request and at landing, and the lane is kept;
//   - US3-5: a dirty checked-out target refuses landing and nothing changes;
//   - `requestIntegration` validates the branch and the profile and freezes the target tip and the
//     profile digest;
//   - US4-1: a target advanced after approval refuses `target-advanced` and keeps the lane;
//   - US4-2: a refreeze blocks the old request `review-stale`, and approving or landing it refuses
//     `review-stale` (spec and contract §5; tasks.md T030 said `request-state-invalid` for landing);
//   - US4-3: a refreeze while a request of the lane is verifying or landing refuses `lane-busy`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationRequestView, LaneView, VerificationProfile } from '../../../src/contracts/execution-lanes';
import {
  canonicalProfileJson,
  profileDigest,
  TARGET_BRANCH_MAX_BYTES
} from '../../../src/services/execution-lanes/lane-input-rules';
import type { SpawnCheck } from '../../../src/services/execution-lanes/verification-runner';
import { createSpawnCheck } from '../../../src/services/execution-lanes/verification-runner';
import { createLaneHarness, disposeLaneHarnesses, HARNESS_WS, type LaneHarness, type LaneHarnessOptions } from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const CHANGED_TEXT = 'alpha, reviewed\n';
const RELEASE = 'release';

function profileExiting(code: number): VerificationProfile {
  return {
    profileId: 'unit',
    revision: 3,
    checks: [{ name: 'exit', argv: [process.execPath, '-e', `process.exitCode = ${code}`], timeoutMs: 30_000 }]
  };
}

interface Frozen {
  readonly h: LaneHarness;
  readonly lane: LaneView;
  readonly candidateCommit: string;
}

async function frozen(options: LaneHarnessOptions = {}): Promise<Frozen> {
  const h = createLaneHarness({ label: 'svc-int', ...options });
  h.fixture.git(['branch', RELEASE]);
  const lane = await h.provision();
  fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), CHANGED_TEXT);
  const candidate = await h.service.freezeCandidate({ laneId: lane.laneId });
  if (!candidate.ok) throw new Error(`freeze refused: ${candidate.refusal.reason}`);
  return { h, lane, candidateCommit: candidate.value.commit };
}

async function verified(f: Frozen, profile = profileExiting(0), targetBranch = 'main'): Promise<IntegrationRequestView> {
  const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch, profile });
  if (!queued.ok) throw new Error(`request refused: ${queued.refusal.reason}`);
  const done = await f.h.service.verifyRequest({ requestId: queued.value.requestId });
  if (!done.ok) throw new Error(`verify refused: ${done.refusal.reason}`);
  return done.value;
}

function approvalOf(request: IntegrationRequestView) {
  return {
    requestId: request.requestId,
    candidateCommit: request.candidateCommit,
    targetCommit: request.expectedTargetCommit,
    profileRevision: request.profile.revision,
    profileDigest: request.profile.digest
  };
}

function laneKept(f: Frozen): void {
  const lane = f.h.service.getLane({ laneId: f.lane.laneId });
  expect(lane.ok && lane.value.state).toBe('active');
  expect(lane.ok && lane.value.currentCandidate?.commit).toBe(f.candidateCommit);
  expect(fs.existsSync(path.join(f.h.storageDir, 'lanes'))).toBe(true);
}

describe('FR-R6-F10 US3-1: the whole path lands the candidate', () => {
  it('moves the target to the candidate, its files to the candidate tree, and records the receipt', async () => {
    const f = await frozen();
    const request = await verified(f);
    expect(request.state).toBe('awaiting-review');

    const receipt = f.h.service.approveRequest(approvalOf(request));
    expect(receipt.ok && receipt.value).toMatchObject({
      candidateCommit: f.candidateCommit,
      targetCommit: request.expectedTargetCommit,
      profileRevision: 3,
      profileDigest: request.profile.digest,
      outcome: null
    });
    const landed = await f.h.service.landRequest({ requestId: request.requestId });

    expect(landed.ok && landed.value.state).toBe('landed');
    expect(landed.ok && landed.value.receipt?.outcome).toBe('landed');
    expect(f.h.fixture.head()).toBe(f.candidateCommit);
    expect(f.h.fixture.git(['rev-parse', 'HEAD^{tree}']).trim()).toBe(f.h.fixture.git(['rev-parse', `${f.candidateCommit}^{tree}`]).trim());
    expect(f.h.fixture.git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });
});

describe('FR-R6-F10 US3-2: a failing check blocks', () => {
  it('ends verification blocked with verification-failed and keeps the failed check', async () => {
    const f = await frozen();
    const request = await verified(f, profileExiting(3));

    expect([request.state, request.reason]).toEqual(['blocked', 'verification-failed']);
    const checks = f.h.service.getVerification({ requestId: request.requestId });
    expect(checks.ok && checks.value.map((check) => [check.name, check.exitCode, check.passed])).toEqual([['exit', 3, false]]);
    expect(f.h.service.approveRequest(approvalOf(request))).toEqual({
      ok: false,
      refusal: { reason: 'request-state-invalid' }
    });
  });
});

describe('FR-R6-F10 US3-3: approval must name what was verified', () => {
  it.each([
    ['candidate commit', { candidateCommit: 'c'.repeat(40) }],
    ['target commit', { targetCommit: 'e'.repeat(40) }],
    ['profile revision', { profileRevision: 4 }],
    ['profile digest', { profileDigest: '0'.repeat(64) }]
  ])('refuses review-stale for a different %s and writes no receipt', async (_label, change) => {
    const f = await frozen();
    const request = await verified(f);

    expect(f.h.service.approveRequest({ ...approvalOf(request), ...change })).toEqual({
      ok: false,
      refusal: { reason: 'review-stale' }
    });
    expect(f.h.integrations.getReceipt(request.requestId)).toBeNull();
  });

  it('refuses a second approval and an unknown request', async () => {
    const f = await frozen();
    const request = await verified(f);
    expect(f.h.service.approveRequest(approvalOf(request)).ok).toBe(true);

    expect(f.h.service.approveRequest(approvalOf(request))).toEqual({ ok: false, refusal: { reason: 'request-state-invalid' } });
    expect(f.h.service.approveRequest({ ...approvalOf(request), requestId: 'f'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'request-not-found' }
    });
    expect(await f.h.service.landRequest({ requestId: 'f'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'request-not-found' }
    });
  });

  it('refuses to approve a queued request', async () => {
    const f = await frozen();
    const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0) });
    if (!queued.ok) throw new Error('request refused');

    expect(f.h.service.approveRequest(approvalOf(queued.value))).toEqual({
      ok: false,
      refusal: { reason: 'request-state-invalid' }
    });
  });
});

describe('FR-R6-F10 US3-4: a diverged target refuses and the lane is kept', () => {
  it('refuses the request when the target tip is not an ancestor of the candidate', async () => {
    const f = await frozen();
    f.h.fixture.write('src/c.txt', 'charlie\n');
    f.h.fixture.commit('main moves on');

    expect(
      await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0) })
    ).toEqual({ ok: false, refusal: { reason: 'target-diverged' } });
    expect(f.h.integrations.countLaneRequests(f.lane.laneId, ['queued'])).toBe(0);
    laneKept(f);
  });

  it('refuses the landing when the target was rewritten after approval', async () => {
    const f = await frozen();
    const request = await verified(f, profileExiting(0), RELEASE);
    expect(f.h.service.approveRequest(approvalOf(request)).ok).toBe(true);
    const orphan = f.h.fixture.git(['commit-tree', `${request.expectedTargetCommit}^{tree}`, '-m', 'rewritten']).trim();
    f.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, orphan]);

    const result = await f.h.service.landRequest({ requestId: request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('target-diverged');
    laneKept(f);
  });
});

describe('FR-R6-F10 US3-5: a dirty checked-out target refuses landing', () => {
  it('refuses target-worktree-dirty and changes no file or ref', async () => {
    const f = await frozen();
    const request = await verified(f);
    expect(f.h.service.approveRequest(approvalOf(request)).ok).toBe(true);
    const bravo = path.join(f.h.fixture.root, 'src', 'b.txt');
    fs.writeFileSync(bravo, 'operator work\n');
    const refsBefore = f.h.fixture.git(['for-each-ref', '--format=%(refname) %(objectname)']);

    const result = await f.h.service.landRequest({ requestId: request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('target-worktree-dirty');
    expect(f.h.fixture.git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore);
    expect(fs.readFileSync(bravo, 'utf8')).toBe('operator work\n');
    expect(fs.readFileSync(path.join(f.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');
    laneKept(f);
  });
});

describe('FR-R6-F10 requestIntegration: validation and what it freezes', () => {
  it('freezes the target tip, the profile digest and the candidate', async () => {
    const f = await frozen();
    const profile = profileExiting(0);
    const tip = f.h.fixture.head();

    const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile });

    expect(queued.ok && queued.value).toMatchObject({
      state: 'queued',
      targetRef: 'refs/heads/main',
      expectedTargetCommit: tip,
      candidateCommit: f.candidateCommit,
      profile: { profileId: 'unit', revision: 3, digest: profileDigest(canonicalProfileJson(profile)) }
    });
  });

  it.each([
    ['an empty branch name', { targetBranch: '' }],
    ['a branch name with a double dot', { targetBranch: 'a..b' }],
    ['a branch name that is a full ref', { targetBranch: 'refs/heads/main' }],
    ['a branch that does not exist', { targetBranch: 'nowhere' }],
    ['a profile with no checks', { profile: { profileId: 'unit', revision: 1, checks: [] } }],
    ['a profile with a zero revision', { profile: { ...profileExiting(0), revision: 0 } }]
  ])('refuses invalid-input for %s', async (_label, change) => {
    const f = await frozen();

    expect(
      await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0), ...change })
    ).toEqual({ ok: false, refusal: { reason: 'invalid-input' } });
  });

  it('bounds the target branch in UTF-8 bytes, which the store limits, not in characters (review R4)', async () => {
    const f = await frozen();
    const multiByte = ['\u00e9'.repeat(60), '\u00e9'.repeat(60), '\u00e9'.repeat(60)].join('/');
    const atTheBound = 'a'.repeat(TARGET_BRANCH_MAX_BYTES);
    f.h.fixture.git(['branch', multiByte]);
    f.h.fixture.git(['branch', atTheBound]);
    const request = (targetBranch: string) =>
      f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch, profile: profileExiting(0) });

    expect(multiByte.length).toBeLessThan(TARGET_BRANCH_MAX_BYTES);
    expect(await request(multiByte)).toEqual({ ok: false, refusal: { reason: 'invalid-input' } });
    expect((await request(atTheBound)).ok).toBe(true);
  });

  it('refuses lane-not-found for an unknown lane', async () => {
    const f = await frozen();

    expect(
      await f.h.service.requestIntegration({ laneId: 'f'.repeat(32), targetBranch: 'main', profile: profileExiting(0) })
    ).toEqual({ ok: false, refusal: { reason: 'lane-not-found' } });
  });

  it('refuses candidate-empty when the lane has no candidate', async () => {
    const h = createLaneHarness({ label: 'svc-int-empty' });
    const lane = await h.provision();

    expect(await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: profileExiting(0) })).toEqual({
      ok: false,
      refusal: { reason: 'candidate-empty' }
    });
  });

  it('refuses candidate-empty when the target already holds the candidate tree', async () => {
    const f = await frozen();
    f.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, f.candidateCommit]);

    expect(
      await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: RELEASE, profile: profileExiting(0) })
    ).toEqual({ ok: false, refusal: { reason: 'candidate-empty' } });
  });
});

async function refreeze(f: Frozen, text: string) {
  fs.writeFileSync(path.join(await f.h.laneRoot(f.lane.laneId), 'src', 'b.txt'), text);
  return f.h.service.freezeCandidate({ laneId: f.lane.laneId });
}

describe('FR-R6-F10 US4-1: a target advanced after approval refuses', () => {
  it('refuses target-advanced with the commits, blocks the request and keeps the lane and its candidate ref', async () => {
    const f = await frozen();
    const request = await verified(f, profileExiting(0), RELEASE);
    expect(f.h.service.approveRequest(approvalOf(request)).ok).toBe(true);
    const advanced = f.h.fixture
      .git(['commit-tree', `${request.expectedTargetCommit}^{tree}`, '-p', request.expectedTargetCommit, '-m', 'release moves on'])
      .trim();
    f.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, advanced]);

    const result = await f.h.service.landRequest({ requestId: request.requestId });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'target-advanced',
        commits: { expected: request.expectedTargetCommit, candidate: f.candidateCommit, observed: advanced }
      }
    });
    const after = f.h.service.getRequest({ requestId: request.requestId });
    expect(after.ok && [after.value.state, after.value.reason]).toEqual(['blocked', 'target-advanced']);
    expect(f.h.fixture.git(['rev-parse', `refs/heads/${RELEASE}`]).trim()).toBe(advanced);
    expect(f.h.fixture.git(['rev-parse', f.lane.candidateRef]).trim()).toBe(f.candidateCommit);
    laneKept(f);
  });
});

describe('FR-R6-F10 US4-2: a refreeze makes the old request stale', () => {
  it('blocks an awaiting-review request review-stale; approving it refuses review-stale', async () => {
    const f = await frozen();
    const request = await verified(f);
    expect((await refreeze(f, 'bravo, again\n')).ok).toBe(true);

    const after = f.h.service.getRequest({ requestId: request.requestId });
    expect(after.ok && [after.value.state, after.value.reason]).toEqual(['blocked', 'review-stale']);
    expect(f.h.service.approveRequest(approvalOf(request))).toEqual({ ok: false, refusal: { reason: 'review-stale' } });
    expect(f.h.integrations.getReceipt(request.requestId)).toBeNull();
  });

  it('refuses review-stale to land an approved request after a refreeze, and the target stays put', async () => {
    const f = await frozen();
    const request = await verified(f);
    expect(f.h.service.approveRequest(approvalOf(request)).ok).toBe(true);
    const tip = f.h.fixture.head();
    expect((await refreeze(f, 'bravo, again\n')).ok).toBe(true);

    expect(await f.h.service.landRequest({ requestId: request.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'review-stale' }
    });
    expect(f.h.fixture.head()).toBe(tip);
    const receipt = f.h.integrations.getReceipt(request.requestId);
    expect(receipt === null ? 'missing' : receipt.outcome).toBeNull(); // 2026-11-10 coincidental: a lane review receipt, not an audit payload
  });

  it('blocks a queued request review-stale', async () => {
    const f = await frozen();
    const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0) });
    if (!queued.ok) throw new Error('request refused');
    expect((await refreeze(f, 'bravo, again\n')).ok).toBe(true);

    const after = f.h.service.getRequest({ requestId: queued.value.requestId });
    expect(after.ok && [after.value.state, after.value.reason]).toEqual(['blocked', 'review-stale']);
  });

  it('refuses request-state-invalid for a request blocked for another reason', async () => {
    const f = await frozen();
    const request = await verified(f, profileExiting(3));

    expect(f.h.service.approveRequest(approvalOf(request))).toEqual({ ok: false, refusal: { reason: 'request-state-invalid' } });
    expect(await f.h.service.landRequest({ requestId: request.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'request-state-invalid' }
    });
  });
});

describe('FR-R6-F10 US4-3: a refreeze while a request is verifying or landing refuses lane-busy', () => {
  it.each(['verifying', 'landing'] as const)('refuses lane-busy when the stored request is %s', async (state) => {
    const f = await frozen();
    const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0) });
    if (!queued.ok) throw new Error('request refused');
    const moved = f.h.integrations.transitionRequest(HARNESS_WS, queued.value.requestId, ['queued'], state, {
      reason: null,
      now: new Date(0).toISOString(),
      generation: f.lane.ownerGeneration
    });
    expect(moved.ok).toBe(true);
    const candidateBefore = f.h.fixture.git(['rev-parse', f.lane.candidateRef]).trim();

    expect(await refreeze(f, 'bravo, again\n')).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    const after = f.h.service.getRequest({ requestId: queued.value.requestId });
    expect(after.ok && [after.value.state, after.value.reason]).toEqual([state, null]);
    expect(f.h.fixture.git(['rev-parse', f.lane.candidateRef]).trim()).toBe(candidateBefore);
  });

  it('refuses lane-busy while a verification of the lane is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const real = createSpawnCheck();
    const held: SpawnCheck = async (argv, options) => {
      entered();
      await gate;
      return real(argv, options);
    };
    const f = await frozen({ overrides: { spawnCheck: held } });
    const queued = await f.h.service.requestIntegration({ laneId: f.lane.laneId, targetBranch: 'main', profile: profileExiting(0) });
    if (!queued.ok) throw new Error('request refused');

    const verifying = f.h.service.verifyRequest({ requestId: queued.value.requestId });
    await started;
    const refused = await f.h.service.freezeCandidate({ laneId: f.lane.laneId });
    release();
    const verified = await verifying;

    expect(refused).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    expect(verified.ok && verified.value.state).toBe('awaiting-review');
  });
});
