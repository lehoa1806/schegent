/**
 * FR-R5-F33 (SPEC-11, D1, D2, D4, D8, D9; WF-07; AC-06, AC-35) —
 * Scoped child-Workflow Repeat executor. Zero `vscode` imports.
 */

import {
  MAX_REPEAT_CARRY_MAPPINGS,
  MAX_REPEAT_ITERATIONS,
  MAX_ROOT_CONTROL_DISPATCHES,
  MIN_REPEAT_ITERATIONS,
  resolveRepeatControlDefaults,
  type RepeatCarryMapping,
  type RepeatControl,
  type RepeatExhaustedPolicy,
  type ResolvedRepeatControl
} from '../../contracts/workflow-controls';
import {
  isPrimitiveValue,
  utf8ByteLength,
  MAX_RESULT_STRING_BYTES,
  type DecisionFieldValue,
  type Primitive,
  type TypedCondition
} from '../../contracts/decision-results';
import type {
  ControlClockPort,
  ControlFrame,
  ControlNotificationRecord,
  ExecutionFence,
  RepeatCompletedPassEntry,
  RepeatConditionResult,
  RepeatRuntimeState,
  RootControlState
} from '../../contracts/control-ledger';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type { WorkflowDefinition, WorkflowNode } from '../../contracts/workflow-definitions';
import {
  appendInputEnvelope,
  attemptsForNode,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import { buildConditionContext } from './condition-context';
import { evaluateTypedCondition, type TypedConditionEvaluation } from './condition-evaluator';
import { createChildWorkflowInvocationFrame, createNodeAttemptRecord } from './connected-run-factory';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';

export type RepeatCrashPoint =
  | 'before-child-return'
  | 'after-child-return-before-eval'
  | 'after-eval-before-advance'
  | 'after-advance-commit';

export function buildRepeatFrameKey(parentInvocationId: string, nodeId: string): string {
  return `${parentInvocationId}:repeat:${nodeId}`;
}

export function resolveFrozenRepeatControl(
  run: ConnectedWorkflowRun,
  workflow: WorkflowDefinition,
  node: WorkflowNode
):
  | { readonly ok: true; readonly control: ResolvedRepeatControl }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const rawControl = node.control;
  if (rawControl === undefined || rawControl.kind !== 'repeat') {
    return { ok: false, code: 'invalid-repeat-control', message: `Node '${node.nodeId}' does not declare kind: 'repeat'.` };
  }
  const version: number = rawControl.version;
  if (version !== 1) {
    return { ok: false, code: 'unsupported-control-version', message: `Node '${node.nodeId}' repeat control version '${String(version)}' is unsupported.` };
  }
  const nodeKey = `${workflow.workflowId}:${node.nodeId}`;
  const frozenDefault = run.frozenClosure?.nodeControlDefaultsByNodeKey?.[nodeKey];
  const resolved: ResolvedRepeatControl =
    frozenDefault !== undefined && frozenDefault.kind === 'repeat'
      ? frozenDefault
      : resolveRepeatControlDefaults(rawControl);

  if (!Number.isSafeInteger(resolved.maxIterations) || resolved.maxIterations < MIN_REPEAT_ITERATIONS || resolved.maxIterations > MAX_REPEAT_ITERATIONS) {
    return { ok: false, code: 'invalid-repeat-max-iterations', message: `Repeat maxIterations on node '${node.nodeId}' must be in ${MIN_REPEAT_ITERATIONS}..${MAX_REPEAT_ITERATIONS}.` };
  }
  if (resolved.carry.length > MAX_REPEAT_CARRY_MAPPINGS) {
    return { ok: false, code: 'invalid-repeat-carry-count', message: `Repeat carry on node '${node.nodeId}' exceeds ${MAX_REPEAT_CARRY_MAPPINGS} mappings.` };
  }
  return { ok: true, control: resolved };
}

export function encodeRepeatCarryValue(
  value: unknown
):
  | { readonly ok: true; readonly encoded: string; readonly primitive: DecisionFieldValue }
  | { readonly ok: false; readonly code: 'invalid-carry-value'; readonly message: string } {
  if (typeof value === 'string') {
    if (utf8ByteLength(value) > MAX_RESULT_STRING_BYTES) {
      return { ok: false, code: 'invalid-carry-value', message: `Carry string value exceeds ${MAX_RESULT_STRING_BYTES} UTF-8 bytes.` };
    }
    return { ok: true, encoded: value, primitive: value };
  }
  if (typeof value === 'boolean') return { ok: true, encoded: value ? 'true' : 'false', primitive: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Object.is(value, -0) ? 0 : value;
    return { ok: true, encoded: JSON.stringify(normalized), primitive: normalized };
  }
  return { ok: false, code: 'invalid-carry-value', message: 'Carry value must be a string, boolean, or finite number.' };
}

export interface BuildRepeatCarryEnvelopeInput {
  readonly invocationId: string;
  readonly nodeId: string;
  readonly nextIteration: number;
  readonly initialBoundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly carry: readonly RepeatCarryMapping[];
  readonly currentPassDecisionResults: Readonly<Record<string, DecisionFieldValue>>;
  readonly childWorkflow: WorkflowDefinition;
  readonly acceptedAt: number;
}

export type BuildRepeatCarryEnvelopeResult =
  | {
      readonly ok: true;
      readonly envelope: InvocationInputEnvelope;
      readonly inputsByPort: Readonly<Record<string, ResolvedPortValue>>;
      readonly carriedValues: Readonly<Record<string, DecisionFieldValue>>;
    }
  | {
      readonly ok: false;
      readonly code: 'missing-required-carry-field' | 'invalid-carry-input-port' | 'invalid-carry-value' | 'duplicate-carry-target';
      readonly message: string;
    };

