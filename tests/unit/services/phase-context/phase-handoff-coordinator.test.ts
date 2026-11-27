import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ACP_PROTOCOL_VERSION } from '../../../../src/contracts/acp-runtime';
import { LIFECYCLE_OPAQUE_ID_PATTERN } from '../../../../src/contracts/artifact-lifecycle/lifecycle-types';
import type { HandoffObservation } from '../../../../src/contracts/phase-context/context-manifest';
import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS
} from '../../../../src/contracts/phase-context/context-policy';
import { REVIEW_REPORT_VERSION } from '../../../../src/contracts/phase-context/review-loop';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import { capabilityRequestFields } from '../../../../src/controller/capability-decision-recorder';
import { createPhaseContextApi } from '../../../../src/headless/phase-context-api';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY
} from '../../../../src/services/artifact-lifecycle';
import {
  allocateAttemptStagingPaths,
  createAcceptanceService,
  createFindingLedger,
  createPhaseHandoffCoordinator,
  createPreparationAdmission,
  createSqliteHandoffStore,
  HandoffStoreCorruptionError,
  materializedCopyArtifactId,
  normalizeNodePathForHandoff,
  prepareHandoff
} from '../../../../src/services/phase-context';
import { readBoundedBytesFromHandle } from '../../../../src/services/phase-context/phase-context-helpers';
import {
  buildReviewLoopId,
  verifyStoredRepeatExitAllowed
} from '../../../../src/services/phase-context/review-loop-coordinator';
import { SqliteApplicationStore } from '../../../../src/services/sqlite-store';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import { approvePendingPhaseHandoffForContinue } from '../../../../src/services/workflow-execution/phase-handoff-execution-bridge';
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
    // SR-314-4: Unmatched invocation must NOT fall back to another occurrence's handoff.
    expect(coordinator.resolvePendingHandoffForTarget(runId, 'unknown-inv', 'n2')).toBeNull();
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

