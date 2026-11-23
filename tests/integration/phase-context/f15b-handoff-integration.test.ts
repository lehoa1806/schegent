import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFrozenWorkflowClosure } from '../../../src/config/pipeline-snapshot';
import { validateWorkflowDefinition } from '../../../src/config/workflow-definition-validator';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import { PHASE_CONTEXT_CONTRIBUTION_VERSION } from '../../../src/contracts/phase-context/context-policy';
import { REVIEW_REPORT_VERSION } from '../../../src/contracts/phase-context/review-loop';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { capabilityRequestFields } from '../../../src/controller/capability-decision-recorder';
import { createPhaseContextApi } from '../../../src/headless/phase-context-api';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactByteProbe,
  type LifecycleFs
} from '../../../src/services/artifact-lifecycle';
import {
  allocateAttemptStagingPaths,
  createPhaseHandoffCoordinator,
  createSqliteHandoffStore
} from '../../../src/services/phase-context';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type PhaseAttemptDispatchInput
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import { WorkflowControlService } from '../../../src/services/workflow-execution/workflow-control-service';
import { WorkflowRecoveryService } from '../../../src/services/workflow-execution/workflow-recovery-service';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeNodeLifecycleFs(): LifecycleFs {
  return {
    async lstat(abs) {
      try {
        const st = await fsp.lstat(abs);
        return {
          kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file',
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs
        };
      } catch {
        return null;
      }
    },
    async readdir(abs) {
      try {
        return await fsp.readdir(abs);
      } catch {
        return [];
      }
    },
    realpath: (abs) => fsp.realpath(abs),
    unlink: (abs) => fsp.unlink(abs)
  };
}