export function buildRepeatCarryEnvelope(input: BuildRepeatCarryEnvelopeInput): BuildRepeatCarryEnvelopeResult {
  const declaredDecisionFields = new Map((input.childWorkflow.decisionResults?.fields ?? []).map((f) => [f.fieldId, f]));
  const childInputsById = new Map((input.childWorkflow.inputs ?? []).map((p) => [p.portId, p]));

  const nextInputsByPort: Record<string, ResolvedPortValue> = {};
  for (const [portId, portVal] of Object.entries(input.initialBoundInputs)) {
    nextInputsByPort[portId] = Object.freeze({
      ...portVal,
      ...(portVal.items !== undefined ? { items: Object.freeze([...portVal.items]) } : {})
    });
  }

  const seenTargetPorts = new Set<string>();
  const carriedValues: Record<string, DecisionFieldValue> = {};

  for (const mapping of input.carry) {
    if (seenTargetPorts.has(mapping.inputPortId)) {
      return { ok: false, code: 'duplicate-carry-target', message: `Carry inputPortId '${mapping.inputPortId}' is mapped more than once.` };
    }
    seenTargetPorts.add(mapping.inputPortId);

    const targetPort = childInputsById.get(mapping.inputPortId);
    if (targetPort !== undefined && targetPort.type !== 'text') {
      return { ok: false, code: 'invalid-carry-input-port', message: `Carry target inputPortId '${mapping.inputPortId}' must have type 'text'.` };
    }

    const declaredField = declaredDecisionFields.get(mapping.fieldId);
    if (input.childWorkflow.decisionResults !== undefined && declaredField === undefined) {
      return { ok: false, code: 'missing-required-carry-field', message: `Carry field '${mapping.fieldId}' is not declared on '${input.childWorkflow.workflowId}'.` };
    }

    if (!Object.hasOwn(input.currentPassDecisionResults, mapping.fieldId)) {
      const isFieldRequired = declaredField?.required ?? true;
      const isPortRequired = targetPort?.required === true;
      if (isFieldRequired || (isPortRequired && !Object.hasOwn(nextInputsByPort, mapping.inputPortId))) {
        return { ok: false, code: 'missing-required-carry-field', message: `Required carry decision field '${mapping.fieldId}' is missing from pass ${input.nextIteration - 1} results.` };
      }
      continue;
    }

    const rawVal = input.currentPassDecisionResults[mapping.fieldId];
    if (declaredField !== undefined && typeof rawVal !== declaredField.type) {
      return { ok: false, code: 'invalid-carry-value', message: `Carry field '${mapping.fieldId}' expected type '${declaredField.type}'.` };
    }

    const encoded = encodeRepeatCarryValue(rawVal);
    if (!encoded.ok) return encoded;

    carriedValues[mapping.fieldId] = encoded.primitive;
    nextInputsByPort[mapping.inputPortId] = Object.freeze({ portId: mapping.inputPortId, type: 'text', value: encoded.encoded });
  }

  const frozenInputsByPort = Object.freeze(nextInputsByPort);
  const envelope: InvocationInputEnvelope = Object.freeze({
    envelopeId: `${input.invocationId}:${input.nodeId}:pass-${input.nextIteration}:carry-env`,
    invocationId: input.invocationId,
    targetNodeId: input.nodeId,
    source: 'binding',
    inputsByPort: frozenInputsByPort,
    localInputs: Object.freeze([]),
    outputTargetOverrides: Object.freeze([]),
    acceptedAt: input.acceptedAt
  });
  return { ok: true, envelope, inputsByPort: frozenInputsByPort, carriedValues: Object.freeze(carriedValues) };
}

