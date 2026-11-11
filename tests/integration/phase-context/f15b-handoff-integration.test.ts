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
});
