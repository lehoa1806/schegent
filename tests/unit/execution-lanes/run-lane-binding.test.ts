// FR-R6-F10 (`SR-B3`): RunLaneCoordinator pagination past 200 historical terminal lanes/requests.
//
// WHAT THIS PINS:
//   - >205 historical `removed` lanes never crowd out lane #206+ in `getProtectedRunIds()`,
//     `refreshCacheFromStore()`, or `findLaneForRun()` (`resolveLaneIdForRun` /
//     `resolveExecutionRoot` / `onRunTerminal`);
//   - >205 historical terminal requests never crowd out an open cancelable request on `onRunPaused`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerificationProfile } from '../../../src/contracts/execution-lanes';
import { LaneGitError } from '../../../src/services/execution-lanes/git-runner';
import { createRunLaneCoordinator } from '../../../src/services/execution-lanes/run-lane-binding';
import { laneBaseRef, laneCandidateRef, laneRootRef } from '../../../src/services/execution-lanes/lane-store-rows';
import { createLaneHarness, disposeLaneHarnesses, HARNESS_NOW_MS, HARNESS_WS } from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const PROFILE: VerificationProfile = {
  profileId: 'sr-b3',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 10_000 }]
};

function hexId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

describe('FR-R6-F10 RunLaneCoordinator pagination past 200 historical records (SR-B3)', () => {
  it('finds active and completed lanes past >205 historical removed lanes in getProtectedRunIds, refreshCacheFromStore, and findLaneForRun', async () => {
    const h = createLaneHarness({ label: 'coord-paging', overrides: { liveLaneCap: 4 } });
    const seedCommit = h.fixture.head();
    const repoId = 'a'.repeat(64);

    // Seed 206 older historical `removed` lanes (timestamps strictly before HARNESS_NOW_MS) so page 1
    // (limit 200, oldest-first) is completely filled by terminal lanes!
    for (let i = 1; i <= 206; i += 1) {
      const laneId = hexId(10_000 + i);
      const ts = new Date(HARNESS_NOW_MS - (300 - i) * 1_000).toISOString();
      h.lanes.insertLane({
        laneId,
        workspaceId: HARNESS_WS,
        repositoryId: repoId,
        rootExecutionId: `historical-run-${i}`,
        sourceCommit: seedCommit,
        baseRef: laneBaseRef(laneId),
        candidateRef: laneCandidateRef(laneId),
        rootRef: laneRootRef(HARNESS_WS, laneId),
        dependencyRecipe: 'none',
        state: 'removed',
        stateReason: null,
        pinned: false,
        ownerGeneration: h.service.generation,
        createdAt: ts,
        updatedAt: ts
      });
    }

    // Provision real active lane #207 and completed lane #208 (created at HARNESS_NOW_MS -> page 2!).
    const activeProv = await h.service.provisionLane({
      rootExecutionId: 'run-active-207',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!activeProv.ok) throw new Error(`active provision failed: ${activeProv.refusal.reason}`);
    const activeLane = activeProv.value;
    const activeRoot = await h.laneRoot(activeLane.laneId);

    const completedProv = await h.service.provisionLane({
      rootExecutionId: 'run-completed-208',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!completedProv.ok) throw new Error(`completed provision failed: ${completedProv.refusal.reason}`);
    const completedLane = completedProv.value;
    expect(h.service.completeLane({ laneId: completedLane.laneId }).ok).toBe(true);

    // 1. Fresh coordinator (empty cache): `getProtectedRunIds()` must still protect active lane #207!
    const coordA = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });
    const protectedIds = coordA.getProtectedRunIds();
    expect(protectedIds.has('run-active-207')).toBe(true);
    expect(protectedIds.has('historical-run-1')).toBe(false);

    // 2. `refreshCacheFromStore()` must populate lane #207's isolated root despite 206 older removed lanes!
    await coordA.refreshCacheFromStore();
    expect(coordA.resolveExecutionRootSyncOrCached('run-active-207')).toBe(activeRoot);

    // 3. Another fresh coordinator (empty cache): `findLaneForRun()` finds BOTH active lane #207 and
    //    non-live completed lane #208 past page 1 via `nextCursor`!
    const coordB = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });
    expect(coordB.resolveLaneIdForRun('run-active-207')).toBe(activeLane.laneId);
    expect(await coordB.resolveExecutionRoot({ runId: 'run-active-207' })).toBe(activeRoot);
    expect(coordB.resolveLaneIdForRun('run-completed-208')).toBe(completedLane.laneId);

    // 4. >205 historical `canceled` requests on activeLane + 1 open `queued` request #206:
    //    `onRunPaused` paginates open requests and cancels request #206!
    fs.writeFileSync(path.join(activeRoot, 'src', 'a.txt'), 'paged-request-edit\n');
    const frozen = await h.service.freezeCandidate({ laneId: activeLane.laneId });
    if (!frozen.ok) throw new Error(`freeze failed: ${frozen.refusal.reason}`);
    const profileJson = JSON.stringify(PROFILE);
    for (let i = 1; i <= 205; i += 1) {
      const ts = new Date(HARNESS_NOW_MS - (300 - i) * 1_000).toISOString();
      h.integrations.insertRequest({
        requestId: hexId(20_000 + i),
        workspaceId: HARNESS_WS,
        repositoryId: activeLane.repositoryId,
        laneId: activeLane.laneId,
        candidateId: frozen.value.candidateId,
        candidateCommit: frozen.value.commit,
        targetRef: 'refs/heads/main',
        expectedTargetCommit: seedCommit,
        profileId: PROFILE.profileId,
        profileRevision: PROFILE.revision,
        profileDigest: 'd'.repeat(64),
        profileJson,
        state: 'canceled',
        reason: null,
        verificationAttempt: 0,
        ownerGeneration: h.service.generation,
        createdAt: ts,
        updatedAt: ts
      });
    }
    const openReq = await h.service.requestIntegration({
      laneId: activeLane.laneId,
      targetBranch: 'main',
      profile: PROFILE
    });
    if (!openReq.ok) throw new Error(`request failed: ${openReq.refusal.reason}`);

    coordB.onRunPaused(activeLane.laneId);
    expect(h.integrations.getRequest(HARNESS_WS, openReq.value.requestId)?.state).toBe('canceled');
    expect(h.lanes.getLane(HARNESS_WS, activeLane.laneId)?.state).toBe('paused');
  });
});

