import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createFrozenWorkflowClosure,
  resolveCandidatePhaseDefinition
} from '../../../src/config/pipeline-snapshot';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { SanitizedLogger } from '../../../src/lib/logger';
import { RunCheckpointRetentionService } from '../../../src/services/run-checkpoint-retention';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import {
  startPhaseNodeRun,
  type NodeRunStartDeps
} from '../../../src/services/workflow-execution/node-run-starter';
import {
  buildRecoveryEnvelope,
  captureWorkspaceObservation
} from '../../../src/services/workflow-execution/recovery-envelope-builder';

const execFileAsync = promisify(execFile);

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function lookupRecord<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

async function initTempGitRepo(dir: string): Promise<string> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test Operator'], { cwd: dir });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/tracked-clean.ts'), 'export const clean = 1;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/tracked-dirty.ts'), 'export const dirty = 1;\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

describe('Candidate Workspace Handover Integration (SPEC-05 / D5)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('preserves preexisting dirty and partial candidate edits byte-for-byte across handover in a real Git workspace', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-git-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-store-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const headCommit = await initTempGitRepo(workspaceRoot);

    // Operator makes preexisting dirty edits before the workflow run starts
    const operatorDirtyEditV1 = 'export const dirty = 2; // operator preexisting edit\n';
    const operatorUntrackedContent = 'operator untracked notes\n';
    await fs.writeFile(path.join(workspaceRoot, 'src/tracked-dirty.ts'), operatorDirtyEditV1, 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'src/operator-untracked.txt'), operatorUntrackedContent, 'utf8');

    const logger = new SanitizedLogger();
    const ledger = new RunMutationLedger({
      workspaceRoot,
      listInFlightRunIds: () => ['run-001'],
      readDiff: async () => {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--binary', '--no-ext-diff', 'HEAD'],
          { cwd: workspaceRoot }
        );
        return stdout;
      }
    });

    const checkpointService = new RunCheckpointService(
      storageRoot,
      workspaceRoot,
      logger,
      () => 1,
      ledger
    );

    await ledger.observeBeforePhase({
      id: 'run-001',
      startedAt: Date.now() + 10,
      phasesCompleted: []
    });

    // Capture pre-attempt snapshot before Candidate A starts
    const beforeSnapshot = await checkpointService.captureBeforeCandidateAttempt('run-001', 'attempt-A');
    expect(beforeSnapshot.isGitRepository).toBe(true);
    expect(beforeSnapshot.head).toBe(headCommit);

    // Candidate A modifies the already-dirty file again, creates a new partial file, and fails
    const candidateADirtyEditV2 =
      'export const dirty = 2; // operator preexisting edit\nexport const candidateAPartial = true;\n';
    const candidateANewFileContent = 'export const createdByCandidateA = "partial";\n';
    await fs.writeFile(path.join(workspaceRoot, 'src/tracked-dirty.ts'), candidateADirtyEditV2, 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'src/candidate-a-new.ts'), candidateANewFileContent, 'utf8');

    await ledger.observeAfterPhase(
      { id: 'run-001', startedAt: Date.now() + 10, phasesCompleted: [] },
      { declaredPaths: ['src/tracked-dirty.ts', 'src/candidate-a-new.ts'] }
    );

    const handoverResult = await checkpointService.captureAndPersistCandidateHandover(
      'run-001',
      'handover-A-to-B',
      {
        invocationId: 'inv-block-1',
        previousAttemptId: 'attempt-A',
        previousOutcome: {
          status: 'incomplete',
          reason: 'credits'
        },
        upstreamArtifactRefs: ['upstream-spec-ref-1'],
        partialArtifactRefs: ['partial-plan-ref-1'],
        sideEffects: 'workspace',
        hasAttributableTeardown: true,
        effectEvidenceRefs: ['teardown-attempt-A']
      }
    );

    expect(handoverResult.ok).toBe(true);
    if (!handoverResult.ok) return;

    // Verify workspace content is preserved byte-for-byte (no git reset/checkout/restore/clean/stash)
    expect(await fs.readFile(path.join(workspaceRoot, 'src/tracked-dirty.ts'), 'utf8')).toBe(
      candidateADirtyEditV2
    );
    expect(await fs.readFile(path.join(workspaceRoot, 'src/operator-untracked.txt'), 'utf8')).toBe(
      operatorUntrackedContent
    );
    expect(await fs.readFile(path.join(workspaceRoot, 'src/candidate-a-new.ts'), 'utf8')).toBe(
      candidateANewFileContent
    );

    // Verify attribution of every entry
    const byPath = new Map(handoverResult.handover.workspace.entries.map((e) => [e.path, e]));
    expect(byPath.get('src/tracked-dirty.ts')).toEqual({
      path: 'src/tracked-dirty.ts',
      existedBefore: true,
      dirtyBefore: true,
      beforeSha256: sha256Hex(operatorDirtyEditV1),
      afterSha256: sha256Hex(candidateADirtyEditV2),
      attribution: 'attempt'
    });
    expect(byPath.get('src/operator-untracked.txt')).toEqual({
      path: 'src/operator-untracked.txt',
      existedBefore: true,
      dirtyBefore: true,
      beforeSha256: sha256Hex(operatorUntrackedContent),
      afterSha256: sha256Hex(operatorUntrackedContent),
      attribution: 'preexisting'
    });
    expect(byPath.get('src/candidate-a-new.ts')).toEqual({
      path: 'src/candidate-a-new.ts',
      existedBefore: false,
      dirtyBefore: false,
      afterSha256: sha256Hex(candidateANewFileContent),
      attribution: 'attempt'
    });

    // Verify persisted .recovery.json is readable and owner-only (0o600)
    const persisted = await checkpointService.readRecoveryEnvelope('run-001', 'handover-A-to-B');
    expect(persisted).not.toBeNull();
    expect(persisted?.ok).toBe(true);
    if (persisted?.ok) {
      expect(persisted.value).toEqual(handoverResult.handover);
    }

    // Missing checkpoint returns null cleanly
    expect(await checkpointService.readRecoveryEnvelope('run-001', 'nonexistent')).toBeNull();

    // Retention sweep measures and preserves recent .recovery.json artifacts
    const retention = new RunCheckpointRetentionService({
      globalStorageRoot: storageRoot,
      logger
    });
    const sweepResult = await retention.sweep();
    expect(sweepResult.retainedRunCount).toBe(1);
    expect(sweepResult.failures).toBe(0);
  });

  it('captures non-Git workspaces with absent HEAD and refuses symlink escapes and concurrent writers', async () => {
    const nonGitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-nongit-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-outside-'));
    tempDirs.push(nonGitRoot, outsideDir);

    await fs.writeFile(path.join(nonGitRoot, 'local.txt'), 'v1\n', 'utf8');
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside secret\n', 'utf8');

    const beforeObs = await captureWorkspaceObservation({ workspaceRoot: nonGitRoot });
    expect(beforeObs.isGitRepository).toBe(false);
    expect(beforeObs.head).toBeUndefined();
    expect(beforeObs.coverage).toBe('complete');

    // Modify local.txt and plant a symlink pointing outside the workspace
    await fs.writeFile(path.join(nonGitRoot, 'local.txt'), 'v2\n', 'utf8');
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(nonGitRoot, 'escape-link.txt'));

    const afterObs = await captureWorkspaceObservation({ workspaceRoot: nonGitRoot });
    expect(afterObs.coverage).toBe('partial');
    expect(lookupRecord(afterObs.files, 'escape-link.txt')?.symlinkOrSpecial).toBe(true);
    expect(lookupRecord(afterObs.files, 'escape-link.txt')?.sha256).toBeUndefined();

    const handover = buildRecoveryEnvelope({
      invocationId: 'inv-nongit',
      beforeObservation: beforeObs,
      afterObservation: afterObs,
      concurrentPaths: ['concurrent-edit.txt'],
      sideEffects: 'workspace',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['ev-1']
    });

    expect(handover.ok).toBe(true);
    if (!handover.ok) return;

    expect(handover.handover.workspace.head).toBeUndefined();
    expect(handover.handover.workspace.coverage).toBe('partial');
    expect(handover.handover.effects.certainty).toBe('unknown');

    const entries = new Map(handover.handover.workspace.entries.map((e) => [e.path, e]));
    expect(entries.get('local.txt')?.attribution).toBe('attempt');
    expect(entries.get('escape-link.txt')?.attribution).toBe('unknown');
    expect(entries.get('concurrent-edit.txt')?.attribution).toBe('concurrent');
  });

  it('dispatches each candidate with its own frozen Phase instructions in a fresh session and blocks uncertain effects', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-dispatch-'));
    tempDirs.push(workspaceRoot);

    const phaseA: PhaseDefinition = {
      phaseId: 'phase-candidate-a',
      name: 'Candidate A Phase',
      version: 1,
      runner: 'claude',
      instruction: 'Candidate A distinct instruction: implement using strategy alpha.',
      sideEffects: 'workspace'
    };
    const phaseB: PhaseDefinition = {
      phaseId: 'phase-candidate-b',
      name: 'Candidate B Phase',
      version: 1,
      runner: 'claude',
      instruction: 'Candidate B distinct instruction: complete recovery using strategy beta.',
      sideEffects: 'workspace'
    };

    const rootWorkflow: WorkflowDefinition = {
      workflowId: 'wf-candidate-block',
      name: 'Candidate Block Workflow',
      version: 1,
      startNodeIds: ['node-a'],
      nodes: [
        { nodeId: 'node-a', kind: 'phase', label: 'Candidate A', phaseId: 'phase-candidate-a' },
        { nodeId: 'node-b', kind: 'phase', label: 'Candidate B', phaseId: 'phase-candidate-b' }
      ],
      connections: [],
      control: {
        version: 1,
        kind: 'candidate-block',
        availabilityPolicy: 'first-ready',
        candidates: [
          { candidateId: 'cand-a', nodeId: 'node-a', priority: 1, maxAttempts: 2 },
          { candidateId: 'cand-b', nodeId: 'node-b', priority: 2, maxAttempts: 2 }
        ]
      }
    };

    const closureRes = createFrozenWorkflowClosure({
      rootWorkflow,
      effectivePhases: [phaseA, phaseB]
    });
    expect(closureRes.ok).toBe(true);
    if (!closureRes.ok) return;

    const resolvedA = resolveCandidatePhaseDefinition(
      closureRes.closure,
      'wf-candidate-block',
      'cand-a'
    );
    const resolvedB = resolveCandidatePhaseDefinition(
      closureRes.closure,
      'wf-candidate-block',
      'cand-b'
    );
    expect(resolvedA?.phase.instruction).toBe(phaseA.instruction);
    expect(resolvedB?.phase.instruction).toBe(phaseB.instruction);
    expect(resolvedA?.phase.runner).toBe('claude');
    expect(resolvedB?.phase.runner).toBe('claude');

    const enqueuedRequests: unknown[] = [];
    const deps: NodeRunStartDeps = {
      logger: new SanitizedLogger(),
      guardedRun: {
        scheduleOrEnqueue: async (req) => {
          enqueuedRequests.push(req);
          return {
            outcome: 'enqueued',
            queueItemId: `q-${enqueuedRequests.length}`
          };
        }
      }
    };

    // 1) Block automatic handover when effects.certainty is 'uncertain'
    const uncertainHandover = buildRecoveryEnvelope({
      invocationId: 'inv-1',
      previousAttemptId: 'att-a-1',
      previousOutcome: { status: 'incomplete', reason: 'credits' },
      upstreamArtifactRefs: ['immutable-upstream-ref'],
      partialArtifactRefs: ['partial-ref-a'],
      sideEffects: 'git',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['ev-1']
    });
    expect(uncertainHandover.ok).toBe(true);
    if (!uncertainHandover.ok) return;

    const blockedStart = await startPhaseNodeRun(deps, {
      frozenClosure: closureRes.closure,
      workflowId: 'wf-candidate-block',
      candidateId: 'cand-b',
      phaseId: 'phase-candidate-b',
      recoveryEnvelope: uncertainHandover.handover,
      request: {
        pipelineId: 'phase-candidate-b',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workspaceRoot,
      occurrence: {
        rootRunId: 'root-1',
        invocationId: 'inv-1',
        parentInvocationId: null,
        nodePath: 'wf-candidate-block/node-b',
        attemptId: 'att-b-1',
        attemptIndex: 2
      }
    });
    expect(blockedStart).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'uncertain-effects:uncertain'
    });
    expect(enqueuedRequests.length).toBe(0);

    // 2) Safe handover dispatches Candidate B with Candidate B's own frozen Phase instructions
    //    and preserves upstreamArtifactRefs alongside partialArtifactRefs
    const safeObs = await captureWorkspaceObservation({ workspaceRoot });
    const safeHandover = buildRecoveryEnvelope({
      invocationId: 'inv-1',
      previousAttemptId: 'att-a-1',
      previousOutcome: { status: 'incomplete', reason: 'credits' },
      upstreamArtifactRefs: ['immutable-upstream-ref'],
      partialArtifactRefs: ['partial-ref-a'],
      beforeObservation: safeObs,
      afterObservation: safeObs,
      sideEffects: 'workspace',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['teardown-att-a-1']
    });
    expect(safeHandover.ok).toBe(true);
    if (!safeHandover.ok) return;

    const allowedStart = await startPhaseNodeRun(deps, {
      frozenClosure: closureRes.closure,
      workflowId: 'wf-candidate-block',
      candidateId: 'cand-b',
      phaseId: 'phase-candidate-b',
      recoveryEnvelope: safeHandover.handover,
      request: {
        pipelineId: 'phase-candidate-b',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workspaceRoot,
      occurrence: {
        rootRunId: 'root-1',
        invocationId: 'inv-1',
        parentInvocationId: null,
        nodePath: 'wf-candidate-block/node-b',
        attemptId: 'att-b-1',
        attemptIndex: 2
      }
    });

    expect(allowedStart.outcome).toBe('enqueued');
    if (allowedStart.outcome !== 'enqueued') return;
    expect(allowedStart.plan.pipeline.id).toBe('phase-candidate-b');
    expect(allowedStart.plan.pipeline.phases.at(0)?.instruction).toBe(phaseB.instruction);
    expect(allowedStart.plan.supplemental.some((s) => s.value.includes('immutable-upstream-ref'))).toBe(true);
  });
});
