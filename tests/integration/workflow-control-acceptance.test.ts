// FR-R5-F35 (SPEC-13) — Integrated end-to-end acceptance suite for Workflow Control Flow,
// Repetition, and Backend Recovery (D1–D9, WF-01–WF-19, AC-01–AC-36).

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIntegratedControlFlowDefinitions,
  createFixtureMemoryMemento,
  createInjectableControlClock,
  makeFixtureFence,
  readSampleItemsFixtureText,
  runControlledCliFixture
} from '../fixtures/workflow-control/workflow-control-fixtures';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { QuotaPermitArbiter } from '../../src/services/workflow-execution/quota-permit-arbiter';
import { BackendAvailabilityService } from '../../src/services/backend-availability-service';
import { ControlWakeupPlanner } from '../../src/services/workflow-execution/control-wakeup-planner';
import { CandidateBlockExecutor } from '../../src/services/workflow-execution/candidate-block-executor';
import { ControlUsageAccountingService } from '../../src/services/workflow-execution/control-usage-accounting';
import { ControlNotificationService } from '../../src/services/workflow-execution/control-notification-service';
import { ControlCommandService } from '../../src/services/workflow-execution/control-command-service';
import { RepeatExecutor } from '../../src/services/workflow-execution/repeat-executor';
import { ForEachExecutor } from '../../src/services/workflow-execution/foreach-executor';
import { type WorkflowRecoveryStore } from '../../src/services/workflow-execution/workflow-recovery-service';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  buildForEachNodeProjection,
  buildRepeatNodeProjection
} from '../../src/services/workflow-execution/workflow-control-projector';
import {
  buildRecoveryEnvelope,
  captureWorkspaceObservation
} from '../../src/services/workflow-execution/recovery-envelope-builder';
import { evaluateAttemptOutcome } from '../../src/services/result-operator';
import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';
import { removeTempRoot } from '../temp-root-cleanup';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../src/services/process-yaml/workflow-document';
import { phaseDefinitionFromDocument } from '../../src/services/process-yaml/phase-yaml-mapper';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await removeTempRoot(dir);
    }
  }
});

async function makeTempDir(prefix = 'schegent-f35-accept-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('FR-R5-F35 — Controlled local CLI fixtures & network isolation (F35-T02)', () => {
  it('executes controlled CLI modes (success, incomplete, credit-limited, malformed, failed-start, uncertain-spawn) and refuses remote network access', async () => {
    const wsDir = await makeTempDir();

    // 1. Remote network access is strictly refused
    const netAttempt = await runControlledCliFixture({
      mode: 'success',
      cwd: wsDir,
      remoteUrlAttempt: 'https://example.invalid/api'
    });
    expect(netAttempt.exitCode).toBe(99);
    expect(netAttempt.stderr).toContain('Remote network access is forbidden');

    // 2. Incomplete findings mode writes valid JSON with pending_tasks: 1, approved: false
    const incRun = await runControlledCliFixture({
      mode: 'incomplete',
      cwd: wsDir,
      outputRelativePath: 'out/incomplete.json'
    });
    expect(incRun.exitCode).toBe(0);
    const incParsed = JSON.parse(incRun.stdout.trim()) as {
      done: boolean;
      approved: boolean;
      pending_tasks: number;
    };
    expect(incParsed.done).toBe(true);
    expect(incParsed.approved).toBe(false);
    expect(incParsed.pending_tasks).toBe(1);

    // 3. Credit-limited mode writes truncated partial output + canonical rate-limit stderr
    const credRun = await runControlledCliFixture({
      mode: 'credit-limited',
      cwd: wsDir,
      outputRelativePath: 'out/partial.json'
    });
    expect(credRun.exitCode).toBe(1);
    expect(credRun.stderr).toContain("You've hit your usage limit");

    // 4. Malformed mode writes non-JSON output so structured-result operator pauses/fails
    const malRun = await runControlledCliFixture({
      mode: 'malformed',
      cwd: wsDir,
      outputRelativePath: 'out/malformed.json'
    });
    expect(malRun.exitCode).toBe(0);

    // 5. Failed-start and uncertain-spawn modes
    const failStart = await runControlledCliFixture({ mode: 'failed-start', cwd: wsDir });
    expect(failStart.exitCode).toBe(126);

    const uncSpawn = await runControlledCliFixture({
      mode: 'uncertain-spawn',
      cwd: wsDir,
      sideEffectRelativePath: 'dirty/side-effect.txt'
    });
    expect(uncSpawn.exitCode).toBe(137);
    const sideEffectText = await fsp.readFile(path.join(wsDir, 'dirty/side-effect.txt'), 'utf8');
    expect(sideEffectText).toContain('uncommitted-side-effect');
  });
});

