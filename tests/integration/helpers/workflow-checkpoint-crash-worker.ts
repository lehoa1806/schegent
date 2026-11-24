/**
 * FR-R8-01 (01-09, T021) — Real crash-matrix worker process executed under
 * disposable WAL SQLite stores and killed via genuine `SIGKILL` immediately
 * before or immediately after each of the eight production checkpoints:
 *   1. prepared-root
 *   2. linked-root
 *   3. admitted-attempt
 *   4. pending-dispatch
 *   5. spawn-intent
 *   6. acknowledged-process
 *   7. settled-attempt
 *   8. terminal-projection
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDesktopOwnershipFenceForStore } from '../../../src/activation/workflow-ownership-fence';
import type { ControlLedger } from '../../../src/contracts/control-ledger';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { PipelineCatalog } from '../../../src/config/pipeline-config';
import { SanitizedLogger } from '../../../src/lib/logger';
import { QueueManager } from '../../../src/queue/queue-manager';
import { ProcessLifecycleRunner } from '../../../src/runner/process-lifecycle-runner';
import { buildSpawnEnv, policyRequestFields } from '../../../src/runner/spawn-env';
import { GuardedRunService } from '../../../src/services/guarded-run-service';
import { validateRunRequest } from '../../../src/services/run-request/run-request-validator';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import { withAttemptSpawnCheckpoints } from '../../../src/services/workflow-execution/attempt-spawn-checkpoints';
import {
  completeComposableNodeAttempt
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import {
  createComposableWorkflowRunSnapshot,
  createNodeAttemptRecord
} from '../../../src/services/workflow-execution/connected-run-factory';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition
} from '../../../src/services/workflow-execution/production-workflow-composition';
import {
  recordNodeAttempt,
  resolveRootInvocationId,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord
} from '../../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { WorkspaceLockManager, type Scheduler } from '../../../src/state/lock';
import { createDiskOwnershipFs } from '../../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

export type CrashCheckpointId =
  | 'prepared-root'
  | 'linked-root'
  | 'admitted-attempt'
  | 'pending-dispatch'
  | 'spawn-intent'
  | 'acknowledged-process'
  | 'settled-attempt'
  | 'terminal-projection';

export type CrashTiming = 'before' | 'after';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeEmptyCatalog(): PipelineCatalog {
  return {
    phases: [],
    pipelines: [],
    models: { claude: [], codex: [], agy: [] },
    defaultPipelineId: 'default',
    phasesById: new Map(),
    pipelinesById: new Map()
  };
}

export const CRASH_MATRIX_PHASE: PhaseDefinition = {
  phaseId: 'phase-work',
  version: 1,
  name: 'Work Phase',
  runner: 'claude',
  sideEffects: 'workspace',
  instruction: 'Perform deterministic work'
};

export const CRASH_MATRIX_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-crash-matrix',
  version: 1,
  name: 'Crash Matrix Workflow',
  nodes: [{ nodeId: 'step1', kind: 'phase', phaseId: 'phase-work', label: 'Step 1' }],
  connections: [],
  startNodeIds: ['step1']
};

async function waitForSigkill(
  checkpoint: CrashCheckpointId,
  timing: CrashTiming,
  extra: Record<string, unknown> = {}
): Promise<never> {
  process.stdout.write(`${JSON.stringify({ readyToKill: true, checkpoint, timing, ...extra })}\n`);
  await new Promise<void>(() => {
    // Intentionally stay alive until parent sends SIGKILL.
    process.stdin.resume();
  });
  process.exit(0);
}

function writeDeterministicFakeCliScript(params: {
  readonly receiptDir: string;
  readonly attemptId: string;
  readonly writeTerminalOutput: boolean;
}): { readonly scriptPath: string; readonly receiptPath: string } {
  const safeId = params.attemptId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const receiptPath = path.join(params.receiptDir, `receipt-${safeId}.json`);
  const scriptPath = path.join(params.receiptDir, `fake-cli-${safeId}.cjs`);
  const script = [
    "const fs = require('node:fs');",
    `const receiptPath = ${JSON.stringify(receiptPath)};`,
    `const payload = { pid: process.pid, attemptId: ${JSON.stringify(params.attemptId)}, wroteAt: Date.now(), terminalOutput: ${JSON.stringify(params.writeTerminalOutput)} };`,
    "fs.writeFileSync(receiptPath, JSON.stringify(payload), 'utf8');",
    "process.stdout.write(JSON.stringify({ providerReceiptWritten: true, pid: process.pid }) + '\\n');",
    'process.exit(0);'
  ].join('\n');
  fs.writeFileSync(scriptPath, script, 'utf8');
  return { scriptPath, receiptPath };
}

function stampQueueItemOnRawLedger(
  rawLedger: unknown,
  ledgerRunId: string,
  attemptId: string,
  queueItemId: string
): { readonly ok: true; readonly nextLedger: unknown } {
  if (typeof rawLedger !== 'object' || rawLedger === null || !('roots' in rawLedger)) {
    return { ok: true, nextLedger: rawLedger };
  }
  const ledger = rawLedger as ControlLedger;
  const roots = ledger.roots as Readonly<Record<string, ControlLedger['roots'][string] | undefined>>;
  const root = Object.hasOwn(roots, ledgerRunId) ? roots[ledgerRunId] : undefined;
  if (root === undefined) {
    return { ok: true, nextLedger: rawLedger };
  }
  const attempts = root.attemptsById as Readonly<
    Record<string, ControlLedger['roots'][string]['attemptsById'][string] | undefined>
  >;
  const attempt = Object.hasOwn(attempts, attemptId) ? attempts[attemptId] : undefined;
  if (attempt === undefined) return { ok: true, nextLedger: rawLedger };
  return {
    ok: true,
    nextLedger: Object.freeze({
      ...ledger,
      roots: {
        ...ledger.roots,
        [ledgerRunId]: Object.freeze({
          ...root,
          attemptsById: {
            ...root.attemptsById,
            [attemptId]: Object.freeze({ ...attempt, queueItemId })
          }
        })
      }
    })
  };
}

async function runWorker(): Promise<void> {
  const dbPath = process.argv.at(2);
  const workspaceRoot = process.argv.at(3);
  const receiptDir = process.argv.at(4);
  const targetCheckpointArg = process.argv.at(5);
  const timingArg = process.argv.at(6);
  const runIdArg = process.argv.at(7);
  if (
    dbPath === undefined ||
    workspaceRoot === undefined ||
    receiptDir === undefined ||
    targetCheckpointArg === undefined ||
    timingArg === undefined ||
    runIdArg === undefined
  ) {
    throw new Error('Usage: worker <dbPath> <workspaceRoot> <receiptDir> <checkpoint> <before|after> <runId>');
  }
  const targetCheckpoint = targetCheckpointArg as CrashCheckpointId;
  const timing = timingArg as CrashTiming;
  const connectedRunId = runIdArg;
  const scopeId = 'crash-matrix-scope';

  const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, scopeId);
  const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(
    createDiskOwnershipFs({ workspaceRoot, ownershipDir }),
    ownershipDir
  );
  await store.initialize();
  const lock = new WorkspaceLockManager(store, 'crash-worker-win', { now: () => Date.now() }, noopScheduler);
  await lock.tryAcquire();
  store.bindPrimacyClaimSource(lock);
  const lease = new ExecutionLeaseManager(store, 'crash-worker-win', { now: () => Date.now() }, noopScheduler);
  store.bindRunClaimSource(lease);
  const queue = new QueueManager(store);
  const logger = new SanitizedLogger();
  const guardedRun = new GuardedRunService({
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller: { getCatalog: makeEmptyCatalog },
    logger,
    store,
    catalogProvider: makeEmptyCatalog
  });
  const desktopFence = createDesktopOwnershipFenceForStore(store);
  const composition = createProductionWorkflowComposition({
    store,
    workspaceRoot,
    isWorkspaceTrusted: () => true,
    ...desktopFence,
    requireLiveFenceVerifier: true
  });
  registerProductionWorkflowComposition(store, composition);

  const now = Date.now();
  const validated = await validateRunRequest(
    {
      pipelineId: CRASH_MATRIX_WORKFLOW.workflowId,
      workflowId: CRASH_MATRIX_WORKFLOW.workflowId,
      entryNodeId: 'step1',
      inputs: [],
      supplemental: [],
      outputs: []
    },
    {
      workflow: {
        rootWorkflow: CRASH_MATRIX_WORKFLOW,
        workflows: [CRASH_MATRIX_WORKFLOW],
        phases: [CRASH_MATRIX_PHASE]
      },
      workspaceRoot,
      now,
      localInputs: {
        checkFile: async () => ({ ok: true }),
        checkFolder: async () => ({ ok: true })
      },
      outputProbe: { exists: async () => false },
      priorOutputs: { outputsFor: () => null }
    }
  );
  if (!validated.ok || validated.plan.frozenClosure === undefined) {
    throw new Error('Failed to validate crash-matrix workflow');
  }

  const snap = createComposableWorkflowRunSnapshot({
    connectedRunId,
    workflow: CRASH_MATRIX_WORKFLOW,
    entryNodeId: 'step1',
    frozenClosure: validated.plan.frozenClosure,
    boundInputs: {},
    startedAt: now,
    queueId: 'default'
  });
  if (snap.outcome !== 'created') {
    throw new Error('Failed to create composable snapshot');
  }

  const rootInvId = resolveRootInvocationId(snap.run);
  const fence = desktopFence.resolveExecutionFence(snap.run, 'default');

  // Checkpoint 1: prepared-root
  if (targetCheckpoint === 'prepared-root' && timing === 'before') {
    await waitForSigkill('prepared-root', 'before');
  }
  const prepRoot = await composition.controlAdmission.prepareRootLink({
    ledgerRunId: connectedRunId,
    connectedRunId,
    rootWorkflowId: CRASH_MATRIX_WORKFLOW.workflowId,
    queueId: 'default',
    fence,
    rootFrameKey: rootInvId,
    rootInvocationId: rootInvId
  });
  if (!prepRoot.ok) throw new Error(`prepareRootLink failed: ${prepRoot.message}`);
  if (targetCheckpoint === 'prepared-root' && timing === 'after') {
    await waitForSigkill('prepared-root', 'after');
  }

  // Checkpoint 2: linked-root
  if (targetCheckpoint === 'linked-root' && timing === 'before') {
    await waitForSigkill('linked-root', 'before');
  }
  const actRoot = await composition.controlAdmission.activateRootLink({
    ledgerRunId: connectedRunId,
    connectedRunId,
    fence
  });
  if (!actRoot.ok) throw new Error(`activateRootLink failed: ${actRoot.message}`);
  const linkedRun: ConnectedWorkflowRun = Object.freeze({
    ...snap.run,
    controlState: prepRoot.controlState
  });
  if (targetCheckpoint === 'linked-root' && timing === 'after') {
    await waitForSigkill('linked-root', 'after');
  }

  // Checkpoint 3: admitted-attempt (including quota permit allocation)
  const attemptId = `${rootInvId}:step1:attempt-1`;
  const prepAtt = await composition.controlAdmission.prepareAttempt({
    ledgerRunId: connectedRunId,
    connectedRunId,
    workflowId: CRASH_MATRIX_WORKFLOW.workflowId,
    frameKey: rootInvId,
    invocationId: rootInvId,
    nodeId: 'step1',
    attemptId,
    attemptIndex: 1,
    backend: 'claude',
    quotaKeys: ['claude/default'],
    queueId: 'default',
    fence,
    hasSideEffects: true
  });
  if (!prepAtt.ok) throw new Error(`prepareAttempt failed: ${prepAtt.message}`);
  if (targetCheckpoint === 'admitted-attempt' && timing === 'before') {
    await waitForSigkill('admitted-attempt', 'before');
  }
  const commitAtt = await composition.controlAdmission.commitAttempt(prepAtt.token);
  if (!commitAtt.ok) throw new Error(`commitAttempt failed: ${commitAtt.message}`);
  if (targetCheckpoint === 'admitted-attempt' && timing === 'after') {
    await waitForSigkill('admitted-attempt', 'after', { attemptId });
  }

  // Checkpoint 4: pending-dispatch (atomic connectedRun + queue + ledger commit)
  if (targetCheckpoint === 'pending-dispatch' && timing === 'before') {
    await waitForSigkill('pending-dispatch', 'before', { attemptId });
  }
  const queueItemId = `task-${connectedRunId}-1`;
  const rootFrame = linkedRun.invocations![rootInvId]!;
  const pendingAttempt: NodeAttemptRecord = createNodeAttemptRecord({
    frame: rootFrame,
    nodeId: 'step1',
    nodeKind: 'phase',
    targetDefinitionId: 'phase-work',
    inputEnvelope: {
      envelopeId: `${attemptId}:env`,
      invocationId: rootInvId,
      targetNodeId: 'step1',
      source: 'binding',
      inputsByPort: {},
      localInputs: [],
      outputTargetOverrides: [],
      acceptedAt: now
    },
    startedAt: now,
    attemptId,
    attemptIndex: 1,
    status: 'in-flight',
    queueItemId
  });
  const boundRun: ConnectedWorkflowRun = Object.freeze({
    ...upsertInvocationFrame(linkedRun, recordNodeAttempt(rootFrame, pendingAttempt)),
    revision: 1
  });
  const atomicRes = await guardedRun.admitComposableWorkflowLaunchAtomically({
    req: {
      description: 'Crash matrix step 1',
      scheduledAt: now,
      via: 'webview',
      queueId: 'default',
      workflowOccurrence: {
        rootRunId: connectedRunId,
        invocationId: rootInvId,
        parentInvocationId: null,
        nodePath: '/step1',
        attemptId,
        attemptIndex: 1
      }
    },
    queueItemId,
    connectedRun: boundRun,
    mutateControlLedger: async (raw) =>
      stampQueueItemOnRawLedger(raw, connectedRunId, attemptId, queueItemId)
  });
  if (atomicRes.outcome !== 'enqueued') {
    throw new Error(`atomic admit failed: ${atomicRes.outcome} (${atomicRes.reason ?? ''})`);
  }
  if (targetCheckpoint === 'pending-dispatch' && timing === 'after') {
    await waitForSigkill('pending-dispatch', 'after', { attemptId, queueItemId });
  }

  // Checkpoints 5 & 6: drive real `withAttemptSpawnCheckpoints` + `ProcessLifecycleRunner`
  // spawning a deterministic fake CLI script so spawn-intent and acknowledged-process are
  // exercised on the exact production runner seam.
  const fakeCli = writeDeterministicFakeCliScript({
    receiptDir,
    attemptId,
    writeTerminalOutput: targetCheckpoint === 'settled-attempt' || targetCheckpoint === 'terminal-projection'
  });
  const spawnedState: { pid?: number | undefined } = {};
  const originalRecordSpawnIntent = composition.controlAdmission.recordSpawnIntent.bind(
    composition.controlAdmission
  );
  const originalRecordAttemptStarted = composition.controlAdmission.recordAttemptStarted.bind(
    composition.controlAdmission
  );
  composition.controlAdmission.recordSpawnIntent = async (intentInput) => {
    if (targetCheckpoint === 'spawn-intent' && timing === 'before') {
      await waitForSigkill('spawn-intent', 'before', { attemptId, queueItemId });
    }
    const res = await originalRecordSpawnIntent(intentInput);
    if (!res.ok) throw new Error(`recordSpawnIntent failed: ${res.message}`);
    if (targetCheckpoint === 'spawn-intent' && timing === 'after') {
      // Spawn intent durably persisted BEFORE child process spawn!
      await waitForSigkill('spawn-intent', 'after', { attemptId, queueItemId });
    }
    return res;
  };
  composition.controlAdmission.recordAttemptStarted = async (startInput) => {
    spawnedState.pid = startInput.pid;
    // Wait briefly so the real fake-CLI child finishes writing its provider receipt on disk
    // before simulating SIGKILL around host acknowledgement.
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(fakeCli.receiptPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (targetCheckpoint === 'acknowledged-process' && timing === 'before') {
      await waitForSigkill('acknowledged-process', 'before', {
        attemptId,
        queueItemId,
        providerPid: startInput.pid,
        receiptPath: fakeCli.receiptPath
      });
    }
    const res = await originalRecordAttemptStarted(startInput);
    if (!res.ok) throw new Error(`recordAttemptStarted failed: ${res.message}`);
    if (targetCheckpoint === 'acknowledged-process' && timing === 'after') {
      await waitForSigkill('acknowledged-process', 'after', {
        attemptId,
        queueItemId,
        providerPid: startInput.pid,
        receiptPath: fakeCli.receiptPath
      });
    }
    return res;
  };

  const runner = new ProcessLifecycleRunner(undefined, null, logger, 'codex-cli');
  const inFlightRunId = `leaf-${connectedRunId}`;
  await withAttemptSpawnCheckpoints(
    {
      store,
      queue,
      run: { id: inFlightRunId, featureId: queueItemId },
      activePhaseDef: { sideEffects: 'workspace' }
    },
    async () => {
      const req = {
        phase: 'phase-work' as const,
        iteration: 1,
        runId: inFlightRunId,
        prompt: 'deterministic crash matrix prompt',
        timeoutMs: 15_000,
        cliPath: process.execPath,
        cwd: workspaceRoot,
        env: {},
        ...policyRequestFields({ runId: inFlightRunId })
      };
      const env = buildSpawnEnv(req);
      await runner.invoke({
        request: req,
        args: [fakeCli.scriptPath],
        env,
        commandDisplay: `${process.execPath} ${fakeCli.scriptPath}`
      });
    }
  );
  const providerPid = spawnedState.pid;

  // Persist durable terminal WorkflowRun + queue completion before settled-attempt
  const completedAt = now + 1_000;
  const leafRun: WorkflowRun = {
    id: inFlightRunId,
    featureId: queueItemId,
    featureDir: `specs/${queueItemId}`,
    status: 'completed',
    currentPhase: 'phase-work',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: completedAt,
    phasesCompleted: [],
    lastError: null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    delayedRetryCount: 0,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseOverrides: [],
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  await store.setRun('default', leafRun, store.runCommitClaim('default'));
  await queue.finish(queueItemId, 'completed');

  // Checkpoint 7: settled-attempt
  if (targetCheckpoint === 'settled-attempt' && timing === 'before') {
    await waitForSigkill('settled-attempt', 'before', { attemptId, queueItemId, providerPid });
  }
  const settledRes = await composition.controlAdmission.settleAttempt({
    ledgerRunId: connectedRunId,
    attemptId,
    fence,
    terminalStatus: 'completed'
  });
  if (!settledRes.ok) throw new Error(`settleAttempt failed: ${settledRes.message}`);
  if (targetCheckpoint === 'settled-attempt' && timing === 'after') {
    await waitForSigkill('settled-attempt', 'after', { attemptId, queueItemId, providerPid });
  }

  // Checkpoint 8: terminal-projection
  const currentRun = store.getConnectedRun(connectedRunId)!;
  const coordDeps = composition.createCoordinatorDeps({
    connectedRuns: store,
    dispatchPhase: async () => ({ outcome: 'rejected', reason: 'not-expected' }),
    workspaceRoot
  });
  // Before terminal-projection: commit terminal ConnectedWorkflowRun BEFORE markRootTerminal
  if (targetCheckpoint === 'terminal-projection' && timing === 'before') {
    // Omit markRootTerminal on this one-shot commit so ledger root stays active until recovery
    let noTerminalMarkDeps = coordDeps;
    if (coordDeps.controlAdmission !== undefined) {
      const { markRootTerminal: _omitted, ...admissionWithoutTerminal } = coordDeps.controlAdmission;
      noTerminalMarkDeps = { ...coordDeps, controlAdmission: admissionWithoutTerminal };
    }
    await completeComposableNodeAttempt(noTerminalMarkDeps, {
      run: currentRun,
      invocationId: rootInvId,
      nodeId: 'step1',
      attemptIndex: 1,
      status: 'completed',
      completedAt
    });
    await waitForSigkill('terminal-projection', 'before', { attemptId, queueItemId, providerPid });
  }

  await completeComposableNodeAttempt(coordDeps, {
    run: currentRun,
    invocationId: rootInvId,
    nodeId: 'step1',
    attemptIndex: 1,
    status: 'completed',
    completedAt
  });
  if (targetCheckpoint === 'terminal-projection' && timing === 'after') {
    await waitForSigkill('terminal-projection', 'after', { attemptId, queueItemId, providerPid });
  }
}

void runWorker().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
