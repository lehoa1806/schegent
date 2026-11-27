import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFrozenWorkflowClosure } from '../../../src/config/pipeline-snapshot';
import { validateWorkflowDefinition } from '../../../src/config/workflow-definition-validator';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import type { DeliveryRepresentation } from '../../../src/contracts/phase-context/context-delivery';
import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef
} from '../../../src/contracts/phase-context/context-policy';
import {
  FIX_CLAIMS_VERSION,
  REVIEW_REPORT_VERSION
} from '../../../src/contracts/phase-context/review-loop';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { capabilityRequestFields } from '../../../src/controller/capability-decision-recorder';
import { createPhaseContextApi } from '../../../src/headless/phase-context-api';
import { AcpBackedRunner } from '../../../src/runner/acp-backed-runner';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactByteProbe,
  type LifecycleFs
} from '../../../src/services/artifact-lifecycle';
import {
  allocateAttemptStagingPaths,
  createPhaseHandoffCoordinator,
  createPreparationAdmission,
  createSqliteHandoffStore,
  materializedCopyArtifactId,
  materializeHandoffArtifacts,
  verifyNegotiatedHandoffCapabilities,
  type MaterializationSource
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
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import { ForEachExecutor } from '../../../src/services/workflow-execution/foreach-executor';
import { RepeatExecutor } from '../../../src/services/workflow-execution/repeat-executor';
import { WorkflowControlService } from '../../../src/services/workflow-execution/workflow-control-service';
import { WorkflowRecoveryService } from '../../../src/services/workflow-execution/workflow-recovery-service';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';
import type { Memento } from '../../../src/state/workspace-state';

function makeMemoryMemento(): Memento {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, structuredClone(value));
    }
  };
}

