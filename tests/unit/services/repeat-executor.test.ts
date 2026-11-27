import { describe, expect, it } from 'vitest';
import type { Memento } from '../../../src/state/workspace-state';
import type { ExecutionFence } from '../../../src/contracts/control-ledger';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { ResolvedRepeatControl } from '../../../src/contracts/workflow-controls';
import {
  RepeatExecutor,
  buildRepeatCarryEnvelope,
  encodeRepeatCarryValue,
  evaluateRepeatUntilCondition,
  resolveChildPassDecisionResults
} from '../../../src/services/workflow-execution/repeat-executor';
import { ControlLedgerStore, lookupRecord } from '../../../src/services/workflow-execution/control-ledger-store';
import { ControlCommandService } from '../../../src/services/workflow-execution/control-command-service';

function makeMemoryMemento(): Memento {
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

function makeFence(rootGeneration = 1): ExecutionFence {
  return {
    primacyClaim: 'primacy-1',
    queueClaim: 'queue-1',
    rootGeneration
  };
}

const CHILD_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-child-review',
  name: 'Child Review Workflow',
  version: 1,
  inputs: [
    { portId: 'feedback', label: 'Feedback', type: 'text', required: true },
    { portId: 'attempt-note', label: 'Attempt Note', type: 'text', required: false },
    { portId: 'source-code', label: 'Source Code', type: 'source', required: false }
  ],
  outputs: [
    {
      portId: 'review-summary',
      label: 'Review Summary',
      type: 'markdown',
      required: true
    }
  ],
  nodes: [{ nodeId: 'phase-node-1', kind: 'phase', phaseId: 'phase-review' }],
  connections: [],
  startNodeIds: ['phase-node-1'],
  decisionResults: {
    version: 1,
    fields: [
      { fieldId: 'approved', type: 'boolean', required: true },
      { fieldId: 'score', type: 'number', required: true },
      { fieldId: 'nextFeedback', type: 'string', required: false }
    ],
    bindings: [
      { fieldId: 'approved', source: { kind: 'node-result', nodeId: 'phase-node-1', fieldId: 'approved' } },
      { fieldId: 'score', source: { kind: 'node-result', nodeId: 'phase-node-1', fieldId: 'score' } },
      { fieldId: 'nextFeedback', source: { kind: 'node-result', nodeId: 'phase-node-1', fieldId: 'nextFeedback' } }
    ]
  }
};

function makeRepeatControl(overrides: Partial<ResolvedRepeatControl> = {}): ResolvedRepeatControl {
  return Object.freeze({
    version: 1,
    kind: 'repeat',
    maxIterations: 3,
    until: Object.freeze({
      version: 1,
      kind: 'typed',
      test: Object.freeze({
        left: Object.freeze({ source: 'result-field', fieldId: 'approved' }),
        operator: 'equals',
        right: true
      })
    }),
    carry: Object.freeze([
      Object.freeze({ fieldId: 'nextFeedback', inputPortId: 'feedback' }),
      Object.freeze({ fieldId: 'score', inputPortId: 'attempt-note' })
    ]),
    onExhausted: 'pause',
    ...overrides
  });
}

function makeHarness(dispatchedAttempts = 0) {
  let wallMs = 1_700_000_000_000;
  let monoMs = 1_000;
  const clock = {
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => monoMs,
    hostEpoch: 'epoch-1',
    advance(ms: number) {
      wallMs += ms;
      monoMs += ms;
    }
  };
  const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
  const fence = makeFence(1);
  const rootRunId = 'root-run-1';
  const parentInvocationId = '00000000-0000-4000-8000-000000000001';

  const seedRoot = async () => {
    await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        result: undefined,
        nextLedger: {
          ...ledger,
          roots: {
            ...ledger.roots,
            [rootRunId]: {
              version: 1,
              ledgerRunId: rootRunId,
              connectedRunId: rootRunId,
              rootWorkflowId: 'wf-parent',
              queueId: 'default',
              linkState: 'active',
              status: 'in-flight',
              fence,
              rootBudget: { version: 1, maxPhaseAttempts: 100 },
              dispatchedAttempts,
              settledMicrousd: 0,
              reservedMicrousd: 0,
              framesByKey: {},
              attemptsById: {},
              notificationsById: {},
              decisionSummaries: [],
              createdAt: wallMs,
              updatedAt: wallMs
            }
          }
        }
      }
    }));
  };

  const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
  const commandService = new ControlCommandService({ ledgerStore, clock });

  return {
    clock,
    ledgerStore,
    repeatExecutor,
    commandService,
    fence,
    rootRunId,
    parentInvocationId,
    seedRoot
  };
}