function makeProbe(workspaceRoot: string): ArtifactByteProbe {
  return {
    async observe(locator) {
      if (locator.storageTier !== 'workspace_file') {
        return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      }
      try {
        const st = await fsp.stat(path.join(workspaceRoot, locator.uriOrRelpath));
        return { exists: true, sizeBytes: st.size, producerIdentity: null, generation: null };
      } catch {
        return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      }
    },
    async digestSha256(locator) {
      if (locator.storageTier !== 'workspace_file') return null;
      try {
        const bytes = await fsp.readFile(path.join(workspaceRoot, locator.uriOrRelpath));
        return sha256Hex(bytes);
      } catch {
        return null;
      }
    }
  };
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const PHASE_A: PhaseDefinition = {
  phaseId: 'phase-a',
  name: 'Phase A',
  version: 1,
  instruction: 'Produce specification summary.',
  runner: 'claude'
};

const PHASE_B: PhaseDefinition = {
  phaseId: 'phase-b',
  name: 'Phase B',
  version: 1,
  instruction: 'Implement from approved handoff.',
  runner: 'claude'
};

const PHASE_C_CODEX: PhaseDefinition = {
  phaseId: 'phase-c',
  name: 'Phase C',
  version: 1,
  instruction: 'Independent review.',
  runner: 'codex'
};

describe('FR-R6-F15 (F15-B) — End-to-End Phase Context Handoff Integration', () => {
  it('validates authored contextPolicy, refuses future versions & non-ancestor selectors, and round-trips YAML losslessly', () => {
    const unsupportedVersion = validateWorkflowDefinition({
      workflowId: 'wf-bad-ver',
      name: 'Bad Version',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: { version: 99, approval: 'automatic', session: 'fresh', selectors: [] }
        }
      ]
    });
    expect(unsupportedVersion.ok).toBe(false);
    expect(unsupportedVersion.errors.some((e) => e.code === 'unsupported-context-policy-version')).toBe(
      true
    );

    const validDefOutcome = validateWorkflowDefinition({
      workflowId: 'wf-handoff',
      name: 'Handoff Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' },
        { nodeId: 'n3', kind: 'phase', phaseId: 'phase-c' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'bad-sel', sourceNodePath: 'n3', required: true, priority: 1 }]
          }
        },
        { from: { nodeId: 'n2' }, to: { nodeId: 'n3' } }
      ]
    });
    expect(validDefOutcome.ok).toBe(true);
    if (validDefOutcome.definition !== null) {
      const graphErrors = validateWorkflowGraph(validDefOutcome.definition, [], new Map(), {
        effectivePhases: [PHASE_A, PHASE_B, PHASE_C_CODEX]
      });
      expect(graphErrors.some((e) => e.code === 'context-selector-not-ancestor')).toBe(true);
    }

    // Valid authored workflow round-trips through Process-YAML & freezes into FrozenWorkflowClosure.
    const goodOutcome = validateWorkflowDefinition({
      workflowId: 'wf-good',
      name: 'Good Handoff Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'manual',
            session: 'reuse-when-qualified',
            selectors: [{ selectorId: 'sel-a', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    });
    expect(goodOutcome.ok).toBe(true);
    if (!goodOutcome.ok || goodOutcome.definition === null) return;

    const doc = documentFromWorkflowDefinition(goodOutcome.definition, {
      phases: [PHASE_A, PHASE_B]
    });
    const yamlText = serializeWorkflowDocument(doc);
    const parsedNode = parseDocumentText(yamlText);
    expect(parsedNode.ok).toBe(true);
    if (parsedNode.ok) {
      const pkg = parseWorkflowPackage(parsedNode.node);
      expect(pkg.ok).toBe(true);
      if (pkg.ok) {
        const rootRes = pkg.resources.at(0);
        expect(rootRes?.resourceKind).toBe('workflow');
        if (rootRes !== undefined && rootRes.ok && rootRes.resourceKind === 'workflow') {
          expect(rootRes.definition.connections.at(0)?.contextPolicy).toEqual(
            goodOutcome.definition.connections.at(0)?.contextPolicy
          );
          const reserialized = serializeWorkflowDocument(
            documentFromWorkflowDefinition(rootRes.definition, { phases: [PHASE_A, PHASE_B] })
          );
          expect(reserialized).toBe(yamlText);
        }
      }
    }

    const closure = createFrozenWorkflowClosure({
      rootWorkflow: goodOutcome.definition,
      effectiveWorkflows: [goodOutcome.definition],
      effectivePhases: [PHASE_A, PHASE_B]
    });
    expect(closure.ok).toBe(true);
  });

  it('persists durable SQLite handoffs across restart, supports manual edit/approve, cross-root streaming materialization, and ACP prompt-block delivery with zero argv/env context', async () => {
    const primaryRoot = await makeTempDir('f15b-primary-');
    const sourceLaneRoot = await makeTempDir('f15b-lane-src-');
    const targetLaneRoot = await makeTempDir('f15b-lane-dst-');
    const dbDir = await makeTempDir('f15b-db-');
    const dbPath = path.join(dbDir, 'schegent-state.db');

    let currentLaneRoot = sourceLaneRoot;

    const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const lifecycle1 = createArtifactLifecycleService({
      conn: sqlite1.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(primaryRoot),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: primaryRoot,
      workspaceId: 'ws-test'
    });
    const handoffStore1 = createSqliteHandoffStore(sqlite1.writerConnection);
    const coordinator1 = createPhaseHandoffCoordinator({
      store: handoffStore1,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-test',
      lifecycle: lifecycle1,
      resolveExecutionRoot: () => currentLaneRoot
    });

    const workflow: WorkflowDefinition = {
      workflowId: 'wf-manual',
      name: 'Manual Handoff Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          handoff: 'manual',
          contextPolicy: {
            version: 1,
            approval: 'manual',
            session: 'fresh',
            selectors: [{ selectorId: 'from-n1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-f15-1',
      workflow,
      effectiveWorkflows: [workflow],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    let currentRun: ConnectedWorkflowRun = snap.run;
    const rootInvId = snap.rootInvocationId;
    const runWriter = {
      get: (id: string): ConnectedWorkflowRun | null =>
        currentRun.connectedRunId === id ? currentRun : null,
      async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
        if (currentRun.revision !== expectedRev) {
          return { outcome: 'stale' as const, current: currentRun };
        }
        currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
        return { outcome: 'written' as const, run: currentRun };
      }
    };

    const dispatchedPayloads: PhaseAttemptDispatchInput[] = [];
    const coordDeps1 = {
      connectedRuns: runWriter,
      phaseHandoffCoordinator: coordinator1,
      workspaceRoot: primaryRoot,
      dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
        dispatchedPayloads.push(inp);
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      }
    };

    // 1. Dispatch Phase A (n1).
    const step1 = await dispatchComposableNode(coordDeps1 as never, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'n1',
      startedAt: 1100
    });
    expect(step1.outcome).toBe('phase-dispatched');
    if (step1.outcome !== 'phase-dispatched') return;

    // 2. Stage valid contribution.json + declared binary file in sourceLaneRoot.
    const specBinaryRel = 'artifacts/spec-bundle.bin';
    const specBinaryAbs = path.join(sourceLaneRoot, specBinaryRel);
    await fsp.mkdir(path.dirname(specBinaryAbs), { recursive: true });
    const binaryBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, ...Buffer.from('spec-payload')]);
    await fsp.writeFile(specBinaryAbs, binaryBytes);

    const stagingN1 = allocateAttemptStagingPaths(sourceLaneRoot, currentRun.connectedRunId, step1.attemptId);
    await fsp.mkdir(path.dirname(stagingN1.contributionAbsPath), { recursive: true });
    const n1Attempt = currentRun.invocations![rootInvId]!.attemptsByNodeId['n1']![0]!;
    const normOccId = rootInvId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const stagedContribution = {
      schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
      producer: {
        nodePath: n1Attempt.nodePath.replace(/^\/+/, ''),
        occurrenceId: normOccId,
        attemptId: step1.attemptId
      },
      coverage: 'complete' as const,
      outcomes: ['Spec drafted and verified'],
      decisions: ['Use ACP content blocks only'],
      constraints: ['Keep rendered context <= 32 KiB'],
      unresolvedIssues: [],
      summary: 'Ready for implementation phase.',
      artifacts: []
    };
    await fsp.writeFile(stagingN1.contributionAbsPath, JSON.stringify(stagedContribution), 'utf8');

    const step2 = await completeComposableNodeAttempt(coordDeps1 as never, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'n1',
      attemptIndex: n1Attempt.attemptIndex,
      status: 'completed',
      completedAt: 1200,
      declaredOutputs: {
        bundle: { portId: 'bundle', type: 'file', value: specBinaryRel }
      }
    });
    expect(step2.outcome).toBe('waiting-for-handoff');
    const handoffId =
      currentRun.invocations?.[rootInvId]?.pendingHandoff?.phaseHandoffId ??
      currentRun.pendingHandoff?.phaseHandoffId;
    expect(handoffId).toBeDefined();

    // 3. Simulate extension host restart: close SQLite store 1, reopen SQLite store 2!
    sqlite1.close();
    const sqlite2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const handoffStore2 = createSqliteHandoffStore(sqlite2.writerConnection);
    const coordinator2 = createPhaseHandoffCoordinator({
      store: handoffStore2,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-test',
      resolveExecutionRoot: () => currentLaneRoot
    });
    const api2 = createPhaseContextApi(() => coordinator2);

    // Rehydrated inspection returns metadata-only explanation with zero prose leakage!
    const inspected = api2.inspectHandoff(handoffId!);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.explanation.revisions).toHaveLength(1);
      expect(inspected.explanation.revisions[0]?.state).toBe('waiting-approval');
      expect(JSON.stringify(inspected.explanation)).not.toContain('Ready for implementation phase.');
    }

    // 4. Operator edits handoff before approving -> creates revision 2 ('waiting-approval') and supersedes revision 1!
    const storedRev1 = handoffStore2.load(handoffId!)!.revisions[0]!;
    const manifest1 = JSON.parse(storedRev1.serializedManifest);
    const carriedBundleArtifact = manifest1.sources[0]!.artifacts[0]!;
    expect(carriedBundleArtifact.digestHex).toBe(sha256Hex(binaryBytes));

    // Adding an unknown artifact that was not in revision 1 is refused by F15 edit rules!
    const illegalAddedArtifactSources = manifest1.sources.map((s: Record<string, unknown>) => ({
      ...s,
      artifacts: [
        {
          artifactId: 'untrusted-injected-bin',
          immutableVersion: 'v1',
          digestHex: sha256Hex(binaryBytes),
          byteSize: binaryBytes.byteLength,
          kind: 'binary'
        }
      ]
    }));
    expect(api2.editHandoff(handoffId!, 1, illegalAddedArtifactSources)).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'edit-unknown-artifact'
    });

    const editedSources = manifest1.sources.map((s: Record<string, unknown>) => ({
      ...s,
      outcomes: ['Edited operator outcome']
    }));

    // Register the binary artifact location in coordinator2 for cross-root streaming materialization after restart.
    coordinator2.registerExternalContribution({
      runId: currentRun.connectedRunId,
      contribution: {
        ...stagedContribution,
        schemaVersion: 1,
        artifacts: [carriedBundleArtifact]
      },
      artifacts: [
        {
          ref: carriedBundleArtifact,
          sourceRoot: sourceLaneRoot,
          relativePath: specBinaryRel
        }
      ]
    });

    const editOutcome = api2.editHandoff(handoffId!, 1, editedSources);
    expect(editOutcome.ok).toBe(true);
    if (editOutcome.ok) {
      expect(editOutcome.revision.revision).toBe(2);
      expect(editOutcome.revision.state).toBe('waiting-approval');
    }
    // Stale edit on revision 1 is refused!
    const staleEdit = api2.editHandoff(handoffId!, 1, editedSources);
    expect(staleEdit.ok).toBe(false);

    // 5. Switch target execution root to `targetLaneRoot` and approve + continue handoff via WorkflowControlService!
    currentLaneRoot = targetLaneRoot;
    let capturedPhaseBDispatch: PhaseAttemptDispatchInput | undefined;
    const controlService = new WorkflowControlService({
      connectedRuns: runWriter,
      phaseHandoffCoordinator: coordinator2,
      workspaceRoot: primaryRoot,
      dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
        capturedPhaseBDispatch = inp;
        return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
      }
    });

    const continueRes = await controlService.executeCommand({
      runId: currentRun.connectedRunId,
      commandId: 'cmd-approve-handoff-1',
      expectedRevision: currentRun.revision,
      operation: 'continue-handoff',
      targetInvocationId: rootInvId,
      targetNodeId: 'n2',
      now: 1500
    });
    expect(continueRes.accepted).toBe(true);
    expect(capturedPhaseBDispatch?.phaseHandoff?.handoffId).toBe(handoffId);
    expect(capturedPhaseBDispatch?.phaseHandoff?.revision).toBe(2);

    // Verify ACP prompt blocks carry target instructions + rendered context + resource-link to materialized copy!
    const blocks = capturedPhaseBDispatch?.phaseHandoff?.acpPromptBlocks ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0]).toEqual({ type: 'text', text: PHASE_B.instruction });
    expect(blocks[1]?.type === 'text' && blocks[1].text.includes('Edited operator outcome')).toBe(true);
    const linkBlock = blocks.find((b) => b.type === 'resource-link');
    expect(linkBlock).toBeDefined();
    if (linkBlock?.type === 'resource-link') {
      const copiedFilePath = new URL(linkBlock.uri).pathname;
      expect(copiedFilePath.startsWith(await fsp.realpath(targetLaneRoot))).toBe(true);
      const copiedBytes = await fsp.readFile(copiedFilePath);
      expect(sha256Hex(copiedBytes)).toBe(sha256Hex(binaryBytes));
    }

    // Verify `capabilityRequestFields` forwards prompt blocks and authority paths without argv/env pollution.
    const runnerFields = capabilityRequestFields({
      iteration: 0,
      envelope: { phaseHandoff: capturedPhaseBDispatch!.phaseHandoff! }
    });
    expect(runnerFields.acpPromptBlocks).toEqual(blocks);
    expect(runnerFields.authorizedUpstreamInputPaths?.length).toBe(1);
    expect(runnerFields.authorizedOutputPaths?.length).toBe(3);

    sqlite2.close();
  });

  it('rejects malformed, oversized, or stale previous-attempt staging files and enforces Repeat(Fix -> Review) revalidation', async () => {
    const rootDir = await makeTempDir('f15b-us10-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection);
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-us10'
    });

    const workflow: WorkflowDefinition = {
      workflowId: 'wf-review',
      name: 'Review Workflow',
      version: 1,
      startNodeIds: ['reviewer'],
      nodes: [{ nodeId: 'reviewer', kind: 'phase', phaseId: 'phase-c' }],
      connections: []
    };
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-review-1',
      workflow,
      effectiveWorkflows: [workflow],
      effectivePhases: [PHASE_C_CODEX],
      startedAt: 2000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    const run = snap.run;
    const invId = snap.rootInvocationId;
    const frame = run.invocations![invId]!;

    const attempt1 = {
      attemptId: 'att-rev-1',
      attemptIndex: 1,
      rootRunId: run.connectedRunId,
      invocationId: invId,
      parentInvocationId: null,
      nodePath: 'root/reviewer',
      nodeId: 'reviewer',
      nodeKind: 'phase' as const,
      targetDefinitionId: 'phase-c',
      status: 'completed' as const,
      startedAt: 2010,
      completedAt: 2020,
      inputEnvelope: {
        envelopeId: 'env-1',
        invocationId: invId,
        targetNodeId: 'reviewer',
        source: 'launch' as const,
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 2005
      },
      declaredOutputs: {}
    };

    // 1. Truncated JSON in contribution.json is refused deterministically (US10).
    const staging1 = allocateAttemptStagingPaths(rootDir, run.connectedRunId, attempt1.attemptId);
    await fsp.mkdir(path.dirname(staging1.contributionAbsPath), { recursive: true });
    await fsp.writeFile(staging1.contributionAbsPath, '{"schemaVersion":1,"broken', 'utf8');

    const badJsonRes = await coordinator.recordSettledAttempt({ run, frame, attempt: attempt1 });
    expect(badJsonRes.ok).toBe(false);
    await fsp.unlink(staging1.contributionAbsPath);

    // 2. Stale wrong-attempt review-report.json is refused!
    const wrongAttemptReport = {
      reportVersion: REVIEW_REPORT_VERSION,
      loopId: `loop-${run.connectedRunId}-repeat-review`,
      pass: 1,
      reviewerAttemptId: 'att-SOME-OTHER-ATTEMPT',
      candidateRef: 'cand-sha-1',
      scopeRevision: 'scope-1',
      criteriaRevision: 'crit-1',
      previousReportRef: null,
      coverage: 'complete' as const,
      reviewPassed: true,
      blockingCount: 0,
      findings: [],
      dispositions: []
    };
    await fsp.writeFile(staging1.reviewReportAbsPath, JSON.stringify(wrongAttemptReport), 'utf8');
    const staleAttemptRes = await coordinator.recordSettledAttempt({
      run,
      frame,
      attempt: attempt1,
      reviewLoopNodeId: 'repeat-review'
    });
    expect(staleAttemptRes).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'reviewer-attempt-mismatch'
    });

    // 3. Valid pass 1 failing report blocks exit; valid pass 2 passing report allows exit; subsequent candidate mutation requires revalidation!
    const failReport = {
      ...wrongAttemptReport,
      reviewerAttemptId: attempt1.attemptId,
      reviewPassed: false,
      blockingCount: 1,
      findings: [
        {
          id: 'F-001',
          severity: 'high' as const,
          title: 'Missing check',
          explanation: 'Add check',
          evidence: ['src/index.ts#L10']
        }
      ]
    };
    await fsp.writeFile(staging1.reviewReportAbsPath, JSON.stringify(failReport), 'utf8');
    const pass1Res = await coordinator.recordSettledAttempt({
      run,
      frame,
      attempt: attempt1,
      reviewLoopNodeId: 'repeat-review',
      candidateSnapshotDigest: 'cand-sha-1'
    });
    expect(pass1Res.ok).toBe(true);
    expect(
      coordinator.verifyRepeatExitAllowed({
        runId: run.connectedRunId,
        repeatNodeId: 'repeat-review'
      }).ok
    ).toBe(false);

    // Pass 2 resolves F-001 -> exit allowed!
    const attempt2 = { ...attempt1, attemptId: 'att-rev-2', attemptIndex: 2 };
    const staging2 = allocateAttemptStagingPaths(rootDir, run.connectedRunId, attempt2.attemptId);
    await fsp.mkdir(path.dirname(staging2.reviewReportAbsPath), { recursive: true });
    const pass1CapturedRef = coordinator.inspectReviewLoop(`loop-${run.connectedRunId}-repeat-review`)
      ?.history.entries[0]?.reportRef ?? null;
    const passReport = {
      ...wrongAttemptReport,
      pass: 2,
      reviewerAttemptId: attempt2.attemptId,
      candidateRef: 'cand-sha-2',
      previousReportRef: pass1CapturedRef,
      reviewPassed: true,
      blockingCount: 0,
      findings: [],
      dispositions: [{ findingId: 'F-001', status: 'resolved' as const }]
    };
    await fsp.writeFile(staging2.reviewReportAbsPath, JSON.stringify(passReport), 'utf8');
    const pass2Res = await coordinator.recordSettledAttempt({
      run,
      frame,
      attempt: attempt2,
      reviewLoopNodeId: 'repeat-review',
      candidateSnapshotDigest: 'cand-sha-2'
    });
    expect(pass2Res.ok).toBe(true);
    expect(
      coordinator.verifyRepeatExitAllowed({
        runId: run.connectedRunId,
        repeatNodeId: 'repeat-review',
        currentCandidateRef: 'cand-sha-2'
      })
    ).toEqual({ ok: true });

    // Candidate mutated after pass 2 -> exit refused until re-reviewed!
    coordinator.invalidateReviewLoopCandidate({
      runId: run.connectedRunId,
      repeatNodeId: 'repeat-review',
      newCandidateRef: 'cand-sha-3'
    });
    expect(
      coordinator.verifyRepeatExitAllowed({
        runId: run.connectedRunId,
        repeatNodeId: 'repeat-review'
      })
    ).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'review-revalidation-required'
    });

    sqlite.close();
  });

  it('14-08: keeps handoff pins and artifact bytes alive across stale CAS conflicts and write failures on all terminal exits (success, failure, cancellation) and across store reopen + retention', async () => {
    const cases: readonly {
      readonly label: string;
      readonly exitMode: 'completed' | 'failed' | 'canceled' | 'control-cancel';
      readonly faultMode: 'stale' | 'throw';
    }[] = [
      { label: 'success-stale', exitMode: 'completed', faultMode: 'stale' },
      { label: 'success-throw', exitMode: 'completed', faultMode: 'throw' },
      { label: 'failure-stale', exitMode: 'failed', faultMode: 'stale' },
      { label: 'failure-throw', exitMode: 'failed', faultMode: 'throw' },
      { label: 'cancel-stale', exitMode: 'canceled', faultMode: 'stale' },
      { label: 'cancel-throw', exitMode: 'canceled', faultMode: 'throw' },
      { label: 'control-cancel-stale', exitMode: 'control-cancel', faultMode: 'stale' },
      { label: 'control-cancel-throw', exitMode: 'control-cancel', faultMode: 'throw' }
    ];

    const workflow: WorkflowDefinition = {
      workflowId: 'wf-pin-safety',
      name: 'Pin Safety Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'from-n1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };

    for (const tc of cases) {
      const rootDir = await makeTempDir(`f15b-14-08-${tc.label}-`);
      const dbDir = await makeTempDir(`f15b-14-08-db-${tc.label}-`);
      const dbPath = path.join(dbDir, 'schegent-state.db');

      const reportsDir = path.join(rootDir, '.schegent', 'reports');
      await fsp.mkdir(reportsDir, { recursive: true });
      const artifactRel = '.schegent/reports/pinned-spec.bin';
      const artifactAbs = path.join(rootDir, artifactRel);
      const artifactBytes = Buffer.from([0x00, 0x01, ...Buffer.from(`pinned-bytes-${tc.label}`, 'utf8')]);
      await fsp.writeFile(artifactAbs, artifactBytes);
      const artifactDigest = sha256Hex(artifactBytes);
      const artifactId = `out-spec-${artifactDigest.slice(0, 8)}`;

      const openLifecycle = (conn: SqliteApplicationStore['writerConnection']) =>
        createArtifactLifecycleService({
          conn,
          nowMs: () => 1_700_000_000_000,
          fs: makeNodeLifecycleFs(),
          probe: makeProbe(rootDir),
          audit: { recordLifecycleMutation: () => undefined },
          scanRoots: [
            {
              rootId: 'reports',
              root: reportsDir,
              retentionClass: 'generated-reports-handoff-exports',
              storeKind: 'report'
            }
          ],
          accessPolicy: DENY_ALL_ACCESS_POLICY,
          resolveOwner: (ownerKind) => (ownerKind === 'handoff' ? 'live' : 'settled'),
          workspaceRoot: rootDir,
          workspaceId: 'ws-14-08'
        });

      const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      const lifecycle1 = openLifecycle(sqlite1.writerConnection);
      const regRes = lifecycle1.registerArtifact({
        artifactId,
        ownerRunId: `run-${tc.label}`,
        ownerAttemptId: 'att-seed',
        sensitivity: 'content',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: artifactDigest },
        byteSize: artifactBytes.byteLength,
        mediaType: 'application/octet-stream',
        displayName: 'pinned-spec.bin',
        producerIdentity: 'test',
        locator: { storageTier: 'workspace_file', uriOrRelpath: artifactRel }
      });
      expect(regRes.ok).toBe(true);

      const handoffStore1 = createSqliteHandoffStore(sqlite1.writerConnection);
      const coordinator1 = createPhaseHandoffCoordinator({
        store: handoffStore1,
        primaryWorkspaceRoot: rootDir,
        workspaceId: 'ws-14-08',
        lifecycle: lifecycle1
      });

      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: `run-${tc.label}`,
        workflow,
        effectiveWorkflows: [workflow],
        effectivePhases: [PHASE_A, PHASE_B],
        startedAt: 1000
      });
      expect(snap.outcome).toBe('created');
      if (snap.outcome !== 'created') continue;

      let currentRun: ConnectedWorkflowRun = snap.run;
      const rootInvId = snap.rootInvocationId;
      let faultActive = false;

      const runWriter = {
        get: (id: string): ConnectedWorkflowRun | null =>
          currentRun.connectedRunId === id ? currentRun : null,
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (faultActive) {
            if (tc.faultMode === 'throw') {
              throw new Error(`injected-cas-write-failure-${tc.label}`);
            }
            return { outcome: 'stale' as const, current: currentRun };
          }
          if (currentRun.revision !== expectedRev) {
            return { outcome: 'stale' as const, current: currentRun };
          }
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      };

      const coordDeps = {
        connectedRuns: runWriter,
        phaseHandoffCoordinator: coordinator1,
        workspaceRoot: rootDir,
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => ({
          outcome: 'dispatched' as const,
          queueItemId: `q-${inp.attemptId}`
        })
      };

      // Dispatch n1, stage contribution referencing our managed artifact, complete n1 -> dispatches n2 with active handoff pin!
      const step1 = await dispatchComposableNode(coordDeps, {
        run: currentRun,
        invocationId: rootInvId,
        nodeId: 'n1',
        startedAt: 1100
      });
      expect(step1.outcome).toBe('phase-dispatched');
      if (step1.outcome !== 'phase-dispatched') continue;

      const stagingN1 = allocateAttemptStagingPaths(rootDir, currentRun.connectedRunId, step1.attemptId);
      await fsp.mkdir(path.dirname(stagingN1.contributionAbsPath), { recursive: true });
      const n1Attempt = currentRun.invocations![rootInvId]!.attemptsByNodeId['n1']![0]!;
      const normOccId = rootInvId.replace(/[^A-Za-z0-9._:-]/g, '-');
      const n1Contrib = {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: n1Attempt.nodePath.replace(/^\/+/, ''),
          occurrenceId: normOccId,
          attemptId: step1.attemptId
        },
        coverage: 'complete' as const,
        outcomes: ['Prepared artifact for n2'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      };
      await fsp.writeFile(stagingN1.contributionAbsPath, JSON.stringify(n1Contrib), 'utf8');

      const step2 = await completeComposableNodeAttempt(coordDeps, {
        run: currentRun,
        invocationId: rootInvId,
        nodeId: 'n1',
        attemptIndex: n1Attempt.attemptIndex,
        status: 'completed',
        completedAt: 1200,
        declaredOutputs: {
          spec: { portId: 'spec', type: 'file', value: artifactRel }
        }
      });
      expect(step2.outcome).toBe('phase-dispatched');

      // Confirm protective handoff reference is active before terminal transition.
      const refsBefore = lifecycle1.listReferences(artifactId);
      expect(refsBefore.ok).toBe(true);
      expect(refsBefore.ok && refsBefore.value.some((r) => r.ownerType === 'handoff' && r.active)).toBe(
        true
      );

      // Inject fault on terminal exit!
      faultActive = true;
      const n2Attempt = currentRun.invocations![rootInvId]!.attemptsByNodeId['n2']![0]!;
      if (tc.exitMode === 'control-cancel') {
        const controlService = new WorkflowControlService({
          connectedRuns: runWriter,
          phaseHandoffCoordinator: coordinator1,
          workspaceRoot: rootDir,
          dispatchPhase: coordDeps.dispatchPhase
        });
        if (tc.faultMode === 'throw') {
          await expect(
            controlService.executeCommand({
              runId: currentRun.connectedRunId,
              commandId: `cmd-cancel-${tc.label}`,
              expectedRevision: currentRun.revision,
              operation: 'cancel',
              now: 1300
            })
          ).rejects.toThrow(`injected-cas-write-failure-${tc.label}`);
        } else {
          const cancelRes = await controlService.executeCommand({
            runId: currentRun.connectedRunId,
            commandId: `cmd-cancel-${tc.label}`,
            expectedRevision: currentRun.revision,
            operation: 'cancel',
            now: 1300
          });
          expect(cancelRes.accepted).toBe(false);
          expect(!cancelRes.accepted && cancelRes.refusalCode).toBe('stale-revision');
        }
      } else if (tc.faultMode === 'throw') {
        await expect(
          completeComposableNodeAttempt(coordDeps, {
            run: currentRun,
            invocationId: rootInvId,
            nodeId: 'n2',
            attemptIndex: n2Attempt.attemptIndex,
            status: tc.exitMode,
            completedAt: 1300
          })
        ).rejects.toThrow(`injected-cas-write-failure-${tc.label}`);
      } else {
        const staleRes = await completeComposableNodeAttempt(coordDeps, {
          run: currentRun,
          invocationId: rootInvId,
          nodeId: 'n2',
          attemptIndex: n2Attempt.attemptIndex,
          status: tc.exitMode,
          completedAt: 1300
        });
        expect(staleRes.outcome).toBe('rejected-stale');
      }

      // Close and REOPEN SQLite store, then run retention deletion against the artifact!
      sqlite1.close();
      const sqlite2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      const lifecycle2 = openLifecycle(sqlite2.writerConnection);

      const refsAfterReopen = lifecycle2.listReferences(artifactId);
      expect(refsAfterReopen.ok).toBe(true);
      expect(
        refsAfterReopen.ok && refsAfterReopen.value.some((r) => r.ownerType === 'handoff' && r.active)
      ).toBe(true);
      expect(lifecycle2.isProtected(artifactId).protected).toBe(true);

      const preview = lifecycle2.previewDeletion({ artifactIds: [artifactId] });
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.value.summary.protectedCount).toBeGreaterThanOrEqual(1);
        expect(preview.value.summary.affectedCount).toBe(0);
        await lifecycle2.executeDeletion({
          artifactIds: [artifactId],
          previewId: preview.value.previewId,
          confirmation: 'confirmed',
          authority: { trusted: true, primary: true, auditHealthy: true }
        });
      }
      // Artifact bytes MUST survive retention on disk!
      expect(await fsp.readFile(artifactAbs)).toEqual(artifactBytes);

      // Now clear the fault and commit the winning terminal transition -> pins MUST release!
      faultActive = false;
      const coordinator2 = createPhaseHandoffCoordinator({
        store: createSqliteHandoffStore(sqlite2.writerConnection),
        primaryWorkspaceRoot: rootDir,
        workspaceId: 'ws-14-08',
        lifecycle: lifecycle2
      });
      if (tc.exitMode === 'control-cancel') {
        const controlService2 = new WorkflowControlService({
          connectedRuns: runWriter,
          phaseHandoffCoordinator: coordinator2,
          workspaceRoot: rootDir,
          dispatchPhase: coordDeps.dispatchPhase
        });
        const okCancel = await controlService2.executeCommand({
          runId: currentRun.connectedRunId,
          commandId: `cmd-cancel-win-${tc.label}`,
          expectedRevision: currentRun.revision,
          operation: 'cancel',
          now: 1400
        });
        expect(okCancel.accepted).toBe(true);
      } else {
        const winRes = await completeComposableNodeAttempt(
          { ...coordDeps, phaseHandoffCoordinator: coordinator2 },
          {
            run: currentRun,
            invocationId: rootInvId,
            nodeId: 'n2',
            attemptIndex: n2Attempt.attemptIndex,
            status: tc.exitMode,
            completedAt: 1400
          }
        );
        expect(winRes.outcome).not.toBe('rejected-stale');
      }

      const refsAfterWin = lifecycle2.listReferences(artifactId);
      expect(refsAfterWin.ok).toBe(true);
      expect(
        refsAfterWin.ok && refsAfterWin.value.some((r) => r.ownerType === 'handoff' && r.active)
      ).toBe(false);
      expect(lifecycle2.isProtected(artifactId).protected).toBe(false);

      sqlite2.close();
    }
  });

  it('14-08: reconciles interrupted post-commit terminal pin cleanup idempotently across repeated recoveries while keeping non-terminal runs pinned', async () => {
    const rootDir = await makeTempDir('f15b-14-08-rec-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(rootDir),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: (ownerKind) => (ownerKind === 'handoff' ? 'live' : 'settled'),
      workspaceRoot: rootDir,
      workspaceId: 'ws-rec'
    });
    const coordinator = createPhaseHandoffCoordinator({
      store: createSqliteHandoffStore(sqlite.writerConnection),
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-rec',
      lifecycle
    });

    const workflow: WorkflowDefinition = {
      workflowId: 'wf-rec-pins',
      name: 'Recovery Pin Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'from-n1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };

    const runs = new Map<string, ConnectedWorkflowRun>();
    let staleNextRecoveryCas = false;
    const store = {
      get: (id: string) => runs.get(id) ?? null,
      list: () => [...runs.values()],
      async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
        const cur = runs.get(next.connectedRunId) ?? null;
        if (staleNextRecoveryCas || cur === null || cur.revision !== expectedRev) {
          return { outcome: 'stale' as const, current: cur };
        }
        const updated = Object.freeze({ ...next, revision: expectedRev + 1 });
        runs.set(updated.connectedRunId, updated);
        return { outcome: 'written' as const, run: updated };
      }
    };

    const setupRunAtN2 = async (runId: string) => {
      const payloadBytes = Buffer.from([0x00, 0x01, ...Buffer.from(`payload-${runId}`, 'utf8')]);
      const digest = sha256Hex(payloadBytes);
      const artifactId = `out-spec-${digest.slice(0, 8)}`;
      const artifactRel = `.schegent/reports/${artifactId}.bin`;
      const artifactAbs = path.join(rootDir, artifactRel);
      await fsp.mkdir(path.dirname(artifactAbs), { recursive: true });
      await fsp.writeFile(artifactAbs, payloadBytes);

      lifecycle.registerArtifact({
        artifactId,
        ownerRunId: runId,
        ownerAttemptId: `att-${runId}`,
        sensitivity: 'content',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: digest },
        byteSize: payloadBytes.byteLength,
        mediaType: 'application/octet-stream',
        displayName: `${artifactId}.bin`,
        producerIdentity: 'test',
        locator: { storageTier: 'workspace_file', uriOrRelpath: artifactRel }
      });
      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: runId,
        workflow,
        effectiveWorkflows: [workflow],
        effectivePhases: [PHASE_A, PHASE_B],
        startedAt: 1000
      });
      if (snap.outcome !== 'created') throw new Error('snapshot failed');
      runs.set(runId, snap.run);

      const deps = {
        connectedRuns: store,
        phaseHandoffCoordinator: coordinator,
        workspaceRoot: rootDir,
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => ({
          outcome: 'dispatched' as const,
          queueItemId: `q-${inp.attemptId}`
        })
      };
      const s1 = await dispatchComposableNode(deps, {
        run: runs.get(runId)!,
        invocationId: snap.rootInvocationId,
        nodeId: 'n1',
        startedAt: 1100
      });
      if (s1.outcome !== 'phase-dispatched') throw new Error('dispatch n1 failed');
      const staging = allocateAttemptStagingPaths(rootDir, runId, s1.attemptId);
      await fsp.mkdir(path.dirname(staging.contributionAbsPath), { recursive: true });
      const n1Att = runs.get(runId)!.invocations![snap.rootInvocationId]!.attemptsByNodeId['n1']![0]!;
      await fsp.writeFile(
        staging.contributionAbsPath,
        JSON.stringify({
          schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
          producer: {
            nodePath: n1Att.nodePath.replace(/^\/+/, ''),
            occurrenceId: snap.rootInvocationId.replace(/[^A-Za-z0-9._:-]/g, '-'),
            attemptId: s1.attemptId
          },
          coverage: 'complete',
          outcomes: ['done n1'],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: null,
          artifacts: []
        }),
        'utf8'
      );
      const s2 = await completeComposableNodeAttempt(deps, {
        run: runs.get(runId)!,
        invocationId: snap.rootInvocationId,
        nodeId: 'n1',
        attemptIndex: n1Att.attemptIndex,
        status: 'completed',
        completedAt: 1200,
        declaredOutputs: {
          spec: { portId: 'spec', type: 'file', value: artifactRel }
        }
      });
      if (s2.outcome !== 'phase-dispatched') throw new Error('advance n2 failed');
      return { rootInvId: snap.rootInvocationId, deps, artifactId };
    };

    // Run 1: wins terminal CAS commit, then crashes BEFORE pin cleanup (simulated via deferTerminalPinRelease: true).
    const r1 = await setupRunAtN2('run-interrupted-terminal');
    const r1N2 = runs.get('run-interrupted-terminal')!.invocations![r1.rootInvId]!.attemptsByNodeId['n2']![0]!;
    const r1Done = await completeComposableNodeAttempt(
      { ...r1.deps, deferTerminalPinRelease: true },
      {
        run: runs.get('run-interrupted-terminal')!,
        invocationId: r1.rootInvId,
        nodeId: 'n2',
        attemptIndex: r1N2.attemptIndex,
        status: 'completed',
        completedAt: 1300
      }
    );
    expect(r1Done.outcome).toBe('workflow-completed');
    expect(lifecycle.isProtected(r1.artifactId).protected).toBe(true);

    // Run 2: stays non-terminal (paused after interruption); MUST remain pinned!
    const r2 = await setupRunAtN2('run-still-active');
    expect(lifecycle.isProtected(r2.artifactId).protected).toBe(true);

    // Run 3: orphaned queue/task -> canceled during recovery (Branch 2).
    const r3 = await setupRunAtN2('run-orphaned');
    expect(lifecycle.isProtected(r3.artifactId).protected).toBe(true);

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      phaseHandoffCoordinator: coordinator,
      dispatchPhase: async (inp) => ({ outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` }),
      isQueueOrTaskPresent: (_q, runId) => runId !== 'run-orphaned'
    });

    // First test stale CAS on Branch 2 (orphaned run) -> pin MUST NOT release on stale!
    staleNextRecoveryCas = true;
    await recovery.reconcileRun('run-orphaned', 2000);
    expect(lifecycle.isProtected(r3.artifactId).protected).toBe(true);
    staleNextRecoveryCas = false;

    // Run recovery TWICE across all runs -> terminal runs released idempotently, non-terminal run stays pinned!
    await recovery.reconcileAllRuns(2100);
    expect(lifecycle.isProtected(r1.artifactId).protected).toBe(false);
    expect(lifecycle.isProtected(r3.artifactId).protected).toBe(false);
    expect(lifecycle.isProtected(r2.artifactId).protected).toBe(true);

    await recovery.reconcileAllRuns(2200);
    expect(lifecycle.isProtected(r1.artifactId).protected).toBe(false);
    expect(lifecycle.isProtected(r3.artifactId).protected).toBe(false);
    expect(lifecycle.isProtected(r2.artifactId).protected).toBe(true);

    sqlite.close();
  });

  it('14-09: reloadFromStore clears stale in-memory state and resolves a restored handoffId reusing (runId, invocationId, targetNodeId)', async () => {
    const rootDir = await makeTempDir('f15b-14-09-restore-');
    const sqlite = SqliteApplicationStore.openInMemory();
    let clockMs = 1_700_000_000_000;
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => {
      clockMs += 1000;
      return clockMs;
    });
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-restore'
    });

    const workflow: WorkflowDefinition = {
      workflowId: 'wf-restore',
      name: 'Restore Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'from-n1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-reused-id',
      workflow,
      effectiveWorkflows: [workflow],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    const rootInvId = snap.rootInvocationId;
    const frame = snap.run.invocations![rootInvId]!;
    const frameNodePath = frame.nodePath.replace(/^\/+/, '') || 'root';
    const n1Attempt = {
      attemptId: 'att-n1-before-restore',
      attemptIndex: 1,
      rootRunId: snap.run.connectedRunId,
      invocationId: rootInvId,
      parentInvocationId: null,
      nodePath: `${frameNodePath}/n1`,
      nodeId: 'n1',
      nodeKind: 'phase' as const,
      targetDefinitionId: 'phase-a',
      status: 'completed' as const,
      startedAt: 1010,
      completedAt: 1020,
      inputEnvelope: {
        envelopeId: 'env-n1',
        invocationId: rootInvId,
        targetNodeId: 'n1',
        source: 'launch' as const,
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1005
      },
      declaredOutputs: {}
    };

    expect(
      (await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: n1Attempt })).ok
    ).toBe(true);
    const prepBefore = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow,
      connection: workflow.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: n1Attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepBefore.kind).toBe('accepted');
    if (prepBefore.kind !== 'accepted') return;
    const preRestoreHandoffId = prepBefore.handoffId;
    expect(
      coordinator.resolvePendingHandoffForTarget(snap.run.connectedRunId, rootInvId, 'n2')
    ).toBe(preRestoreHandoffId);

    // Simulate in-place SQLite backup restore replacing the row with a different handoffId for the same (runId, invocationId, targetNodeId).
    const preRow = sqlite.writerConnection.get<{
      record_json: string;
      record_bytes: number;
      created_at_ms: number;
      updated_at_ms: number;
    }>(
      `SELECT record_json, record_bytes, created_at_ms, updated_at_ms FROM phase_handoff_records WHERE handoff_id = ?`,
      preRestoreHandoffId
    );
    expect(preRow).toBeDefined();
    const restoredHandoffId = 'handoff-restored-replacement-id';
    const parsedEnv = JSON.parse(preRow!.record_json) as {
      record: { handoffId: string };
    };
    parsedEnv.record.handoffId = restoredHandoffId;
    const restoredJson = JSON.stringify(parsedEnv);
    sqlite.writerConnection.run(`DELETE FROM phase_handoff_records WHERE handoff_id = ?`, preRestoreHandoffId);
    sqlite.writerConnection.run(
      `INSERT INTO phase_handoff_records (
        handoff_id, run_id, source_attempt_id, target_phase_id,
        revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'accepted', ?, ?, ?, ?)`,
      restoredHandoffId,
      snap.run.connectedRunId,
      n1Attempt.attemptId,
      'n2',
      restoredJson,
      Buffer.byteLength(restoredJson, 'utf8'),
      preRow!.created_at_ms,
      preRow!.updated_at_ms + 5000
    );

    coordinator.reloadFromStore();
    expect(
      coordinator.resolvePendingHandoffForTarget(snap.run.connectedRunId, rootInvId, 'n2')
    ).toBe(restoredHandoffId);

    sqlite.close();
  });
});
