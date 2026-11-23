// FR-R6-F10 (`SR-B3`): RunLaneCoordinator pagination past 200 historical terminal lanes/requests.
//
// WHAT THIS PINS:
//   - >205 historical `removed` lanes never crowd out lane #206+ in `getProtectedRunIds()`,
//     `refreshCacheFromStore()`, or `findLaneForRun()` (`resolveLaneIdForRun` /
//     `resolveExecutionRoot` / `onRunTerminal`);
//   - >205 historical terminal requests never crowd out an open cancelable request on `onRunPaused`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerificationProfile } from '../../../src/contracts/execution-lanes';
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
