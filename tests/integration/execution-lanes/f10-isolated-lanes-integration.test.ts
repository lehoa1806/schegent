/**
 * FR-R6-F10 end-to-end integration qualification across:
 *   - F10-AC-01: Provisioning gate & zero shared-tree fallback (RunLaneCoordinator + WorkflowRunFactory)
 *   - F10-AC-02: Concurrent same-file edits across isolated lanes + rootExecutionId reuse + RunCheckpointService sole-run capture
 *   - F10-AC-03: Durable primary-workspace evidence survival across lane release & cleanup
 *   - F10-AC-04: Reviewed fast-forward landing + target-advanced / dirty / diverged refusals
 *   - F10-AC-05: Restart & crash reconciliation preserving unknown worktrees
 *   - F10-AC-06: NestedRepoSyncCoordinator local transactional sync & compensating rollback
 *   - F10-AC-07: Headless execution-lanes-api bounded pagination & cancel isolation
 *   - F10-AC-08: SQLite + AcpBackedRunner session-root binding & missing upstream artifact refusal
 */

import * as fs from 'node:fs';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import type { VerificationProfile } from '../../../src/contracts/execution-lanes';
import * as lanesApi from '../../../src/headless/execution-lanes-api';
import type { SanitizedLogger } from '../../../src/lib/logger';
import { AcpBackedRunner } from '../../../src/runner/acp-backed-runner';
import { AcpAuthorityGate } from '../../../src/services/containment-qualification/acp-authority-gate';
import {
  createExecFileGitRunner,
  createRunLaneCoordinator,
  IsolatedLaneProvisionRefusedError
} from '../../../src/services/execution-lanes';
import { NestedRepoSyncCoordinator } from '../../../src/services/nested-repo-sync/nested-repo-sync';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { RUN_CHECKPOINT_DIRECTORY } from '../../../src/services/run-checkpoint-paths';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { createFixtureRepo, type FixtureRepo } from '../../unit/execution-lanes/fixture-repo';
import { createLaneHarness, disposeLaneHarnesses } from '../../unit/execution-lanes/lane-harness';

const extraFixtures: FixtureRepo[] = [];
const extraConnections: NodeSqliteConnection[] = [];
const extraTempDirs: string[] = [];

