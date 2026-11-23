import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PHASE_CONTEXT_CONTRIBUTION_VERSION } from '../../../../src/contracts/phase-context/context-policy';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import {
  createPhaseHandoffCoordinator,
  createSqliteHandoffStore,
  normalizeNodePathForHandoff
} from '../../../../src/services/phase-context';
import { SqliteApplicationStore } from '../../../../src/services/sqlite-store';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import type { ConnectedWorkflowRun, NodeAttemptRecord } from '../../../../src/state/connected-workflow-run';

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
  instruction: 'Produce handoff input.',
  runner: 'claude'
};

const PHASE_B: PhaseDefinition = {
  phaseId: 'phase-b',
  name: 'Phase B',
  version: 1,
  instruction: 'Consume handoff input.',
  runner: 'claude'
};

const WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-handoff-unit',
  name: 'Unit Handoff Workflow',
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
        selectors: [{ selectorId: 'sel-n1', sourceNodePath: 'n1', required: true, priority: 0 }]
      }
    }
  ]
};

function makeAttempt(
  run: ConnectedWorkflowRun,
  invocationId: string,
  attemptId: string,
  frameNodePath: string,
  nodeId = 'n1'
): NodeAttemptRecord {
  const nodePath = normalizeNodePathForHandoff(
    `${normalizeNodePathForHandoff(frameNodePath)}/${nodeId}`
  );
  return {
    attemptId,
    attemptIndex: 1,
    rootRunId: run.connectedRunId,
    invocationId,
    parentInvocationId: null,
    nodePath,
    nodeId,
    nodeKind: 'phase',
    targetDefinitionId: 'phase-a',
    status: 'completed',
    startedAt: 1000,
    completedAt: 1100,
    inputEnvelope: {
      envelopeId: `env-${attemptId}`,
      invocationId,
      targetNodeId: nodeId,
      source: 'launch',
      inputsByPort: {},
      localInputs: [],
      outputTargetOverrides: [],
      acceptedAt: 999
    },
    declaredOutputs: {}
  };
}

