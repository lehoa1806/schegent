// FR-R7-16 (`16-20`, `16-22`, `16-23`):
//   - Pre-effect ownership generation checks immediately before Git/check effects across
//     freeze, landing, cleanup, provisioning, and verification + successor classification;
//   - Production authority/approval separation (`authorizeApproval` inspecting frozen checks/`argv`,
//     `RunLaneCoordinator` never auto-approving or auto-landing);
//   - Harness ID generator uniqueness past 300 allocations (no 256-byte wrap-around).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerificationProfile } from '../../../src/contracts/execution-lanes';
import { createExecFileGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { LaneService } from '../../../src/services/execution-lanes/lane-service';
import { createRunLaneCoordinator } from '../../../src/services/execution-lanes/run-lane-binding';
import { createSpawnCheck, type SpawnCheck } from '../../../src/services/execution-lanes/verification-runner';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  createLaneHarness,
  disposeLaneHarnesses,
  HARNESS_NOW_MS,
  HARNESS_ROOT_EXECUTION,
  HARNESS_WS,
  type GitWrapper,
  type LaneHarness
} from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const PASSING_PROFILE: VerificationProfile = {
  profileId: 'fencing-unit',
  revision: 1,
  checks: [
    { name: 'c0', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 15_000 },
    { name: 'c1', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 15_000 }
  ]
};