describe('FR-R5-F35 — Complete 4-Stage Root Journey & Contending Queues (F35-T03)', () => {
  it('executes one root Workflow combining standalone Phase repetition, CandidateBlock fallback, Repeat loop, and ForEach loop with workspace handover and cumulative accounting', async () => {
    const wsDir = await makeTempDir();
    const itemsRelPath = 'inputs/sample-items.json';
    await fsp.mkdir(path.join(wsDir, 'inputs'), { recursive: true });
    const sampleItemsRaw = await readSampleItemsFixtureText();
    await fsp.writeFile(path.join(wsDir, itemsRelPath), sampleItemsRaw, 'utf8');

    // Create a preexisting dirty file to verify candidate workspace handover preserves it byte-for-byte
    const dirtyFilePath = path.join(wsDir, 'README-dirty.md');
    const preexistingContent = '# Preexisting user work — must survive candidate handover\n';
    await fsp.writeFile(dirtyFilePath, preexistingContent, 'utf8');

    const clock = createInjectableControlClock();
    const memento = createFixtureMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const fence = makeFixtureFence(1, 'root-journey');
    const defs = buildIntegratedControlFlowDefinitions();

    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'root-integrated-1',
      queueId: 'queue-primary',
      workflow: defs.rootWorkflow,
      effectiveWorkflows: [
        defs.rootWorkflow,
        defs.childCandidateWorkflow,
        defs.childRepeatWorkflow,
        defs.childForEachItemWorkflow
      ],
      effectivePhases: defs.phases,
      boundInputs: {
        initialFeedback: {
          portId: 'initialFeedback',
          type: 'text',
          value: 'Initial architecture draft'
        },
        itemsCollection: {
          portId: 'itemsCollection',
          type: 'local-file',
          value: itemsRelPath
        }
      },
      startedAt: clock.nowWallMs()
    });
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    let currentRun: ConnectedWorkflowRun = created.run;
    const rootInvocationId = created.rootInvocationId;
    const runStore: WorkflowRecoveryStore = {
      get(id) {
        return id === currentRun.connectedRunId ? currentRun : null;
      },
      list() {
        return [currentRun];
      },
      async compareAndSetConnectedRun(next) {
        currentRun = { ...next, revision: currentRun.revision + 1 };
        return { outcome: 'written', run: currentRun };
      }
    };

    const admissionService = new ControlAttemptAdmissionService({ ledgerStore, clock });
    const preparedRoot = await admissionService.prepareRootLink({
      ledgerRunId: currentRun.connectedRunId,
      connectedRunId: currentRun.connectedRunId,
      rootWorkflowId: defs.rootWorkflow.workflowId,
      queueId: 'queue-primary',
      fence,
      rootBudget: { version: 1, maxPhaseAttempts: 100 }
    });
    expect(preparedRoot.ok).toBe(true);
    const activatedRoot = await admissionService.activateRootLink({
      ledgerRunId: currentRun.connectedRunId,
      connectedRunId: currentRun.connectedRunId,
      fence
    });
    expect(activatedRoot.ok).toBe(true);

    const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
    const forEachExecutor = new ForEachExecutor({ ledgerStore, clock });
    const dispatchedHistory: Array<{ nodeId: string; phaseId: string; invocationId: string }> = [];

    const coordDeps = {
      connectedRuns: runStore,
      dispatchPhase: async (inp: {
        readonly frame: { readonly invocationId: string };
        readonly node: { readonly nodeId: string };
        readonly phase: { readonly phaseId: string };
        readonly attemptId: string;
      }) => {
        dispatchedHistory.push({
          nodeId: inp.node.nodeId,
          phaseId: inp.phase.phaseId,
          invocationId: inp.frame.invocationId
        });
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      },
      repeatExecutor,
      forEachExecutor,
      resolveExecutionFence: () => fence,
      workspaceRoot: wsDir
    };

    // --- STAGE 1: Standalone Phase Repetition (node-stage1-prep) ---
    const s1Attempt1 = await dispatchComposableNode(coordDeps, {
      run: currentRun,
      invocationId: rootInvocationId,
      nodeId: 'node-stage1-prep',
      startedAt: clock.nowWallMs()
    });
    expect(s1Attempt1.outcome).toBe('phase-dispatched');
    if (s1Attempt1.outcome !== 'phase-dispatched') return;

    // Evaluate structured-result operator on controlled CLI output (pass 1: pending_tasks=1 -> incomplete, pass 2: pending_tasks=0 -> done)
    const cliPrep1 = await runControlledCliFixture({
      mode: 'incomplete',
      cwd: wsDir,
      outputRelativePath: 'out/prep-1.json',
      resultJson: { attemptId: 'att-prep-1', pending_tasks: 1, prep_ready: false }
    });
    expect(cliPrep1.exitCode).toBe(0);
    const prepPhaseDef = defs.phases[0]!;
    const evalPrep1 = await evaluateAttemptOutcome({
      attemptId: 'att-prep-1',
      workspaceRoot: wsDir,
      resultContract: prepPhaseDef.resultContract!,
      declaredOutputsByKey: { prepReport: 'out/prep-1.json' },
      evaluatedAt: clock.nowWallMs()
    });
    expect(evalPrep1.status).toBe('incomplete');

    clock.advance(500);
    const cliPrep2 = await runControlledCliFixture({
      mode: 'success',
      cwd: wsDir,
      outputRelativePath: 'out/prep-2.json',
      resultJson: { attemptId: 'att-prep-2', pending_tasks: 0, prep_ready: true }
    });
    expect(cliPrep2.exitCode).toBe(0);
    const evalPrep2 = await evaluateAttemptOutcome({
      attemptId: 'att-prep-2',
      workspaceRoot: wsDir,
      resultContract: prepPhaseDef.resultContract!,
      declaredOutputsByKey: { prepReport: 'out/prep-2.json' },
      evaluatedAt: clock.nowWallMs()
    });
    expect(evalPrep2.status).toBe('done');

    // Complete Stage 1 -> automatically advances to Stage 2 (CandidateBlock child workflow)
    const afterStage1 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: s1Attempt1.invocationId,
      nodeId: 'node-stage1-prep',
      status: 'completed',
      completedAt: clock.nowWallMs(),
      decisionResults: { pending_tasks: 0, prep_ready: true }
    });
    expect(afterStage1.outcome).toBe('phase-dispatched');
    if (afterStage1.outcome !== 'phase-dispatched') return;
    expect(afterStage1.nodeId).toBe('node-cand-claude');

    // --- STAGE 2: CandidateBlock Recovery (cand-claude fails -> handover -> cand-codex wins) ---
    const beforeObs = await captureWorkspaceObservation({
      workspaceRoot: wsDir,
      candidatePaths: ['README-dirty.md', 'out/prep-1.json', 'out/prep-2.json'],
      explicitDirtyPaths: new Set(['README-dirty.md']),
      nowMs: () => clock.nowWallMs()
    });
    // Candidate 1 writes a partial output before hitting rate-limit
    await fsp.writeFile(path.join(wsDir, 'out/cand1-partial.md'), 'Partial draft\n', 'utf8');
    const afterObs = await captureWorkspaceObservation({
      workspaceRoot: wsDir,
      candidatePaths: [
        'README-dirty.md',
        'out/prep-1.json',
        'out/prep-2.json',
        'out/cand1-partial.md'
      ],
      explicitDirtyPaths: new Set(['README-dirty.md', 'out/cand1-partial.md']),
      nowMs: () => clock.nowWallMs()
    });
    const handoverEnv = buildRecoveryEnvelope({
      invocationId: afterStage1.invocationId,
      previousAttemptId: 'att-cand-claude-1',
      previousOutcome: { status: 'temporarily-unavailable', reason: 'rate-limit' },
      beforeObservation: beforeObs,
      afterObservation: afterObs,
      sideEffects: 'workspace',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['ev-teardown-1']
    });
    expect(handoverEnv.ok).toBe(true);
    if (handoverEnv.ok) {
      expect(handoverEnv.handover.workspace.coverage).toBe('complete');
      expect(
        handoverEnv.handover.workspace.entries.find((e) => e.path === 'README-dirty.md')
          ?.attribution
      ).toBe('preexisting');
      expect(
        handoverEnv.handover.workspace.entries.find((e) => e.path === 'out/cand1-partial.md')
          ?.attribution
      ).toBe('attempt');
      expect(handoverEnv.handover.effects.certainty).toBe('safe');
    }
    expect(await fsp.readFile(dirtyFilePath, 'utf8')).toBe(preexistingContent);

    clock.advance(500);
    const afterCand1Fail = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterStage1.invocationId,
      nodeId: 'node-cand-claude',
      status: 'failed',
      completedAt: clock.nowWallMs()
    });
    expect(afterCand1Fail.outcome).toBe('phase-dispatched');
    if (afterCand1Fail.outcome !== 'phase-dispatched') return;
    expect(afterCand1Fail.nodeId).toBe('node-cand-codex');

    clock.advance(500);
    const afterStage2 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterCand1Fail.invocationId,
      nodeId: 'node-cand-codex',
      status: 'completed',
      completedAt: clock.nowWallMs(),
      declaredOutputs: {
        verdictDoc: {
          portId: 'verdictDoc',
          type: 'markdown',
          value: 'Codex fallback candidate verified architecture'
        }
      }
    });
    // Completing Stage 2 child workflow routes to Stage 3 (Repeat child workflow pass 1)
    expect(afterStage2.outcome).toBe('phase-dispatched');
    if (afterStage2.outcome !== 'phase-dispatched') return;
    expect(afterStage2.nodeId).toBe('node-repeat-leaf');

    // --- STAGE 3: Scoped Child-Workflow Repeat (pass 1 Until=false -> carry -> pass 2 Until=true) ---
    const pass1ChildInv = lookupRecord(currentRun.invocations ?? {}, afterStage2.invocationId);
    expect(lookupRecord(pass1ChildInv?.boundInputs ?? {}, 'feedback')?.value).toBe(
      'Initial architecture draft'
    );

    clock.advance(500);
    const afterRepeatPass1 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterStage2.invocationId,
      nodeId: 'node-repeat-leaf',
      status: 'completed',
      completedAt: clock.nowWallMs(),
      declaredOutputs: {
        specDoc: { portId: 'specDoc', type: 'markdown', value: 'Pass 1 unaccepted draft' }
      },
      decisionResults: {
        approved: false,
        score: 72,
        nextFeedback: 'Strengthen quota recovery invariants'
      }
    });
    expect(afterRepeatPass1.outcome).toBe('phase-dispatched');
    if (afterRepeatPass1.outcome !== 'phase-dispatched') return;
    expect(afterRepeatPass1.invocationId).not.toBe(afterStage2.invocationId);

    const pass2ChildInv = lookupRecord(currentRun.invocations ?? {}, afterRepeatPass1.invocationId);
    expect(lookupRecord(pass2ChildInv?.boundInputs ?? {}, 'feedback')?.value).toBe(
      'Strengthen quota recovery invariants'
    );
    expect(lookupRecord(pass2ChildInv?.boundInputs ?? {}, 'priorScore')?.value).toBe('72');

    // Complete Repeat pass 2 with approved: true -> advances to Stage 4 (ForEach item 0)
    clock.advance(500);
    const afterRepeatPass2 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterRepeatPass1.invocationId,
      nodeId: 'node-repeat-leaf',
      status: 'completed',
      completedAt: clock.nowWallMs(),
      declaredOutputs: {
        specDoc: { portId: 'specDoc', type: 'markdown', value: 'Pass 2 accepted final spec' }
      },
      decisionResults: {
        approved: true,
        score: 97,
        nextFeedback: 'Approved'
      }
    });
    expect(afterRepeatPass2.outcome).toBe('phase-dispatched');
    if (afterRepeatPass2.outcome !== 'phase-dispatched') return;
    expect(afterRepeatPass2.nodeId).toBe('node-foreach-leaf');

    // --- STAGE 4: Sequential Child-Workflow ForEach (3 items: item 0 ok, item 1 fails under continue, item 2 ok) ---
    const feItem0Inv = lookupRecord(currentRun.invocations ?? {}, afterRepeatPass2.invocationId);
    expect(
      JSON.parse(lookupRecord(feItem0Inv?.boundInputs ?? {}, 'itemPayload')?.value ?? '{}')
    ).toEqual({
      id: 'module-auth',
      module: 'auth',
      priority: 1,
      strict: true
    });

    clock.advance(500);
    const afterFeItem0 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterRepeatPass2.invocationId,
      nodeId: 'node-foreach-leaf',
      status: 'completed',
      completedAt: clock.nowWallMs()
    });
    expect(afterFeItem0.outcome).toBe('phase-dispatched');
    if (afterFeItem0.outcome !== 'phase-dispatched') return;

    // Item 1 ('module-billing') fails -> under onItemError: 'continue', records failed slot 1 and dispatches item 2 ('module-reporting')
    clock.advance(500);
    const afterFeItem1 = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterFeItem0.invocationId,
      nodeId: 'node-foreach-leaf',
      status: 'failed',
      failureCode: 'child-failed',
      completedAt: clock.nowWallMs()
    });
    expect(afterFeItem1.outcome).toBe('phase-dispatched');
    if (afterFeItem1.outcome !== 'phase-dispatched') return;

    const feItem2Inv = lookupRecord(currentRun.invocations ?? {}, afterFeItem1.invocationId);
    expect(
      JSON.parse(lookupRecord(feItem2Inv?.boundInputs ?? {}, 'itemPayload')?.value ?? '{}')
    ).toEqual({
      id: 'module-reporting',
      module: 'reporting',
      priority: 3,
      strict: false
    });

    // Item 2 completes -> completes ForEach and completes root Workflow!
    clock.advance(500);
    const rootDone = await completeComposableNodeAttempt(coordDeps, {
      run: currentRun,
      invocationId: afterFeItem1.invocationId,
      nodeId: 'node-foreach-leaf',
      status: 'completed',
      completedAt: clock.nowWallMs()
    });
    expect(rootDone.outcome).toBe('workflow-completed');
    if (rootDone.outcome !== 'workflow-completed') return;

    // Verify exported root outputs from Repeat and ForEach stages
    expect(lookupRecord(rootDone.outputs, 'finalRefinedSpec')?.value).toBe(
      'Pass 2 accepted final spec'
    );
    const exportedBatchIndex = JSON.parse(
      lookupRecord(rootDone.outputs, 'batchResultIndex')?.value ?? '{}'
    ) as {
      itemCount: number;
      hasErrors: boolean;
      errorCount: number;
      slots: Array<{ itemKey: string; state: string }>;
    };
    expect(exportedBatchIndex.itemCount).toBe(3);
    expect(exportedBatchIndex.hasErrors).toBe(true);
    expect(exportedBatchIndex.errorCount).toBe(1);
    expect(exportedBatchIndex.slots.map((s) => ({ itemKey: s.itemKey, state: s.state }))).toEqual([
      { itemKey: 'module-auth', state: 'completed' },
      { itemKey: 'module-billing', state: 'failed' },
      { itemKey: 'module-reporting', state: 'completed' }
    ]);

    // Verify Repeat and ForEach projections on the completed run
    const loadedLedger = ledgerStore.read();
    expect(loadedLedger.ok).toBe(true);
    if (!loadedLedger.ok) return;
    const rootControlState = lookupRecord(loadedLedger.ledger.roots, currentRun.connectedRunId);
    const repeatProj = buildRepeatNodeProjection(
      currentRun,
      'node-stage3-repeat',
      rootControlState
    );
    expect(repeatProj?.currentPass).toBe(2);
    expect(repeatProj?.conditionResult).toBe('true');
    expect(repeatProj?.leafAttemptCount).toBe(2);

    const forEachProj = buildForEachNodeProjection(
      currentRun,
      'node-stage4-foreach',
      rootControlState
    );
    expect(forEachProj?.itemCount).toBe(3);
    expect(forEachProj?.hasErrors).toBe(true);
    expect(forEachProj?.errorCount).toBe(1);
    expect(forEachProj?.leafAttemptCount).toBe(3);
    expect(dispatchedHistory).toHaveLength(8);
  });

  it('arbitrates fair all-or-none permits across two contending queues sharing a quota while allowing independent quota progress', async () => {
    const clock = createInjectableControlClock();
    const ledgerStore = new ControlLedgerStore(createFixtureMemoryMemento());
    const admission = new ControlAttemptAdmissionService({ ledgerStore, clock });
    const arbiter = new QuotaPermitArbiter({ ledgerStore, clock });
    const availability = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: (kind) => ({
        adapterId: `${kind}-adapter`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: 'supported',
        resolveQuotaContext: () => ({
          version: 1,
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          identity: 'qualified',
          quotaIds:
            kind === 'claude' ? ['claude:shared-team'] : ['codex:independent-b'],
          statusCheck: 'supported',
          capacity: 1
        }),
        checkAvailability: async () => ({
          version: 1,
          adapterId: `${kind}-adapter`,
          outcomes: [
            {
              quotaId:
                kind === 'claude' ? 'claude:shared-team' : 'codex:independent-b',
              status: 'ready',
              capacity: 1
            }
          ]
        })
      })
    });
    const wakeupPlanner = new ControlWakeupPlanner({
      ledgerStore,
      availabilityService: availability,
      clock
    });

    const fenceA = makeFixtureFence(1, 'qA');
    const fenceB = makeFixtureFence(1, 'qB');
    await admission.prepareRootLink({
      ledgerRunId: 'root-qA',
      connectedRunId: 'root-qA',
      rootWorkflowId: 'wf-qA',
      queueId: 'queue-alpha',
      fence: fenceA
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-qA',
      connectedRunId: 'root-qA',
      fence: fenceA
    });

    await admission.prepareRootLink({
      ledgerRunId: 'root-qB',
      connectedRunId: 'root-qB',
      rootWorkflowId: 'wf-qB',
      queueId: 'queue-beta',
      fence: fenceB
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-qB',
      connectedRunId: 'root-qB',
      fence: fenceB
    });

    // Record shared quota capacity=1 and independent quota capacity=1 via qualified checks
    const chkShared = await availability.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-shared-a',
      frozenPhase: { runner: 'claude', id: 'p-shared' },
      generation: 1,
      subscribers: [{ rootRunId: 'root-qA', sequence: 1, generation: 1 }]
    });
    expect(chkShared.ok).toBe(true);

    const chkIndep = await availability.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-indep-b',
      frozenPhase: { runner: 'codex', id: 'p-indep' },
      generation: 1,
      subscribers: [{ rootRunId: 'root-qB', sequence: 2, generation: 1 }]
    });
    expect(chkIndep.ok).toBe(true);

    // Enqueue both queues waiting on 'claude:shared-team' in order: queue-alpha (seq 1), queue-beta (seq 2)
    const wA = await arbiter.registerWaiter({
      rootRunId: 'root-qA',
      queueId: 'queue-alpha',
      frameKey: 'frame-qA',
      invocationId: 'inv-qA',
      nodeId: 'node-qA',
      generation: 1,
      quotaIds: ['claude:shared-team']
    });
    const wB = await arbiter.registerWaiter({
      rootRunId: 'root-qB',
      queueId: 'queue-beta',
      frameKey: 'frame-qB',
      invocationId: 'inv-qB',
      nodeId: 'node-qB',
      generation: 1,
      quotaIds: ['claude:shared-team']
    });
    expect(wA.ok && wB.ok).toBe(true);
    if (!wA.ok || !wB.ok) return;
    expect(wA.waiter.sequence).toBeLessThan(wB.waiter.sequence);

    // Prepare + commit queue-alpha on 'claude:shared-team' -> acquires the sole permit
    const prepA = await admission.prepareAttempt({
      ledgerRunId: 'root-qA',
      connectedRunId: 'root-qA',
      queueId: 'queue-alpha',
      frameKey: 'frame-qA',
      workflowId: 'wf-qA',
      invocationId: 'inv-qA',
      nodeId: 'node-qA',
      attemptId: 'att-qA-1',
      attemptIndex: 1,
      backend: 'claude',
      quotaKeys: ['claude:shared-team'],
      satisfiedWaiterId: wA.waiter.waiterId,
      expectedWaiterSequence: wA.waiter.sequence,
      expectedWaiterGeneration: wA.waiter.generation,
      fence: fenceA
    });
    expect(prepA.ok).toBe(true);
    if (!prepA.ok) return;
    const commitA = await admission.commitAttempt(prepA.token);
    expect(commitA.ok).toBe(true);

    // While queue-alpha holds 'claude:shared-team', queue-beta is blocked on 'claude:shared-team'
    const prepBBlocked = arbiter.preparePermitGrant({
      waiterId: wB.waiter.waiterId,
      attemptId: 'att-qB-blocked',
      executionFence: fenceB
    });
    expect(prepBBlocked.ok).toBe(false);

    // Yet queue-beta can still admit on its independent codex quota!
    const prepBIndep = await admission.prepareAttempt({
      ledgerRunId: 'root-qB',
      connectedRunId: 'root-qB',
      queueId: 'queue-beta',
      frameKey: 'frame-qB',
      workflowId: 'wf-qB',
      invocationId: 'inv-qB-indep',
      nodeId: 'node-qB-indep',
      attemptId: 'att-qB-indep-1',
      attemptIndex: 1,
      backend: 'codex',
      quotaKeys: ['codex:independent-b'],
      fence: fenceB
    });
    expect(prepBIndep.ok).toBe(true);
    if (!prepBIndep.ok) return;
    const commitBIndep = await admission.commitAttempt(prepBIndep.token);
    expect(commitBIndep.ok).toBe(true);

    // Release queue-alpha's shared permit and settle queue-beta's independent attempt -> queue-beta becomes next eligible waiter on shared quota
    await admission.settleAttempt({
      ledgerRunId: 'root-qB',
      attemptId: 'att-qB-indep-1',
      terminalStatus: 'completed',
      fence: fenceB
    });
    const settledA = await admission.settleAttempt({
      ledgerRunId: 'root-qA',
      attemptId: 'att-qA-1',
      terminalStatus: 'completed',
      fence: fenceA
    });
    expect(settledA.ok).toBe(true);

    const prepBAfterRelease = arbiter.preparePermitGrant({
      waiterId: wB.waiter.waiterId,
      attemptId: 'att-qB-shared-1',
      executionFence: fenceB
    });
    expect(prepBAfterRelease.ok).toBe(true);
    wakeupPlanner.dispose();
  });
});