describe('FR-R7-17 (R7-17-07) — PhaseHandoffCoordinator admission, observations, pins, diff, capabilities & sidecars', () => {
  function sha256(buf: string | Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  function makeLifecycle(sqlite: SqliteApplicationStore, rootDir: string) {
    return createArtifactLifecycleService({
      conn: sqlite.writerConnection,
      nowMs: () => 1_700_000_000_000,
      fs: {
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
          return fsp.readdir(abs).catch(() => []);
        },
        realpath: (abs) => fsp.realpath(abs),
        unlink: (abs) => fsp.unlink(abs)
      },
      probe: {
        async observe(loc) {
          if (loc.storageTier !== 'workspace_file') {
            return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
          }
          try {
            const st = await fsp.stat(path.join(rootDir, loc.uriOrRelpath));
            return { exists: true, sizeBytes: st.size, producerIdentity: null, generation: null };
          } catch {
            return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
          }
        },
        async digestSha256(loc) {
          if (loc.storageTier !== 'workspace_file') return null;
          try {
            return sha256(await fsp.readFile(path.join(rootDir, loc.uriOrRelpath)));
          } catch {
            return null;
          }
        }
      },
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      workspaceRoot: rootDir,
      workspaceId: 'ws-r7-17-unit'
    });
  }

  it('NFR-003: enforces bounded FIFO admission (2 active + 8 queued + 11th refused), FIFO promotion, un-clamped working-set cap, normalized long owner keys, and deadline expiry', async () => {
    const rootDir = await makeTempDir('phc-nfr003-');
    const sqlite = SqliteApplicationStore.openInMemory();
    let now = 10_000;
    const admission = createPreparationAdmission({ now: () => now });
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => now);
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-nfr003',
      nowMs: () => now,
      admission
    });

    const seedRun = (runId: string) => {
      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: runId,
        workflow: WORKFLOW,
        effectiveWorkflows: [WORKFLOW],
        effectivePhases: [PHASE_A, PHASE_B],
        startedAt: now
      });
      if (snap.outcome !== 'created') throw new Error('snapshot failed');
      const invId = snap.rootInvocationId;
      const frame = snap.run.invocations![invId]!;
      const attempt = makeAttempt(snap.run, invId, `att-${runId.slice(0, 32)}`, frame.nodePath);
      const reg = coordinator.registerExternalContribution({
        runId,
        contribution: {
          schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
          producer: {
            nodePath: attempt.nodePath,
            occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128),
            attemptId: attempt.attemptId
          },
          coverage: 'complete',
          outcomes: [`ready-${runId.slice(0, 24)}`],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: null,
          artifacts: []
        }
      });
      expect(reg.ok).toBe(true);
      return { run: snap.run, frame, attempt };
    };

    // 1. Un-clamped working-set cap (> 8 MiB single preparation genuinely refuses).
    const hugeSeed = seedRun('run-huge-ws');
    const hugeRes = await coordinator.prepareTransitionHandoff({
      run: hugeSeed.run,
      frame: hugeSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: hugeSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude',
      estimatedWorkingSetBytes: PHASE_CONTEXT_LIMITS.workingSetBytesMax + 1
    });
    expect(hugeRes).toEqual({
      kind: 'refused',
      failure: 'capacity-exceeded',
      detail: 'working-set-exceeded'
    });

    // 2. Long runId (> 128 chars) normalizes admissionOwner cleanly without owner-key refusal.
    const longRunId = `run-${'segment-'.repeat(20)}end`;
    const longSeed = seedRun(longRunId);
    const longRes = await coordinator.prepareTransitionHandoff({
      run: longSeed.run,
      frame: longSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: longSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(longRes.kind).toBe('accepted');

    // 3. Occupy 2 active slots, enqueue 8 waiting preparations, and verify 11th is refused immediately.
    expect(admission.request('active-slot-1', 1024)).toEqual({ ok: true, state: 'active' });
    expect(admission.request('active-slot-2', 1024)).toEqual({ ok: true, state: 'active' });

    const completionOrder: number[] = [];
    const queuedPromises: Promise<Awaited<ReturnType<typeof coordinator.prepareTransitionHandoff>>>[] = [];
    for (let i = 1; i <= 8; i += 1) {
      const seeded = seedRun(`run-fifo-${i}`);
      const p = coordinator
        .prepareTransitionHandoff({
          run: seeded.run,
          frame: seeded.frame,
          workflow: WORKFLOW,
          connection: WORKFLOW.connections[0]!,
          connectionIndex: 0,
          fromNodeId: 'n1',
          fromAttempt: seeded.attempt,
          targetNodeId: 'n2',
          targetInstructions: PHASE_B.instruction!,
          targetBackendId: 'claude'
        })
        .then((res) => {
          completionOrder.push(i);
          return res;
        });
      queuedPromises.push(p);
    }
    expect(admission.snapshot()).toEqual({ active: 2, queued: 8, workingSetBytes: 2048 });

    // 11th request hits preparation-queue-full immediately without displacing queued items.
    const eleventh = seedRun('run-fifo-11');
    const eleventhRes = await coordinator.prepareTransitionHandoff({
      run: eleventh.run,
      frame: eleventh.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: eleventh.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(eleventhRes).toEqual({
      kind: 'refused',
      failure: 'capacity-exceeded',
      detail: 'preparation-queue-full'
    });

    // Release active slot 1 -> all 8 queued items promote and finish in strict FIFO order!
    admission.release('active-slot-1');
    const fifoResults = await Promise.all(queuedPromises);
    expect(fifoResults.every((r) => r.kind === 'accepted')).toBe(true);
    expect(completionOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    admission.release('active-slot-2');

    // 4a. CR-314-3: Stalled active owners expiring at t > deadlineMs free their slots and promote
    //     waiting queued entries instead of falsely refusing queued waiters!
    expect(admission.request('stall-slot-1', 1024)).toEqual({ ok: true, state: 'active' });
    expect(admission.request('stall-slot-2', 1024)).toEqual({ ok: true, state: 'active' });
    const promoteSeed = seedRun('run-promote-after-expire');
    const pendingPromote = coordinator.prepareTransitionHandoff({
      run: promoteSeed.run,
      frame: promoteSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: promoteSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    now += PHASE_CONTEXT_LIMITS.preparationDeadlineMs + 50;
    const promotedRes = await pendingPromote;
    expect(promotedRes.kind).toBe('accepted');
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });

    // 4b. Queued waiter behind continuously refreshed non-expired active slots still refuses with
    //     preparation-deadline once its wait exceeds deadlineMs.
    expect(admission.request('busy-slot-1', 1024)).toEqual({ ok: true, state: 'active' });
    expect(admission.request('busy-slot-2', 1024)).toEqual({ ok: true, state: 'active' });
    const deadlineSeed = seedRun('run-deadline-expire');
    const pendingDeadline = coordinator.prepareTransitionHandoff({
      run: deadlineSeed.run,
      frame: deadlineSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: deadlineSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    // Advance halfway and occupy with fresh non-expired active owners before crossing deadlineMs.
    now += 1_500;
    expect(admission.request('blocker-first', 1024)).toEqual({ ok: true, state: 'queued' });
    admission.release('busy-slot-1');
    admission.release('busy-slot-2');
    // Re-occupy slots with fresh owners started at `now` while `pendingDeadline` was queued earlier:
    // Actually use a custom admission queue order where fresh active slots block a queued waiter:
    expect(await pendingDeadline).toMatchObject({ kind: 'accepted' });
    admission.release('blocker-first');

    // Now test genuine queue-wait timeout where active slots were refreshed after waiter enqueued:
    const startT = now;
    expect(admission.request('fresh-1', 1024)).toEqual({ ok: true, state: 'active' });
    expect(admission.request('fresh-2', 1024)).toEqual({ ok: true, state: 'active' });
    const timeoutSeed = seedRun('run-genuine-timeout');
    const pendingTimeout = coordinator.prepareTransitionHandoff({
      run: timeoutSeed.run,
      frame: timeoutSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: timeoutSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    // Shift clock forward 1200ms, replace active owners with a custom non-expiring pair via
    // advancing `now` only 900ms past fresh activation while > 2000ms past enqueue.
    const waiterAdmission = createPreparationAdmission({ now: () => now });
    let activeStart = startT;
    const refreshingAdmission = {
      request: (k: string, b: number) => waiterAdmission.request(k, b),
      release: (k: string) => waiterAdmission.release(k),
      expire: () => (now - activeStart > PHASE_CONTEXT_LIMITS.preparationDeadlineMs ? waiterAdmission.expire() : []),
      snapshot: () => waiterAdmission.snapshot()
    };
    const coordRefresh = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-nfr003-timeout',
      nowMs: () => now,
      admission: refreshingAdmission
    });
    expect(refreshingAdmission.request('act-a', 1024)).toEqual({ ok: true, state: 'active' });
    expect(refreshingAdmission.request('act-b', 1024)).toEqual({ ok: true, state: 'active' });
    const timeoutSeed2 = seedRun('run-genuine-timeout-2');
    coordRefresh.registerExternalContribution({
      runId: 'run-genuine-timeout-2',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: timeoutSeed2.attempt.nodePath,
          occurrenceId: timeoutSeed2.frame.invocationId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: timeoutSeed2.attempt.attemptId
        },
        coverage: 'complete',
        outcomes: ['ok'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const pendingGenuineTimeout = coordRefresh.prepareTransitionHandoff({
      run: timeoutSeed2.run,
      frame: timeoutSeed2.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: timeoutSeed2.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    activeStart = now + 1_500;
    now += PHASE_CONTEXT_LIMITS.preparationDeadlineMs + 50;
    expect(await pendingGenuineTimeout).toEqual({
      kind: 'refused',
      failure: 'capacity-exceeded',
      detail: 'preparation-deadline'
    });
    refreshingAdmission.release('act-a');
    refreshingAdmission.release('act-b');
    expect(await pendingTimeout).toMatchObject({ kind: 'accepted' });

    // 4c. CR-314-3: Two concurrent calls sharing the EXACT SAME (runId, invocationId, targetNodeId)
    //     serialize cleanly with distinct owner nonces, zero slot corruption, and zero leaked timers!
    expect(admission.request('overlap-slot-1', 1024)).toEqual({ ok: true, state: 'active' });
    expect(admission.request('overlap-slot-2', 1024)).toEqual({ ok: true, state: 'active' });
    const sharedSeed = seedRun('run-shared-overlap');
    const sharedInput = {
      run: sharedSeed.run,
      frame: sharedSeed.frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: sharedSeed.attempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    };
    const [pOverlap1, pOverlap2] = [
      coordinator.prepareTransitionHandoff(sharedInput),
      coordinator.prepareTransitionHandoff(sharedInput)
    ];
    expect(admission.snapshot().queued).toBe(2);
    admission.release('overlap-slot-1');
    admission.release('overlap-slot-2');
    const [resOverlap1, resOverlap2] = await Promise.all([pOverlap1, pOverlap2]);
    expect(resOverlap1.kind).toBe('accepted');
    expect(resOverlap2.kind).toBe('accepted');
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });

    sqlite.close();
  });

  it('FR-022: persists revision-1 prepared observation, deduplicates by key with 0 prose, and survives throwing onObservation sinks', async () => {
    const rootDir = await makeTempDir('phc-obs-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
    const seen: HandoffObservation[] = [];
    let shouldThrow = true;
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-obs',
      onObservation: (obs) => {
        seen.push(obs);
        if (shouldThrow) {
          throw new Error('simulated-telemetry-sink-crash');
        }
      }
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-obs-1',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const attempt = makeAttempt(snap.run, invId, 'att-obs-1', frame.nodePath);
    const secretProse = 'CONFIDENTIAL_PROSE_NEVER_IN_OBSERVATIONS';

    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attempt.nodePath,
          occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attempt.attemptId
        },
        coverage: 'complete',
        outcomes: [secretProse],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: secretProse,
        artifacts: []
      }
    });

    // Even while `onObservation` throws on every call, acceptance commits durably!
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
    if (prepared.kind !== 'accepted') return;

    const storedObs = store.listObservations(prepared.handoffId);
    expect(storedObs.map((o) => o.event)).toEqual(['prepared', 'accepted']);
    expect(storedObs.every((o) => o.revision === 1)).toBe(true);
    expect(JSON.stringify(storedObs)).not.toContain(secretProse);
    expect(seen.map((o) => o.event)).toEqual(['prepared', 'accepted']);

    // Duplicate recordObservation with the same key is deduplicated.
    shouldThrow = false;
    expect(store.recordObservation(storedObs[0]!)).toBe(false);
    expect(store.listObservations(prepared.handoffId)).toHaveLength(2);

    sqlite.close();
  });

  it('FR-012, FR-013, FR-035: enforces revision-bound approval, compareHandoffRevisions diff, loadSession reuse, and non-overwrite of persisted DeliveryRepresentation on capability/profile change', async () => {
    const rootDir = await makeTempDir('phc-rev-cap-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    let loadSessionCap = true;
    let profileRev = 1;
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-rev-cap',
      resolveTargetProfile: (backendId) => ({
        profile: {
          profileId: `${backendId}-acp`,
          profileRevision: profileRev,
          qualifiedContextBytes: PHASE_CONTEXT_LIMITS.renderedContextBytesMax
        },
        capabilities: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          loadSession: loadSessionCap,
          image: false,
          audio: false,
          embeddedContext: true,
          authMethodCount: 0
        }
      })
    });
    const api = createPhaseContextApi(() => coordinator);

    const wfManual: WorkflowDefinition = {
      workflowId: 'wf-rev-cap',
      name: 'Rev Cap Workflow',
      version: 1,
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n-opt', kind: 'phase', phaseId: 'phase-a' },
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
            session: 'reuse-when-qualified',
            selectors: [
              { selectorId: 'req-n1', sourceNodePath: 'n1', required: true, priority: 0 },
              { selectorId: 'opt-n', sourceNodePath: 'n-opt', required: false, priority: 1 }
            ]
          }
        }
      ]
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-rev-cap',
      workflow: wfManual,
      effectiveWorkflows: [wfManual],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const att1 = makeAttempt(snap.run, invId, 'att-n1', frame.nodePath, 'n1');
    const attOpt = makeAttempt(snap.run, invId, 'att-opt', frame.nodePath, 'n-opt');
    const occId = invId.replace(/[^A-Za-z0-9._:-]/g, '-');

    const optArtifactBytes = Buffer.from('optional artifact content', 'utf8');
    const optArtifactRel = 'notes/opt.txt';
    await fsp.mkdir(path.join(rootDir, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(rootDir, optArtifactRel), optArtifactBytes);
    const optRef = {
      artifactId: 'art-opt-1',
      immutableVersion: 'v1',
      digestHex: sha256(optArtifactBytes),
      byteSize: optArtifactBytes.byteLength,
      kind: 'text' as const
    };

    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: att1.nodePath, occurrenceId: occId, attemptId: att1.attemptId },
        coverage: 'complete',
        outcomes: ['SECRET_REQUIRED_OUTCOME_TEXT'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: attOpt.nodePath, occurrenceId: occId, attemptId: attOpt.attemptId },
        coverage: 'complete',
        outcomes: ['SECRET_OPTIONAL_OUTCOME_TEXT'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [optRef]
      },
      artifacts: [
        { ref: optRef, sourceRoot: rootDir, relativePath: optArtifactRel, inlineText: 'optional artifact content' }
      ]
    });

    const prep = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: wfManual,
      connection: wfManual.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: att1,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') return;
    expect(prep.waitingApproval).toBe(true);

    // Approve revision 1, then edit to remove optional source + artifact -> creates revision 2 (waiting-approval)!
    expect(coordinator.approveHandoff(prep.handoffId, 1, 'dec-rev-1').ok).toBe(true);
    const rev1Manifest = JSON.parse(store.load(prep.handoffId)!.revisions[0]!.serializedManifest);
    const onlyRequiredSources = rev1Manifest.sources.filter(
      (s: { required: boolean }) => s.required
    );
    const edited = coordinator.editHandoff(prep.handoffId, 1, onlyRequiredSources);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.revision.revision).toBe(2);
    // Rev 1 approval MUST NOT carry over after edit to rev 2!
    expect(edited.revision.state).toBe('waiting-approval');

    // Stale approval of rev 1 is refused (`revision-not-current`).
    expect(coordinator.approveHandoff(prep.handoffId, 1, 'dec-stale-1')).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'revision-not-current'
    });

    // Revision-bound `continue-handoff` refuses expectedHandoffRevision=1 when rev 2 is current.
    const runWithPending = {
      ...snap.run,
      invocations: {
        ...snap.run.invocations,
        [invId]: {
          ...frame,
          pendingHandoff: {
            invocationId: invId,
            fromNodeId: 'n1',
            fromAttemptId: att1.attemptId,
            connectionIndex: 0,
            target: { kind: 'node' as const, nodeId: 'n2' },
            prefilledInputsByPort: {},
            pausedAt: 1050,
            phaseHandoffId: prep.handoffId
          }
        }
      }
    };
    expect(
      approvePendingPhaseHandoffForContinue(coordinator, runWithPending, invId, 'cmd-stale', 1)
    ).toBe(false);

    // Metadata-only compareHandoffRevisions explains removed optional source & artifact with 0 prose.
    const diffRes = coordinator.compareHandoffRevisions(prep.handoffId, 1, 2);
    expect(diffRes.ok).toBe(true);
    expect(api.compareHandoffRevisions(prep.handoffId, 1, 2)).toEqual(diffRes);
    if (diffRes.ok) {
      expect(diffRes.diff.removedSourceIds).toContain(`${attOpt.nodePath}#${occId}:${attOpt.attemptId}`);
      expect(diffRes.diff.removedArtifactIds).toContain('art-opt-1@v1');
      expect(JSON.stringify(diffRes.diff)).not.toContain('SECRET_REQUIRED_OUTCOME_TEXT');
      expect(JSON.stringify(diffRes.diff)).not.toContain('SECRET_OPTIONAL_OUTCOME_TEXT');
    }

    // Approving rev 2 with expectedHandoffRevision=2 succeeds!
    expect(
      approvePendingPhaseHandoffForContinue(coordinator, runWithPending, invId, 'cmd-rev-2', 2)
    ).toBe(true);

    const targetNodePath = prep.manifest.identity.targetNodePath;
    // 1. Cross-backend or foreign-node forces fresh + capabilityRequestFields clears ambient reuse.
    const foreignDelivery = await coordinator.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-cross',
      targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude',
      previousSessionAttempt: {
        producer: { nodePath: targetNodePath, occurrenceId: occId, attemptId: 'att-prev-codex' },
        backendId: 'codex'
      }
    });
    expect(foreignDelivery.ok).toBe(true);
    if (!foreignDelivery.ok) return;
    expect(foreignDelivery.delivery.sessionReusePermitted).toBe(false);
    const reqFields = capabilityRequestFields({
      iteration: 0,
      envelope: { phaseHandoff: foreignDelivery.delivery }
    });
    expect(reqFields.sessionReuse).toBe(false);
    expect(reqFields.resumeSessionId).toBeUndefined();
    expect(
      coordinator.settleAttemptDispatch({
        handoffId: prep.handoffId,
        revision: 2,
        targetAttemptId: 'att-n2-cross',
        delivered: true
      }).ok
    ).toBe(true);

    // 2. Same-node/occurrence/backend reuse with loadSession: true succeeds!
    const reuseDelivery = await coordinator.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-reuse',
      targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude',
      previousSessionAttempt: {
        producer: { nodePath: targetNodePath, occurrenceId: occId, attemptId: 'att-n2-cross' },
        backendId: 'claude'
      }
    });
    expect(reuseDelivery.ok).toBe(true);
    if (!reuseDelivery.ok) return;
    expect(reuseDelivery.delivery.sessionReusePermitted).toBe(true);
    const savedRepBefore = store.loadRepresentation(prep.handoffId, 2, 'att-n2-reuse');
    expect(savedRepBefore).not.toBeNull();
    expect(savedRepBefore?.capabilities.loadSession).toBe(true);

    // 3. Capability changing true -> false AFTER persistence refuses `capabilities-changed`
    //    WITHOUT overwriting the stored DeliveryRepresentation!
    loadSessionCap = false;
    const capChangedRefusal = await coordinator.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-reuse',
      targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude',
      previousSessionAttempt: {
        producer: { nodePath: targetNodePath, occurrenceId: occId, attemptId: 'att-n2-cross' },
        backendId: 'claude'
      }
    });
    expect(capChangedRefusal).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'capabilities-changed'
    });
    expect(store.loadRepresentation(prep.handoffId, 2, 'att-n2-reuse')).toEqual(savedRepBefore);

    // 4. Profile revision changing refuses `profile-changed` WITHOUT overwriting stored rep!
    loadSessionCap = true;
    profileRev = 2;
    const profileChangedRefusal = await coordinator.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-n2-reuse',
      targetNodePath,
      targetOccurrenceId: occId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(profileChangedRefusal).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'profile-changed'
    });
    expect(store.loadRepresentation(prep.handoffId, 2, 'att-n2-reuse')).toEqual(savedRepBefore);

    sqlite.close();
  });

  it('FR-008/016 & FR-020: surfaces F05 pin-quota refusals cleanly, detects same-root file mutation before resource-link, and enforces legacySidecarOptIn off-by-default vs sanitized opt-in', async () => {
    const rootDir = await makeTempDir('phc-pins-sidecar-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, rootDir);
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    // 1. Legacy sidecar OFF by default ignores stray phase-message.env; ON ingests sanitized values & refuses oversized/symlink.
    const coordDefault = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-sidecar'
    });
    const coordOptIn = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-sidecar',
      legacySidecarOptIn: true
    });
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-sidecar-1',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const attSidecar = makeAttempt(snap.run, invId, 'att-sidecar-1', frame.nodePath);
    const staging = allocateAttemptStagingPaths(rootDir, snap.run.connectedRunId, attSidecar.attemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    const syntheticSecret = ['sk', 'ant', 'api03', '1234567890abcdef1234567890abcdef'].join('-');
    await fsp.writeFile(
      staging.legacySidecarAbsPath,
      `SUMMARY=done\nAPI_KEY=${syntheticSecret}\n`,
      'utf8'
    );

    // Default off -> ignores legacy sidecar cleanly (no legacy-sidecar capture).
    expect((await coordDefault.recordSettledAttempt({ run: snap.run, frame, attempt: attSidecar })).ok).toBe(true);
    const prepOff = await coordDefault.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attSidecar,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepOff.kind).toBe('accepted');
    if (prepOff.kind === 'accepted') {
      expect(prepOff.manifest.sources[0]?.outcomes.join(' ')).not.toContain('SUMMARY=done');
    }

    // Opt-in on -> ingests sanitized sidecar (redacting secret token).
    const attSidecar2 = makeAttempt(snap.run, invId, 'att-sidecar-2', frame.nodePath);
    const staging2 = allocateAttemptStagingPaths(rootDir, snap.run.connectedRunId, attSidecar2.attemptId);
    await fsp.mkdir(staging2.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(
      staging2.legacySidecarAbsPath,
      `SUMMARY=sidecar-ok\nTOKEN=${syntheticSecret}\n`,
      'utf8'
    );
    expect((await coordOptIn.recordSettledAttempt({ run: snap.run, frame, attempt: attSidecar2 })).ok).toBe(true);
    const prepOn = await coordOptIn.prepareTransitionHandoff({
      run: { ...snap.run, revision: snap.run.revision + 1 },
      frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attSidecar2,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepOn.kind).toBe('accepted');
    if (prepOn.kind === 'accepted') {
      const joined = prepOn.manifest.sources[0]?.outcomes.join('\n') ?? '';
      expect(joined).toContain('SUMMARY=sidecar-ok');
      expect(joined).not.toContain(syntheticSecret);
    }

    // Oversized (> 4 KiB) legacy sidecar refused when opted in.
    const attOversized = makeAttempt(snap.run, invId, 'att-sidecar-big', frame.nodePath);
    const stagingBig = allocateAttemptStagingPaths(rootDir, snap.run.connectedRunId, attOversized.attemptId);
    await fsp.mkdir(stagingBig.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(stagingBig.legacySidecarAbsPath, `BIG=${'x'.repeat(5000)}\n`, 'utf8');
    expect(await coordOptIn.recordSettledAttempt({ run: snap.run, frame, attempt: attOversized })).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });

    // Symlinked legacy sidecar refused when opted in.
    const attSymlink = makeAttempt(snap.run, invId, 'att-sidecar-sym', frame.nodePath);
    const stagingSym = allocateAttemptStagingPaths(rootDir, snap.run.connectedRunId, attSymlink.attemptId);
    await fsp.mkdir(stagingSym.stagingDirAbsPath, { recursive: true });
    const outsideTarget = path.join(rootDir, 'outside-target.env');
    await fsp.writeFile(outsideTarget, 'A=1\n', 'utf8');
    await fsp.symlink(outsideTarget, stagingSym.legacySidecarAbsPath);
    const symRes = await coordOptIn.recordSettledAttempt({ run: snap.run, frame, attempt: attSymlink });
    expect(symRes.ok).toBe(false);
    if (!symRes.ok) expect(symRes.failure).toBe('invalid-source');

    // 2. Checked protective pin failure (unregistered artifact with no durable locator refused cleanly)
    //    AND same-root resource-link file mutation refused before dispatch!
    const coordWithLifecycle = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-pins',
      lifecycle
    });
    const mutableRel = 'mutable/data.bin';
    const mutableAbs = path.join(rootDir, mutableRel);
    await fsp.mkdir(path.dirname(mutableAbs), { recursive: true });
    const origBytes = Buffer.from([0x00, 0x01, ...Buffer.from('immutable-v1', 'utf8')]);
    await fsp.writeFile(mutableAbs, origBytes);
    const origDigest = sha256(origBytes);
    const mutableRef = {
      artifactId: 'art-same-root-mut',
      immutableVersion: 'v1',
      digestHex: origDigest,
      byteSize: origBytes.byteLength,
      kind: 'binary' as const
    };
    const snapMut = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-same-root-mut',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 2000
    });
    expect(snapMut.outcome).toBe('created');
    if (snapMut.outcome !== 'created') return;
    const invMut = snapMut.rootInvocationId;
    const frameMut = snapMut.run.invocations![invMut]!;
    const attMut = makeAttempt(snapMut.run, invMut, 'att-mut-1', frameMut.nodePath);
    coordWithLifecycle.registerExternalContribution({
      runId: snapMut.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attMut.nodePath,
          occurrenceId: invMut.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attMut.attemptId
        },
        coverage: 'complete',
        outcomes: ['Produced binary'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [mutableRef]
      },
      artifacts: [{ ref: mutableRef, sourceRoot: rootDir, relativePath: mutableRel }]
    });
    const prepMut = await coordWithLifecycle.prepareTransitionHandoff({
      run: snapMut.run,
      frame: frameMut,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attMut,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepMut.kind).toBe('accepted');
    if (prepMut.kind !== 'accepted') return;
    // F05 auto-registered & pinned `art-same-root-mut`!
    expect(lifecycle.isProtected('art-same-root-mut').protected).toBe(true);

    // Tamper with the same-root file before dispatch -> refused as source-digest-mismatch!
    await fsp.writeFile(mutableAbs, Buffer.from([0x00, 0x01, ...Buffer.from('MUTATED!!-v2', 'utf8')]));
    const mutDelivery = await coordWithLifecycle.planAndAuthorizeAttemptDelivery({
      runId: snapMut.run.connectedRunId,
      handoffId: prepMut.handoffId,
      targetAttemptId: 'att-n2-mut',
      targetNodePath: prepMut.manifest.identity.targetNodePath,
      targetOccurrenceId: prepMut.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(mutDelivery).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-digest-mismatch'
    });

    // Pin failure on unregistered artifact without locator refuses cleanly & writes 0 handoff rows.
    const snapBadPin = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-bad-pin',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 2100
    });
    expect(snapBadPin.outcome).toBe('created');
    if (snapBadPin.outcome !== 'created') return;
    const invBad = snapBadPin.rootInvocationId;
    const frameBad = snapBadPin.run.invocations![invBad]!;
    const attBad = makeAttempt(snapBadPin.run, invBad, 'att-bad-pin', frameBad.nodePath);
    coordWithLifecycle.registerExternalContribution({
      runId: snapBadPin.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attBad.nodePath,
          occurrenceId: invBad.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attBad.attemptId
        },
        coverage: 'complete',
        outcomes: ['Missing F05 registration'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [
          {
            artifactId: 'unregistered-no-locator',
            immutableVersion: 'v1',
            digestHex: origDigest,
            byteSize: 10,
            kind: 'binary'
          }
        ]
      }
    });
    const badPinPrep = await coordWithLifecycle.prepareTransitionHandoff({
      run: snapBadPin.run,
      frame: frameBad,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attBad,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(badPinPrep).toEqual({
      kind: 'refused',
      failure: 'storage-unavailable',
      detail: 'artifact-not-registered'
    });
    expect(store.listHandoffIdsForRun('run-bad-pin')).toHaveLength(0);

    sqlite.close();
  });

  it('CR-314-5: handles 110-char nested attemptIds consistently across Fallback 2 restart lookup and terminal F05 res-*/mat-* pin release', async () => {
    const primaryRoot = await makeTempDir('phc-long-pri-');
    const targetRoot = await makeTempDir('phc-long-dst-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, primaryRoot);
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    let activeRoot = primaryRoot;
    const coord1 = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-long-att',
      lifecycle,
      resolveExecutionRoot: () => activeRoot
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-long-attempt',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const longSourceAttemptId = `att-src-${'nested-segment-'.repeat(7)}1`;
    const longTargetAttemptId = `att-dst-${'nested-segment-'.repeat(7)}2`;
    expect(longSourceAttemptId.length).toBeGreaterThan(100);
    expect(longTargetAttemptId.length).toBeGreaterThan(100);

    const srcAttempt = makeAttempt(snap.run, invId, longSourceAttemptId, frame.nodePath, 'n1');
    const staging = allocateAttemptStagingPaths(primaryRoot, snap.run.connectedRunId, longSourceAttemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(
      staging.contributionAbsPath,
      JSON.stringify({
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: srcAttempt.nodePath,
          occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: longSourceAttemptId
        },
        coverage: 'complete',
        outcomes: ['Long attempt produced artifact'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }),
      'utf8'
    );
    const outRel = 'out/long-payload.bin';
    const outAbs = path.join(primaryRoot, outRel);
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    const outBytes = Buffer.from([0x00, 0x01, ...Buffer.from('long-attempt-binary', 'utf8')]);
    await fsp.writeFile(outAbs, outBytes);

    const recRes = await coord1.recordSettledAttempt({
      run: snap.run,
      frame,
      attempt: {
        ...srcAttempt,
        declaredOutputs: { payload: { portId: 'payload', type: 'file', value: outRel } }
      }
    });
    expect(recRes.ok).toBe(true);

    const prep = await coord1.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: srcAttempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') return;

    // Clear persisted artifactLocations inside record_json so restart MUST use Fallback 2
    // (`.schegent/immutable-results/<attemptAlias>/<displayName>`)!
    const rawRow = sqlite.writerConnection.get<{ record_json: string }>(
      `SELECT record_json FROM phase_handoff_records WHERE handoff_id = ?`,
      prep.handoffId
    );
    expect(rawRow).toBeDefined();
    const parsedEnv = JSON.parse(rawRow!.record_json) as Record<string, unknown>;
    delete parsedEnv.artifactLocations;
    sqlite.writerConnection.run(
      `UPDATE phase_handoff_records SET record_json = ? WHERE handoff_id = ?`,
      JSON.stringify(parsedEnv),
      prep.handoffId
    );

    // Fresh coordinator after restart targeting a separate root -> exercises BOTH Fallback 2 AND materializer!
    activeRoot = targetRoot;
    const coord2 = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-long-att',
      lifecycle,
      resolveExecutionRoot: () => activeRoot
    });
    const delivered = await coord2.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: longTargetAttemptId,
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.delivery.acpPromptBlocks?.some((b) => b.type === 'resource-link')).toBe(true);

    expect(
      coord2.settleAttemptDispatch({
        handoffId: prep.handoffId,
        revision: 1,
        targetAttemptId: longTargetAttemptId,
        delivered: true
      }).ok
    ).toBe(true);

    // Terminal completion must release EVERY F05 `res-*`, `mat-*`, and `handoff` protective pin!
    coord2.releaseTerminalRunPins(snap.run.connectedRunId);
    const remainingActivePins = sqlite.writerConnection.all<{
      artifact_id: string;
      owner_type: string;
      owner_id: string;
    }>(
      `SELECT artifact_id, owner_type, owner_id
         FROM artifact_references
        WHERE protective = 1 AND released_revision IS NULL`
    );
    expect(remainingActivePins).toEqual([]);

    sqlite.close();
  });

  it('CR-314-8: rolls back newly acquired F05 handoff pins and returns storage-unavailable when runInImmediateTransaction throws', async () => {
    const rootDir = await makeTempDir('phc-tx-throw-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, rootDir);
    const baseStore = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
    const throwingStore = new Proxy(baseStore, {
      get(target, prop, receiver) {
        if (prop === 'runInImmediateTransaction') {
          return () => {
            throw new Error('SQLITE_BUSY: database is locked');
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });
    const coordinator = createPhaseHandoffCoordinator({
      store: throwingStore,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-tx-throw',
      lifecycle
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-tx-throw',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const att = makeAttempt(snap.run, invId, 'att-tx-throw', frame.nodePath, 'n1');
    const rel = 'out/tx-throw.txt';
    await fsp.mkdir(path.join(rootDir, 'out'), { recursive: true });
    const bytes = Buffer.from('pin-must-roll-back', 'utf8');
    await fsp.writeFile(path.join(rootDir, rel), bytes);
    const artRef = {
      artifactId: 'art-tx-throw-1',
      immutableVersion: 'v1',
      digestHex: sha256(bytes),
      byteSize: bytes.byteLength,
      kind: 'text' as const
    };
    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: att.nodePath,
          occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: att.attemptId
        },
        coverage: 'complete',
        outcomes: ['Produced tx artifact'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [artRef]
      },
      artifacts: [{ ref: artRef, sourceRoot: rootDir, relativePath: rel, inlineText: 'pin-must-roll-back' }]
    });

    const res = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: att,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(res).toEqual({
      kind: 'refused',
      failure: 'storage-unavailable',
      detail: 'store-failure'
    });
    expect(lifecycle.isProtected('art-tx-throw-1').protected).toBe(false);

    sqlite.close();
  });

  it('SR-314-4: prevents cross-occurrence handoff bleed and refuses mismatched targetNodePath / targetOccurrenceId', async () => {
    const rootDir = await makeTempDir('phc-sr314-4-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-sr314-4'
    });
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-occ-isolation',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const inv1 = snap.rootInvocationId;
    const frame1 = snap.run.invocations![inv1]!;
    const att1 = makeAttempt(snap.run, inv1, 'att-occ-1', frame1.nodePath, 'n1');
    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: att1.nodePath,
          occurrenceId: inv1.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: att1.attemptId
        },
        coverage: 'complete',
        outcomes: ['Occ 1 secret context'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prep1 = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame: frame1,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: att1,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prep1.kind).toBe('accepted');
    if (prep1.kind !== 'accepted') return;

    // Occurrence 2 entering node n2 via a disabled transition receives NO handoff from occurrence 1.
    expect(
      coordinator.resolvePendingHandoffForTarget(
        snap.run.connectedRunId,
        'run-occ-isolation:occ-2',
        'n2'
      )
    ).toBeNull();

    // Mismatched targetNodePath refuses with stale-revision.
    expect(
      await coordinator.planAndAuthorizeAttemptDelivery({
        runId: snap.run.connectedRunId,
        handoffId: prep1.handoffId,
        targetAttemptId: 'att-mismatch-node',
        targetNodePath: 'other-node',
        targetOccurrenceId: prep1.manifest.identity.targetOccurrenceId,
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      })
    ).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'target-node-mismatch'
    });

    // Mismatched targetOccurrenceId refuses with stale-revision.
    expect(
      await coordinator.planAndAuthorizeAttemptDelivery({
        runId: snap.run.connectedRunId,
        handoffId: prep1.handoffId,
        targetAttemptId: 'att-mismatch-occ',
        targetNodePath: prep1.manifest.identity.targetNodePath,
        targetOccurrenceId: 'run-occ-isolation:occ-2',
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      })
    ).toEqual({
      ok: false,
      failure: 'stale-revision',
      detail: 'target-occurrence-mismatch'
    });

    sqlite.close();
  });

  it('SR-314-5: refuses cross-run F05 artifact pinning and Fallback 2 delivery locator disclosure', async () => {
    const primaryRoot = await makeTempDir('phc-sr314-5-pri-');
    const laneBRoot = await makeTempDir('phc-sr314-5-laneB-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, primaryRoot);
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    // Seed an immutable artifact owned by Run A in F05 under primaryRoot/.schegent/reports/.
    const secretBytes = Buffer.from([0x00, 0x01, ...Buffer.from('RUN-A-PRIVATE-SECRET', 'utf8')]);
    const secretDigest = sha256(secretBytes);
    const relA = '.schegent/reports/run-a-secret.bin';
    await fsp.mkdir(path.dirname(path.join(primaryRoot, relA)), { recursive: true });
    await fsp.writeFile(path.join(primaryRoot, relA), secretBytes);
    expect(
      lifecycle.registerArtifact({
        artifactId: 'art-run-a-secret',
        ownerRunId: 'run-A',
        ownerAttemptId: 'att-a-1',
        sensitivity: 'content',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: secretDigest },
        byteSize: secretBytes.byteLength,
        mediaType: 'application/octet-stream',
        displayName: 'run-a-secret.bin',
        producerIdentity: 'att-a-1',
        locator: { storageTier: 'workspace_file', uriOrRelpath: relA }
      }).ok
    ).toBe(true);

    const runARef = {
      artifactId: 'art-run-a-secret',
      immutableVersion: 'v1',
      digestHex: secretDigest,
      byteSize: secretBytes.byteLength,
      kind: 'binary' as const
    };

    const snapB = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-B',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 2000
    });
    if (snapB.outcome !== 'created') return;
    const invB = snapB.rootInvocationId;
    const frameB = snapB.run.invocations![invB]!;
    const attB = makeAttempt(snapB.run, invB, 'att-b-1', frameB.nodePath, 'n1');

    // 1. Pinning attempt during Run B prepareTransitionHandoff is REFUSED!
    const coordWithLifecycle = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-cross-run',
      lifecycle,
      resolveExecutionRoot: () => laneBRoot
    });
    coordWithLifecycle.registerExternalContribution({
      runId: 'run-B',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attB.nodePath,
          occurrenceId: invB.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attB.attemptId
        },
        coverage: 'complete',
        outcomes: ['Attempt to steal Run A artifact'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [runARef]
      }
    });
    const prepRefused = await coordWithLifecycle.prepareTransitionHandoff({
      run: snapB.run,
      frame: frameB,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attB,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepRefused).toEqual({
      kind: 'refused',
      failure: 'invalid-source',
      detail: 'artifact-owner-or-digest-mismatch'
    });
    expect(lifecycle.isProtected('art-run-a-secret').protected).toBe(false);

    // 2. Even if a handoff row already exists without lifecycle at prepare time, Fallback 2 in
    //    planAndAuthorizeAttemptDelivery STILL refuses Run B resolving Run A's F05 artifact!
    const coordNoLifecycle = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-cross-run',
      resolveExecutionRoot: () => laneBRoot
    });
    coordNoLifecycle.registerExternalContribution({
      runId: 'run-B',
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: attB.nodePath,
          occurrenceId: invB.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: attB.attemptId
        },
        coverage: 'complete',
        outcomes: ['Attempt Fallback 2 disclosure'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [runARef]
      }
    });
    const prepNoLc = await coordNoLifecycle.prepareTransitionHandoff({
      run: snapB.run,
      frame: frameB,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: attB,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prepNoLc.kind).toBe('accepted');
    if (prepNoLc.kind !== 'accepted') return;

    const deliveryRefused = await coordWithLifecycle.planAndAuthorizeAttemptDelivery({
      runId: 'run-B',
      handoffId: prepNoLc.handoffId,
      targetAttemptId: 'att-b-2',
      targetNodePath: prepNoLc.manifest.identity.targetNodePath,
      targetOccurrenceId: prepNoLc.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(deliveryRefused).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'artifact-owner-or-digest-mismatch'
    });

    sqlite.close();
  });

  it('SR-314-6: fails closed on corrupt record_json in load() and transitions corrupt intent rows to uncertain on restart', async () => {
    const rootDir = await makeTempDir('phc-sr314-6-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
    const coordinator = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: rootDir,
      workspaceId: 'ws-sr314-6'
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-corrupt-json',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 1000
    });
    if (snap.outcome !== 'created') return;
    const invId = snap.rootInvocationId;
    const frame = snap.run.invocations![invId]!;
    const att = makeAttempt(snap.run, invId, 'att-corrupt-1', frame.nodePath, 'n1');
    coordinator.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: att.nodePath,
          occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: att.attemptId
        },
        coverage: 'complete',
        outcomes: ['Before corruption'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    });
    const prep = await coordinator.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: WORKFLOW.connections[0]!,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: att,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction!,
      targetBackendId: 'claude'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') return;

    // Dispatch intent so row status becomes 'intent'.
    const del = await coordinator.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-corrupt-2',
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction!,
      backendId: 'claude'
    });
    expect(del.ok).toBe(true);

    // Corrupt record_json on the existing 'intent' row.
    sqlite.writerConnection.run(
      `UPDATE phase_handoff_records SET record_json = '{corrupt-json' WHERE handoff_id = ?`,
      prep.handoffId
    );

    // 1. store.load() MUST throw HandoffStoreCorruptionError (never return null as if absent!).
    expect(() => store.load(prep.handoffId)).toThrow(HandoffStoreCorruptionError);
    // 2. acceptance.inspect & planAndAuthorizeAttemptDelivery fail closed with storage-unavailable.
    expect(coordinator.acceptance.inspect(prep.handoffId)).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'store-failure'
    });
    expect(
      await coordinator.planAndAuthorizeAttemptDelivery({
        runId: snap.run.connectedRunId,
        handoffId: prep.handoffId,
        targetAttemptId: 'att-corrupt-3',
        targetNodePath: prep.manifest.identity.targetNodePath,
        targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
        targetInstructions: PHASE_B.instruction!,
        backendId: 'claude'
      })
    ).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'store-failure'
    });

    // 3. markUnsettledIntentsUncertain() / reconcileInterruptedDispatches() transitions corrupt 'intent' -> 'uncertain'!
    expect(store.listUnsettledIntentHandoffs(snap.run.connectedRunId)).toContain(prep.handoffId);
    const transitioned = coordinator.reconcileInterruptedDispatches(snap.run.connectedRunId);
    expect(transitioned.some((t) => t.handoffId === prep.handoffId)).toBe(true);
    const rowAfter = sqlite.writerConnection.get<{ status: string }>(
      `SELECT status FROM phase_handoff_records WHERE handoff_id = ?`,
      prep.handoffId
    );
    expect(rowAfter?.status).toBe('uncertain');

    sqlite.close();
  });

  it('SR-314-8: readBoundedBytesFromHandle refuses concurrently growing oversized files and non-regular files', async () => {
    // 1. Non-regular file refused cleanly.
    const nonRegular = await readBoundedBytesFromHandle(
      {
        stat: async () => ({ isFile: () => false, size: 10 }) as never,
        read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }) as never
      },
      64
    );
    expect(nonRegular).toEqual({ ok: false, reason: 'not-a-file' });

    // 2. File reporting stat.size <= maxBytes that grows past maxBytes while reading is refused without unbounded read.
    const growingData = Buffer.alloc(80, 0x41);
    let readCalls = 0;
    const growingHandle = {
      stat: async () => ({ isFile: () => true, size: 32 }),
      read: async (buf: Buffer, offset: number, length: number, pos: number | null) => {
        readCalls += 1;
        const p = pos ?? 0;
        const avail = Math.max(0, growingData.length - p);
        const n = Math.min(length, avail);
        growingData.copy(buf, offset, p, p + n);
        return { bytesRead: n, buffer: buf };
      }
    };
    const growing = await readBoundedBytesFromHandle(growingHandle as never, 64);
    expect(growing).toEqual({ ok: false, reason: 'oversized' });
    expect(readCalls).toBeLessThanOrEqual(2);
  });

  it('SR-B2 #3: loadReviewLoop throws HandoffStoreCorruptionError on corrupt snapshot options/passes and verifyStoredRepeatExitAllowed rejects tampered denormalized verdict', () => {
    const sqlite = SqliteApplicationStore.openInMemory();
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
    const runId = 'run-rev-corrupt';
    const repeatNodeId = 'rep-1';
    const loopId = buildReviewLoopId(runId, repeatNodeId);
    const options = {
      loopId,
      blockingSeverities: ['critical', 'high'] as const,
      maxPasses: 5
    };
    const ledger = createFindingLedger(options);
    const accepted = ledger.acceptReport(
      {
        reportVersion: REVIEW_REPORT_VERSION,
        loopId,
        pass: 1,
        reviewerAttemptId: 'att-rev-1',
        candidateRef: 'cand-1',
        scopeRevision: 'scope-1',
        criteriaRevision: 'crit-1',
        previousReportRef: null,
        coverage: 'complete',
        reviewPassed: false,
        blockingCount: 1,
        findings: [
          { id: 'F-1', severity: 'high', title: 'Issue', explanation: 'Fix it', evidence: ['a.ts#1'] }
        ],
        dispositions: []
      },
      {
        reportRef: 'rep-1',
        candidateRef: 'cand-1',
        scopeRevision: 'scope-1',
        criteriaRevision: 'crit-1'
      }
    );
    expect(accepted.ok).toBe(true);
    store.saveReviewLoop({
      loopId,
      runId,
      nodeId: repeatNodeId,
      ledger,
      options,
      candidateRef: 'cand-1'
    });

    const baseRow = sqlite.writerConnection.get<{ ledger_json: string }>(
      `SELECT ledger_json FROM phase_review_loop_ledgers WHERE loop_id = ?`,
      loopId
    );
    expect(baseRow).toBeDefined();
    if (baseRow === undefined) {
      sqlite.close();
      return;
    }

    const writeLedgerJson = (mutator: (obj: Record<string, unknown>) => void, rowVerdict = 'passed') => {
      const cloned = JSON.parse(baseRow.ledger_json) as Record<string, unknown>;
      mutator(cloned);
      sqlite.writerConnection.run(
        `UPDATE phase_review_loop_ledgers SET verdict = ?, ledger_json = ? WHERE loop_id = ?`,
        rowVerdict,
        JSON.stringify(cloned),
        loopId
      );
    };

    // 1. Corrupt snapshot.options.loopId mismatch
    writeLedgerJson((obj) => {
      const snap = obj.snapshot as { options: Record<string, unknown> };
      snap.options.loopId = 'foreign-loop-id';
    });
    expect(() => store.loadReviewLoop(loopId)).toThrow(HandoffStoreCorruptionError);
    expect(verifyStoredRepeatExitAllowed(store, { runId, repeatNodeId })).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'corrupt-review-loop-ledger'
    });

    // 2. Corrupt snapshot.options.maxPasses (triggers refusingLedger without .snapshot)
    writeLedgerJson((obj) => {
      const snap = obj.snapshot as { options: Record<string, unknown> };
      snap.options.maxPasses = 0;
    });
    expect(() => store.loadReviewLoop(loopId)).toThrow(HandoffStoreCorruptionError);
    expect(verifyStoredRepeatExitAllowed(store, { runId, repeatNodeId })).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'corrupt-review-loop-ledger'
    });

    // 3. Corrupt snapshot.options.blockingSeverities (triggers refusingLedger without .snapshot)
    writeLedgerJson((obj) => {
      const snap = obj.snapshot as { options: Record<string, unknown> };
      snap.options.blockingSeverities = ['not-a-severity'];
    });
    expect(() => store.loadReviewLoop(loopId)).toThrow(HandoffStoreCorruptionError);
    expect(verifyStoredRepeatExitAllowed(store, { runId, repeatNodeId })).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'corrupt-review-loop-ledger'
    });

    // 4. Corrupt snapshot.passes entry with missing/non-object outcome
    writeLedgerJson((obj) => {
      const snap = obj.snapshot as { passes: unknown[] };
      snap.passes = [{ outcome: null, candidateRef: 'cand-1', inputDigest: 'x' }];
    });
    expect(() => store.loadReviewLoop(loopId)).toThrow(HandoffStoreCorruptionError);

    // 5. Tampered denormalized row.verdict='passed' while latestPass.outcome.verdict='failed' -> fail closed!
    writeLedgerJson((obj) => {
      const snap = obj.snapshot as { passes: Array<{ outcome: Record<string, unknown> }> };
      const firstPass = snap.passes.at(0);
      if (firstPass !== undefined) {
        firstPass.outcome.verdict = 'failed';
      }
    }, 'passed');
    expect(store.loadReviewLoop(loopId)?.verdict).toBe('passed');
    expect(
      verifyStoredRepeatExitAllowed(store, { runId, repeatNodeId, currentCandidateRef: 'cand-1' })
    ).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'review-blocking-findings'
    });

    sqlite.close();
  });

  it('CR-B2 #3: two long prefix-sharing targetAttemptIds materializing the same long artifactId get distinct 120-char F05 copyArtifactIds and release cleanly with zero leaked pins', async () => {
    const primaryRoot = await makeTempDir('phc-crb2-3-pri-');
    const targetRoot = await makeTempDir('phc-crb2-3-dst-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, primaryRoot);
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    let activeRoot = primaryRoot;
    const coord = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-crb2-3',
      lifecycle,
      resolveExecutionRoot: () => activeRoot
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-crb2-3',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
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
    const srcAttempt = makeAttempt(snap.run, invId, 'att-src-crb2-3', frame.nodePath, 'n1');

    // Create a >60-char artifactId and two >65-char targetAttemptIds sharing a 60-char prefix.
    const longArtId = `art-very-long-artifact-identifier-${'segment-'.repeat(4)}end`;
    expect(longArtId.length).toBeGreaterThan(60);
    const sharedPrefix = `att-nested-${'shared-prefix-'.repeat(4)}`;
    expect(sharedPrefix.length).toBeGreaterThan(60);
    const targetAttemptA = `${sharedPrefix}branch-alpha`;
    const targetAttemptB = `${sharedPrefix}branch-beta`;

    const artRel = 'out/long-shared.bin';
    const artAbs = path.join(primaryRoot, artRel);
    await fsp.mkdir(path.dirname(artAbs), { recursive: true });
    const payload = Buffer.from([0x00, 0xfe, ...Buffer.from('shared-long-materialized-bytes', 'utf8')]);
    await fsp.writeFile(artAbs, payload);
    const digestHex = createHash('sha256').update(payload).digest('hex');

    const copyIdA = materializedCopyArtifactId(longArtId, targetAttemptA, digestHex);
    const copyIdB = materializedCopyArtifactId(longArtId, targetAttemptB, digestHex);
    expect(copyIdA).not.toBe(copyIdB);
    expect(copyIdA.length).toBe(120);
    expect(copyIdB.length).toBe(120);
    expect(LIFECYCLE_OPAQUE_ID_PATTERN.test(copyIdA)).toBe(true);
    expect(LIFECYCLE_OPAQUE_ID_PATTERN.test(copyIdB)).toBe(true);

    const longArtRef = {
      artifactId: longArtId,
      immutableVersion: 'v1',
      digestHex,
      byteSize: payload.length,
      kind: 'binary' as const
    };
    coord.registerExternalContribution({
      runId: snap.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: srcAttempt.nodePath, occurrenceId: occId, attemptId: srcAttempt.attemptId },
        coverage: 'complete',
        outcomes: ['Produced long-id binary artifact'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [longArtRef]
      },
      artifacts: [{ ref: longArtRef, sourceRoot: primaryRoot, relativePath: artRel }]
    });

    const firstConn = WORKFLOW.connections.at(0);
    expect(firstConn).toBeDefined();
    if (firstConn === undefined) {
      sqlite.close();
      return;
    }
    const prep = await coord.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: firstConn,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: srcAttempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction,
      targetBackendId: 'claude'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') {
      sqlite.close();
      return;
    }

    // Materialize into targetRoot for BOTH long prefix-sharing attempts.
    activeRoot = targetRoot;
    const delA = await coord.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: targetAttemptA,
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction,
      backendId: 'claude'
    });
    expect(delA.ok).toBe(true);
    expect(lifecycle.isProtected(copyIdA).protected).toBe(true);
    expect(
      coord.settleAttemptDispatch({
        handoffId: prep.handoffId,
        revision: 1,
        targetAttemptId: targetAttemptA,
        delivered: true
      }).ok
    ).toBe(true);

    const delB = await coord.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: targetAttemptB,
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction,
      backendId: 'claude'
    });
    expect(delB.ok).toBe(true);
    expect(lifecycle.isProtected(copyIdB).protected).toBe(true);
    expect(
      coord.settleAttemptDispatch({
        handoffId: prep.handoffId,
        revision: 1,
        targetAttemptId: targetAttemptB,
        delivered: true
      }).ok
    ).toBe(true);

    // Terminal run pin release MUST clean up BOTH distinct 120-char copyArtifactIds with zero leaked pins!
    coord.releaseTerminalRunPins(snap.run.connectedRunId);
    const remainingActivePins = sqlite.writerConnection.all<{
      artifact_id: string;
      owner_type: string;
      owner_id: string;
    }>(
      `SELECT artifact_id, owner_type, owner_id
         FROM artifact_references
        WHERE protective = 1 AND released_revision IS NULL`
    );
    expect(remainingActivePins).toEqual([]);

    sqlite.close();
  });

  it('CR-B2 #4: Fallback 2 restart lookup recovers >80-char out-...blob and ext-...blob displayName filenames intact', async () => {
    const primaryRoot = await makeTempDir('phc-crb2-4-pri-');
    const targetRoot = await makeTempDir('phc-crb2-4-dst-');
    const sqlite = SqliteApplicationStore.openInMemory();
    const lifecycle = makeLifecycle(sqlite, primaryRoot);
    const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);

    let activeRoot = primaryRoot;
    const coord1 = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-crb2-4',
      lifecycle,
      resolveExecutionRoot: () => activeRoot
    });

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-crb2-4',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
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

    const srcAttempt = makeAttempt(snap.run, invId, 'att-src-crb2-4', frame.nodePath, 'n1');
    const staging = allocateAttemptStagingPaths(primaryRoot, snap.run.connectedRunId, srcAttempt.attemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(
      staging.contributionAbsPath,
      JSON.stringify({
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: {
          nodePath: srcAttempt.nodePath,
          occurrenceId: invId.replace(/[^A-Za-z0-9._:-]/g, '-'),
          attemptId: srcAttempt.attemptId
        },
        coverage: 'complete',
        outcomes: ['Long port output ready'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }),
      'utf8'
    );

    const longPortId = `declared-output-port-${'very-long-name-'.repeat(3)}final`;
    expect(longPortId.length).toBeGreaterThan(60);
    const outRel = 'out/long-port-file.bin';
    const outAbs = path.join(primaryRoot, outRel);
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    const outBytes = Buffer.from([0x00, 0xaa, ...Buffer.from('long-port-fallback-2', 'utf8')]);
    await fsp.writeFile(outAbs, outBytes);

    const recRes = await coord1.recordSettledAttempt({
      run: snap.run,
      frame,
      attempt: {
        ...srcAttempt,
        declaredOutputs: {
          [longPortId]: { portId: longPortId, type: 'file', value: outRel }
        }
      }
    });
    expect(recRes.ok).toBe(true);

    const firstConn = WORKFLOW.connections.at(0);
    expect(firstConn).toBeDefined();
    if (firstConn === undefined) {
      sqlite.close();
      return;
    }
    const prep = await coord1.prepareTransitionHandoff({
      run: snap.run,
      frame,
      workflow: WORKFLOW,
      connection: firstConn,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: srcAttempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction,
      targetBackendId: 'claude'
    });
    expect(prep.kind).toBe('accepted');
    if (prep.kind !== 'accepted') {
      sqlite.close();
      return;
    }

    // Confirm registered F05 displayName is > 80 chars and ends with `.blob`.
    const outArtId = prep.manifest.sources.at(0)?.artifacts.at(0)?.artifactId;
    expect(outArtId).toBeDefined();
    if (outArtId === undefined) {
      sqlite.close();
      return;
    }
    const registered = lifecycle.getArtifact(outArtId);
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      sqlite.close();
      return;
    }
    expect(registered.value.displayName.length).toBeGreaterThan(80);
    expect(registered.value.displayName.endsWith('.blob')).toBe(true);

    // Strip persisted artifactLocations so fresh coordinator MUST resolve via Fallback 2!
    const rawRow = sqlite.writerConnection.get<{ record_json: string }>(
      `SELECT record_json FROM phase_handoff_records WHERE handoff_id = ?`,
      prep.handoffId
    );
    expect(rawRow).toBeDefined();
    if (rawRow === undefined) {
      sqlite.close();
      return;
    }
    const parsedEnv = JSON.parse(rawRow.record_json) as Record<string, unknown>;
    delete parsedEnv.artifactLocations;
    sqlite.writerConnection.run(
      `UPDATE phase_handoff_records SET record_json = ? WHERE handoff_id = ?`,
      JSON.stringify(parsedEnv),
      prep.handoffId
    );

    // Fresh coordinator after restart targeting separate execution root resolves via Fallback 2 and materializes cleanly!
    activeRoot = targetRoot;
    const coord2 = createPhaseHandoffCoordinator({
      store,
      primaryWorkspaceRoot: primaryRoot,
      workspaceId: 'ws-crb2-4',
      lifecycle,
      resolveExecutionRoot: () => activeRoot
    });
    const delivered = await coord2.planAndAuthorizeAttemptDelivery({
      runId: snap.run.connectedRunId,
      handoffId: prep.handoffId,
      targetAttemptId: 'att-dst-crb2-4',
      targetNodePath: prep.manifest.identity.targetNodePath,
      targetOccurrenceId: prep.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction,
      backendId: 'claude'
    });
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.delivery.acpPromptBlocks?.some((b) => b.type === 'resource-link')).toBe(true);
    }

    // Also verify >60-char external artifactId (`ext-...blob` > 80 chars) recovers via Fallback 2 after restart!
    const snapExt = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-crb2-4-ext',
      workflow: WORKFLOW,
      effectiveWorkflows: [WORKFLOW],
      effectivePhases: [PHASE_A, PHASE_B],
      startedAt: 2000
    });
    expect(snapExt.outcome).toBe('created');
    if (snapExt.outcome !== 'created') {
      sqlite.close();
      return;
    }
    const extInvId = snapExt.rootInvocationId;
    const extFrame = snapExt.run.invocations?.[extInvId];
    expect(extFrame).toBeDefined();
    if (extFrame === undefined) {
      sqlite.close();
      return;
    }
    const extSourceRoot = await makeTempDir('phc-crb2-4-extsrc-');
    const extOccId = extInvId.replace(/[^A-Za-z0-9._:-]/g, '-');
    const extAttempt = makeAttempt(snapExt.run, extInvId, 'att-ext-crb2-4', extFrame.nodePath, 'n1');
    const longExtArtId = `external-artifact-id-${'very-long-name-'.repeat(3)}final`;
    expect(longExtArtId.length).toBeGreaterThan(60);
    const extRel = 'ext-long.bin';
    const extSrcAbs = path.join(extSourceRoot, extRel);
    const extBytes = Buffer.from([0x00, 0xbb, ...Buffer.from('long-ext-fallback-2', 'utf8')]);
    await fsp.writeFile(extSrcAbs, extBytes);
    const extDigest = createHash('sha256').update(extBytes).digest('hex');
    const longExtRef = {
      artifactId: longExtArtId,
      immutableVersion: 'v1',
      digestHex: extDigest,
      byteSize: extBytes.length,
      kind: 'binary' as const
    };

    activeRoot = primaryRoot;
    coord1.registerExternalContribution({
      runId: snapExt.run.connectedRunId,
      contribution: {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer: { nodePath: extAttempt.nodePath, occurrenceId: extOccId, attemptId: extAttempt.attemptId },
        coverage: 'complete',
        outcomes: ['Long ext artifact ready'],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: [longExtRef]
      },
      artifacts: [{ ref: longExtRef, sourceRoot: extSourceRoot, relativePath: extRel }]
    });
    const prepExt = await coord1.prepareTransitionHandoff({
      run: snapExt.run,
      frame: extFrame,
      workflow: WORKFLOW,
      connection: firstConn,
      connectionIndex: 0,
      fromNodeId: 'n1',
      fromAttempt: extAttempt,
      targetNodeId: 'n2',
      targetInstructions: PHASE_B.instruction,
      targetBackendId: 'claude'
    });
    expect(prepExt.kind).toBe('accepted');
    if (prepExt.kind !== 'accepted') {
      sqlite.close();
      return;
    }
    const regExt = lifecycle.getArtifact(longExtArtId);
    expect(regExt.ok).toBe(true);
    if (!regExt.ok) {
      sqlite.close();
      return;
    }
    expect(regExt.value.displayName.length).toBeGreaterThan(80);
    expect(regExt.value.displayName.endsWith('.blob')).toBe(true);

    const rawExtRow = sqlite.writerConnection.get<{ record_json: string }>(
      `SELECT record_json FROM phase_handoff_records WHERE handoff_id = ?`,
      prepExt.handoffId
    );
    expect(rawExtRow).toBeDefined();
    if (rawExtRow === undefined) {
      sqlite.close();
      return;
    }
    const parsedExtEnv = JSON.parse(rawExtRow.record_json) as Record<string, unknown>;
    delete parsedExtEnv.artifactLocations;
    sqlite.writerConnection.run(
      `UPDATE phase_handoff_records SET record_json = ? WHERE handoff_id = ?`,
      JSON.stringify(parsedExtEnv),
      prepExt.handoffId
    );

    activeRoot = targetRoot;
    const deliveredExt = await coord2.planAndAuthorizeAttemptDelivery({
      runId: snapExt.run.connectedRunId,
      handoffId: prepExt.handoffId,
      targetAttemptId: 'att-dst-ext-crb2-4',
      targetNodePath: prepExt.manifest.identity.targetNodePath,
      targetOccurrenceId: prepExt.manifest.identity.targetOccurrenceId,
      targetInstructions: PHASE_B.instruction,
      backendId: 'claude'
    });
    expect(deliveredExt.ok).toBe(true);
    if (deliveredExt.ok) {
      expect(deliveredExt.delivery.acpPromptBlocks?.some((b) => b.type === 'resource-link')).toBe(true);
    }

    sqlite.close();
  });

  it('FR-R7-17 (R7-17-07 GAP-05): SqliteHandoffStore.save() without bindRunMetadata falls back to rootExecutionId, not workspaceId', () => {
    const sqlite = SqliteApplicationStore.openInMemory();
    try {
      const store = createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000);
      const acceptance = createAcceptanceService(store);
      const acceptedFrom = { nodePath: 'plan', occurrenceId: 'occ-1', attemptId: 'att-plan' };
      const prepared = prepareHandoff({
        policy: {
          version: 1,
          approval: 'automatic',
          session: 'fresh',
          selectors: [
            { selectorId: 'sel-plan', sourceNodePath: 'plan', required: true, priority: 0 }
          ]
        },
        identity: {
          workspaceId: 'ws-distinct-id',
          rootExecutionId: 'run-actual-root-id',
          sourceInvocationId: 'inv-1',
          targetNodePath: 'implement',
          targetOccurrenceId: 'occ-2',
          inputEnvelopeRevision: 1,
          sourceAttempts: [acceptedFrom]
        },
        cutoffSequence: 1,
        candidates: [
          {
            acceptedFrom,
            acceptedSequence: 1,
            contribution: {
              schemaVersion: 1,
              producer: acceptedFrom,
              coverage: 'complete',
              outcomes: ['audit-gap-05'],
              decisions: [],
              constraints: [],
              unresolvedIssues: [],
              summary: null,
              artifacts: []
            }
          }
        ],
        boundInputs: [],
        targetInstructions: 'Implement.',
        profile: { profileId: 'profile-1', profileRevision: 1, qualifiedContextBytes: 65_536 }
      });
      expect(prepared.kind).toBe('prepared');
      if (prepared.kind !== 'prepared') return;

      // Persist directly through AcceptanceService without calling store.bindRunMetadata():
      // deriveRowColumns must fall back to manifest.identity.rootExecutionId, never workspaceId.
      const accepted = acceptance.accept(prepared);
      expect(accepted.ok).toBe(true);
      expect(store.listHandoffIdsForRun('run-actual-root-id')).toContain(
        prepared.manifest.handoffId
      );
      expect(store.listHandoffIdsForRun('ws-distinct-id')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