function parsePrimitivePortValue(raw: string, expectedType: 'string' | 'number' | 'boolean'): Primitive | undefined {
  if (expectedType === 'string') return raw;
  if (expectedType === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && raw.trim().length > 0 ? parsed : undefined;
}

export function resolveChildPassDecisionResults(input: {
  readonly childWorkflow: WorkflowDefinition;
  readonly childFrame?: WorkflowInvocationFrame | undefined;
  readonly childInvocationId?: string | undefined;
  readonly explicitDecisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly ledgerRoot?: RootControlState | undefined;
}):
  | { readonly ok: true; readonly values: Readonly<Record<string, DecisionFieldValue>> }
  | { readonly ok: false; readonly code: 'invalid-child-decision-results'; readonly message: string } {
  const contract = input.childWorkflow.decisionResults;
  const rawCollected: Record<string, DecisionFieldValue> = {};
  const childInvId = input.childFrame?.invocationId ?? input.childInvocationId;
  const childLedgerFrame =
    childInvId !== undefined && input.ledgerRoot !== undefined
      ? lookupRecord(input.ledgerRoot.framesByKey, childInvId)
      : undefined;

  if (input.explicitDecisionResults !== undefined) {
    for (const [k, v] of Object.entries(input.explicitDecisionResults)) {
      if (isPrimitiveValue(v)) rawCollected[k] = v;
    }
  }
  if (childLedgerFrame?.decisionResults !== undefined) {
    for (const [k, v] of Object.entries(childLedgerFrame.decisionResults)) {
      if (isPrimitiveValue(v) && !Object.hasOwn(rawCollected, k)) rawCollected[k] = v;
    }
  }
  if (contract !== undefined) {
    const fieldById = new Map(contract.fields.map((f) => [f.fieldId, f]));
    for (const binding of contract.bindings) {
      if (Object.hasOwn(rawCollected, binding.fieldId)) continue;
      const targetField = fieldById.get(binding.fieldId);
      if (targetField === undefined) continue;
      if (binding.source.kind === 'node-result' && input.childFrame !== undefined) {
        const latestCompleted = [...attemptsForNode(input.childFrame, binding.source.nodeId)].reverse().find((a) => a.status === 'completed');
        if (latestCompleted !== undefined) {
          const ledgerAttempt = input.ledgerRoot !== undefined ? lookupRecord(input.ledgerRoot.attemptsById, latestCompleted.attemptId) : undefined;
          if (ledgerAttempt?.decisionResults !== undefined && Object.hasOwn(ledgerAttempt.decisionResults, binding.source.fieldId)) {
            const val = ledgerAttempt.decisionResults[binding.source.fieldId];
            if (isPrimitiveValue(val)) {
              rawCollected[binding.fieldId] = val;
              continue;
            }
          }
          const outPort = lookupRecord(latestCompleted.declaredOutputs, binding.source.fieldId);
          if (outPort !== undefined) {
            const parsed = parsePrimitivePortValue(outPort.value, targetField.type);
            if (parsed !== undefined) rawCollected[binding.fieldId] = parsed;
          }
        }
      } else if (binding.source.kind === 'selected-candidate') {
        const selId = childLedgerFrame?.selectedCandidateId;
        if (selId !== undefined && input.ledgerRoot !== undefined && childInvId !== undefined) {
          const candAtt = Object.values(input.ledgerRoot.attemptsById).find(
            (a) => (a.frameKey === childInvId || a.invocationId === childInvId) && a.candidateId === selId && a.stage === 'settled' && a.terminalStatus === 'completed'
          );
          const candVal = candAtt?.decisionResults !== undefined ? lookupRecord(candAtt.decisionResults, binding.source.fieldId) : undefined;
          if (isPrimitiveValue(candVal)) {
            rawCollected[binding.fieldId] = candVal;
            continue;
          }
        }
        const outPort = input.childFrame !== undefined ? lookupRecord(input.childFrame.resolvedOutputs, binding.source.fieldId) : undefined;
        if (outPort !== undefined) {
          const parsed = parsePrimitivePortValue(outPort.value, targetField.type);
          if (parsed !== undefined) rawCollected[binding.fieldId] = parsed;
        }
      }
    }
  }
  if (contract === undefined) return { ok: true, values: Object.freeze(rawCollected) };

  const validated: Record<string, DecisionFieldValue> = {};
  for (const fieldDef of contract.fields) {
    const val = lookupRecord(rawCollected, fieldDef.fieldId);
    if (val === undefined) {
      if (fieldDef.required) {
        return { ok: false, code: 'invalid-child-decision-results', message: `Required decisionResult field '${fieldDef.fieldId}' is missing.` };
      }
      continue;
    }
    if (
      typeof val !== fieldDef.type ||
      (typeof val === 'number' && !Number.isFinite(val)) ||
      (typeof val === 'string' && utf8ByteLength(val) > MAX_RESULT_STRING_BYTES)
    ) {
      return { ok: false, code: 'invalid-child-decision-results', message: `DecisionResult field '${fieldDef.fieldId}' failed validation.` };
    }
    validated[fieldDef.fieldId] = val;
  }
  return { ok: true, values: Object.freeze(validated) };
}

export function evaluateRepeatUntilCondition(
  until: TypedCondition,
  currentPassDecisionResults: Readonly<Record<string, DecisionFieldValue>>
): { readonly conditionResult: Exclude<RepeatConditionResult, 'not-evaluated'>; readonly evaluation: TypedConditionEvaluation } {
  const evaluation = evaluateTypedCondition(until, buildConditionContext([], { localResults: currentPassDecisionResults }));
  const conditionResult: Exclude<RepeatConditionResult, 'not-evaluated'> =
    evaluation.result === true ? 'true' : evaluation.result === false ? 'false' : 'unresolved';
  return { conditionResult, evaluation };
}

export interface RepeatExecutorDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock: ControlClockPort;
  readonly crashHook?: ((point: RepeatCrashPoint) => void) | undefined;
}

export interface InitializeRepeatFrameInput {
  readonly rootRunId: string;
  readonly parentInvocationId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly control: ResolvedRepeatControl;
  readonly initialChildInvocationId: string;
  readonly initialBoundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly fence: ExecutionFence;
  readonly frameKey?: string | undefined;
  readonly parentFrameKey?: string | null | undefined;
}

export interface SettleRepeatPassInput {
  readonly rootRunId: string;
  readonly parentInvocationId: string;
  readonly nodeId: string;
  readonly childInvocationId: string;
  readonly passStatus: 'completed' | 'failed' | 'canceled';
  readonly control: ResolvedRepeatControl;
  readonly childWorkflow: WorkflowDefinition;
  readonly initialBoundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly validatedOutputs?: Readonly<Record<string, ResolvedPortValue>> | undefined;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly resultRef?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly allocateNextChildInvocationId?: ((nextIteration: number) => string) | undefined;
  readonly fence: ExecutionFence;
  readonly frameKey?: string | undefined;
  readonly liveHostRootDispatchCap?: number | undefined;
}

export type SettleRepeatPassAction =
  | { readonly kind: 'accepted-return'; readonly iteration: number; readonly acceptedInvocationId: string; readonly exportedOutputs: Readonly<Record<string, ResolvedPortValue>>; readonly decisionResults: Readonly<Record<string, DecisionFieldValue>> }
  | { readonly kind: 'advance-next-pass'; readonly nextIteration: number; readonly nextChildInvocationId: string; readonly carryEnvelope: InvocationInputEnvelope; readonly inputsByPort: Readonly<Record<string, ResolvedPortValue>>; readonly carriedValues: Readonly<Record<string, DecisionFieldValue>> }
  | { readonly kind: 'pause-exhausted'; readonly iteration: number; readonly maxIterations: number; readonly reason: 'repeat-exhausted' }
  | { readonly kind: 'fail-exhausted'; readonly iteration: number; readonly maxIterations: number; readonly failureCode: 'repeat-exhausted' }
  | { readonly kind: 'pause-unresolved'; readonly iteration: number; readonly reason: 'unresolved-condition' }
  | { readonly kind: 'fail-pass'; readonly iteration: number; readonly failureCode: string }
  | { readonly kind: 'canceled-pass'; readonly iteration: number }
  | { readonly kind: 'ignored-stale'; readonly reason: string };

export interface SettleRepeatPassResult {
  readonly ok: boolean;
  readonly action: SettleRepeatPassAction;
  readonly frame?: ControlFrame | undefined;
  readonly root?: RootControlState | undefined;
}

function appendCompletedPassBounded(
  existing: readonly RepeatCompletedPassEntry[] | undefined,
  entry: RepeatCompletedPassEntry
): readonly RepeatCompletedPassEntry[] {
  const list = [...(existing ?? [])];
  const idx = list.findIndex((item) => item.iteration === entry.iteration);
  if (idx >= 0) list[idx] = Object.freeze({ ...entry });
  else list.push(Object.freeze({ ...entry }));
  while (list.length > MAX_REPEAT_ITERATIONS) list.shift();
  return Object.freeze(list);
}