afterEach(() => {
  disposeLaneHarnesses();
  for (const conn of extraConnections.splice(0, extraConnections.length)) {
    conn.close();
  }
  for (const fix of extraFixtures.splice(0, extraFixtures.length)) {
    fix.dispose();
  }
  for (const dir of extraTempDirs.splice(0, extraTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PASSING_PROFILE: VerificationProfile = {
  profileId: 'f10-verify',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 15_000 }]
};

function makeSilentLogger(): SanitizedLogger {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    sanitize: (s: string) => s,
    withContext: () => logger
  };
  return logger as unknown as SanitizedLogger;
}

function makeDummyInnerRunner(): BackendRunner {
  return {
    hasActiveProcess: false,
    async invoke() {
      throw new Error('Legacy CLI fallback must never execute');
    },
    cancelActive() {
      return false;
    },
    close() {},
    async settleTeardowns() {
      return [];
    }
  };
}

describe('FR-R6-F10 Isolated Workspaces Integration (F10-AC-01..F10-AC-08)', () => {
  it('F10-AC-01: refuses unsupported submodule topology and live-cap exhaustion before Run admission without shared-tree fallback', async () => {
    const h = createLaneHarness({ label: 'ac01', overrides: { liveLaneCap: 1 } });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const factory = new WorkflowRunFactory({
      getCatalog: () => ({
        models: { claude: [], codex: [], agy: [] },
        defaultPipelineId: 'default',
        pipelines: [],
        pipelinesById: new Map([
          [
            'default',
            {
              id: 'default',
              name: 'Default',
              phases: ['impl']
            }
          ]
        ]),
        phases: [],
        phasesById: new Map([
          [
            'impl',
            {
              id: 'impl',
              name: 'Implement',
              instruction: 'Edit src/a.txt',
              sideEffects: 'none' as const
            }
          ]
        ])
      }),
      provisionRunLane: (rootExecId, aliasId) => coord.provisionForRun(rootExecId, aliasId),
      logger: makeSilentLogger()
    });

    // Admit 1st Run under liveLaneCap = 1: succeeds and binds opaque laneId/laneRootRef (never raw paths).
    const firstRun = await factory.create(
      {
        id: 'req-1',
        description: 'First isolated run',
        enqueuedAt: 1_000,
        status: 'in-flight'
      } as unknown as FeatureRequest,
      null,
      'default'
    );
    expect(firstRun.laneId).toMatch(/^[0-9a-f]{32}$/);
    expect(firstRun.laneRootRef).toBe(`lanes/workspace-a/${firstRun.laneId}`);
    expect(firstRun.laneRootRef?.startsWith('/')).toBe(false);

    // 2nd concurrent Run hits live-cap refusal before Run creation — never falls back to primary workspace!
    await expect(
      factory.create(
        {
          id: 'req-2',
          description: 'Second run over cap',
          enqueuedAt: 1_001,
          status: 'in-flight'
        } as unknown as FeatureRequest,
        null,
        'default'
      )
    ).rejects.toThrow(IsolatedLaneProvisionRefusedError);

    // Unsupported submodule gitlink topology refuses before admission as well.
    const hSub = createLaneHarness({ label: 'ac01-sub', overrides: { liveLaneCap: 2 } });
    hSub.fixture.addGitlink('vendor/sub', hSub.fixture.head());
    const subCoord = createRunLaneCoordinator({
      getLaneService: () => hSub.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: hSub.fixture.root
    });
    await expect(subCoord.provisionForRun('sub-run-1')).rejects.toMatchObject({
      name: 'IsolatedLaneProvisionRefusedError',
      refusalReason: 'submodules-unsupported'
    });
  });

  it('F10-AC-02: isolates concurrent same-file edits across two lanes, reuses rootExecutionId across nested/retry attempts, and captures sole-run checkpoints per lane', async () => {
    const h = createLaneHarness({ label: 'ac02', overrides: { liveLaneCap: 4 } });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const b1 = await coord.provisionForRun('wf-root-alpha', 'child-attempt-1');
    const b2 = await coord.provisionForRun('wf-root-bravo', 'bravo-attempt-1');
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b1?.laneId).not.toBe(b2?.laneId);

    // Second phase / retry attempt under the same rootExecutionId reuses the exact same lane!
    const b1Reuse = await coord.provisionForRun('wf-root-alpha', 'child-attempt-2');
    expect(b1Reuse?.laneId).toBe(b1?.laneId);

    const root1 = await coord.resolveExecutionRoot({
      runId: 'child-attempt-2',
      laneId: b1?.laneId,
      laneRootRef: b1?.laneRootRef
    });
    const root2 = await coord.resolveExecutionRoot({
      runId: 'bravo-attempt-1',
      laneId: b2?.laneId,
      laneRootRef: b2?.laneRootRef
    });
    expect(root1).not.toBe(root2);
    expect(root1).not.toBe(h.fixture.root);

    // Concurrent conflicting edits to the SAME file `src/a.txt` in each lane:
    fs.writeFileSync(path.join(root1, 'src', 'a.txt'), 'alpha-lane-edit\n', 'utf8');
    fs.writeFileSync(path.join(root2, 'src', 'a.txt'), 'bravo-lane-edit\n', 'utf8');

    // Primary checkout remains completely untouched!
    expect(fs.readFileSync(path.join(h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');

    // RunCheckpointService captures per-lane whole-tree diff via sole-run mode even while 2 runs are in flight!
    const cpStorage = h.fixture.sibling('checkpoints');
    const ledger = new RunMutationLedger({
      readDiff: async () => '',
      listInFlightRunIds: () => ['child-attempt-2', 'bravo-attempt-1'],
      workspaceRoot: h.fixture.root
    });
    const checkpoints = new RunCheckpointService(
      cpStorage,
      h.fixture.root,
      makeSilentLogger(),
      () => 2,
      ledger,
      undefined,
      (r) =>
        coord.resolveExecutionRoot({
          runId: r.id,
          laneId: r.laneId,
          laneRootRef: r.laneRootRef
        })
    );

    const stubRun1 = {
      id: 'child-attempt-2',
      featureId: 'f-1',
      featureDir: '',
      laneId: b1?.laneId,
      laneRootRef: b1?.laneRootRef,
      status: 'running',
      currentPhase: 'impl',
      currentIteration: 0,
      startedAt: 1,
      lastTransitionAt: 1,
      phasesCompleted: [],
      lastError: null
    } as unknown as WorkflowRun;

    await checkpoints.checkpoint(stubRun1, 'impl');
    const cpRunDir = path.join(cpStorage, RUN_CHECKPOINT_DIRECTORY, 'child-attempt-2');
    const cpFiles = fs.readdirSync(cpRunDir);
    const patchFile = cpFiles.find((f) => f.endsWith('.patch'));
    expect(patchFile).toBeDefined();
    const patchText = fs.readFileSync(path.join(cpRunDir, patchFile ?? ''), 'utf8');
    expect(patchText).toContain('+alpha-lane-edit');
    expect(patchText).not.toContain('bravo-lane-edit');
  });

  it('F10-AC-03: keeps durable transcripts/diagnostics in primary workspace storage and preserves them after lane cleanup', async () => {
    const h = createLaneHarness({ label: 'ac03' });
    const coord = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const binding = await coord.provisionForRun('run-evidence-1');
    expect(binding).not.toBeNull();
    const laneId = binding?.laneId ?? '';
    const laneRoot = await coord.resolveExecutionRoot({
      runId: 'run-evidence-1',
      laneId,
      laneRootRef: binding?.laneRootRef
    });

    // Write durable evidence in primary workspace `.schegent/transcripts` (as RunDriver routes evidenceRoot = primaryWorkspaceRoot).
    const transcriptDir = path.join(h.fixture.root, '.schegent', 'transcripts', 'run-evidence-1');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, 'phase-1.ndjson');
    fs.writeFileSync(transcriptFile, '{"seq":1,"kind":"turn_end"}\n', 'utf8');

    // Pinning protects the run from premature retention sweep; unpinning + completing + releasing allows cleanup.
    expect(coord.getProtectedRunIds().has('run-evidence-1')).toBe(true);
    await coord.onRunTerminal({ runId: 'run-evidence-1', laneId, status: 'canceled' });
    const rel = h.service.releaseLane({ laneId, disposition: 'eligible' });
    expect(rel.ok).toBe(true);

    const cleaned = await h.service.cleanupLanes({ laneIds: [laneId] });
    expect(cleaned.ok).toBe(true);
    if (cleaned.ok) {
      expect(cleaned.value.removed).toContain(laneId);
    }
    expect(fs.existsSync(laneRoot)).toBe(false);
    // Primary workspace evidence survives lane worktree removal intact!
    expect(fs.readFileSync(transcriptFile, 'utf8')).toContain('"turn_end"');
  });

  it('F10-AC-04: lands verified & reviewed candidate by fast-forward, and refuses target advance, dirty target, and divergence', async () => {
    const h = createLaneHarness({ label: 'ac04', overrides: { liveLaneCap: 4 } });

    // Helper to freeze + verify + approve a candidate on main
    const prepareApproved = async (execId: string, content: string) => {
      const prov = await h.service.provisionLane({
        rootExecutionId: execId,
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      if (!prov.ok) throw new Error(prov.refusal.reason);
      const lRoot = await h.laneRoot(prov.value.laneId);
      fs.writeFileSync(path.join(lRoot, 'src', 'a.txt'), content, 'utf8');
      const frz = await h.service.freezeCandidate({ laneId: prov.value.laneId });
      if (!frz.ok) throw new Error(frz.refusal.reason);
      const req = await h.service.requestIntegration({
        laneId: prov.value.laneId,
        targetBranch: 'main',
        profile: PASSING_PROFILE
      });
      if (!req.ok) throw new Error(req.refusal.reason);
      const ver = await h.service.verifyRequest({ requestId: req.value.requestId });
      if (!ver.ok) throw new Error(ver.refusal.reason);
      const app = h.service.approveRequest({
        requestId: ver.value.requestId,
        candidateCommit: ver.value.candidateCommit,
        targetCommit: ver.value.expectedTargetCommit,
        profileRevision: ver.value.profile.revision,
        profileDigest: ver.value.profile.digest
      });
      if (!app.ok) throw new Error(app.refusal.reason);
      return ver.value;
    };

    const req1 = await prepareApproved('exec-land-1', 'landed-cleanly\n');
    const req2 = await prepareApproved('exec-stale-target', 'stale-edit\n');

    // 1. Dirty target worktree refuses landing:
    h.fixture.write('src/a.txt', 'dirty-tracked\n');
    const dirtyAttempt = await h.service.landRequest({ requestId: req1.requestId });
    expect(dirtyAttempt.ok).toBe(false);
    if (!dirtyAttempt.ok) {
      expect(dirtyAttempt.refusal.reason).toBe('target-worktree-dirty');
    }
    h.fixture.write('src/a.txt', 'alpha\n');

    // 2. Re-queue / approve req1 cleanly and land via fast-forward:
    const req1Fresh = await prepareApproved('exec-land-clean', 'landed-cleanly\n');
    const landed = await h.service.landRequest({ requestId: req1Fresh.requestId });
    expect(landed.ok).toBe(true);
    expect(fs.readFileSync(path.join(h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('landed-cleanly\n');

    // 3. Now `main` has advanced past `req2.expectedTargetCommit` (and diverged from `req2.candidateCommit`): refuses!
    const advancedAttempt = await h.service.landRequest({ requestId: req2.requestId });
    expect(advancedAttempt.ok).toBe(false);
    if (!advancedAttempt.ok) {
      expect(['target-advanced', 'target-diverged']).toContain(advancedAttempt.refusal.reason);
    }
  });

  it('F10-AC-05: reconciles interrupted state across service restart and never deletes unowned worktrees', async () => {
    const h = createLaneHarness({ label: 'ac05' });
    const lane = await h.provision();

    // Create an unowned manual worktree outside LaneStore ownership:
    const manualWt = h.fixture.sibling('manual-user-worktree');
    rmSync(manualWt, { recursive: true, force: true });
    h.fixture.git(['worktree', 'add', '-b', 'user-manual-branch', manualWt, 'HEAD']);

    // Simulate host restart by reopening LaneService (claiming generation 2) and running reconcile():
    const reopened = h.reopen();
    const rec = await reopened.reconcile();
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      expect(rec.value.unknownWorktrees).toBeGreaterThanOrEqual(1);
    }

    // Cleanup never touches the unowned worktree or the live lane:
    const cleanup = await reopened.cleanupLanes({});
    expect(cleanup.ok).toBe(true);
    expect(fs.existsSync(manualWt)).toBe(true);
    const laneAfter = reopened.getLane({ laneId: lane.laneId });
    expect(laneAfter.ok).toBe(true);
  });

  it('F10-AC-06: NestedRepoSyncCoordinator records both revisions, applies CAS rollback when branch is not checked out, and preserves state on checked-out failure', async () => {
    const envelopeRepo = createFixtureRepo('ac06-envelope');
    const execRepo = createFixtureRepo('ac06-exec');
    extraFixtures.push(envelopeRepo, execRepo);

    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
    extraConnections.push(conn);

    // Prepare a fast-forwardable candidate commit on a side branch in execRepo:
    const execBase = execRepo.head();
    execRepo.git(['branch', 'staging', execBase]);
    execRepo.git(['checkout', '-b', 'candidate-work']);
    execRepo.write('feature.ts', 'export const ok = true;\n');
    const candidateCommit = execRepo.commit('feat: candidate');
    execRepo.git(['checkout', 'main']);

    // Record initial sync commit in envelopeRepo:
    envelopeRepo.write('SYNC.md', 'baseline\n');
    envelopeRepo.git(['add', '-A']);
    envelopeRepo.git(['commit', '-q', '--no-verify', '-m', `chore: baseline\n\nRepo-head: ${execBase}`]);
    const envBase = envelopeRepo.head();

    const gitRunner = createExecFileGitRunner({
      baseEnv: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    const syncCoord = new NestedRepoSyncCoordinator({
      envelopeRoot: envelopeRepo.root,
      executionRepoRoot: execRepo.root,
      git: gitRunner,
      conn
    });

    // Case A: Non-checked-out branch (`staging`) advances, then envelope step fails -> CAS `update-ref` rolls `staging` back!
    const rolledBack = await syncCoord.executeLocalTransactionalSync({
      syncId: 'sync-rollback-1',
      targetBranch: 'staging',
      expectedExecutionBefore: execBase,
      executionTargetCommit: candidateCommit,
      expectedEnvelopeBefore: envBase,
      applyEnvelopeUpdate: async () => ({ ok: false, reason: 'simulated-envelope-hook-refusal' })
    });
    expect(rolledBack.status).toBe('compensated-rolled-back');
    expect(rolledBack.compensationAttempted).toBe(true);
    expect(rolledBack.compensationOutcome).toBe('applied');
    expect(rolledBack.actualExecutionRevision).toBe(execBase);
    expect(rolledBack.actualEnvelopeRevision).toBe(envBase);
    expect(syncCoord.getJournalRecord('sync-rollback-1')?.status).toBe('compensated-rolled-back');

    // Case B: Checked-out branch (`main`) advances via --ff-only, then envelope fails -> NO destructive Git reset! Preserves both actual revisions + concrete recovery action.
    const preserved = await syncCoord.executeLocalTransactionalSync({
      syncId: 'sync-partial-2',
      targetBranch: 'main',
      expectedExecutionBefore: execBase,
      executionTargetCommit: candidateCommit,
      expectedEnvelopeBefore: envBase,
      applyEnvelopeUpdate: async () => ({ ok: false, reason: 'simulated-envelope-commit-failure' })
    });
    expect(preserved.status).toBe('partial-sync-preserved');
    expect(preserved.compensationOutcome).toBe('skipped-unauthorized-operation');
    expect(preserved.actualExecutionRevision).toBe(candidateCommit);
    expect(preserved.actualEnvelopeRevision).toBe(envBase);
    expect(preserved.recoveryAction).toBe('record-envelope-sync-commit');

    // Case C: Recover by recording the envelope commit and verify `observeState().inSync === true`:
    envelopeRepo.write('SYNC.md', 'synced\n');
    envelopeRepo.git(['add', '-A']);
    envelopeRepo.git(['commit', '-q', '--no-verify', '-m', `chore: sync\n\nRepo-head: ${candidateCommit}`]);
    const observed = await syncCoord.observeState();
    expect(observed.inSync).toBe(true);
    expect(observed.executionHead).toBe(candidateCommit);
    expect(observed.recordedRepoTrailer).toBe(candidateCommit);
  });

  it('F10-AC-07: enforces headless pagination bounds and ensures canceling one lane request leaves sibling lanes untouched', async () => {
    const h = createLaneHarness({ label: 'ac07', overrides: { liveLaneCap: 4 } });

    const l1 = await lanesApi.provisionLane(h.service, {
      rootExecutionId: 'run-page-1',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    const l2 = await lanesApi.provisionLane(h.service, {
      rootExecutionId: 'run-page-2',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    expect(l1.ok && l2.ok).toBe(true);
    if (!l1.ok || !l2.ok) return;

    // Over-limit (> 200) is refused at input validation before hitting SQLite:
    const overLimit = lanesApi.listLanes(h.service, { limit: 201 });
    expect(overLimit.ok).toBe(false);

    // Paginated read of limit=1 walks both lanes deterministically:
    const page1 = lanesApi.listLanes(h.service, { limit: 1 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(1);
    expect(page1.value.nextCursor).not.toBeNull();
    const page2 = lanesApi.listLanes(h.service, { limit: 1, cursor: page1.value.nextCursor ?? undefined });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(1);

    // Prepare integration requests on both lanes, then cancel lane 1's request -> lane 2's request & ownership stay intact!
    const root1 = await h.laneRoot(l1.value.laneId);
    const root2 = await h.laneRoot(l2.value.laneId);
    fs.writeFileSync(path.join(root1, 'src', 'a.txt'), 'lane1\n', 'utf8');
    fs.writeFileSync(path.join(root2, 'src', 'b.txt'), 'lane2\n', 'utf8');
    await lanesApi.freezeCandidate(h.service, { laneId: l1.value.laneId });
    await lanesApi.freezeCandidate(h.service, { laneId: l2.value.laneId });

    const r1 = await lanesApi.requestIntegration(h.service, {
      laneId: l1.value.laneId,
      targetBranch: 'main',
      profile: PASSING_PROFILE
    });
    const r2 = await lanesApi.requestIntegration(h.service, {
      laneId: l2.value.laneId,
      targetBranch: 'main',
      profile: PASSING_PROFILE
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const canceled1 = lanesApi.cancelRequest(h.service, { requestId: r1.value.requestId });
    expect(canceled1.ok).toBe(true);

    const check2 = lanesApi.getRequest(h.service, { requestId: r2.value.requestId });
    expect(check2.ok).toBe(true);
    if (check2.ok) {
      expect(check2.value.state).toBe('queued');
    }
    const lane2View = lanesApi.getLane(h.service, { laneId: l2.value.laneId });
    expect(lane2View.ok).toBe(true);
    if (lane2View.ok) {
      expect(lane2View.value.state).toBe('active');
    }
  });

  it('F10-AC-08: preserves lane root binding across SQLite reload, opens fresh ACP session on cross-root reuse, and refuses removed upstream handoff artifacts', async () => {
    const h = createLaneHarness({ label: 'ac08', overrides: { liveLaneCap: 4 } });
    const coord1 = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });

    const bA = await coord1.provisionForRun('acp-run-a');
    const bB = await coord1.provisionForRun('acp-run-b');
    expect(bA).not.toBeNull();
    expect(bB).not.toBeNull();

    // Simulate reload: fresh RunLaneCoordinator refreshes cache from SQLite store and preserves exact roots!
    const coordReloaded = createRunLaneCoordinator({
      getLaneService: () => h.service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: h.fixture.root
    });
    await coordReloaded.refreshCacheFromStore();
    const rootA = coordReloaded.resolveExecutionRootSyncOrCached('acp-run-a');
    const rootB = coordReloaded.resolveExecutionRootSyncOrCached('acp-run-b');
    expect(rootA).not.toBe(h.fixture.root);
    expect(rootB).not.toBe(h.fixture.root);
    expect(rootA).not.toBe(rootB);

    // Mock ACP agent recording session/new vs session/load calls:
    const tempDir = mkdtempSync(path.join(tmpdir(), 'schegent-f10-ac08-'));
    extraTempDirs.push(tempDir);
    const logPath = path.join(tempDir, 'rpc-methods.json');
    fs.writeFileSync(logPath, '[]', 'utf8');
    const agentScript = path.join(tempDir, 'mock-acp.mjs');
    writeFileSync(
      agentScript,
      `#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const logFile = ${JSON.stringify(logPath)};
let seq = 0;
function record(entry) {
  const prev = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  prev.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(prev), 'utf8');
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  record({ method: msg.method, cwd: msg.params?.cwd ?? null, sessionId: msg.params?.sessionId ?? null });
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock', version: '1.5.5' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    seq += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-root-' + seq } });
  } else if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
      'utf8'
    );
    chmodSync(agentScript, 0o755);

    const acpRunner = new AcpBackedRunner({
      kind: 'agy',
      inner: makeDummyInnerRunner(),
      readConfiguredProfile: () => 'agy-acp-native',
      authorityGate: new AcpAuthorityGate({
        isWorkspaceTrusted: () => true,
        holdsPrimacy: () => true,
        currentOwnershipGeneration: () => 1
      }),
      primaryWorkspaceRoot: h.fixture.root
    });

    // Turn 1 in rootA -> mints `sess-root-1` bound to `rootA`.
    const resA = await acpRunner.invoke({
      cliPath: agentScript,
      cwd: rootA,
      prompt: 'Work in lane A',
      phase: 'impl',
      iteration: 1,
      runId: 'acp-run-a',
      timeoutMs: 10_000
    });
    expect(resA.cliSessionId).toBe('sess-root-1');

    // Turn 2 attempts to reuse `sess-root-1` in `rootB` -> refuses cross-root load and opens fresh session!
    const resB = await acpRunner.invoke({
      cliPath: agentScript,
      cwd: rootB,
      prompt: 'Work in lane B',
      phase: 'impl',
      iteration: 1,
      runId: 'acp-run-b',
      sessionReuse: true,
      resumeSessionOrigin: 'acp',
      resumeSessionId: 'sess-root-1',
      timeoutMs: 10_000
    });
    expect(resB.cliSessionId).toBe('sess-root-1'); // fresh connection's first session/new in child process
    expect((resB.diagnosticWarnings ?? []).some((w) => w.includes('acp-session-rebind-fresh-root'))).toBe(true);
    const recordedCalls = JSON.parse(fs.readFileSync(logPath, 'utf8')) as readonly {
      readonly method: string;
      readonly cwd: string | null;
    }[];
    expect(recordedCalls.some((c) => c.method === 'session/load')).toBe(false);

    // Turn 3 with a removed F15 upstream artifact in `authorizedUpstreamInputPaths` -> refuses before prompt!
    const missingArtifact = path.join(rootB, '.schegent', 'phase-context', 'materialized', 'gone.md');
    const resMissing = await acpRunner.invoke({
      cliPath: agentScript,
      cwd: rootB,
      prompt: 'Consume upstream artifact',
      phase: 'impl',
      iteration: 2,
      runId: 'acp-run-b',
      authorizedUpstreamInputPaths: [missingArtifact],
      timeoutMs: 10_000
    });
    expect(resMissing.exitCode).toBe(1);
    expect(
      (resMissing.diagnosticWarnings ?? []).some((w) =>
        w.includes('acp-upstream-artifact-inaccessible')
      )
    ).toBe(true);
    const callsAfterRefusal = JSON.parse(fs.readFileSync(logPath, 'utf8')) as readonly {
      readonly method: string;
    }[];
    expect(callsAfterRefusal.filter((c) => c.method === 'session/prompt')).toHaveLength(2);
  });
});