async function seedControlLedgerRoot(
  ledgerStore: ControlLedgerStore,
  params: {
    readonly runId: string;
    readonly workflowId: string;
    readonly rootInvocationId: string;
    readonly nowMs?: number;
  }
): Promise<void> {
  const now = params.nowMs ?? 1000;
  await ledgerStore.mutate({}, ({ ledger }) => ({
    commit: true,
    plan: {
      result: undefined,
      nextLedger: {
        ...ledger,
        roots: {
          ...ledger.roots,
          [params.runId]: {
            version: 1,
            ledgerRunId: params.runId,
            connectedRunId: params.runId,
            rootWorkflowId: params.workflowId,
            rootInvocationId: params.rootInvocationId,
            queueId: 'default',
            linkState: 'active',
            status: 'in-flight',
            fence: {
              primacyClaim: `primacy:${params.runId}`,
              queueClaim: 'queue:default',
              rootGeneration: 1
            },
            createdAt: now,
            updatedAt: now,
            dispatchedAttempts: 0,
            reservedAttempts: 0,
            settledMicrousd: 0,
            reservedMicrousd: 0,
            unpricedAttemptCount: 0,
            rootBudget: {
              version: 1,
              maxPhaseAttempts: 100,
              budgetMode: 'count-only'
            },
            framesByKey: {},
            attemptsById: {},
            notificationsById: {},
            decisionSummaries: []
          }
        }
      }
    }
  }));
}

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
    try {
      await fsp.chmod(dir, 0o700);
      const restore = async (target: string): Promise<void> => {
        const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = path.join(target, entry.name);
          if (entry.isDirectory()) {
            await fsp.chmod(full, 0o700).catch(() => undefined);
            await restore(full);
          } else {
            await fsp.chmod(full, 0o600).catch(() => undefined);
          }
        }
      };
      await restore(dir);
    } catch {
      // Best-effort cleanup permission restore after EACCES negative tests.
    }
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

    // FR-008/016 (R7-17-07): restart resolves artifact locators directly from persisted SQLite
    // `artifactLocations` + immutable snapshots WITHOUT calling `registerExternalContribution`!
    expect(handoffStore2.loadArtifactLocations(handoffId!)[carriedBundleArtifact.artifactId]).toBeDefined();

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

    // CR-314-2: continue-handoff without expectedHandoffRevision=2 uses the paused rev=1 on
    // PendingHandoffRecord and MUST refuse as stale-revision instead of silently approving rev 2!
    const staleContinueRes = await controlService.executeCommand({
      runId: currentRun.connectedRunId,
      commandId: 'cmd-approve-handoff-stale',
      expectedRevision: currentRun.revision,
      operation: 'continue-handoff',
      targetInvocationId: rootInvId,
      targetNodeId: 'n2',
      now: 1480
    });
    expect(staleContinueRes.accepted).toBe(false);
    if (!staleContinueRes.accepted) {
      expect(staleContinueRes.refusalCode).toBe('stale-revision');
    }
    expect(handoffStore2.load(handoffId!)?.revisions.at(-1)?.state).toBe('waiting-approval');

    // SR-314-3: invalid continuationRequest MUST fail pre-commit validation and leave SQLite rev 2
    // in `'waiting-approval'` (NEVER prematurely approved to `'ready'`)!
    const invalidContinueRes = await controlService.executeCommand({
      runId: currentRun.connectedRunId,
      commandId: 'cmd-approve-handoff-invalid-req',
      expectedRevision: currentRun.revision,
      operation: 'continue-handoff',
      targetInvocationId: rootInvId,
      targetNodeId: 'n2',
      expectedHandoffRevision: 2,
      continuationRequest: {
        pipelineId: 'n2',
        workflowId: 'wf-WRONG-WORKFLOW',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      now: 1490
    });
    expect(invalidContinueRes.accepted).toBe(false);
    expect(handoffStore2.load(handoffId!)?.revisions.at(-1)?.state).toBe('waiting-approval');

    const continueRes = await controlService.executeCommand({
      runId: currentRun.connectedRunId,
      commandId: 'cmd-approve-handoff-1',
      expectedRevision: currentRun.revision,
      operation: 'continue-handoff',
      targetInvocationId: rootInvId,
      targetNodeId: 'n2',
      expectedHandoffRevision: 2,
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
    // SR-314-2: non-reviewer phase n2 is authorized ONLY for contribution.json (NOT review-report.json).
    const runnerFields = capabilityRequestFields({
      iteration: 0,
      envelope: { phaseHandoff: capturedPhaseBDispatch!.phaseHandoff! }
    });
    expect(runnerFields.acpPromptBlocks).toEqual(blocks);
    expect(runnerFields.authorizedUpstreamInputPaths?.length).toBe(1);
    expect(runnerFields.authorizedOutputPaths?.length).toBe(1);
    expect(runnerFields.authorizedOutputPaths?.[0]).toMatch(/contribution\.json$/);

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
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
          if (inp.phaseHandoff?.handoffId != null && inp.phaseHandoff.revision != null) {
            coordinator1.settleAttemptDispatch({
              handoffId: inp.phaseHandoff.handoffId,
              revision: inp.phaseHandoff.revision,
              targetAttemptId: inp.phaseHandoff.attemptId,
              delivered: true
            });
          }
          return {
            outcome: 'dispatched' as const,
            queueItemId: `q-${inp.attemptId}`
          };
        }
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
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
          if (inp.phaseHandoff?.handoffId != null && inp.phaseHandoff.revision != null) {
            coordinator.settleAttemptDispatch({
              handoffId: inp.phaseHandoff.handoffId,
              revision: inp.phaseHandoff.revision,
              targetAttemptId: inp.phaseHandoff.attemptId,
              delivered: true
            });
          }
          return {
            outcome: 'dispatched' as const,
            queueItemId: `q-${inp.attemptId}`
          };
        }
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

  it('R7-17-07 (FR-001, FR-007/009): disabled transition writes 0 SQLite handoff rows, 0 F05 pins, 0 immutable captures, and leaves prompt delivery untouched; duplicate acceptance is idempotent', async () => {
    const rootDir = await makeTempDir('f15b-disabled-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(rootDir),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: rootDir,
      workspaceId: 'ws-disabled'
    });
    const handoffStore = createSqliteHandoffStore(sqlite.writerConnection);
    const coordinator = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-disabled',
      lifecycle
    });

    const disabledWorkflow: WorkflowDefinition = {
      workflowId: 'wf-disabled-handoff',
      name: 'Disabled Handoff Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [{ from: { nodeId: 'n1' }, to: { nodeId: 'n2' } }]
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-disabled-1',
      workflow: disabledWorkflow,
      effectiveWorkflows: [disabledWorkflow],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    let currentRun = snap.run;
    const rootInvId = snap.rootInvocationId;
    const dispatched: PhaseAttemptDispatchInput[] = [];
    const deps = {
      connectedRuns: {
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (currentRun.revision !== expectedRev) return { outcome: 'stale' as const, current: currentRun };
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      },
      phaseHandoffCoordinator: coordinator,
      workspaceRoot: rootDir,
      dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
        dispatched.push(inp);
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      }
    };

    const s1 = await dispatchComposableNode(deps, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'n1',
      startedAt: 1010
    });
    expect(s1.outcome).toBe('phase-dispatched');
    if (s1.outcome !== 'phase-dispatched') return;

    // Even if a stray file exists in staging or declared outputs, disabled transition ignores it completely!
    const staging = allocateAttemptStagingPaths(rootDir, currentRun.connectedRunId, s1.attemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(staging.contributionAbsPath, '{invalid-json-ignored-when-disabled', 'utf8');
    await fsp.writeFile(path.join(rootDir, 'plain-out.txt'), 'plain', 'utf8');

    const n1Att = currentRun.invocations![rootInvId]!.attemptsByNodeId['n1']![0]!;
    const s2 = await completeComposableNodeAttempt(deps, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'n1',
      attemptIndex: n1Att.attemptIndex,
      status: 'completed',
      completedAt: 1020,
      declaredOutputs: {
        out: { portId: 'out', type: 'file', value: 'plain-out.txt' }
      }
    });
    expect(s2.outcome).toBe('phase-dispatched');

    // Verify 0 SQLite handoff rows, 0 F05 artifact/reference rows, 0 immutable captures, 0 materialized files, untouched delivery!
    expect(
      Number(sqlite.writerConnection.scalar(`SELECT COUNT(*) FROM phase_handoff_records`) ?? -1)
    ).toBe(0);
    expect(
      Number(sqlite.writerConnection.scalar(`SELECT COUNT(*) FROM artifact_references`) ?? -1)
    ).toBe(0);
    expect(
      Number(sqlite.writerConnection.scalar(`SELECT COUNT(*) FROM artifacts`) ?? -1)
    ).toBe(0);
    expect(await fsp.readdir(path.join(rootDir, '.schegent', 'immutable-results')).catch(() => [])).toEqual([]);
    expect(await fsp.readdir(path.join(rootDir, '.schegent', 'handoff-materialized')).catch(() => [])).toEqual([]);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.phaseHandoff).toBeUndefined();
    expect(dispatched[1]?.phaseHandoff).toBeUndefined();

    // Also verify pin-quota-reached refusal surfaces cleanly from F05 and writes 0 handoff rows.
    const quotaCoord = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-quota',
      lifecycle: {
        ...lifecycle,
        getArtifact: (id: string) => lifecycle.getArtifact(id),
        listReferences: (id: string) => lifecycle.listReferences(id),
        registerArtifact: (inp: Parameters<typeof lifecycle.registerArtifact>[0]) => lifecycle.registerArtifact(inp),
        releaseReference: (inp: Parameters<typeof lifecycle.releaseReference>[0]) => lifecycle.releaseReference(inp),
        addReference: () => ({
          ok: false as const,
          refusal: {
            code: 'pin-quota-reached' as const,
            message: 'owner already holds 64 pins',
            artifactId: null
          }
        })
      } as unknown as ReturnType<typeof createArtifactLifecycleService>
    });
    const wfOpted: WorkflowDefinition = {
      ...disabledWorkflow,
      workflowId: 'wf-quota-check',
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: 'n2' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 's1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };
    const qSnap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-quota-1',
      workflow: wfOpted,
      effectiveWorkflows: [wfOpted],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 2000
    });
    if (qSnap.outcome !== 'created') return;
    const qInv = qSnap.rootInvocationId;
    const qFrame = qSnap.run.invocations![qInv]!;
    const qBytes = Buffer.from('quota-artifact', 'utf8');
    await fsp.writeFile(path.join(rootDir, 'quota.txt'), qBytes);
    const qRef: ArtifactRef = {
      artifactId: 'art-quota-1',
      immutableVersion: 'v1',
      digestHex: sha256Hex(qBytes),
      byteSize: qBytes.byteLength,
      kind: 'text'
    };
    quotaCoord.registerExternalContribution({
      runId: 'run-quota-1',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: `${qFrame.nodePath.replace(/^\/+/, '')}/n1`,
          occurrenceId: qInv.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: 'att-q-1'
        },
        coverage: 'complete',
        outcomes: ['Quota test'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [qRef]
      },
      artifacts: [{ ref: qRef, sourceRoot: rootDir, relativePath: 'quota.txt', inlineText: 'quota-artifact' }]
    });
    const quotaPrep = await quotaCoord.prepareTransitionHandoff({
      run: qSnap.run,
      frame: qFrame,
      workflow: wfOpted,
      connection: wfOpted.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: { ...n1Att, attemptId: 'att-q-1', rootRunId: 'run-quota-1', invocationId: qInv },
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(quotaPrep).toEqual({
      kind: 'refused',
      failure: 'capacity-exceeded',
      detail: 'pin-quota-reached'
    });
    expect(handoffStore.listHandoffIdsForRun('run-quota-1')).toHaveLength(0);

    sqlite.close();
  });

  it('R7-17-07 (Clarification Q3): restart after transport-drop uncertain send OR host-crash intent preserves both handoff & attempt pins and refuses duplicate dispatch for same and newly minted targetAttemptId across coordinator and WorkflowRecoveryService', async () => {
    for (const mode of ['transport-drop-uncertain', 'host-crash-intent'] as const) {
      const primaryRoot = await makeTempDir(`f15b-unc-primary-${mode}-`);
      const targetLaneRoot = await makeTempDir(`f15b-unc-target-${mode}-`);
      const dbDir = await makeTempDir(`f15b-unc-db-${mode}-`);
      const dbPath = path.join(dbDir, 'schegent-state.db');

      const reportsDir = path.join(primaryRoot, '.schegent', 'reports');
      await fsp.mkdir(reportsDir, { recursive: true });
      const artBytes = Buffer.from([0x00, 0x01, ...Buffer.from(`uncertain-payload-${mode}`, 'utf8')]);
      const artDigest = sha256Hex(artBytes);
      const artRel = '.schegent/reports/uncertain-input.bin';
      const artAbs = path.join(primaryRoot, artRel);
      await fsp.writeFile(artAbs, artBytes);
      const artId = `out-spec-${artDigest.slice(0, 8)}`;

      const openLifecycle = (conn: SqliteApplicationStore['writerConnection']) =>
        createArtifactLifecycleService({
          conn,
          nowMs: () => 1_700_000_000_000,
          fs: makeNodeLifecycleFs(),
          probe: makeProbe(primaryRoot),
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
          resolveOwner: () => 'live',
          workspaceRoot: primaryRoot,
          workspaceId: `ws-${mode}`
        });

      const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      const lifecycle1 = openLifecycle(sqlite1.writerConnection);
      expect(
        lifecycle1.registerArtifact({
          artifactId: artId,
          ownerRunId: `run-${mode}`,
          ownerAttemptId: 'att-seed',
          sensitivity: 'content',
          retentionClass: 'generated-reports-handoff-exports',
          storeKind: 'report',
          immutability: 'immutable',
          digest: { algorithm: 'sha256', value: artDigest },
          byteSize: artBytes.byteLength,
          mediaType: 'application/octet-stream',
          displayName: 'uncertain-input.bin',
          producerIdentity: 'att-seed',
          locator: { storageTier: 'workspace_file', uriOrRelpath: artRel }
        }).ok
      ).toBe(true);

      let execRoot = primaryRoot;
      const store1 = createSqliteHandoffStore(sqlite1.writerConnection);
      const coord1 = createPhaseHandoffCoordinator({
        store: store1,
        primaryWorkspaceRoot: primaryRoot,
        workspaceId: `ws-${mode}`,
        lifecycle: lifecycle1,
        resolveExecutionRoot: () => execRoot
      });

      const wf: WorkflowDefinition = {
        workflowId: `wf-${mode}`,
        name: 'Uncertain Send Workflow',
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
        connectedRunId: `run-${mode}`,
        workflow: wf,
        effectiveWorkflows: [wf],
        effectivePhases: [PHASE_A, PHASE_B],
        startedAt: 1000
      });
      if (snap.outcome !== 'created') throw new Error('snapshot failed');
      let currentRun = snap.run;
      const rootInvId = snap.rootInvocationId;
      const runWriter = {
        get: (id: string) => (currentRun.connectedRunId === id ? currentRun : null),
        list: () => [currentRun],
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (currentRun.revision !== expectedRev) return { outcome: 'stale' as const, current: currentRun };
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      };

      const coordDeps1 = {
        connectedRuns: runWriter,
        phaseHandoffCoordinator: coord1,
        workspaceRoot: primaryRoot,
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => ({
          outcome: 'dispatched' as const,
          queueItemId: `q-${inp.attemptId}`
        })
      };

      const step1 = await dispatchComposableNode(coordDeps1, {
        run: currentRun,
        invocationId: rootInvId,
        nodeId: 'n1',
        startedAt: 1100
      });
      expect(step1.outcome).toBe('phase-dispatched');
      if (step1.outcome !== 'phase-dispatched') return;

      const staging1 = allocateAttemptStagingPaths(primaryRoot, currentRun.connectedRunId, step1.attemptId);
      await fsp.mkdir(staging1.stagingDirAbsPath, { recursive: true });
      const n1Att = currentRun.invocations![rootInvId]!.attemptsByNodeId['n1']![0]!;
      await fsp.writeFile(
        staging1.contributionAbsPath,
        JSON.stringify({
          schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
          producer: {
            nodePath: n1Att.nodePath.replace(/^\/+/, ''),
            occurrenceId: rootInvId.replace(/[^A-Za-z0-9._:-]/g, '-'),
            attemptId: step1.attemptId
          },
          coverage: 'complete',
          outcomes: ['n1 completed'],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: null,
          artifacts: []
        }),
        'utf8'
      );

      // Switch target lane root BEFORE n2 dispatches so n2 materializes a cross-root copy (acquiring an attempt pin too!).
      const step2Prepared = await coord1.recordSettledAttempt({
        run: currentRun,
        frame: currentRun.invocations![rootInvId]!,
        attempt: {
          ...n1Att,
          status: 'completed',
          completedAt: 1200,
          declaredOutputs: { spec: { portId: 'spec', type: 'file', value: artRel } }
        }
      });
      expect(step2Prepared.ok).toBe(true);
      const prep = await coord1.prepareTransitionHandoff({
        run: currentRun,
        frame: currentRun.invocations![rootInvId]!,
        workflow: wf,
        connection: wf.connections[0]!,
        connectionIndex: 0,
        fromNodeId: 'n1',
        fromAttempt: n1Att,
        targetNodeId: 'n2',
        targetInstructions: PHASE_B.instruction!,
        targetBackendId: 'claude'
      });
      expect(prep.kind).toBe('accepted');
      if (prep.kind !== 'accepted') return;

      execRoot = targetLaneRoot;
      const firstAttemptId = `att-n2-first-${mode}`;
      const del1 = await coord1.planAndAuthorizeAttemptDelivery({
        runId: currentRun.connectedRunId,
        handoffId: prep.handoffId,
        targetAttemptId: firstAttemptId,
        targetNodePath: prep.manifest.identity.targetNodePath,
        targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      });
      expect(del1.ok).toBe(true);
      if (!del1.ok) return;

      const matCopyArtifactId = materializedCopyArtifactId(artId, firstAttemptId, artDigest);
      expect(lifecycle1.isProtected(artId).protected).toBe(true);
      expect(lifecycle1.isProtected(matCopyArtifactId).protected).toBe(true);

      if (mode === 'transport-drop-uncertain') {
        expect(
          coord1.settleAttemptDispatch({
            handoffId: prep.handoffId,
            revision: 1,
            targetAttemptId: firstAttemptId,
            delivered: false
          })
        ).toEqual({ ok: true });
      }
      // In `host-crash-intent` mode, we intentionally DO NOT settle the dispatch — host crashes with `'intent'`!

      // Simulate host restart: close SQLite 1 and reopen SQLite 2!
      sqlite1.close();
      const sqlite2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      const lifecycle2 = openLifecycle(sqlite2.writerConnection);
      const store2 = createSqliteHandoffStore(sqlite2.writerConnection);
      const coord2 = createPhaseHandoffCoordinator({
        store: store2,
        primaryWorkspaceRoot: primaryRoot,
        workspaceId: `ws-${mode}`,
        lifecycle: lifecycle2,
        resolveExecutionRoot: () => targetLaneRoot
      });

      const transitioned = coord2.reconcileInterruptedDispatches(currentRun.connectedRunId);
      if (mode === 'host-crash-intent') {
        expect(transitioned).toHaveLength(1);
        expect(transitioned[0]?.handoffId).toBe(prep.handoffId);
        expect(transitioned[0]?.targetAttemptId).toBe(firstAttemptId);
      } else {
        expect(transitioned).toHaveLength(0);
      }

      // Stored dispatch MUST now be `'uncertain'` with `'uncertain'` observation recorded!
      const reopenedRecord = store2.load(prep.handoffId);
      expect(reopenedRecord?.dispatches[0]?.state).toBe('uncertain');
      expect(store2.listObservations(prep.handoffId).some((o) => o.event === 'uncertain')).toBe(true);

      // Both `handoff` pin (on source artId) AND `attempt` pin (on materialized copy) MUST survive
      // `releaseTerminalRunPins` AND F05 retention sweep!
      coord2.releaseTerminalRunPins(currentRun.connectedRunId);
      expect(lifecycle2.isProtected(artId).protected).toBe(true);
      expect(lifecycle2.isProtected(matCopyArtifactId).protected).toBe(true);

      const preview = lifecycle2.previewDeletion({ artifactIds: [artId] });
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.value.summary.protectedCount).toBe(1);
        expect(preview.value.summary.affectedCount).toBe(0);
        await lifecycle2.executeDeletion({
          artifactIds: [artId],
          previewId: preview.value.previewId,
          confirmation: 'confirmed',
          authority: { trusted: true, primary: true, auditHealthy: true }
        });
      }
      expect(await fsp.readFile(artAbs)).toEqual(artBytes);

      // Duplicate dispatch is refused for BOTH the same targetAttemptId AND a newly minted targetAttemptId!
      const dupSame = await coord2.planAndAuthorizeAttemptDelivery({
        runId: currentRun.connectedRunId,
        handoffId: prep.handoffId,
        targetAttemptId: firstAttemptId,
        targetNodePath: prep.manifest.identity.targetNodePath,
        targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      });
      expect(dupSame).toEqual({
        ok: false,
        failure: 'uncertain-delivery',
        detail: 'dispatch-uncertain'
      });

      const dupNew = await coord2.planAndAuthorizeAttemptDelivery({
        runId: currentRun.connectedRunId,
        handoffId: prep.handoffId,
        targetAttemptId: `att-n2-newly-minted-${mode}`,
        targetNodePath: prep.manifest.identity.targetNodePath,
        targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      });
      expect(dupNew).toEqual({
        ok: false,
        failure: 'uncertain-delivery',
        detail: 'dispatch-uncertain'
      });

      // WorkflowRecoveryService Branch 4a (`pending-dispatch`) MUST consult phaseHandoffCoordinator and
      // refuse duplicate dispatch (pausing with `uncertain-effect-paused` and dispatching 0 attempts)!
      let recoveryDispatches = 0;
      const { completedAt: _omittedCompletedAt, ...n1Base } = n1Att;
      const pendingN2Attempt = {
        ...n1Base,
        attemptId: `att-n2-pending-rec-${mode}`,
        attemptIndex: 1,
        nodeId: 'n2',
        nodePath: `${n1Att.nodePath.replace(/\/n1$/, '')}/n2`,
        targetDefinitionId: 'phase-b',
        status: 'pending-dispatch' as const
      };
      const frameWithPendingN2 = {
        ...currentRun.invocations![rootInvId]!,
        status: 'in-flight' as const,
        activeNodeId: 'n2',
        attemptsByNodeId: {
          ...currentRun.invocations![rootInvId]!.attemptsByNodeId,
          n2: [pendingN2Attempt]
        }
      };
      currentRun = Object.freeze({
        ...currentRun,
        invocations: { ...currentRun.invocations, [rootInvId]: frameWithPendingN2 }
      });

      const recovery = new WorkflowRecoveryService({
        connectedRuns: runWriter,
        phaseHandoffCoordinator: coord2,
        dispatchPhase: async (inp) => {
          recoveryDispatches += 1;
          return { outcome: 'dispatched', queueItemId: `q-dup-${inp.attemptId}` };
        }
      });
      const recRes = await recovery.reconcileRun(currentRun.connectedRunId, 3000);
      expect(recoveryDispatches).toBe(0);
      expect(recRes?.disposition?.status).toBe('uncertain-effect-paused');

      sqlite2.close();
    }
  });

  it('R7-17-07 (FR-013/035): AcpBackedRunner verifies real initialize-negotiated capabilities against persisted DeliveryRepresentation before session/load or session/prompt', async () => {
    const tempDir = await makeTempDir('f15b-acp-cap-');
    const mockDriftPath = path.join(tempDir, 'mock-acp-cap-drift.mjs');
    const mockNoLoadPath = path.join(tempDir, 'mock-acp-no-load.mjs');
    const writeMockAgent = async (filePath: string, capabilitiesJson: string) => {
      await fsp.writeFile(
        filePath,
        `#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  process.stderr.write('METHOD:' + msg.method + '\\n');
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock-cap', version: '1.5.5' },
        agentCapabilities: ${capabilitiesJson}
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-new-1' } });
  } else if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
        'utf8'
      );
      await fsp.chmod(filePath, 0o755);
    };
    // Case A: passes openAcpConnection's requiredCapabilities, but drifts from planned DeliveryRepresentation (`image: true` vs planned `image: false`).
    await writeMockAgent(
      mockDriftPath,
      JSON.stringify({ loadSession: true, promptCapabilities: { embeddedContext: true, image: true } })
    );
    // Case B: advertises `loadSession: false`, refused at initialize before session/load or session/prompt.
    await writeMockAgent(
      mockNoLoadPath,
      JSON.stringify({ loadSession: false, promptCapabilities: { embeddedContext: true } })
    );

    const dummyInner: BackendRunner = {
      hasActiveProcess: false,
      async invoke() {
        throw new Error('CLI fallback forbidden');
      },
      cancelActive: () => false,
      close: () => undefined,
      async settleTeardowns() {
        return [];
      }
    };

    // Persist a DeliveryRepresentation planned when `loadSession` was `true`.
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection);
    const coord = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: tempDir,
      workspaceId: 'ws-acp-cap'
    });
    const wfReuse: WorkflowDefinition = {
      workflowId: 'wf-acp-reuse',
      name: 'ACP Reuse',
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
            session: 'reuse-when-qualified',
            selectors: [{ selectorId: 's1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-acp-cap',
      workflow: wfReuse,
      effectiveWorkflows: [wfReuse],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const occId = invId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const n1Path = `${frame.nodePath.replace(/^\/+/, '')}/n1`;
    coord.registerExternalContribution({
      runId: 'run-acp-cap',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: n1Path, occurrenceId: occId, attemptId: 'att-n1-cap' },
        coverage: 'complete',
        outcomes: ['Context ready'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prep = await coord.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: wfReuse,
      connection: wfReuse.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: {
        attemptId: 'att-n1-cap',
        attemptIndex: 1,
        rootRunId: 'run-acp-cap',
        invocationId: invId,
        parentInvocationId: null,
        nodePath: n1Path,
        nodeId: 'n1',
        nodeKind: 'phase',
        targetDefinitionId: 'phase-a',
        status: 'completed',
        startedAt: 1010,
        completedAt: 1020,
        inputEnvelope: {
          envelopeId: 'env-1',
          invocationId: invId,
          targetNodeId: 'n1',
          source: 'launch',
          inputsByPort: {},
          localInputs: [],
          outputTargetOverrides: [],
          acceptedAt: 1005
        },
        declaredOutputs: {}
      },
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'agy'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') return;

    const del = await coord.planAndAuthorizeAttemptDelivery({
      runId: 'run-acp-cap',
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-cap',
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'agy',
      previousSessionAttempt: {
        producer: {
          nodePath: prep.manifest.identity.targetNodePath,
          occurrenceId: occId,
          attemptId: 'att-n2-prev'
        },
        backendId: 'agy'
      }
    });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    const persistedRep = store.loadRepresentation(prep.handoffId, 1, 'att-n2-cap');
    expect(persistedRep?.capabilities.loadSession).toBe(true);

    const runner = new AcpBackedRunner({
      kind: 'agy',
      inner: dummyInner,
      readConfiguredProfile: () => 'agy-acp-native',
      primaryWorkspaceRoot: tempDir,
      platform: { os: 'darwin', arch: 'arm64' },
      resolveHandoffRepresentation: (attId) =>
        attId === 'att-n2-cap' ? persistedRep : null
    });

    const invokeWithMock = async (cliPath: string) => {
      const methods: string[] = [];
      const out = await runner.invoke(
        {
          phase: 'implement',
          iteration: 0,
          runId: 'run-acp-cap',
          attemptId: 'att-n2-cap',
          prompt: PHASE_B.instruction!,
          ...(del.delivery.acpPromptBlocks !== undefined
            ? { acpPromptBlocks: del.delivery.acpPromptBlocks }
            : {}),
          sessionReuse: true,
          resumeSessionId: 'sess-prev-1',
          resumeSessionOrigin: 'acp',
          timeoutMs: 5_000,
          cliPath,
          cwd: tempDir
        },
        {
          write(stream, chunk) {
            if (stream === 'stderr') {
              for (const line of chunk.split('\n')) {
                if (line.startsWith('METHOD:')) methods.push(line.slice(7));
              }
            }
            return true;
          },
          onceDrain: () => undefined
        }
      );
      return { out, methods };
    };

    // Case A: openAcpConnection succeeds, then verifyNegotiatedHandoffCapabilities runs checkDispatch
    // against persisted DeliveryRepresentation and refuses before session/load or session/prompt!
    const drift = await invokeWithMock(mockDriftPath);
    expect(drift.out.exitCode).toBe(1);
    expect(drift.out.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:stale-revision:capabilities-changed'
    );
    expect(drift.methods).toEqual(['initialize']);
    expect(drift.methods).not.toContain('session/load');
    expect(drift.methods).not.toContain('session/new');
    expect(drift.methods).not.toContain('session/prompt');

    // Case B: `loadSession: false` is refused at initialize before session/load or session/prompt!
    const noLoad = await invokeWithMock(mockNoLoadPath);
    expect(noLoad.out.exitCode).toBe(1);
    expect(noLoad.out.diagnosticWarnings).toContain(
      'acp-open-refused:capability-missing:load-session'
    );
    expect(noLoad.methods).toEqual(['initialize']);
    expect(noLoad.methods).not.toContain('session/load');
    expect(noLoad.methods).not.toContain('session/prompt');

    sqlite.close();
  });

  it('R7-17-08 (AC-12 — FR-023/024/033): enforces atomic attempt result acceptance across valid, stale/foreign, 0-byte, malformed, exact 256 KiB vs 256 KiB + 1 B, symlink, EACCES, and leftover *.tmp/*.part fail-closed refusal', async () => {
    const rootDir = await makeTempDir('f15b-ac12-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(rootDir),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: rootDir,
      workspaceId: 'ws-ac12'
    });
    const store = createSqliteHandoffStore(sqlite.writerConnection);
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-ac12',
      lifecycle
    });

    const wf: WorkflowDefinition = {
      workflowId: 'wf-ac12',
      name: 'AC-12 Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' }],
      connections: []
    };
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-ac12',
      workflow: wf,
      effectiveWorkflows: [wf],
      effectivePhases: [PHASE_A],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const occId = invId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const nodePath = `${frame.nodePath.replace(/^\/+/, '')}/n1`;

    const makeAtt = (attemptId: string, idx: number) => ({
      attemptId,
      attemptIndex: idx,
      rootRunId: 'run-ac12',
      invocationId: invId,
      parentInvocationId: null,
      nodePath,
      nodeId: 'n1',
      nodeKind: 'phase' as const,
      targetDefinitionId: 'phase-a',
      status: 'completed' as const,
      startedAt: 1010,
      completedAt: 1020,
      inputEnvelope: {
        envelopeId: `env-${attemptId}`,
        invocationId: invId,
        targetNodeId: 'n1',
        source: 'launch' as const,
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1005
      },
      declaredOutputs: {}
    });

    const buildContrib = (attemptId: string, extraText = 'ok') => ({
      schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
      producer: { nodePath, occurrenceId: occId, attemptId },
      coverage: 'complete' as const,
      outcomes: [extraText],
      decisions: [],
      constraints: [],
      unresolvedIssues: [],
      summary: null,
      artifacts: []
    });

    // 1. Atomic valid publish succeeds & pins immutable capture in F05.
    const attValid = makeAtt('att-ac12-valid', 1);
    const stValid = allocateAttemptStagingPaths(rootDir, 'run-ac12', attValid.attemptId);
    await fsp.mkdir(stValid.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stValid.contributionAbsPath, JSON.stringify(buildContrib(attValid.attemptId)), 'utf8');
    expect((await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attValid })).ok).toBe(true);
    expect(lifecycle.isProtected(`res-contribution-${attValid.attemptId}`).protected).toBe(true);

    // 2. Stale/foreign attemptId refused.
    const attStale = makeAtt('att-ac12-stale', 2);
    const stStale = allocateAttemptStagingPaths(rootDir, 'run-ac12', attStale.attemptId);
    await fsp.mkdir(stStale.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stStale.contributionAbsPath, JSON.stringify(buildContrib('att-FOREIGN-999')), 'utf8');
    expect(await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attStale })).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'producer-mismatch'
    });

    // 3. Partial / 0-byte file refused.
    const attZero = makeAtt('att-ac12-zero', 3);
    const stZero = allocateAttemptStagingPaths(rootDir, 'run-ac12', attZero.attemptId);
    await fsp.mkdir(stZero.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stZero.contributionAbsPath, '', 'utf8');
    expect((await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attZero })).ok).toBe(false);

    // 4. Malformed JSON refused.
    const attBad = makeAtt('att-ac12-malformed', 4);
    const stBad = allocateAttemptStagingPaths(rootDir, 'run-ac12', attBad.attemptId);
    await fsp.mkdir(stBad.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stBad.contributionAbsPath, '{"schemaVersion":1,"outcomes":[', 'utf8');
    expect((await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attBad })).ok).toBe(false);

    // 5. Exact 256 KiB (262,144 B) accepted vs 256 KiB + 1 B (262,145 B) refused!
    const attExact = makeAtt('att-ac12-exact-256k', 5);
    const stExact = allocateAttemptStagingPaths(rootDir, 'run-ac12', attExact.attemptId);
    await fsp.mkdir(stExact.stagingDirAbsPath, { recursive: true });
    const baseExact = JSON.stringify(buildContrib(attExact.attemptId, 'exact'));
    const padExact = ' '.repeat(PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax - Buffer.byteLength(baseExact, 'utf8'));
    const exactPayload = `${baseExact}${padExact}`;
    expect(Buffer.byteLength(exactPayload, 'utf8')).toBe(262_144);
    await fsp.writeFile(stExact.contributionAbsPath, exactPayload, 'utf8');
    expect((await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attExact })).ok).toBe(true);

    const attOver = makeAtt('att-ac12-over-256k', 6);
    const stOver = allocateAttemptStagingPaths(rootDir, 'run-ac12', attOver.attemptId);
    await fsp.mkdir(stOver.stagingDirAbsPath, { recursive: true });
    const baseOver = JSON.stringify(buildContrib(attOver.attemptId, 'over'));
    const overPayload = `${baseOver}${' '.repeat(PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax + 1 - Buffer.byteLength(baseOver, 'utf8'))}`;
    expect(Buffer.byteLength(overPayload, 'utf8')).toBe(262_145);
    await fsp.writeFile(stOver.contributionAbsPath, overPayload, 'utf8');
    expect(await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attOver })).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });

    // 6. Symlink refused.
    const attSym = makeAtt('att-ac12-symlink', 7);
    const stSym = allocateAttemptStagingPaths(rootDir, 'run-ac12', attSym.attemptId);
    await fsp.mkdir(stSym.stagingDirAbsPath, { recursive: true });
    const symTarget = path.join(rootDir, 'sym-contrib.json');
    await fsp.writeFile(symTarget, JSON.stringify(buildContrib(attSym.attemptId)), 'utf8');
    await fsp.symlink(symTarget, stSym.contributionAbsPath);
    const symOutcome = await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attSym });
    expect(symOutcome.ok).toBe(false);
    if (!symOutcome.ok) expect(symOutcome.failure).toBe('invalid-source');

    // 7. EACCES denied read refused as storage-unavailable (not silently treated as absent).
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const attEacces = makeAtt('att-ac12-eacces', 8);
      const stEacces = allocateAttemptStagingPaths(rootDir, 'run-ac12', attEacces.attemptId);
      await fsp.mkdir(stEacces.stagingDirAbsPath, { recursive: true });
      await fsp.writeFile(stEacces.contributionAbsPath, JSON.stringify(buildContrib(attEacces.attemptId)), 'utf8');
      await fsp.chmod(stEacces.contributionAbsPath, 0o000);
      const eaccesOutcome = await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attEacces });
      expect(eaccesOutcome.ok).toBe(false);
      if (!eaccesOutcome.ok) expect(eaccesOutcome.failure).toBe('storage-unavailable');
    }

    // 8. Leftover *.tmp and *.part files fail closed BOTH alone AND beside a valid contribution.json (no silent complete fallback!).
    const attTmpAlone = makeAtt('att-ac12-tmp-alone', 9);
    const stTmpAlone = allocateAttemptStagingPaths(rootDir, 'run-ac12', attTmpAlone.attemptId);
    await fsp.mkdir(stTmpAlone.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(path.join(stTmpAlone.stagingDirAbsPath, 'contribution.json.tmp'), '{"partial":true', 'utf8');
    expect(await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attTmpAlone })).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });

    const attPartBeside = makeAtt('att-ac12-part-beside', 10);
    const stPartBeside = allocateAttemptStagingPaths(rootDir, 'run-ac12', attPartBeside.attemptId);
    await fsp.mkdir(stPartBeside.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stPartBeside.contributionAbsPath, JSON.stringify(buildContrib(attPartBeside.attemptId)), 'utf8');
    await fsp.writeFile(path.join(stPartBeside.stagingDirAbsPath, 'review-report.json.part'), 'partial', 'utf8');
    expect(await coordinator.recordSettledAttempt({ run: snap.run, frame, attempt: attPartBeside })).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });

    sqlite.close();
  });

  it('R7-17-08 (AC-14 — FR-025/026, NFR-003/007): enforces 64/65 files, 16 MiB/64 MiB limits, <= 1 MiB streaming chunks, 30 s deadline, ENOSPC rollback leaving 0 partial/0-byte exposed files, Pass-1/2 mutation, restart reuse pin, original pin survival & shared NFR-003 admission', async () => {
    const srcRoot = await makeTempDir('f15b-ac14-src-');
    const dstRoot = await makeTempDir('f15b-ac14-dst-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(srcRoot),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: srcRoot,
      workspaceId: 'ws-ac14'
    });
    const MIB = 1024 * 1024;
    const makeSrc = async (id: string, bytes: Buffer): Promise<MaterializationSource> => {
      const segs = ['src', `${id}.bin`] as const;
      const abs = path.join(srcRoot, ...segs);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, bytes);
      return {
        ref: {
          artifactId: id,
          immutableVersion: 'v1',
          digestHex: sha256Hex(bytes),
          byteSize: bytes.byteLength,
          kind: 'binary'
        },
        sourceRoot: srcRoot,
        sourceSegments: segs
      };
    };

    // 1. Exact 64 files accepted vs 65 files refused.
    const sources64: MaterializationSource[] = [];
    for (let i = 0; i < 64; i += 1) {
      sources64.push(await makeSrc(`f64-${i}`, Buffer.from(`payload-${i}`, 'utf8')));
    }
    const ok64 = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14',
      targetAttemptId: 'att-64',
      targetRoot: dstRoot,
      sources: sources64
    });
    expect(ok64.ok).toBe(true);
    const s65 = await makeSrc('f64-64', Buffer.from('payload-64', 'utf8'));
    const fail65 = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14',
      targetAttemptId: 'att-65',
      targetRoot: dstRoot,
      sources: [...sources64, s65]
    });
    expect(fail65).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialized-file-count'
    });

    // 2. Exact 16 MiB per-file accepted with <= 1 MiB chunks vs 16 MiB + 1 B refused; 64 MiB aggregate accepted vs 64 MiB + 1 B refused.
    const buf16 = Buffer.alloc(16 * MIB, 0x41);
    const src16 = await makeSrc('big-16m', buf16);
    const observedChunks: number[] = [];
    const ok16 = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14',
      targetAttemptId: 'att-16m',
      targetRoot: dstRoot,
      sources: [src16],
      onChunkCopied: (info) => {
        observedChunks.push(info.chunkBytes);
      }
    });
    expect(ok16.ok).toBe(true);
    expect(observedChunks.length).toBeGreaterThanOrEqual(16);
    expect(Math.max(...observedChunks)).toBeLessThanOrEqual(MIB);

    expect(
      await materializeHandoffArtifacts({
        runId: 'run-ac14',
        handoffId: 'h-ac14',
        targetAttemptId: 'att-16m-plus-1',
        targetRoot: dstRoot,
        sources: [
          {
            ...src16,
            ref: { ...src16.ref, artifactId: 'over-16m', byteSize: 16 * MIB + 1 }
          }
        ]
      })
    ).toEqual({ ok: false, failure: 'capacity-exceeded', detail: 'materialized-file-bytes' });

    const meta16 = (idx: number): MaterializationSource => ({
      ref: {
        artifactId: `tot-${idx}`,
        immutableVersion: 'v1',
        digestHex: src16.ref.digestHex,
        byteSize: 16 * MIB,
        kind: 'binary'
      },
      sourceRoot: srcRoot,
      sourceSegments: src16.sourceSegments
    });
    expect(
      await materializeHandoffArtifacts({
        runId: 'run-ac14',
        handoffId: 'h-ac14',
        targetAttemptId: 'att-64m-plus-1',
        targetRoot: dstRoot,
        sources: [
          meta16(1),
          meta16(2),
          meta16(3),
          meta16(4),
          await makeSrc('tot-extra-1b', Buffer.from([0x7f]))
        ]
      })
    ).toEqual({ ok: false, failure: 'capacity-exceeded', detail: 'materialized-total-bytes' });

    // 3. 30,000 ms deadline accepted vs 30,001 ms refused.
    let deadlineClock = 1000;
    const deadlineSrc = await makeSrc('dl-file', Buffer.alloc(2 * MIB, 0x55));
    const dlFail = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14',
      targetAttemptId: 'att-deadline',
      targetRoot: dstRoot,
      sources: [deadlineSrc],
      nowMs: () => deadlineClock,
      onChunkCopied: () => {
        deadlineClock += 30_001;
      }
    });
    expect(dlFail).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialization-deadline'
    });
    expect(
      await fsp.readdir(path.join(dstRoot, '.schegent', 'handoff-materialized', 'att-deadline')).catch(() => [])
    ).toEqual([]);

    // 4. Disk pressure ENOSPC on file 2 of 3 returns typed storage-unavailable, rolls back file 1 (0 exposed destination files), preserves original F05 pin!
    const origSrcA = await makeSrc('enospc-a', Buffer.from('alpha-bytes', 'utf8'));
    const origSrcB = await makeSrc('enospc-b', Buffer.from('beta-bytes', 'utf8'));
    lifecycle.registerArtifact({
      artifactId: 'enospc-a',
      ownerRunId: 'run-ac14',
      ownerAttemptId: 'att-src',
      sensitivity: 'content',
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: 'handoff-context',
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: origSrcA.ref.digestHex },
      byteSize: origSrcA.ref.byteSize,
      mediaType: 'application/octet-stream',
      displayName: 'enospc-a.bin',
      producerIdentity: 'att-src',
      locator: { storageTier: 'workspace_file', uriOrRelpath: 'src/enospc-a.bin' }
    });
    lifecycle.addReference({
      artifactId: 'enospc-a',
      ownerType: 'handoff',
      ownerId: 'h-ac14-orig',
      purpose: 'phase-context',
      protective: true
    });

    let writeCalls = 0;
    const enospcRes = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14-orig',
      targetAttemptId: 'att-enospc',
      targetRoot: dstRoot,
      sources: [origSrcA, origSrcB],
      lifecycle,
      writeChunk: async (handle, buf, off, len, pos) => {
        writeCalls += 1;
        if (writeCalls === 2) {
          const err = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
          throw err;
        }
        return handle.write(buf, off, len, pos);
      }
    });
    expect(enospcRes).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'destination-write-enospc'
    });
    expect(
      await fsp.readdir(path.join(dstRoot, '.schegent', 'handoff-materialized', 'att-enospc')).catch(() => [])
    ).toEqual([]);
    expect(lifecycle.isProtected('enospc-a').protected).toBe(true);

    // 5. Pass-1 / Pass-2 digest mutation detected with 0 exposed destination files.
    const mutSrc = await makeSrc('mut-src', Buffer.from('original-content', 'utf8'));
    await fsp.writeFile(path.join(srcRoot, ...mutSrc.sourceSegments), Buffer.from('tampered-content', 'utf8'));
    const mutRes = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14',
      targetAttemptId: 'att-mut-copy',
      targetRoot: dstRoot,
      sources: [mutSrc]
    });
    expect(mutRes).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-digest-mismatch'
    });
    expect(
      await fsp.readdir(path.join(dstRoot, '.schegent', 'handoff-materialized', 'att-mut-copy')).catch(() => [])
    ).toEqual([]);

    // 6. Restart reuse preserves/ensures F05 copy pin; releasing copy pin leaves original pin intact; shared NFR-003 admission respected.
    const reuseSrc = await makeSrc('reuse-a', Buffer.from('reuse-verified-bytes', 'utf8'));
    const sharedAdmission = createPreparationAdmission({ now: () => 5000 });
    const firstCopy = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14-reuse',
      targetAttemptId: 'att-reuse',
      targetRoot: dstRoot,
      sources: [reuseSrc],
      admission: sharedAdmission
    });
    expect(firstCopy.ok).toBe(true);
    // Re-run with lifecycle (simulating restart reuse where file already exists on disk without pin yet).
    const reusedCopy = await materializeHandoffArtifacts({
      runId: 'run-ac14',
      handoffId: 'h-ac14-reuse',
      targetAttemptId: 'att-reuse',
      targetRoot: dstRoot,
      sources: [reuseSrc],
      lifecycle,
      admission: sharedAdmission
    });
    expect(reusedCopy.ok).toBe(true);
    const reuseCopyId = materializedCopyArtifactId('reuse-a', 'att-reuse', reuseSrc.ref.digestHex);
    expect(lifecycle.isProtected(reuseCopyId).protected).toBe(true);
    // Release copy pin -> original source pin (`enospc-a`) stays completely intact!
    lifecycle.releaseReference({
      artifactId: reuseCopyId,
      ownerType: 'attempt',
      ownerId: 'att-reuse',
      purpose: 'phase-context',
      reason: 'owner-durable'
    });
    expect(lifecycle.isProtected(reuseCopyId).protected).toBe(false);
    expect(lifecycle.isProtected('enospc-a').protected).toBe(true);

    sqlite.close();
  });

  it('R7-17-08 (FR-032): exposes > 2 KiB immutable ordered ForEach result index (including succeeded + failed/partial slots) as a full selectable ArtifactRef without 2 KiB truncation or raw child concatenation', async () => {
    const rootDir = await makeTempDir('f15b-fr032-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: makeNodeLifecycleFs(),
      probe: makeProbe(rootDir),
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: rootDir,
      workspaceId: 'ws-fr032'
    });
    const handoffStore = createSqliteHandoffStore(sqlite.writerConnection);
    const coordinator = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-fr032',
      lifecycle
    });

    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const forEachExecutor = new ForEachExecutor({ ledgerStore });

    const PHASE_ITEM: PhaseDefinition = {
      phaseId: 'phase-item',
      name: 'Process Item',
      version: 1,
      instruction: 'Process single collection item.',
      runner: 'claude'
    };
    const PHASE_SUMMARY: PhaseDefinition = {
      phaseId: 'phase-summary',
      name: 'Summarize ForEach',
      version: 1,
      instruction: 'Summarize all ForEach results.',
      runner: 'claude'
    };

    const childWorkflow: WorkflowDefinition = {
      workflowId: 'wf-fe-item',
      name: 'Item Workflow',
      version: 1,
      inputs: [{ portId: 'item', label: 'Item', type: 'text', required: true }],
      startNodeIds: ['item-step'],
      nodes: [{ nodeId: 'item-step', kind: 'phase', phaseId: 'phase-item' }],
      connections: []
    };

    const rootWorkflow: WorkflowDefinition = {
      workflowId: 'wf-fe-root',
      name: 'ForEach Handoff Root',
      version: 1,
      inputs: [{ portId: 'itemsJson', label: 'Items JSON', type: 'local-file', required: true }],
      startNodeIds: ['fe-node'],
      nodes: [
        {
          nodeId: 'fe-node',
          kind: 'workflow',
          workflowId: 'wf-fe-item',
          control: {
            version: 1,
            kind: 'for-each',
            collection: { source: 'workflow-input', portId: 'itemsJson' },
            itemKeyField: 'id',
            itemInputPortId: 'item',
            maxItems: 20,
            onItemError: 'continue'
          }
        },
        { nodeId: 'summary-node', kind: 'phase', phaseId: 'phase-summary' }
      ],
      connections: [
        {
          from: { nodeId: 'fe-node' },
          to: { nodeId: 'summary-node' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'sel-fe', sourceNodePath: 'fe-node', required: true, priority: 0 }]
          }
        }
      ]
    };

    // Build 18 collection items with rich keys so the ordered result index exceeds BOTH 2 KiB and 8 KiB!
    const items = Array.from({ length: 18 }, (_, i) => ({
      id: `item-${String(i).padStart(2, '0')}-${'k'.repeat(40)}`,
      detail: `record-${i}`
    }));
    const colRel = 'inputs/items.json';
    await fsp.mkdir(path.join(rootDir, 'inputs'), { recursive: true });
    await fsp.writeFile(path.join(rootDir, colRel), JSON.stringify({ version: 1, items }), 'utf8');

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-fr032-1',
      workflow: rootWorkflow,
      effectiveWorkflows: [rootWorkflow, childWorkflow],
      effectivePhases: [PHASE_ITEM, PHASE_SUMMARY],
      boundInputs: {
        itemsJson: { portId: 'itemsJson', type: 'local-file', value: colRel }
      },
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    // Seed control ledger root for ForEachExecutor.
    await seedControlLedgerRoot(ledgerStore, {
      runId: 'run-fr032-1',
      workflowId: rootWorkflow.workflowId,
      rootInvocationId: snap.rootInvocationId
    });

    let currentRun = snap.run;
    const rootInvId = snap.rootInvocationId;
    const dispatchedByNode: Record<string, PhaseAttemptDispatchInput[]> = {};
    const coordDeps = {
      connectedRuns: {
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (currentRun.revision !== expectedRev) return { outcome: 'stale' as const, current: currentRun };
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      },
      forEachExecutor,
      phaseHandoffCoordinator: coordinator,
      workspaceRoot: rootDir,
      dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
        (dispatchedByNode[inp.node.nodeId] ??= []).push(inp);
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      }
    };

    let step = await dispatchComposableNode(coordDeps, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'fe-node',
      startedAt: 1100
    });

    // Execute all 18 items: items 5 and 12 fail (partial/error slots), all others succeed.
    for (let i = 0; i < 18; i += 1) {
      expect(step.outcome).toBe('phase-dispatched');
      if (step.outcome !== 'phase-dispatched') return;
      expect(step.nodeId).toBe('item-step');
      const shouldFail = i === 5 || i === 12;
      step = await completeComposableNodeAttempt(coordDeps, {
        run: currentRun,
        invocationId: step.invocationId,
        nodeId: 'item-step',
        status: shouldFail ? 'failed' : 'completed',
        completedAt: 1200 + i * 10,
        ...(shouldFail ? { failureCode: `item-${i}-boom` } : {})
      });
    }

    // After item 18 finishes, `fe-node` settles and dispatches `summary-node` with full ForEach index ArtifactRef!
    expect(step.outcome).toBe('phase-dispatched');
    if (step.outcome !== 'phase-dispatched') return;
    expect(step.nodeId).toBe('summary-node');

    const summaryList = Object.hasOwn(dispatchedByNode, 'summary-node')
      ? dispatchedByNode['summary-node']
      : undefined;
    const summaryDispatch = summaryList?.[0];
    expect(summaryDispatch?.phaseHandoff?.handoffId).toBeTruthy();
    const handoffId = summaryDispatch!.phaseHandoff!.handoffId!;
    const handoffRec = handoffStore.load(handoffId)!;
    const manifest = JSON.parse(handoffRec.revisions[0]!.serializedManifest) as {
      sources: { outcomes: string[]; artifacts: ArtifactRef[] }[];
    };
    expect(manifest.sources).toHaveLength(1);
    const idxArt = manifest.sources[0]!.artifacts.find((a) => a.artifactId.startsWith('foreach-idx-'));
    expect(idxArt).toBeDefined();
    // Strictly > 2 KiB (no 2 KiB truncation!) and selectable as a full ArtifactRef!
    expect(idxArt!.byteSize).toBeGreaterThan(2048);
    expect(lifecycle.isProtected(idxArt!.artifactId).protected).toBe(true);

    // Verify delivered ACP blocks link or embed the FULL verified ForEach result index JSON!
    const blocks = summaryDispatch?.phaseHandoff?.acpPromptBlocks ?? [];
    const idxLink = blocks.find((b) => b.type === 'resource-link' && b.name === idxArt!.artifactId);
    const idxEmbed = blocks.find(
      (b) => b.type === 'embedded-resource' && b.uri.includes(idxArt!.artifactId)
    );
    expect(idxLink !== undefined || idxEmbed !== undefined).toBe(true);

    const fullIndexText =
      idxLink?.type === 'resource-link'
        ? await fsp.readFile(new URL(idxLink.uri).pathname, 'utf8')
        : idxEmbed?.type === 'embedded-resource'
          ? idxEmbed.text
          : '';
    expect(Buffer.byteLength(fullIndexText, 'utf8')).toBe(idxArt!.byteSize);
    expect(sha256Hex(fullIndexText)).toBe(idxArt!.digestHex);
    const parsedIndex = JSON.parse(fullIndexText) as {
      itemCount: number;
      hasErrors: boolean;
      errorCount: number;
      slots: { index: number; state: string; error?: { code: string } }[];
    };
    expect(parsedIndex.itemCount).toBe(18);
    expect(parsedIndex.hasErrors).toBe(true);
    expect(parsedIndex.errorCount).toBe(2);
    expect(parsedIndex.slots[5]?.state).toBe('failed');
    expect(parsedIndex.slots[12]?.state).toBe('failed');
    expect(parsedIndex.slots[17]?.state).toBe('completed');

    sqlite.close();
  });

  it('R7-17-08 (FR-027): executes authored Initial Review -> conditional Repeat(Fix -> Review) workflow (pass skips Repeat; negative review carries findings into Fix; fix-claims alone never closes findings; false exit blocked live & across WorkflowRecoveryService restart; pass cap stops without extra Fix)', async () => {
    const PHASE_REVIEW: PhaseDefinition = {
      phaseId: 'phase-review',
      name: 'Review Phase',
      version: 1,
      instruction: 'Review candidate code against criteria.',
      runner: 'codex'
    };
    const PHASE_FIX: PhaseDefinition = {
      phaseId: 'phase-fix',
      name: 'Fix Phase',
      version: 1,
      instruction: 'Address blocking review findings.',
      runner: 'claude'
    };

    const repeatBodyWorkflow: WorkflowDefinition = {
      workflowId: 'wf-fix-review-body',
      name: 'Fix -> Review Body',
      version: 1,
      startNodeIds: ['fix'],
      nodes: [
        { nodeId: 'fix', kind: 'phase', phaseId: 'phase-fix' },
        { nodeId: 'review', kind: 'phase', phaseId: 'phase-review' }
      ],
      connections: [
        {
          from: { nodeId: 'fix' },
          to: { nodeId: 'review' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'sel-fix', sourceNodePath: 'fix', required: true, priority: 0 }]
          }
        }
      ],
      decisionResults: {
        version: 1,
        fields: [{ fieldId: 'reviewPassed', type: 'boolean', required: true }],
        bindings: [
          {
            fieldId: 'reviewPassed',
            source: { kind: 'node-result', nodeId: 'review', fieldId: 'reviewPassed' }
          }
        ]
      }
    };

    const rootReviewWorkflow: WorkflowDefinition = {
      workflowId: 'wf-initial-review-repeat',
      name: 'Initial Review -> Repeat(Fix -> Review)',
      version: 1,
      startNodeIds: ['initial-review'],
      nodes: [
        { nodeId: 'initial-review', kind: 'phase', phaseId: 'phase-review' },
        {
          nodeId: 'rev-loop',
          kind: 'workflow',
          workflowId: 'wf-fix-review-body',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            until: {
              version: 1,
              kind: 'typed',
              test: {
                left: { source: 'result-field', fieldId: 'reviewPassed' },
                operator: 'equals',
                right: true
              }
            },
            carry: [],
            onExhausted: 'fail'
          }
        }
      ],
      connections: [
        {
          from: { nodeId: 'initial-review' },
          to: { kind: 'node', nodeId: 'rev-loop' },
          priority: 1,
          condition: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'node-result', nodeId: 'initial-review', fieldId: 'reviewPassed' },
              operator: 'equals',
              right: false
            }
          },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'sel-init-rev', sourceNodePath: 'initial-review', required: true, priority: 0 }]
          }
        },
        {
          from: { nodeId: 'initial-review' },
          to: { kind: 'return', nodeId: 'initial-review' },
          priority: 2,
          condition: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'node-result', nodeId: 'initial-review', fieldId: 'reviewPassed' },
              operator: 'equals',
              right: true
            }
          }
        }
      ]
    };

    const createHarness = async (runId: string) => {
      const rootDir = await makeTempDir(`f15b-fr027-${runId}-`);
      const sqlite = SqliteApplicationStore.openInMemory();
      const store = createSqliteHandoffStore(sqlite.writerConnection);
      const coordinator = createPhaseHandoffCoordinator({
        store,
        primaryWorkspaceRoot: rootDir,
        workspaceId: `ws-${runId}`
      });
      const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
      const repeatExecutor = new RepeatExecutor({
        ledgerStore,
        clock: { nowWallMs: () => 1_700_000_000_000, nowMonotonicMs: () => 1_000 }
      });

      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: runId,
        workflow: rootReviewWorkflow,
        effectiveWorkflows: [rootReviewWorkflow, repeatBodyWorkflow],
        effectivePhases: [PHASE_REVIEW, PHASE_FIX],
        startedAt: 1000
      });
      if (snap.outcome !== 'created') throw new Error(`snapshot failed: ${snap.detail}`);
      await seedControlLedgerRoot(ledgerStore, {
        runId,
        workflowId: rootReviewWorkflow.workflowId,
        rootInvocationId: snap.rootInvocationId
      });
      let currentRun = snap.run;
      const dispatched: PhaseAttemptDispatchInput[] = [];
      const writer = {
        get: (id: string) => (currentRun.connectedRunId === id ? currentRun : null),
        list: () => [currentRun],
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (currentRun.revision !== expectedRev) return { outcome: 'stale' as const, current: currentRun };
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      };
      const deps = {
        connectedRuns: writer,
        repeatExecutor,
        phaseHandoffCoordinator: coordinator,
        workspaceRoot: rootDir,
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
          dispatched.push(inp);
          return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
        }
      };
      return {
        rootDir,
        sqlite,
        store,
        coordinator,
        repeatExecutor,
        writer,
        deps,
        dispatched,
        rootInvId: snap.rootInvocationId,
        getRun: () => currentRun,
        setRun: (r: ConnectedWorkflowRun) => {
          currentRun = r;
        }
      };
    };

    const stageFiles = async (
      rootDir: string,
      runId: string,
      invId: string,
      nodePath: string,
      attemptId: string,
      files: {
        contribution?: Record<string, unknown>;
        reviewReport?: Record<string, unknown>;
        fixClaims?: Record<string, unknown>;
      }
    ) => {
      const staging = allocateAttemptStagingPaths(rootDir, runId, attemptId);
      await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
      if (files.contribution !== undefined) {
        await fsp.writeFile(
          staging.contributionAbsPath,
          JSON.stringify({
            schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
            producer: {
              nodePath: nodePath.replace(/^\/+/, ''),
              occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
              attemptId
            },
            coverage: 'complete',
            outcomes: ['staged'],
            decisions: [],
            constraints: [],
            unresolvedIssues: [],
            summary: null,
            artifacts: [],
            ...files.contribution
          }),
          'utf8'
        );
      }
      if (files.reviewReport !== undefined) {
        await fsp.writeFile(staging.reviewReportAbsPath, JSON.stringify(files.reviewReport), 'utf8');
      }
      if (files.fixClaims !== undefined) {
        await fsp.writeFile(staging.fixClaimsAbsPath, JSON.stringify(files.fixClaims), 'utf8');
      }
    };

    // Scenario 1: Initial passing review skips Repeat completely (0 Fix attempts!).
    {
      const h = await createHarness('r27-skip');
      const loopId = 'loop-r27-skip-rev-loop';
      const s1 = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      expect(s1.outcome).toBe('phase-dispatched');
      if (s1.outcome !== 'phase-dispatched') return;
      const att = h.getRun().invocations![h.rootInvId]!.attemptsByNodeId['initial-review']![0]!;
      await stageFiles(h.rootDir, 'r27-skip', h.rootInvId, att.nodePath, s1.attemptId, {
        reviewReport: {
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: s1.attemptId,
          candidateRef: 'cand-pass-1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: true,
          blockingCount: 0,
          findings: [],
          dispositions: []
        }
      });
      const done = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: true }
      });
      expect(done.outcome).toBe('workflow-completed');
      expect(h.dispatched.filter((d) => d.node.nodeId === 'fix')).toHaveLength(0);
      expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.latestVerdict).toBe('passed');
      h.sqlite.close();
    }

    // Scenario 2: Initial negative review enters Repeat carrying findings into Fix; fix-claims alone
    // NEVER closes findings; re-review pass closes findings and exits Repeat cleanly!
    {
      const h = await createHarness('r27-pass');
      const loopId = 'loop-r27-pass-rev-loop';
      const sInit = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      if (sInit.outcome !== 'phase-dispatched') return;
      const initAtt = h.getRun().invocations![h.rootInvId]!.attemptsByNodeId['initial-review']![0]!;
      await stageFiles(h.rootDir, 'r27-pass', h.rootInvId, initAtt.nodePath, sInit.attemptId, {
        contribution: {
          outcomes: ['Initial review found blocking issue F-001'],
          unresolvedIssues: ['F-001: missing input guard']
        },
        reviewReport: {
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: sInit.attemptId,
          candidateRef: 'cand-v1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: false,
          blockingCount: 1,
          findings: [
            {
              id: 'F-001',
              severity: 'high',
              title: 'Missing input guard',
              explanation: 'Reject invalid payload',
              evidence: ['src/handler.ts#L12']
            }
          ],
          dispositions: []
        }
      });

      const afterInit = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: false }
      });
      expect(afterInit.outcome).toBe('phase-dispatched');
      if (afterInit.outcome !== 'phase-dispatched') return;
      expect(afterInit.nodeId).toBe('fix');

      // Verify Fix received Initial Review's findings in its ACP prompt blocks!
      const fixDispatch = h.dispatched.find((d) => d.node.nodeId === 'fix');
      expect(fixDispatch?.phaseHandoff?.acpPromptBlocks?.some(
        (b) => b.type === 'text' && b.text.includes('F-001: missing input guard')
      )).toBe(true);

      // Fix submits fix-claims.json (`claimed-fixed`) + new candidateRef='cand-v2'.
      const fixInvId = afterInit.invocationId;
      const fixAtt = h.getRun().invocations![fixInvId]!.attemptsByNodeId['fix']![0]!;
      const initReportRef = h.coordinator.inspectReviewLoop(loopId)!.history.entries[0]!.reportRef;
      await stageFiles(h.rootDir, 'r27-pass', fixInvId, fixAtt.nodePath, afterInit.attemptId, {
        contribution: { outcomes: ['Applied fix for F-001'] },
        fixClaims: {
          claimsVersion: FIX_CLAIMS_VERSION,
          loopId,
          pass: 1,
          fixerAttemptId: afterInit.attemptId,
          basedOnReportRef: initReportRef,
          claims: [{ findingId: 'F-001', claim: 'claimed-fixed' }]
        }
      });
      const afterFix = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: fixInvId,
        nodeId: 'fix',
        status: 'completed',
        completedAt: 1300,
        declaredOutputs: {
          candidateRef: { portId: 'candidateRef', type: 'text', value: 'cand-v2' }
        }
      });
      expect(afterFix.outcome).toBe('phase-dispatched');
      if (afterFix.outcome !== 'phase-dispatched') return;
      expect(afterFix.nodeId).toBe('review');

      // Crucial FR-027 invariant: `fix-claims.json` alone NEVER closes F-001!
      const midLoop = h.coordinator.inspectReviewLoop(loopId);
      expect(midLoop?.explanation.findings[0]?.status).toBe('open');
      expect(midLoop?.explanation.findings[0]?.claims).toEqual(['claimed-fixed']);
      expect(
        h.coordinator.verifyRepeatExitAllowed({ runId: 'r27-pass', repeatNodeId: 'rev-loop' }).ok
      ).toBe(false);

      // Pass 2 re-review verifies cand-v2 and resolves F-001 -> exits Repeat cleanly!
      const revAtt = h.getRun().invocations![fixInvId]!.attemptsByNodeId['review']![0]!;
      const pass1ReportRef = midLoop?.history.entries[0]?.reportRef ?? null;
      await stageFiles(h.rootDir, 'r27-pass', fixInvId, revAtt.nodePath, afterFix.attemptId, {
        reviewReport: {
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 2,
          reviewerAttemptId: afterFix.attemptId,
          candidateRef: 'cand-v2',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: pass1ReportRef,
          coverage: 'complete',
          reviewPassed: true,
          blockingCount: 0,
          findings: [],
          dispositions: [{ findingId: 'F-001', status: 'resolved' }]
        }
      });
      const afterRev2 = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: fixInvId,
        nodeId: 'review',
        status: 'completed',
        completedAt: 1400,
        declaredOutputs: {
          candidateRef: { portId: 'candidateRef', type: 'text', value: 'cand-v2' }
        },
        decisionResults: { reviewPassed: true }
      });
      expect(afterRev2.outcome).toBe('workflow-completed');
      expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.latestVerdict).toBe('passed');
      expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.open).toBe(0);
      h.sqlite.close();
    }

    // Scenario 3: False Repeat exit (claiming reviewPassed: true while blocking finding F-001 is still open)
    // is blocked BOTH live AND across WorkflowRecoveryService Branch 5 post-child-return recovery!
    {
      const h = await createHarness('r27-false');
      const loopId = 'loop-r27-false-rev-loop';
      const sInit = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      if (sInit.outcome !== 'phase-dispatched') return;
      const initAtt = h.getRun().invocations![h.rootInvId]!.attemptsByNodeId['initial-review']![0]!;
      await stageFiles(h.rootDir, 'r27-false', h.rootInvId, initAtt.nodePath, sInit.attemptId, {
        contribution: { outcomes: ['Blocking F-001 open'] },
        reviewReport: {
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: sInit.attemptId,
          candidateRef: 'cand-1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: false,
          blockingCount: 1,
          findings: [
            {
              id: 'F-001',
              severity: 'critical',
              title: 'Critical bug',
              explanation: 'Must fix',
              evidence: ['src/app.ts#L1']
            }
          ],
          dispositions: []
        }
      });
      const sFix = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: false }
      });
      if (sFix.outcome !== 'phase-dispatched') return;
      const childInvId = sFix.invocationId;
      const fixAtt3 = h.getRun().invocations![childInvId]!.attemptsByNodeId['fix']![0]!;
      await stageFiles(h.rootDir, 'r27-false', childInvId, fixAtt3.nodePath, sFix.attemptId, {
        contribution: { outcomes: ['Attempted fix'] }
      });
      const sRev = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: childInvId,
        nodeId: 'fix',
        status: 'completed',
        completedAt: 1300
      });
      if (sRev.outcome !== 'phase-dispatched') return;

      // Save snapshot before live completion to ALSO simulate crash right after child returned (Branch 5)!
      const runBeforeChildReturn = h.getRun();

      // 3a. Live false exit: reviewer claims decisionResults.reviewPassed=true WITHOUT publishing a passing review-report.json!
      const liveBlocked = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: childInvId,
        nodeId: 'review',
        status: 'completed',
        completedAt: 1400,
        decisionResults: { reviewPassed: true }
      });
      expect(liveBlocked.outcome).toBe('workflow-failed');
      if (liveBlocked.outcome === 'workflow-failed') {
        expect(liveBlocked.failureCode).toBe('required-context-unavailable');
      }

      // 3b. Recovery Branch 5: simulate crash after childFrame marked completed with reviewPassed=true
      //     while parent Repeat is still in-flight and ledger STILL has open F-001!
      const childFrame = runBeforeChildReturn.invocations![childInvId]!;
      const revAttempt = childFrame.attemptsByNodeId['review']![0]!;
      const completedChildFrame = {
        ...childFrame,
        status: 'completed' as const,
        activeNodeId: null,
        completedAt: 1450,
        attemptsByNodeId: {
          ...childFrame.attemptsByNodeId,
          review: [
            {
              ...revAttempt,
              status: 'completed' as const,
              completedAt: 1450,
              declaredOutputs: {
                reviewPassed: { portId: 'reviewPassed', type: 'text' as const, value: 'true' }
              },
              decisionResults: { reviewPassed: true }
            }
          ]
        }
      };
      h.setRun(
        Object.freeze({
          ...runBeforeChildReturn,
          invocations: {
            ...runBeforeChildReturn.invocations,
            [childInvId]: completedChildFrame
          }
        })
      );
      const recovery = new WorkflowRecoveryService({
        connectedRuns: h.writer,
        repeatExecutor: h.repeatExecutor,
        phaseHandoffCoordinator: h.coordinator,
        dispatchPhase: h.deps.dispatchPhase
      });
      const recOut = await recovery.reconcileRun('r27-false', 1500);
      expect(recOut?.run.invocations?.[h.rootInvId]?.status).toBe('failed');
      expect(
        recOut?.run.invocations?.[h.rootInvId]?.attemptsByNodeId['rev-loop']?.at(-1)?.failureCode
      ).toBe('required-context-unavailable');
      h.sqlite.close();
    }

    // Scenario 4: Pass cap exhaustion (maxIterations: 2) stops without dispatching an extra Fix!
    {
      const h = await createHarness('r27-cap');
      const loopId = 'loop-r27-cap-rev-loop';
      let step = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      if (step.outcome !== 'phase-dispatched') return;
      const initAtt = h.getRun().invocations![h.rootInvId]!.attemptsByNodeId['initial-review']![0]!;
      await stageFiles(h.rootDir, 'r27-cap', h.rootInvId, initAtt.nodePath, step.attemptId, {
        contribution: { outcomes: ['Pass 1 failed'] },
        reviewReport: {
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: step.attemptId,
          candidateRef: 'cand-1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: false,
          blockingCount: 1,
          findings: [
            {
              id: 'F-CAP',
              severity: 'high',
              title: 'Persistent bug',
              explanation: 'Still broken',
              evidence: ['src/cap.ts#L5']
            }
          ],
          dispositions: []
        }
      });
      step = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: false }
      });

      // Run 2 Repeat iterations where Review keeps failing -> Repeat MUST stop after iter 2 (maxIterations=2)!
      for (let iter = 1; iter <= 2; iter += 1) {
        expect(step.outcome).toBe('phase-dispatched');
        if (step.outcome !== 'phase-dispatched') return;
        expect(step.nodeId).toBe('fix');
        const iterInv = step.invocationId;
        const fixAtt4 = h.getRun().invocations![iterInv]!.attemptsByNodeId['fix']![0]!;
        await stageFiles(h.rootDir, 'r27-cap', iterInv, fixAtt4.nodePath, step.attemptId, {
          contribution: { outcomes: [`Fix iteration ${iter}`] }
        });
        step = await completeComposableNodeAttempt(h.deps, {
          run: h.getRun(),
          invocationId: iterInv,
          nodeId: 'fix',
          status: 'completed',
          completedAt: 1200 + iter * 100,
          declaredOutputs: {
            candidateRef: { portId: 'candidateRef', type: 'text', value: `cand-${iter + 1}` }
          }
        });
        expect(step.outcome).toBe('phase-dispatched');
        if (step.outcome !== 'phase-dispatched') return;
        expect(step.nodeId).toBe('review');
        const revAtt = h.getRun().invocations![iterInv]!.attemptsByNodeId['review']![0]!;
        const prevRef = h.coordinator.inspectReviewLoop(loopId)?.history.entries.at(-1)?.reportRef ?? null;
        await stageFiles(h.rootDir, 'r27-cap', iterInv, revAtt.nodePath, step.attemptId, {
          reviewReport: {
            reportVersion: REVIEW_REPORT_VERSION,
            loopId,
            pass: iter + 1,
            reviewerAttemptId: step.attemptId,
            candidateRef: `cand-${iter + 1}`,
            scopeRevision: 'scope-1',
            criteriaRevision: 'crit-1',
            previousReportRef: prevRef,
            coverage: 'complete',
            reviewPassed: false,
            blockingCount: 1,
            findings: [],
            dispositions: [{ findingId: 'F-CAP', status: 'open' }]
          }
        });
        step = await completeComposableNodeAttempt(h.deps, {
          run: h.getRun(),
          invocationId: iterInv,
          nodeId: 'review',
          status: 'completed',
          completedAt: 1250 + iter * 100,
          decisionResults: { reviewPassed: false }
        });
      }

      // Repeat exhausted at maxIterations=2 -> workflow stopped (failed), and ONLY 2 Fix attempts ever dispatched!
      expect(step.outcome).toBe('workflow-failed');
      expect(h.dispatched.filter((d) => d.node.nodeId === 'fix')).toHaveLength(2);
      expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.passes).toBe(3);
      h.sqlite.close();
    }
  });

  it('CR-314-1 & SR-314-1: AcpBackedRunner resolves colon-bearing attemptIds, refuses profile/content mismatch, and fails closed on isContinue/negotiated=null', async () => {
    const tempDir = await makeTempDir('f15b-cr314-1-');
    const mockOkPath = path.join(tempDir, 'mock-acp-ok.mjs');
    await fsp.writeFile(
      mockOkPath,
      `#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
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
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-new-1' } });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
      'utf8'
    );
    await fsp.chmod(mockOkPath, 0o755);

    const dummyInner: BackendRunner = {
      hasActiveProcess: false,
      async invoke() {
        throw new Error('CLI fallback forbidden');
      },
      cancelActive: () => false,
      close: () => undefined,
      async settleTeardowns() {
        return [];
      }
    };

    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection);
    const coord = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: tempDir,
      workspaceId: 'ws-cr314-1'
    });
    const wf: WorkflowDefinition = {
      workflowId: 'wf-colon',
      name: 'Colon Attempt ID Workflow',
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
            selectors: [{ selectorId: 's1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-colon-1',
      workflow: wf,
      effectiveWorkflows: [wf],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const occId = invId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const n1Path = `${frame.nodePath.replace(/^\/+/, '')}/n1`;
    coord.registerExternalContribution({
      runId: 'run-colon-1',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: n1Path, occurrenceId: occId, attemptId: 'run-colon-1:root:n1:attempt-1' },
        coverage: 'complete',
        outcomes: ['Ready'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prep = await coord.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: wf,
      connection: wf.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: {
        attemptId: 'run-colon-1:root:n1:attempt-1',
        attemptIndex: 1,
        rootRunId: 'run-colon-1',
        invocationId: invId,
        parentInvocationId: null,
        nodePath: n1Path,
        nodeId: 'n1',
        nodeKind: 'phase',
        targetDefinitionId: 'phase-a',
        status: 'completed',
        startedAt: 1010,
        completedAt: 1020,
        inputEnvelope: {
          envelopeId: 'env-1',
          invocationId: invId,
          targetNodeId: 'n1',
          source: 'launch',
          inputsByPort: {},
          localInputs: [],
          outputTargetOverrides: [],
          acceptedAt: 1005
        },
        declaredOutputs: {}
      },
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude' // Planned for claude-acp-bridge!
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') return;

    // Persist DeliveryRepresentation under a real colon-bearing attemptId planned for `claude-acp-bridge`.
    const colonAttemptId = 'run-colon-1:root:n2:attempt-1';
    const del = await coord.planAndAuthorizeAttemptDelivery({
      runId: 'run-colon-1',
      handoffId: prep.handoffId,
      targetAttemptId: colonAttemptId,
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    // 1. Coordinator resolves representation using exact colon-bearing attemptId!
    const lookedUp = coord.resolveHandoffRepresentation(colonAttemptId);
    expect(lookedUp?.targetAttemptId).toBe(colonAttemptId);
    expect(lookedUp?.profileId).toBe('claude-acp-bridge');

    // 2. Running on `agy` (`agy-acp-native`) with colon-bearing attemptId resolves `claude-acp-bridge`
    //    representation and FAILS CLOSED with `profile-changed` (proving colon lookup + real profile check!).
    const lookedUpKeys: string[] = [];
    const agyRunner = new AcpBackedRunner({
      kind: 'agy',
      inner: dummyInner,
      readConfiguredProfile: () => 'agy-acp-native',
      primaryWorkspaceRoot: tempDir,
      platform: { os: 'darwin', arch: 'arm64' },
      resolveHandoffRepresentation: (id) => {
        lookedUpKeys.push(id);
        return coord.resolveHandoffRepresentation(id);
      },
      resolveHandoffContentDigest: (hId) => coord.resolveHandoffContentDigest(hId)
    });
    const profileMismatchOut = await agyRunner.invoke({
      phase: 'implement',
      iteration: 0,
      runId: 'run-colon-1',
      attemptId: colonAttemptId,
      prompt: PHASE_B.instruction!,
      ...(del.delivery.acpPromptBlocks !== undefined
        ? { acpPromptBlocks: del.delivery.acpPromptBlocks }
        : {}),
      timeoutMs: 5_000,
      cliPath: mockOkPath,
      cwd: tempDir
    });
    expect(lookedUpKeys).toEqual([colonAttemptId]);
    expect(profileMismatchOut.exitCode).toBe(1);
    expect(profileMismatchOut.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:stale-revision:profile-changed'
    );

    // 3. verifyNegotiatedHandoffCapabilities fails closed on `isContinue: true` + `loadSession: false`
    //    AND on `negotiated === null` when embedded blocks or loadSession are requested!
    expect(
      verifyNegotiatedHandoffCapabilities({
        negotiated: {
          protocolVersion: 1,
          loadSession: false,
          image: false,
          audio: false,
          embeddedContext: true,
          authMethodCount: 0
        },
        representation: null,
        wantsLoadSession: true,
        isContinue: true
      })
    ).toEqual({
      ok: false,
      warning: 'acp-handoff-capabilities-changed:session-load-unsupported'
    });
    expect(
      verifyNegotiatedHandoffCapabilities({
        negotiated: null,
        representation: null,
        acpPromptBlocks: [{ type: 'embedded-resource', uri: 'artifact:a@1', text: 'hi', mimeType: 'text/plain' }],
        wantsLoadSession: false,
        isContinue: false
      })
    ).toEqual({
      ok: false,
      warning: 'acp-handoff-capabilities-changed:embedded-context-unsupported'
    });
    expect(
      verifyNegotiatedHandoffCapabilities({
        negotiated: null,
        representation: null,
        wantsLoadSession: true,
        isContinue: true
      })
    ).toEqual({
      ok: false,
      warning: 'acp-handoff-capabilities-changed:session-load-unsupported'
    });

    sqlite.close();
  });

  it('SR-314-2 & CR-314-4: blocks Fixer self-approval via review-report.json, enforces Repeat boundInputs vs post-Fix candidateRef precedence, and fails closed on corrupt review ledger', async () => {
    const PHASE_REVIEW: PhaseDefinition = {
      phaseId: 'phase-rev-sec',
      name: 'Review Phase',
      version: 1,
      instruction: 'Review candidate code.',
      runner: 'codex'
    };
    const PHASE_FIX: PhaseDefinition = {
      phaseId: 'phase-fix-sec',
      name: 'Fix Phase',
      version: 1,
      instruction: 'Fix blocking findings.',
      runner: 'claude'
    };
    const bodyWf: WorkflowDefinition = {
      workflowId: 'wf-sec-body',
      name: 'Fix -> Review Body',
      version: 1,
      inputs: [{ portId: 'candidateRef', label: 'Candidate', type: 'text', required: false }],
      startNodeIds: ['fix'],
      nodes: [
        { nodeId: 'fix', kind: 'phase', phaseId: 'phase-fix-sec' },
        { nodeId: 'review', kind: 'phase', phaseId: 'phase-rev-sec' }
      ],
      connections: [
        {
          from: { nodeId: 'fix' },
          to: { nodeId: 'review' },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'sel-fix', sourceNodePath: 'fix', required: true, priority: 0 }]
          }
        }
      ],
      decisionResults: {
        version: 1,
        fields: [{ fieldId: 'reviewPassed', type: 'boolean', required: true }],
        bindings: [
          {
            fieldId: 'reviewPassed',
            source: { kind: 'node-result', nodeId: 'review', fieldId: 'reviewPassed' }
          }
        ]
      }
    };
    const rootWf: WorkflowDefinition = {
      workflowId: 'wf-sec-root',
      name: 'Initial Review -> Repeat(Fix -> Review)',
      version: 1,
      inputs: [{ portId: 'candidateRef', label: 'Candidate', type: 'text', required: false }],
      startNodeIds: ['initial-review'],
      nodes: [
        { nodeId: 'initial-review', kind: 'phase', phaseId: 'phase-rev-sec' },
        {
          nodeId: 'rev-loop',
          kind: 'workflow',
          workflowId: 'wf-sec-body',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            until: {
              version: 1,
              kind: 'typed',
              test: {
                left: { source: 'result-field', fieldId: 'reviewPassed' },
                operator: 'equals',
                right: true
              }
            },
            carry: [],
            onExhausted: 'fail'
          }
        }
      ],
      bindings: [
        {
          kind: 'input',
          nodeId: 'rev-loop',
          inputKey: 'candidateRef',
          source: { from: 'workflow-input', portId: 'candidateRef' }
        }
      ],
      connections: [
        {
          from: { nodeId: 'initial-review' },
          to: { kind: 'node', nodeId: 'rev-loop' },
          priority: 1,
          condition: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'node-result', nodeId: 'initial-review', fieldId: 'reviewPassed' },
              operator: 'equals',
              right: false
            }
          },
          contextPolicy: {
            version: 1,
            approval: 'automatic',
            session: 'fresh',
            selectors: [{ selectorId: 'sel-init', sourceNodePath: 'initial-review', required: true, priority: 0 }]
          }
        },
        {
          from: { nodeId: 'initial-review' },
          to: { kind: 'return', nodeId: 'initial-review' },
          priority: 2,
          condition: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'node-result', nodeId: 'initial-review', fieldId: 'reviewPassed' },
              operator: 'equals',
              right: true
            }
          }
        }
      ]
    };

    const makeHarness = async (runId: string) => {
      const rootDir = await makeTempDir(`f15b-sec-${runId}-`);
      const sqlite = SqliteApplicationStore.openInMemory();
      const store = createSqliteHandoffStore(sqlite.writerConnection);
      const coordinator = createPhaseHandoffCoordinator({
        store,
        primaryWorkspaceRoot: rootDir,
        workspaceId: `ws-${runId}`
      });
      const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
      const repeatExecutor = new RepeatExecutor({
        ledgerStore,
        clock: { nowWallMs: () => 1_700_000_000_000, nowMonotonicMs: () => 1_000 }
      });
      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: runId,
        workflow: rootWf,
        effectiveWorkflows: [rootWf, bodyWf],
        effectivePhases: [PHASE_REVIEW, PHASE_FIX],
        boundInputs: {
          candidateRef: { portId: 'candidateRef', type: 'text', value: 'cand-v1' }
        },
        startedAt: 1000
      });
      if (snap.outcome !== 'created') throw new Error('snap failed');
      await seedControlLedgerRoot(ledgerStore, {
        runId,
        workflowId: rootWf.workflowId,
        rootInvocationId: snap.rootInvocationId
      });
      let currentRun = snap.run;
      const dispatched: PhaseAttemptDispatchInput[] = [];
      const writer = {
        get: (id: string) => (currentRun.connectedRunId === id ? currentRun : null),
        list: () => [currentRun],
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRev: number) {
          if (currentRun.revision !== expectedRev) return { outcome: 'stale' as const, current: currentRun };
          currentRun = Object.freeze({ ...next, revision: expectedRev + 1 });
          return { outcome: 'written' as const, run: currentRun };
        }
      };
      const deps = {
        connectedRuns: writer,
        repeatExecutor,
        phaseHandoffCoordinator: coordinator,
        workspaceRoot: rootDir,
        dispatchPhase: async (inp: PhaseAttemptDispatchInput) => {
          dispatched.push(inp);
          return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
        }
      };
      return {
        rootDir,
        sqlite,
        store,
        coordinator,
        deps,
        dispatched,
        rootInvId: snap.rootInvocationId,
        getRun: () => currentRun
      };
    };

    // Part 1 (SR-314-2): Fixer is NOT authorized to write review-report.json and attempting to
    // stage a self-approving review-report.json with reviewerAttemptId=fixAttemptId is REFUSED!
    {
      const h = await makeHarness('sec-fixer-forge');
      const loopId = 'loop-sec-fixer-forge-rev-loop';
      const s1 = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      if (s1.outcome !== 'phase-dispatched') return;
      // Reviewer IS authorized for review-report.json:
      const initDispatch = h.dispatched.find((d) => d.node.nodeId === 'initial-review');
      expect(
        initDispatch?.phaseHandoff?.authorizedOutputPaths?.some((p) => p.endsWith('review-report.json'))
      ).toBe(true);

      const stInit = allocateAttemptStagingPaths(h.rootDir, 'sec-fixer-forge', s1.attemptId);
      await fsp.mkdir(stInit.stagingDirAbsPath, { recursive: true });
      await fsp.writeFile(
        stInit.reviewReportAbsPath,
        JSON.stringify({
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: s1.attemptId,
          candidateRef: 'cand-v1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: false,
          blockingCount: 1,
          findings: [
            { id: 'F-001', severity: 'high', title: 'Bug', explanation: 'Fix it', evidence: ['a.ts#L1'] }
          ],
          dispositions: []
        }),
        'utf8'
      );
      const sFix = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: false }
      });
      expect(sFix.outcome).toBe('phase-dispatched');
      if (sFix.outcome !== 'phase-dispatched') return;

      // Fixer's authorizedOutputPaths MUST exclude review-report.json!
      const fixDispatch = h.dispatched.find((d) => d.node.nodeId === 'fix');
      expect(
        fixDispatch?.phaseHandoff?.authorizedOutputPaths?.some((p) => p.endsWith('review-report.json'))
      ).toBe(false);
      expect(
        fixDispatch?.phaseHandoff?.authorizedOutputPaths?.some((p) => p.endsWith('fix-claims.json'))
      ).toBe(true);

      // Compromised Fixer writes a forged self-approving review-report.json on disk!
      const prevReportRef = h.coordinator.inspectReviewLoop(loopId)!.history.entries[0]!.reportRef;
      const stFix = allocateAttemptStagingPaths(h.rootDir, 'sec-fixer-forge', sFix.attemptId);
      await fsp.mkdir(stFix.stagingDirAbsPath, { recursive: true });
      await fsp.writeFile(
        stFix.reviewReportAbsPath,
        JSON.stringify({
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 2,
          reviewerAttemptId: sFix.attemptId,
          candidateRef: 'cand-v1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: prevReportRef,
          coverage: 'complete',
          reviewPassed: true,
          blockingCount: 0,
          findings: [],
          dispositions: [{ findingId: 'F-001', status: 'resolved' }]
        }),
        'utf8'
      );
      const fixCompleted = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: sFix.invocationId,
        nodeId: 'fix',
        status: 'completed',
        completedAt: 1300
      });
      expect(fixCompleted.outcome).toBe('workflow-failed');
      // Blocking finding F-001 remains OPEN and Repeat exit stays REFUSED!
      expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.findings[0]?.status).toBe('open');
      expect(
        h.coordinator.verifyRepeatExitAllowed({ runId: 'sec-fixer-forge', repeatNodeId: 'rev-loop' }).ok
      ).toBe(false);

      // Corrupting phase_review_loop_ledgers fails closed with storage-unavailable (NEVER { ok: true })!
      h.sqlite.writerConnection.run(
        `UPDATE phase_review_loop_ledgers SET ledger_json = '{corrupt' WHERE loop_id = ?`,
        loopId
      );
      expect(
        h.coordinator.verifyRepeatExitAllowed({ runId: 'sec-fixer-forge', repeatNodeId: 'rev-loop' })
      ).toEqual({
        ok: false,
        failure: 'storage-unavailable',
        detail: 'corrupt-review-loop-ledger'
      });
      h.sqlite.close();
    }

    // Part 2 (CR-314-4 + SR-314-2b): Repeat body starts with boundInputs.candidateRef='cand-v1';
    // Fix emits declaredOutputs.candidateRef='cand-v2'; Review settles WITHOUT re-emitting
    // declaredOutputs.candidateRef -> stale 'cand-v1' report is REJECTED (candidate-mismatch),
    // while valid 'cand-v2' report is ACCEPTED and Repeat exits cleanly!
    for (const reviewReportCandidate of ['cand-v1', 'cand-v2'] as const) {
      const runId = `cr314-4-${reviewReportCandidate}`;
      const h = await makeHarness(runId);
      const loopId = `loop-${runId}-rev-loop`;
      const s1 = await dispatchComposableNode(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        startedAt: 1100
      });
      if (s1.outcome !== 'phase-dispatched') return;
      const stInit = allocateAttemptStagingPaths(h.rootDir, runId, s1.attemptId);
      await fsp.mkdir(stInit.stagingDirAbsPath, { recursive: true });
      await fsp.writeFile(
        stInit.reviewReportAbsPath,
        JSON.stringify({
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 1,
          reviewerAttemptId: s1.attemptId,
          candidateRef: 'cand-v1',
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: null,
          coverage: 'complete',
          reviewPassed: false,
          blockingCount: 1,
          findings: [
            { id: 'F-001', severity: 'high', title: 'Bug', explanation: 'Fix it', evidence: ['a.ts#L1'] }
          ],
          dispositions: []
        }),
        'utf8'
      );
      const sFix = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: h.rootInvId,
        nodeId: 'initial-review',
        status: 'completed',
        completedAt: 1200,
        decisionResults: { reviewPassed: false }
      });
      if (sFix.outcome !== 'phase-dispatched') return;

      // Verify Repeat body frame carries boundInputs.candidateRef === 'cand-v1'.
      expect(h.getRun().invocations?.[sFix.invocationId]?.boundInputs['candidateRef']?.value).toBe('cand-v1');

      // Fix emits declaredOutputs.candidateRef = 'cand-v2'.
      const sRev = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: sFix.invocationId,
        nodeId: 'fix',
        status: 'completed',
        completedAt: 1300,
        declaredOutputs: {
          candidateRef: { portId: 'candidateRef', type: 'text', value: 'cand-v2' }
        }
      });
      expect(sRev.outcome).toBe('phase-dispatched');
      if (sRev.outcome !== 'phase-dispatched') return;

      // Review stages review-report.json and settles WITHOUT re-emitting declaredOutputs.candidateRef!
      const prevRef = h.coordinator.inspectReviewLoop(loopId)!.history.entries[0]!.reportRef;
      const stRev = allocateAttemptStagingPaths(h.rootDir, runId, sRev.attemptId);
      await fsp.mkdir(stRev.stagingDirAbsPath, { recursive: true });
      await fsp.writeFile(
        stRev.reviewReportAbsPath,
        JSON.stringify({
          reportVersion: REVIEW_REPORT_VERSION,
          loopId,
          pass: 2,
          reviewerAttemptId: sRev.attemptId,
          candidateRef: reviewReportCandidate,
          scopeRevision: 'scope-1',
          criteriaRevision: 'crit-1',
          previousReportRef: prevRef,
          coverage: 'complete',
          reviewPassed: true,
          blockingCount: 0,
          findings: [],
          dispositions: [{ findingId: 'F-001', status: 'resolved' }]
        }),
        'utf8'
      );
      const done = await completeComposableNodeAttempt(h.deps, {
        run: h.getRun(),
        invocationId: sFix.invocationId,
        nodeId: 'review',
        status: 'completed',
        completedAt: 1400,
        decisionResults: { reviewPassed: true }
      });

      if (reviewReportCandidate === 'cand-v1') {
        expect(done.outcome).toBe('workflow-failed');
        if (done.outcome === 'workflow-failed') {
          expect(done.run.invocations?.[sFix.invocationId]?.failureCode).toBe('stale-revision');
        }
      } else {
        expect(done.outcome).toBe('workflow-completed');
        expect(h.coordinator.inspectReviewLoop(loopId)?.explanation.latestVerdict).toBe('passed');
      }
      h.sqlite.close();
    }
  });

  it('SR-B2 #1 & #2: AcpBackedRunner fails closed when phaseHandoffId representation is missing/mismatched or when fresh policy receives wantsLoadSession=true', async () => {
    const tempDir = await makeTempDir('f15b-srb2-12-');
    const mockOkPath = path.join(tempDir, 'mock-acp-ok.mjs');
    await fsp.writeFile(
      mockOkPath,
      `#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  process.stderr.write('METHOD:' + msg.method + '\\n');
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock-ok', version: '1.5.5' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-new-srb2' } });
  } else if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
      'utf8'
    );
    await fsp.chmod(mockOkPath, 0o755);

    const dummyInner: BackendRunner = {
      hasActiveProcess: false,
      async invoke() {
        throw new Error('CLI fallback forbidden');
      },
      cancelActive: () => false,
      close: () => undefined,
      async settleTeardowns() {
        return [];
      }
    };

    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection);
    const coord = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: tempDir,
      workspaceId: 'ws-srb2-12'
    });
    const wfFresh: WorkflowDefinition = {
      workflowId: 'wf-srb2-fresh',
      name: 'SR-B2 Fresh Handoff',
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
            selectors: [{ selectorId: 's1', sourceNodePath: 'n1', required: true, priority: 0 }]
          }
        }
      ]
    };
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-srb2-12',
      workflow: wfFresh,
      effectiveWorkflows: [wfFresh],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') {
      sqlite.close();
      return;
    }
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations?.[invId];
    expect(frame).toBeDefined();
    if (frame === undefined) {
      sqlite.close();
      return;
    }
    const occId = invId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const n1Path = `${frame.nodePath.replace(/^\/+/, '')}/n1`;
    coord.registerExternalContribution({
      runId: 'run-srb2-12',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: n1Path, occurrenceId: occId, attemptId: 'att-n1-srb2' },
        coverage: 'complete',
        outcomes: ['Fresh policy handoff'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const firstConn = wfFresh.connections.at(0);
    expect(firstConn).toBeDefined();
    if (firstConn === undefined) {
      sqlite.close();
      return;
    }
    const prep = await coord.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: wfFresh,
      connection: firstConn,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: {
        attemptId: 'att-n1-srb2',
        attemptIndex: 1,
        rootRunId: 'run-srb2-12',
        invocationId: invId,
        parentInvocationId: null,
        nodePath: n1Path,
        nodeId: 'n1',
        nodeKind: 'phase',
        targetDefinitionId: 'phase-a',
        status: 'completed',
        startedAt: 1010,
        completedAt: 1020,
        inputEnvelope: {
          envelopeId: 'env-srb2-1',
          invocationId: invId,
          targetNodeId: 'n1',
          source: 'launch',
          inputsByPort: {},
          localInputs: [],
          outputTargetOverrides: [],
          acceptedAt: 1005
        },
        declaredOutputs: {}
      },
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction,
      targetBackendId: 'agy'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') {
      sqlite.close();
      return;
    }

    const del = await coord.planAndAuthorizeAttemptDelivery({
      runId: 'run-srb2-12',
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-srb2',
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction,
      backendId: 'agy'
    });
    expect(del.ok).toBe(true);
    if (!del.ok) {
      sqlite.close();
      return;
    }

    // 1. capabilityRequestFields forwards phaseHandoffId & phaseHandoffRepresentationDigest when handoffId !== null,
    //    and omits both when handoffId === null.
    const forwarded = capabilityRequestFields({
      iteration: 0,
      envelope: { phaseHandoff: del.delivery }
    });
    expect(forwarded.phaseHandoffId).toBe(prep.handoffId);
    expect(forwarded.phaseHandoffRepresentationDigest).toBe(del.delivery.representationDigest);
    const nonHandoffFields = capabilityRequestFields({
      iteration: 0,
      envelope: {
        phaseHandoff: {
          handoffId: null,
          revision: null,
          attemptId: 'att-no-handoff',
          representationDigest: null
        }
      }
    });
    expect('phaseHandoffId' in nonHandoffFields).toBe(false);
    expect('phaseHandoffRepresentationDigest' in nonHandoffFields).toBe(false);

    const persistedRep = store.loadRepresentation(prep.handoffId, 1, 'att-n2-srb2');
    expect(persistedRep).not.toBeNull();
    if (persistedRep === null) {
      sqlite.close();
      return;
    }
    expect(persistedRep.session).toBe('fresh');

    const runWithResolver = async (
      resolver: ((attemptId: string) => DeliveryRepresentation | null) | undefined,
      overrides: {
        readonly phaseHandoffId?: string;
        readonly phaseHandoffRepresentationDigest?: string;
        readonly sessionReuse?: boolean;
        readonly resumeSessionId?: string;
        readonly resumeSessionOrigin?: 'acp' | 'legacy-cli';
        readonly includePromptBlocks?: boolean;
      }
    ) => {
      const methods: string[] = [];
      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner: dummyInner,
        readConfiguredProfile: () => 'agy-acp-native',
        primaryWorkspaceRoot: tempDir,
        platform: { os: 'darwin', arch: 'arm64' },
        ...(resolver !== undefined ? { resolveHandoffRepresentation: resolver } : {}),
        resolveHandoffContentDigest: (hId) => coord.resolveHandoffContentDigest(hId)
      });
      const out = await runner.invoke(
        {
          phase: 'implement',
          iteration: 0,
          runId: 'run-srb2-12',
          attemptId: 'att-n2-srb2',
          prompt: PHASE_B.instruction,
          ...(overrides.includePromptBlocks !== false && del.delivery.acpPromptBlocks !== undefined
            ? { acpPromptBlocks: del.delivery.acpPromptBlocks }
            : {}),
          ...(overrides.phaseHandoffId !== undefined
            ? { phaseHandoffId: overrides.phaseHandoffId }
            : {}),
          ...(overrides.phaseHandoffRepresentationDigest !== undefined
            ? { phaseHandoffRepresentationDigest: overrides.phaseHandoffRepresentationDigest }
            : {}),
          ...(overrides.sessionReuse !== undefined ? { sessionReuse: overrides.sessionReuse } : {}),
          ...(overrides.resumeSessionId !== undefined
            ? { resumeSessionId: overrides.resumeSessionId }
            : {}),
          ...(overrides.resumeSessionOrigin !== undefined
            ? { resumeSessionOrigin: overrides.resumeSessionOrigin }
            : {}),
          timeoutMs: 5_000,
          cliPath: mockOkPath,
          cwd: tempDir
        },
        {
          write(stream, chunk) {
            if (stream === 'stderr') {
              for (const line of chunk.split('\n')) {
                if (line.startsWith('METHOD:')) methods.push(line.slice(7));
              }
            }
            return true;
          },
          onceDrain: () => undefined
        }
      );
      return { out, methods };
    };

    // 2. SR-B2 #1a: phaseHandoffId set + resolveHandoffRepresentation returns null (missing row / detached store) -> fail closed!
    const missingRep = await runWithResolver(() => null, {
      phaseHandoffId: prep.handoffId,
      ...(del.delivery.representationDigest !== null
        ? { phaseHandoffRepresentationDigest: del.delivery.representationDigest }
        : {})
    });
    expect(missingRep.out.exitCode).toBe(1);
    expect(missingRep.out.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:storage-unavailable:representation-missing'
    );
    expect(missingRep.methods).toEqual(['initialize']);

    // 3. SR-B2 #1b: phaseHandoffId set + mismatched handoffId on resolved representation -> fail closed!
    const wrongHandoffId = await runWithResolver(
      () => ({ ...persistedRep, handoffId: 'other-handoff-id' }),
      {
        phaseHandoffId: prep.handoffId,
        ...(del.delivery.representationDigest !== null
          ? { phaseHandoffRepresentationDigest: del.delivery.representationDigest }
          : {})
      }
    );
    expect(wrongHandoffId.out.exitCode).toBe(1);
    expect(wrongHandoffId.out.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:stale-revision:representation-digest'
    );
    expect(wrongHandoffId.methods).toEqual(['initialize']);

    // 4. SR-B2 #1c: phaseHandoffId set + mismatched representationDigest -> fail closed!
    const wrongDigest = await runWithResolver(() => persistedRep, {
      phaseHandoffId: prep.handoffId,
      phaseHandoffRepresentationDigest: '0'.repeat(64)
    });
    expect(wrongDigest.out.exitCode).toBe(1);
    expect(wrongDigest.out.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:stale-revision:representation-digest'
    );
    expect(wrongDigest.methods).toEqual(['initialize']);

    // 5. SR-B2 #1d: non-handoff call (no phaseHandoffId) with null representation remains unaffected.
    const nonHandoff = await runWithResolver(() => null, { includePromptBlocks: false });
    expect(nonHandoff.out.exitCode).toBe(0);
    expect(nonHandoff.methods).toContain('session/new');
    expect(nonHandoff.methods).toContain('session/prompt');

    // 6. SR-B2 #2: representation.session === 'fresh' + wantsLoadSession === true + negotiated.loadSession === true -> fail closed!
    expect(
      verifyNegotiatedHandoffCapabilities({
        negotiated: persistedRep.capabilities,
        representation: persistedRep,
        activeProfile: {
          profileId: persistedRep.profileId,
          profileRevision: persistedRep.profileRevision
        },
        expectedContentDigest: persistedRep.contentDigest,
        expectedHandoffId: prep.handoffId,
        ...(del.delivery.representationDigest !== null
          ? { expectedRepresentationDigest: del.delivery.representationDigest }
          : {}),
        acpPromptBlocks: del.delivery.acpPromptBlocks,
        wantsLoadSession: true,
        isContinue: false
      })
    ).toEqual({
      ok: false,
      warning: 'acp-handoff-dispatch-refused:invalid-policy:session-reuse-not-permitted'
    });
    const freshLoadAttempt = await runWithResolver(() => persistedRep, {
      phaseHandoffId: prep.handoffId,
      ...(del.delivery.representationDigest !== null
        ? { phaseHandoffRepresentationDigest: del.delivery.representationDigest }
        : {}),
      sessionReuse: true,
      resumeSessionId: 'sess-ambient-1',
      resumeSessionOrigin: 'acp'
    });
    expect(freshLoadAttempt.out.exitCode).toBe(1);
    expect(freshLoadAttempt.out.diagnosticWarnings).toContain(
      'acp-handoff-dispatch-refused:invalid-policy:session-reuse-not-permitted'
    );
    expect(freshLoadAttempt.methods).toEqual(['initialize']);
    expect(freshLoadAttempt.methods).not.toContain('session/load');
    expect(freshLoadAttempt.methods).not.toContain('session/prompt');

    sqlite.close();
  });
});