export class RepeatExecutor {
  private readonly ledgerStore: ControlLedgerStore;
  private readonly clock: ControlClockPort;
  private readonly crashHook: ((point: RepeatCrashPoint) => void) | undefined;

  public constructor(deps: RepeatExecutorDeps) {
    this.ledgerStore = deps.ledgerStore;
    this.clock = deps.clock;
    this.crashHook = deps.crashHook;
  }

  private async mutateRoot(input: {
    readonly ledgerRunId: string;
    readonly expectedFence: ExecutionFence;
    readonly mutator: (root: RootControlState) => RootControlState;
  }): Promise<{ readonly ok: boolean; readonly root?: RootControlState; readonly message?: string }> {
    const res = await this.ledgerStore.mutate<RootControlState>(
      { targetRootId: input.ledgerRunId, expectedFence: input.expectedFence },
      ({ ledger }) => {
        const existingRoot = lookupRecord(ledger.roots, input.ledgerRunId);
        if (existingRoot === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Root '${input.ledgerRunId}' not found.`
          };
        }
        const nextRoot = input.mutator(existingRoot);
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: nextRoot
              }
            },
            result: nextRoot
          }
        };
      }
    );
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, root: res.result };
  }

  public async initializeRepeatFrame(
    input: InitializeRepeatFrameInput
  ): Promise<{ readonly ok: boolean; readonly frame?: ControlFrame; readonly message?: string }> {
    const frameKey = input.frameKey ?? buildRepeatFrameKey(input.parentInvocationId, input.nodeId);
    const nowWallMs = this.clock.nowWallMs();
    let savedFrame: ControlFrame | undefined;
    const mutated = await this.mutateRoot({
      ledgerRunId: input.rootRunId,
      expectedFence: input.fence,
      mutator: (root) => {
        const existing = lookupRecord(root.framesByKey, frameKey);
        if (existing !== undefined) {
          savedFrame = existing;
          return root;
        }
        const repeatState: RepeatRuntimeState = Object.freeze({
          iteration: 1, currentPass: 1, maxIterations: input.control.maxIterations,
          currentChildInvocationId: input.initialChildInvocationId,
          completedPasses: Object.freeze([]), conditionResult: 'not-evaluated',
          onExhausted: input.control.onExhausted
        });
        const frame: ControlFrame = Object.freeze({
          frameKey, parentFrameKey: input.parentFrameKey ?? input.parentInvocationId,
          invocationId: input.parentInvocationId, workflowId: input.workflowId,
          nodeId: input.nodeId, kind: 'repeat', status: 'executing',
          createdAt: nowWallMs, updatedAt: nowWallMs, dispatchedCount: 1,
          maxDispatches: input.control.maxIterations, frameGeneration: 1, repeatState
        });
        savedFrame = frame;
        return Object.freeze({ ...root, framesByKey: Object.freeze({ ...root.framesByKey, [frameKey]: frame }), updatedAt: nowWallMs });
      }
    });
    if (!mutated.ok) return { ok: false, ...(mutated.message !== undefined ? { message: mutated.message } : {}) };
    return { ok: true, ...(savedFrame !== undefined ? { frame: savedFrame } : {}) };
  }

  private async commitFrameUpdate(
    rootRunId: string, frameKey: string, fence: ExecutionFence, nowWallMs: number,
    buildFrame: (frame: ControlFrame) => ControlFrame,
    decorateRoot?: (root: RootControlState, frame: ControlFrame) => RootControlState
  ): Promise<{ readonly ok: boolean; readonly frame?: ControlFrame; readonly root?: RootControlState }> {
    let updatedFrame: ControlFrame | undefined;
    const mutated = await this.mutateRoot({
      ledgerRunId: rootRunId, expectedFence: fence,
      mutator: (root) => {
        const frame = lookupRecord(root.framesByKey, frameKey);
        if (frame === undefined) return root;
        updatedFrame = buildFrame(frame);
        const baseRoot: RootControlState = Object.freeze({
          ...root, framesByKey: Object.freeze({ ...root.framesByKey, [frameKey]: updatedFrame }), updatedAt: nowWallMs
        });
        return decorateRoot !== undefined ? decorateRoot(baseRoot, updatedFrame) : baseRoot;
      }
    });
    return { ok: mutated.ok, ...(updatedFrame !== undefined ? { frame: updatedFrame } : {}), ...(mutated.ok ? { root: mutated.root } : {}) };
  }

  public async settleRepeatPass(input: SettleRepeatPassInput): Promise<SettleRepeatPassResult> {
    const frameKey = input.frameKey ?? buildRepeatFrameKey(input.parentInvocationId, input.nodeId);
    const nowWallMs = this.clock.nowWallMs();
    this.crashHook?.('before-child-return');

    const loaded = this.ledgerStore.read();
    if (!loaded.ok) return { ok: false, action: { kind: 'ignored-stale', reason: loaded.code } };
    const initialRoot = lookupRecord(loaded.ledger.roots, input.rootRunId);
    const existingFrame = initialRoot !== undefined ? lookupRecord(initialRoot.framesByKey, frameKey) : undefined;
    if (initialRoot === undefined || existingFrame === undefined) {
      return { ok: false, action: { kind: 'ignored-stale', reason: 'repeat-frame-not-found' } };
    }
    if (existingFrame.status === 'completed' || existingFrame.status === 'failed' || existingFrame.status === 'canceled' || existingFrame.status === 'paused') {
      return { ok: false, action: { kind: 'ignored-stale', reason: `repeat-frame-${existingFrame.status}` }, frame: existingFrame, root: initialRoot };
    }

    const currentRepeat = existingFrame.repeatState ?? {
      iteration: 1, currentPass: 1, maxIterations: input.control.maxIterations,
      currentChildInvocationId: input.childInvocationId, completedPasses: [],
      conditionResult: 'not-evaluated' as const, onExhausted: input.control.onExhausted
    };
    const currentIteration = currentRepeat.iteration ?? currentRepeat.currentPass;
    if (
      currentRepeat.currentChildInvocationId !== undefined &&
      currentRepeat.currentChildInvocationId !== null &&
      currentRepeat.currentChildInvocationId !== input.childInvocationId
    ) {
      return { ok: false, action: { kind: 'ignored-stale', reason: 'child-invocation-mismatch' }, frame: existingFrame, root: initialRoot };
    }

    const failRepeatPass = async (
      failureCode: string, conditionResult: RepeatConditionResult,
      passes: readonly RepeatCompletedPassEntry[], failRoot = false
    ): Promise<SettleRepeatPassResult> => {
      const res = await this.commitFrameUpdate(
        input.rootRunId, frameKey, input.fence, nowWallMs,
        (frame) => Object.freeze({
          ...frame, status: 'failed', failureCode, completedAt: nowWallMs, updatedAt: nowWallMs,
          frameGeneration: (frame.frameGeneration ?? 1) + 1, winningOutputs: undefined, decisionResults: undefined,
          repeatState: Object.freeze({
            ...currentRepeat, iteration: currentIteration, currentPass: currentIteration,
            currentChildInvocationId: null, completedPasses: passes, conditionResult,
            lastPassAccepted: false, exhaustionReason: failureCode
          })
        }),
        failRoot ? (root) => Object.freeze({ ...root, status: 'failed', failureCode, completedAt: nowWallMs }) : undefined
      );
      return { ...res, action: { kind: 'fail-pass', iteration: currentIteration, failureCode } };
    };

    if (input.passStatus === 'canceled') {
      const completedPasses = appendCompletedPassBounded(currentRepeat.completedPasses, {
        iteration: currentIteration, invocationId: input.childInvocationId, status: 'canceled'
      });
      const res = await this.commitFrameUpdate(input.rootRunId, frameKey, input.fence, nowWallMs, (frame) =>
        Object.freeze({
          ...frame, status: 'canceled', completedAt: nowWallMs, updatedAt: nowWallMs,
          frameGeneration: (frame.frameGeneration ?? 1) + 1,
          repeatState: Object.freeze({
            ...currentRepeat, iteration: currentIteration, currentPass: currentIteration,
            currentChildInvocationId: null, completedPasses, conditionResult: 'not-evaluated', lastPassAccepted: false
          })
        })
      );
      return { ...res, action: { kind: 'canceled-pass', iteration: currentIteration } };
    }

    if (input.passStatus === 'failed') {
      const completedPasses = appendCompletedPassBounded(currentRepeat.completedPasses, {
        iteration: currentIteration, invocationId: input.childInvocationId, status: 'failed'
      });
      return failRepeatPass(input.failureCode ?? 'child-workflow-failed', 'not-evaluated', completedPasses);
    }

    this.crashHook?.('after-child-return-before-eval');

    const decisionRes = resolveChildPassDecisionResults({
      childWorkflow: input.childWorkflow, childInvocationId: input.childInvocationId,
      explicitDecisionResults: input.decisionResults, ledgerRoot: initialRoot
    });
    if (!decisionRes.ok) {
      const completedPasses = appendCompletedPassBounded(currentRepeat.completedPasses, {
        iteration: currentIteration, invocationId: input.childInvocationId, status: 'failed'
      });
      return failRepeatPass(decisionRes.code, 'not-evaluated', completedPasses);
    }

    const currentDecisionValues = decisionRes.values;
    const { conditionResult } = evaluateRepeatUntilCondition(input.control.until, currentDecisionValues);
    const completedPasses = appendCompletedPassBounded(currentRepeat.completedPasses, {
      iteration: currentIteration, invocationId: input.childInvocationId, status: 'completed',
      resultRef: input.resultRef ?? `ref:${input.childInvocationId}:pass-${currentIteration}`
    });

    this.crashHook?.('after-eval-before-advance');

    if (conditionResult === 'true') {
      const exportedOutputs = Object.freeze({ ...(input.validatedOutputs ?? {}) });
      const winningOutputsStrings: Record<string, string> = {};
      for (const [k, v] of Object.entries(exportedOutputs)) winningOutputsStrings[k] = v.value;
      const res = await this.commitFrameUpdate(input.rootRunId, frameKey, input.fence, nowWallMs, (frame) =>
        Object.freeze({
          ...frame, status: 'completed', completedAt: nowWallMs, updatedAt: nowWallMs,
          frameGeneration: (frame.frameGeneration ?? 1) + 1,
          returnCommitId: `${frameKey}:return:pass-${currentIteration}`,
          winningOutputs: Object.freeze(winningOutputsStrings), decisionResults: currentDecisionValues,
          repeatState: Object.freeze({
            ...currentRepeat, iteration: currentIteration, currentPass: currentIteration,
            currentChildInvocationId: null, completedPasses, conditionResult: 'true', lastPassAccepted: true
          })
        })
      );
      this.crashHook?.('after-advance-commit');
      return {
        ...res,
        action: {
          kind: 'accepted-return', iteration: currentIteration, acceptedInvocationId: input.childInvocationId,
          exportedOutputs, decisionResults: currentDecisionValues
        }
      };
    }

    if (conditionResult === 'unresolved') {
      const res = await this.commitFrameUpdate(
        input.rootRunId, frameKey, input.fence, nowWallMs,
        (frame) => Object.freeze({
          ...frame, status: 'paused', pauseCause: 'unresolved-condition', updatedAt: nowWallMs,
          frameGeneration: (frame.frameGeneration ?? 1) + 1, winningOutputs: undefined, decisionResults: undefined,
          repeatState: Object.freeze({
            ...currentRepeat, iteration: currentIteration, currentPass: currentIteration,
            currentChildInvocationId: null, completedPasses, conditionResult: 'unresolved',
            lastPassAccepted: false, exhaustionReason: 'unresolved-condition'
          })
        }),
        (root) => Object.freeze({ ...root, status: 'paused', pauseCause: 'unresolved-condition' })
      );
      this.crashHook?.('after-advance-commit');
      return { ...res, action: { kind: 'pause-unresolved', iteration: currentIteration, reason: 'unresolved-condition' } };
    }

    if (currentIteration >= input.control.maxIterations) {
      const onExhausted: RepeatExhaustedPolicy = input.control.onExhausted;
      const res = await this.commitFrameUpdate(
        input.rootRunId, frameKey, input.fence, nowWallMs,
        (frame) => Object.freeze({
          ...frame, status: onExhausted === 'pause' ? 'paused' : 'failed',
          ...(onExhausted === 'pause' ? { pauseCause: 'repeat-exhausted' } : { failureCode: 'repeat-exhausted', completedAt: nowWallMs }),
          updatedAt: nowWallMs, frameGeneration: (frame.frameGeneration ?? 1) + 1,
          winningOutputs: undefined, decisionResults: undefined,
          repeatState: Object.freeze({
            ...currentRepeat, iteration: currentIteration, currentPass: currentIteration,
            currentChildInvocationId: null, completedPasses, conditionResult: 'false',
            lastPassAccepted: false, exhaustionReason: 'repeat-exhausted'
          })
        }),
        (root, updatedFrame) => {
          const nextGeneration = updatedFrame.frameGeneration ?? 1;
          const notificationId = `${input.rootRunId}:${frameKey}:repeat-exhausted:${nextGeneration}`;
          const notification: ControlNotificationRecord = Object.freeze({
            notificationId, rootRunId: input.rootRunId, invocationId: input.parentInvocationId,
            generation: nextGeneration, reason: 'repeat-exhausted', createdAt: nowWallMs,
            delivery: 'pending',
            summary: `Repeat node '${input.nodeId}' exhausted ${input.control.maxIterations} iterations without satisfying Until.`
          });
          return Object.freeze({
            ...root, status: onExhausted === 'pause' ? 'paused' : 'failed',
            ...(onExhausted === 'pause' ? { pauseCause: 'repeat-exhausted' } : { failureCode: 'repeat-exhausted', completedAt: nowWallMs }),
            notificationsById: Object.freeze({ ...(root.notificationsById ?? {}), [notificationId]: notification })
          });
        }
      );
      this.crashHook?.('after-advance-commit');
      return {
        ...res,
        action:
          onExhausted === 'pause'
            ? { kind: 'pause-exhausted', iteration: currentIteration, maxIterations: input.control.maxIterations, reason: 'repeat-exhausted' }
            : { kind: 'fail-exhausted', iteration: currentIteration, maxIterations: input.control.maxIterations, failureCode: 'repeat-exhausted' }
      };
    }

    const effectiveRootCap = Math.min(
      MAX_ROOT_CONTROL_DISPATCHES, initialRoot.rootBudget.maxPhaseAttempts,
      input.liveHostRootDispatchCap ?? MAX_ROOT_CONTROL_DISPATCHES
    );
    if (initialRoot.dispatchedAttempts >= effectiveRootCap) {
      return failRepeatPass('root-attempt-budget-exhausted', 'false', completedPasses, true);
    }

    const nextIteration = currentIteration + 1;
    const carryResult = buildRepeatCarryEnvelope({
      invocationId: input.parentInvocationId, nodeId: input.nodeId, nextIteration,
      initialBoundInputs: input.initialBoundInputs, carry: input.control.carry,
      currentPassDecisionResults: currentDecisionValues, childWorkflow: input.childWorkflow, acceptedAt: nowWallMs
    });
    if (!carryResult.ok) return failRepeatPass(carryResult.code, 'false', completedPasses);

    const nextChildInvocationId =
      input.allocateNextChildInvocationId?.(nextIteration) ??
      `${input.parentInvocationId}:${input.nodeId}:${input.parentInvocationId}:${input.nodeId}:attempt-${nextIteration}`;

    const res = await this.commitFrameUpdate(input.rootRunId, frameKey, input.fence, nowWallMs, (frame) =>
      Object.freeze({
        ...frame, status: 'executing', dispatchedCount: nextIteration, updatedAt: nowWallMs,
        frameGeneration: (frame.frameGeneration ?? 1) + 1,
        repeatState: Object.freeze({
          ...currentRepeat, iteration: nextIteration, currentPass: nextIteration,
          maxIterations: input.control.maxIterations, currentChildInvocationId: nextChildInvocationId,
          completedPasses, conditionResult: 'false', carryEnvelopeRef: carryResult.envelope.envelopeId,
          carryValues: carryResult.carriedValues, lastPassAccepted: false
        })
      })
    );
    this.crashHook?.('after-advance-commit');
    return {
      ...res,
      action: {
        kind: 'advance-next-pass', nextIteration, nextChildInvocationId,
        carryEnvelope: carryResult.envelope, inputsByPort: carryResult.inputsByPort,
        carriedValues: carryResult.carriedValues
      }
    };
  }
}

export function prepareRepeatPassFrames(input: {
  readonly run: ConnectedWorkflowRun;
  readonly parentFrame: WorkflowInvocationFrame;
  readonly node: WorkflowNode;
  readonly childWorkflow: WorkflowDefinition;
  readonly passIndex: number;
  readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly inputEnvelope: InvocationInputEnvelope;
  readonly startedAt: number;
}): {
  readonly nextRun: ConnectedWorkflowRun;
  readonly childFrame: WorkflowInvocationFrame;
  readonly parentAttempt: NodeAttemptRecord;
  readonly childEntryNodeId: string;
} | null {
  const childEntryNodeId =
    input.childWorkflow.control?.kind === 'candidate-block'
      ? [...input.childWorkflow.control.candidates].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1)).at(0)?.nodeId ??
        input.childWorkflow.startNodeIds.at(0)
      : input.childWorkflow.startNodeIds.at(0);
  if (childEntryNodeId === undefined) return null;

  const parentAttemptId = `${input.parentFrame.invocationId}:${input.node.nodeId}:attempt-${input.passIndex}`;
  const childFrame = createChildWorkflowInvocationFrame({
    parentFrame: input.parentFrame,
    callNodeId: input.node.nodeId,
    parentAttemptId,
    childWorkflow: input.childWorkflow,
    boundInputs: input.boundInputs,
    startedAt: input.startedAt
  });
  const parentAttempt = createNodeAttemptRecord({
    frame: input.parentFrame,
    nodeId: input.node.nodeId,
    nodeKind: 'workflow',
    targetDefinitionId: input.childWorkflow.workflowId,
    inputEnvelope: input.inputEnvelope,
    startedAt: input.startedAt,
    childInvocationId: childFrame.invocationId
  });
  const updatedParentFrame = recordNodeAttempt(input.parentFrame, parentAttempt);
  let nextRun = upsertInvocationFrame(input.run, updatedParentFrame);
  nextRun = upsertInvocationFrame(nextRun, childFrame);
  if (input.passIndex > 1) nextRun = appendInputEnvelope(nextRun, input.inputEnvelope);
  return { nextRun, childFrame, parentAttempt, childEntryNodeId };
}

export function pauseParentFrameOnRepeat(
  run: ConnectedWorkflowRun,
  parentFrame: WorkflowInvocationFrame,
  nodeId: string,
  pausedAt: number,
  reasonCode: string
): ConnectedWorkflowRun {
  const pausedFrame: WorkflowInvocationFrame = {
    ...parentFrame,
    activeNodeId: nodeId,
    status: 'paused',
    failureCode: reasonCode,
    controlMarkers: pauseInvocationControlMarkers(parentFrame.controlMarkers, pausedAt, 'operator-pause')
  };
  return upsertInvocationFrame(run, pausedFrame);
}

export interface HandleRepeatChildCompletionInput {
  readonly run: ConnectedWorkflowRun;
  readonly parentFrame: WorkflowInvocationFrame;
  readonly parentWorkflow: WorkflowDefinition;
  readonly parentNode: WorkflowNode;
  readonly parentAttempt: NodeAttemptRecord;
  readonly completedChildFrame: WorkflowInvocationFrame;
  readonly childWorkflow: WorkflowDefinition;
  readonly childOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly completedAt: number;
  readonly explicitDecisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly repeatExecutor?: RepeatExecutor | undefined;
  readonly fence?: ExecutionFence | undefined;
}

export type HandleRepeatChildCompletionResult =
  | { readonly kind: 'accepted'; readonly run: ConnectedWorkflowRun; readonly exportedOutputs: Readonly<Record<string, ResolvedPortValue>> }
  | { readonly kind: 'advance'; readonly run: ConnectedWorkflowRun; readonly nextChildInvocationId: string; readonly childEntryNodeId: string }
  | { readonly kind: 'paused'; readonly run: ConnectedWorkflowRun; readonly pauseCause: string }
  | { readonly kind: 'failed'; readonly run: ConnectedWorkflowRun; readonly settledParentFrame: WorkflowInvocationFrame; readonly failureCode: string; readonly detail?: string };

export async function handleRepeatChildCompletion(
  input: HandleRepeatChildCompletionInput
): Promise<HandleRepeatChildCompletionResult> {
  const resolvedCtrl = resolveFrozenRepeatControl(input.run, input.parentWorkflow, input.parentNode);
  if (!resolvedCtrl.ok) {
    return { kind: 'failed', run: input.run, settledParentFrame: input.parentFrame, failureCode: resolvedCtrl.code, detail: resolvedCtrl.message };
  }
  const control = resolvedCtrl.control;
  const allAttempts = attemptsForNode(input.parentFrame, input.parentNode.nodeId);
  const firstAttempt = allAttempts[0] ?? input.parentAttempt;
  const initialBoundInputs = firstAttempt.inputEnvelope.inputsByPort;
  const currentIteration = input.parentAttempt.attemptIndex;

  let ledgerRoot: RootControlState | undefined;
  const prelimDecisionRes = resolveChildPassDecisionResults({
    childWorkflow: input.childWorkflow,
    childFrame: input.completedChildFrame,
    explicitDecisionResults: input.explicitDecisionResults
  });

  if (input.repeatExecutor !== undefined) {
    const ledgerRunId = input.run.controlState?.ledgerRunId ?? input.run.connectedRunId;
    const fence: ExecutionFence = input.fence ?? {
      primacyClaim: `primacy:${input.run.connectedRunId}`,
      queueClaim: `queue:${input.run.queueId ?? 'default'}`,
      rootGeneration: 1
    };
    await input.repeatExecutor.initializeRepeatFrame({
      rootRunId: ledgerRunId,
      parentInvocationId: input.parentFrame.invocationId,
      workflowId: input.parentWorkflow.workflowId,
      nodeId: input.parentNode.nodeId,
      control,
      initialChildInvocationId: input.completedChildFrame.invocationId,
      initialBoundInputs,
      fence
    });
    const settled = await input.repeatExecutor.settleRepeatPass({
      rootRunId: ledgerRunId,
      parentInvocationId: input.parentFrame.invocationId,
      nodeId: input.parentNode.nodeId,
      childInvocationId: input.completedChildFrame.invocationId,
      passStatus: 'completed',
      control,
      childWorkflow: input.childWorkflow,
      initialBoundInputs,
      validatedOutputs: input.childOutputs,
      decisionResults: prelimDecisionRes.ok ? prelimDecisionRes.values : input.explicitDecisionResults,
      fence
    });
    ledgerRoot = settled.root;
    if (settled.action.kind === 'fail-pass' && settled.action.failureCode === 'root-attempt-budget-exhausted') {
      const failedAttempt: NodeAttemptRecord = Object.freeze({
        ...input.parentAttempt, status: 'failed', completedAt: input.completedAt,
        failureCode: 'root-attempt-budget-exhausted', declaredOutputs: Object.freeze({})
      });
      const settledParentFrame = recordNodeAttempt(input.parentFrame, failedAttempt);
      return { kind: 'failed', run: upsertInvocationFrame(input.run, settledParentFrame), settledParentFrame, failureCode: 'root-attempt-budget-exhausted' };
    }
  }

  const decisionRes = resolveChildPassDecisionResults({
    childWorkflow: input.childWorkflow,
    childFrame: input.completedChildFrame,
    explicitDecisionResults: input.explicitDecisionResults,
    ledgerRoot
  });
  if (!decisionRes.ok) {
    const failedAttempt: NodeAttemptRecord = Object.freeze({
      ...input.parentAttempt,
      status: 'failed',
      completedAt: input.completedAt,
      failureCode: decisionRes.code,
      declaredOutputs: Object.freeze({})
    });
    const settledParentFrame = recordNodeAttempt(input.parentFrame, failedAttempt);
    return { kind: 'failed', run: upsertInvocationFrame(input.run, settledParentFrame), settledParentFrame, failureCode: decisionRes.code, detail: decisionRes.message };
  }

  const { conditionResult } = evaluateRepeatUntilCondition(control.until, decisionRes.values);
  if (conditionResult === 'true') return { kind: 'accepted', run: input.run, exportedOutputs: input.childOutputs };
  if (conditionResult === 'unresolved') {
    const pausedAttempt: NodeAttemptRecord = Object.freeze({
      ...input.parentAttempt,
      status: 'paused',
      completedAt: input.completedAt,
      declaredOutputs: Object.freeze({})
    });
    const parentWithAttempt = recordNodeAttempt(input.parentFrame, pausedAttempt);
    return {
      kind: 'paused',
      run: pauseParentFrameOnRepeat(input.run, parentWithAttempt, input.parentNode.nodeId, input.completedAt, 'unresolved-condition'),
      pauseCause: 'unresolved-condition'
    };
  }

  const completedPassAttempt: NodeAttemptRecord = Object.freeze({
    ...input.parentAttempt,
    status: 'completed',
    completedAt: input.completedAt,
    declaredOutputs: Object.freeze({})
  });
  const parentWithPassDone = recordNodeAttempt(input.parentFrame, completedPassAttempt);
  const runWithPassDone = upsertInvocationFrame(input.run, parentWithPassDone);

  if (currentIteration >= control.maxIterations) {
    if (control.onExhausted === 'pause') {
      const pausedExhaustedAttempt: NodeAttemptRecord = Object.freeze({
        ...input.parentAttempt,
        status: 'paused',
        completedAt: input.completedAt,
        failureCode: 'repeat-exhausted',
        declaredOutputs: Object.freeze({})
      });
      const parentWithPaused = recordNodeAttempt(input.parentFrame, pausedExhaustedAttempt);
      return {
        kind: 'paused',
        run: pauseParentFrameOnRepeat(runWithPassDone, parentWithPaused, input.parentNode.nodeId, input.completedAt, 'repeat-exhausted'),
        pauseCause: 'repeat-exhausted'
      };
    }
    const failedExhaustedAttempt: NodeAttemptRecord = Object.freeze({
      ...input.parentAttempt,
      status: 'failed',
      completedAt: input.completedAt,
      failureCode: 'repeat-exhausted',
      declaredOutputs: Object.freeze({})
    });
    const parentWithFailed = recordNodeAttempt(input.parentFrame, failedExhaustedAttempt);
    return {
      kind: 'failed',
      run: upsertInvocationFrame(input.run, parentWithFailed),
      settledParentFrame: parentWithFailed,
      failureCode: 'repeat-exhausted',
      detail: `Repeat node '${input.parentNode.nodeId}' exhausted ${control.maxIterations} passes.`
    };
  }

  const nextIteration = currentIteration + 1;
  const carryRes = buildRepeatCarryEnvelope({
    invocationId: input.parentFrame.invocationId,
    nodeId: input.parentNode.nodeId,
    nextIteration,
    initialBoundInputs,
    carry: control.carry,
    currentPassDecisionResults: decisionRes.values,
    childWorkflow: input.childWorkflow,
    acceptedAt: input.completedAt
  });
  if (!carryRes.ok) {
    return { kind: 'failed', run: runWithPassDone, settledParentFrame: parentWithPassDone, failureCode: carryRes.code, detail: carryRes.message };
  }

  const prepared = prepareRepeatPassFrames({
    run: runWithPassDone, parentFrame: parentWithPassDone, node: input.parentNode,
    childWorkflow: input.childWorkflow, passIndex: nextIteration,
    boundInputs: carryRes.inputsByPort, inputEnvelope: carryRes.envelope, startedAt: input.completedAt
  });
  if (prepared === null) {
    return { kind: 'failed', run: runWithPassDone, settledParentFrame: parentWithPassDone, failureCode: 'invalid-entry-node' };
  }
  return { kind: 'advance', run: prepared.nextRun, nextChildInvocationId: prepared.childFrame.invocationId, childEntryNodeId: prepared.childEntryNodeId };
}

export async function settleFailedOrCanceledRepeatChild(input: {
  readonly run: ConnectedWorkflowRun;
  readonly parentFrame: WorkflowInvocationFrame;
  readonly childFrame: WorkflowInvocationFrame;
  readonly status: 'failed' | 'canceled';
  readonly failureCode?: string | undefined;
  readonly repeatExecutor?: RepeatExecutor | undefined;
  readonly fence?: ExecutionFence | undefined;
}): Promise<void> {
  if (input.repeatExecutor === undefined) return;
  const ledgerRunId = input.run.controlState?.ledgerRunId ?? input.run.connectedRunId;
  const closure = input.run.frozenClosure;
  const parentWorkflow = closure?.workflowsById[input.parentFrame.workflowId];
  const parentNode = parentWorkflow?.nodes.find((n) => n.nodeId === input.childFrame.parentCallNodeId);
  const childWorkflow = closure?.workflowsById[input.childFrame.workflowId];
  if (parentWorkflow === undefined || parentNode?.control?.kind !== 'repeat' || childWorkflow === undefined) return;
  const resolvedCtrl = resolveFrozenRepeatControl(input.run, parentWorkflow, parentNode);
  if (!resolvedCtrl.ok) return;
  const allAttempts = attemptsForNode(input.parentFrame, parentNode.nodeId);
  const initialBoundInputs = allAttempts[0]?.inputEnvelope.inputsByPort ?? Object.freeze({});
  const fence: ExecutionFence = input.fence ?? {
    primacyClaim: `primacy:${input.run.connectedRunId}`, queueClaim: `queue:${input.run.queueId ?? 'default'}`, rootGeneration: 1
  };
  await input.repeatExecutor.settleRepeatPass({
    rootRunId: ledgerRunId, parentInvocationId: input.parentFrame.invocationId, nodeId: parentNode.nodeId,
    childInvocationId: input.childFrame.invocationId, passStatus: input.status, control: resolvedCtrl.control,
    childWorkflow, initialBoundInputs, failureCode: input.failureCode, fence
  });
}

export type { RepeatControl };