describe('FR-R8-01 (01-06) retryable isolated lane preservation on freeze failure', () => {
  it('keeps lane active with bounded freeze-failed reason on git-identity-missing refusal, survives reopen, retries exact file change, and completes once', async () => {
    const h = createLaneHarness({ label: 'coord-freeze-refusal' });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const bound = await coord.provisionForRun('run-distinctive-1');
    if (bound === null) throw new Error('expected lane binding');
    const laneRoot = await coord.resolveExecutionRoot({ runId: 'run-distinctive-1', laneId: bound.laneId });
    const distinctiveFile = path.join(laneRoot, 'src', 'distinctive-01-06.txt');
    fs.writeFileSync(distinctiveFile, 'distinctive-worktree-payload-01-06\n');

    // Break Git identity so freezeCandidate refuses `git-identity-missing`.
    h.fixture.git(['config', '--unset', 'user.email']);

    await coord.onRunTerminal({ runId: 'run-distinctive-1', laneId: bound.laneId, status: 'completed' });

    const afterFailure = h.service.getLane({ laneId: bound.laneId });
    expect(afterFailure.ok).toBe(true);
    if (!afterFailure.ok) throw new Error('expected lane');
    expect(afterFailure.value.state).toBe('active');
    expect(afterFailure.value.stateReason).toBe('freeze-failed:git-identity-missing');
    expect(afterFailure.value.currentCandidate).toBeNull();
    expect(fs.readFileSync(distinctiveFile, 'utf8')).toBe('distinctive-worktree-payload-01-06\n');
    expect(coord.getProtectedRunIds().has('run-distinctive-1')).toBe(true);

    // Cleanup protects the live retryable lane (`lane-live`).
    expect(await h.service.cleanupLanes({ laneIds: [bound.laneId] })).toEqual({
      ok: true,
      value: { removed: [], kept: [{ laneId: bound.laneId, observation: 'lane-live' }] }
    });

    // Reopen store under a new host generation: state, reason, and worktree survive intact.
    const host2 = h.reopen();
    const reopened = host2.getLane({ laneId: bound.laneId });
    expect(reopened.ok && reopened.value.state).toBe('active');
    expect(reopened.ok && reopened.value.stateReason).toBe('freeze-failed:git-identity-missing');
    expect(fs.readFileSync(distinctiveFile, 'utf8')).toBe('distinctive-worktree-payload-01-06\n');

    // Fix root cause and explicitly retry freeze -> captures exact distinctive file and clears stateReason.
    h.fixture.git(['config', 'user.email', 'operator@example.invalid']);
    const retried = await host2.freezeCandidate({ laneId: bound.laneId });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('expected retry freeze ok');
    expect(h.fixture.git(['show', `${retried.value.commit}:src/distinctive-01-06.txt`])).toBe(
      'distinctive-worktree-payload-01-06\n'
    );
    const afterRetry = host2.getLane({ laneId: bound.laneId });
    expect(afterRetry.ok && afterRetry.value.state).toBe('active');
    expect(afterRetry.ok && afterRetry.value.stateReason).toBeNull();
    expect(afterRetry.ok && afterRetry.value.currentCandidate?.commit).toBe(retried.value.commit);

    // Explicit completion succeeds once; duplicate completion refuses `lane-state-invalid`.
    const completed = host2.completeLane({ laneId: bound.laneId });
    expect(completed.ok && completed.value.state).toBe('completed');
    expect(completed.ok && completed.value.stateReason).toBeNull();
    expect(host2.completeLane({ laneId: bound.laneId })).toEqual({
      ok: false,
      refusal: { reason: 'lane-state-invalid' }
    });

    // Duplicate terminal notification on an already-completed lane is a clean no-op.
    const coord2 = createRunLaneCoordinator({
      getLaneService: () => host2,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });
    const freezeSpy = vi.spyOn(host2, 'freezeCandidate');
    const completeSpy = vi.spyOn(host2, 'completeLane');
    await coord2.onRunTerminal({ runId: 'run-distinctive-1', laneId: bound.laneId, status: 'completed' });
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('keeps lane active and retains prior candidate on thrown Git error, then retries after fix', async () => {
    let failCommitTreeOnce = true;
    const h = createLaneHarness({
      label: 'coord-freeze-git-throw',
      wrapGit: (real) => ({
        run: (args, opts) => {
          if (failCommitTreeOnce && args.at(0) === 'commit-tree') {
            failCommitTreeOnce = false;
            return Promise.resolve({ ok: false, code: 'exit', exitCode: 128 });
          }
          return real.run(args, opts);
        }
      })
    });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const bound = await coord.provisionForRun('run-git-throw');
    if (bound === null) throw new Error('expected lane binding');
    const laneRoot = await coord.resolveExecutionRoot({ runId: 'run-git-throw', laneId: bound.laneId });

    // Freeze candidate #1 before arming the fault.
    failCommitTreeOnce = false;
    fs.writeFileSync(path.join(laneRoot, 'src', 'a.txt'), 'prior-candidate-v1\n');
    const prior = await h.service.freezeCandidate({ laneId: bound.laneId });
    if (!prior.ok) throw new Error('expected prior freeze');

    // Make distinctive edit #2 and inject a thrown LaneGitError during onRunTerminal.
    fs.writeFileSync(path.join(laneRoot, 'src', 'second-edit.txt'), 'distinctive-after-git-fault\n');
    failCommitTreeOnce = true;

    await coord.onRunTerminal({ runId: 'run-git-throw', laneId: bound.laneId, status: 'completed' });

    const afterThrow = h.service.getLane({ laneId: bound.laneId });
    expect(afterThrow.ok).toBe(true);
    if (!afterThrow.ok) throw new Error('expected lane');
    expect(afterThrow.value.state).toBe('active');
    expect(afterThrow.value.stateReason).toBe('freeze-failed:git-commit-tree-exit');
    // Prior candidate and worktree edit both survive intact!
    expect(afterThrow.value.currentCandidate?.commit).toBe(prior.value.commit);
    expect(fs.readFileSync(path.join(laneRoot, 'src', 'second-edit.txt'), 'utf8')).toBe(
      'distinctive-after-git-fault\n'
    );

    // Reopen and retry freeze -> freezes candidate #2 and clears stateReason.
    const host2 = h.reopen();
    const retried = await host2.freezeCandidate({ laneId: bound.laneId });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('expected retry ok');
    expect(retried.value.seq).toBe(2);
    expect(h.fixture.git(['show', `${retried.value.commit}:src/second-edit.txt`])).toBe(
      'distinctive-after-git-fault\n'
    );
    expect(host2.getLane({ laneId: bound.laneId })).toMatchObject({
      ok: true,
      value: { state: 'active', stateReason: null }
    });
  });

  it('keeps lane active when freezeCandidate throws a storage error (even if recording failure also throws)', async () => {
    const h = createLaneHarness({ label: 'coord-freeze-storage-throw' });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const bound = await coord.provisionForRun('run-storage-throw');
    if (bound === null) throw new Error('expected lane binding');
    const laneRoot = await coord.resolveExecutionRoot({ runId: 'run-storage-throw', laneId: bound.laneId });
    fs.writeFileSync(path.join(laneRoot, 'src', 'a.txt'), 'storage-fault-edit\n');

    // 1. freezeCandidate throws a storage error; recordFreezeFailure succeeds.
    const sqliteErr = Object.assign(new Error('SQLITE_BUSY at /secret/abs/path'), {
      name: 'SqliteError',
      code: 'SQLITE_BUSY'
    });
    const freezeSpy = vi.spyOn(h.service, 'freezeCandidate').mockRejectedValueOnce(sqliteErr);
    await coord.onRunTerminal({ runId: 'run-storage-throw', laneId: bound.laneId, status: 'completed' });
    freezeSpy.mockRestore();

    const afterStorageErr = h.service.getLane({ laneId: bound.laneId });
    expect(afterStorageErr.ok).toBe(true);
    if (!afterStorageErr.ok) throw new Error('expected lane');
    expect(afterStorageErr.value.state).toBe('active');
    expect(afterStorageErr.value.stateReason).toBe('freeze-failed:storage-sqlite_busy');
    expect(afterStorageErr.value.stateReason).not.toContain('/secret');

    // 2. Both freezeCandidate and recordFreezeFailure throw -> onRunTerminal still does NOT close the lane!
    const freezeSpy2 = vi
      .spyOn(h.service, 'freezeCandidate')
      .mockRejectedValueOnce(new LaneGitError('write-tree', { code: 'timeout', exitCode: null }));
    const recordSpy = vi.spyOn(h.service, 'recordFreezeFailure').mockImplementationOnce(() => {
      throw new Error('storage down');
    });
    const completeSpy = vi.spyOn(h.service, 'completeLane');

    await coord.onRunTerminal({ runId: 'run-storage-throw', laneId: bound.laneId, status: 'completed' });
    freezeSpy2.mockRestore();
    recordSpy.mockRestore();
    expect(completeSpy).not.toHaveBeenCalled();
    expect(h.service.getLane({ laneId: bound.laneId })).toMatchObject({
      ok: true,
      value: { state: 'active' }
    });
  });

  it('completes cleanly on candidate-empty and reopens pre-change schema-v9 lanes without issues', async () => {
    const h = createLaneHarness({ label: 'coord-empty-and-prechange' });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    // Clean lane with zero changes (`candidate-empty`) completes normally.
    const emptyBound = await coord.provisionForRun('run-empty');
    if (emptyBound === null) throw new Error('expected lane binding');
    await coord.onRunTerminal({ runId: 'run-empty', laneId: emptyBound.laneId, status: 'completed' });
    expect(h.service.getLane({ laneId: emptyBound.laneId })).toMatchObject({
      ok: true,
      value: { state: 'completed', stateReason: null, currentCandidate: null }
    });

    // Pre-change schema-v9 lane row (`state_reason = NULL`) reopens cleanly under a new host.
    const preChangeLaneId = hexId(90_001);
    const seedCommit = h.fixture.head();
    const ts = new Date(HARNESS_NOW_MS - 60_000).toISOString();
    h.lanes.insertLane({
      laneId: preChangeLaneId,
      workspaceId: HARNESS_WS,
      repositoryId: 'b'.repeat(64),
      rootExecutionId: 'run-prechange-completed',
      sourceCommit: seedCommit,
      baseRef: laneBaseRef(preChangeLaneId),
      candidateRef: laneCandidateRef(preChangeLaneId),
      rootRef: laneRootRef(HARNESS_WS, preChangeLaneId),
      dependencyRecipe: 'none',
      state: 'completed',
      stateReason: null,
      pinned: false,
      ownerGeneration: 1,
      createdAt: ts,
      updatedAt: ts
    });

    const host2 = h.reopen();
    const loaded = host2.getLane({ laneId: preChangeLaneId });
    expect(loaded.ok && loaded.value.state).toBe('completed');
    expect(loaded.ok && loaded.value.stateReason).toBeNull();
    const coord2 = createRunLaneCoordinator({
      getLaneService: () => host2,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });
    await coord2.onRunTerminal({
      runId: 'run-prechange-completed',
      laneId: preChangeLaneId,
      status: 'completed'
    });
    expect(host2.getLane({ laneId: preChangeLaneId })).toMatchObject({
      ok: true,
      value: { state: 'completed', stateReason: null }
    });
  });
});