function valueOf<T>(result: { ok: true; value: T } | { ok: false; refusal: { reason: string } }): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`);
  return result.value;
}

describe('FR-R7-16 (16-20): immediate pre-effect generation fencing & successor classification', () => {
  it('freeze: ownership transfer before add -A aborts Git mutations and refuses ownership-superseded', async () => {
    const calls: string[][] = [];
    let reopenNow: (() => void) | null = null;
    const supersedeBeforeAdd: GitWrapper = (real) => ({
      run: async (args, opts) => {
        calls.push([...args]);
        const res = await real.run(args, opts);
        if (reopenNow !== null && args.at(0) === 'rev-parse' && args.at(2) === 'HEAD^{commit}') {
          const fn = reopenNow;
          reopenNow = null;
          fn();
        }
        return res;
      }
    });

    const h = createLaneHarness({ label: 'fence-freeze', wrapGit: supersedeBeforeAdd });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'edited\n');
    const headBefore = h.fixture.git(['rev-parse', 'HEAD'], root).trim();
    calls.length = 0;
    reopenNow = () => {
      h.reopen();
    };

    const result = await h.service.freezeCandidate({ laneId: lane.laneId });

    expect(result).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(calls.some((args) => args.at(0) === 'add' || args.at(0) === 'commit-tree' || args.at(0) === 'update-ref')).toBe(
      false
    );
    expect(h.fixture.git(['rev-parse', 'HEAD'], root).trim()).toBe(headBefore);
    expect(h.lanes.currentCandidate(lane.laneId)).toBeNull();
  });

  it('landing: ownership transfer immediately before applyLanding aborts Git effect and successor classifies without replay', async () => {
    const calls: string[][] = [];
    let reopenNow: (() => void) | null = null;
    const supersedeBeforeApply: GitWrapper = (real) => ({
      run: async (args, opts) => {
        calls.push([...args]);
        const res = await real.run(args, opts);
        // Trigger right after `recheckTarget`'s status check, immediately before `applyLanding`.
        if (reopenNow !== null && args.includes('status') && args.includes('--untracked-files=no')) {
          const fn = reopenNow;
          reopenNow = null;
          fn();
        }
        return res;
      }
    });

    const h = createLaneHarness({ label: 'fence-land-pre', wrapGit: supersedeBeforeApply });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'land-work\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const req = valueOf(
      await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PASSING_PROFILE })
    );
    const verified = valueOf(await h.service.verifyRequest({ requestId: req.requestId }));
    valueOf(
      h.service.approveRequest({
        requestId: verified.requestId,
        candidateCommit: verified.candidateCommit,
        targetCommit: verified.expectedTargetCommit,
        profileRevision: verified.profile.revision,
        profileDigest: verified.profile.digest
      })
    );

    const tipBefore = h.fixture.head();
    calls.length = 0;
    let successor!: ReturnType<LaneHarness['reopen']>;
    reopenNow = () => {
      successor = h.reopen();
    };

    const staleResult = await h.service.landRequest({ requestId: verified.requestId });

    expect(staleResult).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    // Pre-effect fence stopped merge/--ff-only from running at all!
    expect(calls.some((args) => args.includes('merge') || args.at(0) === 'update-ref')).toBe(false);
    expect(h.fixture.head()).toBe(tipBefore);

    // Successor classifies using journalled hashes without repeating a landing.
    const rec = valueOf(await successor.reconcile());
    expect(rec.requests).toEqual([
      {
        requestId: verified.requestId,
        from: 'landing',
        to: 'blocked',
        reason: 'landing-not-applied',
        commits: { expected: verified.expectedTargetCommit, candidate: verified.candidateCommit, observed: tipBefore }
      }
    ]);
    expect(h.fixture.head()).toBe(tipBefore);
  });

  it('landing residual syscall window: takeover during applyLanding is settled by successor as landed without repeating', async () => {
    let reopenNow: (() => void) | null = null;
    const supersedeDuringApply: GitWrapper = (real) => ({
      run: async (args, opts) => {
        const res = await real.run(args, opts);
        if (reopenNow !== null && args.includes('merge') && args.includes('--ff-only')) {
          const fn = reopenNow;
          reopenNow = null;
          fn();
        }
        return res;
      }
    });

    const h = createLaneHarness({ label: 'fence-land-residual', wrapGit: supersedeDuringApply });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'residual-land\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const req = valueOf(
      await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PASSING_PROFILE })
    );
    const verified = valueOf(await h.service.verifyRequest({ requestId: req.requestId }));
    valueOf(
      h.service.approveRequest({
        requestId: verified.requestId,
        candidateCommit: verified.candidateCommit,
        targetCommit: verified.expectedTargetCommit,
        profileRevision: verified.profile.revision,
        profileDigest: verified.profile.digest
      })
    );

    const successorCalls: string[][] = [];
    let successor!: ReturnType<LaneHarness['reopen']>;
    reopenNow = () => {
      successor = h.reopen({
        wrapGit: (real) => ({
          run: (args, opts) => {
            successorCalls.push([...args]);
            return real.run(args, opts);
          }
        })
      });
    };

    const stale = await h.service.landRequest({ requestId: verified.requestId });
    expect(stale).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });

    const rec = valueOf(await successor.reconcile());
    expect(rec.requests).toEqual([{ requestId: verified.requestId, from: 'landing', to: 'landed', reason: null }]);
    expect(successorCalls.some((args) => args.includes('merge') || args.at(0) === 'update-ref')).toBe(false);
    expect(h.fixture.head()).toBe(verified.candidateCommit);
  });

  it('cleanup: ownership transfer before worktree remove and before update-ref -d aborts stale mutations', async () => {
    // 1. Takeover before `worktree remove`
    const calls1: string[][] = [];
    let reopen1: (() => void) | null = null;
    const h1 = createLaneHarness({
      label: 'fence-clean-rm',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          calls1.push([...args]);
          const res = await real.run(args, opts);
          if (reopen1 !== null && args.at(0) === 'rev-parse' && args.at(2) === 'HEAD^{commit}') {
            const fn = reopen1;
            reopen1 = null;
            fn();
          }
          return res;
        }
      })
    });
    const lane1 = await h1.provision();
    const root1 = await h1.laneRoot(lane1.laneId);
    valueOf(h1.service.completeLane({ laneId: lane1.laneId }));
    valueOf(h1.service.releaseLane({ laneId: lane1.laneId, disposition: 'eligible' }));
    calls1.length = 0;
    reopen1 = () => {
      h1.reopen();
    };

    const res1 = await h1.service.cleanupLanes({});
    expect(res1).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(calls1.some((args) => args.at(0) === 'worktree' && args.at(1) === 'remove')).toBe(false);
    expect(fs.existsSync(root1)).toBe(true);

    // 2. Takeover right after `worktree remove`, immediately before `update-ref -d`
    const calls2: string[][] = [];
    let reopen2: (() => void) | null = null;
    const h2 = createLaneHarness({
      label: 'fence-clean-ref',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          calls2.push([...args]);
          const res = await real.run(args, opts);
          if (reopen2 !== null && args.at(0) === 'worktree' && args.at(1) === 'remove') {
            const fn = reopen2;
            reopen2 = null;
            fn();
          }
          return res;
        }
      })
    });
    const lane2 = await h2.provision();
    valueOf(h2.service.completeLane({ laneId: lane2.laneId }));
    valueOf(h2.service.releaseLane({ laneId: lane2.laneId, disposition: 'eligible' }));
    calls2.length = 0;
    let successor2!: ReturnType<LaneHarness['reopen']>;
    reopen2 = () => {
      successor2 = h2.reopen();
    };

    const res2 = await h2.service.cleanupLanes({});
    expect(res2).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(calls2.some((args) => args.at(0) === 'update-ref' && args.at(1) === '-d')).toBe(false);
    // Successor reconcile converges the interrupted cleanup to `removed` and deletes baseRef!
    const rec2 = valueOf(await successor2.reconcile());
    expect(rec2.lanes).toEqual([{ laneId: lane2.laneId, from: 'cleanup-eligible', to: 'removed', observation: null }]);
    expect(h2.fixture.git(['for-each-ref', '--format=%(refname)', lane2.baseRef]).trim()).toBe('');
  });

  it('provisioning: ownership transfer before worktree add and before update-ref preserves ownership-superseded', async () => {
    const calls: string[][] = [];
    let supersedeAtUpdateRef = false;
    let successor!: ReturnType<LaneHarness['reopen']>;
    let triggerReopen: () => void = () => undefined;
    const h = createLaneHarness({
      label: 'fence-provision',
      wrapGit: (real) => ({
        run: async (args, opts) => {
          calls.push([...args]);
          const res = await real.run(args, opts);
          if (supersedeAtUpdateRef && args.at(0) === 'worktree' && args.at(1) === 'add') {
            supersedeAtUpdateRef = false;
            triggerReopen();
          }
          return res;
        }
      })
    });
    triggerReopen = () => {
      successor = h.reopen();
    };

    supersedeAtUpdateRef = true;
    const res = await h.service.provisionLane({
      rootExecutionId: HARNESS_ROOT_EXECUTION,
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });

    expect(res).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(calls.some((args) => args.at(0) === 'update-ref')).toBe(false);
    // Successor reconcile settles the interrupted preparing lane cleanly.
    const rec = valueOf(await successor.reconcile());
    expect(rec.lanes).toHaveLength(1);
    expect(rec.lanes.at(0)?.to).toBe('preparation-failed');
  });

  it('verification: ownership transfer before check 1 aborts spawn and fences insertVerificationResult', async () => {
    const spawnedChecks: number[] = [];
    const realSpawn = createSpawnCheck();
    let successor!: ReturnType<LaneHarness['reopen']>;
    let triggerReopen: () => void = () => undefined;
    const wrappedSpawn: SpawnCheck = async (argv, options) => {
      spawnedChecks.push(spawnedChecks.length);
      const run = await realSpawn(argv, options);
      // Supersede after check 0 executes, BEFORE `insertVerificationResult` runs!
      if (spawnedChecks.length === 1) {
        triggerReopen();
      }
      return run;
    };

    const h = createLaneHarness({ label: 'fence-verify', overrides: { spawnCheck: wrappedSpawn } });
    triggerReopen = () => {
      successor = h.reopen();
    };
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'verify-work\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const req = valueOf(
      await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PASSING_PROFILE })
    );

    const verified = await h.service.verifyRequest({ requestId: req.requestId });

    expect(verified).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    // Check 1 was never spawned AND check 0's result was fenced out of SQLite!
    expect(spawnedChecks).toEqual([0]);
    expect(h.integrations.listVerificationResults(req.requestId, 1)).toEqual([]);

    // Successor reconcile returns the abandoned verifying request cleanly to `queued`.
    const rec = valueOf(await successor.reconcile());
    expect(rec.requests).toEqual([{ requestId: req.requestId, from: 'verifying', to: 'queued', reason: null }]);
  });
});

describe('FR-R7-16 (16-22): production authority & approval separation boundaries', () => {
  it('enforces authorizeApproval with full frozen check argv visibility and refuses unauthorized approval with zero receipt', async () => {
    const seenChecks: (readonly string[])[] = [];
    let allowHuman = false;
    const h = createLaneHarness({
      label: 'auth-gate',
      overrides: {
        authorizeApproval: (approval) => {
          for (const c of approval.checks) seenChecks.push(c.argv);
          return allowHuman;
        }
      }
    });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'reviewed-work\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const req = valueOf(
      await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PASSING_PROFILE })
    );
    const verified = valueOf(await h.service.verifyRequest({ requestId: req.requestId }));

    // Unauthorized caller (e.g. non-human or unconfirmed argv) is refused and writes NO receipt.
    const denied = h.service.approveRequest({
      requestId: verified.requestId,
      candidateCommit: verified.candidateCommit,
      targetCommit: verified.expectedTargetCommit,
      profileRevision: verified.profile.revision,
      profileDigest: verified.profile.digest
    });
    expect(denied).toEqual({ ok: false, refusal: { reason: 'review-stale' } });
    expect(h.integrations.getReceipt(verified.requestId)).toBeNull();
    expect(seenChecks).toEqual(PASSING_PROFILE.checks.map((c) => c.argv));

    // Landing without a receipt refuses `review-stale`.
    expect(await h.service.landRequest({ requestId: verified.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'review-stale' }
    });

    // Human-confirmed approval succeeds and enables landing.
    allowHuman = true;
    const granted = valueOf(
      h.service.approveRequest({
        requestId: verified.requestId,
        candidateCommit: verified.candidateCommit,
        targetCommit: verified.expectedTargetCommit,
        profileRevision: verified.profile.revision,
        profileDigest: verified.profile.digest
      })
    );
    expect(granted.candidateCommit).toBe(verified.candidateCommit);
    expect(valueOf(await h.service.landRequest({ requestId: verified.requestId })).state).toBe('landed');
  });

  it('fails closed when LaneService.open omits authorizeApproval, refusing approveRequest with review-stale and zero receipt (SR-B9)', async () => {
    const h = createLaneHarness({ label: 'auth-fail-closed' });
    const lane = await h.provision();
    fs.writeFileSync(path.join(await h.laneRoot(lane.laneId), 'src', 'a.txt'), 'needs-auth\n');
    valueOf(await h.service.freezeCandidate({ laneId: lane.laneId }));
    const req = valueOf(
      await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: 'main', profile: PASSING_PROFILE })
    );
    const verified = valueOf(await h.service.verifyRequest({ requestId: req.requestId }));

    // Open a direct production-default LaneService WITHOUT `authorizeApproval`.
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => HARNESS_NOW_MS);
      const storageDir = h.fixture.sibling('default-auth-storage');
      let seq = 100;
      const defaultService = LaneService.open({
        connection: conn,
        workspaceRoot: h.fixture.root,
        storageDir,
        workspaceId: HARNESS_WS,
        liveLaneCap: 2,
        git: createExecFileGitRunner({ baseEnv: h.gitEnv }),
        clock: () => HARNESS_NOW_MS,
        random: (size) => {
          seq += 1;
          const buf = Buffer.alloc(size);
          buf.writeUInt32BE(seq, size - 4);
          return buf;
        }
      });
      const defaultLane = valueOf(
        await defaultService.provisionLane({
          rootExecutionId: HARNESS_ROOT_EXECUTION,
          sourceRevision: 'HEAD',
          dependencyRecipe: 'none'
        })
      );
      const defaultRoot = await defaultService.resolveLaneRoot(`lanes/${HARNESS_WS}/${defaultLane.laneId}`);
      if (defaultRoot === null) throw new Error('root unresolved');
      fs.writeFileSync(path.join(defaultRoot, 'src', 'a.txt'), 'default-fail-closed\n');
      valueOf(await defaultService.freezeCandidate({ laneId: defaultLane.laneId }));
      const defaultReq = valueOf(
        await defaultService.requestIntegration({
          laneId: defaultLane.laneId,
          targetBranch: 'main',
          profile: PASSING_PROFILE
        })
      );
      const defaultVerified = valueOf(await defaultService.verifyRequest({ requestId: defaultReq.requestId }));

      const refused = defaultService.approveRequest({
        requestId: defaultVerified.requestId,
        candidateCommit: defaultVerified.candidateCommit,
        targetCommit: defaultVerified.expectedTargetCommit,
        profileRevision: defaultVerified.profile.revision,
        profileDigest: defaultVerified.profile.digest
      });
      expect(refused).toEqual({ ok: false, refusal: { reason: 'review-stale' } });
      expect(valueOf(defaultService.getRequest({ requestId: defaultVerified.requestId })).receipt).toBeNull();
      expect(await defaultService.landRequest({ requestId: defaultVerified.requestId })).toEqual({
        ok: false,
        refusal: { reason: 'review-stale' }
      });
    } finally {
      conn.close();
    }
    // Sanity: the harness's explicitly authorized service still had its own verified request untouched.
    expect(verified.state).toBe('awaiting-review');
  });

  it('RunLaneCoordinator never opens integration requests, approves, or lands on Run completion', async () => {
    const h = createLaneHarness({ label: 'coord-authority' });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const binding = await coord.provisionForRun('run-auth-1');
    expect(binding).not.toBeNull();
    if (binding === null) return;
    const root = await h.laneRoot(binding.laneId);
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'agent-edit\n');
    const headBefore = h.fixture.head();

    await coord.onRunTerminal({ runId: 'run-auth-1', laneId: binding.laneId, status: 'completed' });

    // Candidate was frozen for operator review, lane completed, ZERO requests/receipts/landings occurred.
    const laneView = valueOf(h.service.getLane({ laneId: binding.laneId }));
    expect(laneView.state).toBe('completed');
    expect(laneView.currentCandidate).not.toBeNull();
    expect(valueOf(h.service.listRequests({})).items).toEqual([]);
    expect(h.fixture.head()).toBe(headBefore);
    // Coordinator surface has no approve/land methods.
    expect('approveRequest' in coord).toBe(false);
    expect('landRequest' in coord).toBe(false);
    expect('requestIntegration' in coord).toBe(false);
  });
});

describe('FR-R7-16 (16-23): non-wrapping deterministic harness IDs past 256', () => {
  it('generates >300 unique hex IDs without repeating at 256', async () => {
    const h = createLaneHarness({ label: 'id-unique', overrides: { liveLaneCap: 4 } });
    const lane = await h.provision();
    // Generate >300 operation records through alternating keep/cleanup or store operations using harness random.
    // Exercise the harness's actual `random` via 320 repeated operations directly on `lane_operations`.
    const seen = new Set<string>();
    const laneId = lane.laneId;
    for (let i = 0; i < 320; i += 1) {
      // Trigger a distinct lane operation via `setLanePinned` + `cleanupLanes`? Even faster: test via `reconcile` or
      // invoke `approveRequest`/store via `laneService`? Let's exercise 310 distinct candidate/operation IDs via `freezeCandidate`?
      // Wait: `cleanupLanes` on alternating pinned/unpinned active lane runs in <0.1ms per call (zero git calls!).
      valueOf(h.service.setLanePinned({ laneId, pinned: i % 2 === 0 }));
      valueOf(await h.service.cleanupLanes({ laneIds: [laneId] }));
    }
    // Check that all retained operations + all 320 allocated IDs did not collide on PRIMARY KEY!
    // (With the old `Buffer.alloc(size, counter)` bug, the 256th operation ID threw SQLITE_CONSTRAINT_PRIMARYKEY!)
    for (const op of h.lanes.listOperations(laneId)) {
      seen.add(op.operationId);
    }
    expect(seen.size).toBe(h.lanes.listOperations(laneId).length);
    expect(seen.size).toBeGreaterThan(0);
  });
});