describe('FR-R7-14 (14-09) — PhaseHandoffCoordinator bounded & restored target lookups', () => {
  it('does not retain unbounded target-lookup or run-scoped memory across many completed runs', async () => {
    const rootDir = await makeTempDir('phc-bounded-');
    const sqlite = SqliteApplicationStore.openInMemory();
    let tick = 1_700_000_000_000;
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => {
      tick += 10;
      return tick;
    });
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-bounded'
    });

    const totalRuns = 120;
    for (let i = 0; i < totalRuns; i += 1) {
      const runId = `run-bounded-${i}`;
      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: runId,
        workflow: WORKFLOW,
        effectiveWorkflows: [WORKFLOW],
        effectivePhases: [PHASE_A, PHASE_B],
        startedAt: 1000 + i
      });
      expect(snap.outcome).toBe('created');
      if (snap.outcome !== 'created') continue;

      const invId = snap.rootInvocationId;
      const frame = snap.run.invocations![invId]!;
      const attempt = makeAttempt(snap.run, invId, `att-${i}`, frame.nodePath);

      const reg = coordinator.registerExternalContribution({
        runId,
        contribution: {
          schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
          producer: {
            nodePath: attempt.nodePath,
            occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
            attemptId: attempt.attemptId
          },
          coverage: 'complete',
          outcomes: [`outcome-${i}`],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: null,
          artifacts: []
        }
      });
      expect(reg.ok).toBe(true);

      const prepared = await coordinator.prepareTransitionHandoff({
        run: snap.run,
        frame,
        workflow: WORKFLOW,
        connection: WORKFLOW.connections[0]!,
        connectionIndex: 0,
        fromNodeId: 'n1',
        fromAttempt: attempt,
        targetNodeId: 'n2',
        targetInstructions: PHASE_B.instruction!,
        targetBackendId: 'claude'
      });
      expect(prepared.kind).toBe('accepted');
      if (prepared.kind === 'accepted') {
        expect(coordinator.resolvePendingHandoffForTarget(runId, invId, 'n2')).toBe(
          prepared.handoffId
        );
      }

      coordinator.releaseTerminalRunPins(runId);
    }

    // Verify zero unbounded target-lookup cache exists and per-run/pending maps stay empty after completion.
    const internalCoord = coordinator as unknown as {
      latestHandoffByTargetKey?: unknown;
      candidatesByRunId: Map<string, unknown>;
      sequenceByRunId: Map<string, unknown>;
    };
    const internalStore = store as unknown as {
      pendingMetaByHandoffId: Map<string, unknown>;
    };

    expect(internalCoord.latestHandoffByTargetKey).toBeUndefined();
    expect(internalCoord.candidatesByRunId.size).toBe(0);
    expect(internalCoord.sequenceByRunId.size).toBe(0);
    expect(internalStore.pendingMetaByHandoffId.size).toBe(0);

    // Durable lookup still resolves any persisted run directly from SQLite.
    expect(
      coordinator.resolvePendingHandoffForTarget(
        'run-bounded-42',
        'run-bounded-42:root',
        'n2'
      )
    ).not.toBeNull();

    sqlite.close();
  });

  it('resolves newest-first matching target_phase_id, prefers exact invocationId match, and immediately sees restored handoffIds after reloadFromStore()', async () => {
    const rootDir = await makeTempDir('phc-restore-');
    const sqlite = SqliteApplicationStore.openInMemory();
    let tick = 1_700_000_000_000;
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => {
      tick += 1_000;
      return tick;
    });
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-restore-unit'
    });

    const runId = 'run-shared-id';
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: runId,
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;

    const invA = snap.rootInvocationId;
    const frameA = snap.run.invocations![invA]!;
    const invB = `${runId}:child-2`;
    const frameB = { ...frameA, invocationId: invB, nodePath: `${frameA.nodePath}/sub-b` };

    // Create older handoff for invA -> n2.
    const attA1 = makeAttempt(snap.run, invA, 'att-a-1', frameA.nodePath);
    coordinator.registerExternalContribution({
      runId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attA1.nodePath,
          occurrenceId: invA.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attA1.attemptId
        },
        coverage: 'complete',
        outcomes: ['invA-v1'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prepA1 = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame: frameA,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attA1,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepA1.kind).toBe('accepted');
    if (prepA1.kind !== 'accepted') return;

    // Create newer handoff for invA -> n2 (different revision -> distinct handoffId).
    const prepA2 = await coordinator.prepareTransitionHandoff({
      run: { ...snap.run, revision: snap.run.revision + 1 },
      frame: frameA,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attA1,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepA2.kind).toBe('accepted');
    if (prepA2.kind !== 'accepted') return;
    expect(prepA2.handoffId).not.toBe(prepA1.handoffId);

    // Create even newer handoff for invB -> n2.
    const attB1 = makeAttempt(snap.run, invB, 'att-b-1', frameB.nodePath);
    coordinator.registerExternalContribution({
      runId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attB1.nodePath,
          occurrenceId: invB.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attB1.attemptId
        },
        coverage: 'complete',
        outcomes: ['invB-v1'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prepB1 = await coordinator.prepareTransitionHandoff({
      run: { ...snap.run, revision: snap.run.revision + 2 },
      frame: frameB,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attB1,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepB1.kind).toBe('accepted');
    if (prepB1.kind !== 'accepted') return;

    // Verify newest-first ordering and exact invocationId preference:
    expect(store.listHandoffIdsForRun(runId)).toEqual([
      prepB1.handoffId,
      prepA2.handoffId,
      prepA1.handoffId
    ]);
    expect(coordinator.resolvePendingHandoffForTarget(runId, invA, 'n2')).toBe(prepA2.handoffId);
    expect(coordinator.resolvePendingHandoffForTarget(runId, invB, 'n2')).toBe(prepB1.handoffId);
    // Unmatched invocation falls back to newest row for target_phase_id='n2' (prepB1).
    expect(coordinator.resolvePendingHandoffForTarget(runId, 'unknown-inv', 'n2')).toBe(
      prepB1.handoffId
    );
    expect(coordinator.resolvePendingHandoffForTarget(runId, invA, 'nonexistent-node')).toBeNull();

    // Seed unsaved pending metadata to verify reloadFromStore() clears it too.
    store.bindRunMetadata('unsaved-pending-handoff', {
      runId,
      targetPhaseId: 'n2'
    });
    expect(store.getRunMetadata('unsaved-pending-handoff')).not.toBeNull();

    // Simulate database restore reusing (runId, invA, 'n2') with a different handoffId.
    const rowA2 = sqlite.writerConnection.get<{
      record_json: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>(
      `SELECT record_json, created_at_ms, updated_at_ms FROM phase_handoff_records WHERE handoff_id = ?`,
      prepA2.handoffId
    );
    expect(rowA2).toBeDefined();
    const restoredId = 'handoff-restored-inv-a';
    const parsedEnv = JSON.parse(rowA2!.record_json) as { record: { handoffId: string } };
    parsedEnv.record.handoffId = restoredId;
    const restoredJson = JSON.stringify(parsedEnv);

    sqlite.writerConnection.run(`DELETE FROM phase_handoff_records WHERE run_id = ?`, runId);
    sqlite.writerConnection.run(
      `INSERT INTO phase_handoff_records (
        handoff_id, run_id, source_attempt_id, target_phase_id,
        revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'accepted', ?, ?, ?, ?)`,
      restoredId,
      runId,
      attA1.attemptId,
      'n2',
      restoredJson,
      Buffer.byteLength(restoredJson, 'utf8'),
      rowA2!.created_at_ms,
      rowA2!.updated_at_ms + 10_000
    );

    coordinator.reloadFromStore();

    // Pending metadata, candidates, and sequences are cleared, and lookup immediately returns restoredId!
    expect(store.getRunMetadata('unsaved-pending-handoff')).toBeNull();
    expect(coordinator.resolvePendingHandoffForTarget(runId, invA, 'n2')).toBe(restoredId);

    const internalCoord = coordinator as unknown as {
      candidatesByRunId: Map<string, unknown>;
      sequenceByRunId: Map<string, unknown>;
    };
    expect(internalCoord.candidatesByRunId.size).toBe(0);
    expect(internalCoord.sequenceByRunId.size).toBe(0);

    sqlite.close();
  });
});