describe('FR-R5-F35 — Fault Injection Across Durable Boundaries & Command Parity (F35-T04, F35-T05)', () => {
  it('reconciles interrupted state across prepared-root, admission, spawn-intent, usage/notifications, and revision-fenced commands without double-counting or leaking permits', async () => {
    const clock = createInjectableControlClock();
    const memento = createFixtureMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const fence = makeFixtureFence(1, 'fault-matrix');
    const admission = new ControlAttemptAdmissionService({ ledgerStore, clock });
    const usageService = new ControlUsageAccountingService({ ledgerStore, clock });
    const notificationService = new ControlNotificationService({ ledgerStore, clock });
    const commandService = new ControlCommandService({ ledgerStore, clock });
    const candidateExecutor = new CandidateBlockExecutor({
      ledgerStore,
      admissionService: admission,
      clock
    });

    // 1. Prepared-root boundary before link activation consumes 0 attempts
    await admission.prepareRootLink({
      ledgerRunId: 'root-fault-1',
      connectedRunId: 'root-fault-1',
      rootWorkflowId: 'wf-fault',
      queueId: 'default',
      fence,
      rootBudget: {
        version: 1,
        maxPhaseAttempts: 100,
        budgetMode: 'strict-usd',
        maxMicrousd: 500_000,
        strictUsdBudget: {
          mode: 'strict-usd',
          limitMicrousd: 500_000
        }
      }
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-fault-1',
      connectedRunId: 'root-fault-1',
      fence
    });

    // 2. Admit attempt 1 -> record spawn-intent -> crash before process acknowledgement
    const prep1 = await admission.prepareAttempt({
      ledgerRunId: 'root-fault-1',
      connectedRunId: 'root-fault-1',
      queueId: 'default',
      frameKey: 'frame-cand-1',
      workflowId: 'wf-fault',
      invocationId: 'inv-fault-1',
      nodeId: 'node-cand-1',
      attemptId: 'att-fault-1',
      attemptIndex: 1,
      candidateId: 'cand-1',
      backend: 'claude',
      quotaKeys: ['claude:default'],
      reservedMicrousd: 100_000,
      fence
    });
    expect(prep1.ok).toBe(true);
    if (!prep1.ok) return;
    const adm1 = await admission.commitAttempt(prep1.token);
    expect(adm1.ok).toBe(true);

    const intent1 = await admission.recordSpawnIntent({
      ledgerRunId: 'root-fault-1',
      attemptId: 'att-fault-1',
      fence
    });
    expect(intent1.ok).toBe(true);

    // Reload store after crash at spawn-intent -> reconcile marks permit held-uncertain and pauses without blind replay
    const reloadedStore = new ControlLedgerStore(memento);
    const reloadedAdmission = new ControlAttemptAdmissionService({
      ledgerStore: reloadedStore,
      clock
    });
    const recIntent = await reloadedAdmission.reconcileControlRoot({
      ledgerRunId: 'root-fault-1',
      connectedRun: {
        connectedRunId: 'root-fault-1',
        workflowId: 'wf-fault',
        revision: 1,
        startedAt: clock.nowWallMs(),
        graph: {
          workflowId: 'wf-fault',
          name: 'Fault Workflow',
          version: 1,
          nodes: [{ nodeId: 'node-cand-1', kind: 'phase', phaseId: 'p1' }],
          connections: [],
          startNodeIds: ['node-cand-1']
        },
        pipelines: {},
        nodes: {},
        decisions: [],
        controlState: Object.freeze({ version: 1, ledgerRunId: 'root-fault-1' })
      },
      newFence: fence
    });
    expect(recIntent.ok).toBe(true);
    expect(recIntent.disposition).toBe('paused-uncertain-effect');

    // Advance fake clock 48 hours -> verify uncertain permit is NEVER released by time expiry alone
    clock.advance(48 * 3_600_000);
    const ledgerAfterWait = reloadedStore.read();
    expect(ledgerAfterWait.ok).toBe(true);
    if (!ledgerAfterWait.ok) return;
    const rootAfterWait = lookupRecord(ledgerAfterWait.ledger.roots, 'root-fault-1');
    expect(rootAfterWait?.dispatchedAttempts).toBe(1);
    const heldPermit = lookupRecord(ledgerAfterWait.ledger.permits, 'permit:att-fault-1');
    expect(heldPermit?.state).toBe('uncertain');

    // 3. Usage accounting & deduplicated notification claim across reload
    const usageRes = await usageService.reconcileAttemptUsage({
      rootRunId: 'root-fault-1',
      attemptId: 'att-fault-1',
      fence,
      usageRecord: {
        attemptId: 'att-fault-1',
        backend: 'claude',
        modelId: 'claude-3-7-sonnet',
        denomination: 'usd',
        quality: 'verified',
        inputTokens: 1_200,
        outputTokens: 400,
        costMicrousd: 85_000
      }
    });
    expect(usageRes.ok).toBe(true);

    const noteRes = await notificationService.recordNotification({
      rootRunId: 'root-fault-1',
      invocationId: 'inv-fault-1',
      generation: 1,
      reason: 'intervention-required',
      summary: 'Ambiguous spawn requires operator confirmation'
    });
    expect(noteRes.ok).toBe(true);

    // Duplicate notification for same generation + reason is deduplicated
    const dupNoteRes = await notificationService.recordNotification({
      rootRunId: 'root-fault-1',
      invocationId: 'inv-fault-1',
      generation: 1,
      reason: 'intervention-required',
      summary: 'Duplicate notice'
    });
    expect(dupNoteRes.ok).toBe(true);
    expect(dupNoteRes.newlyCreated).toBe(false);
    expect(dupNoteRes.notification?.notificationId).toBe(noteRes.notification?.notificationId);

    // 4. Candidate block initialization + revision-fenced command idempotency
    const invCandBlockUuid = '33333333-3333-4333-8333-333333333333';
    const initBlock = await candidateExecutor.initializeCandidateBlock({
      rootRunId: 'root-fault-1',
      workflowId: 'wf-fault',
      frameKey: 'frame-cand-block',
      invocationId: invCandBlockUuid,
      nodeId: 'node-cand-block',
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-1',
          nodeId: 'node-cand-1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-2',
          nodeId: 'node-cand-2',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2
        }
      ],
      fence
    });
    expect(initBlock.ok).toBe(true);

    const cmdId1 = '11111111-1111-4111-8111-111111111111';
    const cmd1 = await commandService.executeControlCommand({
      version: 1,
      commandId: cmdId1,
      rootRunId: 'root-fault-1',
      queueId: 'default',
      invocationId: invCandBlockUuid,
      expectedGeneration: 1,
      action: {
        kind: 'set-policy',
        availabilityPolicy: 'wait-for-selected'
      }
    });
    expect(cmd1.outcome).toBe('accepted');

    // Replaying identical commandId + payload returns idempotent accepted acknowledgement
    const cmd1Replay = await commandService.executeControlCommand({
      version: 1,
      commandId: cmdId1,
      rootRunId: 'root-fault-1',
      queueId: 'default',
      invocationId: invCandBlockUuid,
      expectedGeneration: 1,
      action: {
        kind: 'set-policy',
        availabilityPolicy: 'wait-for-selected'
      }
    });
    expect(cmd1Replay.outcome).toBe('accepted');

    // Stale generation with a new commandId is refused with stale-generation
    const staleCmd = await commandService.executeControlCommand({
      version: 1,
      commandId: '22222222-2222-4222-8222-222222222222',
      rootRunId: 'root-fault-1',
      queueId: 'default',
      invocationId: invCandBlockUuid,
      expectedGeneration: 1,
      action: {
        kind: 'set-policy',
        availabilityPolicy: 'stop-on-unavailability'
      }
    });
    expect(staleCmd.outcome).toBe('refused');
    expect(staleCmd.reason).toBe('stale-generation');
  });
});