describe('RepeatExecutor (FR-R5-F33 / SPEC-11)', () => {
  it('accepts at pass 1 and pass 25, returning only the accepted pass outputs', async () => {
    // 1. Acceptance at pass 1
    const h1 = makeHarness();
    await h1.seedRoot();
    const ctrl1 = makeRepeatControl({ maxIterations: 3 });
    await h1.repeatExecutor.initializeRepeatFrame({
      rootRunId: h1.rootRunId,
      parentInvocationId: h1.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrl1,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h1.fence
    });

    const pass1Result = await h1.repeatExecutor.settleRepeatPass({
      rootRunId: h1.rootRunId,
      parentInvocationId: h1.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrl1,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      validatedOutputs: {
        'review-summary': { portId: 'review-summary', type: 'markdown', value: '/out/pass-1.md' }
      },
      decisionResults: { approved: true, score: 95, nextFeedback: 'done' },
      fence: h1.fence
    });

    expect(pass1Result.ok).toBe(true);
    expect(pass1Result.action).toEqual({
      kind: 'accepted-return',
      iteration: 1,
      acceptedInvocationId: 'child-pass-1',
      exportedOutputs: {
        'review-summary': { portId: 'review-summary', type: 'markdown', value: '/out/pass-1.md' }
      },
      decisionResults: { approved: true, score: 95, nextFeedback: 'done' }
    });
    expect(pass1Result.frame?.status).toBe('completed');
    expect(pass1Result.frame?.repeatState?.conditionResult).toBe('true');

    // 2. Acceptance at pass 25 (maximum allowed maxIterations = 25)
    const h25 = makeHarness();
    await h25.seedRoot();
    const ctrl25 = makeRepeatControl({ maxIterations: 25 });
    await h25.repeatExecutor.initializeRepeatFrame({
      rootRunId: h25.rootRunId,
      parentInvocationId: h25.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrl25,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h25.fence
    });

    for (let i = 1; i <= 24; i += 1) {
      const step = await h25.repeatExecutor.settleRepeatPass({
        rootRunId: h25.rootRunId,
        parentInvocationId: h25.parentInvocationId,
        nodeId: 'node-repeat',
        childInvocationId: `child-pass-${i}`,
        passStatus: 'completed',
        control: ctrl25,
        childWorkflow: CHILD_WORKFLOW,
        initialBoundInputs: {
          feedback: { portId: 'feedback', type: 'text', value: 'initial' }
        },
        validatedOutputs: {
          'review-summary': { portId: 'review-summary', type: 'markdown', value: `/out/pass-${i}.md` }
        },
        decisionResults: { approved: false, score: i, nextFeedback: `refine-${i}` },
        allocateNextChildInvocationId: (next) => `child-pass-${next}`,
        fence: h25.fence
      });
      expect(step.action.kind).toBe('advance-next-pass');
    }

    const pass25 = await h25.repeatExecutor.settleRepeatPass({
      rootRunId: h25.rootRunId,
      parentInvocationId: h25.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-25',
      passStatus: 'completed',
      control: ctrl25,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      validatedOutputs: {
        'review-summary': { portId: 'review-summary', type: 'markdown', value: '/out/pass-25.md' }
      },
      decisionResults: { approved: true, score: 100, nextFeedback: 'accepted-25' },
      fence: h25.fence
    });

    expect(pass25.action).toEqual({
      kind: 'accepted-return',
      iteration: 25,
      acceptedInvocationId: 'child-pass-25',
      exportedOutputs: {
        'review-summary': { portId: 'review-summary', type: 'markdown', value: '/out/pass-25.md' }
      },
      decisionResults: { approved: true, score: 100, nextFeedback: 'accepted-25' }
    });
    expect(pass25.frame?.repeatState?.completedPasses).toHaveLength(25);
  });

  it('pauses with repeat-exhausted (and refuses resume) or fails on false final pass', async () => {
    // 1. onExhausted: 'pause'
    const hp = makeHarness();
    await hp.seedRoot();
    const ctrlPause = makeRepeatControl({ maxIterations: 2, onExhausted: 'pause' });
    await hp.repeatExecutor.initializeRepeatFrame({
      rootRunId: hp.rootRunId,
      parentInvocationId: hp.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrlPause,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: hp.fence
    });

    await hp.repeatExecutor.settleRepeatPass({
      rootRunId: hp.rootRunId,
      parentInvocationId: hp.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrlPause,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 40, nextFeedback: 'try-2' },
      allocateNextChildInvocationId: () => 'child-pass-2',
      fence: hp.fence
    });

    const exhaustedPause = await hp.repeatExecutor.settleRepeatPass({
      rootRunId: hp.rootRunId,
      parentInvocationId: hp.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-2',
      passStatus: 'completed',
      control: ctrlPause,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 55, nextFeedback: 'still-false' },
      fence: hp.fence
    });

    expect(exhaustedPause.action).toEqual({
      kind: 'pause-exhausted',
      iteration: 2,
      maxIterations: 2,
      reason: 'repeat-exhausted'
    });
    expect(exhaustedPause.frame?.status).toBe('paused');
    expect(exhaustedPause.frame?.pauseCause).toBe('repeat-exhausted');
    expect(exhaustedPause.frame?.winningOutputs).toBeUndefined();

    // Resume on a repeat-exhausted frame MUST be refused and never grant fresh iterations
    const resumeReply = await hp.commandService.executeControlCommand({
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000901',
      rootRunId: hp.rootRunId,
      queueId: 'default',
      invocationId: hp.parentInvocationId,
      expectedGeneration: exhaustedPause.frame?.frameGeneration ?? 3,
      action: { kind: 'resume' }
    });
    expect(resumeReply.outcome).toBe('refused');
    expect(resumeReply.reason).toBe('illegal-state');

    // 2. onExhausted: 'fail'
    const hf = makeHarness();
    await hf.seedRoot();
    const ctrlFail = makeRepeatControl({ maxIterations: 1, onExhausted: 'fail' });
    await hf.repeatExecutor.initializeRepeatFrame({
      rootRunId: hf.rootRunId,
      parentInvocationId: hf.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrlFail,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: hf.fence
    });

    const exhaustedFail = await hf.repeatExecutor.settleRepeatPass({
      rootRunId: hf.rootRunId,
      parentInvocationId: hf.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrlFail,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 30 },
      fence: hf.fence
    });

    expect(exhaustedFail.action).toEqual({
      kind: 'fail-exhausted',
      iteration: 1,
      maxIterations: 1,
      failureCode: 'repeat-exhausted'
    });
    expect(exhaustedFail.frame?.status).toBe('failed');
    expect(exhaustedFail.frame?.failureCode).toBe('repeat-exhausted');
  });

  it('isolates failed pass after a prior valid pass so earlier pass results never leak', async () => {
    const h = makeHarness();
    await h.seedRoot();
    const ctrl = makeRepeatControl({ maxIterations: 3 });
    await h.repeatExecutor.initializeRepeatFrame({
      rootRunId: h.rootRunId,
      parentInvocationId: h.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrl,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h.fence
    });

    // Pass 1 completes with valid outputs and decisionResults, but until is false
    const pass1 = await h.repeatExecutor.settleRepeatPass({
      rootRunId: h.rootRunId,
      parentInvocationId: h.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrl,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      validatedOutputs: {
        'review-summary': { portId: 'review-summary', type: 'markdown', value: '/out/pass-1-valid.md' }
      },
      decisionResults: { approved: false, score: 75, nextFeedback: 'fix-edge-case' },
      allocateNextChildInvocationId: () => 'child-pass-2',
      fence: h.fence
    });
    expect(pass1.action.kind).toBe('advance-next-pass');

    // Pass 2 fails -> must fail Repeat frame and clear any winningOutputs/decisionResults
    const pass2Fail = await h.repeatExecutor.settleRepeatPass({
      rootRunId: h.rootRunId,
      parentInvocationId: h.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-2',
      passStatus: 'failed',
      failureCode: 'phase-execution-failed',
      control: ctrl,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h.fence
    });

    expect(pass2Fail.action).toEqual({
      kind: 'fail-pass',
      iteration: 2,
      failureCode: 'phase-execution-failed'
    });
    expect(pass2Fail.frame?.status).toBe('failed');
    expect(pass2Fail.frame?.winningOutputs).toBeUndefined();
    expect(pass2Fail.frame?.decisionResults).toBeUndefined();
    expect(pass2Fail.frame?.repeatState?.lastPassAccepted).toBe(false);
  });

  it('encodes optional and required carry mappings and rejects missing required or non-text targets', () => {
    expect(encodeRepeatCarryValue('hello {{literal}}')).toEqual({
      ok: true,
      encoded: 'hello {{literal}}',
      primitive: 'hello {{literal}}'
    });
    expect(encodeRepeatCarryValue(true)).toEqual({
      ok: true,
      encoded: 'true',
      primitive: true
    });
    expect(encodeRepeatCarryValue(false)).toEqual({
      ok: true,
      encoded: 'false',
      primitive: false
    });
    expect(encodeRepeatCarryValue(42.5)).toEqual({
      ok: true,
      encoded: '42.5',
      primitive: 42.5
    });

    // Optional field omitted -> preserves initial bound input
    const optionalOmitted = buildRepeatCarryEnvelope({
      invocationId: 'inv-1',
      nodeId: 'node-repeat',
      nextIteration: 2,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'keep-initial' }
      },
      carry: [
        { fieldId: 'nextFeedback', inputPortId: 'feedback' },
        { fieldId: 'score', inputPortId: 'attempt-note' }
      ],
      currentPassDecisionResults: { approved: false, score: 88 },
      childWorkflow: CHILD_WORKFLOW,
      acceptedAt: 2000
    });
    expect(optionalOmitted.ok).toBe(true);
    if (optionalOmitted.ok) {
      expect(lookupRecord(optionalOmitted.inputsByPort, 'feedback')?.value).toBe('keep-initial');
      expect(lookupRecord(optionalOmitted.inputsByPort, 'attempt-note')?.value).toBe('88');
    }

    // Missing required decision field -> rejected
    const missingRequired = buildRepeatCarryEnvelope({
      invocationId: 'inv-1',
      nodeId: 'node-repeat',
      nextIteration: 2,
      initialBoundInputs: {},
      carry: [{ fieldId: 'score', inputPortId: 'attempt-note' }],
      currentPassDecisionResults: { approved: false },
      childWorkflow: CHILD_WORKFLOW,
      acceptedAt: 2000
    });
    expect(missingRequired).toEqual({
      ok: false,
      code: 'missing-required-carry-field',
      message: expect.stringContaining("Required carry decision field 'score' is missing")
    });

    // Non-text target port -> rejected
    const nonTextPort = buildRepeatCarryEnvelope({
      invocationId: 'inv-1',
      nodeId: 'node-repeat',
      nextIteration: 2,
      initialBoundInputs: {},
      carry: [{ fieldId: 'nextFeedback', inputPortId: 'source-code' }],
      currentPassDecisionResults: { approved: false, score: 10, nextFeedback: 'bad' },
      childWorkflow: CHILD_WORKFLOW,
      acceptedAt: 2000
    });
    expect(nonTextPort).toEqual({
      ok: false,
      code: 'invalid-carry-input-port',
      message: expect.stringContaining("must have type 'text'")
    });
  });

  it('suspends with pause-unresolved when Until predicate evaluates to unresolved', async () => {
    const h = makeHarness();
    await h.seedRoot();
    // Until references optional field `nextFeedback` which is omitted from pass 1 results
    const ctrlUnresolved = makeRepeatControl({
      maxIterations: 3,
      until: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'nextFeedback' },
          operator: 'equals',
          right: 'ready'
        }
      }
    });
    await h.repeatExecutor.initializeRepeatFrame({
      rootRunId: h.rootRunId,
      parentInvocationId: h.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrlUnresolved,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h.fence
    });

    const evalCheck = evaluateRepeatUntilCondition(ctrlUnresolved.until, {
      approved: false,
      score: 50
    });
    expect(evalCheck.conditionResult).toBe('unresolved');

    const res = await h.repeatExecutor.settleRepeatPass({
      rootRunId: h.rootRunId,
      parentInvocationId: h.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrlUnresolved,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 50 },
      fence: h.fence
    });

    expect(res.action).toEqual({
      kind: 'pause-unresolved',
      iteration: 1,
      reason: 'unresolved-condition'
    });
    expect(res.frame?.status).toBe('paused');
    expect(res.frame?.pauseCause).toBe('unresolved-condition');
  });

  it('allows the 100th root dispatch to complete and blocks the 101st pass advancement', async () => {
    // 99 dispatches already used before pass 1; pass 1 is the 99th/100th dispatch.
    const h99 = makeHarness(99);
    await h99.seedRoot();
    const ctrl = makeRepeatControl({ maxIterations: 5 });
    await h99.repeatExecutor.initializeRepeatFrame({
      rootRunId: h99.rootRunId,
      parentInvocationId: h99.parentInvocationId,
      workflowId: 'wf-parent',
      nodeId: 'node-repeat',
      control: ctrl,
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      fence: h99.fence
    });

    // At 99 dispatches (< 100), advancing to pass 2 (the 100th dispatch) is allowed
    const to100 = await h99.repeatExecutor.settleRepeatPass({
      rootRunId: h99.rootRunId,
      parentInvocationId: h99.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: ctrl,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 70, nextFeedback: 'pass-2' },
      allocateNextChildInvocationId: () => 'child-pass-2',
      fence: h99.fence
    });
    expect(to100.action.kind).toBe('advance-next-pass');

    // Now dispatchedAttempts reaches 100 when pass 2's leaf Phase executes
    await h99.ledgerStore.mutate(
      { expectedFence: h99.fence },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, h99.rootRunId);
        if (!root) {
          return { commit: false, code: 'control-root-not-found', message: 'not found' };
        }
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [h99.rootRunId]: { ...root, dispatchedAttempts: 100 }
              }
            },
            result: undefined
          }
        };
      }
    );

    // When pass 2 evaluates to false at dispatchedAttempts === 100, the 101st dispatch is blocked
    const blocked101 = await h99.repeatExecutor.settleRepeatPass({
      rootRunId: h99.rootRunId,
      parentInvocationId: h99.parentInvocationId,
      nodeId: 'node-repeat',
      childInvocationId: 'child-pass-2',
      passStatus: 'completed',
      control: ctrl,
      childWorkflow: CHILD_WORKFLOW,
      initialBoundInputs: {
        feedback: { portId: 'feedback', type: 'text', value: 'initial' }
      },
      decisionResults: { approved: false, score: 80, nextFeedback: 'pass-3' },
      fence: h99.fence
    });

    expect(blocked101.action).toEqual({
      kind: 'fail-pass',
      iteration: 2,
      failureCode: 'root-attempt-budget-exhausted'
    });
    const loaded99 = h99.ledgerStore.read();
    const rootAfter = loaded99.ok ? lookupRecord(loaded99.ledger.roots, h99.rootRunId) : undefined;
    expect(rootAfter?.status).toBe('failed');
    expect(rootAfter?.failureCode).toBe('root-attempt-budget-exhausted');
  });

  it('validates child pass decisionResults strictly against child Workflow contract', () => {
    const missingRequired = resolveChildPassDecisionResults({
      childWorkflow: CHILD_WORKFLOW,
      explicitDecisionResults: { approved: true }
    });
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.code).toBe('invalid-child-decision-results');
    }
  });
});