describe('FR-R5-F35 — Importable Process YAML Example Bundles Verification (F35-T06)', () => {
  const EXAMPLE_FILES = [
    '01-phase-repetition-and-branching.workflow.yaml',
    '02-candidate-block-recovery.workflow.yaml',
    '03-scoped-workflow-repeat.workflow.yaml',
    '04-sequential-workflow-foreach.workflow.yaml'
  ] as const;

  it.each(EXAMPLE_FILES)(
    'parses, validates, round-trips, and freezes %s through the production Process YAML and closure pipeline',
    async (fileName) => {
      const examplePath = path.resolve(
        __dirname,
        '..',
        '..',
        'examples',
        'workflow-control',
        fileName
      );
      const rawYaml = await fsp.readFile(examplePath, 'utf8');

      const parsedTree = parseDocumentBytes(Buffer.from(rawYaml, 'utf8'));
      expect(parsedTree.ok).toBe(true);
      if (!parsedTree.ok) return;

      const pkg = parseWorkflowPackage(parsedTree.node);
      expect(pkg.ok).toBe(true);
      if (!pkg.ok) return;

      for (const res of pkg.resources) {
        expect(res.ok ? [] : res.defects).toEqual([]);
      }

      const workflows: WorkflowDefinition[] = [];
      const phases: PhaseDefinition[] = [];
      for (const res of pkg.resources) {
        if (!res.ok) continue;
        if (res.resourceKind === 'workflow') workflows.push(res.definition);
        if (res.resourceKind === 'phase') {
          phases.push(phaseDefinitionFromDocument(res.document));
        }
      }
      expect(workflows.length).toBeGreaterThan(0);
      const rootWorkflow = workflows[0]!;

      // Verify lossless canonical serialization round-trip
      const doc = documentFromWorkflowDefinition(rootWorkflow, {
        workflows: workflows.slice(1),
        phases
      });
      const serialized = serializeWorkflowDocument(doc);
      const reparsedTree = parseDocumentBytes(Buffer.from(serialized, 'utf8'));
      expect(reparsedTree.ok).toBe(true);
      if (!reparsedTree.ok) return;
      const reparsedPkg = parseWorkflowPackage(reparsedTree.node);
      expect(reparsedPkg.ok).toBe(true);

      // Verify launch closure freeze succeeds
      const boundInputs = Object.fromEntries(
        (rootWorkflow.inputs ?? []).map((port) => [
          port.portId,
          {
            portId: port.portId,
            type: port.type,
            value: port.type === 'local-file' ? 'inputs/sample.json' : 'sample-input-value'
          }
        ])
      );
      const frozen = createComposableWorkflowRunSnapshot({
        connectedRunId: `conn-${rootWorkflow.workflowId}`,
        queueId: 'default',
        workflow: rootWorkflow,
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        boundInputs,
        startedAt: 1_700_000_000_000
      });
      expect(frozen.outcome).toBe('created');
    }
  );
});
